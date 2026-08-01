import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GenesisDraftSchema, type DomainEvent, type HarnessAdapter } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";

/**
 * Genesis conversations (prototype 12a): a world that does not exist yet is shaped in a
 * sandbox directory by the world-author agent. The protocol is file-based like everything
 * else here — after each reply the agent maintains draft.json, and that file is the
 * "world so far" rail. Nothing lands until Begin-in-this-world walks the draft through the
 * ordinary creation gates; abandoning the conversation costs a directory delete.
 */

export interface GenesisOptions {
  buildConfig: (input: { worldQueryUrl?: string }) => Record<string, unknown>;
  wallClockMs?: number;
  tokenBudget?: number;
}

interface ActiveTurn {
  sessionId: string;
  cancelled: boolean;
}

const DEFAULT_WALL_CLOCK_MS = 3 * 60_000;
const DEFAULT_TOKEN_BUDGET = 120_000;

/** Sent once, ahead of the first user message — the draft.json contract. */
const PROTOCOL = `You are shaping a brand-new story world in conversation with its author. Reply briefly and
concretely — offer names, textures and consequences, ask one good question at a time, and never
bury the author in lore.

After EVERY reply, write the current state of the draft to ./draft.json (overwrite it) with
exactly this shape, omitting fields you have not settled yet:

{"name": "...", "logline": "one sentence", "tone": "two or three words", "genre": "...",
 "characters": [{"name": "...", "line": "one line on who they are"}],
 "locations": [{"name": "...", "line": "one line on the place"}],
 "threads": ["an open question worth pulling later"]}

Everything in draft.json is proposed, not settled — keep it small and true to what was
actually discussed.

The author says:`;

export class GenesisService {
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly sessions = new Map<string, string>();

  constructor(
    private readonly adapter: HarnessAdapter,
    private readonly emit: (event: DomainEvent) => void,
    private readonly opts: GenesisOptions,
  ) {}

  isRunning(genesisId: string): boolean {
    return this.turns.has(genesisId);
  }

  /** The conversation is over — begun or abandoned; the sandbox's fate is the caller's. */
  release(genesisId: string): void {
    this.sessions.delete(genesisId);
  }

  /** One conversational turn in the sandbox. Failure is a stated status, never a throw. */
  async run(dir: string, genesisId: string, text: string): Promise<void> {
    const at = () => new Date().toISOString();
    const status = (
      state: "running" | "completed" | "cancelled" | "timeout" | "budget-exceeded" | "failed",
      detail?: string,
    ) =>
      this.emit({
        at: at(),
        type: "genesis.status",
        genesisId,
        status: state,
        ...(detail !== undefined ? { detail } : {}),
      });

    if (this.turns.has(genesisId)) {
      status("failed", "a turn is already running in this conversation");
      return;
    }
    if (!this.adapter.readiness().ready) {
      status("failed", this.adapter.readiness().reason ?? "the harness is not ready");
      return;
    }

    let sessionId = this.sessions.get(genesisId);
    const firstTurn = sessionId === undefined;
    if (sessionId === undefined) {
      // Same confinement config as authoring sessions — no world, so no world-query MCP.
      await atomicWriteFile(join(dir, "opencode.json"), JSON.stringify(this.opts.buildConfig({}), null, 2) + "\n");
      try {
        const session = await this.adapter.createSession({ purpose: "drafting", cwd: dir, agent: "world-author" });
        sessionId = session.sessionId;
        this.sessions.set(genesisId, sessionId);
      } catch (err) {
        status("failed", `could not create a session: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    this.emit({ at: at(), type: "genesis.turn", genesisId, role: "user", text });

    const run: ActiveTurn = { sessionId, cancelled: false };
    this.turns.set(genesisId, run);
    status("running");

    const wallClock = this.opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    const tokenBudget = this.opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const abort = new AbortController();
    let ending: { state: "completed" | "cancelled" | "timeout" | "budget-exceeded" | "failed"; detail?: string } | null =
      null;
    const timer = setTimeout(() => {
      ending = { state: "timeout", detail: `hit the ${Math.round(wallClock / 1000)}s wall-clock limit` };
      const interrupt = (this.adapter as { interrupt?: (id: string) => Promise<void> }).interrupt;
      void interrupt?.call(this.adapter, sessionId).catch(() => {});
    }, wallClock);
    // Refed, and cleared in `finally` — see AuthoringService for why an unref'd deadline is
    // no deadline at all.
    const usage = (this.adapter as { usageTokens?: (id: string) => number }).usageTokens;
    let replyText = "";

    try {
      const events = this.adapter.streamEvents(abort.signal);
      await this.adapter.dispatchAsync({
        sessionId,
        parts: [{ type: "text", text: firstTurn ? `${PROTOCOL}\n\n${text}` : text }],
      });

      for await (const event of events) {
        if (!("sessionId" in event) || event.sessionId !== sessionId) continue;
        if (event.type === "message.delta") {
          replyText = event.text;
        } else if (event.type === "message.completed") {
          replyText = event.text;
          if (!ending) ending = { state: run.cancelled ? "cancelled" : "completed" };
          break;
        } else if (event.type === "session.error") {
          ending = { state: "failed", detail: event.message };
          break;
        } else if (event.type === "session.ended") {
          ending = {
            state: event.reason === "completed" ? "completed" : event.reason === "cancelled" ? "cancelled" : "failed",
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
          };
          break;
        }
        if (usage && usage.call(this.adapter, sessionId) > tokenBudget) {
          ending = { state: "budget-exceeded", detail: `passed the ${tokenBudget.toLocaleString()}-token budget` };
          const interrupt = (this.adapter as { interrupt?: (id: string) => Promise<void> }).interrupt;
          void interrupt?.call(this.adapter, sessionId).catch(() => {});
        }
      }
    } catch (err) {
      ending = { state: "failed", detail: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      abort.abort();
      this.turns.delete(genesisId);
    }

    const final = ending ?? { state: "failed" as const, detail: "the event stream ended unexpectedly" };
    if (final.state !== "completed") this.sessions.delete(genesisId);
    if (final.state === "completed") {
      if (replyText.trim().length > 0) {
        this.emit({ at: at(), type: "genesis.turn", genesisId, role: "gate", text: replyText.trim() });
      }
      // The draft is whatever the agent wrote — tolerant parse, absent file is simply no draft.
      try {
        const raw = await readFile(join(dir, "draft.json"), "utf8");
        const parsed = GenesisDraftSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          this.emit({ at: at(), type: "genesis.draft", genesisId, draft: parsed.data });
        }
      } catch {
        /* no draft yet — the rail keeps its last state */
      }
    }
    status(final.state, final.detail);
  }
}

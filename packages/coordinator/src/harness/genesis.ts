import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  GenesisDraftSchema,
  type DomainEvent,
  type GenesisDraft,
  type HarnessAdapter,
} from "@arke-studio/contracts";
import { GENESIS_ATTACHMENTS_DIR, sandboxAttachments } from "../artifacts/genesis-attachments.js";
import { atomicWriteFile } from "../world/atomic.js";
import { THINKING_LABEL, WRITING_LABEL, workingLabel } from "../world-chat/project.js";

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

/**
 * The floor for one creation conversation's spend, when nobody can say what model is answering.
 *
 * What this guards is a runaway — an agent looping on its own output until somebody notices. It
 * was never meant to ration honest work, and as a flat 120,000 it did: a creation conversation
 * where the author attaches a series bible spends most of that reading it, and the turns after
 * were interrupted mid-sentence with "passed the 120,000-token budget".
 */
const FALLBACK_TOKEN_BUDGET = 120_000;

/**
 * How many full windows one creation conversation may spend before it is called a runaway.
 *
 * A turn may legitimately fill the model's input window — that is what the prompt budget now
 * allows — so a session budget worth less than a few of them stops the work rather than the loop.
 * Ten is not a measured figure; it is comfortably more than a person types through and still
 * finite, which is the only property the guard actually needs.
 */
const SESSION_WINDOWS = 10;

/** What one creation conversation may spend, from the window of the model that answers it. */
export function genesisTokenBudget(inputTokenLimit: number | null | undefined): number {
  if (!inputTokenLimit || inputTokenLimit <= 0) return FALLBACK_TOKEN_BUDGET;
  return Math.max(FALLBACK_TOKEN_BUDGET, inputTokenLimit * SESSION_WINDOWS);
}
/** The follow-up that asks for the draft alone is short work; it does not get the full clock. */
const DRAFT_ASK_MS = 60_000;

/** Asked only when the agent replied without touching draft.json. */
const DRAFT_REQUEST = `Now write ./draft.json for the world as it stands after that reply, and return its
contents as your whole message — JSON only, no prose, no code fence. Same shape as before:

{"name": "...", "logline": "one sentence", "tone": "two or three words", "genre": "...",
 "characters": [{"name": "...", "line": "one line on who they are"}],
 "locations": [{"name": "...", "line": "one line on the place"}],
 "threads": ["an open question worth pulling later"]}

Omit anything not settled. If nothing has been settled yet, return {}.`;

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
  /**
   * Which attachments the agent has already been told about. Handing over a file has to mean
   * something in the conversation — the file is in its working directory, but a model does not
   * go looking. Announced once each: a list repeated every turn reads as an instruction to keep
   * re-reading them.
   */
  private readonly announced = new Map<string, Set<string>>();

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
    this.announced.delete(genesisId);
  }

  /** The line that tells the agent what it has been handed, for files it has not seen named. */
  private async handoverNote(dir: string, genesisId: string): Promise<string> {
    const seen = this.announced.get(genesisId) ?? new Set<string>();
    const fresh = (await sandboxAttachments(dir)).map((p) => basename(p)).filter((n) => !seen.has(n));
    if (fresh.length === 0) return "";
    for (const name of fresh) seen.add(name);
    this.announced.set(genesisId, seen);
    const list = fresh.map((n) => `./${GENESIS_ATTACHMENTS_DIR}/${n}`).join(", ");
    return `\n\n[The author has attached ${list} — read what is useful before replying, and use it rather than inventing around it.]`;
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

    // What the rail already holds, so we can tell a draft the agent updated from one it ignored.
    const draftBefore = await this.readDraft(dir);

    this.emit({ at: at(), type: "genesis.turn", genesisId, role: "user", text });

    const run: ActiveTurn = { sessionId, cancelled: false };
    this.turns.set(genesisId, run);
    status("running");

    const wallClock = this.opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    const tokenBudget =
      this.opts.tokenBudget ?? genesisTokenBudget(this.adapter.knownInputTokenLimit?.());
    const abort = new AbortController();
    let ending: { state: "completed" | "cancelled" | "timeout" | "budget-exceeded" | "failed"; detail?: string } | null =
      null;
    const timer = setTimeout(() => {
      ending = { state: "timeout", detail: `hit the ${Math.round(wallClock / 1000)}s wall-clock limit` };
      const interrupt = (this.adapter as { interrupt?: (id: string) => Promise<void> }).interrupt;
      void interrupt?.call(this.adapter, sessionId).catch(() => {});
      // And end the wait ourselves. Asking the harness to stop and then waiting for it to say
      // so is not a deadline — it is a hope. A session with nothing running answers an
      // interrupt with silence, and the turn sat on "shaping the draft…" indefinitely.
      abort.abort();
    }, wallClock);
    // Refed, and cleared in `finally` — see AuthoringService for why an unref'd deadline is
    // no deadline at all.
    const usage = (this.adapter as { usageTokens?: (id: string) => number }).usageTokens;
    let replyText = "";

    // The turn in flight, one verb at a time — the same working surface world chat has.
    // Without it the genesis chat sat silent for a whole model turn, which reads as broken.
    const progress = (label: string) => this.emit({ at: at(), type: "genesis.progress", genesisId, label });
    let writing = false;

    try {
      const events = this.adapter.streamEvents(abort.signal);
      const handover = await this.handoverNote(dir, genesisId);
      await this.adapter.dispatchAsync({
        sessionId,
        parts: [{ type: "text", text: `${firstTurn ? `${PROTOCOL}\n\n` : ""}${text}${handover}` }],
      });
      progress(THINKING_LABEL);

      for await (const event of events) {
        if (!("sessionId" in event) || event.sessionId !== sessionId) continue;
        if (event.type === "tool.activity") {
          // The tool, never its summary — the verb is all a progress line is allowed to be.
          progress(workingLabel(event.tool));
          writing = false;
        }
        if (event.type === "message.delta") {
          if (!writing) {
            // Once per stretch of writing, not per token: a label that changes on every delta
            // is a strobe, and it would say the same word each time anyway.
            writing = true;
            progress(WRITING_LABEL);
          }
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

    const final = ending ?? {
      state: "failed" as const,
      detail: "the studio stopped replying before it finished — nothing was written",
    };
    if (final.state !== "completed") this.sessions.delete(genesisId);
    if (final.state === "completed") {
      if (replyText.trim().length > 0) {
        this.emit({ at: at(), type: "genesis.turn", genesisId, role: "gate", text: replyText.trim() });
      }
      // The draft the agent wrote, if it wrote one. Asking a model to hold a conversation AND
      // keep a file up to date gets the conversation and not the file most of the time — so
      // when the file has not moved, we ask for the draft on its own and write it ourselves.
      // The file stays the record either way; only who typed it changes.
      let draft = await this.readDraft(dir);
      if (draft === null || sameDraft(draft, draftBefore)) {
        const recovered = await this.askForDraft(sessionId, dir);
        if (recovered !== null) draft = recovered;
      }
      if (draft !== null && !sameDraft(draft, draftBefore)) {
        this.emit({ at: at(), type: "genesis.draft", genesisId, draft });
      }
    }
    status(final.state, final.detail);
  }

  /** The draft as it stands on disk. Absent or malformed reads as no draft, never as an error. */
  private async readDraft(dir: string): Promise<GenesisDraft | null> {
    try {
      const parsed = GenesisDraftSchema.safeParse(JSON.parse(await readFile(join(dir, "draft.json"), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * The agent talked but did not update the draft. Ask for the draft alone — one narrow turn,
   * no conversation to compete with — and write the file here. Returns null if that fails too,
   * which leaves the rail exactly as it was: a turn that adds nothing is not an error.
   */
  private async askForDraft(sessionId: string, dir: string): Promise<GenesisDraft | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), DRAFT_ASK_MS);
    try {
      const events = this.adapter.streamEvents(abort.signal);
      await this.adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: DRAFT_REQUEST }] });
      let reply = "";
      for await (const event of events) {
        if (!("sessionId" in event) || event.sessionId !== sessionId) continue;
        if (event.type === "message.delta") reply = event.text;
        else if (event.type === "message.completed") {
          reply = event.text;
          break;
        } else if (event.type === "session.error" || event.type === "session.ended") break;
      }
      const draft = parseDraftFrom(reply);
      if (draft === null) return null;
      await atomicWriteFile(join(dir, "draft.json"), JSON.stringify(draft, null, 2) + "\n");
      return draft;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
}

/** Has anything actually been settled? Empty lists and no title is a draft of nothing. */
function saysSomething(draft: GenesisDraft): boolean {
  return (
    draft.name !== undefined ||
    draft.logline !== undefined ||
    draft.tone !== undefined ||
    draft.genre !== undefined ||
    draft.characters.length > 0 ||
    draft.locations.length > 0 ||
    draft.threads.length > 0
  );
}

/** Two drafts are the same when they say the same thing — the rail should not flicker. */
function sameDraft(a: GenesisDraft | null, b: GenesisDraft | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Pull the draft out of a reply. Models fence JSON, prefix it with a sentence, or answer with
 * it bare; all three are the same answer. The outermost braces win, and the schema decides.
 */
export function parseDraftFrom(reply: string): GenesisDraft | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
  const candidates = [fenced?.[1], reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1), reply];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.trim() === "") continue;
    try {
      const parsed = GenesisDraftSchema.safeParse(JSON.parse(candidate));
      // `{}` parses cleanly — the schema fills the lists — but says nothing. A draft that
      // settles nothing must not overwrite one that settled something.
      if (parsed.success && saysSomething(parsed.data)) return parsed.data;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

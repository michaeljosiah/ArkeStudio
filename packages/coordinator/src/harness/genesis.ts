import { createPreparedSession, type SessionInput } from "./session-files.js";
import { basename, join } from "node:path";
import {
  GenesisDraftSchema,
  type DomainEvent,
  type GenesisDraft,
  type HarnessAdapter,
} from "@arke-studio/contracts";
import { GENESIS_ATTACHMENTS_DIR, sandboxAttachments } from "../artifacts/genesis-attachments.js";
import { blueprintSaysSomething, foldBlueprint, sameBlueprint } from "./blueprint.js";
import { sessionTokenBudget } from "./token-budget.js";
import { atomicWriteFile } from "../world/atomic.js";
import { THINKING_LABEL, WRITING_LABEL, workingLabel } from "../world-chat/project.js";

/**
 * Genesis conversations (prototype 12a; SPEC-031 §1.3): a world that does not exist yet is
 * shaped in a sandbox directory by the world-author agent. The protocol is file-based like
 * everything else here — after each reply the agent maintains a blueprint: draft.json for
 * identity, look, bible and threads, and one small file per character, place and faction
 * under draft/. The fold over that directory is the "world so far" rail. Nothing lands until
 * Begin-in-this-world walks the blueprint through the ordinary creation gates; abandoning
 * the conversation costs a directory delete.
 */

export interface GenesisOptions {
  /** Studio's session input, enriched with live Settings; the adapter decides what lands on disk. */
  sessionInput: SessionInput;
  wallClockMs?: number;
  tokenBudget?: number;
}

interface ActiveTurn {
  sessionId: string | null;
  cancelled: boolean;
}

/**
 * How long before a turn is called hung rather than slow (§19).
 *
 * It catches a run that will never arrive; it is not there to police work that takes a while.
 * Two things make a generous figure the right one: a person can stop a turn themselves, from the
 * working line where they can see how long it has been going — so the clock is the backstop and
 * not the control — and a turn may now legitimately take far longer than it used to, because the
 * prompt it carries is bounded by the model's window rather than by a fixed character count.
 */
const DEFAULT_WALL_CLOCK_MS = 15 * 60_000;

/**
 * The floor for one creation conversation, when no model window can be named.
 *
 * What replaced the flat figure, and why, is beside `sessionTokenBudget`.
 */
const FALLBACK_TOKEN_BUDGET = 120_000;

/** The follow-up that asks for the draft alone is short work; it does not get the full clock. */
const DRAFT_ASK_MS = 5 * 60_000;

/** Asked only when the agent replied without touching the blueprint. */
const DRAFT_REQUEST = `Now write ./draft.json for the world as it stands after that reply, and return its
contents as your whole message — JSON only, no prose, no code fence. Same shape as before,
plus one-line entries for any cast or places you have not yet written files for:

{"name": "...", "logline": "one sentence", "tone": "two or three words", "genre": "...",
 "look": "how this world should look, in your own words",
 "characters": [{"name": "...", "line": "one line on who they are"}],
 "locations": [{"name": "...", "line": "one line on the place"}],
 "threads": ["an open question worth pulling later"],
 "bible": "a few paragraphs of prose: the through-line, the shape, what it is about",
 "keyArt": {"subject": "what the world's one image holds", "moment": "the moment it catches",
  "stakes": "what is at stake in it", "characters": ["names in frame"], "location": "the place in frame"}}

Omit anything not settled. If nothing has been settled yet, return {}.`;

/** Sent once, ahead of the first user message — the blueprint contract (SPEC-031 §1.3). */
const PROTOCOL = `You are shaping a brand-new story world in conversation with its author. Reply briefly and
concretely — offer names, textures and consequences, ask one good question at a time, and never
bury the author in lore.

You keep the plan for this world as small files, so the studio can build the world the moment
the author says go. After EVERY reply, bring the files up to date with what was actually
discussed — and touch only the files that reply changed.

./draft.json — the world itself (overwrite it), omitting fields you have not settled yet:

{"name": "...", "logline": "one sentence", "tone": "two or three words", "genre": "...",
 "look": "how everything this world renders should look, in your own words — palette, light, medium, mood",
 "threads": ["an open question worth pulling later"],
 "bible": "a few paragraphs of prose: the through-line, the shape, what it is about",
 "keyArt": {"subject": "what the world's one image holds", "moment": "the moment it catches",
  "stakes": "what is at stake in it", "characters": ["names of cast members in frame"],
  "location": "the place in frame, if one"}}

./draft/characters/<slug>.json — one file per character, and likewise
./draft/locations/<slug>.json and ./draft/factions/<slug>.json. Pick a short lowercase slug
when the entity first appears and never rename the file: the filename is the identity, and the
name inside it can change freely. A character file:

{"name": "...", "line": "one line on who they are",
 "description": "a short paragraph of who they are in this story",
 "brief": {"apparentAge": "...", "build": "...", "colouring": "...", "hair": "...",
  "wardrobe": "...", "bearing": "...", "defaultExpression": "..."}}

A location's brief instead holds {"establishingView": "what one establishing view of it holds",
"hour": "...", "weather": "...", "season": "..."}. A faction file has no brief. A brief holds
subject facts only — who or what would be in a picture. Never style, medium, lens or anything
aimed at an image model; the look covers that once, for everything. If the author takes an
entity back out of the story, set "withdrawn": true in its file.

"keyArt" is sent to an image model with the cast's photos alongside it, so compose it the way
a poster would: a face, a hand, an object, a doorway, the thing the story turns on — one
detail rather than a room full of figures. Keep bodies and sleepwear out of the frame, and
never put young cast in bedrooms, nightclothes, bathing or undress: the image model refuses
such a picture outright and the world is founded without its art. The narrower image is
almost always the stronger one.

Propose "look" yourself once tone and genre have settled — your reading of everything
discussed, which the author sees and can rewrite. Keep quiet track of what is still blank —
premise, cast, places, the through-line, the look, and the world's one image — and when the
conversation has room, raise the most valuable blank as your one question.

Everything in these files is proposed, not settled — keep them small and true to what was
actually discussed.

"bible" is the exception to keeping it small, and the one field written to be read rather than
looked up. It becomes the world's bible: the document the author and everyone working on the
world open first. Write it once the shape of the story is clear — the argument underneath it,
the arc from where it opens to where it ends, the turn it is built around, who it is for. Use
the author's own framing and their words where they said something well. Prose, in Markdown,
with headings if it helps. Do not restate the cast and the places; they have their own files.
Leave it out entirely while the conversation is still finding what the story is.

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
    const run: ActiveTurn = { sessionId: null, cancelled: false };
    this.turns.set(genesisId, run);
    status("running");

    let sessionId = this.sessions.get(genesisId);
    const firstTurn = sessionId === undefined;
    if (sessionId === undefined) {
      // Same confinement config as authoring sessions — no world, so no world-query MCP. Research
      // still works here: `web` is a harness tool the confinement grants, not an MCP one, so the
      // door can go and look something up before there is any world to scope a lookup to.
      try {
        const session = await createPreparedSession(this.adapter, dir, this.opts.sessionInput({}), {
          purpose: "drafting",
          agent: "world-author",
        });
        sessionId = session.sessionId;
        this.sessions.set(genesisId, sessionId);
      } catch (err) {
        this.turns.delete(genesisId);
        status("failed", `could not create a session: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    run.sessionId = sessionId;

    // What the rail already holds, so we can tell a blueprint the agent updated from one it
    // ignored. The fold covers draft.json and every entity file — a turn that only touched
    // one character's file still reads as a change.
    const blueprintBefore = await foldBlueprint(dir);

    this.emit({ at: at(), type: "genesis.turn", genesisId, role: "user", text });

    const wallClock = this.opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    const tokenBudget =
      this.opts.tokenBudget ??
      sessionTokenBudget(this.adapter.knownInputTokenLimit?.(), FALLBACK_TOKEN_BUDGET);
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
      // The blueprint the agent wrote, if it wrote to it. Asking a model to hold a
      // conversation AND keep files up to date gets the conversation and not the files most
      // of the time — so when nothing moved, OR draft.json itself failed to parse (an
      // over-cap look, a torn write), we ask for draft.json on its own and write it
      // ourselves. The rescue is deliberately narrow (§2.2): draft.json is small now, and
      // the entity files fail one at a time rather than taking the world with them.
      let blueprint = await foldBlueprint(dir);
      if (sameBlueprint(blueprint, blueprintBefore) || blueprint.dropped.includes("draft.json")) {
        const recovered = await this.askForDraft(sessionId, dir);
        if (recovered !== null) blueprint = await foldBlueprint(dir);
      }
      // Emitted when it changed and either side says something — a withdrawal that empties
      // the plan is still a change the rail must see (R-2). A draft.json that is still
      // unreadable is not emitted: blanking the identity the rail already holds would trade
      // a stale name for no name.
      if (
        !sameBlueprint(blueprint, blueprintBefore) &&
        !blueprint.dropped.includes("draft.json") &&
        (blueprintSaysSomething(blueprint) || (blueprintBefore !== null && blueprintSaysSomething(blueprintBefore)))
      ) {
        this.emit({ at: at(), type: "genesis.blueprint", genesisId, blueprint });
      }
    }
    status(final.state, final.detail);
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
    draft.look !== undefined ||
    draft.keyArt !== undefined ||
    draft.characters.length > 0 ||
    draft.locations.length > 0 ||
    draft.threads.length > 0 ||
    // A draft that is only a bible is the shape a long conversation about what the story means
    // arrives in, before anyone has named a single character. Left off this list, the recovery
    // path threw away the one field that took the whole conversation to write.
    draft.bible !== undefined
  );
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

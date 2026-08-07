import type {
  CandidateTombstone,
  WorldChangeCandidate,
  WorldChatMessage,
} from "@arke-studio/contracts";
import { contentHash } from "./observations.js";

/**
 * What a run is allowed to see (#70 §8.5).
 *
 * Every section has a stated bound, and the bounds are enforced here rather than trusted to
 * happen. The rule underneath them is the one worth keeping: the model never inherits unbounded
 * history invisibly. A conversation that has been going for two hours must cost the same as one
 * that started five minutes ago, or the app quietly becomes slower, more expensive and less
 * predictable the longer somebody uses it — and nobody would be able to point at when it changed.
 *
 * The current user message is the single exception, and it is never truncated. Cutting what
 * somebody just typed, mid-sentence, to fit a budget would be the app losing part of what they
 * said without telling them. Oversized input becomes a private attachment instead (§19).
 */

export const BOUNDS = {
  summary: 8_000,
  registry: 16_000,
  recentTurns: 32_000,
  worldContext: 32_000,
} as const;

/** How many complete turns of history a run sees before summarisation takes over (§8.5). */
export const RECENT_TURN_COUNT = 8;

export interface ContextInput {
  /**
   * What the conversation was opened about (#70 phase 6).
   *
   * Recorded on the conversation and given to every turn, because a conversation started from a
   * character sheet is about that character from its first word — making somebody re-describe
   * what they were looking at is the toll the entry points exist to remove.
   */
  entryContext?: string;
  summary?: string;
  candidates: readonly WorldChangeCandidate[];
  messages: readonly WorldChatMessage[];
  tombstones: readonly CandidateTombstone[];
  worldContext?: string;
  currentUserMessage: string;
}

export interface AssembledContext {
  entryContext: string;
  summary: string;
  /** Live propositions, so the model can correct rather than repeat them. */
  registry: string;
  recentTurns: string;
  worldContext: string;
  /** Structural keys and digests only — enough to not re-propose, not enough to reconstruct. */
  tombstones: string;
  currentUserMessage: string;
  /** What identifies this exact context, recorded on the run (§5.3). */
  digest: string;
  /** Sections that had to be trimmed, so the trimming is never silent. */
  trimmed: string[];
}

/**
 * Trim to a bound at a line boundary, keeping the most recent content.
 *
 * Oldest-first is deliberate: in a conversation the recent material is the material that is
 * still being talked about.
 */
function trimToBound(text: string, bound: number): { text: string; trimmed: boolean } {
  if (text.length <= bound) return { text, trimmed: false };
  const cut = text.slice(text.length - bound);
  const boundary = cut.indexOf("\n");
  return { text: boundary === -1 ? cut : cut.slice(boundary + 1), trimmed: true };
}

function renderRegistry(candidates: readonly WorldChangeCandidate[]): string {
  return candidates
    .filter((c) => c.status === "live")
    .map((c) => `- [${c.id} r${c.revision}] (${c.classification}, ${c.settledness}) ${c.title}`)
    .join("\n");
}

function renderTurns(messages: readonly WorldChatMessage[]): string {
  return messages.map((m) => `${m.role === "user" ? "User" : "Studio"}: ${m.text}`).join("\n\n");
}

/**
 * Tombstones travel as keys and digests, never as their original text (§8.5).
 *
 * The model needs to know not to re-propose something. It does not need to be reminded what the
 * retracted idea was — that would put the withdrawn text back in front of it every turn, which
 * is the opposite of what the user asked for when they said to forget it.
 */
function renderTombstones(tombstones: readonly CandidateTombstone[]): string {
  return tombstones.map((t) => `- ${t.structuralKey} :: ${t.payloadDigest}`).join("\n");
}

export function assembleContext(input: ContextInput): AssembledContext {
  const trimmed: string[] = [];

  const take = (name: string, text: string, bound: number): string => {
    const result = trimToBound(text, bound);
    if (result.trimmed) trimmed.push(name);
    return result.text;
  };

  const summary = take("summary", input.summary ?? "", BOUNDS.summary);
  const registry = take("registry", renderRegistry(input.candidates), BOUNDS.registry);
  const recentTurns = take(
    "recentTurns",
    renderTurns(input.messages.slice(-RECENT_TURN_COUNT * 2)),
    BOUNDS.recentTurns,
  );
  const worldContext = take("worldContext", input.worldContext ?? "", BOUNDS.worldContext);
  const tombstones = renderTombstones(input.tombstones);

  return {
    // Never trimmed: it is one short line, and it is the frame for everything else.
    entryContext: input.entryContext ?? "",
    summary,
    registry,
    recentTurns,
    worldContext,
    tombstones,
    // Never trimmed. See the note at the top of this file.
    currentUserMessage: input.currentUserMessage,
    digest: contentHash({
      entryContext: input.entryContext ?? "",
      summary,
      registry,
      recentTurns,
      worldContext,
      tombstones,
      current: input.currentUserMessage,
    }),
    trimmed,
  };
}

/**
 * Whether it is time to summarise (§8.6).
 *
 * Either enough turns have passed, or the recent-turn section has reached its bound — the second
 * matters because eight short turns and eight long ones are not the same amount of history.
 */
export function shouldSummarise(input: { turnCount: number; recentTurnsLength: number }): boolean {
  return input.turnCount >= RECENT_TURN_COUNT || input.recentTurnsLength >= BOUNDS.recentTurns;
}

/**
 * A summary is context, never authority (§8.6).
 *
 * Messages remain the source for what was said, candidates for what was detected, world files for
 * what is true. Evidence never cites a summary, which is why nothing here produces one: a
 * summary that could be quoted would become a second, lossier account of the conversation that
 * propositions could be built on.
 */
export interface SummaryInput {
  throughSeq: number;
  sourceMessageIds: readonly string[];
  text: string;
}

export function boundSummary(input: SummaryInput): SummaryInput {
  return { ...input, text: input.text.slice(0, BOUNDS.summary) };
}

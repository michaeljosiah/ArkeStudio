import type {
  CandidateGroup,
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
  /** Matches MAX_TEXT_PER_RUN_CHARS: what one run may read out of attachments in total (§19). */
  attachments: 32_000,
} as const;

/** How many complete turns of history a run sees before summarisation takes over (§8.5). */
export const RECENT_TURN_COUNT = 8;

/**
 * One attachment as the model needs to know it (§13.2).
 *
 * `text` is present only for what can honestly be read. An unreadable file is still named — the
 * model must be able to say "I can see you attached a PNG and I cannot read it" rather than
 * denying it exists, which is what silence produces.
 *
 * `id` and `contentHash` travel for the same reason message ids do: attachment evidence requires
 * both, and evidence can only cite what the prompt shows. Rendering the text without them left
 * every attachment quotation unwriteable — the model had to invent an id, and the verifier then
 * rejected the whole turn. `get_attachment_text` is no way round it either: that tool takes the
 * very id this is the only place to learn.
 */
export interface ContextAttachment {
  id: string;
  contentHash: string;
  fileName: string;
  kind: string;
  readable: boolean;
  text?: string;
}

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
  /** Live groups, so an operation on one can name it. Empty when nothing has been grouped. */
  groups?: readonly CandidateGroup[];
  messages: readonly WorldChatMessage[];
  tombstones: readonly CandidateTombstone[];
  worldContext?: string;
  /** Linked to this turn. Empty for a turn that handed nothing over. */
  attachments?: readonly ContextAttachment[];
  currentUserMessage: string;
  /**
   * The durable id of the message being answered, shown to the model beside the text.
   *
   * Message evidence requires a messageId, and the model can only cite an id it has been shown —
   * the first live turn of World Chat failed on exactly this: the schema demanded an id the
   * prompt never rendered, so no answer could ever validate. On a retry this is the original
   * message's id, because that is the record the evidence must verify against.
   */
  currentUserMessageId: string;
}

export interface AssembledContext {
  entryContext: string;
  summary: string;
  /** Live propositions, so the model can correct rather than repeat them. */
  registry: string;
  recentTurns: string;
  worldContext: string;
  /** What was handed over this turn, named and — where readable — quoted. */
  attachments: string;
  /** Structural keys and digests only — enough to not re-propose, not enough to reconstruct. */
  tombstones: string;
  currentUserMessage: string;
  currentUserMessageId: string;
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

/**
 * The live propositions and groups, each with everything an operation on it has to restate.
 *
 * Groups are here for the same reason candidates are: `update` and `withdraw` carry a `grp_...`
 * id and its expected revision, and an id that is nowhere in the prompt can only be guessed at.
 *
 * They carry their rationale and their exact membership for a second reason. A group update
 * replaces the whole group — title, rationale and members together — so anything omitted here is
 * something the model has to invent to say anything at all. Inventing a membership is the worst
 * of the three: a plausible guess validates, and quietly re-forms which propositions must land
 * together, which is the one promise a group exists to make.
 */
function renderRegistry(
  candidates: readonly WorldChangeCandidate[],
  groups: readonly CandidateGroup[],
): string {
  const lines = candidates
    .filter((c) => c.status === "live")
    .map((c) => `- [${c.id} r${c.revision}] (${c.classification}, ${c.settledness}) ${c.title}`);
  const groupLines = groups
    .filter((g) => g.status === "live")
    .flatMap((g) => [
      `- [${g.id} r${g.revision}] ${g.title}`,
      `  rationale: ${g.rationale}`,
      `  members: ${g.members.map((m) => `${m.candidateId} r${m.revision}`).join(", ")}`,
    ]);
  if (groupLines.length === 0) return lines.join("\n");
  return [...lines, "", "Groups (an update restates all three fields):", ...groupLines].join("\n");
}

/**
 * Every user line opens with its durable id, because evidence has to cite one. Studio lines do
 * not, because nothing the Studio said is evidence of anything.
 *
 * The id is product identity, not model output: the model copies it into a `messageId` field,
 * and evidence verification then checks the quote against that exact message. Without the ids
 * here there is nothing valid to copy, and every citation of the conversation is an invention.
 *
 * Withholding them from Studio lines is the other half. An id on its own reply is an invitation
 * to cite it, and a proposition evidenced by the Studio's earlier prose is a claim about a claim:
 * an inference from two turns ago would come back as a fact the user is told they asked for.
 * The verifier refuses those anyway — this stops the model spending a turn on one.
 */
function renderTurns(messages: readonly WorldChatMessage[]): string {
  return messages
    .map((m) => (m.role === "user" ? `User [${m.id}]: ${m.text}` : `Studio: ${m.text}`))
    .join("\n\n");
}

/**
 * What was handed over, inlined rather than left to a tool call (§13.2).
 *
 * The text is put in front of the model rather than only offered through `get_attachment_text`,
 * and that is a deliberate departure from the obvious reading of the spec. Naming a file and
 * trusting the model to go and fetch it has one failure mode, and it is the one a user actually
 * hit: the model does not call the tool, then says it cannot see any attachment. Somebody who
 * pasted a document and was told it does not exist has no way to tell a missing feature from a
 * broken one, and no action that would fix it — they paste it again, and are told again.
 *
 * The tool remains, for reading further into something longer than the bound. It is the way to
 * read *more*, not the only way to read at all.
 *
 * An unreadable attachment is still named, with what it is and that it cannot be read. Silence
 * about it produces a denial, which is worse than a refusal: the file plainly went somewhere.
 */
const CUT_NOTE = "[Cut off here. Read further with get_attachment_text rather than guessing at the rest.]";

/**
 * The budget is shared out per document rather than spent in order.
 *
 * Cutting the concatenation at a total bound spends it first-come: five documents with long
 * openings and the fifth one's heading falls off the end — name, id and hash with it. That is
 * the worst thing to lose, because the id is what `get_attachment_text` needs, so the one
 * document the model was told least about is also the only one it cannot go and read. Every
 * attachment now keeps its identity and a share of the text.
 */
function renderAttachments(
  attachments: readonly ContextAttachment[],
  budget: number,
): { text: string; trimmed: boolean } {
  if (attachments.length === 0) return { text: "", trimmed: false };
  const share = Math.floor(budget / attachments.length);
  let trimmed = false;
  const blocks = attachments.map((a) => {
    // The identity line is what makes a quotation of this document citable at all; it is
    // printed for unreadable files too, so an image can still be referred to by id.
    const head = `### ${a.fileName} (${a.kind})\nattachmentId: ${a.id}\ncontentHash: ${a.contentHash}`;
    if (!a.readable || a.text === undefined) {
      return `${head}\nAttached, and cannot be read as text here. Say so plainly if it is relevant; do not guess at what it contains.`;
    }
    // Less the newline after the heading, the blank line before the note, and the blank line
    // that joins this block to the next — a share that ignored them would overrun the bound.
    const room = Math.max(0, share - head.length - CUT_NOTE.length - 5);
    if (a.text.length <= room) return `${head}\n${a.text}`;
    trimmed = true;
    // The beginning, as before: a document was handed over whole and starts at its start, so
    // keeping the tail would give the model the last page of something it never saw page one of.
    return `${head}\n${a.text.slice(0, room)}\n\n${CUT_NOTE}`;
  });
  return { text: blocks.join("\n\n"), trimmed };
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
  const registry = take("registry", renderRegistry(input.candidates, input.groups ?? []), BOUNDS.registry);
  const recentTurns = take(
    "recentTurns",
    renderTurns(input.messages.slice(-RECENT_TURN_COUNT * 2)),
    BOUNDS.recentTurns,
  );
  const worldContext = take("worldContext", input.worldContext ?? "", BOUNDS.worldContext);
  const tombstones = renderTombstones(input.tombstones);
  /**
   * Cut per document and from the *end* of each, unlike every other section.
   *
   * The others keep their most recent lines because a conversation's recent material is what is
   * still being talked about. A document is the other way round: it was handed over whole and
   * starts at its beginning, so keeping the tail would hand the model the last page of something
   * it was never given the first page of.
   */
  const rendered = renderAttachments(input.attachments ?? [], BOUNDS.attachments);
  if (rendered.trimmed) trimmed.push("attachments");
  const attachments = rendered.text;

  return {
    // Never trimmed: it is one short line, and it is the frame for everything else.
    entryContext: input.entryContext ?? "",
    summary,
    registry,
    recentTurns,
    worldContext,
    attachments,
    tombstones,
    // Never trimmed. See the note at the top of this file.
    currentUserMessage: input.currentUserMessage,
    currentUserMessageId: input.currentUserMessageId,
    digest: contentHash({
      entryContext: input.entryContext ?? "",
      summary,
      registry,
      recentTurns,
      worldContext,
      // In the digest because two turns differing only by what was handed over are different
      // turns, and the run record should not claim they had the same context.
      attachments,
      tombstones,
      current: input.currentUserMessage,
      currentId: input.currentUserMessageId,
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

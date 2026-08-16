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
 * One budget, taken from the context window of the model that is actually going to answer, and
 * spent only when there is not enough room for everything. Nothing is cut while it fits.
 *
 * It used to be a fixed character bound per section — 8k of summary, 32k of world, 32k of
 * attachments shared between them — which came to about 30k tokens against models holding
 * 372,000 and more. A document somebody attached for this turn was cut to a third of a third of
 * what the model could comfortably read, and the reply was written out of the fraction that
 * survived. The person could see the whole document on their own screen and had no way to know
 * which part the Studio had been given.
 *
 * When the limit is not known the floor below applies, which is what the fixed bounds added up
 * to: the same behaviour as before rather than a guess that might overflow a small model.
 */

/**
 * The budget when nobody could say what model is answering — the old bounds, added up.
 *
 * A floor rather than a guess: an unknown model may be a small one, and overflowing it fails the
 * turn outright, which is worse than the trimming this replaces.
 */
export const FALLBACK_BUDGET_CHARS = 120_000;

/**
 * Characters per token, for turning a model's token window into a character budget.
 *
 * Deliberately pessimistic. English prose runs nearer four, and assuming three leaves the
 * arithmetic wrong in the safe direction on prose that tokenises badly — names, ids, JSON.
 */
const CHARS_PER_TOKEN = 3;

/**
 * How much of the input window this prompt may fill: all of it.
 *
 * The window a provider states as `input` is already the room a prompt has — `input` plus
 * `output` is the whole context, so the reply is accounted for before this arithmetic starts.
 * Holding back a further half was reserving space that had already been reserved.
 *
 * What a turn reads afterwards through its tools comes out of the same window, and the slack for
 * that is in `CHARS_PER_TOKEN` above: assuming three characters a token against prose that runs
 * nearer four leaves roughly a quarter of the window unspent by the arithmetic itself.
 */
const WINDOW_SHARE = 1;

/** A character budget from a model's input-token limit, or the floor when there is none. */
export function budgetFor(inputTokenLimit: number | undefined): number {
  if (!inputTokenLimit || inputTokenLimit <= 0) return FALLBACK_BUDGET_CHARS;
  return Math.max(FALLBACK_BUDGET_CHARS, Math.floor(inputTokenLimit * WINDOW_SHARE * CHARS_PER_TOKEN));
}

/**
 * What gets cut first when there genuinely is not room, and what is never cut.
 *
 * Ordered by what a turn can most afford to lose. Recent turns go first because the summary
 * already carries what they were about; attachments go last of the trimmable sections because
 * they are what the person handed over for *this* turn, which is the same reason the current
 * message is not on this list at all. The bible is absent for the reason stated beside it.
 */
const SACRIFICE_ORDER = ["recentTurns", "worldContext", "summary", "registry", "attachments"] as const;

/**
 * When a conversation is long enough to be worth summarising.
 *
 * Unrelated to the prompt budget, and it always was: this is about a conversation having enough
 * history to be worth condensing, not about running out of room to send it.
 */
const SUMMARISE_AFTER_CHARS = 32_000;

/** A summary is a summary. Longer than this and it is a second copy of the conversation. */
const MAX_SUMMARY_CHARS = 8_000;

/**
 * The bible is deliberately absent from BOUNDS: it is never trimmed (SPEC-022).
 *
 * That is a departure from the rule above, and a considered one. The section is the author's own
 * document, loaded whole because a bible the Studio has only half of is worse than useless — it
 * would answer confidently out of the half it holds, and the author, who can see the whole thing
 * on their own screen, has no way to know which half that was.
 *
 * What the rule above is actually defending survives intact. Its worry is *unbounded history*:
 * conversation context that grows the longer somebody talks, so that the same question costs
 * more at teatime than it did at breakfast. The bible does not do that. It is the same size on
 * turn one and turn fifty, and it changes only when somebody edits it deliberately.
 *
 * What replaces the bound is visibility: `bibleSize` feeds a meter on the Bible screen, and the
 * agent is told not to append to it unprompted. A document that is loaded every turn and also
 * written every turn is the one way this could grow without anybody choosing it.
 */

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
  /** The author's bible, whole and untrimmed (SPEC-022). Empty when they have not started one. */
  bible?: string;
  /**
   * What this prompt may spend, in characters, from the answering model's own window.
   *
   * Absent means nobody could say which model is answering, and the floor applies.
   */
  budgetChars?: number;
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
  /** The bible with its framing line, or "" when there is none. Never trimmed. */
  bible: string;
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
    .flatMap((c) => {
      const head = `- [${c.id} r${c.revision}] (${c.classification}, ${c.settledness}) ${c.title}`;
      /*
       * A look proposition carries its whole replacement description, and an update to one has to
       * restate that description whole. The title alone cannot be revised from: once the turn that
       * wrote it falls out of the recent-turn window, the only text left in front of the model is
       * the *accepted* look — so "make it a bit warmer" would rebuild the update from the look
       * being replaced, and the structural key would then supersede the earlier proposition,
       * silently dropping everything it had said.
       */
      if (c.classification !== "art-direction.change") return [head];
      const description = (c.draft as { description?: string }).description ?? "";
      return description ? [head, `  proposed look: ${description}`] : [head];
    });
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
function renderAttachments(attachments: readonly ContextAttachment[], room?: number): string {
  /*
   * Whole, all of them.
   *
   * These used to share a fixed budget and be cut to `budget / count`, so attaching a second
   * document halved the first — three documents left a 57,000-character bible showing about a
   * fifth of itself, and the reply was written out of that fifth. An attachment is what somebody
   * handed over for this turn, which is the same thing the current message is, so it is treated
   * the same way: given whole, and shortened only if the whole prompt will not fit.
   */
  /*
   * A share each, and only when `room` says there is not enough for all of them.
   *
   * Spending a shortfall down the concatenation instead would take it all out of the last
   * documents — losing their headings, and with them the ids `get_attachment_text` needs to go
   * and read the rest. The one the model is told least about would be the one it cannot look up.
   */
  const share = room === undefined ? undefined : Math.floor(room / Math.max(1, attachments.length));
  return attachments
    .map((a) => {
      // The identity line is what makes a quotation of this document citable at all; it is
      // printed for unreadable files too, so an image can still be referred to by id.
      const head = [
        `### ${a.fileName} (${a.kind})`,
        `attachmentId: ${a.id}`,
        `contentHash: ${a.contentHash}`,
      ].join("\n");
      if (!a.readable || a.text === undefined) {
        return `${head}\nAttached, and cannot be read as text here. Say so plainly if it is relevant; do not guess at what it contains.`;
      }
      if (share === undefined || a.text.length <= share - head.length - CUT_NOTE.length - 5) {
        return `${head}\n${a.text}`;
      }
      // The beginning: a document was handed over whole and starts at its start, so keeping the
      // tail would give the model the last page of something it never saw page one of.
      const keep = Math.max(0, share - head.length - CUT_NOTE.length - 5);
      return `${head}\n${a.text.slice(0, keep)}\n\n${CUT_NOTE}`;
    })
    .join("\n\n");
}

/**
 * The author's bible, whole, with the one paragraph that says what it is (SPEC-022).
 *
 * The framing is not decoration. A long, confident, first-person document about a world, dropped
 * into a prompt unlabelled, reads exactly like settled fact — and the Studio would then answer
 * out of it, cite it, and defend it, which is the failure SPEC-006's whole grounding pipeline
 * exists to prevent, reintroduced through a side door.
 *
 * The last line is the one that earns its place in practice. A bible and its canon *will* drift:
 * the author writes a thought in March, canon decides otherwise in June, and nobody goes back to
 * the March paragraph. A Studio that notices and says so is doing the drift detection the master
 * spec defers (§6.4). A Studio that silently picks one is worse than useless, because whichever
 * it picks it will sound equally sure.
 */
function renderBible(text: string): string {
  if (text.trim() === "") return "";
  return [
    "This is the author's own bible: their thinking about this world, in their words. It is context, not Canon.",
    "Nothing in it is settled unless a CANON entry says so, and no candidate may cite it as evidence.",
    "Where it and Canon disagree, Canon is what the world has decided — say so rather than choosing between them.",
    "",
    text.trim(),
  ].join("\n");
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
  const budget = input.budgetChars ?? FALLBACK_BUDGET_CHARS;
  const trimmed: string[] = [];

  /*
   * Everything, whole, before anything is measured.
   *
   * The order of these two steps is the change: sections used to be cut to their own bound as
   * they were built, so a document was shortened whether or not there was room for it. Nothing is
   * cut here until the total is known to be too big.
   */
  const sections: Record<(typeof SACRIFICE_ORDER)[number], string> = {
    recentTurns: renderTurns(input.messages.slice(-RECENT_TURN_COUNT * 2)),
    worldContext: input.worldContext ?? "",
    summary: input.summary ?? "",
    registry: renderRegistry(input.candidates, input.groups ?? []),
    attachments: renderAttachments(input.attachments ?? []),
  };
  // Never cut, and so never part of what is spent: see the notes beside each of them.
  const bible = renderBible(input.bible ?? "");
  const tombstones = renderTombstones(input.tombstones);
  const fixed =
    bible.length + tombstones.length + input.currentUserMessage.length + (input.entryContext ?? "").length;

  const spent = () => Object.values(sections).reduce((n, text) => n + text.length, 0);
  /*
   * Cut only as far as it takes, and in the order stated above.
   *
   * Each section gives up what the total is over by, not all of it: a prompt 200 characters too
   * long loses 200 characters of the oldest turns rather than every turn it had.
   */
  for (const name of SACRIFICE_ORDER) {
    const over = fixed + spent() - budget;
    if (over <= 0) break;
    const text = sections[name];
    if (text.length === 0) continue;
    const keep = Math.max(0, text.length - over);
    sections[name] =
      name === "attachments"
        ? renderAttachments(input.attachments ?? [], keep)
        : trimToBound(text, keep).text;
    trimmed.push(name);
  }

  return {
    // Never trimmed: it is one short line, and it is the frame for everything else.
    entryContext: input.entryContext ?? "",
    summary: sections.summary,
    registry: sections.registry,
    recentTurns: sections.recentTurns,
    worldContext: sections.worldContext,
    bible,
    attachments: sections.attachments,
    tombstones,
    // Never trimmed. See the note at the top of this file.
    currentUserMessage: input.currentUserMessage,
    currentUserMessageId: input.currentUserMessageId,
    digest: contentHash({
      entryContext: input.entryContext ?? "",
      summary: sections.summary,
      registry: sections.registry,
      recentTurns: sections.recentTurns,
      worldContext: sections.worldContext,
      // In the digest because the bible is editable from inside the conversation as well as from
      // outside it. Two turns that read different bibles are different turns, and a run record
      // claiming they shared a context would misdate every edit made between them.
      bible,
      // In the digest because two turns differing only by what was handed over are different
      // turns, and the run record should not claim they had the same context.
      attachments: sections.attachments,
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
  return input.turnCount >= RECENT_TURN_COUNT || input.recentTurnsLength >= SUMMARISE_AFTER_CHARS;
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
  return { ...input, text: input.text.slice(0, MAX_SUMMARY_CHARS) };
}

/**
 * The world's look, verbatim, for a model that may be asked to change it.
 *
 * An `art-direction.change` replaces the whole description, and nothing else the model can reach
 * shows it: the retrieval tools cover Canon, sheets, relationships and attachments, and there is
 * no tool for the one string every image is generated from. Told to restate it whole and unable
 * to read it, a model asked to "make it darker and keep the rest" has to invent the rest — and
 * whatever it cannot guess is gone, with nothing on screen to show that it went.
 *
 * Verbatim rather than summarised for the same reason: this is the text being rewritten, so a
 * paraphrase of it would be a different look.
 */
export function currentLookContext(look: { version: number; description: string } | null): string {
  if (!look) return "";
  return [
    `The world look is v${look.version}, and it is what every image is generated from:`,
    "",
    look.description,
    "",
    "An art-direction.change replaces this text entirely. Restate everything that should still be true of the look, not only the part being changed.",
  ].join("\n");
}

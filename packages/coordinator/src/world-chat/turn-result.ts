import { z } from "zod";
import {
  newId,
  WorldChatEntityRefSchema,
  WorldChatTurnResultSchema,
  type BibleEdit,
  type ModelEditorRequest,
  type ModelSceneEdit,
  type CandidateChecks,
  type CandidateEvidence,
  type CandidateGroup,
  type CandidateGroupId,
  type CandidateId,
  type CandidateTombstone,
  type ConversationId,
  type MessageId,
  type ModelCandidateDraft,
  type ModelCandidateRef,
  type WorldChangeCandidate,
  type WorldChatCheckReceipt,
  type WorldChatTurnResult,
} from "@arke-studio/contracts";
import {
  normaliseEvidence,
  safeEvidenceMessage,
  verifyAllEvidence,
  type EvidenceSources,
} from "./evidence.js";
import { findByStructure, payloadDigest, structuralKey, suppressedByTombstone } from "./identity.js";

/**
 * Turning one model message into propositions, or into nothing at all (#70 §8.3, §8.4).
 *
 * The rule that shapes everything here is all-or-nothing. A turn either lands complete — reply
 * and every proposition it describes — or it does not land. There is no partial application.
 *
 * That is not tidiness. The reply is prose that refers to the propositions beside it: "I've noted
 * her aunt, and flagged the thing about the bells". If the reply persisted and two of the three
 * propositions did not, the conversation would contain a confident account of work that does not
 * exist, and the user would have no way to tell. They would find out at wrap-up, when the thing
 * they were told had been noted was not there.
 *
 * So validation runs in full, and any failure rejects the whole result.
 */

export interface TurnProblem {
  code: string;
  /** Safe to send to the model in the one corrective turn. Never carries world content. */
  safeMessage: string;
}

export interface ValidateInput {
  /** The assistant's entire completed message. */
  raw: string;
  conversationId: ConversationId;
  /** The user message this turn is answering — evidence of intent must cite something real. */
  messages: readonly import("@arke-studio/contracts").WorldChatMessage[];
  existing: readonly WorldChangeCandidate[];
  groups: readonly CandidateGroup[];
  tombstones: readonly CandidateTombstone[];
  /** Only receipts this run produced may be cited (§8.4 step 6). */
  receiptsThisRun: readonly WorldChatCheckReceipt[];
  evidenceSources: EvidenceSources;
  /** The coordinator's own checks for a draft, from the check plan it ran (§8.3.1). */
  checksFor: (draft: ModelCandidateDraft) => CandidateChecks;
  now: () => string;
}

export interface AcceptedTurn {
  reply: string;
  /** Full new snapshots for every proposition this turn created or changed. */
  candidates: WorldChangeCandidate[];
  groups: CandidateGroup[];
  tombstones: CandidateTombstone[];
  /**
   * Bible edits this turn described, still unapplied (master §4.5).
   *
   * Validation stops at the shape. Whether a heading resolves is a fact about the file, and this
   * module deliberately touches no world state — the runner applies them, and a failure there
   * rejects the turn exactly as a failure here would.
   */
  bibleEdits: readonly BibleEdit[];
  /** Editor requests this turn described, still unstaged (SPEC-039 R-27); the runner validates them against the base. */
  editorRequests: readonly ModelEditorRequest[];
  /** Scene edits this turn described, still unapplied (SPEC-036 R-38); the runner lands them against the version it showed. */
  sceneEdits: readonly ModelSceneEdit[];
}

export type ValidationOutcome =
  | { ok: true; turn: AcceptedTurn }
  | { ok: false; problems: TurnProblem[] };

function problem(code: string, safeMessage: string): TurnProblem {
  return { code, safeMessage };
}

const NO_EVIDENCE: readonly CandidateEvidence[] = [];

/**
 * What a corrective turn may cost (§8.4).
 *
 * The turn budget is the reason for each of these. A correction is meant to be smaller than the
 * thing it corrects; one that grows with the size of a malformed answer would let a bad result
 * spend the retry's context on its own faults, which is the failure the bounds exist to prevent.
 */
const MAX_KEYS_NAMED = 8;
const MAX_PROBLEMS = 8;
const MAX_PROBLEM_CHARS = 300;
const MAX_CORRECTIVE_CHARS = 4_000;

/** Whether these reasons include the one that cannot be substituted (§8.4, and wrap-up's gate). */
function hasIntentEvidence(evidence: readonly CandidateEvidence[]): boolean {
  return evidence.some((e) => e.kind === "message" && e.purpose === "intent");
}

/** The verified intent a revision inherits from the proposition it revises. */
function intentEvidenceOf(existing: WorldChangeCandidate | undefined): readonly CandidateEvidence[] {
  if (!existing) return NO_EVIDENCE;
  return existing.evidence.filter((e) => e.kind === "message" && e.purpose === "intent");
}

/**
 * One schema issue as a line the model can act on.
 *
 * The rule this follows: expected values are the schema's own and safe to state; received values
 * are the model's and are not, because what it sent may carry world content. So a wrong field is
 * named by its path and what belongs there — never by echoing what arrived. The exceptions are
 * type names ("string", "undefined"), which describe shape rather than content, and messages
 * zod carries for `invalid_string` and `custom` issues, which are authored in the schema itself.
 *
 * This replaced a bare list of failing paths, which was watched failing live: told to "check
 * candidateOperations.0.candidate.draft.type", the model guessed a value, and the guess was
 * wrong too. A path without what belongs at it spends the one corrective turn on a coin toss.
 */
function schemaIssueLine(issue: z.ZodIssue): string {
  const path = issue.path.join(".") || "(root)";
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      // For an enum field zod's `expected` is the joined options, so a missing `type` reads
      // "required: expected 'rule' | 'lore' | …" — the answer travels with the complaint.
      return issue.received === "undefined"
        ? `${path} is required: expected ${issue.expected}`
        : `${path} must be ${issue.expected}, not ${issue.received}`;
    case z.ZodIssueCode.invalid_literal:
      return `${path} must be exactly ${JSON.stringify(issue.expected)}`;
    case z.ZodIssueCode.unrecognized_keys: {
      // Zod puts every unknown key in one issue, so an object with a thousand of them would
      // otherwise become a corrective prompt the size of the answer it is rejecting — spending
      // the one retry's context on a list nobody needs to read past the first few of.
      const shown = issue.keys.slice(0, MAX_KEYS_NAMED).map((k) => k.slice(0, 60));
      const rest = issue.keys.length - shown.length;
      return `${path} has unknown field${issue.keys.length === 1 ? "" : "s"}: ${shown.join(", ")}${
        rest > 0 ? `, and ${rest} more` : ""
      }`;
    }
    case z.ZodIssueCode.invalid_union_discriminator:
    case z.ZodIssueCode.invalid_enum_value:
      return `${path} must be one of ${issue.options.map((o) => JSON.stringify(o)).join(" | ")}`;
    case z.ZodIssueCode.invalid_union:
      return `${path} matches none of the allowed shapes for that field`;
    case z.ZodIssueCode.too_small: {
      const unit = issue.type === "string" ? " characters" : issue.type === "array" ? " items" : "";
      if (unit && (issue.minimum === 1 || issue.minimum === 1n)) return `${path} must not be empty`;
      return `${path} needs at least ${issue.minimum}${unit}`;
    }
    case z.ZodIssueCode.too_big: {
      const unit = issue.type === "string" ? " characters" : issue.type === "array" ? " items" : "";
      return `${path} allows at most ${issue.maximum}${unit}`;
    }
    case z.ZodIssueCode.invalid_string:
    case z.ZodIssueCode.custom:
      return `${path}: ${issue.message}`;
    default:
      return `${path} does not match the required shape`;
  }
}

/**
 * Parse the model's message as the strict turn-result schema.
 *
 * Separate from the rest so a malformed message fails before anything else is attempted — there
 * is nothing useful to say about the evidence in a result that is not a result.
 */
export function parseTurnResult(raw: string): { ok: true; value: WorldChatTurnResult } | { ok: false; problems: TurnProblem[] } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      problems: [
        problem(
          "not-json",
          "The reply was not valid JSON. Return the complete result again as one JSON object — no prose around it, no markdown fences.",
        ),
      ],
    };
  }
  const parsed = WorldChatTurnResultSchema.safeParse(json);
  if (!parsed.success) {
    /**
     * Bounded where the issues are collected, not where they are printed.
     *
     * Zod reports every element of an invalid array separately, so a long one produces a problem
     * per entry. Only the first few are ever shown, but the whole list used to be built, mapped
     * and joined on the way to a 500-character run detail — work proportional to how wrong the
     * answer was, at the moment there is least time to spare.
     */
    const lines = new Set<string>();
    for (const issue of parsed.error.issues) {
      lines.add(truncate(schemaIssueLine(issue), MAX_PROBLEM_CHARS));
      if (lines.size >= MAX_PROBLEMS) break;
    }
    return { ok: false, problems: [...lines].map((line) => problem("schema", line)) };
  }
  return { ok: true, value: parsed.data };
}

/**
 * The full §8.4 validation order, then the snapshots it produces.
 *
 * Problems accumulate rather than short-circuiting, because the model gets exactly one corrective
 * turn — naming one fault at a time would spend it on the first of several.
 */
export function validateTurnResult(input: ValidateInput): ValidationOutcome {
  const parsed = parseTurnResult(input.raw);
  if (!parsed.ok) return parsed;
  const result = parsed.value;

  const problems: TurnProblem[] = [];
  const byId = new Map(input.existing.map((c) => [c.id, c]));
  const receiptIds = new Set(input.receiptsThisRun.map((r) => r.id));
  const at = input.now();

  // Step 3 and 4: identity, revisions and payloads.
  const temporaryIds = new Set<string>();
  for (const op of result.candidateOperations) {
    if (op.op === "create") {
      if (temporaryIds.has(op.temporaryId)) {
        problems.push(problem("duplicate-temporary-id", "Two operations used the same temporary id."));
      }
      temporaryIds.add(op.temporaryId);
      continue;
    }
    const existing = byId.get(op.candidateId);
    if (!existing) {
      problems.push(problem("unknown-candidate", "An operation referred to a proposition that does not exist."));
      continue;
    }
    if (existing.revision !== op.expectedRevision) {
      problems.push(
        problem("stale-revision", "An operation was based on an out-of-date version of a proposition."),
      );
    }
    if (existing.status === "accepted" || existing.status === "proposed") {
      // Accepted propositions are immutable history; a later change is a new proposition
      // against accepted world state (§6.3).
      problems.push(
        problem("immutable-candidate", "A proposition that has already been carried into a proposal cannot be changed."),
      );
    }
  }

  for (const { draft } of draftsWithOperations(result)) {
    for (const ref of temporaryLinkRefs(draft)) {
      if (!temporaryIds.has(ref.temporaryId)) {
        problems.push(problem("unknown-temporary-reference", "A proposition referred to a same-turn entity that does not exist."));
      }
    }
  }

  /**
   * Step 5: evidence, and step 6: receipts.
   *
   * A draft that revises an existing proposition carries that proposition's verified intent with
   * it. Without this, correcting something said more than eight turns ago is impossible to
   * express: the original message has left the context window, the registry shows only titles and
   * ids, and the words in front of the model are a `correction` rather than the original ask — so
   * a required intent citation could not be written, and both the turn and its one retry would
   * fail on a proposition the user was actively trying to fix.
   */
  const drafts = result.candidateOperations.flatMap((op) => {
    if (op.op === "create") return [{ draft: op.candidate, inherited: NO_EVIDENCE }];
    if (op.op === "update") return [{ draft: op.candidate, inherited: intentEvidenceOf(byId.get(op.candidateId)) }];
    if (op.op === "split") {
      const inherited = intentEvidenceOf(byId.get(op.candidateId));
      return op.replacements.map((draft) => ({ draft, inherited }));
    }
    return [];
  });
  for (const { draft, inherited } of drafts) {
    for (const evidenceProblem of verifyAllEvidence(draft.evidence, input.evidenceSources)) {
      problems.push(problem(evidenceProblem.kind, safeEvidenceMessage(evidenceProblem)));
    }
    if (draft.evidence.length === 0) {
      problems.push(problem("no-evidence", "Every proposition needs evidence of what it is based on."));
    } else if (!hasIntentEvidence(draft.evidence) && inherited.length === 0) {
      /**
       * Intent is the one piece that cannot be substituted, and it is checked here rather than
       * only at wrap-up (`hasIntentEvidence` in readiness.ts).
       *
       * Without this a candidate evidenced only by a document or by world state validates,
       * appears in the panel as understood, and is then silently dropped as "invalid" when the
       * user presses the button — the exact failure this feature's all-or-nothing rule exists to
       * prevent, only deferred to the worst moment. Refusing it now spends the corrective turn
       * on something the model can actually fix: quote the sentence they asked in.
       */
      problems.push(
        problem(
          "no-intent-evidence",
          'Every proposition needs a message quotation with "purpose": "intent" — the user\'s own words asking for it. Supporting evidence from the world or an attachment does not replace it.',
        ),
      );
    }
    for (const id of draft.checkReceiptIds) {
      if (!receiptIds.has(id)) {
        problems.push(problem("foreign-receipt", "A cited check was not produced by this turn."));
      }
    }
  }

  // Step 9: group membership and atomicity.
  for (const op of result.groupOperations) {
    const members = op.op === "withdraw" ? [] : op.members;
    for (const member of members) {
      if (!resolvableMember(member, temporaryIds, byId)) {
        problems.push(problem("unknown-group-member", "A group referred to a proposition that does not exist."));
      }
    }
    if (op.op !== "withdraw" && op.op !== "create") {
      const group = input.groups.find((g) => g.id === op.groupId);
      if (!group) {
        problems.push(problem("unknown-group", "An operation referred to a group that does not exist."));
      } else if (group.revision !== op.expectedRevision) {
        problems.push(problem("stale-group-revision", "A group operation was based on an out-of-date version."));
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems: dedupeProblems(problems) };

  // Everything validated. Now build the snapshots.
  const candidates: WorldChangeCandidate[] = [];
  const tombstones: CandidateTombstone[] = [];
  const idByTemporary = new Map<string, CandidateId>();
  const revisionByTemporary = new Map<string, number>();

  // Plan every create before building any snapshot. A proposition may cite a later create in the
  // same result, so resolving while walking operations would make meaning depend on array order.
  for (const op of result.candidateOperations) {
    if (op.op !== "create") continue;
    const duplicate = findByStructure(op.candidate, input.existing);
    idByTemporary.set(op.temporaryId, duplicate?.id ?? (newId("cand") as CandidateId));
    revisionByTemporary.set(op.temporaryId, duplicate ? duplicate.revision + 1 : 1);
  }

  for (const op of result.candidateOperations) {
    switch (op.op) {
      case "create": {
        // Step 7: a retracted idea does not come back simply because it is still in context,
        // and a proposition the model has already made is an update rather than a second card.
        if (suppressedByTombstone(op.candidate, input.tombstones)) continue;
        const duplicate = findByStructure(op.candidate, input.existing);
        const draft = resolveTemporaryReferences(op.candidate, idByTemporary, revisionByTemporary);
        if (duplicate) {
          candidates.push(snapshot(duplicate, draft, input, at, duplicate.revision + 1));
          continue;
        }
        candidates.push(fresh(idByTemporary.get(op.temporaryId)!, draft, input, at));
        break;
      }
      case "update": {
        const existing = byId.get(op.candidateId)!;
        candidates.push(snapshot(existing, resolveTemporaryReferences(op.candidate, idByTemporary, revisionByTemporary), input, at, existing.revision + 1));
        break;
      }
      case "withdraw": {
        const existing = byId.get(op.candidateId)!;
        const retractedBy = lastUserMessageId(input.messages);
        candidates.push({ ...existing, status: "withdrawn", revision: existing.revision + 1, updatedAt: at });
        if (retractedBy) {
          tombstones.push({
            candidateId: existing.id,
            revision: existing.revision,
            structuralKey: structuralKey(existing),
            payloadDigest: payloadDigest(existing),
            retractedByMessageId: retractedBy,
            at,
          });
        }
        break;
      }
      case "split": {
        const existing = byId.get(op.candidateId)!;
        candidates.push({ ...existing, status: "superseded", revision: existing.revision + 1, updatedAt: at });
        const inherited = intentEvidenceOf(existing);
        for (const replacement of op.replacements) {
          const id = newId("cand") as CandidateId;
          candidates.push({
            ...fresh(id, resolveTemporaryReferences(replacement, idByTemporary, revisionByTemporary), input, at, inherited),
            splitFrom: existing.id,
          });
        }
        break;
      }
    }
  }

  const groups = buildGroups(result, input, idByTemporary, candidates);
  bindGroupMembers(result, input, candidates, groups);
  const candidatesById = new Map(input.existing.map((candidate) => [candidate.id, candidate]));
  for (const candidate of candidates) candidatesById.set(candidate.id, candidate);
  for (const candidate of candidates) {
    for (const ref of storedLinkRefs(candidate.draft)) {
      const target = candidatesById.get(ref.candidateId);
      if (
        !candidate.groupId ||
        !target?.groupId ||
        candidate.groupId !== target.groupId ||
        target.revision !== ref.revision
      ) {
        problems.push(problem(
          "unbound-pending-reference",
          "A same-turn entity reference must remain pinned inside one atomic group.",
        ));
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems: dedupeProblems(problems) };
  // Carried through untouched: the schema has already bounded them, and whether they *apply* is
  // a question about the file on disk, which only the caller holding the store can answer.
  return {
    ok: true,
    turn: {
      reply: result.reply,
      candidates,
      groups,
      tombstones,
      bibleEdits: result.bibleEdits,
      editorRequests: result.editorRequests,
      sceneEdits: result.sceneEdits,
    },
  };
}

function draftsWithOperations(result: WorldChatTurnResult): Array<{ draft: ModelCandidateDraft }> {
  return result.candidateOperations.flatMap((op) =>
    op.op === "create" || op.op === "update"
      ? [{ draft: op.candidate }]
      : op.op === "split"
        ? op.replacements.map((draft) => ({ draft }))
        : [],
  );
}

function temporaryLinkRefs(draft: ModelCandidateDraft): Array<{ temporaryId: string }> {
  const found: Array<{ temporaryId: string }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record["kind"] === "pending-entity") {
      const ref = record["ref"] as Record<string, unknown> | undefined;
      if (typeof ref?.["temporaryId"] === "string") found.push({ temporaryId: ref["temporaryId"] });
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(draft);
  return found;
}

function storedLinkRefs(draft: WorldChangeCandidate["draft"]): Array<{ candidateId: string; revision: number }> {
  const found: Array<{ candidateId: string; revision: number }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record["kind"] === "pending-entity") {
      const ref = record["ref"] as { candidateId?: string; revision?: number } | undefined;
      if (typeof ref?.candidateId === "string" && typeof ref.revision === "number") {
        found.push({ candidateId: ref.candidateId, revision: ref.revision });
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(draft);
  return found;
}

/** Replace model-only temporary references before the candidate crosses the durable schema. */
function resolveTemporaryReferences(
  draft: ModelCandidateDraft,
  ids: ReadonlyMap<string, CandidateId>,
  revisions: ReadonlyMap<string, number>,
): ModelCandidateDraft {
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (record["kind"] === "pending-entity") {
      const ref = record["ref"] as { temporaryId?: string } | undefined;
      if (typeof ref?.temporaryId === "string") {
        return {
          kind: "pending-entity",
          ref: { candidateId: ids.get(ref.temporaryId)!, revision: revisions.get(ref.temporaryId)! },
        };
      }
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, replace(child)]));
  };
  return replace(draft) as ModelCandidateDraft;
}

/** Candidate snapshots carry group membership because save/materialise operate from the candidate. */
function bindGroupMembers(
  result: WorldChatTurnResult,
  input: ValidateInput,
  candidates: WorldChangeCandidate[],
  groups: readonly CandidateGroup[],
): void {
  const touched = new Set(
    result.groupOperations.flatMap((op) => op.op === "create" ? [] : [op.groupId]),
  );
  const membership = new Map<string, CandidateGroupId>();
  for (const group of groups) {
    if (group.status !== "live") continue;
    for (const member of group.members) membership.set(member.candidateId, group.id);
  }
  const affected = new Set<string>(membership.keys());
  for (const candidate of input.existing) {
    if (candidate.groupId && touched.has(candidate.groupId)) affected.add(candidate.id);
  }
  for (const candidateId of affected) {
    const index = candidates.findLastIndex((candidate) => candidate.id === candidateId);
    const current = index >= 0 ? candidates[index]! : input.existing.find((candidate) => candidate.id === candidateId);
    if (!current) continue;
    const groupId = membership.get(candidateId);
    const next = { ...current };
    if (index < 0) next.revision = current.revision + 1;
    if (groupId) next.groupId = groupId;
    else delete next.groupId;
    if (groupId) {
      const group = groups.find((candidate) => candidate.id === groupId);
      if (group) {
        group.members = group.members.map((member) =>
          member.candidateId === candidateId ? { ...member, revision: next.revision } : member);
      }
    }
    if (index >= 0) candidates[index] = next;
    else candidates.push(next);
  }
}

function resolvableMember(
  member: ModelCandidateRef,
  temporaryIds: ReadonlySet<string>,
  byId: ReadonlyMap<string, WorldChangeCandidate>,
): boolean {
  return "temporaryId" in member ? temporaryIds.has(member.temporaryId) : byId.has(member.candidateId);
}

function lastUserMessageId(
  messages: readonly import("@arke-studio/contracts").WorldChatMessage[],
): MessageId | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.id;
  }
  return null;
}

/**
 * The subject a proposition displays under (§5.5).
 *
 * Coordinator-computed, because grouping the panel by subject is what makes it readable, and a
 * model choosing its own headings would produce a different set every turn.
 */
/**
 * What a proposition is about, for grouping in the panel: its own target where it has one.
 *
 * The casts here are what let a target the subject union does not admit reach the store and fail
 * there instead of in the compiler (2026-08-21: every `development.*` proposition, for as long as
 * they have existed). They cannot be removed outright — the payloads are a discriminated union
 * and `target` has a different shape in each arm — so the value is parsed instead. A target that
 * is not a valid subject now falls back to a label rather than writing a candidate nothing can
 * read, and the parse is the check the cast was pretending to be.
 */
function subjectOf(draft: ModelCandidateDraft): WorldChangeCandidate["subject"] {
  const record = draft as unknown as Record<string, unknown>;
  const payload = (record["draft"] ?? {}) as Record<string, unknown>;
  const target =
    draft.classification === "media.image-opportunity" ? payload["target"] : record["target"];
  if (target !== undefined) {
    const ref = WorldChatEntityRefSchema.safeParse(target);
    if (ref.success) return ref.data;
  }
  const label = payload["name"] ?? payload["title"] ?? draft.title;
  return { kind: "new", label: String(label).slice(0, 120) };
}

function fresh(
  id: CandidateId,
  draft: ModelCandidateDraft,
  input: ValidateInput,
  at: string,
  inheritedIntent: readonly CandidateEvidence[] = NO_EVIDENCE,
): WorldChangeCandidate {
  // `checkReceiptIds` is model-facing only. It is what the model says it read, and it is dropped
  // here because the stored candidate carries `checks` instead — the coordinator's own findings.
  // Keeping both would put the model's account of its searching next to the real one, where the
  // difference between them is exactly what must not be blurred (§8.3.1).
  const { title, rationale, settledness, evidence, checkReceiptIds, ...payload } = draft;
  // Intent travels with the proposition, not with the turn that last touched it: the original ask
  // is still why this exists, and wrap-up refuses anything that cannot show one. A revision that
  // states its own intent keeps it; only a revision that does not inherits.
  const cited = hasIntentEvidence(evidence) ? [...evidence] : [...inheritedIntent, ...evidence];
  // Stored with the offsets pointing where the words actually are, not where they were said to be.
  const reasons = normaliseEvidence(cited, input.messages);
  return {
    ...(payload as object),
    id,
    conversationId: input.conversationId,
    revision: 1,
    status: "live",
    settledness,
    subject: subjectOf(draft),
    title,
    rationale,
    sourceMessageIds: [...new Set(reasons.filter((e) => e.kind === "message").map((e) => e.messageId))],
    evidence: reasons,
    checks: {
      ...input.checksFor(draft),
      targetReads: checkReceiptIds.flatMap((id) => {
        const receipt = input.receiptsThisRun.find((entry) => entry.id === id);
        return receipt?.tool === "target-read" &&
          (receipt.status === "complete" || receipt.status === "empty") &&
          receipt.complete === true &&
          receipt.nextCursor === null &&
          receipt.target !== undefined &&
          receipt.observedRevisionOrDigest !== undefined
          ? [{ checkId: receipt.id, target: receipt.target, observedRevisionOrDigest: receipt.observedRevisionOrDigest }]
          : [];
      }),
    },
    createdAt: at,
    updatedAt: at,
  } as WorldChangeCandidate;
}

/**
 * A correction is a full new snapshot under the same id (§6.3).
 *
 * Not a patch: the whole proposition is replaced, so there is no way for a half-applied change to
 * leave a proposition describing partly one thing and partly another.
 */
function snapshot(
  existing: WorldChangeCandidate,
  draft: ModelCandidateDraft,
  input: ValidateInput,
  at: string,
  revision: number,
): WorldChangeCandidate {
  return {
    ...fresh(existing.id, draft, input, at, intentEvidenceOf(existing)),
    revision,
    createdAt: existing.createdAt,
    ...(existing.groupId !== undefined ? { groupId: existing.groupId } : {}),
    ...(existing.splitFrom !== undefined ? { splitFrom: existing.splitFrom } : {}),
  };
}

function buildGroups(
  result: WorldChatTurnResult,
  input: ValidateInput,
  idByTemporary: ReadonlyMap<string, CandidateId>,
  candidates: readonly WorldChangeCandidate[],
): CandidateGroup[] {
  const revisionOf = (id: CandidateId): number =>
    candidates.find((c) => c.id === id)?.revision ?? input.existing.find((c) => c.id === id)?.revision ?? 1;

  const groups: CandidateGroup[] = [];
  for (const op of result.groupOperations) {
    if (op.op === "withdraw") {
      const existing = input.groups.find((g) => g.id === op.groupId);
      if (existing) groups.push({ ...existing, status: "withdrawn", revision: existing.revision + 1 });
      continue;
    }
    const members = op.members
      .map((m) => ("temporaryId" in m ? idByTemporary.get(m.temporaryId) : m.candidateId))
      .filter((id): id is CandidateId => id !== undefined)
      .map((id) => ({ candidateId: id, revision: revisionOf(id) }));

    // A media opportunity never lands atomically with authored change (§5.9): it is an idea, not
    // a file, so binding it to a group would make the group's promise untrue.
    const withoutMedia = members.filter((m) => {
      const candidate = candidates.find((c) => c.id === m.candidateId) ?? input.existing.find((c) => c.id === m.candidateId);
      return candidate?.classification !== "media.image-opportunity";
    });
    if (withoutMedia.length < 2) continue;

    const existing = op.op === "update" ? input.groups.find((g) => g.id === op.groupId) : undefined;
    groups.push({
      id: existing?.id ?? (newId("grp") as CandidateGroupId),
      conversationId: input.conversationId,
      revision: existing ? existing.revision + 1 : 1,
      title: op.title,
      rationale: op.rationale,
      members: withoutMedia,
      atomic: true,
      status: "live",
    });
  }
  return groups;
}

function dedupeProblems(problems: readonly TurnProblem[]): TurnProblem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.code}|${p.safeMessage}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The one corrective turn (§8.4).
 *
 * Names only the structural faults and asks for the complete result again. It never carries world
 * content, and it never asks for a partial fix — a model given "just fix the third one" would
 * return the third one.
 */
export function correctiveMessage(problems: readonly TurnProblem[]): string {
  const lines = problems.slice(0, MAX_PROBLEMS).map((p) => `- ${truncate(p.safeMessage, MAX_PROBLEM_CHARS)}`);
  const message = [
    "The previous result was not accepted:",
    ...lines,
    "",
    "Return the complete result again, as a single JSON object matching the required shape.",
    'The exact shape, with examples, is under "The result shape, exactly" in your instructions.',
  ].join("\n");
  return truncate(message, MAX_CORRECTIVE_CHARS);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

import { z } from "zod";
import {
  newId,
  WorldChatTurnResultSchema,
  type CandidateChecks,
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
import { verifyAllEvidence, safeEvidenceMessage, type EvidenceSources } from "./evidence.js";
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
}

export type ValidationOutcome =
  | { ok: true; turn: AcceptedTurn }
  | { ok: false; problems: TurnProblem[] };

function problem(code: string, safeMessage: string): TurnProblem {
  return { code, safeMessage };
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
    case z.ZodIssueCode.unrecognized_keys:
      return `${path} has unknown field${issue.keys.length === 1 ? "" : "s"}: ${issue.keys
        .map((k) => k.slice(0, 60))
        .join(", ")}`;
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
    const lines = [...new Set(parsed.error.issues.map(schemaIssueLine))];
    return { ok: false, problems: lines.map((line) => problem("schema", line)) };
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

  // Step 5: evidence, and step 6: receipts.
  const drafts = result.candidateOperations.flatMap((op) =>
    op.op === "create" || op.op === "update" ? [op.candidate] : op.op === "split" ? op.replacements : [],
  );
  for (const draft of drafts) {
    for (const evidenceProblem of verifyAllEvidence(draft.evidence, input.evidenceSources)) {
      problems.push(problem(evidenceProblem.kind, safeEvidenceMessage(evidenceProblem)));
    }
    if (draft.evidence.length === 0) {
      problems.push(problem("no-evidence", "Every proposition needs evidence of what it is based on."));
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

  for (const op of result.candidateOperations) {
    switch (op.op) {
      case "create": {
        // Step 7: a retracted idea does not come back simply because it is still in context,
        // and a proposition the model has already made is an update rather than a second card.
        if (suppressedByTombstone(op.candidate, input.tombstones)) continue;
        const duplicate = findByStructure(op.candidate, input.existing);
        if (duplicate) {
          candidates.push(snapshot(duplicate, op.candidate, input, at, duplicate.revision + 1));
          idByTemporary.set(op.temporaryId, duplicate.id);
          continue;
        }
        const id = newId("cand") as CandidateId;
        idByTemporary.set(op.temporaryId, id);
        candidates.push(fresh(id, op.candidate, input, at));
        break;
      }
      case "update": {
        const existing = byId.get(op.candidateId)!;
        candidates.push(snapshot(existing, op.candidate, input, at, existing.revision + 1));
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
        for (const replacement of op.replacements) {
          const id = newId("cand") as CandidateId;
          candidates.push({ ...fresh(id, replacement, input, at), splitFrom: existing.id });
        }
        break;
      }
    }
  }

  const groups = buildGroups(result, input, idByTemporary, candidates);
  return { ok: true, turn: { reply: result.reply, candidates, groups, tombstones } };
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
function subjectOf(draft: ModelCandidateDraft): WorldChangeCandidate["subject"] {
  const record = draft as unknown as Record<string, unknown>;
  const target = record["target"] as WorldChangeCandidate["subject"] | undefined;
  if (target) return target;
  const payload = (record["draft"] ?? {}) as Record<string, unknown>;
  if (draft.classification === "media.image-opportunity") {
    return payload["target"] as WorldChangeCandidate["subject"];
  }
  const label = payload["name"] ?? payload["title"] ?? draft.title;
  return { kind: "new", label: String(label).slice(0, 120) };
}

function fresh(
  id: CandidateId,
  draft: ModelCandidateDraft,
  input: ValidateInput,
  at: string,
): WorldChangeCandidate {
  // `checkReceiptIds` is model-facing only. It is what the model says it read, and it is dropped
  // here because the stored candidate carries `checks` instead — the coordinator's own findings.
  // Keeping both would put the model's account of its searching next to the real one, where the
  // difference between them is exactly what must not be blurred (§8.3.1).
  const { title, rationale, settledness, evidence, checkReceiptIds, ...payload } = draft;
  void checkReceiptIds;
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
    sourceMessageIds: [...new Set(evidence.filter((e) => e.kind === "message").map((e) => e.messageId))],
    evidence: [...evidence],
    checks: input.checksFor(draft),
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
    ...fresh(existing.id, draft, input, at),
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
      const candidate = candidates.find((c) => c.id === m.candidateId);
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
  const lines = problems.slice(0, 8).map((p) => `- ${p.safeMessage}`);
  return [
    "The previous result was not accepted:",
    ...lines,
    "",
    "Return the complete result again, as a single JSON object matching the required shape.",
    'The exact shape, with examples, is under "The result shape, exactly" in your instructions.',
  ].join("\n");
}

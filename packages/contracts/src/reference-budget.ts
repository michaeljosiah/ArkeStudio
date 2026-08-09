import type { ManifestModel } from "./manifest.js";
import type { SheetKind } from "./world.js";

/**
 * The reference budget (SPEC-010 §2.9, R-15, D9): a shot citing more sheets than the model
 * accepts. Selection is deterministic and the drop is always named before commit — a silent
 * cap reads as full coverage, and the user blames the model for drift caused by a policy they
 * never saw.
 */

/** What a carried asset is (SPEC-019 R-41). Each kind is budgeted against its own limits. */
export type ReferenceKind = "image" | "video" | "audio";

export interface BudgetCandidate {
  /** Defaults to "image": every existing candidate is one, and every caller wrote it that way. */
  kind_?: ReferenceKind;
  sheetId: string;
  kind: SheetKind;
  /** Characters: "lead" | "support" | … Anything unstated sorts after "lead". */
  billing?: string;
  /** Order of first appearance in the shot description; lower first. */
  appearanceOrder: number;
  /** Whether a reference image actually exists to carry (a designated compilation). */
  hasReference: boolean;
  /** A character with both sheet and main photo may spend a spare slot on identity depth. */
  hasSecondaryReference?: boolean;
  referenceRole?: "primary" | "secondary";
}

export interface BudgetResult {
  /** Carried, in rank order. */
  carried: BudgetCandidate[];
  /** Dropped, in rank order — named before the user commits, never silent (R-15). */
  dropped: BudgetCandidate[];
  /** Human notice; empty when everything fits. */
  notice: string | null;
  /**
   * Which of the four dimensions actually bound this request (SPEC-019 R-40).
   *
   * Named because they behave differently and the user needs to know which one to act on:
   * assets truncate, subjects only warn, duration truncates, and bytes block. A notice that says
   * "something was dropped" without saying what ran out is not actionable.
   */
  boundBy: "assets" | "subjects" | "duration" | "bytes" | null;
  /**
   * Distinct subjects carried. Not the same number as assets — a character with a model sheet
   * and a main photo spends two assets and is one subject (R-42).
   */
  subjects: number;
  /** Subject count past the model's stated reliable range: a warning, never a truncation. */
  subjectsOverRange: { carried: number; reliableTo: number } | null;
}

const KIND_RANK: Record<SheetKind, number> = { character: 0, location: 1, faction: 2 };

function rank(a: BudgetCandidate, b: BudgetCandidate): number {
  // 1 — characters before locations and factions: a face drifting is noticed most (§2.9).
  const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (kind !== 0) return kind;
  // 2 — billing: leads before supporting.
  const aLead = a.billing === "lead" ? 0 : 1;
  const bLead = b.billing === "lead" ? 0 : 1;
  if (aLead !== bLead) return aLead - bLead;
  // 3 — order of first appearance.
  return a.appearanceOrder - b.appearanceOrder;
}

function referenceLabel(candidate: BudgetCandidate): string {
  return candidate.referenceRole === "secondary"
    ? `${candidate.sheetId} (second reference)`
    : candidate.sheetId;
}

/**
 * Deterministic selection under the model's accepted count (R-15). Candidates without a
 * reference to carry never consume budget; existing sheet prose still remains in the prompt.
 */
export function referenceBudget(candidates: BudgetCandidate[], model: ManifestModel): BudgetResult {
  const accepted = model.accepts.referenceImages;
  const primaries = candidates
    .filter((c) => c.hasReference)
    .map((candidate) => ({ ...candidate, referenceRole: "primary" as const }))
    .sort(rank);
  const secondaries = primaries
    .filter((candidate) => candidate.hasSecondaryReference === true)
    .map((candidate) => ({ ...candidate, referenceRole: "secondary" as const }));
  const carriable = [...primaries, ...secondaries];
  if (accepted === 0) {
    return {
      carried: [],
      dropped: carriable,
      boundBy: carriable.length > 0 ? "assets" : null,
      subjects: 0,
      subjectsOverRange: null,
      notice:
        carriable.length > 0
          ? `${model.displayName} accepts no reference images — those images are omitted; only existing sheet descriptions remain for ${carriable
              .map(referenceLabel)
              .join(", ")}`
          : null,
    };
  }
  // Breadth before depth: every cited sheet gets its primary before any character gets a second.
  const carriedPrimaries = primaries.slice(0, accepted);
  const remaining = Math.max(0, accepted - carriedPrimaries.length);
  const eligibleSecondaries = secondaries.filter((secondary) =>
    carriedPrimaries.some((primary) => primary.sheetId === secondary.sheetId),
  );
  const carried = [...carriedPrimaries, ...eligibleSecondaries.slice(0, remaining)];
  const carriedKeys = new Set(carried.map((candidate) => `${candidate.sheetId}:${candidate.referenceRole}`));
  const dropped = carriable.filter(
    (candidate) => !carriedKeys.has(`${candidate.sheetId}:${candidate.referenceRole}`),
  );
  const subjects = new Set(carried.map((candidate) => candidate.sheetId)).size;
  // Subjects warn; they never truncate (R-42, D35). The range describes degradation, not a
  // limit, and dropping a character the user wrote into the shot produces a stable take of the
  // wrong scene — with the warning that would have explained it replaced by the action.
  const reliableTo = model.limits.reliableSubjects;
  const subjectsOverRange =
    reliableTo !== undefined && subjects > reliableTo ? { carried: subjects, reliableTo } : null;
  const truncationNotice =
    dropped.length > 0
      ? `${model.displayName} accepts ${accepted} reference${accepted === 1 ? "" : "s"}: carrying ${carried
          .map(referenceLabel)
          .join(", ")} — dropping ${dropped.map(referenceLabel).join(", ")}`
      : null;
  const rangeNotice = subjectsOverRange
    ? `${subjects} subjects is past the ${reliableTo} ${model.displayName} holds apart reliably — all ${subjects} are carried and the take may be less stable`
    : null;
  return {
    carried,
    dropped,
    subjects,
    subjectsOverRange,
    boundBy: dropped.length > 0 ? "assets" : subjectsOverRange ? "subjects" : null,
    notice: [truncationNotice, rangeNotice].filter((n): n is string => n !== null).join(" · ") || null,
  };
}

// ---------------------------------------------------------------------------
// Payload bytes (SPEC-019 R-43, D37) — a hard limit, not a degradation range
// ---------------------------------------------------------------------------

/**
 * base64 costs about a third again on top of the file, and the transport inlines references that
 * way against a fixed ceiling. Four small images could not plausibly breach it; thirty large ones
 * routinely will.
 */
export function encodedBytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export interface PayloadVerdict {
  encodedBytes: number;
  ceilingBytes: number;
  /** True when the request is over the ceiling — which the client already refuses. */
  over: boolean;
  notice: string | null;
}

/**
 * Whether this payload can be sent at all (R-43).
 *
 * Unlike every other dimension here, this one does not degrade: a request over the ceiling is one
 * the transport is already known to reject. Naming a certain failure and then letting the user
 * commit is the enforce/warn distinction applied backwards, so planning either reduces by rank or
 * blocks — and this function is what tells it which case it is in.
 */
export function payloadVerdict(rawBytes: number, ceilingBytes: number): PayloadVerdict {
  const encoded = encodedBytes(rawBytes);
  const over = encoded > ceilingBytes;
  return {
    encodedBytes: encoded,
    ceilingBytes,
    over,
    notice: over
      ? `references total ${Math.round(encoded / 1024 / 1024)}MB encoded, over the ${Math.round(
          ceilingBytes / 1024 / 1024,
        )}MB the provider accepts — drop some, or use smaller reference images`
      : null,
  };
}

import type { ManifestModel } from "./manifest.js";
import type { SheetKind } from "./world.js";

/**
 * The reference budget (SPEC-010 §2.9, R-15, D9): a shot citing more sheets than the model
 * accepts. Selection is deterministic and the drop is always named before commit — a silent
 * cap reads as full coverage, and the user blames the model for drift caused by a policy they
 * never saw.
 */

export interface BudgetCandidate {
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
  return {
    carried,
    dropped,
    notice:
      dropped.length > 0
        ? `${model.displayName} accepts ${accepted} reference${accepted === 1 ? "" : "s"}: carrying ${carried
            .map(referenceLabel)
            .join(", ")} — dropping ${dropped.map(referenceLabel).join(", ")}`
        : null,
  };
}

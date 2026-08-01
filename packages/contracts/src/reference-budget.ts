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

/**
 * Deterministic selection under the model's accepted count (R-15). Candidates without a
 * reference to carry never consume budget — they ride in the prompt regardless.
 */
export function referenceBudget(candidates: BudgetCandidate[], model: ManifestModel): BudgetResult {
  const accepted = model.accepts.referenceImages;
  const carriable = candidates.filter((c) => c.hasReference).sort(rank);
  if (accepted === 0) {
    return {
      carried: [],
      dropped: carriable,
      notice:
        carriable.length > 0
          ? `${model.displayName} accepts no reference images — identity rides in the prompt for ${carriable
              .map((c) => c.sheetId)
              .join(", ")}`
          : null,
    };
  }
  const carried = carriable.slice(0, accepted);
  const dropped = carriable.slice(accepted);
  return {
    carried,
    dropped,
    notice:
      dropped.length > 0
        ? `${model.displayName} accepts ${accepted} reference${accepted === 1 ? "" : "s"}: carrying ${carried
            .map((c) => c.sheetId)
            .join(", ")} — dropping ${dropped.map((c) => c.sheetId).join(", ")}`
        : null,
  };
}

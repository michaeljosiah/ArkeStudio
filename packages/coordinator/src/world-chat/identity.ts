import type {
  CandidateTombstone,
  ModelCandidateDraft,
  WorldChangeCandidate,
  WorldChangeClassification,
} from "@arke-studio/contracts";
import { contentHash } from "./observations.js";

/**
 * What makes two propositions the same proposition (#70 §6.3, §6.4).
 *
 * The coordinator owns candidate identity; the model proposes operations against it. That split
 * is what makes correction work by talking. "Not her mother, her aunt" has to land on the
 * proposition that already exists rather than appending a second, contradictory card beside it,
 * and it has to do so without the user pressing anything.
 *
 * Two keys do the work, and they answer different questions:
 *
 * - The **structural key** asks "is this about the same thing?" — same classification, same
 *   target, same owned fields. It survives a change of value, which is exactly what a correction
 *   is. It is what lets an update find its candidate.
 * - The **payload digest** asks "is this the same claim?" — the normalised values as well. It
 *   changes when a correction changes anything, which is what stops a retracted idea from
 *   coming back unchanged next turn simply because it is still sitting in the context window.
 */

/**
 * Normalise a value for comparison.
 *
 * Whitespace and case are presentation, not content: a model that re-emits the same proposition
 * with different capitalisation has not changed its mind, and treating that as a new claim would
 * resurrect retracted ideas on nothing more than a re-render.
 */
function normalise(value: unknown): unknown {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalise(v)]),
    );
  }
  return value;
}

/** The target a proposition acts on, as a comparable string. */
export function targetKey(draft: Pick<ModelCandidateDraft, "classification"> & Record<string, unknown>): string {
  const target = draft["target"] as { entryId?: string; sheetId?: string } | undefined;
  if (target?.entryId) return `canon:${target.entryId}`;
  if (target?.sheetId) return `sheet:${target.sheetId}`;

  // A create has no existing target, so its identity comes from what it would create. Without
  // this, two different new characters proposed in one turn would collide on one key.
  const payload = draft["draft"] as Record<string, unknown> | undefined;
  const name = payload?.["name"] ?? payload?.["title"] ?? payload?.["question"];
  if (typeof name === "string") return `new:${normalise(name) as string}`;

  const mediaTarget = payload?.["target"] as { entryId?: string; sheetId?: string } | undefined;
  if (mediaTarget?.entryId) return `canon:${mediaTarget.entryId}`;
  if (mediaTarget?.sheetId) return `sheet:${mediaTarget.sheetId}`;
  return "unbound";
}

/**
 * "Is this about the same thing?"
 *
 * Classification and target only. Owned field names are included for the edit classifications so
 * that changing a character's role and changing their region are not treated as one proposition
 * that keeps overwriting itself.
 */
export function structuralKey(draft: ModelCandidateDraft | WorldChangeCandidate): string {
  const record = draft as unknown as Record<string, unknown>;
  const payload = (record["draft"] ?? {}) as Record<string, unknown>;
  const parts = [draft.classification, targetKey(record as never)];

  if (draft.classification === "sheet.edit" || draft.classification === "canon.amend") {
    parts.push(Object.keys(payload).sort().join(","));
  }
  if (draft.classification === "relationship.change") {
    const from = payload["from"] as Record<string, unknown> | undefined;
    const to = payload["to"] as Record<string, unknown> | undefined;
    parts.push(JSON.stringify([normalise(from), normalise(to)]));
  }
  if (draft.classification === "media.image-opportunity") {
    parts.push(String(payload["purpose"] ?? ""));
  }
  return parts.join("|");
}

/** "Is this the same claim?" — the structure plus the normalised values. */
export function payloadDigest(draft: ModelCandidateDraft | WorldChangeCandidate): string {
  const record = draft as unknown as Record<string, unknown>;
  return contentHash({
    key: structuralKey(draft),
    draft: normalise(record["draft"]),
    settledness: record["settledness"],
  });
}

/**
 * Whether a retracted proposition may come back (§6.4).
 *
 * A tombstone suppresses re-detection of the same claim. It is lifted only by a material change:
 * a different target, a different value, a different settledness or a different classification.
 * That the model has proposed it again is not a material change — the idea is still in the
 * context window, so re-proposing it is the default behaviour rather than a new judgement, and
 * treating it as one would make "forget that" mean "forget that until the next message".
 */
export function suppressedByTombstone(
  draft: ModelCandidateDraft,
  tombstones: readonly CandidateTombstone[],
): CandidateTombstone | null {
  const digest = payloadDigest(draft);
  return tombstones.find((t) => t.payloadDigest === digest) ?? null;
}

/**
 * The live proposition an operation is about, found structurally.
 *
 * Used to notice that a model has proposed something it already proposed — a duplicate rather
 * than a correction — so the turn updates the existing proposition instead of listing the same
 * change twice in the panel.
 */
export function findByStructure(
  draft: ModelCandidateDraft,
  candidates: readonly WorldChangeCandidate[],
): WorldChangeCandidate | null {
  const key = structuralKey(draft);
  return (
    candidates.find((candidate) => candidate.status === "live" && structuralKey(candidate) === key) ?? null
  );
}

/** Classifications that describe an authored change to the world, as opposed to a question. */
const AUTHORED: readonly WorldChangeClassification[] = [
  "canon.create",
  "canon.amend",
  "sheet.create",
  "sheet.edit",
  "relationship.change",
  "art-direction.change",
];

export function isAuthoredChange(classification: WorldChangeClassification): boolean {
  return AUTHORED.includes(classification);
}

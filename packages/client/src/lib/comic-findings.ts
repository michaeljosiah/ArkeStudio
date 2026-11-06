import type { PageReviewFinding } from "@arke-studio/contracts";

/** A review's findings as the author reads them, in Pages and on Arke's Make card. */
export const REVIEW_FINDING: Record<PageReviewFinding["kind"], string> = { content: "Scene", cast: "People", caption: "Caption", defect: "Defect", speaker: "Speaker", likeness: "Likeness", continuity: "Continuity", layout: "Layout" };

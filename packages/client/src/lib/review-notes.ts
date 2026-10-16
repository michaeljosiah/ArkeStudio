import { paragraphSpans, type ChapterReview } from "@arke-studio/contracts";

/*
 * A finished review's open notes, placed in the chapter as it stands (SPEC-056 R-29): by the
 * stored offset when the quote is still there, else by the exact quote's first appearance, else not
 * at all — a quote gone from the chapter is said to be gone and never anchored to other words.
 */

export type ReviewFinding = ChapterReview["findings"][number];

export interface PlacedNote {
  finding: ReviewFinding;
  /** Its number in the margin, counted from one in reading order. */
  n: number;
  /** Where the quote starts in the body. */
  at: number;
  /** Which appearance of the quote it is, counted from zero, so the editor marks that one. */
  nth: number;
  /** The paragraph it is in, counted from one, as a passage ask names it. */
  paragraph: number | null;
}

export function placeReviewNotes(body: string, findings: readonly ReviewFinding[]): { placed: PlacedNote[]; lost: ReviewFinding[] } {
  const located: { finding: ReviewFinding; at: number }[] = [];
  const lost: ReviewFinding[] = [];
  for (const finding of findings) {
    if (finding.decision !== "open") continue;
    const at = body.slice(finding.offset, finding.offset + finding.quote.length) === finding.quote ? finding.offset : body.indexOf(finding.quote);
    if (at < 0) lost.push(finding);
    else located.push({ finding, at });
  }
  located.sort((a, b) => a.at - b.at);
  const spans = paragraphSpans(body);
  const placed = located.map(({ finding, at }, i) => {
    let nth = 0;
    for (let seen = body.indexOf(finding.quote); seen !== -1 && seen < at; seen = body.indexOf(finding.quote, seen + 1)) nth += 1;
    const index = spans.findIndex((span) => at >= span.start && at <= span.end);
    return { finding, n: i + 1, at, nth, paragraph: index < 0 ? null : index + 1 };
  });
  return { placed, lost };
}

/** A quote as the editor shows its words: the Markdown's marks dropped, runs of space as one. */
export function quoteText(quote: string): string {
  return quote.replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
}

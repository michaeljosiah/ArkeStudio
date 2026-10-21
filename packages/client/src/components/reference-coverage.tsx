import { useEffect, useState } from "react";
import { referenceCoverageCounts, type ChapterReferenceCoverage } from "@arke-studio/contracts";
import { readAudiobookLooks, useStore } from "../lib/store.js";
import { Button } from "./ui.js";

const preparation = { current: "Prepared", missing: "Not prepared", stale: "Chapter changed", unreadable: "Record unreadable", unavailable: "Chapter unavailable" } as const;
const state = { ready: "Reference saved", "missing-reference": "No reference", unlinked: "Identity not linked", ambiguous: "Ambiguous identity", "needs-review": "Review place description", "not-depicted": "Never depicted" } as const;
export function coverageSummary(chapter: ChapterReferenceCoverage): string {
  const count = referenceCoverageCounts(chapter);
  return [preparation[chapter.preparation], `${count.unresolved} unresolved`, `${count.missing} missing reference${count.missing === 1 ? "" : "s"}`, ...(count.review ? [`${count.review} to review`] : []), ...(count.bounded ? ["Limited preparation"] : [])].join(" · ");
}

/** Uses the same folded, compact evidence presentation as Chapter details; no completeness badge. */
export function ReferenceCoverage({ chapter }: { chapter: ChapterReferenceCoverage }) {
  return <details className="fy-look__chapterdetails" data-testid="reference-coverage">
    <summary>Reference check · {coverageSummary(chapter)}</summary>
    <div className="fy-look__chapterfields">
      <p className="fy-look__hint">Saved chapter details, exact known names and prepared picture subjects. This does not discover every person or place.</p>
      {chapter.preparation !== "current" && <p className="fy-ch__who-where--warn">{preparation[chapter.preparation]} · review this chapter’s Looks.</p>}
      {Object.entries(chapter.bounds).filter(([, bound]) => bound.omitted > 0).map(([key, bound]) => <p key={key} className="fy-ch__who-where--warn" data-testid="reference-bound">{key === "people" ? `${bound.omitted} character candidates outside the ${bound.limit}-person preparation` : key === "places" ? `${bound.omitted} known places outside the ${bound.limit}-place preparation` : `${bound.omitted} characters of prose omitted from preparation`}</p>)}
      {chapter.rows.map(row => <div key={`${row.kind}:${row.key}`} className="fy-look__detailchar" data-testid="reference-coverage-row">
        <b>{row.name}</b><p className="fy-look__facts">{row.kind === "place" ? "Location" : row.billing === "lead" ? "Principal character" : row.billing === "supporting" ? "Supporting character" : "Character"} · {state[row.state]}</p>
        {(row.aliases?.length ?? 0) > 0 && <p className="fy-look__savehint">Other names: {row.aliases!.join(", ")}</p>}
        {row.blocks.length > 0 && <p className="fy-look__savehint">{row.blocks.length} passage{row.blocks.length === 1 ? "" : "s"} cited</p>}
      </div>)}
      {chapter.rows.length === 0 && <p className="fy-look__savehint">No named evidence saved.</p>}
      <p className="fy-look__savehint">Anonymous people and object or detail compositions remain decisions in each picture brief. Without and Skip do not resolve world references.</p>
    </div>
  </details>;
}

export function BookReferenceCoverage({ worldId, productionId, disabled }: { worldId: string; productionId: string; disabled: boolean }) {
  const store = useStore();
  const [request, setRequest] = useState<string | null>(null);
  useEffect(() => setRequest(null), [worldId, productionId]);
  const answer = request === null ? undefined : store.audiobookAsks[request];
  const chapters = answer?.state === "looks" ? answer.coverage : undefined;
  const working = answer?.state === "working";
  const unresolved = chapters?.reduce((sum, chapter) => sum + referenceCoverageCounts(chapter).unresolved, 0) ?? 0;
  const missing = chapters?.reduce((sum, chapter) => sum + referenceCoverageCounts(chapter).missing, 0) ?? 0;
  const incomplete = chapters?.filter(chapter => chapter.preparation !== "current" || referenceCoverageCounts(chapter).bounded).length ?? 0;
  return <details className="fy-look__chapterdetails" data-testid="book-reference-coverage">
    <summary>Book references{chapters === undefined ? "" : ` · ${unresolved} unresolved · ${missing} missing reference${missing === 1 ? "" : "s"} · ${incomplete} chapter${incomplete === 1 ? "" : "s"} to prepare`}</summary>
    <div className="fy-look__chapterfields">
      <Button variant="secondary" disabled={disabled || working} onClick={() => setRequest(readAudiobookLooks(worldId, productionId, true))}>{working ? "Checking…" : chapters === undefined ? "Check book references" : "Check again"}</Button>
      {chapters !== undefined && <p className="fy-look__savehint">Saved evidence at the last check. Check again after resolving identities or references.</p>}
      {answer?.state === "refused" && <p className="fy-ch__who-where--warn">{answer.refused}</p>}
      {chapters?.map(chapter => <section key={chapter.chapterId}><h4>Chapter {chapter.order} · {chapter.title}</h4><ReferenceCoverage chapter={chapter} /></section>)}
    </div>
  </details>;
}

import { useEffect, useState } from "react";
import type { ChapterReview } from "@arke-studio/contracts";
import { EditorDialog } from "./editor-dialog.js";
import { Button } from "./ui.js";
import { mediaUrl } from "../lib/media.js";
import { decideChapterReview, requestChapterReview, subscribeChapterReview, useStore } from "../lib/store.js";

export function ChapterReviewReport({ review, slug, disabled, onDecision }: {
  review: ChapterReview; slug: string; disabled?: boolean;
  onDecision: (id: string, decision: "open" | "intentional" | "dismissed", note?: string) => void;
}) {
  const [index, setIndex] = useState(0), [note, setNote] = useState("");
  const finding = review.findings[Math.min(index, Math.max(0, review.findings.length - 1))];
  const completed = review.tasks.filter(t => t.state === "complete").length;
  const supplied = new Set(review.tasks.filter(t => t.specialist === "visual" && t.state === "complete").flatMap(t => t.images));
  return <div className="fy-chreview">
    <p role="status"><strong>{review.status}</strong> · {completed}/{review.tasks.length} tasks complete · {supplied.size}/{review.images.length} pictures supplied to completed reviews</p>
    <p>Audio delivery not listened to. Narration coverage is a saved-record audit, not an exact provider-request review.</p>
    {review.stale && <div role="alert" className="fy-chreview__notice"><strong>Source check needed — refresh or review again.</strong><ul>{review.staleReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
    <details><summary>Coverage, models and task results</summary>
      <ul>{review.checks.map((check, i) => <li key={i}>{check}</li>)}</ul>
      {review.tasks.map(task => <p key={task.id}><strong>{task.id}: {task.state}</strong> · {task.skill}{task.model ? ` · ${task.model}` : ""}<br />{task.disclosure}<br />{task.detail}</p>)}
      <p>{review.rejectedFindings} unsupported findings or facts rejected.</p>
    </details>
    {finding ? <>
      <div className="fy-chreview__controls"><Button disabled={index <= 0} onClick={() => { setIndex(index - 1); setNote(""); }}>Previous</Button>
        <span>Finding {Math.min(index + 1, review.findings.length)} of {review.findings.length}</span>
        <Button disabled={index >= review.findings.length - 1} onClick={() => { setIndex(index + 1); setNote(""); }}>Next</Button></div>
      <p><strong>{finding.category}</strong> · {finding.certainty.replaceAll("-", " ")} · {finding.decision}</p>
      <div className="fy-chreview__evidence"><div><blockquote>{finding.quote}</blockquote><p>{finding.observation}</p><p><strong>Audience effect:</strong> {finding.impact}</p><p><strong>Suggested correction:</strong> {finding.correction}</p></div>
        <div>{finding.imageBlocks.map(block => { const image = review.images.find(i => i.block === block); return image ? <figure key={block}>
          {review.stale ? <p>Image hidden because the source may have changed. The original evidence hash is retained.</p> : <img src={mediaUrl(slug, image.file)} alt={`Review evidence for ${block}`} />}
          <figcaption>{block}</figcaption></figure> : null; })}</div></div>
      {finding.decisionNote && <p><strong>Your note:</strong> {finding.decisionNote}</p>}
      <label>Decision note<textarea value={note} maxLength={1000} onChange={e => setNote(e.target.value)} /></label>
      <div className="fy-chreview__controls">
        <Button disabled={disabled || review.stale} onClick={() => onDecision(finding.id, "intentional", note || undefined)}>Keep intentionally</Button>
        <Button disabled={disabled || review.stale} onClick={() => onDecision(finding.id, "dismissed", note || undefined)}>Dismiss finding</Button>
        {finding.decision !== "open" && <Button disabled={disabled || review.stale} onClick={() => onDecision(finding.id, "open")}>Reopen</Button>}
      </div>
      <p>Decisions record your assessment. They do not change the manuscript, images or audio.</p>
    </> : <p>{review.status === "running" ? "Reviewing the chapter…" : "No supported findings returned. This is not a guarantee that the chapter has no issues."}</p>}
  </div>;
}

export function ChapterReviewControl({ worldId, productionId, chapterId, slug, held }: {
  worldId: string; productionId: string; chapterId: string; slug: string; held: boolean;
}) {
  const { connection } = useStore();
  const [open, setOpen] = useState(false), [review, setReview] = useState<ChapterReview | null>(null);
  const [error, setError] = useState<string | null>(null), [starting, setStarting] = useState(false);
  useEffect(() => {
    setReview(null); setError(null); setStarting(false);
    return subscribeChapterReview(event => {
      if (event.worldId !== worldId || event.productionId !== productionId || event.chapterId !== chapterId) return;
      setStarting(false);
      if (event.error) setError(event.error);
      else { setError(null); setReview(previous => {
        const next = event.review;
        if (!next) return previous;
        if (previous && (next.createdAt < previous.createdAt || (next.id === previous.id && next.updatedAt < previous.updatedAt))) return previous;
        return next;
      }); }
    });
  }, [worldId, productionId, chapterId]);
  useEffect(() => { if (open && connection === "open") requestChapterReview("chapter-review-read", worldId, productionId, chapterId); }, [open, connection, worldId, productionId, chapterId]);
  const busy = starting || review?.status === "running";
  return <>
    <Button onClick={() => setOpen(true)}>Review chapter{busy ? " · running" : ""}</Button>
    <EditorDialog open={open} onClose={() => setOpen(false)} title="Chapter review" width={1050}>
      <div className="fy-chreview">
        <p>Review saved prose and selected pictures using Arke’s script and visual specialists. Findings are advisory. This uses your configured writing models; cloud image settings apply.</p>
        <p>Up to 60,000 characters and 60 pictures. One script task, then visual tasks with up to five neighboring pictures each. You can leave this chapter while review continues.</p>
        <div className="fy-chreview__controls"><Button disabled={held || busy || connection !== "open"} onClick={() => {
          setError(null); setStarting(true);
          if (!requestChapterReview("chapter-review-start", worldId, productionId, chapterId)) { setStarting(false); setError("Not connected."); }
        }}>{review ? "Review again" : "Start review"}</Button>
        {busy && <Button onClick={() => requestChapterReview("chapter-review-cancel", worldId, productionId, chapterId)}>Stop review</Button>}
        <Button disabled={connection !== "open"} onClick={() => requestChapterReview("chapter-review-read", worldId, productionId, chapterId)}>Refresh</Button></div>
        {held && <p>Save the chapter before starting a review.</p>}
        {error && <p role="alert">{error}</p>}
      </div>
      {review && <ChapterReviewReport key={review.id} review={review} slug={slug} disabled={held || busy || connection !== "open"}
        onDecision={(id, decision, note) => decideChapterReview(worldId, productionId, chapterId, review.id, id, decision, note)} />}
    </EditorDialog>
  </>;
}

import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { manuscriptReviewCoverage, ManuscriptFindingSchema, ulid, type ManuscriptReview, type ManuscriptReviewHistory, type ClientMessage } from "@arke-studio/contracts";
import { EditorDialog } from "./editor-dialog.js";
import { Button } from "./ui.js";
import { useGlobalChat } from "./global-chat-context.js";
import { chatKey, conversationProps } from "../lib/global-chat.js";
import { requestManuscriptReview, subscribeManuscriptReview, useStore } from "../lib/store.js";

type Citation = ManuscriptReview["findings"][number]["citations"][number];
const sections = ["At a glance", "Full synopsis", "Candid editorial review", "Continuity and unresolved intent", "Prioritised revision plan", "Method and limitations"];
const Text = ({ children }: { children: string | undefined }) => <p className="fy-manuscript-review__text">{children || "Not available in this report."}</p>;
export function ManuscriptReviewReport({ review, disabled = false, onDecision, onEvidence, onDiscuss }: {
  review: ManuscriptReview; disabled?: boolean;
  onDecision(id: string, decision: ManuscriptReview["findings"][number]["decision"]): void;
  onEvidence(citation: Citation): void; onDiscuss?(finding: ManuscriptReview["findings"][number]): void;
}) {
  const coverage = manuscriptReviewCoverage(review);
  const section = (index: number) => `manuscript-${review.id}-${index}`;
  return <article className="fy-manuscript-review">
    <nav aria-label="Report sections">{sections.map((name, i) => <Button key={name} onClick={() => document.getElementById(section(i))?.scrollIntoView({ block: "start" })}>{name}</Button>)}</nav>
    <section id={section(0)}><h2>At a glance</h2><h3>{review.title}</h3>
      <p role="status"><strong>{review.status}</strong> · {coverage.chapters}/{coverage.totalChapters} chapters fully supplied · {coverage.stages}/{coverage.totalStages} reading stages complete · {coverage.words.toLocaleString()} words</p>
      {review.status !== "complete" && <p>No complete manuscript review is claimed. Completed readings remain available below.</p>}
      {review.stale && <div role="alert"><strong>Sources changed since review.</strong><Text>{review.staleReasons.join("\n")}</Text></div>}
      <h3>Author brief</h3><Text>{review.brief || "No author brief supplied."}</Text><Text>{review.synthesis?.verdict}</Text>
    </section>
    <section id={section(1)}><h2>Full synopsis</h2><Text>{review.synthesis?.synopsis}</Text>
      {review.sources.map(source => <details key={source.id}><summary>{source.title}</summary>
        {review.tasks.filter(task => task.kind === "reading" && task.chapterId === source.id).map(task => <div key={task.id}>
          <p>{task.id} · {task.state}</p><Text>{task.reading?.synopsis ?? task.error ?? "This source segment has not been read."}</Text>
          {task.reading && <details><summary>Retained editorial reading</summary><Text>{task.reading.strengths}</Text><Text>{task.reading.editorial}</Text><Text>{task.reading.continuity}</Text></details>}
        </div>)}
      </details>)}
    </section>
    <section id={section(2)}><h2>Candid editorial review</h2><h3>Strengths worth preserving</h3><Text>{review.synthesis?.strengths}</Text><Text>{review.synthesis?.editorial}</Text></section>
    <section id={section(3)}><h2>Continuity and unresolved intent</h2><Text>{review.synthesis?.continuity}</Text></section>
    <section id={section(4)}><h2>Prioritised revision plan</h2>
      {review.previousId && <p>{review.findings.filter(f => !f.carried).length} new findings · {review.findings.filter(f => f.carried).length} carried · {review.notRaisedAgain} not raised again. Absence from this report does not establish resolution.</p>}
      {!review.findings.length && <p>No source-linked revision findings are available. This does not establish that the manuscript has no issues.</p>}
      {[...review.findings].sort((a,b) => a.priority - b.priority).map(finding => <section key={finding.id} className="fy-manuscript-review__finding">
        <h3>Priority {finding.priority}: {finding.title}</h3><p>{finding.kind} · {finding.decision}{finding.stale ? " · source changed" : ""}</p>
        <Text>{finding.observation}</Text><p><strong>Revision:</strong> {finding.recommendation}</p><p><strong>Preserve:</strong> {finding.preserve}</p><p><strong>Dependencies:</strong> {finding.dependencies || "None identified."}</p>
        {finding.citations.map((cite,i) => <div key={i}><blockquote>{cite.quote}</blockquote><Button onClick={() => onEvidence(cite)}>Open supporting passage · {review.sources.find(s => s.id === cite.chapterId)?.title ?? cite.chapterId}</Button></div>)}
        <div className="fy-manuscript-review__actions">
          {onDiscuss && <Button disabled={finding.stale} onClick={() => onDiscuss(finding)}>Discuss with Arke</Button>}
          {([ ["intentional", "Keep intentionally"], ["dismissed", "Dismiss"], ["resolved", "Mark resolved"], ["open", "Reopen"] ] as const).filter(([decision]) => decision !== finding.decision).map(([decision,label]) => <Button key={decision} disabled={disabled || finding.stale} onClick={() => onDecision(finding.id, decision)}>{label}</Button>)}
        </div>
      </section>)}
      <p>Decisions record your assessment. Changes to prose use the existing chapter conversation and proposal review.</p>
    </section>
    <section id={section(5)}><h2>Method and limitations</h2>
      <p>Each completed reading stage received its entire pinned source segment. Cross-chapter synthesis uses retained readings, with bounded intermediate synthesis for long books. Exact citations prove linkage, not correctness. Models may omit or misinterpret details.</p>
      <p>Context includes saved production/chapter planning and settled canon explicitly referenced by chapters. Other world canon, character sheets, pictures and narration were not inspected. Editorial judgment is not an age classification. Review and export do not edit the manuscript or media.</p>
      <Text>{review.synthesis?.limitations}</Text><p>{review.rejectedCitations} findings omitted for invalid or ambiguous citations.</p>
      <p>Saved {review.createdAt} · Report {review.id} · Source snapshot {review.snapshotHash}</p>
      <details><summary>Exact sources and approved context</summary><ul>{review.sources.map(source => <li key={source.id}>{source.title} · {source.file} · {source.hash}</li>)}</ul><Text>{review.context}</Text></details>
      <details><summary>Stages, models and failures</summary>{review.tasks.map(task => <p key={task.id}><strong>{task.id} · {task.state}</strong><br />{task.model ?? "Model not recorded"} · {task.provider ?? "Provider not separately reported by harness"}<br />{task.sessionId}<br />{task.disclosure ?? "Configured writing harness; manuscript text may be sent to its provider."}<br />{task.error}</p>)}</details>
    </section>
  </article>;
}

export function ManuscriptReviewControl({ worldId, productionId, chapters, words }: { worldId: string; productionId: string; chapters: number; words: number }) {
  const { connection, state } = useStore(), navigate = useNavigate(), globalChat = useGlobalChat();
  const [open, setOpen] = useState(false), [review, setReview] = useState<ManuscriptReview | null>(null), [history, setHistory] = useState<ManuscriptReviewHistory>([]);
  const [brief, setBrief] = useState(""), [error, setError] = useState(""), [starting, setStarting] = useState(false), [exporting, setExporting] = useState(false);
  const selected = useRef<string | null>(null), latestRequest = useRef<string | null>(null), exportRequest = useRef<string | null>(null), briefEdited = useRef(false);
  const send = (message: Extract<ClientMessage, { kind: `manuscript-review-${string}` }>) => {
    latestRequest.current = message.requestId; setError("");
    if (!requestManuscriptReview(message)) { setError("Not connected."); setStarting(false); setExporting(false); }
  };
  useEffect(() => {
    selected.current = null; briefEdited.current = false; setReview(null); setHistory([]); setBrief(""); setError(""); setStarting(false);
    return subscribeManuscriptReview(event => {
      if (event.worldId !== worldId || event.productionId !== productionId) return;
      if (event.error) { if (event.requestId === latestRequest.current || event.requestId === exportRequest.current) { setError(event.error); setStarting(false); setExporting(false); } return; }
      setHistory(event.history);
      if (event.pdf && event.requestId === exportRequest.current) {
        exportRequest.current = null; setExporting(false);
        const bytes = Uint8Array.from(atob(event.pdf), c => c.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        const link = document.createElement("a"); link.href = url; link.download = `${productionId}-review-${event.review?.id ?? "report"}.pdf`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      if (selected.current && event.review?.id !== selected.current) return;
      if (!selected.current && event.review) selected.current = event.review.id;
      setStarting(false); setReview(previous => previous && event.review?.id === previous.id && event.review.updatedAt < previous.updatedAt ? previous : event.review);
      if (!briefEdited.current && event.review) setBrief(event.review.brief);
    });
  }, [worldId, productionId]);
  useEffect(() => {
    if (open && connection === "open") send({ kind: "manuscript-review-read", worldId, productionId, requestId: ulid(), ...(selected.current ? { reviewId: selected.current } : {}) });
    if (connection !== "open") { setStarting(false); setExporting(false); exportRequest.current = null; }
  }, [open, connection, worldId, productionId]);
  const busy = starting || review?.status === "running", offline = connection !== "open";
  const canContinue = review && review.status !== "complete" && !busy && (review.tasks.some(t => t.state === "pending") || (review.tasks.every(t => t.state === "complete") && !review.synthesis));
  const evidence = (cite: Citation) => { setOpen(false); navigate(`/w/${worldId}/p/${productionId}/story/chapters/${encodeURIComponent(cite.chapterId)}`, { state: { manuscriptReviewPassage: cite } }); };
  const discuss = globalChat ? (finding: ManuscriptReview["findings"][number]) => {
    const cite = finding.citations[0]!, entry = { kind: "production" as const, productionId }, props = conversationProps(worldId, entry);
    props.subject = { kind: "passage", chapterId: cite.chapterId, text: cite.quote };
    props.dock = { title: "Arke", subject: finding.title, conversationFirst: true, subjectLine: "Manuscript review · supporting passage", subjectPrefix: `Discuss this editorial finding against the current saved chapter. ${finding.observation}\nSuggested revision: ${finding.recommendation}\nPreserve: ${finding.preserve}\nQuoted passage: ${cite.quote}`.slice(0,5000) };
    evidence(cite); globalChat.open({ key: chatKey(worldId, entry), worldId, worldName: state?.world?.meta.name ?? "World", kind: "production", title: "Builder Chat", label: finding.title, entry, path: `/w/${worldId}/p/${productionId}/story/chapters/${cite.chapterId}`, props });
  } : undefined;
  return <>
    <Button onClick={() => setOpen(true)}>Review manuscript{busy ? " · running" : ""}</Button>
    <EditorDialog open={open} title="Manuscript review" onClose={() => setOpen(false)} width={1050}>
      <div className="fy-manuscript-review">
        <p>{chapters} saved chapters · {words.toLocaleString()} words. Reviews the complete saved manuscript, including the ending.</p>
        <label>Author brief <span>(optional)</span><textarea rows={4} maxLength={6000} value={brief} disabled={busy} onChange={e => { briefEdited.current = true; setBrief(e.target.value); }} placeholder="Genre, audience/intensity, editorial concerns, protected passages and deliberate ambiguity" /></label>
        <p>Uses your configured writing model. Cloud models receive manuscript text and approved context; usage may incur charges. No manuscript, canon or media edits are made.</p>
        <p>Up to 24,000 characters per reading stage, 1,000 stages and 64,000 characters of approved context. Model limits or failed stages are reported. You can leave while work continues.</p>
        <div className="fy-manuscript-review__actions"><Button disabled={busy || offline || !chapters} onClick={() => { const id = ulid(); selected.current = id; setStarting(true); send({ kind: "manuscript-review-start", worldId, productionId, requestId: id, brief }); }}>{review ? "Start a new review" : "Start review"}</Button>
          {busy && <Button disabled={offline} onClick={() => send({ kind: "manuscript-review-cancel", worldId, productionId, requestId: ulid() })}>Stop review</Button>}
          {canContinue && <Button disabled={offline} onClick={() => { selected.current = review.id; setStarting(true); send({ kind: "manuscript-review-resume", worldId, productionId, requestId: ulid(), reviewId: review.id }); }}>Continue unstarted stages</Button>}
          <Button disabled={offline} onClick={() => send({ kind: "manuscript-review-read", worldId, productionId, requestId: ulid(), ...(selected.current ? { reviewId: selected.current } : {}) })}>Refresh</Button>
          {review && <Button disabled={busy || offline || exporting} onClick={() => { const id = ulid(); exportRequest.current = id; setExporting(true); send({ kind: "manuscript-review-export", worldId, productionId, requestId: id, reviewId: review.id }); }}>{exporting ? "Preparing PDF…" : "Export PDF"}</Button>}
        </div>
        {canContinue && <p>Continues the original pinned sources. Failed or uncertain model calls are not retried. A new review is a separate request and may incur new charges.</p>}
        {error && <p role="alert">{error}</p>}
        {!!history.length && <label>Past reports<select value={review?.id ?? ""} disabled={starting} onChange={e => { selected.current = e.target.value; send({ kind: "manuscript-review-read", worldId, productionId, requestId: ulid(), reviewId: e.target.value }); }}><option value="" disabled>Choose a report</option>{history.map(item => <option key={item.id} value={item.id}>{item.createdAt} · {item.status}</option>)}</select></label>}
      </div>
      {review && <ManuscriptReviewReport review={review} disabled={busy || offline} onEvidence={evidence} onDiscuss={discuss} onDecision={(findingId, decision) => send({ kind: "manuscript-review-decide", worldId, productionId, requestId: ulid(), reviewId: review.id, findingId, decision })} />}
    </EditorDialog>
  </>;
}

/** Historical quotations are readable at their chapter even after its live prose changes. */
export function ManuscriptReviewPassage({ chapterId, hash }: { chapterId: string; hash: string | undefined }) {
  const location = useLocation(), [dismissed, setDismissed] = useState<unknown>(null);
  const parsed = ManuscriptFindingSchema.shape.citations.element.safeParse(location.state?.manuscriptReviewPassage);
  if (!parsed.success || parsed.data.chapterId !== chapterId || dismissed === location.state) return null;
  return <aside className="fy-manuscript-review__passage"><strong>Manuscript review · pinned supporting passage</strong><blockquote>{parsed.data.quote}</blockquote>
    <p>{parsed.data.hash === hash ? "This passage belongs to the reviewed chapter version." : "The chapter has changed. This is the original evidence; review the current prose before revising."}</p>
    <Button onClick={() => setDismissed(location.state)}>Close evidence</Button></aside>;
}

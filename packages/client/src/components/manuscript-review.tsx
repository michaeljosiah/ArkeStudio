import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { harnessModelReference, manuscriptReviewCoverage, ManuscriptFindingSchema, ulid, type ManuscriptReview, type ManuscriptReviewHistory, type ClientMessage } from "@arke-studio/contracts";
import { EditorDialog } from "./editor-dialog.js";
import { BookOpen } from "./icons.js";
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
  const done = review.synthesis !== undefined, failed = review.tasks.filter(task => task.state === "failed");
  const stages = <details><summary>Stages, models and failures</summary>{review.tasks.map(task => <p key={task.id}><strong>{task.id} · {task.state}</strong><br />{task.model ?? "Model not recorded"} · {task.provider ?? "Provider not separately reported by harness"}<br />{task.sessionId}<br />{task.disclosure ?? "Configured writing harness; manuscript text may be sent to its provider."}<br />{task.error}</p>)}</details>;
  return <article className="fy-manuscript-review">
    {done && <nav aria-label="Report sections">{sections.map((name, i) => <Button key={name} variant="ghost" size="sm" onClick={() => document.getElementById(section(i))?.scrollIntoView({ block: "start" })}>{name}</Button>)}</nav>}
    <section id={section(0)}><h2>At a glance</h2><h3>{review.title}</h3>
      <p role="status">{review.status === "complete" ? "" : <><strong>{review.status}</strong> · </>}Read {coverage.chapters} of {coverage.totalChapters} chapters · {coverage.words.toLocaleString()} words</p>
      {failed.length > 0 && <p role="alert">{failed.length} of {review.tasks.length} stages failed. {failed[0]!.error}</p>}
      {review.status !== "complete" && failed.length === 0 && <p>No complete manuscript review is claimed. Completed readings remain available below.</p>}
      {review.stale && <div role="alert"><strong>Sources changed since review.</strong><Text>{review.staleReasons.join("\n")}</Text></div>}
      <h3>Author brief</h3><Text>{review.brief || "No author brief supplied."}</Text>{review.synthesis && <Text>{review.synthesis.verdict}</Text>}
      {!done && stages}
    </section>
    {(done || review.tasks.some(task => task.reading)) && <section id={section(1)}><h2>Full synopsis</h2>{review.synthesis && <Text>{review.synthesis.synopsis}</Text>}
      {review.sources.map(source => <details key={source.id}><summary>{source.title}</summary>
        {review.tasks.filter(task => task.kind === "reading" && task.chapterId === source.id).map(task => <div key={task.id}>
          <p>{task.id} · {task.state}</p><Text>{task.reading?.synopsis ?? task.error ?? "This source segment has not been read."}</Text>
          {task.reading && <details><summary>Retained editorial reading</summary><Text>{task.reading.strengths}</Text><Text>{task.reading.editorial}</Text><Text>{task.reading.continuity}</Text></details>}
        </div>)}
      </details>)}
    </section>}
    {done && <>
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
      <Text>{review.synthesis?.limitations}</Text>
      <p>Saved {new Date(review.createdAt).toLocaleString()}{review.rejectedCitations > 0 ? ` · ${review.rejectedCitations} findings left out: their quotes could not be found` : ""}</p>
      <details><summary>How this was read</summary>
        <p>Each completed reading stage received its entire pinned source segment. Cross-chapter synthesis uses retained readings, with bounded intermediate synthesis for long books. Exact citations prove linkage, not correctness. Models may omit or misinterpret details.</p>
        <p>Context includes saved production/chapter planning and settled canon explicitly referenced by chapters. Other world canon, character sheets, pictures and narration were not inspected. Editorial judgment is not an age classification. Review and export do not edit the manuscript or media.</p>
        <p>Report {review.id} · Source snapshot {review.snapshotHash}</p>
      </details>
      <details><summary>Exact sources and approved context</summary><ul>{review.sources.map(source => <li key={source.id}>{source.title} · {source.file} · {source.hash}</li>)}</ul><Text>{review.context}</Text></details>
      {stages}
    </section>
    </>}
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
  const agents = state?.app.agents ?? [], reviewerModel = agents.find(agent => agent.name === "manuscript-reviewer")?.model ?? agents.find(agent => agent.name === "story-writer")?.model;
  const reviewer = !reviewerModel ? "the harness's own model" : state?.app.harnessModels.find(model => harnessModelReference(model) === reviewerModel)?.displayName ?? reviewerModel;
  const canContinue = review && review.status !== "complete" && !busy && (review.tasks.some(t => t.state === "pending" || t.state === "failed") || (review.tasks.every(t => t.state === "complete") && !review.synthesis));
  const evidence = (cite: Citation) => { setOpen(false); navigate(`/w/${worldId}/p/${productionId}/story/chapters/${encodeURIComponent(cite.chapterId)}`, { state: { manuscriptReviewPassage: cite } }); };
  const discuss = globalChat ? (finding: ManuscriptReview["findings"][number]) => {
    const cite = finding.citations[0]!, entry = { kind: "production" as const, productionId }, props = conversationProps(worldId, entry);
    props.subject = { kind: "passage", chapterId: cite.chapterId, text: cite.quote };
    props.dock = { title: "Arke", subject: finding.title, conversationFirst: true, subjectLine: "Manuscript review · supporting passage", subjectPrefix: `Discuss this editorial finding against the current saved chapter. ${finding.observation}\nSuggested revision: ${finding.recommendation}\nPreserve: ${finding.preserve}\nQuoted passage: ${cite.quote}`.slice(0,5000) };
    evidence(cite); globalChat.open({ key: chatKey(worldId, entry), worldId, worldName: state?.world?.meta.name ?? "World", kind: "production", title: "Builder Chat", label: finding.title, entry, path: `/w/${worldId}/p/${productionId}/story/chapters/${cite.chapterId}`, props });
  } : undefined;
  return <>
    <Button onClick={() => setOpen(true)}><BookOpen size={13} />Review{busy ? " · running" : ""}</Button>
    <EditorDialog open={open} title="Manuscript review" onClose={() => setOpen(false)} width={1050}>
      <div className="fy-manuscript-review">
        <p>{chapters} {chapters === 1 ? "chapter" : "chapters"} · {words.toLocaleString()} words · read by {reviewer}. Your text goes to that model, and cloud models may charge.</p>
        {/* The report comes first once there is one: the form folds until it is wanted (issue 2463). */}
        <details open={!review}><summary>{review ? "New review" : "Your brief"}</summary>
        <label>Author brief <span>(optional)</span><textarea rows={4} maxLength={6000} value={brief} disabled={busy} onChange={e => { briefEdited.current = true; setBrief(e.target.value); }} placeholder="Genre, audience/intensity, editorial concerns, protected passages and deliberate ambiguity" /></label>
        <div className="fy-manuscript-review__actions"><Button disabled={busy || offline || !chapters} onClick={() => { const id = ulid(); selected.current = id; setStarting(true); send({ kind: "manuscript-review-start", worldId, productionId, requestId: id, brief }); }}>{review ? "Start a new review" : "Start review"}</Button></div>
        </details>
        <div className="fy-manuscript-review__actions">
          {review?.status === "running" && <Button disabled={offline} onClick={() => send({ kind: "manuscript-review-cancel", worldId, productionId, requestId: ulid() })}>Stop review</Button>}
          {canContinue && <Button disabled={offline} onClick={() => { selected.current = review.id; setStarting(true); send({ kind: "manuscript-review-resume", worldId, productionId, requestId: ulid(), reviewId: review.id }); }}>Try again</Button>}
          {review?.synthesis && <Button disabled={busy || offline || exporting} onClick={() => { const id = ulid(); exportRequest.current = id; setExporting(true); send({ kind: "manuscript-review-export", worldId, productionId, requestId: id, reviewId: review.id }); }}>{exporting ? "Preparing PDF…" : "Export PDF"}</Button>}
        </div>
        {error && <p role="alert">{error}</p>}
        {!!history.length && <label>Past reports<select value={review?.id ?? ""} disabled={starting} onChange={e => { selected.current = e.target.value; send({ kind: "manuscript-review-read", worldId, productionId, requestId: ulid(), reviewId: e.target.value }); }}><option value="" disabled>Choose a report</option>{history.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.status}</option>)}</select></label>}
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

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  audiobookActivityCost, audiobookActivityJobs, audiobookActivityLive, audiobookActivityPath, audiobookActivityStage,
  audiobookActivityTitle, audiobookRequestCost, formatMicroUsd, type AudiobookActivity, type ClientState,
} from "@arke-studio/contracts";
import { resolveHeldJob, stopAudiobook, subscribeAudiobookActivity, useStore } from "../lib/store.js";
import { closeActivityPanel, openActivityPanel, inspectProviderCalls } from "../lib/activity-panel.js";
import { Button, cx } from "./ui.js";

const tone = (run: AudiobookActivity) => run.phase === "ready" ? "ok" : run.phase === "finished" ? "warn" : run.phase === "interrupted" ? "fail" : audiobookActivityLive(run) ? "live" : "queued";

export function AudiobookActivityRow({ run, state }: { run: AudiobookActivity; state: ClientState }) {
  const navigate = useNavigate();
  const live = audiobookActivityLive(run);
  const jobs = audiobookActivityJobs(run, state.app.jobs);
  const unresolved = jobs.find(ref => state.app.jobs.find(job => job.id === ref.id)?.status === "needs-reconciliation");
  const [expanded, setExpanded] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  const order = run.chapterOrder ?? state.world?.productions.find(p => p.meta.id === run.productionId)?.chapters.find(c => c.id === run.chapterId)?.order;
  const saved = `${run.made} of ${run.toMake} blocks saved`;
  const blockReady = run.scope === "block" && run.phase === "ready";
  const unread = run.toMake - run.made - run.flagged;
  const remaining = unread > 0 ? ` · ${unread} left unread` : "";
  const cancelled = jobs.filter(ref => state.app.jobs.find(job => job.id === ref.id)?.status === "cancelled").length;
  const stage = unresolved ? `Request ${unresolved.index} needs a decision` : run.phase === "ready" ? saved : run.phase === "stopped" ? saved + remaining
    : run.phase === "interrupted" && run.interruptedDuring === "aligning" ? `Request ${run.request} · alignment failed` : audiobookActivityStage(run);
  const progress = run.phase === "queued" ? `${run.toMake} blocks · ${run.requests} requests`
    : run.phase === "ready" ? `${run.requests} requests finished`
    : run.phase === "stopped" ? `${Math.max(0, run.request - cancelled)} request${run.request - cancelled === 1 ? "" : "s"} finished${cancelled > 0 ? ` · ${cancelled} cancelled` : ""}`
    : saved + (run.phase === "finished" ? ` · ${run.requests} requests finished` : !live ? remaining : "");
  const showRequests = () => { setExpanded(true); requestAnimationFrame(() => details.current?.querySelector("summary")?.focus()); };
  const showDetails = expanded || (run.phase === "aligning" && !unresolved);
  const uncertain = Boolean(unresolved) || ["stopping", "stopped"].includes(run.phase);
  const readCost = audiobookActivityCost(run, state.app.jobs);
  const scopedCost = uncertain ? readCost.replace(/ for this read$/, "") : readCost;
  const cost = run.phase === "stopping" ? scopedCost.replace("1 request charge unknown", "current request charge unknown") : scopedCost;
  const submitted = jobs.map(ref => state.app.jobs.find(job => job.id === ref.id)).filter(job => job !== undefined);
  const submittedBlocks = submitted.flatMap(job => Array.isArray(job.params.blocks) ? job.params.blocks.filter((key): key is string => typeof key === "string") : typeof job.params.block === "string" ? [job.params.block] : []);
  const remainingBlocks = run.toMake - new Set(submittedBlocks).size;
  const remainingEstimate = Math.max(0, run.estimatedMicroUsd - submitted.reduce((sum, job) => sum + job.estimatedMicroUsd, 0));
  return <div className="fy-ap__row fy-ap__row--top fy-abactivity" data-testid="audiobook-activity-row" data-run={run.id} tabIndex={-1}>
    <span className={cx("fy-ap__dot", `fy-ap__dot--${unresolved ? "warn" : tone(run)}`)} aria-hidden />
    <div className="fy-ap__main">
      <div className="fy-ap__rowtitle">{audiobookActivityTitle(run)}</div>
      <div className="fy-ap__rowsub">{order !== undefined ? `Chapter ${order} · ` : ""}{run.productionTitle} · {run.worldName}</div>
      {!blockReady && <><div className="fy-abactivity__stage" role="status">{stage}</div>
        <div className="fy-ap__rowsub">{progress}</div></>}
      <div className="fy-ap__rowsub">{blockReady ? `${run.made} block${run.made === 1 ? "" : "s"} saved · ${cost.replace(" this re-read", " for this re-read")}` : [!uncertain && run.models.join(", "), cost].filter(Boolean).join(" · ")}</div>
      {run.reason && <div className="fy-ap__reason">{run.reason}</div>}
      {!run.reason && run.phase === "aligning" && expanded && <div className="fy-ap__reason">Matching the audio to its blocks.</div>}
      <div className="fy-ap__actions">
        {unresolved && <Button size="sm" variant="primary" onClick={showRequests}>Resolve request</Button>}
        <Button size="sm" variant={unresolved || blockReady ? "outline" : "primary"} onClick={() => { closeActivityPanel(); navigate(audiobookActivityPath(run)); }}>{run.flagged > 0 ? "Review blocks" : run.scope === "block" && run.block ? "Open block" : "Open chapter"}</Button>
        {live && run.phase !== "stopping" && <Button size="sm" variant="outline" onClick={() => stopAudiobook(run.worldId, run.productionId, run.chapterFile)}>Stop</Button>}
        {!unresolved && !live && ["interrupted", "stopped"].includes(run.phase) && jobs.length > 0 && <Button size="sm" variant="outline" onClick={showRequests}>Requests</Button>}
      </div>
      {run.requests > 0 && showDetails && <details className="fy-abactivity__requests" ref={details} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary>{run.requests} request{run.requests === 1 ? "" : "s"}</summary>
        {jobs.map(ref => {
          const job = state.app.jobs.find(job => job.id === ref.id);
          const aligning = ref.index === run.request && run.phase === "aligning";
          const blocks = Array.isArray(job?.params.blocks) ? job.params.blocks.length : undefined;
          const phase = aligning ? "aligning locally" : ref.saved !== undefined && ref.saved === blocks ? "saved" : job?.status === "succeeded" ? "audio received" : job?.status ?? "record unavailable";
          const charge = job ? audiobookRequestCost(job) : { amount: null, label: "charge unknown" };
          const chargeKind = charge.label.endsWith("reported") ? "reported charge" : charge.label.endsWith("from usage") ? "charge from usage" : "measured charge";
          return <div className="fy-abactivity__request" key={ref.id}>
            <div className="fy-abactivity__request-head"><b>Request {ref.index} · {ref.reused ? "reused" : phase}</b>{!ref.reused && charge.amount !== null && <span>{formatMicroUsd(charge.amount)}</span>}</div>
            <div className="fy-ap__rowsub">{ref.reused ? "No new request or charge" : [blocks !== undefined ? `${blocks} blocks` : "", charge.amount === null ? charge.label : chargeKind, aligning ? "no new TTS request" : ""].filter(Boolean).join(" · ")}</div>
            {job?.error && <div className="fy-ap__reason">{job.error}</div>}
            {job?.status === "needs-reconciliation" && <div className="fy-ap__actions">
              <Button size="sm" onClick={() => resolveHeldJob(job.id, "resubmit")}>Resubmit · may charge again</Button>
              <Button size="sm" variant="ghost" onClick={() => resolveHeldJob(job.id, "discard")}>Abandon · prior cost unknown</Button>
            </div>}
            {job && phase !== "saved" && <Button size="sm" variant="ghost" onClick={() => inspectProviderCalls(job.id)}>Provider calls</Button>}
          </div>;
        })}
        {run.request < run.requests && <div className="fy-abactivity__request"><b>Requests {run.request + 1}{run.requests > run.request + 1 ? `–${run.requests}` : ""} · not sent</b><div className="fy-ap__rowsub">{submittedBlocks.length > 0 ? `${remainingBlocks} blocks · ` : ""}~{formatMicroUsd(remainingEstimate)} remaining estimate</div></div>}
      </details>}
    </div>
  </div>;
}

function ReadReceipt({ initial, dismiss }: { initial: AudiobookActivity; dismiss: () => void }) {
  const state = useStore().state;
  const run = state?.app.audiobookActivity?.find(run => run.id === initial.id) ?? initial;
  const close = useRef(dismiss); close.current = dismiss;
  useEffect(() => {
    const timer = setTimeout(() => close.current(), initial.phase === "interrupted" ? 12000 : 6000);
    return () => clearTimeout(timer);
  }, [initial.id, initial.phase]);
  return <div className="fy-note fy-abreceipt" data-testid="audiobook-receipt" role="status">
    <span className={cx("fy-ap__dot", `fy-ap__dot--${tone(run)}`)} aria-hidden />
    <div className="fy-note__body">
      <div className="fy-note__title">{audiobookActivityTitle(run)}</div>
      <div className="fy-note__meta">{[run.request > 0 && audiobookActivityLive(run) ? `Request ${run.request} of ${run.requests}` : "", audiobookActivityCost(run, state?.app.jobs ?? [])].filter(Boolean).join(" · ")}</div>
      {run.phase === "interrupted" && run.reason && <div className="fy-note__reason">{run.reason}</div>}
    </div>
    <div className="fy-note__end"><Button variant="outline" size="sm" onClick={() => { openActivityPanel("inbox"); dismiss(); requestAnimationFrame(() => { const row = document.querySelector<HTMLElement>(`[data-run="${run.id}"]`); row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: "nearest" }); }); }}>Activity</Button>
      <button className="fy-note__close" aria-label="Dismiss narration notice" onClick={dismiss}>×</button>
    </div>
  </div>;
}

/** Only live events announce. Snapshot/reconnect never creates receipts for old operations. */
export function AudiobookActivityReceipts() {
  const observed = useRef(new Set<string>());
  const finished = useRef(new Set<string>());
  useEffect(() => subscribeAudiobookActivity(run => {
    const live = audiobookActivityLive(run);
    const started = run.phase === "queued" && !observed.current.has(run.id);
    const ended = !live && observed.current.has(run.id) && !finished.current.has(run.id);
    if (live) observed.current.add(run.id);
    if (!started && !ended) return;
    if (ended) finished.current.add(run.id);
    const id = `audiobook:${run.id}`;
    toast.custom(() => <ReadReceipt key={`${id}:${ended ? "end" : "start"}`} initial={run} dismiss={() => toast.dismiss(id)} />, {
      id, duration: Infinity, position: "top-right", style: { width: "min(420px, calc(100vw - 24px))" },
    });
  }), []);
  return null;
}

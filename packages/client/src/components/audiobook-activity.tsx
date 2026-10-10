import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  audiobookActivityCost, audiobookActivityJobs, audiobookActivityLive, audiobookActivityPath, audiobookActivityStage,
  audiobookActivityTitle, audiobookRequestCost, type AudiobookActivity, type ClientState,
} from "@arke-studio/contracts";
import { stopAudiobook, subscribeAudiobookActivity, useStore } from "../lib/store.js";
import { closeActivityPanel, openActivityPanel, inspectProviderCalls } from "../lib/activity-panel.js";
import { Button, cx } from "./ui.js";

const tone = (run: AudiobookActivity) => run.phase === "ready" ? "ok" : run.phase === "finished" ? "warn" : run.phase === "interrupted" ? "fail" : audiobookActivityLive(run) ? "live" : "queued";

export function AudiobookActivityRow({ run, state }: { run: AudiobookActivity; state: ClientState }) {
  const navigate = useNavigate();
  const live = audiobookActivityLive(run);
  const jobs = audiobookActivityJobs(run, state.app.jobs);
  return <div className="fy-ap__row fy-ap__row--top fy-abactivity" data-testid="audiobook-activity-row" data-run={run.id} tabIndex={-1}>
    <span className={cx("fy-ap__dot", `fy-ap__dot--${tone(run)}`)} aria-hidden />
    <div className="fy-ap__main">
      <div className="fy-ap__rowtitle">{audiobookActivityTitle(run)}</div>
      <div className="fy-ap__rowsub">{run.productionTitle} · {run.worldName}</div>
      <div className="fy-abactivity__stage" role="status">{audiobookActivityStage(run)}</div>
      {live && run.toMake > 0 && <div className="fy-abactivity__progress" role="progressbar" aria-label="Blocks saved" aria-valuemin={0} aria-valuemax={run.toMake} aria-valuenow={run.made}><i style={{ width: `${Math.min(100, run.made / run.toMake * 100)}%` }} /></div>}
      <div className="fy-ap__rowsub">{run.made} of {run.toMake} blocks saved{!live && run.made + run.flagged < run.toMake ? ` · ${run.toMake - run.made - run.flagged} left unread` : ""}</div>
      <div className="fy-ap__rowsub">{[run.models.join(", "), audiobookActivityCost(run, state.app.jobs)].filter(Boolean).join(" · ")}</div>
      {run.reason && <div className="fy-ap__reason">{run.reason}</div>}
      <div className="fy-ap__actions">
        <Button size="sm" onClick={() => { closeActivityPanel(); navigate(audiobookActivityPath(run)); }}>{run.flagged > 0 ? "Review blocks" : "Open chapter"}</Button>
        {live && run.phase !== "stopping" && <Button size="sm" variant="outline" onClick={() => stopAudiobook(run.worldId, run.productionId, run.chapterFile)}>Stop</Button>}
      </div>
      {jobs.length > 0 && <details className="fy-abactivity__requests">
        <summary>{run.requests} request{run.requests === 1 ? "" : "s"}</summary>
        {jobs.map(ref => {
          const job = state.app.jobs.find(job => job.id === ref.id);
          const phase = ref.index === run.request && run.phase === "aligning" ? "aligning locally" : job?.status === "succeeded" ? "audio received" : job?.status ?? "record unavailable";
          return <div className="fy-abactivity__request" key={ref.id}>
            <div>Request {ref.index} · {ref.reused ? "reused" : phase}</div>
            <div className="fy-ap__rowsub">{ref.reused ? "No new request or charge" : job ? audiobookRequestCost(job).label : "charge unknown"}</div>
            {job?.error && <div className="fy-ap__reason">{job.error}</div>}
            {job && <Button size="sm" variant="ghost" onClick={() => inspectProviderCalls(job.id)}>Provider calls</Button>}
          </div>;
        })}
        {run.request < run.requests && <div className="fy-ap__rowsub">{run.requests - run.request} requests not sent</div>}
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

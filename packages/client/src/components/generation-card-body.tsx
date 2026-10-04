import { useEffect, useRef, useState } from "react";
import { isReplayableFinalization, type ConversationActionCard } from "@arke-studio/contracts";
import { useNavigate } from "react-router";
import { cancelJob, prepareConversationTakeReview, retryJobFinalization, sendWorldChat, useStore } from "../lib/store.js";
import { generationCardView } from "../lib/generation-card-view.js";
import { generationResultUses } from "../lib/generation-result-use.js";
import { mediaUrl } from "../lib/media.js";
import { Button } from "./ui.js";
import { TakeMediaFigure } from "./take-comparison-card.js";

function SelectResult({ action, takeId, shotId }: { action: ConversationActionCard; takeId: string; shotId: string }) {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [preparedId, setPreparedId] = useState<string | null>(null);
  const seq = useStore().state?.worldChat?.seq;
  useEffect(() => {
    if (!preparedId) return;
    const card = document.querySelector<HTMLElement>(`[data-action-id="${preparedId}"]`);
    if (card) { card.focus(); card.scrollIntoView({ block: "nearest" }); setPreparedId(null); }
  }, [preparedId, seq]);
  return <div><Button variant="ghost" disabled={busy} onClick={() => {
    if (active.current) return;
    active.current = true; setBusy(true); setResult("");
    void prepareConversationTakeReview(action, takeId, shotId).then(id => { setResult("Review prepared"); setPreparedId(id); }, error => setResult(error.message))
      .finally(() => { active.current = false; setBusy(false); });
  }}>{busy ? "Preparing…" : "Select"}</Button><span role="status">{result}</span></div>;
}

export function GenerationReferences({ action }: { action: ConversationActionCard }) {
  const world = useStore().state?.world;
  if (world?.meta.worldId !== action.worldId || !action.generationWork?.media.length) return null;
  return <div className="fy-generation-card__grid" aria-label="Frozen references">{action.generationWork.media.map(media => <figure key={media.path}>
    {media.kind === "image" ? <img src={mediaUrl(world.meta.slug, media.path)} alt={media.alt} /> : media.kind === "audio"
      ? <audio controls preload="metadata" src={mediaUrl(world.meta.slug, media.path)} aria-label={media.alt} />
      : media.kind === "video" ? <video controls preload="metadata" src={mediaUrl(world.meta.slug, media.path)} aria-label={media.alt} /> : <span>{media.alt}</span>}
    <figcaption>{media.role}</figcaption>
  </figure>)}</div>;
}

function ResultUse({ action, result }: { action: ConversationActionCard; result: NonNullable<NonNullable<ConversationActionCard["receipt"]>["generation"]>["results"][number] }) {
  const state = useStore().state, world = state?.world;
  const sent = useRef(false);
  const [requested, setRequested] = useState(false);
  const [notice, setNotice] = useState("");
  const uses = world ? generationResultUses(action, result, world) : [];
  if (!uses.length) return null;
  const disabled = requested || state?.worldChat?.conversationId !== action.conversationId;
  return <details className="fy-generation-card__use"><summary>Use as…</summary>{uses.map(use => <Button key={use.label} variant="ghost" disabled={disabled} onClick={() => {
    if (sent.current) return;
    sent.current = true;
    if (sendWorldChat(action.worldId, action.conversationId, use.request)) { setRequested(true); setNotice("Review requested"); }
    else { sent.current = false; setNotice("The request could not be sent."); }
  }}>{use.label}</Button>)}<span role="status">{notice}</span></details>;
}

/** Native result players are shared by running cards and retained terminal receipts. */
export function GenerationResults({ action }: { action: ConversationActionCard }) {
  const { state } = useStore();
  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);
  if (state?.world?.meta.worldId !== action.worldId) return null;
  const world = state.world;
  const view = generationCardView(action, world, state.app.jobs, state.app.ledger);
  const terminal = ["completed", "failed", "cancelled"].includes(action.status);
  const receipt = action.receipt?.generation;
  const results = view.results.length ? view.results : receipt?.results.map(result => ({ ...result, shotIds: [] as string[], segment: undefined })) ?? [];
  const production = world.productions.find(p => p.meta.id === action.productionId);
  const shotIds = [...new Set(results.filter(result => result.status === "completed").flatMap(result => result.shotIds))];
  if (!action.generationWork && !receipt) return null;
  return <div className="fy-generation-card" aria-label="Generation results">
    <p role="status">{terminal && receipt ? receipt.completed : view.completed} / {view.authorized} completed · {terminal && receipt ? receipt.failed : view.failed} failed · {terminal && receipt ? receipt.cancelled : view.cancelled} cancelled</p>
    <p>Actual cost · {view.actualMicroUsd === null ? "Not reported" : `$${(view.actualMicroUsd / 1_000_000).toFixed(4)}`}</p>
    {view.jobs.filter(job => !["succeeded", "failed", "cancelled"].includes(job.status)).map(job => <div key={job.id} className="fy-generation-card__job">
      <span>{job.target.id} · {job.status}{job.step ? ` · ${job.step.stage} ${job.step.done}/${job.step.total}` : ""}{job.waitingFor ? ` · ${job.waitingFor}` : ""}</span>
      {action.shown.body.family === "generation" && action.shown.body.cancellationSupported && <Button variant="ghost" onClick={() => cancelJob(job.id)}>Cancel</Button>}
    </div>)}
    <div className="fy-generation-card__grid">{production && shotIds.map(shotId => {
      const selection = production.selections[shotId];
      const id = action.shown.body.family === "generation" && action.shown.body.medium === "image" ? selection?.startFrameTakeId ?? selection?.startFrameArtifactId ?? null : selection?.acceptedTakeId ?? null;
      return <TakeMediaFigure key={`current:${shotId}`} world={world} production={production} id={id} label={`Current selection · ${shotId}`} />;
    })}{results.map(result => <figure key={result.id}>
      {result.status === "completed" && result.mediaPath ? <>
        {result.medium === "video" ? <video controls preload="metadata" src={mediaUrl(world.meta.slug, result.mediaPath)} {...(result.posterPath ? { poster: mediaUrl(world.meta.slug, result.posterPath) } : {})}
          onLoadedMetadata={event => { if (result.segment) event.currentTarget.currentTime = result.segment.inSec; }}
          onTimeUpdate={event => { if (result.segment && event.currentTarget.currentTime >= result.segment.outSec) { event.currentTarget.pause(); event.currentTarget.currentTime = result.segment.inSec; } }} />
          : result.medium === "audio" ? <audio controls preload="metadata" src={mediaUrl(world.meta.slug, result.mediaPath)} />
          : result.medium === "image" ? <img src={mediaUrl(world.meta.slug, result.mediaPath)} alt={result.description} /> : null}
        <a href={mediaUrl(world.meta.slug, result.mediaPath)} target="_blank" rel="noreferrer">Open</a>
        {action.productionId && result.shotIds.length ? result.shotIds.map(shotId => <SelectResult key={shotId} action={action} takeId={result.id} shotId={shotId} />) : generationResultUses(action, result, world).length ? <ResultUse action={action} result={result} /> : world.referenceTakes.some(t => t.id === result.id) ? <Button variant="ghost" onClick={() => {
          const take = world.referenceTakes.find(t => t.id === result.id), sheet = world.sheets.find(s => s.id === take?.reference?.sheetId);
          void navigate(`/w/${world.meta.worldId}${sheet ? sheet.type === "location" ? `/locations/${sheet.id}/reference` : `/cast/${sheet.id}/kit` : take?.prop ? "/props" : ""}`);
        }}>Use as…</Button> : action.productionId ? <Button variant="ghost" onClick={() => void navigate(`/w/${world.meta.worldId}/p/${action.productionId}`)}>Open production</Button> : null}
      </> : null}
      <figcaption>{result.description} · {result.status}{result.detail ? ` · ${result.detail}` : ""}</figcaption>
    </figure>)}</div>
    {view.jobs.filter(job => job.status === "failed" || job.finalization?.status === "failed").map(job => <div key={job.id} className="fy-actioncard__notice">
      <p>{job.target.id} · {job.error ?? "Result filing needs retry in Activity"}</p>
      {job.finalization?.status === "failed" && isReplayableFinalization(job) ? <Button variant="ghost" onClick={() => retryJobFinalization(job.id)}>Retry filing</Button>
        : job.status === "failed" && action.productionId && <Button variant="ghost" disabled={retrying || state.worldChat?.conversationId !== action.conversationId} onClick={() => {
          if (sendWorldChat(action.worldId, action.conversationId, `Prepare a new quote to retry only the failed generation job ${job.id} from action ${action.actionId}. Keep its production and shot targets. Re-read the current inputs. Leave uncertain provider work for reconciliation.`)) setRetrying(true);
        }}>Retry with a new quote</Button>}
    </div>)}
  </div>;
}

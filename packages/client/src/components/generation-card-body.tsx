import { useEffect, useRef, useState } from "react";
import { formatMicroUsd, isReplayableFinalization, type ConversationActionCard } from "@arke-studio/contracts";
import { useNavigate } from "react-router";
import { cancelJob, prepareConversationTakeReview, retryJobFinalization, sendWorldChat, useWorld, useStoreSelector, useClientState } from "../lib/store.js";
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
  const seq = useStoreSelector((store) => store.state?.worldChat?.seq);
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

/** "0–5s" on the clip's own clock, without the zeros nobody says. */
function clipSpan(startSec: number, endSec: number): string {
  const said = (sec: number) => String(Math.round(sec * 10) / 10);
  return `${said(startSec)}–${said(endSec)}s`;
}

/** A shot's words, short until asked for: a film shot can run to a page, and its row is read for the picture and the line first. */
function ShotWords({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 280) return <p data-action>{text}</p>;
  return <><p data-action>{open ? text : `${text.slice(0, 240).replace(/\s+\S*$/, "").replace(/[,;:]$/, "")}…`}</p>
    <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</Button></>;
}

/**
 * The clip's shots, read before it is made (SPEC-041 R-75a): each in the order it plays, with the
 * picture sent for it, its seconds, the camera, the line and what happens. The prompt under it is
 * what is sent; this is how a person reads the same request. A shot shows a picture only where one
 * is sent for it, so a row without one is a shot the model draws from words.
 */
export function GenerationStoryboard({ action }: { action: ConversationActionCard }) {
  const world = useWorld();
  const body = action.shown.body;
  if (body.family !== "generation" || !body.storyboard?.length) return null;
  const slug = world?.meta.worldId === action.worldId ? world.meta.slug : null;
  return <ol className="fy-storyboard" aria-label="Shots">{body.storyboard.map(shot => <li key={shot.shotId}>
    {shot.picture && slug && <img src={mediaUrl(slug, shot.picture)} alt={`Shot ${shot.number} start picture`} draggable={false} />}
    <div>
      <p><strong>{shot.number} · {shot.title}</strong> · {clipSpan(shot.startSec, shot.endSec)}</p>
      {shot.camera && <p data-camera>{shot.camera}</p>}
      {shot.line && <p data-line>{shot.line.speaker && <strong>{shot.line.speaker} </strong>}“{shot.line.text}”</p>}
      {shot.action && <ShotWords text={shot.action} />}
      {shot.beats?.map(beat => <p key={`${beat.span}/${beat.text}`} data-beat>{beat.span} · {beat.text}</p>)}
    </div>
  </li>)}</ol>;
}

export function GenerationReferences({ action }: { action: ConversationActionCard }) {
  const world = useWorld();
  if (world?.meta.worldId !== action.worldId || !action.generationWork?.media.length) return null;
  return <div className="fy-generation-card__grid" aria-label="Frozen references">{action.generationWork.media.map(media => <figure key={media.path}>
    {media.kind === "image" ? <img src={mediaUrl(world.meta.slug, media.path)} alt={media.alt} /> : media.kind === "audio"
      ? <audio controls preload="metadata" src={mediaUrl(world.meta.slug, media.path)} aria-label={media.alt} />
      : media.kind === "video" ? <video controls preload="metadata" src={mediaUrl(world.meta.slug, media.path)} aria-label={media.alt} /> : <span>{media.alt}</span>}
    <figcaption>{media.role}</figcaption>
  </figure>)}</div>;
}

function ResultUse({ action, result }: { action: ConversationActionCard; result: NonNullable<NonNullable<ConversationActionCard["receipt"]>["generation"]>["results"][number] }) {
  const state = useClientState(), world = state?.world;
  const sent = useRef(false);
  const [requested, setRequested] = useState(false);
  const [notice, setNotice] = useState("");
  const uses = world ? generationResultUses(action, result, world) : [];
  if (!uses.length) return null;
  const disabled = requested || state?.worldChat?.conversationId !== action.conversationId;
  const press = (use: typeof uses[number]) => {
    if (sent.current) return;
    sent.current = true;
    if (sendWorldChat(action.worldId, action.conversationId, use.request)) { setRequested(true); setNotice("Review requested"); }
    else { sent.current = false; setNotice("The request could not be sent."); }
  };
  // One use is one press: a menu of one hid it behind a word.
  if (uses.length === 1) return <><Button variant="secondary" disabled={disabled} onClick={() => press(uses[0]!)}>Use as {uses[0]!.label.toLowerCase()}</Button><span role="status">{notice}</span></>;
  return <details className="fy-generation-card__use"><summary>Use as…</summary>{uses.map(use => <Button key={use.label} variant="ghost" disabled={disabled} onClick={() => press(use)}>{use.label}</Button>)}<span role="status">{notice}</span></details>;
}

/** Native result players are shared by running cards and retained terminal receipts. */
export function GenerationResults({ action }: { action: ConversationActionCard }) {
  const state = useClientState();
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
  const failed = terminal && receipt ? receipt.failed : view.failed, cancelled = terminal && receipt ? receipt.cancelled : view.cancelled;
  return <div className="fy-generation-card" aria-label="Generation results">
    {(!terminal || failed > 0 || cancelled > 0) && <p role="status">{terminal && receipt ? receipt.completed : view.completed} of {view.authorized} made{failed ? ` · ${failed} failed` : ""}{cancelled ? ` · ${cancelled} cancelled` : ""}</p>}
    {view.actualMicroUsd ? <p>Cost · {formatMicroUsd(view.actualMicroUsd)}</p> : null}
    {view.jobs.filter(job => !["succeeded", "failed", "cancelled"].includes(job.status)).map(job => <div key={job.id} className="fy-generation-card__job">
      <span>{job.status === "needs-reconciliation" ? "Needs your answer in Activity" : job.step ? `${job.step.stage} ${job.step.done}/${job.step.total}` : job.status === "queued" ? "Waiting" : "Making"}{job.waitingFor ? ` · ${job.waitingFor}` : ""}</span>
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
        <div className="fy-generation-card__acts">
        <a className="ui-btn ui-btn--ghost ui-btn--md" href={mediaUrl(world.meta.slug, result.mediaPath)} target="_blank" rel="noreferrer">Open</a>
        {action.productionId && result.shotIds.length ? result.shotIds.map(shotId => <SelectResult key={shotId} action={action} takeId={result.id} shotId={shotId} />) : generationResultUses(action, result, world).length ? <ResultUse action={action} result={result} /> : world.referenceTakes.some(t => t.id === result.id) ? <Button variant="ghost" onClick={() => {
          const take = world.referenceTakes.find(t => t.id === result.id), sheet = world.sheets.find(s => s.id === take?.reference?.sheetId);
          void navigate(`/w/${world.meta.worldId}${sheet ? sheet.type === "location" ? `/locations/${sheet.id}/reference` : `/cast/${sheet.id}/kit` : take?.prop ? "/props" : ""}`);
        }}>Use as…</Button> : action.productionId ? <Button variant="ghost" onClick={() => void navigate(`/w/${world.meta.worldId}/p/${action.productionId}`)}>Open production</Button> : null}
        </div>
      </> : null}
      {!(result.status === "completed" && result.description.startsWith("New ")) && <figcaption>{result.description}{result.status === "completed" ? "" : ` · ${result.status}`}{result.detail ? ` · ${result.detail}` : ""}</figcaption>}
    </figure>)}</div>
    {view.jobs.filter(job => job.status === "failed" || job.finalization?.status === "failed").map(job => <div key={job.id} className="fy-actioncard__notice">
      <p>{job.error ?? "Result filing needs retry in Activity"}</p>
      {job.finalization?.status === "failed" && isReplayableFinalization(job) ? <Button variant="ghost" onClick={() => retryJobFinalization(job.id)}>Retry filing</Button>
        : job.status === "failed" && action.productionId && <Button variant="ghost" disabled={retrying || state.worldChat?.conversationId !== action.conversationId} onClick={() => {
          if (sendWorldChat(action.worldId, action.conversationId, `Prepare a new quote to retry only the failed generation job ${job.id} from action ${action.actionId}. Keep its production and shot targets. Re-read the current inputs. Leave uncertain provider work for reconciliation.`)) setRetrying(true);
        }}>Retry with a new quote</Button>}
    </div>)}
  </div>;
}

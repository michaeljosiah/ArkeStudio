import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  formatMicroUsd,
  orderedShots,
  sceneImageOutput,
  ulid,
  type ArtifactSidecar,
  type FrameRunQuote,
  type FrameRunState,
  type FrameRunStepState,
  type ManifestModel,
  type ProductionBundle,
  type SceneRecord,
  type WorldBundle,
} from "@arke-studio/contracts";
import { productionModel, resolveModel, strandReason, usableModels } from "../../components/dispatch-bar.js";
import { ChevronLeft, ChevronRight, X } from "../../components/icons.js";
import { Button } from "../../components/ui.js";
import { mediaUrl } from "../../lib/media.js";
import {
  clearFrameRunQuote,
  clearFrameRunStartResult,
  frameRunCommand,
  subscribeFrameRunQuote,
  subscribeFrameRunStartResult,
  type useClientState,
  useStore,
} from "../../lib/store.js";
import { boardsForScene, shotHasFrame, type WorkspaceBoardPack } from "./boards.js";

type ClientState = ReturnType<typeof useClientState>;
type RunShotView = FrameRunStepState["shots"][number] & {
  stepIndex: number;
  stepCanRetry: boolean;
  grain: FrameRunState["run"]["steps"][number]["grain"];
};

const SETTLED = new Set(["succeeded", "failed", "cancelled", "reconciled", "superseded", "missing"]);

/** Retries append, so the last durable attempt naming a shot is its authoritative projection. */
export function frameRunShotState(run: FrameRunState | null, shotId: string): RunShotView | null {
  if (run === null) return null;
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const shot = run.steps[index]!.shots.find((candidate) => candidate.shotId === shotId);
    if (shot !== undefined) {
      return {
        ...shot,
        stepIndex: index,
        stepCanRetry: run.steps[index]!.canRetry,
        grain: run.run.steps[index]!.grain,
      };
    }
  }
  return null;
}

function moveRadio(event: KeyboardEvent<HTMLElement>, select: (index: number) => void): void {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const group = event.currentTarget.closest('[role="radiogroup"]');
  if (group === null) return;
  const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
  const current = radios.indexOf(event.currentTarget);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? radios.length - 1
      : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + radios.length) % radios.length;
  event.preventDefault();
  select(next);
  radios[next]?.focus();
}

function boardCap(model: ManifestModel | null): { seconds: number; panels: number | undefined; name: string } {
  return {
    seconds: model?.limits.maxDurationSec ?? 10,
    panels: model?.limits.storyboardPanels,
    name: model?.displayName ?? "routed video model",
  };
}

export function GenerateFramesDialog({
  open,
  state,
  world,
  production,
  scene,
  aspect,
  videoModel,
  shotId,
  returnFocus,
  onClose,
}: {
  open: boolean;
  state: ClientState;
  world: WorldBundle;
  production: ProductionBundle;
  scene: SceneRecord;
  aspect: string;
  videoModel: ManifestModel | null;
  shotId?: string;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <GenerateFramesDialogOpen
      state={state}
      world={world}
      production={production}
      scene={scene}
      aspect={aspect}
      videoModel={videoModel}
      {...(shotId === undefined ? {} : { shotId })}
      returnFocus={returnFocus}
      onClose={onClose}
    />
  );
}

function GenerateFramesDialogOpen({
  state,
  world,
  production,
  scene,
  aspect,
  videoModel,
  shotId,
  returnFocus,
  onClose,
}: Omit<Parameters<typeof GenerateFramesDialog>[0], "open">) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const sceneShots = orderedShots(scene);
  const shots = shotId === undefined ? sceneShots : sceneShots.filter((shot) => shot.id === shotId);
  const missing = shots.filter((shot) => !shotHasFrame(production, world.artifacts, shot.id));
  const [mode, setMode] = useState<"per-shot" | "board">(shotId === undefined ? "board" : "per-shot");
  const [scope, setScope] = useState<"missing" | "all">(shotId === undefined && missing.length > 0 ? "missing" : "all");
  const remembered = productionModel(state, production.meta.id, "image");
  const resolved = resolveModel(state, "image", undefined, remembered);
  const [modelId, setModelId] = useState(remembered ?? resolved.model?.id ?? "");
  const allModels = state?.app.manifest?.models ?? [];
  const knownModel = allModels.find((candidate) => candidate.id === modelId && candidate.capability === "image") ?? null;
  const usable = usableModels(state, "image");
  const models = knownModel !== null && !usable.some((candidate) => candidate.id === knownModel.id)
    ? [knownModel, ...usable]
    : usable;
  const modelChoices: Array<{ id: string; model: ManifestModel | null }> = modelId.length > 0 && knownModel === null
    ? [{ id: modelId, model: null }, ...usable.map((model) => ({ id: model.id, model }))]
    : models.map((model) => ({ id: model.id, model }));
  const unavailable = knownModel !== null && !usable.some((candidate) => candidate.id === knownModel.id);
  const included = scope === "all" ? shots : missing;
  const cap = boardCap(videoModel);
  const pack = boardsForScene({
    scene,
    production,
    artifacts: world.artifacts,
    sheets: world.sheets,
    capSec: cap.seconds,
    ...(cap.panels !== undefined ? { panelCap: cap.panels } : {}),
  });
  const [quote, setQuote] = useState<FrameRunQuote | null>(null);
  const [quotePending, setQuotePending] = useState(false);
  const [deliveryReason, setDeliveryReason] = useState<string | null>(null);
  const [startPending, setStartPending] = useState<{ requestId: string; quoteId: string } | null>(null);
  const [startReason, setStartReason] = useState<string | null>(null);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const currentRequest = useRef<string | null>(null);
  const startSubscription = useRef<(() => void) | null>(null);
  const requestEpoch = useStore().frameRunRequestEpoch;
  const seenRequestEpoch = useRef(requestEpoch);
  const options = {
    worldId: world.meta.worldId,
    productionId: production.meta.id,
    sceneId: scene.id,
    mode,
    modelId,
    scope,
    ...(shotId === undefined ? {} : { shotId }),
  };

  useEffect(() => {
    const node = dialog.current;
    if (node === null) return;
    if (node.showModal !== undefined) node.showModal();
    else node.setAttribute("open", "");
    return () => returnFocus.current?.focus();
  }, [returnFocus]);

  useEffect(() => {
    setQuote(null);
    setDeliveryReason(null);
    if (modelId.length === 0) {
      setQuotePending(false);
      currentRequest.current = null;
      setDeliveryReason("No image model is available to quote.");
      return;
    }
    const requestId = ulid();
    currentRequest.current = requestId;
    setQuotePending(true);
    const unsubscribe = subscribeFrameRunQuote(requestId, (event) => {
      if (currentRequest.current !== requestId) return;
      const answer = event.quote;
      if (
        answer.requestId !== requestId ||
        answer.worldId !== options.worldId ||
        answer.productionId !== options.productionId ||
        answer.sceneId !== options.sceneId ||
        answer.mode !== options.mode ||
        answer.modelId !== options.modelId ||
        answer.scope !== options.scope ||
        answer.shotId !== options.shotId
      ) return;
      setQuote(answer);
      setQuotePending(false);
    });
    if (!frameRunCommand({ kind: "frame-run-quote", requestId, ...options })) {
      currentRequest.current = null;
      setQuotePending(false);
      setDeliveryReason("A current quote is unavailable while the studio is disconnected.");
    }
    return () => {
      if (currentRequest.current === requestId) currentRequest.current = null;
      unsubscribe();
      clearFrameRunQuote(requestId);
    };
  }, [world.meta.worldId, production.meta.id, scene.id, scene.version, mode, modelId, scope, quoteRevision, requestEpoch]);

  useEffect(() => () => {
    startSubscription.current?.();
    startSubscription.current = null;
  }, []);

  useEffect(() => {
    if (seenRequestEpoch.current === requestEpoch) return;
    seenRequestEpoch.current = requestEpoch;
    startSubscription.current?.();
    startSubscription.current = null;
    setStartPending(null);
    setStartReason("The studio refreshed before the frame run was confirmed.");
  }, [requestEpoch]);

  const matchingOptions = quote !== null &&
    quote.requestId === currentRequest.current &&
    quote.worldId === options.worldId &&
    quote.productionId === options.productionId &&
    quote.sceneId === options.sceneId &&
    quote.mode === mode &&
    quote.modelId === modelId &&
    quote.scope === scope &&
    quote.shotId === shotId;
  const canStart = matchingOptions &&
    quote.sceneVersion === scene.version &&
    quote.blockedReason === null &&
    quote.signature !== null &&
    quote.estimatedMicroUsd !== null;
  const blockedReason = matchingOptions ? quote.blockedReason : deliveryReason;

  const start = () => {
    if (startPending !== null || !canStart || quote.signature === null || quote.estimatedMicroUsd === null) return;
    const pending = { requestId: quote.requestId, quoteId: quote.quoteId };
    startSubscription.current?.();
    startSubscription.current = subscribeFrameRunStartResult(quote.requestId, quote.quoteId, (event) => {
      if (
        event.requestId !== pending.requestId ||
        event.quoteId !== pending.quoteId ||
        event.worldId !== options.worldId ||
        event.productionId !== options.productionId
      ) return;
      startSubscription.current?.();
      startSubscription.current = null;
      clearFrameRunQuote(pending.requestId);
      clearFrameRunStartResult(pending.requestId, pending.quoteId);
      if (event.disposition === "accepted") {
        onClose();
        return;
      }
      setQuote(null);
      setStartPending(null);
      setStartReason(event.reason ?? "The frame run was refused.");
      setQuoteRevision((revision) => revision + 1);
    });
    setStartReason(null);
    setStartPending(pending);
    const sent = frameRunCommand({
      kind: "frame-run-start",
      requestId: quote.requestId,
      quoteId: quote.quoteId,
      quoteSignature: quote.signature,
      quotedMicroUsd: quote.estimatedMicroUsd,
      ...options,
    });
    if (!sent) {
      startSubscription.current();
      startSubscription.current = null;
      setStartPending(null);
      setStartReason("The frame run could not be sent while the studio is disconnected.");
    }
  };

  return (
    <dialog
      ref={dialog}
      className="fy-swgen"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="fy-swgen__panel">
        <header className="fy-swgen__head">
          <div>
            <span className="fy-swgen__eyebrow">Scene {scene.number} · frames</span>
            <h2 id={titleId}>Generate {matchingOptions ? quote.includedCount : included.length} frame{(matchingOptions ? quote.includedCount : included.length) === 1 ? "" : "s"}</h2>
          </div>
          <button type="button" aria-label="Close generate frames" onClick={onClose}><X size={18} /></button>
        </header>

        {shotId === undefined ? <section className="fy-swgen__section">
          <h3>Method</h3>
          <div className="fy-swgen__methods" role="radiogroup" aria-label="Frame generation method">
            {(["per-shot", "board"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                disabled={startPending !== null}
                role="radio"
                tabIndex={mode === candidate ? 0 : -1}
                aria-checked={mode === candidate}
                data-on={mode === candidate ? "true" : undefined}
                onKeyDown={(event) => moveRadio(event, (at) => setMode((["per-shot", "board"] as const)[at]!))}
                onClick={() => setMode(candidate)}
              >
                <strong>{candidate === "per-shot" ? "Per shot" : "Shot board"}</strong>
                <span>{candidate === "per-shot" ? "Fastest, cheap to retry, but characters and light drift between shots." : "Holds cast, light and grade together - a retry redoes the whole board."}</span>
              </button>
            ))}
          </div>
        </section> : null}

        {shotId === undefined && mode === "board" ? <PackingPreview shots={shots} pack={pack} cap={cap} /> : null}

        {shotId === undefined ? <section className="fy-swgen__section">
          <h3>Include</h3>
          <div className="fy-swgen__scope" role="radiogroup" aria-label="Frames to include">
            {(["missing", "all"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                disabled={startPending !== null}
                role="radio"
                tabIndex={scope === candidate ? 0 : -1}
                aria-checked={scope === candidate}
                data-on={scope === candidate ? "true" : undefined}
                onKeyDown={(event) => moveRadio(event, (at) => setScope((["missing", "all"] as const)[at]!))}
                onClick={() => setScope(candidate)}
              >
                {candidate === "missing" ? "Shots without a frame" : "Every shot in the scene"} <span>{candidate === "missing" ? missing.length : shots.length}</span>
              </button>
            ))}
          </div>
        </section> : null}

        <section className="fy-swgen__section">
          <h3>Image model</h3>
          <div className="fy-swgen__models" role="radiogroup" aria-label="Image model">
            {modelChoices.map((choice) => {
              const candidate = choice.model;
              const selected = choice.id === modelId;
              const candidateUnavailable = candidate === null || !usable.some((entry) => entry.id === candidate.id);
              const output = candidate === null ? null : sceneImageOutput(candidate, undefined, aspect);
              return (
                <button
                  key={choice.id}
                  type="button"
                  disabled={startPending !== null}
                  role="radio"
                  tabIndex={selected ? 0 : -1}
                  aria-checked={selected}
                  data-on={selected ? "true" : undefined}
                  onKeyDown={(event) => moveRadio(event, (at) => setModelId(modelChoices[at]!.id))}
                  onClick={() => setModelId(choice.id)}
                >
                  <strong>{candidate?.displayName ?? choice.id}{candidateUnavailable ? " · unavailable" : ""}</strong>
                  <span>{candidate === null
                    ? "No longer in the model catalogue"
                    : `${output!.width}x${output!.height} output · ${candidate.accepts.referenceImages} reference${candidate.accepts.referenceImages === 1 ? "" : "s"}${candidateUnavailable ? ` · ${strandReason(state, candidate)}` : ""}`}</span>
                </button>
              );
            })}
          </div>
          {unavailable ? <p className="fy-swgen__hint">This production still names {knownModel!.displayName}; it has not been replaced by another model.</p> : null}
        </section>

        <footer className="fy-swgen__foot">
          <div className="fy-swgen__context" aria-label="Inherited scene context">
            {contextLabels(scene, world, production, aspect).map((label) => <span key={label}>{label}</span>)}
          </div>
          <div className="fy-swgen__estimate">
            {startPending !== null
              ? "Starting frame run..."
              : matchingOptions
                ? `${quote.includedCount} frame${quote.includedCount === 1 ? "" : "s"}${quote.estimatedMicroUsd === null ? "" : ` · ${formatMicroUsd(quote.estimatedMicroUsd)}`}`
                : quotePending
                  ? "Checking current price..."
                  : "Quote unavailable"}
          </div>
          <Button onClick={onClose}>Cancel</Button>
          {startReason === null ? null : <p className="fy-swgen__guard" role="status">{startReason}</p>}
          {blockedReason !== null && startPending === null ? <p className="fy-swgen__guard" role="status">{blockedReason}</p> : <Button variant="primary" disabled={!canStart || startPending !== null} onClick={start}>{startPending === null ? "Generate frames" : "Starting..."}</Button>}
        </footer>
      </div>
    </dialog>
  );
}

function PackingPreview({
  shots,
  pack,
  cap,
}: {
  shots: ReturnType<typeof orderedShots>;
  pack: WorkspaceBoardPack;
  cap: ReturnType<typeof boardCap>;
}) {
  const numberById = new Map(shots.map((shot) => [shot.id, shot.number]));
  return (
    <section className="fy-swgen__section fy-swgen__packing">
      <h3>Packing preview · {cap.name} · {cap.seconds}s cap{cap.panels === undefined ? "" : ` · ${cap.panels} panels`}</h3>
      {!pack.ok ? <p className="fy-swgen__guard">{pack.reason}</p> : (
        <>
          <p className="fy-swgen__packline">{shots.length} shots → {pack.boards.length} board{pack.boards.length === 1 ? "" : "s"}</p>
          <div className="fy-swgen__boards">
            {pack.boards.map((board) => {
              const headroom = cap.seconds - board.durationSec;
              return (
                <article key={board.letter}>
                  <strong>Board {board.letter} · shots {numberById.get(board.memberShotIds[0]!)}–{numberById.get(board.memberShotIds.at(-1)!)}</strong>
                  <span>{board.durationSec}s / {cap.seconds}s · <i data-tight={headroom < 2 ? "true" : undefined}>{headroom}s spare</i></span>
                  {board.reason === null ? null : <span>split · {board.reason}</span>}
                  {board.notes.map((note, index) => <span key={`${note.text}:${index}`} data-kind={note.kind}>{note.text}</span>)}
                </article>
              );
            })}
          </div>
          <p className="fy-swgen__hint">This preview explains continuity packing. The current quote decides whether the selected image model can render the composite.</p>
        </>
      )}
    </section>
  );
}

function contextLabels(scene: SceneRecord, world: WorldBundle, production: ProductionBundle, aspect: string): string[] {
  const location = scene.inherits?.location === undefined
    ? null
    : world.sheets.find((sheet) => sheet.id === scene.inherits?.location)?.name ?? scene.inherits.location;
  return [
    location === null ? null : `location · ${location}`,
    scene.inherits?.timeOfDay === undefined ? null : `time · ${scene.inherits.timeOfDay}`,
    production.meta.styleOverride === undefined ? `world look · v${world.artDirection.version}` : "production look",
    `aspect · ${aspect}`,
  ].filter((label): label is string => label !== null);
}

export function FrameRunBar({ run, worldId, productionId, onReview }: { run: FrameRunState; worldId: string; productionId: string; onReview: () => void }) {
  const total = new Set(run.run.steps.filter((step) => step.grain === "initial").flatMap((step) => step.updateShotIds)).size;
  const settled = Math.min(total, run.filedShots + run.failedShots + run.supersededShots);
  const current = run.steps.find((step) => !SETTLED.has(step.status));
  const currentLabel = current === undefined ? null : run.run.steps[current.index]?.label ?? null;
  const finishing = run.steps.filter((step) => ["queued", "submitting", "running"].includes(step.status)).length;
  const control = (kind: "frame-run-pause" | "frame-run-resume" | "frame-run-cancel" | "frame-run-dismiss") =>
    frameRunCommand({ kind, worldId, productionId, runId: run.run.id });

  if (run.status === "completed") {
    return (
      <div className="fy-swrun fy-swrun--complete" data-testid="frame-run-bar" role="status">
        <strong>{run.filedShots} frame{run.filedShots === 1 ? "" : "s"} added{run.failedShots > 0 ? ` · ${run.failedShots} failed` : ""}{run.supersededShots > 0 ? ` · ${run.supersededShots} overtaken` : ""}</strong>
        <span className="fy-swrun__rule" />
        <button type="button" onClick={onReview}>Review</button>
        <button type="button" aria-label="Dismiss frame run" onClick={() => control("frame-run-dismiss")}><X size={14} /></button>
      </div>
    );
  }
  if (run.status === "cancelled") {
    return (
      <div className="fy-swrun fy-swrun--complete" data-testid="frame-run-bar" role="status">
        <strong>Frame run cancelled</strong><span className="fy-swrun__rule" />
        <button type="button" aria-label="Dismiss frame run" onClick={() => control("frame-run-dismiss")}><X size={14} /></button>
      </div>
    );
  }
  return (
    <div className="fy-swrun" data-testid="frame-run-bar" role="status">
      <progress value={settled} max={Math.max(1, total)} aria-label={`${settled} of ${total} frames`} />
      <strong>{run.status === "paused" ? `paused${finishing > 0 ? ` · finishing ${finishing}` : ""}` : currentLabel ?? "Preparing frames"}</strong>
      <span>{settled} of {total} frames</span>
      {run.etaSec === null ? null : <span>~{Math.ceil(run.etaSec)}s left</span>}
      <span className="fy-swrun__rule" />
      {run.status === "paused"
        ? <button type="button" onClick={() => control("frame-run-resume")}>Resume</button>
        : <button type="button" onClick={() => control("frame-run-pause")}>Pause</button>}
      <button type="button" onClick={() => control("frame-run-cancel")}>Cancel</button>
    </div>
  );
}

export function FrameRunBoardFailures({ run, worldId, productionId }: { run: FrameRunState; worldId: string; productionId: string }) {
  if (run.run.mode !== "board") return null;
  const failures = run.steps.flatMap((state, index) => {
    const step = run.run.steps[index]!;
    return state.status === "failed" && step.grain !== "cell-retry" ? [{ state, step, index }] : [];
  });
  if (failures.length === 0) return null;
  return (
    <div className="fy-swrunboards" aria-label="Frame run board failures">
      {failures.map(({ state, step, index }) => (
        <div key={index} className="fy-swboard__failure" role="status">
          <strong>{step.label}</strong><span>{runFailureCopy(state)}</span>
          {state.canRetry ? <button type="button" onClick={() => frameRunCommand({ kind: "frame-run-retry-step", worldId, productionId, runId: run.run.id, stepIndex: index })}>Retry board</button> : null}
        </div>
      ))}
    </div>
  );
}

function runFailureCopy(state: Pick<FrameRunStepState, "status" | "failureClass" | "error">): string {
  if (state.failureClass === "provider-fault") return state.error === null ? "provider fault · lane held" : `${state.error} · lane held`;
  if (state.failureClass === "offline") {
    // Offline holds the lane only while the job is still queued or running. A board that gave
    // up after its last attempt is terminal with nothing paused behind it, so the suffix would
    // name a hold that does not exist (issue 697). Provider-fault keeps it: a credential
    // rejection pauses the lane even as it terminalizes the job.
    const held = state.status === "queued" || state.status === "submitting" || state.status === "running";
    if (!held) return state.error ?? "offline";
    return state.error === null ? "offline · lane held" : `${state.error} · lane held`;
  }
  if (state.failureClass === "terminal") return state.error ?? "the provider refused this request";
  return state.error ?? "came back dark";
}

export function FrameRunReview({
  run,
  scene,
  artifacts,
  worldSlug,
  open,
  onClose,
}: {
  run: FrameRunState;
  scene: SceneRecord;
  artifacts: readonly ArtifactSidecar[];
  worldSlug: string | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const jobs = new Set(run.run.steps.flatMap((step) => step.jobId === null ? [] : [step.jobId]));
  const shotOrder = run.run.steps.filter((step) => step.grain === "initial").flatMap((step) => step.updateShotIds);
  const frames = artifacts.filter((artifact) => {
    if (artifact.kind !== "image" || artifact.origin.by !== "system") return false;
    const producedBy = artifact.origin.producedBy;
    return [...jobs].some((jobId) => producedBy === `frame-run:${jobId}`);
  }).sort((left, right) => {
    const leftAt = shotOrder.findIndex((shotId) => left.links.includes(shotId));
    const rightAt = shotOrder.findIndex((shotId) => right.links.includes(shotId));
    return leftAt - rightAt || left.created.localeCompare(right.created);
  });
  const [index, setIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!open || node === null) return;
    setIndex(0);
    if (node.showModal !== undefined) node.showModal();
    else node.setAttribute("open", "");
  }, [open]);
  if (!open) return null;
  const frame = frames[index] ?? null;
  const shot = frame === null ? undefined : orderedShots(scene).find((candidate) => frame.links.includes(candidate.id));
  return (
    <dialog ref={dialog} className="fy-swreview" aria-label="Generated frames" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="fy-swreview__panel">
        <button type="button" className="fy-swreview__close" aria-label="Close generated frames" onClick={onClose}><X size={18} /></button>
        {frame === null || worldSlug === undefined ? <p>No filed frames from this run are available yet.</p> : <img src={mediaUrl(worldSlug, `artifacts/${frame.file}`)} alt={shot === undefined ? "Generated frame" : `Shot ${shot.number} · ${shot.title}`} />}
        <footer>
          <button type="button" aria-label="Previous frame" disabled={index === 0} onClick={() => setIndex((value) => value - 1)}><ChevronLeft /></button>
          <span>{frames.length === 0 ? "No frames" : `${index + 1} of ${frames.length}`}</span>
          <button type="button" aria-label="Next frame" disabled={index >= frames.length - 1} onClick={() => setIndex((value) => value + 1)}><ChevronRight /></button>
        </footer>
      </div>
    </dialog>
  );
}

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  aspectSupport,
  formatMicroUsd,
  isReplayableFinalization,
  orderedShots,
  PROVIDERS,
  resolveCast,
  sceneImageOutput,
  ulid,
  type FrameRunQuote,
  type FrameRunState,
  type FrameRunStepState,
  type Job,
  type ManifestModel,
  type ProductionBundle,
  type SceneRecord,
  type WorldBundle,
  resolvePropStates,
} from "@arke-studio/contracts";
import { productionModel, resolveModel, strandReason, usableModels } from "../../components/dispatch-bar.js";
import { X } from "../../components/icons.js";
import { characterPortraitPath, locationPortraitPath, Portrait } from "../../components/portrait.js";
import { Button } from "../../components/ui.js";
import {
  clearFrameRunQuote,
  clearFrameRunStartResult,
  frameRunCommand,
  retryJobFinalization,
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

export function finalizationRetryJobId(
  run: FrameRunState,
  stepIndex: number,
  jobs: readonly Job[],
): string | null {
  const jobId = run.run.steps[stepIndex]?.jobId;
  if (jobId === null || jobId === undefined) return null;
  const job = jobs.find((candidate) => candidate.id === jobId);
  return job?.finalization?.status === "failed" && isReplayableFinalization(job) ? job.id : null;
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

function boardCap(model: ManifestModel | null): { seconds: number; panels: number | undefined } {
  return {
    seconds: model?.limits.maxDurationSec ?? 10,
    panels: model?.limits.storyboardPanels,
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
  onStarted,
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
  /** The run was accepted (SPEC-039 R-44): the workspace opens the editor and Arke assembles the scene. */
  onStarted?: () => void;
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
      {...(onStarted === undefined ? {} : { onStarted })}
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
  onStarted,
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
  const allModels = state?.app.manifest?.models ?? [];
  const usable = usableModels(state, "image");
  const aspectDefault = remembered === undefined && resolved.stranded === null && resolved.model !== null && !aspectSupport(resolved.model, aspect).ok
    ? usable.find((candidate) => aspectSupport(candidate, aspect).ok) ?? null
    : null;
  const [modelId, setModelId] = useState(remembered ?? aspectDefault?.id ?? resolved.model?.id ?? "");
  const knownModel = allModels.find((candidate) => candidate.id === modelId && candidate.capability === "image") ?? null;
  const models = knownModel !== null && !usable.some((candidate) => candidate.id === knownModel.id)
    ? [knownModel, ...usable]
    : usable;
  const modelChoices: Array<{ id: string; model: ManifestModel | null }> = modelId.length > 0 && knownModel === null
    ? [{ id: modelId, model: null }, ...usable.map((model) => ({ id: model.id, model }))]
    : models.map((model) => ({ id: model.id, model }));
  const unavailable = knownModel !== null && !usable.some((candidate) => candidate.id === knownModel.id);
  const included = scope === "all" ? shots : missing;
  // Turn 105's strips (issue 537): a cited prop with no state, or a state with no accepted image,
  // sends the description alone — said before spend and acknowledged, never inferred around.
  const propIssues = world.props.length === 0
    ? []
    : included.flatMap((shot) =>
        resolvePropStates(shot, world.props).flatMap((entry) =>
          entry.stateId === null
            ? [{ key: `${shot.id}:${entry.propId}`, label: "UNRESOLVED", text: `no state chosen for ${entry.propName} in shot ${shot.number} · sending description only` }]
            : entry.referenceFile === null
              ? [{ key: `${shot.id}:${entry.propId}`, label: "NO REFERENCE", text: `${entry.propName} · ${entry.stateName} has no accepted image in shot ${shot.number} · sending description only` }]
              : [],
        ),
      );
  const [propsAcknowledged, setPropsAcknowledged] = useState(false);
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
    quote.estimatedMicroUsd !== null &&
    (propIssues.length === 0 || propsAcknowledged);
  const blockedReason = matchingOptions ? quote.blockedReason : deliveryReason;
  const aspectVerdict = knownModel === null ? null : aspectSupport(knownModel, aspect);
  const compatibleAlternative = aspectVerdict?.ok === false
    ? usable.find((candidate) => candidate.id !== modelId && aspectSupport(candidate, aspect).ok) ?? null
    : null;
  const alternativeName = compatibleAlternative === null
    ? null
    : usable.some((candidate) => candidate.id !== compatibleAlternative.id && candidate.displayName === compatibleAlternative.displayName)
      ? `${compatibleAlternative.displayName} via ${PROVIDERS[compatibleAlternative.provider].displayName}`
      : compatibleAlternative.displayName;
  const displayedBlockedReason = blockedReason !== null && aspectVerdict?.ok === false && blockedReason.includes("cannot deliver")
    ? `${blockedReason}. ${alternativeName === null
      ? `No available image model supports ${aspect}; turn one on in Providers.`
      : `Choose ${alternativeName}, which supports ${aspect}.`}`
    : blockedReason;
  const references = matchingOptions ? quoteReferences(quote, scene, world) : [];
  // R-16's second layer: a scope that resolves to nothing swaps the primary for the sentence
  // naming the fix. Only the all-framed case has a fix to name — a scene with no shots keeps
  // the backend's refusal, because switching scope would not change anything there.
  const emptyScope = shotId === undefined && scope === "missing" && missing.length === 0 && shots.length > 0;
  const displayedCount = matchingOptions && quote.blockedReason === null ? quote.includedCount : included.length;

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
        onStarted?.();
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
          <h2 id={titleId}>Generate {displayedCount} frame{displayedCount === 1 ? "" : "s"}</h2>
          <span className="fy-swgen__scene">scene {scene.number}</span>
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
                <span>{candidate === "per-shot" ? "Fastest, cheap to retry, but characters and light drift between shots." : "Holds cast, light and grade together — a retry redoes the whole board."}</span>
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
                {candidate === "missing" ? "Shots without a frame" : "Every shot in the scene"}
              </button>
            ))}
          </div>
        </section> : null}

        <section className="fy-swgen__section">
          <h3>Model</h3>
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
                  title={candidate !== null && candidateUnavailable ? strandReason(state, candidate) : undefined}
                  onKeyDown={(event) => moveRadio(event, (at) => setModelId(modelChoices[at]!.id))}
                  onClick={() => setModelId(choice.id)}
                >
                  {candidate?.displayName ?? choice.id}{candidateUnavailable ? " · unavailable" : ""}
                  <span>{candidate === null
                    ? "not in the catalogue"
                    : `${output!.width}×${output!.height} · ${candidate.accepts.referenceImages} ref${candidate.accepts.referenceImages === 1 ? "" : "s"}`}</span>
                </button>
              );
            })}
          </div>
          {unavailable ? <p className="fy-swgen__hint">This production still names {knownModel!.displayName}; it has not been replaced by another model.</p> : null}
        </section>

        {references.length === 0 ? null : (
          <section className="fy-swgen__section">
            <h3>References</h3>
            <div className="fy-swgen__references">
              {references.map((reference) => (
                <article key={reference.sheet.id} data-riding={reference.ridingSteps > 0 ? "true" : "false"}>
                  <span className="fy-swgen__reference-image">
                    <Portrait worldSlug={world.meta.slug} path={reference.path} label="" radius={5} />
                  </span>
                  <span className="fy-swgen__reference-copy">
                    <strong>{reference.sheet.name}</strong>
                    <span>{reference.ridingSteps === reference.citedSteps
                      ? "rides"
                      : reference.ridingSteps === 0
                        ? "citation only"
                        : `rides in ${reference.ridingSteps} of ${reference.citedSteps}`}</span>
                  </span>
                </article>
              ))}
            </div>
          </section>
        )}

        {propIssues.length === 0 ? null : (
          <section className="fy-swgen__section" data-testid="prop-strips">
            <h3>Props</h3>
            {propIssues.map((issue) => (
              <p key={issue.key} className="fy-swgen__guard" role="status">
                <strong>{issue.label}</strong> · {issue.text}
              </p>
            ))}
            <label className="fy-swgen__hint">
              <input
                type="checkbox"
                checked={propsAcknowledged}
                onChange={(e) => setPropsAcknowledged(e.target.checked)}
              />{" "}
              Send these on the description alone
            </label>
          </section>
        )}

        <footer className="fy-swgen__foot">
          <span className="fy-swgen__context" aria-label="Inherited scene context">
            applies the scene context · {contextValues(scene, world, aspect).join(", ")}
          </span>
          {emptyScope ? (
            <div className="fy-swgen__actions">
              <span className="fy-swgen__empty">
                Every shot already has a frame. Switch to <button type="button" onClick={() => setScope("all")}>every shot in the scene</button> to re-render.
              </span>
              <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
            </div>
          ) : (
            <div className="fy-swgen__actions">
              <span className="fy-swgen__estimate">
                {startPending !== null
                  ? "Starting frame run..."
                  : matchingOptions
                    ? `${displayedCount} frame${displayedCount === 1 ? "" : "s"}${quote.estimatedMicroUsd === null ? "" : ` · ${formatMicroUsd(quote.estimatedMicroUsd)}`}`
                    : quotePending
                      ? "Checking current price..."
                      : "Quote unavailable"}
              </span>
              <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              {startReason === null ? null : <p className="fy-swgen__guard" role="status">{startReason}</p>}
              {displayedBlockedReason !== null && startPending === null ? <p className="fy-swgen__guard" role="status">{displayedBlockedReason}</p> : <Button variant="primary" size="sm" disabled={!canStart || startPending !== null} onClick={start}>{startPending === null ? "Generate frames" : "Starting..."}</Button>}
            </div>
          )}
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
      <div className="fy-swgen__packing-head">
        <h3>Packing</h3>
        {pack.ok ? <span>{shots.length} shot{shots.length === 1 ? "" : "s"} → {pack.boards.length} board{pack.boards.length === 1 ? "" : "s"}</span> : null}
        <span>{cap.seconds}s clip limit</span>
      </div>
      {!pack.ok ? <p className="fy-swgen__guard">{pack.reason}</p> : (
        <>
          <div className="fy-swgen__boards">
            {pack.boards.map((board) => {
              // Sums of shot durations are binary floats, so the labels are fixed to one
              // decimal or a 16.5s board can print as 16.499999999s.
              const headroom = cap.seconds - board.durationSec;
              const first = numberById.get(board.memberShotIds[0]!);
              const last = numberById.get(board.memberShotIds.at(-1)!);
              return (
                <article key={board.letter}>
                  <div className="fy-swgen__board-head">
                    <strong>Board {board.letter}</strong>
                    <span>{board.memberShotIds.length > 1 ? `shots ${first}–${last}` : `shot ${first}`}</span>
                    <span>{board.durationSec.toFixed(1)}s / {cap.seconds}s</span>
                  </div>
                  {board.notes.length === 0 ? null : (
                    <div className="fy-swgen__board-notes">
                      {board.notes.map((note, index) => <span key={`${note.text}:${index}`} data-kind={note.kind}>{note.text}</span>)}
                    </div>
                  )}
                  <div className="fy-swgen__board-foot">
                    {board.reason === null ? null : <span>split · {board.reason}</span>}
                    <span data-tight={headroom < 2 ? "true" : undefined}>{headroom.toFixed(1)}s spare</span>
                  </div>
                </article>
              );
            })}
          </div>
          <p className="fy-swgen__hint">Boards break at the clip limit and wherever continuity breaks. Frames are sliced back onto the shots; the board is kept as the source for retries.</p>
        </>
      )}
    </section>
  );
}

/** The same values the header's context chips carry, in the same order. */
function contextValues(scene: SceneRecord, world: WorldBundle, aspect: string): string[] {
  const location = scene.inherits?.location === undefined
    ? null
    : world.sheets.find((sheet) => sheet.id === scene.inherits?.location)?.name ?? scene.inherits.location;
  return [location, scene.inherits?.timeOfDay ?? null, scene.inherits?.tone ?? null, aspect]
    .filter((value): value is string => value !== null);
}

function quoteReferences(quote: FrameRunQuote, scene: SceneRecord, world: WorldBundle) {
  const shotById = new Map(orderedShots(scene).map((shot) => [shot.id, shot]));
  const sheetById = new Map(world.sheets.map((sheet) => [sheet.id, sheet]));
  const summary = new Map<string, {
    sheet: WorldBundle["sheets"][number];
    path: string | null;
    citedSteps: number;
    ridingSteps: number;
  }>();
  for (const step of quote.steps) {
    const cited = new Set<string>();
    if (scene.inherits?.location !== undefined) cited.add(scene.inherits.location);
    for (const shotId of step.requestShotIds) {
      const shot = shotById.get(shotId);
      if (shot === undefined) continue;
      for (const entry of resolveCast(shot.description, world.sheets).cast) cited.add(entry.sheet.id);
    }
    for (const reference of step.references) cited.add(reference.sheetId);
    for (const sheetId of cited) {
      const sheet = sheetById.get(sheetId);
      if (sheet === undefined) continue;
      const riding = step.references.find((reference) => reference.sheetId === sheetId);
      const previous = summary.get(sheetId);
      summary.set(sheetId, {
        sheet,
        path: previous?.path ?? riding?.path ?? null,
        citedSteps: (previous?.citedSteps ?? 0) + 1,
        ridingSteps: (previous?.ridingSteps ?? 0) + (riding === undefined ? 0 : 1),
      });
    }
  }
  return [...summary.values()].map((entry) => ({
    ...entry,
    path: entry.path ?? (entry.sheet.type === "location"
      ? locationPortraitPath(world, entry.sheet.id)
      : characterPortraitPath(world, entry.sheet.id)),
  }));
}

export function FrameRunBar({ run, worldId, productionId, onReview }: { run: FrameRunState; worldId: string; productionId: string; onReview?: () => void }) {
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
        <span className="fy-swrun__done">{run.filedShots} frame{run.filedShots === 1 ? "" : "s"} added{run.failedShots > 0 ? ` · ${run.failedShots} failed` : ""}{run.supersededShots > 0 ? ` · ${run.supersededShots} overtaken` : ""}</span>
        {onReview === undefined ? null : <button type="button" className="fy-swrun__review" data-primary="true" onClick={onReview}>Review</button>}
        <button type="button" className="fy-swrun__dismiss" aria-label="Dismiss frame run" onClick={() => control("frame-run-dismiss")}><X size={11} /></button>
      </div>
    );
  }
  // Cancel returns the row to idle at once. The workspace dismisses a cancelled record itself
  // and never mounts the bar for one, so there is no cancelled state to draw here.
  if (run.status === "cancelled") return null;
  const pct = total === 0 ? 0 : Math.round((settled / total) * 100);
  return (
    <div className="fy-swrun" data-testid="frame-run-bar" role="status">
      <span
        className="fy-swrun__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={settled}
        aria-label={`${settled} of ${total} frames`}
      >
        <span style={{ width: `${pct}%` }} />
      </span>
      <strong>{run.status === "paused" ? `paused${finishing > 0 ? ` · finishing ${finishing}` : ""}` : currentLabel ?? "Preparing frames"}</strong>
      <span className="fy-swrun__count">{settled} of {total} frames</span>
      {run.etaSec === null ? null : <span className="fy-swrun__eta">~{Math.ceil(run.etaSec)}s left</span>}
      {run.status === "paused"
        ? <button type="button" data-primary="true" onClick={() => control("frame-run-resume")}>Resume</button>
        : <button type="button" onClick={() => control("frame-run-pause")}>Pause</button>}
      <button type="button" onClick={() => control("frame-run-cancel")}>Cancel</button>
    </div>
  );
}

export function FrameRunBoardFailures({
  run,
  jobs,
  worldId,
  productionId,
}: {
  run: FrameRunState;
  jobs: readonly Job[];
  worldId: string;
  productionId: string;
}) {
  if (run.run.mode !== "board") return null;
  const failures = run.steps.flatMap((state, index) => {
    const step = run.run.steps[index]!;
    return state.status === "failed" && step.grain !== "cell-retry" ? [{ state, step, index }] : [];
  });
  if (failures.length === 0) return null;
  return (
    <div className="fy-swrunboards" aria-label="Frame run board failures">
      {failures.map(({ state, step, index }) => {
        const retryJobId = finalizationRetryJobId(run, index, jobs);
        return (
          <div key={index} className="fy-swboard__failure" role="status">
            <strong>{step.label}</strong><span>{runFailureCopy(state)}</span>
            {retryJobId !== null ? (
              <button type="button" onClick={() => retryJobFinalization(retryJobId)}>Retry finalization</button>
            ) : state.canRetry ? (
              <button type="button" onClick={() => frameRunCommand({ kind: "frame-run-retry-step", worldId, productionId, runId: run.run.id, stepIndex: index })}>Retry board</button>
            ) : null}
          </div>
        );
      })}
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

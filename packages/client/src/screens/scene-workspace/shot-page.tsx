import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import {
  DEFAULT_SHOT_SEC,
  legacySceneView,
  orderedShots,
  productionAspect,
  resolvedShotStaging,
  shotCardState,
  shotCoverage,
  stagingMotionWord,
  type ArtifactSidecar,
  type FrameRunState,
  type ProductionBundle,
  type SceneRecord,
  type Shot,
  type WorldBundle,
  type WorldChatSubject,
} from "@arke-studio/contracts";
import { productionModel, resolveModel } from "../../components/dispatch-bar.js";
import { ProductionConversation } from "../../components/conversation.js";
import { EmptyState, Screen } from "../../components/layout.js";
import { Button } from "../../components/ui.js";
import { ChevronLeft, ChevronRight, ImageMark, Maximize2, More, Pencil, Pin } from "../../components/icons.js";
import { mediaUrl } from "../../lib/media.js";
import { acceptTake, clearShotFrame, frameRunCommand, importShotFrame, sendBenchOpenSubject, subscribeBenchSubjectOpened, useClientState, useStore } from "../../lib/store.js";
import { acceptedTakeId, takesForShot, useProduction } from "../../lib/selectors.js";
import { useBlockDigests } from "../storyboard.js";
import { shotFramePath } from "./boards.js";
import { CharacterDialog } from "./character-dialog.js";
import { FrameActions } from "./frame-actions.js";
import { frameRunShotState, GenerateFramesDialog } from "./frame-run.js";
import { ShotLightbox } from "./lightbox.js";
import { useSceneWriter } from "./scene-writer.js";
import { SelectionProvider, type WorkspaceSubject } from "./selection.js";
import { ShotFields } from "./shot-fields.js";
import { SceneStage } from "./stage.js";

function canPickFiles(): boolean {
  return typeof window !== "undefined" && typeof (window as { arke?: { pickFrameFile?: unknown } }).arke?.pickFrameFile === "function";
}

/**
 * The shot as a page (design turn 145, SPEC-036 as amended): the route 97's Advanced sheet used,
 * now the one home of everything the row does not hold. The scene lists its shots; a shot is
 * opened here, never unfolded in the list.
 */
export function ShotPage() {
  const { worldId, prodId, sceneId, shotId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const record = production?.scenes.find((candidate) => candidate.id === sceneId);
  if (world && production && record && shotId !== undefined) {
    // A shot that has gone — deleted from the list, or an address that never named one — lands
    // on its scene rather than on a page about nothing.
    if (!orderedShots(record).some((shot) => shot.id === shotId)) {
      return <Navigate to={`/w/${world.meta.worldId}/p/${production.meta.id}/scenes/${record.id}`} replace />;
    }
    return <ShotWorkspace key={`${world.meta.worldId}/${production.meta.id}/${record.id}/${shotId}`} world={world} production={production} scene={record} shotId={shotId} />;
  }
  return (
    <Screen id="shot">
      <EmptyState title="Opening the shot…" />
    </Screen>
  );
}

function ShotWorkspace({
  world,
  production,
  scene,
  shotId,
}: {
  world: WorldBundle;
  production: ProductionBundle;
  scene: SceneRecord;
  shotId: string;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useClientState();
  const connection = useStore().connection;
  const digests = useBlockDigests(legacySceneView(scene));
  const writer = useSceneWriter(world, production, scene);
  const { workingScene, staged, write, locked, commandPending, refusalVersion, sceneFile } = writer;
  const shots = orderedShots(workingScene);
  const index = Math.max(0, shots.findIndex((candidate) => candidate.id === shotId));
  const shot: Shot = shots[index] ?? orderedShots(scene).find((candidate) => candidate.id === shotId)!;
  const previous = index > 0 ? shots[index - 1] ?? null : null;
  const next = shots[index + 1] ?? null;
  const artifacts: readonly ArtifactSidecar[] = world.artifacts;
  const aspect = productionAspect(production.meta);
  const slug = world.meta.slug;
  const scenePath = `/w/${world.meta.worldId}/p/${production.meta.id}/scenes/${scene.id}`;
  // The view rides in the address, so a filmstrip press keeps it and a link can open the Stage
  // of a shot directly; it is still not a setting.
  const view: "shot" | "stage" = searchParams.get("view") === "stage" ? "stage" : "shot";
  const setView = (target: "shot" | "stage") => {
    const params = new URLSearchParams(searchParams);
    if (target === "stage") params.set("view", "stage");
    else params.delete("view");
    setSearchParams(params, { replace: true });
  };
  const shotPath = (target: string, targetView: "shot" | "stage" = view) => `${scenePath}/shots/${target}${targetView === "stage" ? "?view=stage" : ""}`;
  const goTo = (target: string) => navigate(shotPath(target));

  // Full screen (SPEC-044 R-37, R-38): session state, never written. The Stage stays where it
  // is in the tree and the page around it steps aside by CSS, so its draft survives the move.
  const [full, setFull] = useState(false);
  const fullscreen = full && view === "stage";
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.querySelector("dialog[open]") === null) setFull(false);
    };
    document.addEventListener("keydown", onKey);
    const chrome = [...document.querySelectorAll(".fy-prodrail, .fy-titlebar")];
    for (const element of chrome) element.setAttribute("inert", "");
    return () => {
      document.removeEventListener("keydown", onKey);
      for (const element of chrome) element.removeAttribute("inert");
    };
  }, [fullscreen]);

  // The one selection the Stage reads (R-25): on this page it is the shot the address names, and
  // choosing another is a navigation rather than a state.
  const selection = useMemo(
    () => ({
      subject: { kind: "shot", shotId } as WorkspaceSubject,
      select: (subject: WorkspaceSubject) => {
        if (subject.kind === "shot" && subject.shotId !== shotId) void navigate(shotPath(subject.shotId));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shotId, view, scenePath],
  );

  const [dock, setDock] = useState(true);
  const [lightbox, setLightbox] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [openMember, setOpenMember] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(shot.title);
  const [generatorPending, setGeneratorPending] = useState(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  const generateReturnFocus = useRef<HTMLElement>(null);
  const doorFocus = useRef<HTMLElement | null>(null);
  const variantsTrigger = useRef<HTMLButtonElement | null>(null);
  const variantsDialog = useRef<HTMLDialogElement | null>(null);
  const titleTrigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const pendingGenerator = useRef<{ requestId: string; key: string } | null>(null);
  const pageKey = `${world.meta.worldId}/${production.meta.id}/${scene.id}/${shotId}`;
  const currentKey = useRef(pageKey);
  currentKey.current = pageKey;
  useEffect(() => { setTitleDraft(shot.title); }, [shot.title, refusalVersion]);
  useEffect(() => {
    if (openMember === null) doorFocus.current?.focus();
  }, [openMember]);

  // The frame: the same resolution the row uses, so the page never disagrees with the list.
  const frame = shotFramePath(production, artifacts, shot.id);
  const src = slug === undefined || frame.path === null ? null : mediaUrl(slug, frame.path);
  const takes = takesForShot(production, shot.id);
  const frameVariants = takes.filter((take) => (take.kind === "frame" || take.kind === "still") && take.media !== undefined);
  const durationSec = shot.durationSec ?? DEFAULT_SHOT_SEC;
  const resolvedModel = resolveModel(state, "video", undefined, productionModel(state, production.meta.id, "video"));
  const videoModel = resolvedModel.stranded ?? resolvedModel.model;
  const sceneRuns = [...(state?.frameRuns ?? [])]
    .filter((candidate) => candidate.worldId === world.meta.worldId && candidate.productionId === production.meta.id && candidate.run.sceneId === scene.id && candidate.run.dismissed !== true)
    .sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt));
  const frameRun: FrameRunState | null = sceneRuns.find((candidate) => candidate.status === "active" || candidate.status === "paused")
    ?? sceneRuns.find((candidate) => candidate.status === "completed")
    ?? null;
  const runState = frameRunShotState(frameRun, shot.id);
  const coverage = shotCoverage(shot, digests);
  const accepted = acceptedTakeId(production, shot.id);
  const cardState = shotCardState({
    blankScript: shot.description.trim() === "",
    clipAccepted: accepted !== null && takes.find((take) => take.id === accepted)?.kind === "clip",
    hasFrame: frame.hasFrame,
    coverage,
  });
  // The state word on the view row (138's exceptions, said once): what is happening to the frame,
  // else what the shot has — the row's own ladder, in words.
  const stateWord = runState !== null && (runState.status === "queued" || runState.status === "submitting" || runState.status === "running" || runState.status === "not-enqueued")
    ? { word: "Generating…", tone: "pending" }
    : runState?.status === "failed"
      ? { word: "Failed", tone: "failed" }
      : cardState === "needs attention"
        ? { word: "Needs attention", tone: "empty" }
        : cardState === "rendered"
          ? { word: "Clip accepted", tone: "ready" }
          : cardState === "story"
            ? { word: "Needs frame", tone: "empty" }
            : coverage === "changed"
              ? { word: "Script changed", tone: "stale" }
              : { word: "Frame ready", tone: "ready" };
  const staging = shot.staging === undefined ? null : resolvedShotStaging(workingScene, shot.staging);
  const stagingWord = staging === null ? "Not staged" : `v${shot.staging!.version} · ${staging.keys.length} key${staging.keys.length === 1 ? "" : "s"} · ${stagingMotionWord(staging, durationSec)}`;

  useEffect(() => {
    frameRunCommand({ kind: "frame-run-list", worldId: world.meta.worldId, productionId: production.meta.id });
  }, [world.meta.worldId, production.meta.id]);
  useEffect(
    () =>
      subscribeBenchSubjectOpened((event) => {
        const pending = pendingGenerator.current;
        if (pending === null || pending.key !== currentKey.current || event.worldId !== world.meta.worldId || event.requestId !== pending.requestId) return;
        pendingGenerator.current = null;
        setGeneratorPending(false);
        if (event.sessionId === null) {
          setGeneratorError(event.reason ?? "The generator session could not be prepared.");
          return;
        }
        setGeneratorError(null);
        void navigate(`/w/${world.meta.worldId}/artifacts/bench/${event.sessionId}`);
      }),
    [navigate, world.meta.worldId],
  );
  useEffect(() => {
    if (connection === "open" || pendingGenerator.current === null) return;
    pendingGenerator.current = null;
    setGeneratorPending(false);
    setGeneratorError("Connection lost - try again.");
  }, [connection]);
  const openGenerator = (mode?: "image" | "video") => {
    if (pendingGenerator.current !== null) return;
    const requestId = sendBenchOpenSubject({
      worldId: world.meta.worldId,
      productionId: production.meta.id,
      sceneId: scene.id,
      subject: { kind: "shot", shotId: shot.id },
      ...(mode === undefined ? {} : { mode }),
    });
    if (requestId !== null) {
      pendingGenerator.current = { requestId, key: pageKey };
      setGeneratorPending(true);
      setGeneratorError(null);
    } else {
      setGeneratorError("Not connected - try again.");
    }
  };
  // Arke can build a blockout or file a playblast for a shot from the production's chat; the
  // request names the shot, and this page goes to that shot's Stage to carry it out.
  const constructionRequest = state?.stageConstructionRequests?.find((request) => request.worldId === world.meta.worldId && request.productionId === production.meta.id && request.sceneId === scene.id);
  const playblastRequest = state?.stagePlayblastRequests?.find((request) => request.worldId === world.meta.worldId && request.productionId === production.meta.id && request.sceneId === scene.id);
  const requestedShot = constructionRequest?.shotId ?? playblastRequest?.shotId;
  const requestedAction = constructionRequest?.actionId ?? playblastRequest?.actionId;
  useEffect(() => {
    if (requestedShot === undefined) return;
    if (requestedShot !== shot.id) void navigate(shotPath(requestedShot, "stage"));
    else if (view !== "stage") setView("stage");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedAction, requestedShot]);

  const disabled = locked;
  const commitTitle = (value: string) => {
    const title = value.trim();
    if (title === "" || title === shot.title || disabled || !write({ kind: "edit-shot", shotId: shot.id, change: { title } })) setTitleDraft(shot.title);
    setEditingTitle(false);
  };
  const conversationSubject: WorldChatSubject = { kind: "shot", sceneId: scene.id, shotId: shot.id as never };
  const shotLabel = (target: string) => {
    const named = shots.find((candidate) => candidate.id === target);
    return named === undefined ? target : `shot ${named.number}`;
  };
  const episode = production.episodes.find((candidate) => candidate.scenes.includes(scene.id));

  return (
    <SelectionProvider value={selection}>
      <div className="fy-sw" data-screen="shot-page" data-testid="shot-page" data-dock={dock ? "true" : "false"} data-full={fullscreen ? "true" : undefined} style={{ "--shot-aspect": aspect.replace(":", " / ") } as CSSProperties}>
        <main className="fy-sw__centre">
          {fullscreen ? (
            <div className="fy-sw__fullpill">
              {production.meta.title} · {episode === undefined ? "" : `episode ${episode.order} · `}scene {scene.number} · shot {shot.number}
              <i aria-hidden="true" />
              <b>Stage</b>
            </div>
          ) : null}
          <header className="fy-sw__head">
            <p className="fy-sw__breadcrumb">
              {production.meta.title}
              {episode === undefined ? "" : ` · episode ${episode.order} · ${episode.title}`}
              {" · "}
              <button type="button" className="fy-shot__crumb" onClick={() => navigate(`${scenePath}?shot=${shot.id}`)}>Scene {scene.number} · {scene.title}</button>
            </p>
            <div className="fy-sw__headline">
              <h1 className="fy-sw__title fy-shot__title">
                {editingTitle ? <span>Shot {shot.number} ·</span> : null}
                {editingTitle ? (
                  <input
                    className="fy-shot__title-input"
                    aria-label={`Title for shot ${shot.number}`}
                    value={titleDraft}
                    disabled={disabled}
                    autoFocus
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== "Escape") return;
                      event.preventDefault();
                      if (event.key === "Escape") { setTitleDraft(shot.title); setEditingTitle(false); }
                      else commitTitle(event.currentTarget.value);
                      requestAnimationFrame(() => titleTrigger.current?.focus());
                    }}
                    onBlur={(event) => commitTitle(event.currentTarget.value)}
                  />
                ) : (
                  <>
                    <span className="fy-shot__title-text">Shot {shot.number} · {shot.title}</span>
                    <button ref={titleTrigger} type="button" className="fy-shot__pencil" aria-label={`Edit title for shot ${shot.number}`} title="Rename" disabled={disabled} onClick={() => setEditingTitle(true)}>
                      <Pencil size={16} />
                    </button>
                  </>
                )}
              </h1>
              <div className="fy-sw__actions">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={disabled || frameRun?.status === "active" || frameRun?.status === "paused"}
                  onClick={(event) => {
                    generateReturnFocus.current = event.currentTarget;
                    setGenerating(true);
                  }}
                >
                  {frame.hasFrame ? "Regenerate" : "Generate frame"}
                </Button>
                <details
                  ref={menu}
                  className="fy-shot__menu"
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || event.defaultPrevented) return;
                    event.currentTarget.open = false;
                    event.currentTarget.querySelector("summary")?.focus();
                  }}
                  onBlur={(event) => {
                    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                    event.currentTarget.open = false;
                  }}
                >
                  <summary aria-label={`Actions for shot ${shot.number}`} title="More"><More size={16} /></summary>
                  <div className="fy-shot__menupanel" role="menu">
                    <button type="button" role="menuitem" disabled={disabled || generatorPending} onClick={() => { menu.current?.removeAttribute("open"); openGenerator(); }}>
                      {generatorPending ? "Opening…" : "Open in generator"}
                    </button>
                    <button type="button" role="menuitem" onClick={() => navigate(`${scenePath}?shot=${shot.id}&view=preview`)}>Play from here</button>
                    <button type="button" role="menuitem" disabled={disabled} onClick={() => { menu.current?.removeAttribute("open"); write({ kind: "duplicate-shot", shotId: shot.id }); }}>Duplicate</button>
                    <button type="button" role="menuitem" className="fy-shot__danger" disabled={disabled} onClick={() => { menu.current?.removeAttribute("open"); setConfirmDelete(true); }}>Delete</button>
                  </div>
                </details>
              </div>
            </div>
            {generatorError === null ? null : <p role="alert" className="fy-swboards__refusal">{generatorError}</p>}
            <Filmstrip
              shots={shots}
              current={shot.id}
              production={production}
              artifacts={artifacts}
              slug={slug}
              previous={previous}
              next={next}
              onOpen={goTo}
            />
          </header>

          <div className="fy-sw__toolbar">
            <div className="fy-sw__tabs" role="radiogroup" aria-label="View">
              {(["shot", "stage"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={view === candidate}
                  className="fy-sw__tab"
                  data-on={view === candidate ? "true" : undefined}
                  onClick={() => setView(candidate)}
                >
                  {candidate === "shot" ? "Shot" : "Stage"}
                </button>
              ))}
            </div>
            <span className="fy-sw__spacer" />
            {view === "shot" ? (
              <span className="fy-shot__state" data-tone={stateWord.tone} role="status">
                <span aria-hidden="true" />{stateWord.word}
              </span>
            ) : (
              <>
                <span className="fy-shot__staging" role="status">{stagingWord}</span>
                <button type="button" className="fy-sw__full" title="Full screen" aria-label="Full screen" onClick={() => setFull(true)}>
                  <Maximize2 size={14} />
                </button>
              </>
            )}
          </div>

          {view === "shot" ? (
            <div className="fy-shot__body">
              <div className="fy-shot__framecol">
                <div className="fy-shot__frame fy-imghost" data-empty={src === null ? "true" : undefined}>
                  {src === null ? (
                    <div className="fy-shot__hatch"><ImageMark size={24} /></div>
                  ) : (
                    <img className="fy-shot__img" alt={shot.title} src={src} draggable={false} />
                  )}
                  <span className="fy-shot__label">{shot.number}</span>
                  <span className="fy-shot__chipmeta">{durationSec}s</span>
                  <FrameActions
                    shotNumber={shot.number}
                    title={shot.title}
                    slug={slug}
                    framePath={frame.path}
                    variants={frameVariants.length}
                    disabled={disabled}
                    canUpload={canPickFiles()}
                    canClear={frame.pointer}
                    onPreview={() => setLightbox(true)}
                    onVariants={(trigger) => { variantsTrigger.current = trigger; variantsDialog.current?.showModal(); }}
                    onUpload={() => importShotFrame(world.meta.worldId, production.meta.id, shot.id)}
                    onClear={() => clearShotFrame(world.meta.worldId, production.meta.id, shot.id)}
                    readAloud={{ source: { of: "shot", productionId: production.meta.id, sceneId: scene.id, shotId: shot.id }, title: `Shot ${shot.number} · script`, text: shot.description }}
                  />
                  <dialog
                    ref={variantsDialog}
                    className="fy-swvariants"
                    aria-label={`Frame variants for shot ${shot.number}`}
                    onClose={() => variantsTrigger.current?.focus()}
                    onClick={(event) => { if (event.target === event.currentTarget) variantsDialog.current?.close(); }}
                  >
                    <div className="fy-swvariants__panel">
                      <header>
                        <div>
                          <span>Shot {shot.number} · frame history</span>
                          <h2>{shot.title}</h2>
                        </div>
                        <button type="button" aria-label="Close frame variants" onClick={() => variantsDialog.current?.close()}>Close</button>
                      </header>
                      <div className="fy-swvariants__grid">
                        {frameVariants.map((take) => {
                          const path = `productions/${production.meta.id}/takes/${take.id}/${take.media!}`;
                          const current = production.selections[shot.id]?.startFrameTakeId === take.id || frame.artifact?.links.includes(take.id) === true;
                          return (
                            <article key={take.id} data-current={current ? "true" : undefined}>
                              <img src={slug === undefined ? undefined : mediaUrl(slug, path)} alt={`Variant for shot ${shot.number}`} style={{ aspectRatio: aspect.replace(":", " / ") }} />
                              <div>
                                <span>{take.model}</span>
                                <button type="button" disabled={current || disabled} onClick={() => { acceptTake(world.meta.worldId, production.meta.id, take.id, shot.id); variantsDialog.current?.close(); }}>
                                  {current ? "Current" : "Use frame"}
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  </dialog>
                </div>
              </div>
              <div className="fy-shot__column">
                <ShotFields
                  world={world}
                  production={production}
                  scene={workingScene}
                  shot={shot}
                  previous={previous}
                  digests={digests}
                  locked={disabled}
                  refusalVersion={refusalVersion}
                  onCommand={write}
                  onOpenCharacter={(sheetId, trigger) => { doorFocus.current = trigger; setOpenMember(sheetId); }}
                />
              </div>
            </div>
          ) : (
            <SceneStage
              head={false}
              fullscreen={fullscreen ? { leave: () => setFull(false) } : null}
              scene={workingScene}
              production={production}
              world={world}
              aspect={aspect}
              sceneFile={sceneFile}
              locked={disabled}
              generatorPending={generatorPending}
              refusalVersion={refusalVersion}
              onCommand={write}
              onRenderShot={() => openGenerator("video")}
              {...(constructionRequest ? { constructionRequest } : {})}
              {...(playblastRequest ? { playblastRequest } : {})}
            />
          )}
          <footer className="fy-sw__footer">
            <span className="fy-sw__save" role="status" data-pending={commandPending || staged !== undefined || connection !== "open" || undefined}>
              <span aria-hidden="true" />{connection !== "open" ? "Disconnected" : commandPending ? "Saving…" : staged !== undefined ? "Changes awaiting review" : `Connected · v${scene.version}`}
            </span>
            <button type="button" className="fy-sw__back" onClick={() => navigate(`${scenePath}?shot=${shot.id}`)}>Back to scene <span aria-hidden="true">→</span></button>
          </footer>
        </main>

        {dock ? (
          <ProductionConversation
            worldId={world.meta.worldId}
            productionId={production.meta.id}
            entry={{ kind: "scene", productionId: production.meta.id, sceneId: scene.id }}
            subject={conversationSubject}
            dock={{
              title: `Arke · Shot ${shot.number}`,
              subject: `${shot.title} · v${scene.version}`,
              conversationFirst: true,
              ...(src === null ? {} : { thumbnail: { src, alt: `Frame for shot ${shot.number}` } }),
              onPutAway: () => setDock(false),
              prompts: [`Tighten shot ${shot.number}`, `What does shot ${shot.number} need?`],
              shotLabel,
              subjectPrefix: `About shot ${shot.number}:`,
            }}
            openingNote="opening…"
            emptyLine={`Nothing written with Arke for shot ${shot.number} yet.`}
            placeholder={`Ask Arke about shot ${shot.number}…`}
            onSelectShot={goTo}
            pointsEmpty="Nothing understood yet. As you talk, what Arke takes from the shot appears here."
          />
        ) : (
          <button type="button" className="fy-sw__rail" title="Pin the assistant back" onClick={() => setDock(true)}>
            <span className="fy-sw__rail-dot" aria-hidden="true" />
            <span className="fy-sw__rail-label">Ask Arke</span>
            <span className="fy-sw__rail-pin"><Pin size={13} /></span>
          </button>
        )}
        <GenerateFramesDialog
          open={generating}
          state={state}
          world={world}
          production={production}
          scene={scene}
          aspect={aspect}
          videoModel={videoModel}
          shotId={shot.id}
          returnFocus={generateReturnFocus}
          onClose={() => setGenerating(false)}
          onStarted={() => navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/cut?assemble=${scene.id}`)}
        />
        <ShotLightbox
          scene={scene}
          production={production}
          artifacts={artifacts}
          worldSlug={slug}
          aspect={aspect}
          shotId={lightbox ? shot.id : null}
          onClose={() => setLightbox(false)}
          onSelectShot={(target) => { if (target !== shot.id) goTo(target); }}
          onEditShot={(target) => { setLightbox(false); if (target !== shot.id) goTo(target); }}
          onOpenInGenerator={() => openGenerator()}
        />
        {openMember === null ? null : (
          <CharacterDialog
            key={openMember}
            world={world}
            production={production}
            scene={scene}
            sheetId={openMember}
            locked={locked}
            onClose={() => setOpenMember(null)}
            onWrite={write}
          />
        )}
        {confirmDelete ? (
          <div className="fy-shot__confirm" role="alertdialog" aria-modal="true" aria-label={`Delete shot ${shot.number}?`}>
            <span>Delete shot {shot.number}?</span>
            <button
              type="button"
              autoFocus
              disabled={disabled}
              onClick={() => {
                if (write({ kind: "delete-shot", shotId: shot.id })) void navigate(scenePath);
                setConfirmDelete(false);
              }}
            >
              Delete
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        ) : null}
      </div>
    </SelectionProvider>
  );
}

/**
 * The scene's shots under the title (145b): the open one ringed, the ways to its neighbours at
 * the ends and on the arrow keys. It is the row's chevron seen from the other side, and the
 * Stage's stepper.
 */
function Filmstrip({
  shots,
  current,
  production,
  artifacts,
  slug,
  previous,
  next,
  onOpen,
}: {
  shots: readonly Shot[];
  current: string;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
  previous: Shot | null;
  next: Shot | null;
  onOpen: (shotId: string) => void;
}) {
  const at = shots.findIndex((shot) => shot.id === current) + 1;
  return (
    <nav
      className="fy-shot__strip"
      aria-label="Shots in this scene"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" && previous !== null) { event.preventDefault(); onOpen(previous.id); }
        if (event.key === "ArrowRight" && next !== null) { event.preventDefault(); onOpen(next.id); }
      }}
    >
      <button type="button" className="fy-shot__step" aria-label="Previous shot" disabled={previous === null} onClick={() => previous !== null && onOpen(previous.id)}>
        <ChevronLeft size={12} />
      </button>
      <ol className="fy-shot__thumbs">
        {shots.map((shot) => {
          const frame = shotFramePath(production, artifacts, shot.id);
          const src = slug === undefined || frame.path === null || !frame.hasFrame ? null : mediaUrl(slug, frame.path);
          return (
            <li key={shot.id}>
              <button
                type="button"
                className="fy-shot__thumb"
                data-empty={src === null ? "true" : undefined}
                aria-current={shot.id === current ? "true" : undefined}
                aria-label={`Shot ${shot.number} · ${shot.title}`}
                title={`Shot ${shot.number} · ${shot.title}`}
                onClick={() => onOpen(shot.id)}
              >
                {src === null ? <ImageMark size={14} /> : <img src={src} alt="" draggable={false} />}
                <span aria-hidden="true">{shot.number}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <button type="button" className="fy-shot__step" aria-label="Next shot" disabled={next === null} onClick={() => next !== null && onOpen(next.id)}>
        <ChevronRight size={12} />
      </button>
      <span className="fy-sw__spacer" />
      <span className="fy-shot__count">Shot {at} of {shots.length}</span>
    </nav>
  );
}

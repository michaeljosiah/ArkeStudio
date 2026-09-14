import { TakeDialogueFeedbackPanel } from "../components/take-dialogue-feedback.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import {
  frameDispatchFor,
  modelCapabilityCopy,
  productionAspect,
  productionShape,
  DELIVERIES,
  legacyVoiceModel,
  supportedDeliveries,
  type CompiledPass,
  type Delivery,
  type CharacterLook,
  type ProductionBundle,
  type Take,
  orderedShots,
  legacySceneView,
} from "@arke-studio/contracts";
import { DegradedBanner, EmptyState } from "../components/layout.js";
import { Button, cx } from "../components/ui.js";
import {
  PauseSolid,
  Play,
  Plus,
} from "../components/icons.js";
import { ProductionConversation } from "../components/conversation.js";
import { productionModel } from "../components/dispatch-bar.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { RemoteVoiceUploadConfirmation } from "../components/remote-voice-upload-confirmation.js";
import { mediaUrl } from "../lib/media.js";
import { seconds, usd } from "../lib/format.js";
import {
  acceptedTakeId,
  mediaTakeFor,
  takeDecisions,
  takesForShot,
  useProduction,
} from "../lib/selectors.js";
import { lookTileLabel } from "./character-reference.js";
import { isVideoMedia, posterNameFor } from "../lib/poster.js";
import { playbackSnapshot, togglePlayback } from "../lib/audio.js";
import {
  acceptTake,
  rejectTake,
  setProductionModel,
  useStore,
  requestVoiceLine,
  sendBenchOpenSubject,
  subscribeBenchSubjectOpened,
  subscribeQueueResults,
  subscribeVoiceUploadConfirmations,
} from "../lib/store.js";
import { decisionTone, EpisodePicker } from "./production-shell.js";
import { carriedSubjects } from "./production-cast.js";

/** A take's playable bytes and poster, resolved through a segment's backing pass when needed. */
export function takeMediaView(
  production: Pick<ProductionBundle, "meta" | "takes">,
  take: ProductionBundle["takes"][number],
): { sourcePath: string; posterPath: string; isVideo: boolean } | null {
  const mediaTake = mediaTakeFor(production, take);
  if (mediaTake === null) return null;
  const root = `productions/${production.meta.id}/takes/${mediaTake.id}`;
  return {
    sourcePath: `${root}/${mediaTake.media}`,
    posterPath: `${root}/${posterNameFor(mediaTake.media)}`,
    isVideo: isVideoMedia(mediaTake.media),
  };
}

/** A take's poster image, on the shared convention (lib/poster.ts). */
export function takeMediaPath(
  production: Pick<ProductionBundle, "meta" | "takes">,
  take: ProductionBundle["takes"][number],
): string | null {
  return takeMediaView(production, take)?.posterPath ?? null;
}

// ---- Cast (SPEC-020) -------------------------------------------------------

/**
 * The production's cast, in two bands: the guests it owns, and the world's cast it draws on.
 *
 * The bands are the whole point of the screen (R-9). Both sets of people are equally usable in a
 * shot — a guest is a full sheet, and resolution never asks who owns it (R-5) — so the only thing
 * separating them is what happens to them when this production ends. Naming that on the surface
 * is cheaper than discovering it later, when a one-off barman has quietly become part of the
 * world's permanent record.
 */
/**
 * The picker's labels, disambiguated only where they collide (codex round 2).
 *
 * A look's caption is the exploration's own words, and one exploration returns several results —
 * so accepting more than one from a batch gives looks whose `prompt` and `kind` are identical and
 * whose ids and files are not. The picker is text, unlike the gallery it came from, so those
 * arrived as several indistinguishable options over different images.
 *
 * Numbered in acceptance order, which is the order the kit stores them in, and only where a
 * caption is claimed more than once — a lone look carries no number to read.
 */
export function lookPickerLabels(looks: readonly CharacterLook[]): Map<string, string> {
  const caption = (look: CharacterLook): string => lookTileLabel(look.prompt, look.kind);
  const claims = new Map<string, number>();
  for (const look of looks) claims.set(caption(look), (claims.get(caption(look)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const look of looks) {
    const text = caption(look);
    if ((claims.get(text) ?? 0) < 2) {
      labels.set(look.id, text);
      continue;
    }
    const nth = (seen.get(text) ?? 0) + 1;
    seen.set(text, nth);
    labels.set(look.id, `${text} ${nth}`);
  }
  return labels;
}

/**
 * What choosing this option would take it away from (design 67, codex round 1).
 *
 * A look holds one `attachedTo`, so picking one that is already spoken for is a *move*: the
 * other production silently drops back to its identity package, or a scene loses its override.
 * The option says where it currently rides, so the move is visible at the point of choice — a
 * label rather than a confirmation, because the change is one field and reattaching undoes it.
 *
 * The look this production already holds says nothing: it is the selected option, and "here" is
 * not news.
 */
export function lookOptionScope(
  look: CharacterLook,
  production: ProductionBundle,
  productions: readonly ProductionBundle[],
): string | null {
  const scope = look.attachedTo;
  if (!scope) return null;
  if (scope.productionId === production.meta.id) {
    if (scope.kind === "production") return null;
    const scene = production.scenes.find((candidate) => candidate.id === scope.sceneId);
    return scene ? `Sc ${scene.number}` : null;
  }
  const owner = productions.find((candidate) => candidate.meta.id === scope.productionId);
  if (!owner) return null;
  if (scope.kind === "production") return `in ${owner.meta.title}`;
  const scene = owner.scenes.find((candidate) => candidate.id === scope.sceneId);
  // A scope whose scene is gone rides nowhere, so there is nothing here to warn about taking.
  return scene ? `in ${owner.meta.title} Sc ${scene.number}` : null;
}

// ---- Generate workspace (11b) ----------------------------------------------

type TakeEpisode = ProductionBundle["episodes"][number];
export type TakeEpisodeOption = Pick<TakeEpisode, "id" | "title" | "scenes"> & { order: number | null };

export const episodeLabel = (episode: TakeEpisodeOption): string =>
  episode.order === null ? episode.title : `${String(episode.order).padStart(2, "0")} · ${episode.title}`;

export function filterTakeEpisodes(episodes: readonly TakeEpisodeOption[], query: string): TakeEpisodeOption[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...episodes];
  return episodes.filter((episode) => {
    const searchable = episode.order === null
      ? episode.title.toLowerCase()
      : `${episode.order} ${String(episode.order).padStart(2, "0")} ${episode.title}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

function TakeTileMedia({
  production,
  take,
  number,
  worldSlug,
  onPick,
  onPlay,
}: {
  production: ProductionBundle;
  take: Take;
  number: number;
  worldSlug: string | undefined;
  onPick: () => void;
  onPlay: (video: HTMLVideoElement) => void;
}) {
  const view = takeMediaView(production, take);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    setFailed(false);
    setPlaying(false);
  }, [view?.sourcePath]);

  if (view === null) return <span className="fy-mono">running…</span>;
  if (!view.isVideo || worldSlug === undefined || failed) {
    return (
      <>
        <Portrait worldSlug={worldSlug} path={view.posterPath} label={`Take ${number}`} radius={0} />
        {failed && <span className="fy-take__media-failed">Could not play video</span>}
      </>
    );
  }

  const keepInsideSegment = (video: HTMLVideoElement) => {
    const segment = take.segment;
    if (segment === undefined) return;
    if (video.currentTime < segment.inSec) {
      video.currentTime = segment.inSec;
    } else if (video.currentTime >= segment.outSec) {
      video.pause();
      if (video.currentTime !== segment.outSec) video.currentTime = segment.outSec;
    }
  };
  return (
    <>
      <video
        ref={videoRef}
        className="fy-take__video"
        src={mediaUrl(worldSlug, view.sourcePath)}
        poster={mediaUrl(worldSlug, view.posterPath)}
        playsInline
        preload="metadata"
        aria-label={`Take ${number} video`}
        onPointerDown={onPick}
        onLoadedMetadata={(event) => {
          const segment = take.segment;
          if (segment !== undefined) event.currentTarget.currentTime = segment.inSec;
        }}
        onPlay={(event) => {
          const segment = take.segment;
          if (segment !== undefined &&
              (event.currentTarget.currentTime < segment.inSec || event.currentTarget.currentTime >= segment.outSec)) {
            event.currentTarget.currentTime = segment.inSec;
          }
          setPlaying(true);
          onPlay(event.currentTarget);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => keepInsideSegment(event.currentTarget)}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        className="fy-playbtn fy-take__play"
        aria-label={`${playing ? "Pause" : "Play"} Take ${number}`}
        onClick={() => {
          const video = videoRef.current;
          if (video === null) return;
          onPick();
          if (video.paused) {
            void video.play().catch((error: unknown) => {
              // Switching takes can interrupt a pending play request without a media failure.
              if (!(error instanceof Error && error.name === "AbortError")) setFailed(true);
            });
          } else {
            video.pause();
          }
        }}
      >
        {playing ? <PauseSolid size={18} /> : <Play size={18} />}
      </button>
    </>
  );
}

/**
 * The takes, watched (design turn 102, frame 102c).
 *
 * A thing you watch is shown, not described. One shot's takes sit side by side, the chosen one is
 * marked, every shot is a chip away, and accepting is one button at the foot. What used to be
 * here — the composer, the parameter rail, the model picker, the select of shots — is the bench,
 * behind Advanced: layer three, never deleted and never in front.
 *
 * Two ergonomics this fixes by construction. The shot picker was a select, which hides where you
 * are in a scene; and Accept take was disabled unless the take you were looking at happened to be
 * the pending one, which reads as broken. A marked tile and a row of chips have neither problem.
 */
function TakesView({
  worldId,
  prodId,
  askedFor,
  generating,
  onGenerate,
  onAdvanced,
  onContact,
}: {
  worldId: string | undefined;
  prodId: string | undefined;
  /** The shot the press was about, carried in the address (`?shot=`). */
  askedFor: string | null;
  generating: boolean;
  onGenerate: (shotId: string) => void;
  /* Both doors carry the shot with them (review 2026-08-22): pressing Advanced used to replace
     the whole query string, losing the shot one click after the address recovered it. */
  onAdvanced: (shotId: string | null) => void;
  onContact: (shotId: string | null) => void;
}) {
  const { world, production } = useProduction(worldId, prodId);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [showAllScenes, setShowAllScenes] = useState(false);
  const sceneById = new Map(production?.scenes.map((candidate) => [candidate.id, candidate]) ?? []);
  const episodic = production ? productionShape(production.meta).isEpisodic : false;
  const episodes = episodic ? [...(production?.episodes ?? [])].sort((a, b) => a.order - b.order) : [];
  const assignedSceneIds = new Set(episodes.flatMap((episode) => episode.scenes));
  const unassignedScenes = episodic
    ? (production?.scenes ?? []).filter((scene) => !assignedSceneIds.has(scene.id))
    : [];
  const episodeOptions: TakeEpisodeOption[] = [
    ...episodes,
    ...(unassignedScenes.length === 0
      ? []
      : [{ id: "__takes_unassigned__", order: null, title: "Unassigned", scenes: unassignedScenes.map((scene) => scene.id) }]),
  ];
  const askedScene =
    askedFor === null
      ? undefined
      : production?.scenes.find((candidate) => orderedShots(candidate).some((shot) => shot.id === askedFor));
  const askedEpisode = episodeOptions.find((episode) => askedScene !== undefined && episode.scenes.includes(askedScene.id));
  const selectedEpisode =
    episodeOptions.find((episode) => episode.id === selectedEpisodeId) ?? askedEpisode ?? episodeOptions[0] ?? null;
  const scenes = selectedEpisode === null
    ? production?.scenes ?? []
    : selectedEpisode.scenes.flatMap((id) => {
        const candidate = sceneById.get(id);
        return candidate === undefined ? [] : [candidate];
      });
  const all = scenes.flatMap((candidate) => orderedShots(candidate));
  /*
   * The shot the storyboard sent, if it sent one (found by driving: `Generate frame` on shot 14
   * opened the workspace on shot 4, because the press asked for the workspace rather than for a
   * shot). A chip pressed here still wins — the address is where you arrived, not a lock.
   */
  const asked = askedFor !== null && all.some((s) => s.id === askedFor) ? askedFor : null;
  const selected = selectedShotId !== null && all.some((candidate) => candidate.id === selectedShotId)
    ? selectedShotId
    : null;
  const shotId = selected ?? asked ?? all[0]?.id ?? null;
  const shot = all.find((s) => s.id === shotId) ?? null;
  const found = production?.scenes.find((s) => orderedShots(s).some((x) => x.id === shotId)) ?? null;
  const scene = found === null ? null : legacySceneView(found);
  /*
   * The ordinary row stays scene-local: shot numbers repeat between scenes. `All` is the explicit
   * exception, scoped first by the episode row when one is selected.
   */
  const shots = showAllScenes ? all : found === null ? [] : orderedShots(found);
  /** Only takes with resolvable pixels, plus anything still in flight. */
  const takes = production && shotId
    ? takesForShot(production, shotId).filter(
        (take) => mediaTakeFor(production, take) !== null || take.completedAt === undefined,
      )
    : [];
  const acceptedId = production && shotId ? acceptedTakeId(production, shotId) : null;
  /*
   * The mark tells no lies (review 2026-08-22). The first cut of this view guessed: when the
   * acceptance sat on a filtered charge-split record it re-pointed ✓ at the newest take with
   * media — which marked takes that were never accepted, disabled Accept on them, and disagreed
   * with the cut, the chips and the exporter all at once. Now ✓ appears only on the take that
   * is literally accepted; when that record has no preview, the foot says so instead, and one
   * press of Accept on a visible take moves the selection somewhere honest.
   */
  const accepted = takes.find((t) => t.id === acceptedId)?.id ?? null;
  const acceptedHidden = acceptedId !== null && accepted === null;
  /* What is worth looking at: the one already accepted, or the newest that came back. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked =
    takes.find((t) => t.id === pickedId) ??
    takes.find((t) => t.id === accepted) ??
    takes[takes.length - 1] ??
    null;
  const playingTakeVideo = useRef<HTMLVideoElement | null>(null);
  useEffect(() => () => {
    playingTakeVideo.current?.pause();
    playingTakeVideo.current = null;
  }, [shotId]);
  const playTake = (video: HTMLVideoElement, takeId: string) => {
    if (playingTakeVideo.current !== video) playingTakeVideo.current?.pause();
    playingTakeVideo.current = video;
    setPickedId(takeId);
    if (playbackSnapshot().status === "playing") togglePlayback();
  };
  const acceptedCount = shots.filter(
    (s) => production && acceptedTakeId(production, s.id) !== null,
  ).length;
  /* One pass over the takes for the chip dots, not one filter per chip (review 2026-08-22). */
  const coveredShotIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of production?.takes ?? []) for (const sid of t.coversShots) ids.add(sid);
    return ids;
  }, [production?.takes]);
  if (!production) {
    return (
      <div className="fy-prodmain" data-screen="generate-workspace">
        <EmptyState title="Nothing to review yet" hint="Generate a scene and its takes arrive here." />
      </div>
    );
  }
  const selectEpisode = (episode: TakeEpisodeOption) => {
    const nextScene = episode.scenes
      .map((id) => sceneById.get(id))
      .find((candidate) => candidate !== undefined && orderedShots(candidate).length > 0);
    setSelectedEpisodeId(episode.id);
    setShowAllScenes(false);
    setSelectedShotId(nextScene === undefined ? null : orderedShots(nextScene)[0]?.id ?? null);
    setPickedId(null);
  };
  const episodeFilter = selectedEpisode === null ? null : (
    <div className="fy-takes__filter fy-takes__filter--episode">
      <span className="fy-takes__filter-label">EPISODE</span>
      <EpisodePicker
        episodes={episodeOptions}
        selected={selectedEpisode}
        production={production}
        worldSlug={world?.meta.slug}
        disabled={generating}
        onSelect={selectEpisode}
      />
    </div>
  );
  if (!scene || !shot) {
    return (
      <div className="fy-arkewrap">
        <div className="fy-prodmain fy-takes" data-screen="generate-workspace">
          <header className="fy-takes__head">
            <nav className="fy-takes__filters" aria-label="Take filters">{episodeFilter}</nav>
          </header>
          <EmptyState
            title="Nothing to review yet"
            hint={selectedEpisode !== null && all.length === 0 && unassignedScenes.length > 0
              ? `${unassignedScenes.length} unassigned scene${unassignedScenes.length === 1 ? " is" : "s are"} available in the episode picker.`
              : selectedEpisode === null
                ? "Generate a scene and its takes arrive here."
                : "Choose another episode or generate its first shot."}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="fy-arkewrap">
      <div className="fy-prodmain fy-takes" data-screen="generate-workspace">
        <header className="fy-takes__head">
          <nav className="fy-takes__filters" aria-label="Take filters">
            {episodeFilter}
            {scenes.length > 1 && (
              <div className={cx("fy-takes__filter", selectedEpisode !== null && "fy-takes__filter--episode-scenes")}>
                <span className="fy-takes__filter-label">SCENE</span>
                <div className="fy-takechips" role="group" aria-label="Scene">
                  <button
                    type="button"
                    disabled={generating}
                    aria-pressed={showAllScenes}
                    className={cx("fy-takechip", showAllScenes && "fy-takechip--on")}
                    onClick={() => {
                      setShowAllScenes(true);
                      setPickedId(null);
                    }}
                  >
                    All
                  </button>
                  {scenes.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      disabled={generating}
                      aria-pressed={!showAllScenes && candidate.id === scene.id}
                      className={cx(
                        "fy-takechip",
                        "fy-takechip--scene",
                        !showAllScenes && candidate.id === scene.id && "fy-takechip--on",
                      )}
                      title={`${candidate.number} · ${candidate.title}`}
                      onClick={() => {
                        setShowAllScenes(false);
                        setSelectedShotId(orderedShots(candidate)[0]?.id ?? null);
                        setPickedId(null);
                      }}
                    >
                      <span className="fy-takechip__scene-label">
                        {candidate.number} · {candidate.title}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="fy-takes__filter">
              <span className="fy-takes__filter-label">SHOT</span>
              <div className="fy-takechips fy-takechips--shots" role="group" aria-label="Shot">
                {shots.map((candidate) => {
                  const done = acceptedTakeId(production, candidate.id) !== null;
                  const has = coveredShotIds.has(candidate.id);
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      disabled={generating}
                      aria-pressed={candidate.id === shotId}
                      className={cx("fy-takechip", candidate.id === shotId && "fy-takechip--on")}
                      onClick={() => {
                        setSelectedShotId(candidate.id);
                        setPickedId(null);
                      }}
                    >
                      <span
                        className="fy-dot"
                        style={{
                          background: done ? "var(--foreground)" : has ? "var(--warning)" : "var(--neutral-300)",
                        }}
                      />
                      Shot {candidate.number}
                    </button>
                  );
                })}
              </div>
            </div>
          </nav>
          <div className="fy-h1row">
            <h1 className="fy-h1">Shot {shot.number}</h1>
            <span className="fy-h1row__meta">
              {shot.title} · {seconds(shot.durationSec)}
            </span>
            <span className="fy-h1row__push" />
            <span className="fy-mono">
              {acceptedCount} of {shots.length} accepted
            </span>
          </div>
        </header>
        {takes.length === 0 ? (
          <EmptyState
            title="No takes yet"
            hint="Generate this shot and its takes arrive here, side by side."
          />
        ) : (
          <div className="fy-takegrid">
            {takes.map((t, i) => {
              const durationSec = typeof t.params.durationSec === "number" ? t.params.durationSec : shot.durationSec;
              return (
                <article
                  key={t.id}
                  className={cx("fy-take", picked?.id === t.id && "fy-take--on")}
                >
                  <button
                    type="button"
                    className="fy-take__pick"
                    aria-label={`Choose Take ${i + 1} for review`}
                    aria-pressed={picked?.id === t.id}
                    onClick={() => setPickedId(t.id)}
                  />
                  <span className="fy-take__frame">
                    <TakeTileMedia
                      production={production}
                      take={t}
                      number={i + 1}
                      worldSlug={world?.meta.slug}
                      onPick={() => setPickedId(t.id)}
                      onPlay={(video) => playTake(video, t.id)}
                    />
                  </span>
                  <span className="fy-take__foot">
                    <span className="fy-take__name">Take {i + 1}</span>
                    <span style={{ flex: 1 }} />
                    <span className="fy-mono">
                      {t.id === accepted ? "✓ SELECTED" : seconds(durationSec)}
                    </span>
                  </span>
                </article>
              );
            })}
          </div>
        )}
        {picked && worldId && shotId && <TakeDialogueFeedbackPanel key={`${picked.id}/${shotId}`} worldId={worldId} production={production} take={picked} shotId={shotId} />}
        <div className="fy-takes__foot">
          {/* The two verdicts and the one thing that spends (review 2026-08-22): the first cut
              of this view had no way to generate and no way to reject, so "Generate frame" from
              the storyboard landed on a screen that told you to generate and offered nothing to
              press, and a drifted take could only be ignored — never taught from. */}
          <Button
            variant="primary"
            disabled={generating || shotId === null}
            onClick={() => shotId !== null && onGenerate(shotId)}
          >
            {generating ? "Opening…" : "Open in generator"}
          </Button>
          <Button
            disabled={!picked || picked.id === accepted}
            onClick={() => {
              if (worldId && prodId && shotId && picked) acceptTake(worldId, prodId, picked.id, shotId);
            }}
          >
            {picked ? `Accept take ${takes.indexOf(picked) + 1}` : "Accept take"}
          </Button>
          <Button
            variant="ghost"
            disabled={!picked || Object.keys(picked.provenance.sheets).length === 0}
            title="A rejection cites the sheet the take drifted from"
            onClick={() => {
              const sheet = picked ? Object.keys(picked.provenance.sheets)[0] : undefined;
              if (worldId && prodId && picked && sheet)
                rejectTake(
                  worldId,
                  prodId,
                  picked.id,
                  { sheet, field: "appearance", note: "rejected in review" },
                  shotId ?? undefined,
                );
            }}
          >
            Reject
          </Button>
          {/* A state when there is one; what accepting does is the rule's, not the row's. */}
          {acceptedHidden && (
            <span className="fy-mono fy-takes__explanation">
              accepted take holds no preview — accepting a visible one replaces it
            </span>
          )}
          <span className="fy-takes__links">
            <button type="button" className="fy-linkbtn" onClick={() => onContact(shotId)}>
              Contact sheet
            </button>
            <button type="button" className="fy-linkbtn" disabled={generating} onClick={() => onAdvanced(shotId)}>
              Advanced
            </button>
          </span>
        </div>
      </div>
      {/* Layer two, in the same column it holds everywhere else (turns 99, 100, 102). */}
      <ProductionConversation
        worldId={worldId}
        productionId={prodId}
        entry={{ kind: "scene", productionId: prodId ?? "", sceneId: scene.id }}
        dock={{
          title: `Arke · Shot ${shot.number}`,
          subject: `${shot.title} · ${takes.length} take${takes.length === 1 ? "" : "s"}`,
        }}
        openingNote="opening…"
        emptyLine={`${takes.length} take${takes.length === 1 ? "" : "s"} back on shot ${shot.number}. Say what to change and it runs again.`}
        placeholder="Say what to change"
        pointsEmpty="Nothing understood yet. As you talk, what the studio takes from it appears here."
      />
    </div>
  );
}

export function GenerateScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const { connection, state } = useStore();
  const navigate = useNavigate();
  const ownerKey = `${worldId ?? ""}/${prodId ?? ""}`;
  const currentOwnerKey = useRef(ownerKey);
  currentOwnerKey.current = ownerKey;
  const pendingGenerator = useRef<{ requestId: string; ownerKey: string } | null>(null);
  const [generatorPending, setGeneratorPending] = useState(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  // The workspace's second lens (design 55a): the same frame/still takes, seen as a set.
  // Deep-linkable — the retired /stills address redirects here with the lens on.
  const [searchParams, setSearchParams] = useSearchParams();
  const contactLens = searchParams.get("view") === "stills";
  const shots = production?.scenes.flatMap((s) => orderedShots(s)) ?? [];
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);
  /* The bench honours the address the same way the takes view does (review 2026-08-22). */
  const benchAsked = searchParams.get("shot");
  const shotId =
    selectedShotId ??
    (benchAsked !== null && shots.some((s) => s.id === benchAsked) ? benchAsked : null) ??
    shots[0]?.id ??
    null;
  const shot = shots.find((s) => s.id === shotId) ?? null;
  const found = production?.scenes.find((s) => orderedShots(s).some((x) => x.id === shotId)) ?? null;
  const scene = found === null ? null : legacySceneView(found);
  const takes = production && shotId ? takesForShot(production, shotId) : [];
  const decisions = production ? takeDecisions(production) : {};
  const accepted = production && shotId ? acceptedTakeId(production, shotId) : null;
  const take =
    takes.find((t) => t.id === selectedTakeId) ??
    (accepted ? takes.find((t) => t.id === accepted) : undefined) ??
    takes[takes.length - 1] ??
    null;
  const slug = world?.meta.slug;
  const model =
    (state?.app.manifest?.models ?? []).find(
      (m) => m.id === (productionModel(state, prodId, "video") ?? state?.app.routing.defaults["video"]),
    ) ??
    (state?.app.manifest?.models ?? []).find((m) => m.capability === "video") ??
    null;

  useEffect(
    () =>
      subscribeBenchSubjectOpened((event) => {
        const pending = pendingGenerator.current;
        if (
          pending === null ||
          pending.ownerKey !== currentOwnerKey.current ||
          event.requestId !== pending.requestId ||
          event.worldId !== worldId
        ) {
          return;
        }
        pendingGenerator.current = null;
        setGeneratorPending(false);
        if (event.sessionId === null) {
          setGeneratorError(event.reason ?? "The generator session could not be prepared.");
          return;
        }
        setGeneratorError(null);
        void navigate(`/w/${worldId}/artifacts/bench/${event.sessionId}`);
      }),
    [navigate, worldId],
  );
  useEffect(() => {
    if (connection === "open" || pendingGenerator.current === null) return;
    pendingGenerator.current = null;
    setGeneratorPending(false);
    setGeneratorError("Connection lost - try again.");
  }, [connection]);
  useEffect(() => {
    const pending = pendingGenerator.current;
    if (pending === null || pending.ownerKey === ownerKey) return;
    pendingGenerator.current = null;
    setGeneratorPending(false);
    setGeneratorError(null);
  }, [ownerKey]);
  const openGenerator = (targetShotId: string) => {
    if (!worldId || !prodId || pendingGenerator.current !== null) return;
    const targetScene = production?.scenes.find((candidate) => orderedShots(candidate).some((candidate) => candidate.id === targetShotId));
    if (targetScene === undefined) return;
    const requestId = sendBenchOpenSubject({
      worldId,
      productionId: prodId,
      sceneId: targetScene.id,
      subject: { kind: "shot", shotId: targetShotId },
    });
    if (requestId === null) {
      setGeneratorError("Not connected - try again.");
      return;
    }
    pendingGenerator.current = { requestId, ownerKey };
    setGeneratorPending(true);
    setGeneratorError(null);
  };

  /*
   * Which lens the workspace opens on (turn 102). Takes are the thing here: once something has
   * been generated you are assessing rather than writing, so the takes themselves are the front
   * and the three-column bench — composer, parameters, model picker — is layer three behind
   * Advanced. Deep-linkable, so somebody who wants the bench can live in it.
   */
  const benchLens = searchParams.get("view") === "bench";

  if (contactLens) {
    return (
      <ContactSheet
        production={production}
        worldSlug={world?.meta.slug}
        worldId={worldId}
        prodId={prodId}
        onShotLens={() => setSearchParams({}, { replace: true })}
      />
    );
  }
  if (!benchLens) {
    return (
      <TakesView
        worldId={worldId}
        prodId={prodId}
        askedFor={searchParams.get("shot")}
        generating={generatorPending}
        onGenerate={openGenerator}
        onAdvanced={(targetShotId) => targetShotId !== null && openGenerator(targetShotId)}
        onContact={(shotId) =>
          setSearchParams(shotId ? { view: "stills", shot: shotId } : { view: "stills" }, { replace: true })
        }
      />
    );
  }

  /*
   * Bench-only derivations live below the lens branch (review 2026-08-22): the previous frame,
   * the frame route, the boundary still and the cited sheets are the bench's furniture, and
   * computing them above the branch made every takes-view render pay for a bench nobody was
   * looking at. Plain consts, so they may sit under the returns; the hooks stay above.
   */
  const prevShot = (() => {
    if (!found || !shot) return null;
    const ordered = orderedShots(found);
    const i = ordered.findIndex((s) => s.id === shot.id);
    return i > 0 ? ordered[i - 1]! : null;
  })();
  const prevAccepted =
    prevShot && production
      ? production.takes.find((t) => t.id === acceptedTakeId(production, prevShot.id))
      : null;
  const prevFrame = prevAccepted && production ? takeMediaPath(production, prevAccepted) : null;
  // Strict frame behaviour is promised exactly where the route supports and receives it (issue
  // 154): the model's first-frame route, and the shot's durable boundary still. Anything less is
  // steering, and the copy says so instead of promising what the dispatch cannot send.
  const frameRoute = model ? frameDispatchFor(model, 1) : null;
  const boundaryFrame = (() => {
    if (!shot || !production || !world) return null;
    const id = production.selections[shot.id]?.startFrameArtifactId ?? null;
    return id !== null ? (world.artifacts.find((a) => a.id === id) ?? null) : null;
  })();

  const citedSheets = (() => {
    if (!shot || !world) return [];
    const mentions = [...shot.description.matchAll(/@([A-Za-z0-9-]+)/g)].map((m) => m[1]!.toLowerCase());
    return world.sheets
      .filter((s) => s.type === "character")
      .filter((s) => mentions.some((m) => s.id.includes(m) || s.name.toLowerCase().includes(m)))
      .slice(0, 2);
  })();

  return (
    <div className="fy-gen" data-screen="generate-workspace">
      <div className="fy-gen__left">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="fy-seg">
            <span className="fy-seg__item fy-seg__item--active">Shot</span>
            <button
              type="button"
              className="fy-seg__item"
              onClick={() => setSearchParams({ view: "stills" }, { replace: true })}
            >
              Contact sheet
            </button>
          </span>
          <select
            value={shotId ?? ""}
            disabled={generatorPending}
            onChange={(e) => {
              setSelectedShotId(e.target.value);
              setSelectedTakeId(null);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              font: "500 12px var(--font-sans)",
              padding: "6px 8px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "inherit",
            }}
          >
            {shots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id.replace("sh_", "shot ")} · {s.title}
              </option>
            ))}
          </select>
        </div>
        <div className="fy-gen__label">
          References <span className="fy-mono">sent with every take</span>
        </div>
        <div className="fy-refstrip">
          <div className="fy-refstrip__wide">
            <Portrait
              worldSlug={slug}
              path={scene?.board ? `productions/${production!.meta.id}/${scene.board.image}` : ""}
              label={shot ? `${shot.id.replace("sh_", "Shot ")} frame` : "frame"}
              radius={0}
            />
          </div>
          {citedSheets.map((s) => (
            <div key={s.id} className="fy-refstrip__tile">
              <Portrait worldSlug={slug} path={sheetPortraitPath(s.id)} label={s.name} radius={0} />
            </div>
          ))}
          <button
            type="button"
            className="fy-refstrip__add"
            title="References ride from the kits"
            onClick={() => navigate(`/w/${worldId}/cast`)}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="fy-mono" style={{ marginTop: 6 }}>
          {shot
            ? `${shot.id.replace("sh_", "shot ")}${citedSheets.length > 0 ? ` · ${citedSheets.map((s) => `${s.name} model sheet v${s.version}`).join(" · ")}` : ""}`
            : ""}
        </div>
        <div className="fy-gen__label" style={{ marginTop: 16 }}>
          Frames{" "}
          <span className="fy-mono">
            {frameRoute !== null
              ? "start travels on the first-frame route"
              : "steering only · no frame route on this model"}
          </span>
        </div>
        {world && production && (
          <div className="fy-worldlook-line">
            <span>
              {shot?.promptOverride
                ? "Shot prompt override"
                : production.meta.styleOverride?.trim()
                ? "Production look"
                : `World look · v${world.artDirection.version}`}
            </span>
            <small>
              {shot?.promptOverride ? "edited by you" : production.meta.styleOverride?.trim() || "inherited"} · carries
              as text
            </small>
          </div>
        )}
        <div className="fy-framerow">
          {boundaryFrame ? (
            <div className="fy-frame">
              <Portrait
                worldSlug={slug}
                path={`artifacts/${boundaryFrame.file}`}
                label="Start frame"
                radius={0}
              />
              <span className="fy-frame__tag">
                START · BOUNDARY FRAME{frameRoute !== null ? "" : " (STEERS ONLY)"}
              </span>
            </div>
          ) : prevFrame ? (
            <div className="fy-frame">
              <Portrait worldSlug={slug} path={prevFrame} label="Start frame" radius={0} />
              <span className="fy-frame__tag">
                START · {prevShot!.id.replace("sh_", "SHOT ")}, LAST FRAME (PREVIEW)
              </span>
            </div>
          ) : (
            <div className="fy-frame fy-frame--empty">START · FROM THE BOARD</div>
          )}
          <div className="fy-frame fy-frame--empty">END · OPTIONAL</div>
        </div>
        <div className="fy-paramrow">
          {/* The production's delivery aspect (issue 389), never a hard-coded landscape. */}
          <span className="fy-param">{production ? productionAspect(production.meta) : "16:9"}</span>
          <span className="fy-param">720p</span>
          {shot && <span className="fy-param">{seconds(shot.durationSec)}</span>}
          {frameRoute !== null && boundaryFrame && (
            <span className="fy-param">opens on its boundary frame</span>
          )}
        </div>
        <div className="fy-gen__cta">
          {model && (
            <span className="fy-modelchip">
              {model.displayName}
              <span className="fy-mono">{modelCapabilityCopy(model)}</span>
            </span>
          )}
          <span className="fy-h1row__push" />
          <Button
            variant="primary"
            disabled={generatorPending || shotId === null}
            onClick={() => shotId !== null && openGenerator(shotId)}
          >
            {generatorPending ? "Opening…" : "Open generation session"}
          </Button>
          {generatorError === null ? null : <span role="alert" className="fy-mono">{generatorError}</span>}
        </div>
      </div>
      <div className="fy-gen__center">
        {take ? (
          <>
            <div className="fy-gen__meta">
              <span className="fy-mono">
                take {takes.indexOf(take) + 1} · {take.model} · {seconds(shot?.durationSec)}
                {take.completedAt ? ` · finished ${take.completedAt.slice(11, 16)}` : ""}
              </span>
              {(take.provenance.propStates ?? []).length === 0 ? null : (
                // The five fields frozen at dispatch (design turn 105; issue 536), named rather
                // than by id — what this take was made with, not what the shot says now.
                <span className="fy-mono" data-testid="take-prop-provenance" style={{ display: "block" }}>
                  {take.provenance.propStates!
                    .map((entry) => {
                      const prop = world?.props.find((candidate) => candidate.id === entry.propId);
                      const state = prop?.states.find((candidate) => candidate.id === entry.stateId);
                      return `prop: ${prop?.name ?? entry.propId} · state: ${state?.name ?? entry.stateId ?? "unresolved"} · ref: ${entry.referenceId ?? "none"} · resolved: ${entry.resolutionSource} · override: ${entry.overrideSource ?? "none"}`;
                    })
                    .join("  ")}
                </span>
              )}
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span className={`fy-dot fy-dot--${decisionTone(decisions[take.id])}`} />
                <span className="fy-mono">{decisions[take.id] ?? "pending"}</span>
              </span>
            </div>
            <div className="fy-viewer">
              <Portrait
                worldSlug={slug}
                path={takeMediaPath(production!, take) ?? ""}
                label={`Take: first frame`}
                radius={0}
              />
              <span className="fy-playbtn" aria-hidden style={{ pointerEvents: "none" }}>
                <Play size={22} />
              </span>
            </div>
            <div className="fy-scrub">
              <span className="fy-mono">0:00</span>
              <div className="fy-scrub__bar">
                <div className="fy-scrub__fill" style={{ width: "0%" }} />
              </div>
              <span className="fy-mono">{seconds(shot?.durationSec)}</span>
            </div>
            <div className="fy-gen__verdict">
              <Button
                variant="primary"
                disabled={!shotId || decisions[take.id] === "accepted"}
                onClick={() => worldId && prodId && shotId && acceptTake(worldId, prodId, take.id, shotId)}
              >
                Accept take
              </Button>
              <Button
                disabled={
                  Object.keys(take.provenance.sheets).length === 0 || decisions[take.id] === "rejected"
                }
                title="A rejection cites the sheet the take drifted from"
                onClick={() => {
                  const sheet = Object.keys(take.provenance.sheets)[0];
                  if (worldId && prodId && sheet)
                    rejectTake(
                      worldId,
                      prodId,
                      take.id,
                      { sheet, field: "appearance", note: "rejected in review" },
                      shotId ?? undefined,
                    );
                }}
              >
                Reject · cite the sheet
              </Button>
              <span className="fy-h1row__push" />
            </div>
          </>
        ) : (
          <EmptyState
            title="No takes for this shot yet"
            hint="Dispatch sends the shot out; takes land here for review."
          />
        )}
      </div>
      <div className="fy-gen__takes">
        <div className="fy-eyebrow-sm" style={{ textAlign: "center" }}>
          TAKES
        </div>
        {takes.map((t, i) => (
          <button
            key={t.id}
            type="button"
            className={cx("fy-taketile", take?.id === t.id && "fy-taketile--active")}
            onClick={() => setSelectedTakeId(t.id)}
          >
            <div className="fy-taketile__frame">
              <Portrait
                worldSlug={slug}
                path={takeMediaPath(production!, t) ?? ""}
                label={`take ${i + 1}`}
                radius={0}
              />
            </div>
            <div className="fy-taketile__meta">
              <span>{i + 1}</span>
              <span
                className={`fy-dot fy-dot--${decisionTone(decisions[t.id])}`}
                style={{ width: 5, height: 5 }}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One pass, said as the dispatch it is: route, what rides, length, price.
 *
 * Module-level and pure, so the line can be read back in a test rather than re-spelled there —
 * a second copy of this format would be a second answer to what the dispatch is.
 */
export function passRow(pass: CompiledPass): string {
  const route =
    pass.route.kind === "frame"
      ? "first-frame route"
      : pass.route.kind === "reference"
        ? `reference route · refs ×${pass.references.length} · ${carriedSubjects(pass.references)}`
        : "text route";
  const length = pass.askedSec !== undefined ? ` · ${seconds(pass.askedSec)}` : "";
  return `${route}${length} · ${usd(pass.estimatedMicroUsd)}`;
}

export function VoiceLineDialogScreen() {
  const { worldId, prodId } = useParams();
  const [params] = useSearchParams();
  const { world, production } = useProduction(worldId, prodId);
  const clientState = useStore().state;
  const navigate = useNavigate();
  const spoken =
    production?.scenes.flatMap((s) => orderedShots(s)).filter((s) => s.audio?.line && s.audio.speaker) ?? [];
  // The shot the row asked for. Without this the dialog showed whichever line came first, so
  // pressing Generate beside one character opened another character's line.
  const asked = params.get("shot");
  const shot = spoken.find((s) => s.id === asked) ?? spoken[0];
  const speaker = shot?.audio?.speaker ? world?.sheets.find((c) => c.id === shot.audio!.speaker) : undefined;
  const assignedVoiceModelId = speaker?.voice
    ? (speaker.voice.model ?? legacyVoiceModel(speaker.voice.provider, speaker.voice.voiceId, world?.clonedVoices ?? []))
    : null;
  const voiceModel = speaker?.voice && assignedVoiceModelId
    ? clientState?.app.manifest?.models.find(
        (model) =>
          model.provider === speaker.voice!.provider &&
          model.capability === "voice-tts" &&
          model.id === assignedVoiceModelId,
      )
    : undefined;
  const voiceDeliveries = supportedDeliveries(voiceModel);
  const voiceReadiness =
    speaker?.voice && voiceModel?.provider === "comfyui"
      ? clientState?.app.comfyui?.recipes.find((recipe) => recipe.recipeId === voiceModel.id)
      : null;
  const assignedVoiceUnavailableReason =
    voiceReadiness?.state === "disabled" ||
    (voiceReadiness?.state === "unknown" && clientState?.app.comfyui?.engine.locality === "local")
      ? (voiceReadiness.reason ?? "The assigned voice recipe is not ready.")
      : voiceModel !== undefined && (clientState?.app.models.disabled ?? []).includes(voiceModel.id)
        ? `${voiceModel.displayName} is turned off in AI models.`
      : voiceModel === undefined && speaker?.voice
        ? "The assigned voice model is no longer available."
        : null;
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<Delivery | "">("");
  const [voiceModelOverride, setVoiceModelOverride] = useState<string | undefined>();
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const [uploadConfirmation, setUploadConfirmation] = useState<{
    destinationLabel: string;
    confirmationToken: string;
    destinationNotice?: string;
  } | null>(null);
  const rememberedVoiceModelId = production?.meta.models?.["voice-tts"];
  const effectiveVoiceModelId = voiceModelOverride ?? rememberedVoiceModelId ?? assignedVoiceModelId ?? undefined;
  const selectedVoiceModel = clientState?.app.manifest?.models.find(
    (model) => model.id === effectiveVoiceModelId && model.capability === "voice-tts",
  );
  const voiceModelConflict =
    effectiveVoiceModelId !== undefined && assignedVoiceModelId !== null && effectiveVoiceModelId !== assignedVoiceModelId
      ? selectedVoiceModel === undefined
        ? `This production still names ${effectiveVoiceModelId}, which is no longer available.`
        : `This production uses ${selectedVoiceModel.displayName}, but ${speaker?.name ?? "this character"}'s assigned voice uses ${voiceModel?.displayName ?? assignedVoiceModelId}. Choose the assigned model for this line.`
      : null;
  const voiceUnavailableReason = voiceModelConflict ?? assignedVoiceUnavailableReason;
  useEffect(
    () =>
      subscribeQueueResults((result) => {
        if (result.requestId !== pending.current) return;
        pending.current = null;
        setSending(false);
        if (result.disposition === "accepted") navigate(`/w/${worldId}/p/${prodId}/audio`);
        else setRefusal(result.failures[0]?.reason ?? "The line could not be queued.");
      }),
    [navigate, worldId, prodId],
  );
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== pending.current) return;
        setUploadConfirmation(confirmation);
      }),
    [],
  );
  const generateLine = (voiceUploadConfirmedFor?: string) => {
    if (!worldId || !prodId || !shot) return;
    setRefusal(null);
    setSending(true);
    pending.current = requestVoiceLine({
      worldId,
      productionId: prodId,
      shotId: shot.id,
      ...(effectiveVoiceModelId !== undefined ? { modelId: effectiveVoiceModelId } : {}),
      ...(delivery ? { delivery } : {}),
      ...(voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor } : {}),
    });
  };
  return (
    <div className="fy-dialogwrap" data-screen="voice-line-dialog">
      <div className="fy-dialog" style={{ maxWidth: 560 }}>
        <div className="fy-h1row">
          <h1 className="fy-h1" style={{ fontSize: 22 }}>
            Voice line
          </h1>
          <span className="fy-h1row__push" />
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
            Close
          </Button>
        </div>
        <DegradedBanner component="voice" />
        {shot && speaker ? (
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <div style={{ width: 56, height: 64, flex: "none" }}>
              <Portrait
                worldSlug={world?.meta.slug}
                path={sheetPortraitPath(speaker.id)}
                label={speaker.name}
                radius={8}
              />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ font: "600 14px var(--font-sans)" }}>{speaker.name}</div>
              <div
                style={{
                  font: "400 13px/1.5 var(--font-sans)",
                  color: "var(--muted-foreground)",
                  fontStyle: "italic",
                  marginTop: 2,
                }}
              >
                “{shot.audio!.line}”
              </div>
              <div className="fy-mono" style={{ marginTop: 4 }}>
                {`voice · ${speaker.voice ? `${speaker.voice.label ?? speaker.voice.voiceId} (${speaker.voice.provider})` : "none assigned"}`}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState title="No spoken lines in this production yet" />
        )}
        {refusal !== null && <p className="fy-refusal">{refusal}</p>}
        {voiceUnavailableReason !== null && (
          <p className="fy-refusal">
            {voiceModelConflict ?? `Assigned voice unavailable · ${assignedVoiceUnavailableReason}`}
          </p>
        )}
        {speaker?.voice && assignedVoiceModelId && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <select
              aria-label="Voice model"
              className="fy-bench__chip"
              value={effectiveVoiceModelId}
              onChange={(event) => setVoiceModelOverride(event.target.value)}
            >
              {rememberedVoiceModelId && rememberedVoiceModelId !== assignedVoiceModelId && (
                <option value={rememberedVoiceModelId}>
                  {selectedVoiceModel?.displayName ?? rememberedVoiceModelId} · this production
                </option>
              )}
              <option value={assignedVoiceModelId}>{voiceModel?.displayName ?? assignedVoiceModelId} · assigned voice</option>
            </select>
            {effectiveVoiceModelId === assignedVoiceModelId && rememberedVoiceModelId !== assignedVoiceModelId && worldId && prodId && (
              <button
                type="button"
                className="fy-set__link"
                onClick={() => setProductionModel(worldId, prodId, "voice-tts", assignedVoiceModelId)}
              >
                Remember for this production
              </button>
            )}
          </div>
        )}
        {speaker?.voice &&
          (voiceDeliveries.length > 0 ? (
            <select
              aria-label="Delivery"
              className="fy-bench__chip"
              value={delivery}
              onChange={(event) => setDelivery(event.target.value as Delivery | "")}
            >
              <option value="">delivery · default</option>
              {DELIVERIES.filter((item) => voiceDeliveries.includes(item)).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          ) : (
            <span className="fy-mono">delivery · provider default only</span>
          ))}
        <div>
          <Button
            variant="primary"
            data-testid="voice-line-generate"
            disabled={
              shot === undefined ||
              speaker === undefined ||
              speaker.voice === undefined ||
              voiceUnavailableReason !== null ||
              sending
            }
            title={
              speaker !== undefined && speaker.voice === undefined
                ? `${speaker.name} has no assigned voice — choose one on their sheet`
                : (voiceUnavailableReason ?? undefined)
            }
            onClick={() => generateLine()}
          >
            {sending ? "Generating…" : "Generate line"}
          </Button>
        </div>
        {uploadConfirmation && (
          <RemoteVoiceUploadConfirmation
            destinationLabel={uploadConfirmation.destinationLabel}
            destinationNotice={uploadConfirmation.destinationNotice}
            onCancel={() => {
              pending.current = null;
              setSending(false);
              setUploadConfirmation(null);
            }}
            onConfirm={() => {
              const token = uploadConfirmation.confirmationToken;
              setUploadConfirmation(null);
              generateLine(token);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ---- Stills contact sheet --------------------------------------------------

/**
 * Generate's second lens (design 55a): the frame/still takes as a set, decided one at a time.
 * This was a rail destination of its own; a take is decided where it was made, so the contact
 * sheet now lives inside the workspace and the seg is the way between the lenses.
 */
function ContactSheet({
  production,
  worldSlug,
  worldId,
  prodId,
  onShotLens,
}: {
  production: ReturnType<typeof useProduction>["production"];
  worldSlug: string | undefined;
  worldId: string | undefined;
  prodId: string | undefined;
  onShotLens: () => void;
}) {
  const stills = useMemo(
    () => production?.takes.filter((t) => t.kind === "frame" || t.kind === "still") ?? [],
    [production],
  );
  const decisions = production ? takeDecisions(production) : {};
  return (
    <div className="fy-prodmain" data-screen="stills-contact-sheet">
      <div className="fy-h1row">
        <span className="fy-seg">
          <button type="button" className="fy-seg__item" onClick={onShotLens}>
            Shot
          </button>
          <span className="fy-seg__item fy-seg__item--active">Contact sheet</span>
        </span>
        <span className="fy-h1row__meta">
          {stills.length} frame{stills.length === 1 ? "" : "s"}
        </span>
      </div>
      {stills.length === 0 ? (
        <EmptyState title="No stills yet" />
      ) : (
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}
        >
          {stills.map((take) => {
            const decision = decisions[take.id];
            const shotId = take.coversShots[0];
            return (
              <div key={take.id} className="fy-shotcard">
                <div className="fy-shotcard__frame">
                  <Portrait
                    worldSlug={worldSlug}
                    path={takeMediaPath(production!, take) ?? ""}
                    label={shotId?.replace("sh_", "shot ") ?? take.id}
                    radius={0}
                  />
                </div>
                <div className="fy-shotcard__body">
                  <div className="fy-shotcard__head">
                    <span className="fy-shotcard__num">{shotId?.replace("sh_", "") ?? "—"}</span>
                    <span className="fy-shotcard__title">{take.media ?? take.id}</span>
                    <span className={`fy-dot fy-dot--${decisionTone(decision)}`} />
                  </div>
                  <span className="fy-mono">
                    {take.model}
                    {decision && decision !== "pending" ? ` · ${decision}` : " · unreviewed"}
                  </span>
                  <div className="fy-shotcard__spacer" />
                  <div className="fy-shotcard__actions">
                    <Button
                      variant={decision === "accepted" ? "primary" : "ghost"}
                      disabled={!shotId}
                      onClick={() => {
                        // Accept = decision + selection in one commit (SPEC-013 R-9).
                        if (worldId && prodId && shotId) acceptTake(worldId, prodId, take.id, shotId);
                      }}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={Object.keys(take.provenance.sheets).length === 0}
                      title="A rejection cites the sheet the take drifted from (R-10)"
                      onClick={() => {
                        const sheet = Object.keys(take.provenance.sheets)[0];
                        if (worldId && prodId && sheet)
                          rejectTake(
                            worldId,
                            prodId,
                            take.id,
                            { sheet, field: "appearance", note: "rejected from the contact sheet" },
                            shotId,
                          );
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

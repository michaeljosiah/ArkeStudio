import {
  legacySceneView,
  orderedShots,
  productionShape,
  type ProductionBundle,
  type Take,
} from "@arke-studio/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProductionConversation } from "../components/conversation.js";
import { PauseSolid, Play } from "../components/icons.js";
import { EmptyState } from "../components/layout.js";
import { Portrait } from "../components/portrait.js";
import { TakeDialogueFeedbackPanel } from "../components/take-dialogue-feedback.js";
import { Button, cx } from "../components/ui.js";
import { playbackSnapshot, togglePlayback } from "../lib/audio.js";
import { seconds } from "../lib/format.js";
import { mediaUrl } from "../lib/media.js";
import { acceptedTakeId, reviewableTakesForShot, useProduction } from "../lib/selectors.js";
import { acceptTake, rejectTake } from "../lib/store.js";
import { takeMediaView } from "../lib/take-presentation.js";
import { EpisodePicker, type TakeEpisodeOption } from "./production-episode-picker.js";

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
export function TakesView({
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
    ? reviewableTakesForShot(production, shotId)
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

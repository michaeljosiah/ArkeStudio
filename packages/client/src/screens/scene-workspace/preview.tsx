import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SHOT_SEC,
  deriveCut,
  hasOwnFrame,
  orderedShots,
  type ArtifactSidecar,
  type PackedBoard,
  type ProductionBundle,
  type SceneRecord,
  type Shot,
} from "@arke-studio/contracts";
import { mediaUrl } from "../../lib/media.js";
import { mediaTakeFor, acceptedTakeId } from "../../lib/selectors.js";
import { posterNameFor, posterize } from "../../lib/poster.js";
import { onMediaReady, syncMediaElement, useTransport } from "../../lib/playback-engine.js";
import { useWorkspaceSelection } from "./selection.js";

interface PreviewSpan {
  shot: Shot;
  startSec: number;
  endSec: number;
  clipPath: string | null;
  clipInSec: number;
  framePath: string | null;
  framed: boolean;
  boardStart: boolean;
}

function framePath(
  production: ProductionBundle,
  artifacts: readonly ArtifactSidecar[],
  shotId: string,
): string | null {
  const selection = production.selections[shotId];
  if (hasOwnFrame(selection, artifacts)) {
    const artifact = artifacts.find((candidate) => candidate.id === selection?.startFrameArtifactId);
    if (artifact !== undefined) return `artifacts/${artifact.file}`;
  }
  const steeringId = selection?.startFrameTakeId ?? null;
  const steering = steeringId === null ? undefined : production.takes.find((take) => take.id === steeringId);
  const steeringMedia = steering === undefined ? null : mediaTakeFor(production, steering);
  if (steeringMedia !== null) {
    return `productions/${production.meta.id}/takes/${steeringMedia.id}/${posterNameFor(steeringMedia.media)}`;
  }
  const accepted = acceptedTakeId(production, shotId);
  const legacy = accepted === null
    ? undefined
    : production.takes.find((take) => take.id === accepted && (take.kind === "frame" || take.kind === "still"));
  const legacyMedia = legacy === undefined ? null : mediaTakeFor(production, legacy);
  return legacyMedia === null
    ? null
    : `productions/${production.meta.id}/takes/${legacyMedia.id}/${posterNameFor(legacyMedia.media)}`;
}

export function scenePreviewSpans(
  production: ProductionBundle,
  scene: SceneRecord,
  artifacts: readonly ArtifactSidecar[],
  boards: readonly PackedBoard[],
): PreviewSpan[] {
  const entries = new Map(
    deriveCut(production).entries
      .filter((entry) => entry.sceneNumber === scene.number)
      .map((entry) => [entry.shot.id, entry]),
  );
  const boardStarts = new Set(boards.slice(1).map((board) => board.memberShotIds[0]));
  let at = 0;
  return orderedShots(scene).map((shot) => {
    const durationSec = shot.durationSec ?? DEFAULT_SHOT_SEC;
    const entry = entries.get(shot.id);
    const clipPath = entry?.take?.kind === "clip" ? (entry.media?.path ?? null) : null;
    const frame = framePath(production, artifacts, shot.id) ?? (clipPath === null ? null : posterize(clipPath));
    const span: PreviewSpan = {
      shot,
      startSec: at,
      endSec: at + durationSec,
      clipPath,
      clipInSec: entry?.media?.inSec ?? 0,
      framePath: frame,
      framed: hasOwnFrame(production.selections[shot.id], artifacts) ||
        production.takes.some((take) =>
          take.id === production.selections[shot.id]?.acceptedTakeId &&
          (take.kind === "frame" || take.kind === "still"),
        ),
      boardStart: boardStarts.has(shot.id),
    };
    at = span.endSec;
    return span;
  });
}

function spanAt(spans: readonly PreviewSpan[], seconds: number): PreviewSpan | null {
  return spans.find((span) => seconds >= span.startSec && seconds < span.endSec) ??
    (seconds === spans.at(-1)?.endSec ? spans.at(-1)! : null);
}

export function ScenePreview({
  production,
  scene,
  artifacts,
  boards,
  worldSlug,
  aspect,
}: {
  production: ProductionBundle;
  scene: SceneRecord;
  artifacts: readonly ArtifactSidecar[];
  boards: readonly PackedBoard[];
  worldSlug: string | undefined;
  aspect: string;
}) {
  const spans = useMemo(
    () => scenePreviewSpans(production, scene, artifacts, boards),
    [production, scene, artifacts, boards],
  );
  const totalSec = spans.at(-1)?.endSec ?? 0;
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const timeRef = useRef(0);
  const video = useRef<HTMLVideoElement>(null);
  const still = useRef<HTMLImageElement>(null);
  const { select } = useWorkspaceSelection();
  const setPosition = useTransport({
    playing,
    durationSec: totalSec,
    timeRef,
    onTime: setTime,
    onEnded: () => setPlaying(false),
  });
  const seek = useCallback((seconds: number) => {
    const next = Math.min(Math.max(0, seconds), totalSec);
    setPosition(next);
    setTime(next);
  }, [setPosition, totalSec]);

  useEffect(() => {
    if (timeRef.current <= totalSec) return;
    seek(totalSec);
  }, [seek, totalSec, timeRef]);

  const sync = useCallback((span: PreviewSpan | null, nowMs: number) => {
    const clipSrc = span?.clipPath === null || span?.clipPath === undefined || worldSlug === undefined
      ? null
      : mediaUrl(worldSlug, span.clipPath);
    const frameSrc = span?.framePath === null || span?.framePath === undefined || worldSlug === undefined
      ? null
      : mediaUrl(worldSlug, span.framePath);
    const media = video.current;
    const image = still.current;
    if (media !== null) {
      syncMediaElement(media, {
        src: clipSrc,
        targetSec: span === null ? 0 : span.clipInSec + Math.max(0, timeRef.current - span.startSec),
        playing,
        nowMs,
      });
      media.style.opacity = clipSrc === null ? "0" : "1";
    }
    if (image !== null) {
      if (clipSrc === null && frameSrc !== null && image.getAttribute("src") !== frameSrc) image.setAttribute("src", frameSrc);
      image.style.opacity = clipSrc === null && frameSrc !== null ? "1" : "0";
    }
  }, [playing, timeRef, worldSlug]);

  useEffect(() => {
    const media = video.current;
    if (media === null) return;
    const push = () => sync(spanAt(spans, timeRef.current), Date.now());
    onMediaReady(media, push);
    if (!playing) {
      push();
      return;
    }
    let frame = 0;
    const tick = () => {
      push();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, spans, sync, time, timeRef]);

  const current = spanAt(spans, time);
  return (
    <section className="fy-swpreview" data-testid="workspace-preview">
      <div className="fy-swpreview__viewport">
        <div className="fy-swpreview__stage" style={{ aspectRatio: aspect.replace(":", " / ") }}>
          <video ref={video} playsInline muted aria-label="Rendered scene preview" />
          <img ref={still} alt="" />
          {current !== null && current.framePath === null && current.clipPath === null ? <span className="fy-swpreview__empty">no frame yet</span> : null}
          {current === null ? null : (
            <>
              <span className="fy-swpreview__shot">shot {current.shot.number}</span>
              <span className="fy-swpreview__kind">{current.clipPath === null ? "still · animatic" : "motion · rendered"}</span>
              <span className="fy-swpreview__caption">
                <strong>{current.shot.title}</strong>
                <span>{current.shot.framing?.size ?? "shot"}{current.shot.framing?.lens === undefined ? "" : ` · ${current.shot.framing.lens}`} · {(current.endSec - current.startSec).toFixed(1)}s</span>
              </span>
            </>
          )}
          {playing || totalSec === 0 ? null : (
            <button type="button" className="fy-swpreview__stageplay" aria-label="Play scene preview" onClick={() => setPlaying(true)} />
          )}
        </div>
      </div>
      <div className="fy-swpreview__controls">
        <div className="fy-swpreview__transport">
          <button type="button" onClick={() => setPlaying((value) => totalSec > 0 && !value)}>{playing ? "Pause" : "Play"}</button>
          <button type="button" aria-label="Restart preview" onClick={() => { seek(0); setPlaying(totalSec > 0); }}>Restart</button>
          <span>{time.toFixed(1)}s / {totalSec.toFixed(1)}s</span>
        </div>
        <div className="fy-swpreview__striptrack">
          <div className="fy-swpreview__filmstrip" aria-label="Scene shots">
            {spans.map((span) => {
              const thumb = span.framePath === null || worldSlug === undefined ? null : mediaUrl(worldSlug, span.framePath);
              return (
                <button
                  key={span.shot.id}
                  type="button"
                  style={{ flexGrow: span.endSec - span.startSec, flexBasis: 0 }}
                  data-current={current?.shot.id === span.shot.id ? "true" : undefined}
                  data-frameless={!span.framed ? "true" : undefined}
                  data-board-start={span.boardStart ? "true" : undefined}
                  aria-label={`Seek to shot ${span.shot.number}`}
                  onClick={() => {
                    seek(span.startSec);
                    select({ kind: "shot", shotId: span.shot.id });
                  }}
                >
                  {thumb === null ? null : <span style={{ backgroundImage: `url(${thumb})` }} />}
                  <b>{span.shot.number}</b>
                </button>
              );
            })}
          </div>
          <span className="fy-swpreview__progress"><span style={{ width: `${totalSec === 0 ? 0 : (time / totalSec) * 100}%` }} /></span>
        </div>
      </div>
      <p className="fy-swpreview__script">{current?.shot.description ?? "No shots in this scene."}</p>
    </section>
  );
}

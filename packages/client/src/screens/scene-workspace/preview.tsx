import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SHOT_SEC,
  deriveCut,
  deriveRehearsalLines,
  effectiveFraming,
  formatMicroUsd,
  pickableArtifacts,
  productionAspect,
  stagePlayblastIsStale,
  stageSourceFingerprintInput,
  hasOwnFrame,
  orderedShots,
  type ArtifactSidecar,
  type PackedBoard,
  type ProductionBundle,
  type SceneRecord,
  type Sheet,
  type Shot,
  type TableReadPlan,
} from "@arke-studio/contracts";
import { ImageMark, PauseSolid, PlaySolid, RotateCcw } from "../../components/icons.js";
import { artifactsForProduction } from "../../lib/artifact-view.js";
import { loadPlaylist, playPlaylistLine, setPlaylistRate, setPlaylistSolo, type PlaylistState } from "../../lib/audio.js";
import { mediaUrl } from "../../lib/media.js";
import { planTableRead, prepareTableRead, subscribeRehearsalResults, useStore } from "../../lib/store.js";
import { posterize } from "../../lib/poster.js";
import { onMediaReady, syncMediaElement, useTransport } from "../../lib/playback-engine.js";
import { ShotLightbox, shotFramePath } from "./lightbox.js";
import { useWorkspaceSelection } from "./selection.js";

interface PreviewSpan {
  shot: Shot;
  startSec: number;
  endSec: number;
  clipPath: string | null;
  clipInSec: number;
  framePath: string | null;
  framed: boolean;
  blockout: boolean;
  boardStart: boolean;
}

export function fitPreviewStage(width: number, height: number, aspect: string): { width: number; height: number } {
  const [wide, high] = aspect.split(":").map(Number);
  const ratio = wide !== undefined && high !== undefined && wide > 0 && high > 0 ? wide / high : 16 / 9;
  const fittedWidth = Math.max(0, Math.min(width, height * ratio));
  return { width: fittedWidth, height: fittedWidth / ratio };
}

export function scenePreviewSpans(
  production: ProductionBundle,
  scene: SceneRecord,
  artifacts: readonly ArtifactSidecar[],
  boards: readonly PackedBoard[],
  fingerprints: ReadonlyMap<string, string> = new Map(),
): PreviewSpan[] {
  const entries = new Map(
    deriveCut(production).entries
      .filter((entry) => entry.sceneNumber === scene.number)
      .map((entry) => [entry.shot.id, entry]),
  );
  const boardStarts = new Set(boards.slice(1).map((board) => board.memberShotIds[0]));
  const shelf = pickableArtifacts(artifactsForProduction(artifacts, production.meta.id));
  const aspect = productionAspect(production.meta);
  let at = 0;
  return orderedShots(scene).map((shot) => {
    const durationSec = shot.durationSec ?? DEFAULT_SHOT_SEC;
    const entry = entries.get(shot.id);
    const staging = shot.staging;
    const pin = staging?.playblast;
    const fresh = !entry?.take && staging && pin &&
      !stagePlayblastIsStale(scene, staging, { durationSec, aspect, lens: effectiveFraming(scene, shot).lens }) &&
      (pin.sourceFingerprint === undefined || fingerprints.get(stageSourceFingerprintInput(scene, shot, aspect)) === pin.sourceFingerprint);
    const playblast = fresh ? shelf.find(artifact => artifact.id === pin.artifactId && artifact.kind === "video") : undefined;
    const opening = playblast ? shelf.find(artifact => artifact.id === pin!.openingFrameArtifactId && artifact.kind === "image") : undefined;
    const clipPath = entry?.take?.kind === "clip" ? (entry.media?.path ?? null) : playblast ? `artifacts/${playblast.file}` : null;
    const frame = opening ? `artifacts/${opening.file}`
      : shotFramePath(production, artifacts, shot.id) ?? (playblast || clipPath === null ? null : posterize(clipPath));
    const span: PreviewSpan = {
      shot,
      startSec: at,
      endSec: at + durationSec,
      clipPath,
      clipInSec: playblast ? 0 : entry?.media?.inSec ?? 0,
      blockout: playblast !== undefined,
      framePath: frame,
      framed: opening !== undefined || hasOwnFrame(production.selections[shot.id], artifacts) ||
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
  worldId,
  worldSlug,
  sheets,
  aspect,
  onEditShot,
  onOpenShotInGenerator,
}: {
  production: ProductionBundle;
  scene: SceneRecord;
  artifacts: readonly ArtifactSidecar[];
  boards: readonly PackedBoard[];
  worldId: string;
  worldSlug: string | undefined;
  sheets: readonly Sheet[];
  aspect: string;
  // The lightbox's Advanced and Generate frame hand off to the workspace; optional only so a
  // caller that has not wired them yet still compiles, in which case those two buttons just close.
  onEditShot?: (shotId: string) => void;
  onOpenShotInGenerator?: (shotId: string) => void;
}) {
  const fingerprintInputs = useMemo(() => [...new Set(orderedShots(scene)
    .filter(shot => shot.staging?.playblast?.sourceFingerprint !== undefined)
    .map(shot => stageSourceFingerprintInput(scene, shot, productionAspect(production.meta))))], [scene, production.meta]);
  const [fingerprints, setFingerprints] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    let current = true;
    void Promise.all(fingerprintInputs.map(async input => {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
      return [input, Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")] as const;
    })).then(values => { if (current) setFingerprints(new Map(values)); }).catch(() => {
      if (current) setFingerprints(new Map()); // Unverified playblasts stay absent.
    });
    return () => { current = false; };
  }, [fingerprintInputs]);
  const spans = useMemo(
    () => scenePreviewSpans(production, scene, artifacts, boards, fingerprints),
    [production, scene, artifacts, boards, fingerprints],
  );
  const totalSec = spans.at(-1)?.endSec ?? 0;
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);

  // Play lines (SPEC-044 R-33): the scene's spoken lines that have a read — a selected one, or the
  // table-read cache — in shot order through the one player; the rest are counted, not played, and
  // a dashed door prepares them at the cost the plan quoted. The plan is asked for when the lines,
  // the reviews or the cache's jobs change, so the door's count and price are current before a press.
  const { state, connection } = useStore();
  const lines = useMemo(() => deriveRehearsalLines(scene, sheets).filter((line) => line.reason === undefined), [scene, sheets]);
  const [plan, setPlan] = useState<TableReadPlan | null>(null);
  const [linesNotice, setLinesNotice] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [solo, setSolo] = useState<string | null>(null);
  const [rate, setRate] = useState<PlaylistState["rate"]>(1);
  const planRequest = useRef<string | null>(null);
  const prepareRequest = useRef<string | null>(null);
  const requestPlan = useCallback(() => { planRequest.current = planTableRead(worldId, production.meta.id, scene.id); }, [worldId, production.meta.id, scene.id]);
  useEffect(() => subscribeRehearsalResults((result) => {
    if (result.requestId !== planRequest.current && result.requestId !== prepareRequest.current) return;
    if (result.requestId === prepareRequest.current) {
      prepareRequest.current = null; setPreparing(false);
      // A preparation that went through whole says itself through the refreshed plan; what did
      // not — a refusal, or lines the queue or the local engine would not take — is said in the
      // result's own words (codex round 3). A refusal's token is spent, so the plan is asked again.
      setLinesNotice(result.status === "refused" || /could not be prepared|not queued/.test(result.reason) ? result.reason : "");
      if (result.status === "refused") requestPlan();
    } else planRequest.current = null;
    if (result.plan) setPlan(result.plan);
    else if (result.status === "refused") setLinesNotice(result.reason);
  }), [requestPlan]);
  const cacheJobs = state?.app.jobs.filter((job) => job.target.kind === "table-read-cache" && job.worldId === worldId).map((job) => `${job.id}:${job.status}`).join("|") ?? "";
  // Asked again when the connection comes back: a request that found no studio was never sent.
  useEffect(() => { if (lines.length > 0 && connection === "open") requestPlan(); }, [lines.length, scene.version, production.performanceReview.reviewHash, production.performanceReview.selectionHash, cacheJobs, connection, requestPlan]);
  const playable = plan?.items.filter((item) => item.file !== undefined) ?? [];
  const missing = plan?.items.filter((item) => item.route === "local" || item.route === "cloud") ?? [];
  const playLines = () => {
    if (plan === null || worldSlug === undefined) return;
    const items = plan.items.flatMap((item) => {
      const line = lines.find((candidate) => candidate.id === item.lineId);
      if (item.file === undefined || line?.speakerSheetId === undefined) return [];
      const name = sheets.find((sheet) => sheet.id === line.speakerSheetId)?.name ?? line.speakerSheetId;
      return [{ id: `table/${line.id}`, lineId: line.id, speakerSheetId: line.speakerSheetId, url: mediaUrl(worldSlug, item.file), title: `${name}: ${line.text}` }];
    });
    loadPlaylist(items);
    setPlaylistRate(rate);
    // Soloing a speaker other than the first line's starts the read at their line itself.
    setPlaylistSolo(solo);
    if (solo === null || items[0]?.speakerSheetId === solo) void playPlaylistLine();
  };
  const prepareLines = () => {
    if (plan === null) return;
    setLinesNotice("");
    setPreparing(true);
    prepareRequest.current = prepareTableRead(worldId, production.meta.id, scene.id, plan.confirmationToken, plan.totalEstimatedMicroUsd);
    if (prepareRequest.current === null) { setPreparing(false); setLinesNotice("The studio is disconnected."); }
  };
  const speakers = [...new Set(lines.flatMap((line) => (line.speakerSheetId === undefined ? [] : [line.speakerSheetId])))];
  const [lightboxShotId, setLightboxShotId] = useState<string | null>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);
  const [failedClips, setFailedClips] = useState<ReadonlySet<string>>(() => new Set());
  const [failedFrames, setFailedFrames] = useState<ReadonlySet<string>>(() => new Set());
  const timeRef = useRef(0);
  const viewport = useRef<HTMLDivElement>(null);
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

  // The end holds (R-29), so play pressed there goes back to the top rather than doing nothing.
  const play = () => {
    if (totalSec === 0) return;
    if (timeRef.current >= totalSec) seek(0);
    setPlaying(true);
  };

  useEffect(() => {
    if (timeRef.current <= totalSec) return;
    seek(totalSec);
  }, [seek, totalSec, timeRef]);

  useEffect(() => {
    const node = viewport.current;
    if (node === null) return;
    const measure = () => {
      const box = node.getBoundingClientRect();
      const next = fitPreviewStage(box.width, box.height, aspect);
      setStageSize((current) =>
        current !== null && current.width === next.width && current.height === next.height ? current : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [aspect]);

  const sync = useCallback((span: PreviewSpan | null, nowMs: number) => {
    const requestedClipSrc = span?.clipPath === null || span?.clipPath === undefined || worldSlug === undefined
      ? null
      : mediaUrl(worldSlug, span.clipPath);
    const clipFailed = requestedClipSrc !== null && failedClips.has(requestedClipSrc);
    const clipSrc = requestedClipSrc;
    const frameSrc = span?.framePath === null || span?.framePath === undefined || worldSlug === undefined
      ? null
      : mediaUrl(worldSlug, span.framePath);
    const frameFailed = frameSrc !== null && failedFrames.has(frameSrc);
    const media = video.current;
    const image = still.current;
    if (media !== null) {
      syncMediaElement(media, {
        src: clipSrc,
        targetSec: span === null ? 0 : span.clipInSec + Math.max(0, timeRef.current - span.startSec),
        playing,
        nowMs,
      });
      media.style.opacity = clipSrc === null || clipFailed ? "0" : "1";
    }
    if (image !== null) {
      if ((clipSrc === null || clipFailed) && frameSrc !== null && image.getAttribute("src") !== frameSrc) image.setAttribute("src", frameSrc);
      image.style.opacity = (clipSrc === null || clipFailed) && frameSrc !== null && !frameFailed ? "1" : "0";
    }
  }, [failedClips, failedFrames, playing, timeRef, worldSlug]);

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
  const currentClipSrc = current?.clipPath === null || current?.clipPath === undefined || worldSlug === undefined
    ? null
    : mediaUrl(worldSlug, current.clipPath);
  const currentFrameSrc = current?.framePath === null || current?.framePath === undefined || worldSlug === undefined
    ? null
    : mediaUrl(worldSlug, current.framePath);
  const currentHasPlayableClip = currentClipSrc !== null && !failedClips.has(currentClipSrc);
  const currentHasFrame = currentFrameSrc !== null && !failedFrames.has(currentFrameSrc);
  const currentMediaFailed = !currentHasPlayableClip && (
    (currentClipSrc !== null && failedClips.has(currentClipSrc)) ||
    (currentFrameSrc !== null && failedFrames.has(currentFrameSrc))
  );
  const retryMedia = () => {
    if (currentClipSrc !== null && failedClips.has(currentClipSrc)) video.current?.load();
    if (currentFrameSrc !== null && failedFrames.has(currentFrameSrc) && still.current !== null) {
      const image = still.current;
      image.removeAttribute("src");
      requestAnimationFrame(() => image.setAttribute("src", currentFrameSrc));
    }
  };
  return (
    <section className="fy-swpreview" data-testid="workspace-preview">
      <div ref={viewport} className="fy-swpreview__viewport">
        <div
          className="fy-swpreview__stage"
          style={{
            aspectRatio: aspect.replace(":", " / "),
            ...(stageSize === null ? {} : { width: stageSize.width, height: stageSize.height }),
          }}
        >
          <video
            ref={video}
            playsInline
            muted
            aria-label="Scene preview"
            poster={currentFrameSrc ?? undefined}
            onError={(event) => {
              const failed = event.currentTarget.currentSrc || event.currentTarget.getAttribute("src");
              if (failed === null || failed === "") return;
              setFailedClips((current) => current.has(failed) ? current : new Set([...current, failed]));
            }}
            onCanPlay={(event) => {
              const recovered = event.currentTarget.currentSrc || event.currentTarget.getAttribute("src");
              if (recovered === null || recovered === "") return;
              setFailedClips((current) => {
                if (!current.has(recovered)) return current;
                const next = new Set(current);
                next.delete(recovered);
                return next;
              });
            }}
          />
          <img
            ref={still}
            alt=""
            onError={(event) => {
              const failed = event.currentTarget.currentSrc || event.currentTarget.getAttribute("src");
              if (failed === null || failed === "") return;
              setFailedFrames((current) => current.has(failed) ? current : new Set([...current, failed]));
            }}
            onLoad={(event) => {
              const recovered = event.currentTarget.currentSrc || event.currentTarget.getAttribute("src");
              if (recovered === null || recovered === "") return;
              setFailedFrames((current) => {
                if (!current.has(recovered)) return current;
                const next = new Set(current);
                next.delete(recovered);
                return next;
              });
            }}
          />
          {current !== null && !currentHasFrame && !currentHasPlayableClip ? (
            <span className="fy-swpreview__empty"><ImageMark size={20} /><span>no frame for this shot yet</span></span>
          ) : null}
          {currentMediaFailed ? <button type="button" className="fy-swpreview__retry" onClick={retryMedia}>Retry</button> : null}
          {current === null ? null : (
            <>
              <span className="fy-swpreview__badges">
                <span className="fy-swpreview__shot">shot {current.shot.number}</span>
                <span className="fy-swpreview__kind">{current.blockout ? `${currentHasPlayableClip ? "motion" : "still"} · blockout` : currentHasPlayableClip ? "motion · rendered" : "still · animatic"}</span>
              </span>
              <span className="fy-swpreview__caption">
                <strong>{current.shot.title}</strong>
                <span>{current.shot.framing?.size ?? "shot"}{current.shot.framing?.lens === undefined ? "" : ` · ${current.shot.framing.lens}`} · {(current.endSec - current.startSec).toFixed(1)}s</span>
              </span>
              {current.blockout ? null : <button type="button" className="fy-swpreview__larger" onClick={() => setLightboxShotId(current.shot.id)}>Larger</button>}
            </>
          )}
          {playing || totalSec === 0 ? null : (
            <button type="button" className="fy-swpreview__stageplay" aria-label="Play scene preview" onClick={play}>
              <span className="fy-swpreview__playdisc"><PlaySolid size={20} /></span>
            </button>
          )}
        </div>
      </div>
      <div className="fy-swpreview__controls">
        <div className="fy-swpreview__transport">
          <button
            type="button"
            className="fy-swpreview__toggle"
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => (playing ? setPlaying(false) : play())}
          >
            {playing ? <PauseSolid size={12} /> : <PlaySolid size={12} />}
          </button>
          <button type="button" className="fy-swpreview__restart" aria-label="Restart preview" onClick={() => { seek(0); setPlaying(false); }}>
            <RotateCcw size={14} />
          </button>
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
                    // The prototype only seeks. Here the strip also moves the selection, on
                    // purpose: Arke's subject is the selection (R-1), and the shot you just
                    // seeked to is the one you want to ask about.
                    select({ kind: "shot", shotId: span.shot.id });
                  }}
                >
                  {thumb === null ? null : <span style={{ backgroundImage: `url(${thumb})` }} />}
                </button>
              );
            })}
          </div>
          <span className="fy-swpreview__progress"><span style={{ width: `${totalSec === 0 ? 0 : (time / totalSec) * 100}%` }} /></span>
        </div>
        {lines.length === 0 ? null : (
          <div className="fy-swpreview__lines" aria-label="Lines">
            <button type="button" className="fy-swpreview__lines-play" disabled={playable.length === 0 || worldSlug === undefined} onClick={playLines}>
              <PlaySolid size={10} />Play lines
            </button>
            <label>solo
              <select value={solo ?? ""} onChange={(event) => { const next = event.target.value || null; setSolo(next); setPlaylistSolo(next); }}>
                <option value="">all</option>
                {speakers.map((sheetId) => <option key={sheetId} value={sheetId}>{sheets.find((sheet) => sheet.id === sheetId)?.name ?? sheetId}</option>)}
              </select>
            </label>
            <label>rate
              <select value={rate} onChange={(event) => { const next = Number(event.target.value) as PlaylistState["rate"]; setRate(next); setPlaylistRate(next); }}>
                {[0.75, 1, 1.25, 1.5].map((stop) => <option key={stop} value={stop}>{stop}×</option>)}
              </select>
            </label>
            {plan === null ? null : <span className="fy-swpreview__lines-count">{playable.length} of {lines.length} line{lines.length === 1 ? "" : "s"} {lines.length === 1 ? "has" : "have"} a read</span>}
            {plan === null || missing.length === 0 ? null : (
              <button type="button" className="fy-swpreview__lines-door" disabled={preparing} onClick={prepareLines}>
                Prepare {missing.length} line{missing.length === 1 ? "" : "s"} · {formatMicroUsd(plan.totalEstimatedMicroUsd)}
              </button>
            )}
            {linesNotice === "" ? null : <span role="status" className="fy-swpreview__lines-notice">{linesNotice}</span>}
          </div>
        )}
      </div>
      <p className="fy-swpreview__script">{current?.shot.description ?? ""}</p>
      <ShotLightbox
        scene={scene}
        production={production}
        artifacts={artifacts}
        worldSlug={worldSlug}
        aspect={aspect}
        shotId={lightboxShotId}
        onClose={() => setLightboxShotId(null)}
        onSelectShot={(shotId) => {
          setLightboxShotId(shotId);
          select({ kind: "shot", shotId });
        }}
        onEditShot={onEditShot ?? (() => {})}
        onOpenInGenerator={onOpenShotInGenerator ?? (() => {})}
      />
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { STAGE_FRAME_RATE, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { ReferencePickerDialog, characterPickerSources, worldPickerSources, type PickerSource } from "../../components/reference-picker.js";
import { Button } from "../../components/ui.js";
import { artifactsForProduction } from "../../lib/artifact-view.js";
import { mediaUrl } from "../../lib/media.js";
import { onMediaReady, syncMediaElement } from "../../lib/playback-engine.js";
import { uploadArtifacts } from "../../lib/store.js";
import { takeMediaView } from "../production.js";
import { fitPreviewStage } from "./preview.js";

interface PlateSource extends PickerSource { path: string; inSec: number; outSec?: number }
export function stagePlateSources(world: WorldBundle, production: ProductionBundle, shotId: string): { world: PlateSource[]; characters: PlateSource[]; takes: PlateSource[] } {
  const artifacts = artifactsForProduction(world.artifacts, production.meta.id);
  return {
    world: worldPickerSources(artifacts, null).flatMap(source => {
      const artifact = artifacts.find(item => source.pick.source === "artifact" && item.id === source.pick.artifactId);
      return artifact && (source.kind === "image" || source.kind === "video")
        ? [{ ...source, path: `artifacts/${artifact.file}`, inSec: 0 }] : [];
    }),
    characters: characterPickerSources(world, null).flatMap(source => source.imagePath ? [{ ...source, path: source.imagePath, inSec: 0 }] : []),
    takes: production.takes.filter(take => take.coversShots.includes(shotId) && !take.boardSheetParent).flatMap(take => {
      const media = takeMediaView(production, take);
      if (!media || !["clip", "frame", "still"].includes(take.kind)) return [];
      return [{ key: `take:${take.id}`, kind: media.isVideo ? "video" as const : "image" as const, name: take.id,
        imagePath: media.posterPath, meta: take.model, durationSec: take.segment ? take.segment.outSec - take.segment.inSec : null,
        pick: { source: "take" as const, takeId: take.id }, path: media.sourcePath,
        inSec: take.segment?.inSec ?? 0, ...(take.segment ? { outSec: take.segment.outSec } : {}) }];
    }),
  };
}

/** Editor chrome only: a sibling of the WebGL canvas, never part of the rendered scene (#1049). */
export function StageUnderlay({ world, production, shotId, viewport, aspect, at, playing, visible, disabled, onChoose }: {
  world: WorldBundle; production: ProductionBundle; shotId: string; viewport: HTMLElement | null; aspect: string;
  at: number; playing: boolean; visible: boolean; disabled: boolean; onChoose: () => void;
}) {
  const sources = useMemo(() => stagePlateSources(world, production, shotId), [world, production, shotId]);
  const [sourceKey, setSourceKey] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [opacity, setOpacity] = useState(.5);
  const [offset, setOffset] = useState(0);
  const [layout, setLayout] = useState<"ghost" | "corner">("ghost");
  const [note, setNote] = useState<string | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const video = useRef<HTMLVideoElement | null>(null);
  const previousOffset = useRef(offset);
  const source = [...sources.world, ...sources.characters, ...sources.takes].find(candidate => candidate.key === sourceKey);
  const src = source ? mediaUrl(world.meta.slug, source.path) : null;

  useEffect(() => {
    if (!viewport) return;
    const measure = () => setBox(fitPreviewStage(viewport.clientWidth, viewport.clientHeight, aspect));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport, aspect]);

  const sync = useCallback(() => {
    const element = video.current;
    if (!element || !source || !src) return;
    const end = Math.min(source.outSec ?? Infinity, Number.isFinite(element.duration) ? element.duration : Infinity);
    const last = Math.max(source.inSec, end - 1 / STAGE_FRAME_RATE);
    const requested = source.inSec + at + offset;
    const targetSec = Math.max(source.inSec, Math.min(last, requested));
    const run = visible && playing && requested >= source.inSec && requested < last;
    syncMediaElement(element, { src, targetSec, playing: run, nowMs: Date.now() });
    // Paused matching and offset edits need the selected frame, rather than the player's drift window.
    if (element.readyState >= 2 && (!run || previousOffset.current !== offset) && Math.abs(element.currentTime - targetSec) > 1 / (2 * STAGE_FRAME_RATE)) element.currentTime = targetSec;
    previousOffset.current = offset;
  }, [source, src, at, offset, playing, visible]);
  const latestSync = useRef(sync);
  latestSync.current = sync;
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    onMediaReady(element, () => latestSync.current());
    return () => { if (!element.paused) element.pause(); };
  }, [src, visible, viewport]);
  useEffect(sync, [sync]);

  return <div className="fy-swstage__block">
    <div className="fy-swstage__eyebrow"><span>Reference</span></div>
    <Button size="sm" disabled={disabled} onClick={() => setPicker(true)}>{source ? "Change reference" : "Choose reference"}</Button>
    {source ? <>
      <span className="fy-swstage__quiet">{source.name}</span>
      <label className="fy-swstage__row">View<select aria-label="Reference display" value={layout} disabled={disabled} onChange={event => setLayout(event.target.value as typeof layout)}><option value="ghost">Ghost</option><option value="corner">Corner</option></select></label>
      <label className="fy-swstage__row">Opacity<input aria-label="Reference opacity" type="range" min="0" max="1" step=".05" value={opacity} disabled={disabled} onChange={event => setOpacity(Number(event.target.value))} /></label>
      {source.kind === "video" ? <label className="fy-swstage__row">Offset (s)<input aria-label="Reference time offset" type="number" step=".1" value={offset} disabled={disabled} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) setOffset(value); }} /></label> : null}
      <Button size="sm" disabled={disabled} onClick={() => { setSourceKey(null); setNote(null); }}>Remove reference</Button>
    </> : null}
    {note ? <span className="fy-swstage__quiet" role="status">{note}</span> : null}
    <ReferencePickerDialog open={picker} mode="slot" title="Stage reference" note="Choose a picture or clip to match in Camera view. Imported files appear here when filed."
      budget="none" worldSlug={world.meta.slug} model={null} carried={[]} world={sources.world} session={sources.takes} sessionLabel="Shot takes" characters={sources.characters}
      onChoose={pick => {
        const selected = [...sources.world, ...sources.characters, ...sources.takes].find(candidate => JSON.stringify(candidate.pick) === JSON.stringify(pick));
        if (selected) { setSourceKey(selected.key); setOffset(0); setNote(null); onChoose(); }
        setPicker(false);
      }}
      onUpload={() => { const result = uploadArtifacts(world.meta.worldId, undefined, production.meta.id); setNote(result.reason ?? "Choose the imported file when it appears."); }}
      onClose={() => setPicker(false)} />
    {viewport && visible && source && src ? createPortal(
      <div className="fy-swstage__plate" data-layout={layout} style={{ width: box.width, height: box.height }} aria-label="Stage reference underlay">
        {source.kind === "video"
          ? <video ref={video} key={src} src={src} muted playsInline preload="auto" style={{ opacity }} onError={() => setNote("This reference could not be played.")} />
          : <img src={src} alt="" style={{ opacity }} onError={() => setNote("This reference could not be opened.")} />}
      </div>, viewport) : null}
  </div>;
}

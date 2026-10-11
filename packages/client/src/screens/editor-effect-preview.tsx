import { useCallback, useEffect, useId, useRef, useState } from "react";
import { cueAtSec, type EffectRenderProjection, type RenderPlan } from "@arke-studio/contracts";
import { cx } from "../components/ui.js";
import { PauseSolid, Play } from "../components/icons.js";
import { clock } from "../components/player.js";
import { mediaUrl } from "../lib/media.js";
import { EditorPicturePreview, previewProductionFrame } from "./editor-picture-preview.js";
import { useEffectAnalyses, type EffectAnalysisContext, type EffectPreviewReadiness } from "./editor-effect-analysis.js";
import type { Transport } from "./editor-transport.js";
import type { EffectAuthoringProps } from "../lib/editor-effect-authoring.js";
import { EffectTargetArea } from "./editor-effect-target-area.js";

/** Effects extend the existing viewer; its soundtrack continues to belong to usePlanAudio. */
export function EffectCutPreview({ slug, plan, projection, transport, totalSec, compact = false, analysisContext, effectControls }: {
  slug: string | undefined;
  plan: RenderPlan;
  projection: EffectRenderProjection;
  transport: Transport;
  totalSec: number;
  compact?: boolean;
  analysisContext?: EffectAnalysisContext;
  effectControls?: EffectAuthoringProps;
}) {
  const analysis = useEffectAnalyses(analysisContext, plan, previewProductionFrame(projection, transport.time));
  const [resolution, setResolution] = useState<1 | 0.5>(1);
  const [cue, setCue] = useState(() => cueAtSec(plan, transport.timeRef.current));
  const [editingArea, setEditingArea] = useState<string | null>(null), areaId = useId();
  const [areaFrame, setAreaFrame] = useState(() => previewProductionFrame(projection, transport.timeRef.current));
  const areaActive = effectControls !== undefined && editingArea === effectControls.effect.id;
  const live = useRef({ plan, transport, projection, areaActive });
  live.current = { plan, transport, projection, areaActive };
  useEffect(() => { setEditingArea(null); }, [effectControls?.effect.id]);
  const urlFor = useCallback((path: string) => slug ? mediaUrl(slug, path) : null, [slug]);
  useEffect(() => {
    let animation = 0;
    const sync = () => {
      const next = cueAtSec(live.current.plan, live.current.transport.timeRef.current);
      setCue(previous => previous?.id === next?.id && previous?.text === next?.text ? previous : next);
      if (live.current.areaActive) setAreaFrame(previewProductionFrame(live.current.projection, live.current.transport.timeRef.current));
    };
    const tick = () => { sync(); animation = requestAnimationFrame(tick); };
    sync();
    if (transport.playing) animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [plan, transport.playing, transport.time, areaActive]);
  const style = plan.subtitles?.style;
  const otherIssues = projection.issues.filter(issue => issue.kind !== "analysis-required");
  const reacting = analysis.readiness.filter(row => row.state.status !== "off");
  return <div className={cx("fy-cutviewer fy-cutviewer--effects", effectControls && "fy-cutviewer--effect-controls")}>
    <EditorPicturePreview projection={projection} transport={transport} urlFor={urlFor} resolution={resolution} reactions={analysis.sources}>
      {cue && <span className={cx("fy-cutviewer__cue", style?.background === "box" && "fy-cutviewer__cue--box")} data-cue={cue.id} aria-live="off"
        style={style ? { color: style.color, fontSize: `${(style.relativeSize * 100).toFixed(2)}cqh`, bottom: `${(style.bottomMargin * 100).toFixed(2)}%`,
          textShadow: style.background === "outline" ? "0 0 3px var(--neutral-950), 0 0 6px var(--neutral-950)" : "none" } : undefined}>{cue.text}</span>}
      {areaActive && effectControls && <div id={areaId} className="fx-target-area__stage"><EffectTargetArea {...effectControls} projection={projection} absoluteFrame={transport.playing ? areaFrame : previewProductionFrame(projection, transport.time)} /></div>}
    </EditorPicturePreview>
    <div className={effectControls ? "fx-target-area__toolbar" : undefined}>
    {effectControls && <button type="button" className="fx-target-area__toggle" aria-expanded={areaActive} aria-controls={areaId} disabled={effectControls.disabled} onClick={() => {
      setAreaFrame(previewProductionFrame(projection, transport.timeRef.current));
      setEditingArea(areaActive ? null : effectControls.effect.id);
    }}>{areaActive ? "Done editing area" : "Edit emitting area"}</button>}
    <label className="fy-effectpreview__quality">Preview resolution <select aria-label="Preview resolution" value={resolution} onChange={event => setResolution(event.target.value === "0.5" ? 0.5 : 1)}><option value="1">100%</option><option value="0.5">50%</option></select></label>
    </div>
    {(reacting.length > 0 || otherIssues.length > 0) && <span className="fy-effectpreview__notice" role="status">
      {reacting.map(row => <span key={row.effectId} data-effect-analysis={row.state.status}>
        {row.preview !== "ready" && "Base atmosphere · "}{effectAnalysisLabel(row)}
        {row.reason && <> · {row.reason}</>}
        {row.state.status === "ready" && row.state.cueConflicts.map(conflict => <span key={conflict.cueId}> · Cue {conflict.cueId}: {conflict.reason}</span>)}
        {row.retry && <button type="button" onClick={row.retry}>Retry reaction</button>}
        {row.cancel && <button type="button" onClick={row.cancel}>Cancel analysis</button>}
      </span>)}
      {otherIssues.map(issue => <span key={issue.effectId}>{issue.reason}</span>)}
    </span>}
    {!areaActive && <button type="button" className="fy-playbtn" aria-label={transport.playing ? "Pause" : "Play"} onClick={() => {
      if (!transport.playing && transport.timeRef.current >= totalSec) transport.seek(0);
      transport.setPlaying(value => !value);
    }}>{transport.playing ? <PauseSolid size={22} /> : <Play size={22} />}</button>}
    <span className="fy-viewer__tag">{clock(transport.time)}{!compact && <> / {clock(totalSec)}</>}</span>
  </div>;
}

export function effectAnalysisLabel(row: Pick<EffectPreviewReadiness, "state" | "preview">): string {
  const state = row.state;
  switch (state.status) {
    case "off": return "Reaction Off";
    case "no-source": return "No audio source · Choose an audio source";
    case "source-changed": return "Source changed · Analysis required";
    case "missing-source": return `Missing audio source · ${state.reason}`;
    case "analysing": return `Analysing audio${state.progress === undefined ? "" : ` · ${Math.round(state.progress * 100)}%`}`;
    case "failed": return `Analysis failed · ${state.reason}`;
    case "ready": return row.preview === "loading" ? "Loading reaction preview" : row.preview === "failed" ? "Reaction preview unavailable"
      : state.silent ? "Reaction ready · Source currently silent" : "Reaction ready";
  }
}

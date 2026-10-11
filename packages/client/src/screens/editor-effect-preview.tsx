import { useCallback, useEffect, useRef, useState } from "react";
import { cueAtSec, type EffectRenderProjection, type RenderPlan } from "@arke-studio/contracts";
import { cx } from "../components/ui.js";
import { PauseSolid, Play } from "../components/icons.js";
import { clock } from "../components/player.js";
import { mediaUrl } from "../lib/media.js";
import { EditorPicturePreview } from "./editor-picture-preview.js";
import type { Transport } from "./editor-transport.js";

/** Effects extend the existing viewer; its soundtrack continues to belong to usePlanAudio. */
export function EffectCutPreview({ slug, plan, projection, transport, restartToken, totalSec, compact = false }: {
  slug: string | undefined;
  plan: RenderPlan;
  projection: EffectRenderProjection;
  transport: Transport;
  restartToken: number;
  totalSec: number;
  compact?: boolean;
}) {
  const [resolution, setResolution] = useState<1 | 0.5>(1);
  const [cue, setCue] = useState(() => cueAtSec(plan, transport.timeRef.current));
  const live = useRef({ plan, transport });
  live.current = { plan, transport };
  const urlFor = useCallback((path: string) => slug ? mediaUrl(slug, path) : null, [slug]);
  useEffect(() => {
    if (restartToken === 0) return;
    transport.seek(0); transport.setPlaying(true);
  }, [restartToken]);
  useEffect(() => {
    let animation = 0;
    const sync = () => {
      const next = cueAtSec(live.current.plan, live.current.transport.timeRef.current);
      setCue(previous => previous?.id === next?.id && previous?.text === next?.text ? previous : next);
    };
    const tick = () => { sync(); animation = requestAnimationFrame(tick); };
    sync();
    if (transport.playing) animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [plan, transport.playing, transport.time]);
  const style = plan.subtitles?.style;
  const reactionPending = projection.issues.some(issue => issue.kind === "analysis-required");
  const otherIssues = projection.issues.filter(issue => issue.kind !== "analysis-required");
  return <div className="fy-cutviewer fy-cutviewer--effects">
    <EditorPicturePreview projection={projection} transport={transport} urlFor={urlFor} resolution={resolution}>
      {cue && <span className={cx("fy-cutviewer__cue", style?.background === "box" && "fy-cutviewer__cue--box")} data-cue={cue.id} aria-live="off"
        style={style ? { color: style.color, fontSize: `${(style.relativeSize * 100).toFixed(2)}cqh`, bottom: `${(style.bottomMargin * 100).toFixed(2)}%`,
          textShadow: style.background === "outline" ? "0 0 3px var(--neutral-950), 0 0 6px var(--neutral-950)" : "none" } : undefined}>{cue.text}</span>}
    </EditorPicturePreview>
    <label className="fy-effectpreview__quality">Preview resolution <select aria-label="Preview resolution" value={resolution} onChange={event => setResolution(event.target.value === "0.5" ? 0.5 : 1)}><option value="1">100%</option><option value="0.5">50%</option></select></label>
    {(reactionPending || otherIssues.length > 0) && <span className="fy-effectpreview__notice" role="status">
      {reactionPending && "Base atmosphere preview · Audio reaction needs analysis. Turn reaction Off to export."}
      {otherIssues.map(issue => <span key={issue.effectId}>{issue.reason}</span>)}
    </span>}
    <button type="button" className="fy-playbtn" aria-label={transport.playing ? "Pause" : "Play"} onClick={() => {
      if (!transport.playing && transport.timeRef.current >= totalSec) transport.seek(0);
      transport.setPlaying(value => !value);
    }}>{transport.playing ? <PauseSolid size={22} /> : <Play size={22} />}</button>
    <span className="fy-viewer__tag">{clock(transport.time)}{!compact && <> / {clock(totalSec)}</>}</span>
  </div>;
}

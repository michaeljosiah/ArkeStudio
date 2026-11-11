import { PICTURE_MOTION_DEFAULT_AMOUNT, PICTURE_MOTION_KINDS, type FrameRate, type PictureMotion, type TimelineClip, type TimelineCommand } from "@arke-studio/contracts";
import { EffectNumberField, EffectTimeField } from "./editor-effect-fields.js";

const MOVES: Record<PictureMotion["kind"], string> = { "push-in": "Push in", "pull-out": "Pull out", "drift-left": "Drift left", "drift-right": "Drift right", "drift-up": "Drift up", "drift-down": "Drift down" };

/** Only a still can move; any picture can fade at an edge no crossfade holds. */
export function PictureMotionInspector({ clip, still, frameRate, disabled, onCommands, resetToken }: {
  clip: TimelineClip; still: boolean; frameRate: FrameRate; disabled: boolean; onCommands: (commands: TimelineCommand[], label?: string) => void; resetToken?: number | string;
}) {
  const motion = clip.motion;
  return <section className="fx-inspector picture-motion" aria-label="Picture motion">
    <h3>{still ? "Motion" : "Fade"}</h3>
    {still && <label className="fx-inspector__select">Move<select aria-label="Picture move" value={motion?.kind ?? "none"} disabled={disabled}
      onChange={event => {
        const kind = event.currentTarget.value;
        onCommands([{ kind: "picture-motion", clipId: clip.id, motion: kind === "none" ? null : { kind: kind as PictureMotion["kind"], amount: motion?.amount ?? PICTURE_MOTION_DEFAULT_AMOUNT } }],
          kind === "none" ? "Remove picture motion" : "Set picture motion");
      }}>
      <option value="none">None</option>{PICTURE_MOTION_KINDS.map(kind => <option key={kind} value={kind}>{MOVES[kind]}</option>)}
    </select></label>}
    {still && motion && <EffectNumberField label="Move amount" value={Math.round(motion.amount * 100)} min={1} max={50} step={1} suffix="%" slider disabled={disabled} resetToken={resetToken}
      onCommit={value => onCommands([{ kind: "picture-motion", clipId: clip.id, motion: { kind: motion.kind, amount: value / 100 } }], "Set picture motion")} />}
    <EffectTimeField label="Fade in" value={clip.fade?.inFrames ?? 0} frameRate={frameRate} max={clip.durationFrames} disabled={disabled} resetToken={resetToken}
      onCommit={inFrames => onCommands([{ kind: "picture-fade", clipId: clip.id, inFrames }], "Set picture fade")} />
    <EffectTimeField label="Fade out" value={clip.fade?.outFrames ?? 0} frameRate={frameRate} max={clip.durationFrames} disabled={disabled} resetToken={resetToken}
      onCommit={outFrames => onCommands([{ kind: "picture-fade", clipId: clip.id, outFrames }], "Set picture fade")} />
  </section>;
}

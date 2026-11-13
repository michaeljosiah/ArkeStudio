import { CLIP_SPEED_MAX, CLIP_SPEED_MIN, clipSpeed, type TimelineClip, type TimelineCommand } from "@arke-studio/contracts";
import { EffectNumberField } from "./editor-effect-fields.js";

/** A video's speed and direction (SPEC-037 R-43). Drawn only for a video: a still and a title have neither. */
export function ClipSpeedInspector({ clip, disabled, onCommands, resetToken }: {
  clip: TimelineClip; disabled: boolean; onCommands: (commands: TimelineCommand[], label?: string) => void; resetToken?: number | string;
}) {
  // The record keeps hundredths; a third decimal typed here is rounded, never refused.
  const setSpeed = (speed: number) => onCommands([{ kind: "set-clip-speed", clipId: clip.id, speed: Math.round(speed * 100) / 100 }], "Set clip speed");
  return <section className="fx-inspector clip-speed" aria-label="Clip speed">
    <h3>Speed</h3>
    <EffectNumberField label="Speed" value={clipSpeed(clip)} min={CLIP_SPEED_MIN} max={CLIP_SPEED_MAX} step={0.05} suffix="x" slider disabled={disabled} resetToken={resetToken} onCommit={setSpeed} />
    <label className="fx-inspector__select">Direction<select aria-label="Clip direction" value={clip.reverse ? "backwards" : "forwards"} disabled={disabled}
      onChange={event => {
        const reverse = event.currentTarget.value === "backwards";
        onCommands([{ kind: "set-clip-reverse", clipId: clip.id, reverse }], reverse ? "Play backwards" : "Play forwards");
      }}>
      <option value="forwards">Forwards</option><option value="backwards">Backwards</option>
    </select></label>
  </section>;
}

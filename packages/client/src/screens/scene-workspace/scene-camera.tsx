import type { SceneDefaultsPatch, SceneRecord } from "@arke-studio/contracts";
import { Select } from "../../components/ui.js";
import { CAMERA_FIELDS } from "./shot-fields.js";

/**
 * The scene's side of a shot's "from scene" (issue 3247).
 *
 * Every field on a shot's Camera card inherits from the scene, and until now no screen could
 * write what it inherits: a film's light and look had to be chosen on each shot, nobody chose
 * them, and its frames went out with no word on how they are photographed. The picture model's
 * answer to that silence is a glossy still lit from the camera side.
 *
 * Only the conditions that hold across a scene are offered: the lens and focus a scene is shot
 * on, its light, and its grade. Size, angle and movement are a shot's own decisions, and the
 * scene's time of day already lives in what it inherits from its place; offering it twice here
 * would say "night" to the model twice.
 */
const SCENE_CAMERA_KEYS = ["lens", "focus", "lighting"] as const;

export function SceneCamera({
  scene,
  disabled,
  onCommit,
}: {
  scene: SceneRecord;
  disabled: boolean;
  onCommit: (defaults: SceneDefaultsPatch) => void;
}) {
  const fields = CAMERA_FIELDS.filter((field) => (SCENE_CAMERA_KEYS as readonly string[]).includes(field.key));
  const grade = scene.defaults?.grade ?? "";
  // One field a command, as a shot's card sends one: null is the clear on the wire.
  const set = (key: keyof SceneDefaultsPatch, value: string) => {
    const patch: SceneDefaultsPatch = {};
    patch[key] = value === "" ? null : value;
    onCommit(patch);
  };
  return (
    <div className="fy-sw__camera" role="group" aria-label="Scene camera">
      {fields.map((field) => {
        const value = scene.defaults?.[field.key] ?? "";
        return (
          <label key={field.key} className="fy-sw__camerafield">
            <span>{field.label}</span>
            <Select
              label={`Scene ${field.label}`}
              className="fy-sw__cameraselect"
              wrapClassName="fy-sw__cameraselectwrap"
              value={value}
              disabled={disabled}
              onChange={(event) => set(field.key, event.target.value)}
            >
              <option value="">none</option>
              {/* Arke may write a light the list does not hold; a select that cannot show its own value reads as unset. */}
              {value !== "" && !field.options.includes(value) ? <option value={value}>{value}</option> : null}
              {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
            </Select>
          </label>
        );
      })}
      <label className="fy-sw__camerafield fy-sw__camerafield--wide">
        <span>grade</span>
        <input
          key={grade}
          aria-label="Scene grade"
          defaultValue={grade}
          maxLength={400}
          disabled={disabled}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim();
            if (next !== grade) set("grade", next);
          }}
        />
      </label>
    </div>
  );
}

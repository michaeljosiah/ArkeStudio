import {
  STAGE_MATERIALS,
  STAGE_MATERIAL_LOOKS,
  STAGE_SURFACE_DEFAULTS,
  expandStageSet,
  stageKelvinColour,
  type SceneAtmosphere,
  type StageLight,
  type StageMaterial,
  type StagingSet,
} from "@arke-studio/contracts";
import { Eyebrow, Link, Row, Stepper, Triad } from "./stage-inspector.js";

/**
 * Lights, the scene's Look and what sets are made of (issue 1825, design turn 228e). A light is a
 * practical on the set — a lamp, a neon, a window, the sun — and the Look is the scene's time,
 * sky, haze and shading. Both are the scene's, written with its blocking; neither is a caption,
 * only rows a person sets.
 */

const KINDS: ReadonlyArray<[StageLight["kind"], string]> = [["point", "Point"], ["spot", "Spot"], ["area", "Area"], ["sun", "Sun"]];
const swatch = (material: StageMaterial) => `#${STAGE_MATERIAL_LOOKS[material].colour.toString(16).padStart(6, "0")}`;
const label = (material: StageMaterial) => material[0]!.toUpperCase() + material.slice(1);

export function LightForm({ light, sets, disabled, onChange, onRemove }: {
  light: StageLight;
  sets: readonly StagingSet[];
  disabled: boolean;
  onChange: (next: StageLight) => void;
  onRemove: () => void;
}) {
  const aimName = typeof light.aim === "string" ? light.aim : "";
  return (
    <div className="fy-swstage__block" data-testid="stage-light-form">
      <Eyebrow title="Light" meta={light.name} />
      <Row label="name">
        <input key={light.name} type="text" className="fy-swstage__field" aria-label="Light name" defaultValue={light.name} disabled={disabled} maxLength={80}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
          onBlur={(event) => { const name = event.currentTarget.value.trim(); if (name && name !== light.name) onChange({ ...light, name }); else event.currentTarget.value = light.name; }} />
      </Row>
      <Row label="kind">
        <span className="fy-swstage__chips" role="radiogroup" aria-label="Light kind">
          {KINDS.map(([kind, text]) => (
            <button key={kind} type="button" role="radio" aria-checked={light.kind === kind} data-on={light.kind === kind ? "true" : undefined} disabled={disabled}
              onClick={() => onChange({ ...light, kind })}>{text}</button>
          ))}
        </span>
      </Row>
      <Row label="colour">
        <span className="fy-swstage__lightcolour">
          <span className="fy-swstage__swatch" style={{ background: light.colour }} aria-hidden="true" />
          <Stepper label="colour temperature" value={light.kelvin} placeholder="custom" unit="K" step={100} min={1000} max={20000} decimals={0} disabled={disabled}
            onCommit={(kelvin) => { if (kelvin !== undefined) onChange({ ...light, kelvin, colour: stageKelvinColour(kelvin) }); }} />
        </span>
      </Row>
      <Row label="strength">
        <Stepper label="strength" value={light.strength} step={1} min={0} max={500} decimals={0} disabled={disabled} onCommit={(strength) => { if (strength !== undefined) onChange({ ...light, strength }); }} />
      </Row>
      <Row label="reach">
        <Stepper label="reach" value={light.reach} placeholder="any" unit="m" step={0.5} min={0.5} max={500} decimals={1} disabled={disabled} clearable
          onCommit={(reach) => { const { reach: _reach, ...rest } = light; onChange(reach === undefined ? rest : { ...rest, reach }); }} />
      </Row>
      <Row label="shadow">
        <label className="fy-swstage__check"><input type="checkbox" aria-label="Light casts shadow" checked={light.shadow ?? false} disabled={disabled}
          onChange={(event) => { const { shadow: _shadow, ...rest } = light; onChange(event.target.checked ? { ...rest, shadow: true } : rest); }} /></label>
      </Row>
      <Row label="place">
        <Triad disabled={disabled} cells={[
          { prefix: "x", label: "Light x", value: light.x, onCommit: (x: number) => onChange({ ...light, x }) },
          { prefix: "y", label: "Light height", value: light.y, onCommit: (y: number) => onChange({ ...light, y }) },
          { prefix: "z", label: "Light z", value: light.z, onCommit: (z: number) => onChange({ ...light, z }) },
        ]} />
      </Row>
      {light.kind === "point" ? null : (
        <Row label="aims at">
          <select className="fy-swstage__select" aria-label="Light aims at" value={aimName} disabled={disabled}
            onChange={(event) => { const { aim: _aim, ...rest } = light; onChange(event.target.value === "" ? rest : { ...rest, aim: event.target.value }); }}>
            <option value="">Straight down</option>
            {sets.map((set) => <option key={set.name} value={set.name}>{set.name}</option>)}
          </select>
        </Row>
      )}
      <Row label=""><Link disabled={disabled} onClick={onRemove}>Remove light</Link></Row>
    </div>
  );
}

const TIMES: ReadonlyArray<[NonNullable<SceneAtmosphere["time"]>, string]> = [["day", "Day"], ["dusk", "Dusk"], ["night", "Night"], ["interior", "Interior"]];
const SKIES: ReadonlyArray<[NonNullable<SceneAtmosphere["sky"]>, string]> = [["clear", "Clear"], ["overcast", "Overcast"], ["night-city", "Night city"], ["studio", "Studio"]];

/** The scene's Look: time, sky, haze, shading. */
export function AtmosphereRows({ atmosphere, disabled, onChange }: { atmosphere: SceneAtmosphere | undefined; disabled: boolean; onChange: (next: SceneAtmosphere) => void }) {
  const current = atmosphere ?? {};
  return (
    <div className="fy-swstage__block" data-testid="stage-atmosphere">
      <Eyebrow title="Look" meta="this scene" />
      <Row label="time">
        <select className="fy-swstage__select" aria-label="Time of day" value={current.time ?? "interior"} disabled={disabled}
          onChange={(event) => onChange({ ...current, time: event.target.value as NonNullable<SceneAtmosphere["time"]> })}>
          {TIMES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </Row>
      <Row label="sky">
        <select className="fy-swstage__select" aria-label="Sky" value={current.sky ?? ""} disabled={disabled}
          onChange={(event) => { const { sky: _sky, ...rest } = current; onChange(event.target.value === "" ? rest : { ...rest, sky: event.target.value as NonNullable<SceneAtmosphere["sky"]> }); }}>
          <option value="">For the time</option>
          {SKIES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </Row>
      <Row label="haze">
        <Stepper label="haze" value={current.haze} placeholder="for the time" step={0.005} min={0} max={0.2} decimals={3} disabled={disabled} clearable
          onCommit={(haze) => { const { haze: _haze, ...rest } = current; onChange(haze === undefined ? rest : { ...rest, haze }); }} />
      </Row>
      <Row label="shading">
        <span className="fy-swstage__chips" role="radiogroup" aria-label="Shading">
          {([["soft", "Soft"], ["off", "Off"]] as const).map(([value, text]) => (
            <button key={value} type="button" role="radio" aria-checked={(current.shading ?? "soft") === value} data-on={(current.shading ?? "soft") === value ? "true" : undefined} disabled={disabled}
              onClick={() => onChange({ ...current, shading: value })}>{text}</button>
          ))}
        </span>
      </Row>
    </div>
  );
}

function MaterialSelect({ value, fallback, aria, disabled, onChange }: { value: StageMaterial | undefined; fallback: StageMaterial; aria: string; disabled: boolean; onChange: (next: StageMaterial | undefined) => void }) {
  return (
    <span className="fy-swstage__materialrow">
      <span className="fy-swstage__swatch" style={{ background: swatch(value ?? fallback) }} aria-hidden="true" />
      <select className="fy-swstage__select" aria-label={aria} value={value ?? ""} disabled={disabled} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value as StageMaterial)}>
        <option value="">{label(fallback)}</option>
        {STAGE_MATERIALS.filter((material) => material !== fallback).map((material) => <option key={material} value={material}>{label(material)}</option>)}
      </select>
    </span>
  );
}

/** A plain set's material. */
export function MaterialRow({ set, disabled, onChange }: { set: StagingSet; disabled: boolean; onChange: (material: StageMaterial | undefined) => void }) {
  return <Row label="material"><MaterialSelect value={set.material} fallback="concrete" aria={`${set.name} material`} disabled={disabled} onChange={onChange} /></Row>;
}

/** A kit item's surfaces (228e): one row per surface it has, a room's walls by side. */
export function SurfaceRows({ set, disabled, onChange }: { set: StagingSet; disabled: boolean; onChange: (surfaces: Record<string, StageMaterial> | undefined) => void }) {
  const parts = expandStageSet(set);
  const keys: Array<{ key: string; fallback: StageMaterial }> = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const local = part.name.slice(set.name.length + 3);
    const side = /^(front|back|left|right) wall/.exec(local)?.[0];
    const key = side !== undefined && part.surface === "wall" ? side : part.surface;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ key, fallback: set.material && (part.surface === "wall" || part.surface === "floor") ? set.material : STAGE_SURFACE_DEFAULTS[part.surface] });
  }
  const set1 = (key: string, material: StageMaterial | undefined) => {
    const next: Record<string, StageMaterial> = { ...set.surfaces };
    if (material === undefined) delete next[key]; else next[key] = material;
    onChange(Object.keys(next).length === 0 ? undefined : next);
  };
  return (
    <>
      <Eyebrow title="Surfaces" meta={`${keys.length}`} />
      {keys.map(({ key, fallback }) => (
        <Row key={key} label={key.replace(" wall", "")}>
          <MaterialSelect value={set.surfaces?.[key]} fallback={fallback} aria={`${set.name} ${key}`} disabled={disabled} onChange={(material) => set1(key, material)} />
        </Row>
      ))}
    </>
  );
}

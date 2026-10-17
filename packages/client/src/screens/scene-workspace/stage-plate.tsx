import { useState } from "react";
import { scenePlatePath, stagePlateHorizon, type ScenePlate, type Shot, type WorldBundle } from "@arke-studio/contracts";
import { mediaUrl } from "../../lib/media.js";
import { Eyebrow, Link, Row, Stepper, Value } from "./stage-inspector.js";

/**
 * The location plate on the Stage (issue 1818, design turn 228c): the chip that opens the
 * blockout line, the picker behind it, and the plate's form in the inspector. A plate is a
 * picture of the empty place; the build reads it as the authority on layout and the generator
 * receives it as Image 1. Picked from the world's images, location pictures first — an image
 * artifact carries the hash that pins it.
 */

export interface PlateCandidate {
  id: string;
  hash: string;
  file: string;
  /** The location sheet it is linked to, when it is one's picture: the plate takes its name. */
  location: string | null;
}

/** Image artifacts a plate can be, location pictures first, newest last-filed first within each. */
export function plateCandidates(world: WorldBundle): PlateCandidate[] {
  const superseded = new Set(world.artifacts.flatMap((artifact) => (artifact.supersedes ? [artifact.supersedes] : [])));
  const locations = new Map(world.sheets.filter((sheet) => sheet.type === "location").map((sheet) => [sheet.id, sheet.name]));
  return world.artifacts
    .filter((artifact) => artifact.kind === "image" && !superseded.has(artifact.id))
    .map((artifact) => ({ id: artifact.id, hash: artifact.hash, file: artifact.file, location: artifact.links.map((link) => locations.get(link)).find((name) => name !== undefined) ?? null }))
    .reverse()
    .sort((a, b) => Number(b.location !== null) - Number(a.location !== null))
    .slice(0, 24);
}

export function platePicture(plate: ScenePlate, world: WorldBundle): string | null {
  const path = scenePlatePath(plate, world.artifacts);
  return path === null ? null : mediaUrl(world.meta.slug, path);
}

/** The blockout line's first control: the plate's thumbnail and name, or a dashed Add plate. */
export function PlateChip({ plate, world, disabled, onPick }: {
  plate: ScenePlate | undefined;
  world: WorldBundle;
  disabled: boolean;
  onPick: (candidate: PlateCandidate) => void;
}) {
  const [open, setOpen] = useState(false);
  const picture = plate === undefined ? null : platePicture(plate, world);
  return (
    <span className="fy-swstage__plateanchor">
      <button
        type="button"
        className="fy-swstage__platechip"
        data-empty={plate === undefined ? "true" : undefined}
        data-testid="stage-plate-chip"
        disabled={disabled}
        title="Location plate"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {picture === null ? null : <i style={{ backgroundImage: `url("${picture}")` }} aria-hidden="true" />}
        {plate === undefined ? "Add plate" : `${plate.label} · plate`}
      </button>
      {open ? (
        <>
          <div className="fy-swstage__platescrim" onClick={() => setOpen(false)} />
          <PlatePicker world={world} onPick={(candidate) => { setOpen(false); onPick(candidate); }} />
        </>
      ) : null}
    </span>
  );
}

function PlatePicker({ world, onPick }: { world: WorldBundle; onPick: (candidate: PlateCandidate) => void }) {
  const candidates = plateCandidates(world);
  return (
    <div className="fy-swstage__platepicker" role="listbox" aria-label="Choose a location plate" data-testid="stage-plate-picker">
      {candidates.length === 0 ? <p className="fy-swstage__note">No pictures in this world yet.</p> : candidates.map((candidate) => (
        <button key={candidate.id} type="button" role="option" aria-selected={false} title={candidate.location ?? candidate.file} onClick={() => onPick(candidate)}>
          <i style={{ backgroundImage: `url("${mediaUrl(world.meta.slug, `artifacts/${candidate.file}`)}")` }} aria-hidden="true" />
          <span>{candidate.location ?? "picture"}</span>
        </button>
      ))}
    </div>
  );
}

/** The plate's form (228c): picture and Replace, the shot it matches, its lens and horizon, whether it rides, Match camera. */
export function PlateForm({ plate, world, shots, currentShotId, disabled, onChange, onReplace, onMatch, onRemove }: {
  plate: ScenePlate;
  world: WorldBundle;
  shots: readonly Shot[];
  currentShotId: string;
  disabled: boolean;
  onChange: (next: ScenePlate) => void;
  onReplace: (candidate: PlateCandidate) => void;
  onMatch: () => void;
  onRemove: () => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const picture = platePicture(plate, world);
  const horizon = stagePlateHorizon(plate);
  const matchesHere = plate.shotId === undefined || plate.shotId === currentShotId;
  return (
    <div className="fy-swstage__block" data-testid="stage-plate-form">
      <Eyebrow title="Plate" meta={plate.label} />
      <div className="fy-swstage__platehead">
        {picture === null ? <span className="fy-swstage__platethumb" data-missing="true" /> : <span className="fy-swstage__platethumb" style={{ backgroundImage: `url("${picture}")` }} />}
        <span>
          <input
            key={plate.label}
            type="text"
            className="fy-swstage__field"
            aria-label="Plate name"
            defaultValue={plate.label}
            disabled={disabled}
            maxLength={80}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
            onBlur={(event) => {
              const label = event.currentTarget.value.trim();
              if (label.length > 0 && label !== plate.label) onChange({ ...plate, label });
              else event.currentTarget.value = plate.label;
            }}
          />
          <span className="fy-swstage__plateanchor">
            <Link disabled={disabled} onClick={() => setReplacing((value) => !value)}>Replace</Link>
            {replacing ? (
              <>
                <div className="fy-swstage__platescrim" onClick={() => setReplacing(false)} />
                <PlatePicker world={world} onPick={(candidate) => { setReplacing(false); onReplace(candidate); }} />
              </>
            ) : null}
          </span>
        </span>
      </div>
      <Row label="matches">
        <select
          className="fy-swstage__select"
          aria-label="Shot the plate matches"
          value={plate.shotId ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const { shotId: _shotId, ...rest } = plate;
            onChange(event.target.value === "" ? rest : { ...rest, shotId: event.target.value });
          }}
        >
          <option value="">No shot</option>
          {shots.map((candidate) => <option key={candidate.id} value={candidate.id}>Shot {candidate.number}</option>)}
        </select>
      </Row>
      {plate.camera === undefined ? (
        <Row label="camera"><Value muted>not estimated</Value></Row>
      ) : (
        <>
          <Row label="lens">
          <Stepper label="lens" value={plate.camera.focalMm} unit="mm" step={1} min={8} max={300} decimals={0} disabled={disabled}
            onCommit={(value) => { if (value !== undefined) onChange({ ...plate, camera: { ...plate.camera!, focalMm: value } }); }} />
          </Row>
          <Row label="horizon">
          <Stepper label="horizon" value={horizon ?? undefined} unit="m" step={0.05} min={0.1} max={30} decimals={2} disabled={disabled}
            onCommit={(value) => {
              if (value === undefined) return;
              const camera = plate.camera!;
              // Raising the horizon lifts the camera and its aim together, so the view's pitch holds.
              const lift = value - camera.p[1];
              onChange({ ...plate, camera: { ...camera, p: [camera.p[0], value, camera.p[2]], l: [camera.l[0], camera.l[1] + lift, camera.l[2]] } });
            }} />
          </Row>
        </>
      )}
      <Row label="rides">
        <span className="fy-swstage__chips" role="radiogroup" aria-label="Plate rides">
          {([["Image 1", true], ["Off", false]] as const).map(([label, rides]) => (
            <button key={label} type="button" role="radio" aria-checked={(plate.rides !== false) === rides} data-on={(plate.rides !== false) === rides ? "true" : undefined} disabled={disabled}
              onClick={() => { const { rides: _rides, ...rest } = plate; onChange(rides ? rest : { ...rest, rides: false }); }}>{label}</button>
          ))}
        </span>
      </Row>
      <Row label="">
        <Link disabled={disabled || plate.camera === undefined || !matchesHere} title={plate.camera === undefined ? "Build with Arke estimates the plate's camera" : !matchesHere ? "The plate matches another shot" : undefined} onClick={onMatch}>Match camera</Link>
      </Row>
      <Row label="">
        <Link disabled={disabled} onClick={onRemove}>Remove plate</Link>
      </Row>
    </div>
  );
}

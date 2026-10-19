import { useState } from "react";
import { artifactDisplayName, linkNameResolver, scenePlatePath, stagePlateHorizon, type ScenePlate, type Shot, type WorldBundle } from "@arke-studio/contracts";
import { productionShelf } from "../../lib/artifact-view.js";
import { mediaUrl } from "../../lib/media.js";
import { Eyebrow, Link, Row, Stepper, Value } from "./stage-inspector.js";

/**
 * The location plate on the Stage (issue 1818, design turn 229c): the chip that opens the
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
  /** What the picture is of, as the shelf names it — a tile said "picture" for every one. */
  name: string;
}

/**
 * Image artifacts a plate can be, location pictures first, newest last-filed first within each.
 * Only this production's shelf: another production's scoped pictures are not its to use, and a
 * retired or superseded one is not offered (the coordinator refuses the first either way).
 */
export function plateCandidates(world: WorldBundle, productionId: string): PlateCandidate[] {
  const locations = new Map(world.sheets.filter((sheet) => sheet.type === "location").map((sheet) => [sheet.id, sheet.name]));
  const linkName = linkNameResolver(world);
  return productionShelf(world.artifacts, productionId)
    // The Stage's own stills — a playblast's frames, a board animatic's opening — are renders of the
    // greybox, never a picture of the place, and they crowded out the plates (issue 1865 §9).
    .filter((artifact) => artifact.kind === "image" && !(artifact.origin.by === "system" && /^stage(-board)?:/.test(artifact.origin.producedBy)))
    .map((artifact) => ({
      id: artifact.id, hash: artifact.hash, file: artifact.file,
      location: artifact.links.map((link) => locations.get(link)).find((name) => name !== undefined) ?? null,
      name: artifactDisplayName(artifact, linkName),
    }))
    .reverse()
    .sort((a, b) => Number(b.location !== null) - Number(a.location !== null))
    .slice(0, 24);
}

export function platePicture(plate: ScenePlate, world: WorldBundle): string | null {
  const path = scenePlatePath(plate, world.artifacts);
  return path === null ? null : mediaUrl(world.meta.slug, path);
}

/** The blockout line's first control: the plate's thumbnail and name, or a dashed Add plate. */
export function PlateChip({ plate, world, productionId, disabled, disabledReason, onPick }: {
  plate: ScenePlate | undefined;
  world: WorldBundle;
  productionId: string;
  disabled: boolean;
  /** Why it is shut, when a person can do something about it (issue 1865 §5). */
  disabledReason?: string;
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
        title={disabled && disabledReason !== undefined ? disabledReason : "Location plate"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {picture === null ? null : <i style={{ backgroundImage: `url("${picture}")` }} aria-hidden="true" />}
        {plate === undefined ? "Add plate" : `${plate.label} · plate`}
      </button>
      {open ? (
        <>
          <div className="fy-swstage__platescrim" onClick={() => setOpen(false)} />
          <PlatePicker world={world} productionId={productionId} onPick={(candidate) => { setOpen(false); onPick(candidate); }} />
        </>
      ) : null}
    </span>
  );
}

function PlatePicker({ world, productionId, onPick }: { world: WorldBundle; productionId: string; onPick: (candidate: PlateCandidate) => void }) {
  const candidates = plateCandidates(world, productionId);
  return (
    <div className="fy-swstage__platepicker" role="listbox" aria-label="Choose a location plate" data-testid="stage-plate-picker">
      {candidates.length === 0 ? <p className="fy-swstage__note">No pictures in this world yet.</p> : candidates.map((candidate) => (
        <button key={candidate.id} type="button" role="option" aria-selected={false} title={candidate.location ?? candidate.name} onClick={() => onPick(candidate)}>
          <i style={{ backgroundImage: `url("${mediaUrl(world.meta.slug, `artifacts/${candidate.file}`)}")` }} aria-hidden="true" />
          <span>{candidate.location ?? candidate.name}</span>
        </button>
      ))}
    </div>
  );
}

/** The plate's form (229c): picture and Replace, the shot it matches, its lens and horizon, whether it rides, Match camera. */
export function PlateForm({ plate, world, productionId, shots, currentShotId, disabled, light, onChange, onReplace, onMatch, onRemove }: {
  plate: ScenePlate;
  world: WorldBundle;
  productionId: string;
  shots: readonly Shot[];
  currentShotId: string;
  disabled: boolean;
  /** The scene's light as the plate shows it (229c: "night · warm practicals · 5"). */
  light?: { time: string | undefined; summary: string | undefined };
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
      <Eyebrow title="Plate" meta={light?.time === undefined ? plate.label : `${plate.label} · ${light.time}`} />
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
                <PlatePicker world={world} productionId={productionId} onPick={(candidate) => { setReplacing(false); onReplace(candidate); }} />
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
      {light?.summary === undefined ? null : <Row label="light"><Value muted><span className="fy-swstage__quietmono">{light.summary}</span></Value></Row>}
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

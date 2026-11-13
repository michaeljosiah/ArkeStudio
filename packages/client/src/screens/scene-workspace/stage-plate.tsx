import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { artifactDisplayName, linkNameResolver, orderedLocationViews, productionAspect, scenePlatePath, stagedReferenceKey, stagePlateHorizon, type ScenePlate, type Shot, type SizeTier, type WorldBundle } from "@arke-studio/contracts";
import { productionShelf } from "../../lib/artifact-view.js";
import { mediaUrl } from "../../lib/media.js";
import { clearStagedReference, generateLocationView, pickStagedReference, subscribeQueueResults, uploadArtifacts, useStore } from "../../lib/store.js";
import { resolveModel, worldModel } from "../../components/dispatch-bar.js";
import { BodyLayer } from "../../components/body-layer.js";
import { GenerationDialog } from "../../components/generation-dialog.js";
import { Plus, Search, Upload } from "../../components/icons.js";
import { Button } from "../../components/ui.js";
import { Eyebrow, Link, Row, Stepper, Value } from "./stage-inspector.js";

/**
 * The location plate on the Stage (issue 1818, design turn 229c): the chip that opens the
 * blockout line, the picker behind it, and the plate's form in the inspector. A plate is a
 * picture of the empty place; the build reads it as the authority on layout and the generator
 * receives it as Image 1. Every plate is pinned by its hash.
 */

export interface PlateCandidate {
  /** The tile's key: the artifact's id, or the world file's path. */
  key: string;
  source: ScenePlate["source"];
  /** Where the picture is in the world, for its thumbnail. */
  path: string;
  /** The location sheet it is a picture of, when it is one's: the plate takes its name. */
  location: string | null;
  /** What the tile says: the location and its view, or what the shelf calls the picture. */
  label: string;
  /** The job that made a view still waiting to be named, so a Generate knows its own result. */
  jobId?: string;
}

/**
 * What a plate can be (design turn 231f), the world's location pictures first: each location's
 * accepted views, establishing first, then a view still waiting to be named (a Generate from the
 * location's own flow), then this production's shelf pictures linked to a location, then every
 * other picture on the shelf. A view is its take's file, pinned by the take's hash. Only this
 * production's shelf: another production's scoped pictures are not its to use, and a retired or
 * superseded one is not offered (the coordinator refuses the first either way).
 */
export function plateCandidates(world: WorldBundle, productionId: string): PlateCandidate[] {
  const locations = new Map(world.sheets.filter((sheet) => sheet.type === "location").map((sheet) => [sheet.id, sheet.name]));
  const takes = new Map((world.referenceTakes ?? []).map((take) => [take.id, take]));
  const reviewed = new Set((world.referenceReviews ?? []).map((review) => review.takeId));
  const views: PlateCandidate[] = [];
  for (const kit of world.referenceKits) {
    const location = locations.get(kit.sheetId);
    if (location === undefined) continue;
    for (const view of orderedLocationViews(kit)) {
      const hash = takes.get(view.sourceTakeId)?.mediaHash;
      if (hash === undefined) continue;
      const path = `references/${kit.sheetId}/${view.file}`;
      views.push({ key: path, source: { source: "world-file", path, hash }, path, location, label: view.id === kit.establishingViewId ? location : `${location} · ${view.name}` });
    }
  }
  for (const take of world.referenceTakes ?? []) {
    const sheetId = take.reference?.sheetId;
    const location = sheetId === undefined ? undefined : locations.get(sheetId);
    if (take.kind !== "location-view" || location === undefined || reviewed.has(take.id) || take.media === undefined || take.mediaHash === undefined) continue;
    const path = `references/${sheetId}/takes/${take.id}/${take.media}`;
    views.push({ key: path, source: { source: "world-file", path, hash: take.mediaHash }, path, location, label: `${location} · new`, ...(take.jobId === undefined ? {} : { jobId: take.jobId }) });
  }
  const linkName = linkNameResolver(world);
  const shelf = productionShelf(world.artifacts, productionId)
    // The Stage's own stills — a playblast's frames, a board animatic's opening — are renders of the
    // greybox, never a picture of the place, and they crowded out the plates (issue 1865 §9).
    .filter((artifact) => artifact.kind === "image" && !(artifact.origin.by === "system" && /^stage(-board)?:/.test(artifact.origin.producedBy)))
    .map((artifact): PlateCandidate & { own: string } => {
      const location = artifact.links.map((link) => locations.get(link)).find((name) => name !== undefined) ?? null;
      const own = artifactDisplayName(artifact, linkName);
      return { key: artifact.id, source: { source: "artifact", artifactId: artifact.id, hash: artifact.hash }, path: `artifacts/${artifact.file}`, location, label: location ?? own, own };
    })
    .reverse()
    .sort((a, b) => Number(b.location !== null) - Number(a.location !== null));
  // Two pictures of one place are told apart by their own names after the place's.
  const taken = new Map<string, number>();
  for (const candidate of [...views, ...shelf]) taken.set(candidate.label, (taken.get(candidate.label) ?? 0) + 1);
  const named = shelf.map(({ own, ...candidate }) => (candidate.location !== null && (taken.get(candidate.label) ?? 0) > 1 ? { ...candidate, label: `${candidate.location} · ${own}` } : candidate));
  return [...views, ...named];
}

/** A plate's tile key, so the picker opens on the plate already chosen. */
function plateKey(plate: ScenePlate | undefined): string | null {
  return plate === undefined ? null : plate.source.source === "artifact" ? plate.source.artifactId : plate.source.path;
}

export function platePicture(plate: ScenePlate, world: WorldBundle): string | null {
  const path = scenePlatePath(plate, world.artifacts);
  return path === null ? null : mediaUrl(world.meta.slug, path);
}

/** The blockout line's first control: the plate's thumbnail and name, or a dashed Add plate. */
export function PlateChip({ plate, world, productionId, locationId, disabled, disabledReason, onPick }: {
  plate: ScenePlate | undefined;
  world: WorldBundle;
  productionId: string;
  /** The scene's location, whose own picture flow Generate opens. */
  locationId?: string | undefined;
  disabled: boolean;
  /** Why it is shut, when a person can do something about it (issue 1865 §5). */
  disabledReason?: string;
  onPick: (candidate: PlateCandidate) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
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
        aria-expanded={anchor !== null}
        onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setAnchor((open) => (open === null ? rect : null)); }}
      >
        {picture === null ? null : <i style={{ backgroundImage: `url("${picture}")` }} aria-hidden="true" />}
        {plate === undefined ? "Add plate" : `${plate.label} · plate`}
      </button>
      {anchor === null ? null : (
        <PlatePicker world={world} productionId={productionId} locationId={locationId} current={plateKey(plate)} anchor={anchor}
          onCancel={() => setAnchor(null)} onUse={(candidate) => { setAnchor(null); onPick(candidate); }} />
      )}
    </span>
  );
}

/**
 * The plate picker (design turn 231f): a search, the world's locations by name with a count,
 * Generate and Upload beside them, every other picture behind Show all pictures, and Cancel and
 * Use plate: a pick is chosen first, then placed. Generate is the location's own picture flow and
 * Upload is the world's import; what either brings in is the picture chosen once it lands. It is
 * drawn on the page's body, where neither the inspector's scroll nor the line can clip it.
 */
function PlatePicker({ world, productionId, locationId, current, anchor, onCancel, onUse }: {
  world: WorldBundle;
  productionId: string;
  locationId: string | undefined;
  current: string | null;
  anchor: DOMRect;
  onCancel: () => void;
  onUse: (candidate: PlateCandidate) => void;
}) {
  const candidates = useMemo(() => plateCandidates(world, productionId), [world, productionId]);
  const location = locationId === undefined ? undefined : world.sheets.find((sheet) => sheet.id === locationId && sheet.type === "location");
  const kit = location === undefined ? undefined : world.referenceKits.find((candidate) => candidate.sheetId === location.id);
  const establishing = kit === undefined || orderedLocationViews(kit).length === 0;
  const [query, setQuery] = useState("");
  // Off by default (231f), unless the plate already chosen is one of the other pictures.
  const [showAll, setShowAll] = useState(() => candidates.some((candidate) => candidate.key === current && candidate.location === null));
  const [chosen, setChosen] = useState<string | null>(current);
  const [awaiting, setAwaiting] = useState<{ kind: "upload" | "generate"; requestId: string; known: ReadonlySet<string>; jobs?: readonly string[] } | null>(null);
  const { state } = useStore();
  const search = useRef<HTMLInputElement | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [angle, setAngle] = useState("");
  const [angleName, setAngleName] = useState(establishing ? "Establishing view" : "Plate");
  const [count, setCount] = useState(1);
  const [choice, setChoice] = useState<{ modelId?: string; tier?: SizeTier }>({});
  const generateButton = useRef<HTMLButtonElement | null>(null);
  // What Generate or Upload brought in is the pick once it lands: the first picture the picker did
  // not hold when it was asked for, a location's for Generate.
  useEffect(() => {
    if (awaiting === null) return;
    // A Generate's own result is the view its job made, once the queue has said which jobs those
    // are; until then, a new view of this scene's location (codex on PR 1902): another location's
    // job finishing meanwhile is not this one's.
    const ours = (candidate: PlateCandidate) => awaiting.kind === "upload"
      || (awaiting.jobs !== undefined && candidate.jobId !== undefined ? awaiting.jobs.includes(candidate.jobId) : candidate.location !== null && candidate.location === location?.name);
    const landed = candidates.find((candidate) => !awaiting.known.has(candidate.key) && ours(candidate));
    if (landed === undefined) return;
    setChosen(landed.key);
    if (landed.location === null) setShowAll(true);
    setAwaiting(null);
    setNote(null);
  }, [candidates, awaiting]);
  // A chooser closed with nothing in it, or an import or generation refused, ends the wait with
  // what was said, rather than leaving "importing…" standing over a picker that cannot go on (codex
  // on PR 1902). Generate and Upload stay open meanwhile, so a wait that never lands can be asked again.
  useEffect(() => subscribeQueueResults((result) => {
    if (awaiting === null || result.requestId !== awaiting.requestId) return;
    if (result.disposition !== "rejected" && result.requestedCount > 0) {
      if (result.acceptedJobIds.length > 0) setAwaiting((current) => (current?.requestId === result.requestId ? { ...current, jobs: result.acceptedJobIds } : current));
      return;
    }
    setAwaiting(null);
    setNote(result.failures[0]?.reason ?? null);
  }), [awaiting]);
  // The picker takes the keys while it is open, and gives them back to its trigger when it goes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => { if (opener && typeof opener.focus === "function") opener.focus(); };
  }, []);
  const words = query.trim().toLowerCase();
  const matches = (candidate: PlateCandidate) => words === "" || candidate.label.toLowerCase().includes(words);
  const places = candidates.filter((candidate) => candidate.location !== null && matches(candidate));
  const others = candidates.filter((candidate) => candidate.location === null && matches(candidate));
  const picked = candidates.find((candidate) => candidate.key === chosen);
  const known = () => new Set(candidates.map((candidate) => candidate.key));
  const tile = (candidate: PlateCandidate) => (
    <button key={candidate.key} type="button" role="option" className="fy-plate-picker__tile" aria-selected={candidate.key === chosen}
      data-on={candidate.key === chosen ? "true" : undefined} title={candidate.label} onClick={() => setChosen(candidate.key)}>
      <i style={{ backgroundImage: `url("${mediaUrl(world.meta.slug, candidate.path)}")` }} aria-hidden="true" />
      <span>{candidate.label}</span>
    </button>
  );
  const width = typeof window === "undefined" || typeof window.innerWidth !== "number" ? 1360 : window.innerWidth;
  const height = typeof window === "undefined" || typeof window.innerHeight !== "number" ? 850 : window.innerHeight;
  // Under the trigger with what room is left below, or above it when more is above (codex on PR
  // 1902): from Replace low in the inspector the foot with Cancel and Use plate fell off the window.
  const below = height - anchor.bottom - 18, above = anchor.top - 18;
  const vertical = below >= 320 || below >= above
    ? { top: Math.round(anchor.bottom + 6), maxHeight: Math.max(160, Math.round(below)) }
    : { bottom: Math.round(height - anchor.top + 6), maxHeight: Math.round(above) };
  // Drawn on the body, out of the page's reach: the tiles take the production's aspect from here.
  const meta = world.productions.find((candidate) => candidate.meta.id === productionId)?.meta;
  const position = { ...vertical, left: Math.round(Math.max(12, Math.min(anchor.left, width - 532))), ...(meta === undefined ? {} : { "--shot-aspect": productionAspect(meta).replace(":", " / ") }) } as CSSProperties;
  return (
    <BodyLayer>
      <div className="fy-plate-picker__scrim" onClick={onCancel} />
      <div className="fy-plate-picker" role="dialog" aria-label="Plate" data-testid="stage-plate-picker" style={position}
        onKeyDown={(event) => { if (event.key === "Escape" && !generating) { event.stopPropagation(); onCancel(); } }}>
        <div className="fy-plate-picker__head">
          <b>Plate</b>
          <span className="fy-plate-picker__search">
            <Search size={13} />
            <input ref={search} type="search" aria-label="Search locations" placeholder="Search locations" value={query} onChange={(event) => setQuery(event.target.value)} />
          </span>
        </div>
        <Eyebrow title="Locations" meta={String(places.length)} />
        <div className="fy-plate-picker__tiles" role="listbox" aria-label="Locations">
          {places.map(tile)}
          <div className="fy-plate-picker__makes">
            <button ref={generateButton} type="button" disabled={location === undefined}
              title={location === undefined ? "Give the scene a location first" : `A picture of ${location.name}`} onClick={() => setGenerating(true)}>
              <Plus size={14} />Generate
            </button>
            <button type="button" onClick={() => {
              const result = uploadArtifacts(world.meta.worldId, undefined, productionId);
              if (result.requestId === null) { setNote(result.reason ?? "The picture could not be imported."); return; }
              setAwaiting({ kind: "upload", requestId: result.requestId, known: known() });
              setNote("importing…");
            }}>
              <Upload size={14} />Upload
            </button>
          </div>
        </div>
        <label className="fy-plate-picker__switch">
          <input type="checkbox" role="switch" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
          <span>Show all pictures</span>
        </label>
        {showAll ? (
          <div className="fy-plate-picker__tiles" role="listbox" aria-label="All pictures">
            {others.length === 0 ? <p className="fy-plate-picker__note">No other pictures</p> : others.map(tile)}
          </div>
        ) : null}
        {note === null ? null : <p className="fy-plate-picker__note" role="status">{note}</p>}
        <div className="fy-plate-picker__foot">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={picked === undefined || picked.key === current} onClick={() => { if (picked !== undefined) onUse(picked); }}>Use plate</Button>
        </div>
        {location === undefined ? null : (
          <GenerationDialog
            open={generating}
            onClose={() => setGenerating(false)}
            returnFocus={generateButton}
            title={establishing ? "Generate the establishing view" : "Add a view"}
            lede={establishing ? `${location.name} · establishing view` : `${location.name} · anchored to the establishing view`}
            promptLabel="Where is the camera?"
            prompt={angle}
            onPrompt={setAngle}
            promptOptional
            worldSlug={world.meta.slug}
            extra={
              <label className="fy-locref__namefield">
                <span>What is this angle called?</span>
                <input type="text" value={angleName} maxLength={80} onChange={(event) => setAngleName(event.target.value)} />
              </label>
            }
            reference={world.stagedReferences[stagedReferenceKey("location-view", location.id)] ?? null}
            referenceTarget={{ worldId: world.meta.worldId, key: stagedReferenceKey("location-view", location.id), origin: world.stagedReferenceOrigins[world.stagedReferences[stagedReferenceKey("location-view", location.id)] ?? ""]?.worldName }}
            referenceHint="Optional. A photograph or a plate of the place to work from. The establishing view goes first, so this rides only where the model has room for a second image."
            onAttachReference={() => pickStagedReference(world.meta.worldId, stagedReferenceKey("location-view", location.id))}
            worldReferences={{ world, model: resolveModel(state, "image", choice.modelId, worldModel(state, "image")).model, onChoose: (file) => pickStagedReference(world.meta.worldId, stagedReferenceKey("location-view", location.id), file) }}
            onClearReference={() => clearStagedReference(world.meta.worldId, stagedReferenceKey("location-view", location.id))}
            workflow="location-view"
            referenceImages={establishing ? 0 : 1}
            count={count}
            onCount={setCount}
            choice={choice}
            onChoice={setChoice}
            submitLabel="Generate"
            submitDisabled={angleName.trim() === ""}
            onSubmit={() => {
              const requestId = generateLocationView(world.meta.worldId, location.id, {
                name: angleName.trim(),
                ...(angle.trim() ? { prompt: angle.trim() } : {}),
                count,
                ...(establishing ? { establishing: true } : {}),
              }, { ...(choice.modelId ? { modelId: choice.modelId } : {}), ...(choice.tier ? { tier: choice.tier } : {}) });
              setGenerating(false);
              if (requestId === null) { setNote("The studio is disconnected. Reconnect and try again."); return; }
              setAwaiting({ kind: "generate", requestId, known: known() });
              setNote("generating…");
            }}
          />
        )}
      </div>
    </BodyLayer>
  );
}

/** The plate's form (229c): picture and Replace, the shot it matches, its lens and horizon, whether it rides, Match camera. */
export function PlateForm({ plate, world, productionId, locationId, shots, currentShotId, disabled, light, onChange, onReplace, onMatch, onRemove }: {
  plate: ScenePlate;
  world: WorldBundle;
  productionId: string;
  locationId?: string | undefined;
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
  const [replacing, setReplacing] = useState<DOMRect | null>(null);
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
            <Link disabled={disabled} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setReplacing((open) => (open === null ? rect : null)); }}>Replace</Link>
            {replacing === null ? null : (
              <PlatePicker world={world} productionId={productionId} locationId={locationId} current={plateKey(plate)} anchor={replacing}
                onCancel={() => setReplacing(null)} onUse={(candidate) => { setReplacing(null); onReplace(candidate); }} />
            )}
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

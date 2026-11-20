import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  MAX_PLACE_POSITIONS,
  orderedShots,
  placePictureStale,
  placePositionPicture,
  type PlacePosition,
  type StagingSet,
  type WorldBundle,
} from "@arke-studio/contracts";
import { ImageDialog } from "../components/image-dialog.js";
import { Button } from "../components/ui.js";
import { shortDate } from "../lib/format.js";
import { useOpenWorldGuard, useSheet } from "../lib/selectors.js";
import { changePlacePlan } from "../lib/store.js";
import { LocationHeader } from "./location-reference.js";
import { PlanView, newPlanPosition } from "./scene-workspace/plan.js";
import { planPictureAvailable, renderGreyView } from "./scene-workspace/plan-picture.js";

/** A place has no production, so its pictures and its lenses are read at the frame most are shot in. */
const ASPECT = "16:9";
const NO_SETS: readonly StagingSet[] = [];
const NO_POSITIONS: readonly PlacePosition[] = [];
const NO_CAST: readonly [] = [];

/**
 * The grey view of each position that has no picture yet, by its number. One is rendered a frame,
 * not all at once: a place holds up to 24, each a render of the whole set, and doing them in one
 * go would hold the page still while it opened. A view is kept until its camera or the set moves.
 */
function useGreyViews(sets: readonly StagingSet[], positions: readonly PlacePosition[]): Record<number, string> {
  const [views, setViews] = useState<Record<number, string>>({});
  const kept = useRef<{ sets: string; views: Map<number, { camera: string; picture: string }> }>({ sets: "", views: new Map() });
  const signature = JSON.stringify([sets, positions.map((position) => [position.n, position.p, position.l, position.focalMm])]);
  useEffect(() => {
    if (!planPictureAvailable()) return;
    const built = JSON.stringify(sets);
    if (kept.current.sets !== built) kept.current = { sets: built, views: new Map() };
    const cache = kept.current.views;
    for (const n of cache.keys()) if (!positions.some((position) => position.n === n)) cache.delete(n);
    const camera = (position: PlacePosition) => JSON.stringify([position.p, position.l, position.focalMm]);
    const waiting = positions.filter((position) => cache.get(position.n)?.camera !== camera(position));
    const show = () => setViews(Object.fromEntries([...cache].map(([n, view]) => [n, view.picture])));
    show();
    let frame = 0;
    const step = () => {
      const position = waiting.shift();
      if (position === undefined) return;
      const picture = renderGreyView(sets, position, ASPECT, 480);
      if (picture !== null) {
        cache.set(position.n, { camera: camera(position), picture });
        show();
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return views;
}

/**
 * The first shot of a scene set in this place, on the Stage: where a place with no set yet gets
 * one. A scene whose flow does not read has no first shot to open, and is passed over.
 */
function stageDoor(world: WorldBundle, sheetId: string): string | null {
  for (const production of world.productions) for (const scene of production.scenes) {
    if (scene.inherits?.location !== sheetId) continue;
    let first: string | undefined;
    try {
      first = orderedShots(scene)[0]?.id;
    } catch {
      continue;
    }
    if (first !== undefined) return `/w/${world.meta.worldId}/p/${production.meta.id}/scenes/${scene.id}/shots/${first}?view=stage`;
  }
  return null;
}

/**
 * The Plan on a location's sheet (design turn 285, frame 285d): the place's set from above with no
 * scene's cast, walks or sides on it, and each position as one of Reference's cards with its
 * picture, or its grey view where none is drawn yet.
 */
export function LocationPlanScreen() {
  const { worldId, sheetId } = useParams();
  const navigate = useNavigate();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const plan = world?.placePlans.find((candidate) => candidate.sheetId === sheetId);
  const positions = plan?.positions ?? NO_POSITIONS;
  const undrawn = useMemo(() => positions.filter((position) => placePositionPicture(position, ASPECT) === undefined), [positions]);
  const greys = useGreyViews(plan?.sets ?? NO_SETS, undrawn);
  const [selected, setSelected] = useState<number | null>(null);
  if (!world || !sheet || !sheetId || !worldId) return null;

  const drawn = positions.length - undrawn.length;
  const door = plan === undefined ? stageDoor(world, sheetId) : null;
  return (
    <div data-screen="location-plan">
      <LocationHeader
        worldId={worldId}
        sheetId={sheetId}
        name={sheet.name}
        line={plan === undefined ? sheet.status : `${sheet.status} · set v${plan.version} · ${positions.length} ${positions.length === 1 ? "position" : "positions"}`}
        active="plan"
      />
      {plan === undefined ? (
        // A set is built on the Stage, in a scene set here; with no such scene there is nothing to press.
        door === null ? null : (
          <main className="fy-locref fy-locref--uncompiled">
            <div className="pl-place__foot"><Button variant="outline" onClick={() => navigate(door)}>Open the Stage</Button></div>
          </main>
        )
      ) : (
        <main className="fy-locref fy-locref--uncompiled">
          <section className="fy-locref__views">
            <div className="fy-locref__sechead">
              <h2>Positions</h2>
              <span className="fy-mono">{positions.length}{drawn === 0 ? "" : ` · ${drawn} drawn`}</span>
            </div>
            <div className="pl-place__grid">
              <PlanView
                look="place"
                className="pl-plan__picture--place"
                sets={plan.sets}
                cast={NO_CAST}
                positions={positions}
                selected={positions.some((position) => position.n === selected) ? selected : null}
                aspect={ASPECT}
                fallback={[784, 329]}
                onSelect={setSelected}
              />
              {positions.map((position) => {
                const picture = placePositionPicture(position, ASPECT);
                const grey = greys[position.n];
                return (
                  <article key={position.n} className="fy-locref__view">
                    <div className="fy-locref__viewimage fy-imghost">
                      {picture !== undefined ? (
                        <ImageDialog
                          worldSlug={world.meta.slug}
                          path={`references/${sheetId}/${picture.file}`}
                          label={`${sheet.name}: ${position.name}`}
                          title={sheet.name}
                          subtitle={position.name}
                          triggerLabel={`View larger: ${position.name}`}
                          closeLabel="Close view"
                          triggerClassName="fy-locref__zoom"
                          triggerRadius={6}
                          download
                          downloadName={`${sheet.name} ${position.name}`}
                        />
                      ) : grey === undefined ? null : <img className="fy-portrait" alt={`${sheet.name}: ${position.name}`} src={grey} />}
                    </div>
                    <div className="fy-locref__viewfoot">
                      <div className="fy-locref__viewhead">
                        <span className="fy-locref__panel fy-mono">{position.n}</span>
                        <h3 title={position.name}>{position.name}</h3>
                      </div>
                      <p className="fy-mono">
                        {Number(position.focalMm.toFixed(1))} mm · {picture === undefined ? "no picture" : `picture ${shortDate(picture.acceptedAt)}${placePictureStale(plan, position, picture) ? " · stale" : ""}`}
                      </p>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="pl-place__foot">
              {/* No scene is named: the place has its set already, and its own page has no cast to frame. */}
              <Button
                variant="secondary"
                disabled={positions.length >= MAX_PLACE_POSITIONS}
                onClick={() => { changePlacePlan(worldId, sheetId, newPlanPosition({ cast: NO_CAST, sets: plan.sets }, ASPECT)); }}
              >
                Add position
              </Button>
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

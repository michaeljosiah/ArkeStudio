import { durationOptions, type ManifestModel, type TaskMode } from "@arke-studio/contracts";

/**
 * Everything the length track needs to draw itself, worked out once.
 *
 * It lives here rather than in the screen because the panel is a popover: closed, none of this
 * is in the document, and a test that reads the rendered HTML can only see the pill. The maths
 * is the part worth pinning — the track, its fill, its ends and its handle all have to agree.
 */
export interface DurationTrack {
  /** The lengths on offer, ascending, for the route this job will actually land on. */
  stops: number[];
  /** No length has been asked for: the model's own default, or its "auto". */
  unset: boolean;
  /** A length was chosen that the current route will not make — kept, marked, and refused. */
  overCeiling: boolean;
  min: number;
  max: number;
  value: number;
  /** How much of the track is behind the handle, as a percentage. */
  fill: number;
  /**
   * What attaching a reference costs in length, where the two routes disagree — the figure to
   * show struck at the end of the track. Null when nothing was given up.
   */
  lostToReferences: number | null;
}

/**
 * The track runs from one position *below* its shortest stop to one *above* its ceiling when a
 * length overshoots.
 *
 * Both extra positions exist for the same reason. A range input fires no change when a click
 * lands on the value it already holds, so a handle parked on the first stop made the shortest
 * length — also the cheapest — unreachable, and a handle parked on the ceiling made the one
 * obvious way out of an over-ceiling refusal do nothing. Below the start is also where "unsaid"
 * honestly sits, so the dead ends and the state share one fix.
 */
export function durationTrack(
  model: ManifestModel,
  chosen: number | undefined,
  opts: { taskMode?: TaskMode; withReferences: boolean },
): DurationTrack {
  const stops = durationOptions(model, opts);
  const unset = chosen === undefined;
  const overCeiling = chosen !== undefined && stops.length > 0 && !stops.includes(chosen);
  const min = -1;
  const max = Math.max(0, stops.length - 1) + (overCeiling ? 1 : 0);
  const index = Math.max(0, stops.indexOf(chosen ?? stops[0] ?? 0));
  const value = unset ? min : overCeiling ? max : index;
  const fill = unset || max <= min ? 0 : ((value - min) / (max - min)) * 100;
  const unrestricted = opts.withReferences ? durationOptions(model, { taskMode: opts.taskMode }) : stops;
  const lostToReferences =
    opts.withReferences && unrestricted.length > stops.length
      ? (unrestricted[unrestricted.length - 1] ?? null)
      : null;
  return { stops, unset, overCeiling, min, max, value, fill, lostToReferences };
}

/** What the closed pill says: a length, or the word for having asked for none. */
export function durationPillLabel(model: ManifestModel, chosen: number | undefined): string {
  if (chosen !== undefined) return `${chosen}s`;
  return model.limits.durationAuto === true ? "Auto" : "default";
}

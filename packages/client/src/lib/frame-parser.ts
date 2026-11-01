import { FrameSchema, type Frame } from "@arke-studio/contracts";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The authenticated coordinator validates every outgoing row. Validate the envelope and
 * interactive state here, without cloning its large, already validated historical collections.
 * Other frames (including private replies) still receive their complete schema validation. */
export function parseIncomingFrame(value: unknown): Frame {
  if (!object(value) || value.kind !== "snapshot" || !object(value.state) || !object(value.state.app)) return FrameSchema.parse(value);
  const state = value.state, app = state.app as Record<string, unknown>, world = state.world;
  const jobs = app.jobs, ledger = app.ledger, artifacts = object(world) ? world.artifacts : undefined;
  if (!Array.isArray(jobs) || !Array.isArray(ledger) || world !== null && (!object(world) || !Array.isArray(artifacts))) return FrameSchema.parse(value);
  const frame = FrameSchema.parse({ ...value, state: { ...state, app: { ...app, jobs: [], ledger: [] },
    world: object(world) ? { ...world, artifacts: [] } : world } });
  if (frame.kind !== "snapshot") throw new Error("Expected a snapshot.");
  frame.state.app.jobs = jobs;
  frame.state.app.ledger = ledger;
  if (frame.state.world) frame.state.world.artifacts = artifacts as NonNullable<typeof frame.state.world>["artifacts"];
  return frame;
}

/** Reuse unchanged JSON branches while consuming a fresh parsed tree. Only `next` is mutated;
 * existing subscribers keep immutable values and memoized derived views across snapshots. */
export function shareSnapshot<T>(previous: T | null | undefined, next: T): T {
  if (Object.is(previous, next)) return previous as T;
  if (previous === null || next === null || typeof previous !== "object" || typeof next !== "object" || Array.isArray(previous) !== Array.isArray(next)) return next;
  const before = previous as Record<string, unknown>, after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let same = keys.length === Object.keys(before).length;
  for (const key of keys) {
    if (!Object.hasOwn(before, key)) { same = false; continue; }
    const shared = shareSnapshot(before[key], after[key]);
    if (shared !== before[key]) same = false;
    after[key] = shared;
  }
  return same ? previous as T : next;
}

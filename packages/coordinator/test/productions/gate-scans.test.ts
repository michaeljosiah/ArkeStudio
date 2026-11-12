import assert from "node:assert/strict";
import { it } from "node:test";
import { createEpisode, createScene } from "../../src/productions/ops.js";
import { acceptTake, rejectTake, setTrim } from "../../src/takes/review.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * A gate operation that ends on its commit takes the commit's own refresh (issue 2781). Without
 * `finalWrite: "commit"` the gate scanned the whole world again straight after, so each of these
 * cost two full scans for one write.
 */
it("costs one full scan per gate operation that ends on its commit, and a refusal still reconciles", async () => {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => "2026-11-08T10:00:00.000Z" });
  closeOnCleanup(() => store.close());
  const scans = { n: 0 };
  const live = store as unknown as { rescan: (paths?: string[]) => Promise<void> };
  const rescan = live.rescan.bind(store);
  live.rescan = (paths) => { scans.n++; return rescan(paths); };
  const counted = async (work: () => Promise<unknown>) => { scans.n = 0; await work(); return scans.n; };
  const saltlight = () => store.getBundle().productions.find((production) => production.meta.id === "saltlight")!;

  assert.equal(await counted(() => createEpisode(store, { productionId: "saltlight", title: "Pilot" })), 1, "creating an episode");
  assert.equal(await counted(() => createScene(store, { productionId: "saltlight", title: "Harbour wall" })), 1, "creating a scene");
  assert.equal(await counted(() => acceptTake(store, saltlight(), { takeId: "tk_01J8F0000000000000000000B2", shotId: "sh_12", by: "user" })), 1, "accepting a take");
  assert.equal(await counted(() => setTrim(store, saltlight(), { shotId: "sh_12", trimInSec: 0.5 })), 1, "trimming a shot");
  assert.equal(await counted(() => rejectTake(store, saltlight(), { takeId: "tk_01J8A0000000000000000000A1", by: "user",
    citation: { sheet: "maren-kest", field: "Appearance" } })), 1, "rejecting a take");

  scans.n = 0;
  await assert.rejects(createScene(store, { productionId: "no-such-production", title: "Lost" }));
  assert.equal(scans.n, 1, "a refused operation made no commit, so it still reconciles with a scan");
});

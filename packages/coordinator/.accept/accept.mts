// Acceptance on a copy of the Juju world: plan, run the default ticks, hold one old export, restore it.
import { randomUUID } from "node:crypto";
import { WorldStore } from "../src/world/store.js";
import { WorldCleanup } from "../src/cleanup/service.js";
import type { WorldCleanupAnswer, WorldCleanupOp } from "@arke-studio/contracts";

const dir = process.argv[2]!, root = process.argv[3] ?? null, mode = process.argv[4] ?? "plan";
const gib = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GiB`;
const store = await WorldStore.open(dir);
const cleanup = new WorldCleanup({
  openStore: () => store, appRoot: () => root, benchChanged: async () => {}, keep: async () => {}, serialiseTake: (_k, w) => w(),
  pinned: () => false, refreshWorld: async () => {}, log: e => console.log("log", JSON.stringify(e)),
});
const ask = (request: WorldCleanupOp) => new Promise<Extract<WorldCleanupAnswer, { ok: true }>>((res, rej) =>
  void cleanup.handle({ kind: "world-cleanup", requestId: randomUUID(), worldId: store.worldId, request }, a => a.ok ? res(a) : rej(new Error(a.reason))));
let t = performance.now();
const { plan, status } = await ask({ op: "plan" });
console.log(`plan in ${((performance.now() - t) / 1000).toFixed(1)} s; refusal ${status.refusal}; held plans ${status.held.length}`);
for (const row of plan!.classes) console.log(row.class.padEnd(20), row.state, row.stoppedBy ?? "", row.items, gib(row.bytes));
for (const p of plan!.problems) console.log("problem", p.kind, p.label, p.count, p.bytes === null ? "" : gib(p.bytes));
console.log("retired without media", plan!.retiredWithoutMedia);
for (const cls of ["old-exports", "unkept-bench-takes", "unused-artifacts", "audiobook-takes"]) console.log(cls, plan!.items.filter(i => i.class === cls).slice(0, 4).map(i => `${i.label}${i.covers ? ` (${i.covers})` : ""}${i.group ? ` [${i.group}]` : ""}`));
if (mode === "run") {
  const ticked = plan!.items.filter(i => i.ticked).map(i => i.id);
  const oneExport = plan!.items.find(i => i.class === "old-exports");
  t = performance.now();
  await ask({ op: "run", planId: plan!.id, items: [...ticked, ...(oneExport ? [oneExport.id] : [])] });
  let s = status;
  while ((s = (await ask({ op: "status" })).status).running) await new Promise(r => setTimeout(r, 500));
  console.log(`run in ${((performance.now() - t) / 1000).toFixed(1)} s`, JSON.stringify(s.run, null, 1));
  console.log("held", JSON.stringify(s.held.map(h => ({ ...h, items: h.items.length }))));
  if (oneExport) { const r = await ask({ op: "restore", planId: plan!.id }); console.log("restored; held now", r.status.held.length, r.note ?? ""); }
}
await store.close();

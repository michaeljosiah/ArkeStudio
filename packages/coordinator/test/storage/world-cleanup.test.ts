import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ulid, type WorldCleanupAnswer, type WorldCleanupOp } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { openBenchSession } from "../../src/bench/service.js";
import { WorldCleanup } from "../../src/cleanup/service.js";
import { takeCensus, namedElsewhere } from "../../src/cleanup/census.js";
import { Ledger, readLedger, unsettled } from "../../src/cleanup/ledger.js";
import { sha256 } from "../../src/world/text-files.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup, tempDir } from "../tmp.js";

const DAY = 86_400_000;

async function world() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir);
  closeOnCleanup(() => store.close());
  let now = Date.now();
  const cleanup = new WorldCleanup({
    openStore: () => store, appRoot: () => null, now: () => now,
    benchChanged: async () => {}, keep: async () => {}, serialiseTake: (_key, work) => work(),
    pinned: () => false, refreshWorld: async () => {}, log: () => {},
  });
  const ask = (request: WorldCleanupOp) => new Promise<Extract<WorldCleanupAnswer, { ok: true }>>((resolve, reject) =>
    void cleanup.handle({ kind: "world-cleanup", requestId: randomUUID(), worldId: store.worldId, request }, answer => answer.ok ? resolve(answer) : reject(new Error(answer.reason))));
  const settle = async () => { for (let i = 0; i < 200; i++) { const { status } = await ask({ op: "status" }); if (!status.running) return status; await new Promise(r => setTimeout(r, 10)); } throw new Error("run never ended"); };
  return { dir, store, cleanup, ask, settle, tick: (ms: number) => { now += ms; } };
}

/** An artifact filed through the one commit primitive, as filing does. */
async function artifact(store: WorldStore, file: string, bytes: Buffer, extra: Record<string, unknown> = {}) {
  await writeFile(join(store.dir, "artifacts", file), bytes);
  const sidecar = { id: `ar_${ulid()}`, kind: "image", file, hash: sha256(bytes).slice(0, "sha256:".length + 16), origin: { by: "user" }, links: [], created: new Date().toISOString(), ...extra };
  await store.commit({ kind: "artifact-file", source: "test", files: [{ path: `artifacts/${file}.json`, action: "create", content: JSON.stringify(sidecar, null, 2) + "\n", baseHash: null }] });
  return sidecar;
}

describe("world clean-up (SPEC-066)", () => {
  it("plans without writing, then links a Bench copy to its artifact (R-12, R-32)", async () => {
    const { dir, store, ask, settle } = await world();
    const bytes = randomBytes(20_000);
    const kept = await artifact(store, "kept.png", bytes);
    const bench = await openBenchSession(dir, () => new Date().toISOString(), { fresh: true, defaultModel: { provider: "fal", model: "x" } });
    assert.ok(bench);
    const take = `tk_${ulid()}`, copy = join(dir, ".sessions", bench.session.id, "media", take);
    await mkdir(copy, { recursive: true });
    await writeFile(join(copy, "take.png"), bytes);
    // The session names the artifact, so the census keeps it.
    await bench.store.append({ type: "take-filed", takeId: take as never, artifactId: kept.id as never }, { at: new Date().toISOString() });
    const before = await readdir(dir);
    const { plan } = await ask({ op: "plan" });
    assert.deepEqual(await readdir(dir), before, "planning writes nothing");
    const item = plan!.items.find(i => i.class === "bench-copies");
    assert.ok(item, "the Bench copy is offered as a link");
    assert.equal(item.ticked, true);
    assert.equal(item.bytes, 20_000);
    assert.equal(plan!.items.some(i => i.class === "unused-artifacts" && i.label.startsWith("kept.png")), false, "a named artifact is never offered");
    await ask({ op: "run", planId: plan!.id, items: [item.id] });
    const status = await settle();
    assert.equal(status.run?.classes[0]?.done, 1);
    const [a, b] = await Promise.all([lstat(join(dir, "artifacts", "kept.png")), lstat(join(copy, "take.png"))]);
    assert.equal(a.ino, b.ino, "one file, two names");
    assert.equal(a.nlink, 2);
    assert.deepEqual(await readFile(join(copy, "take.png")), bytes);
    const lines = await readLedger(dir);
    assert.deepEqual(lines.map(l => l.kind), ["plan", "intent", "outcome", "end"]);
    assert.equal(unsettled(lines).length, 0);
    assert.doesNotMatch(await readFile(join(dir, "cleanup.jsonl"), "utf8"), /[A-Z]:\\|"ino"|"dev"/, "no absolute path or identity in the ledger");
    // A plan runs once (R-13).
    await assert.rejects(ask({ op: "run", planId: plan!.id, items: [item.id] }), /Plan again/);
  });

  it("holds an unused artifact, restores it, holds it again and lets it go after its hold (R-28 – R-31, R-39)", async () => {
    const { dir, store, ask, settle, tick } = await world();
    const orphan = await artifact(store, "orphan.png", randomBytes(9_000));
    let { plan } = await ask({ op: "plan" });
    let item = plan!.items.find(i => i.class === "unused-artifacts" && i.label === "orphan.png");
    assert.ok(item, "an artifact nothing names is offered");
    assert.equal(item.ticked, false, "deletion is never ticked by default");
    await ask({ op: "run", planId: plan!.id, items: [item.id] });
    let status = await settle();
    assert.equal(status.run?.held, 9_000);
    assert.equal(await lstat(join(dir, "artifacts", "orphan.png")).catch(() => null), null);
    assert.equal(await lstat(join(dir, "artifacts", "orphan.png.json")).catch(() => null), null, "the sidecar goes through a commit");
    assert.ok(await lstat(join(dir, ".held", plan!.id, "artifacts", "orphan.png")));
    assert.equal(store.getBundle().artifacts.some(a => a.id === orphan.id), false);
    assert.equal(status.held.length, 1);
    assert.equal(status.held[0]!.state, "held");

    await ask({ op: "restore", planId: plan!.id });
    assert.ok(await lstat(join(dir, "artifacts", "orphan.png")));
    assert.ok(store.getBundle().artifacts.some(a => a.id === orphan.id), "restored with its record");
    assert.equal((await ask({ op: "status" })).status.held.length, 0);

    ({ plan } = await ask({ op: "plan" }));
    item = plan!.items.find(i => i.label === "orphan.png")!;
    await ask({ op: "run", planId: plan!.id, items: [item.id] });
    await settle();
    // Not yet: the hold has 30 days and a day after it before an opening lets it go.
    tick(30 * DAY);
    await ask({ op: "plan" });
    assert.ok(await lstat(join(dir, ".held", plan!.id, "artifacts", "orphan.png")));
    status = (await ask({ op: "status" })).status;
    assert.equal(status.held[0]!.state, "ended");
    tick(DAY + 1);
    await ask({ op: "plan" });
    assert.equal(await lstat(join(dir, ".held")).catch(() => null), null, "the files and their empty folders are gone");
    assert.equal((await ask({ op: "status" })).status.held.length, 0);
  });

  it("Empty now removes a plan's held files before its hold ends (R-31)", async () => {
    const { dir, store, ask, settle } = await world();
    await artifact(store, "gone.png", randomBytes(5_000));
    const { plan } = await ask({ op: "plan" });
    const item = plan!.items.find(i => i.label === "gone.png")!;
    await ask({ op: "run", planId: plan!.id, items: [item.id] });
    await settle();
    await ask({ op: "empty", planId: plan!.id });
    assert.equal(await lstat(join(dir, ".held", plan!.id)).catch(() => null), null);
  });

  it("holds an unkept Bench take and restores it with its number (R-37)", async () => {
    const { dir, store, ask, settle, tick } = await world();
    const bench = await openBenchSession(dir, () => new Date().toISOString(), { fresh: true, defaultModel: { provider: "fal", model: "x" } });
    assert.ok(bench);
    const takeId = `tk_${ulid()}`, at = new Date(Date.now() - 8 * DAY).toISOString();
    const request = { mode: "image", brief: "a quiet street", references: [], keyframes: [], provider: "fal", model: "x", params: { kind: "image", count: 1 } };
    await bench.store.append({ type: "takes-reserved", takes: [{ id: takeId, n: 1, requestId: "r1", request, createdAt: at }] } as never, { at });
    await bench.store.append({ type: "take-completed", takeId: takeId as never, media: { file: "take.png", hash: "sha256:0123456789abcdef" } as never, completedAt: at }, { at });
    const media = join(dir, ".sessions", bench.session.id, "media", takeId);
    await mkdir(media, { recursive: true });
    await writeFile(join(media, "take.png"), randomBytes(3000));
    assert.equal((await bench.store.fold())?.takes[0]?.status, "succeeded");
    const { plan } = await ask({ op: "plan" });
    const item = plan!.items.find(i => i.class === "unkept-bench-takes");
    assert.ok(item, "a never-kept take a week old is offered");
    await ask({ op: "run", planId: plan!.id, items: [item.id] });
    await settle();
    assert.equal((await bench.store.fold())?.takes.some(t => t.id === takeId), false);
    assert.ok(await lstat(join(dir, ".held", plan!.id, ".sessions", bench.session.id, "media", takeId, "take.png")));
    tick(DAY);
    await ask({ op: "restore", planId: plan!.id });
    const back = await bench.store.fold();
    assert.equal(back?.takes.find(t => t.id === takeId)?.n, 1, "the take comes back with its number");
    assert.ok(await lstat(join(media, "take.png")));
    assert.ok(store.schemaVersion >= 131, "the world's floor is raised before take-restored");
  });

  it("settles a hold a crash cut short: no record changed, so the files come back (R-24)", async () => {
    const { dir, store, cleanup } = await world();
    const side = await artifact(store, "half.png", randomBytes(4_000));
    const planId = `cp_${ulid()}`, ledger = new Ledger(dir, () => new Date().toISOString());
    const sidecarText = await readFile(join(dir, "artifacts", "half.png.json"), "utf8");
    await ledger.append({ kind: "plan", planId, holdUntil: null, items: 1 });
    await ledger.append({ kind: "intent", op: "run", planId, item: { id: "ci_1", class: "unused-artifacts", action: "hold", label: "half.png", bytes: 4000, paths: ["artifacts/half.png", "artifacts/half.png.json"], files: [{ path: "artifacts/half.png", size: 4000, mtimeMs: 0 }], sidecar: { path: "artifacts/half.png.json", text: sidecarText } } });
    // The crash: the media moved, the sidecar's commit never ran.
    await mkdir(join(dir, ".held", planId, "artifacts"), { recursive: true });
    await rename(join(dir, "artifacts", "half.png"), join(dir, ".held", planId, "artifacts", "half.png"));
    await cleanup.opened(store);
    assert.ok(await lstat(join(dir, "artifacts", "half.png")), "rolled back");
    assert.equal(unsettled(await readLedger(dir)).length, 0);
    assert.ok(store.getBundle().artifacts.some(a => a.id === side.id));
  });

  it("keeps a take a chapter record names under a key a join folded away (§3.2, Appendix A)", async () => {
    const dir = await tempDir("arke-census-");
    await mkdir(join(dir, "productions", "book", "audiobook"), { recursive: true });
    await mkdir(join(dir, "artifacts"), { recursive: true });
    const current = `ar_${ulid()}`, folded = `ar_${ulid()}`, loose = `ar_${ulid()}`;
    // p3.1 is a block today; p3.2 was joined into it by Group by beats, and its take is kept so the join can be undone.
    await writeFile(join(dir, "productions", "book", "audiobook", "chapter-7.json"), JSON.stringify({ takes: { "p3.1": { artifactId: current }, "p3.2": { artifactId: folded } } }));
    for (const id of [current, folded, loose]) await writeFile(join(dir, "artifacts", `${id}.wav.json`), JSON.stringify({ id, file: `${id}.wav` }));
    const census = await takeCensus(dir, null, new Set([`${current}.wav`, `${folded}.wav`, `${loose}.wav`]), new AbortController().signal);
    assert.equal(namedElsewhere(census.named.get(folded), `side:${folded}`), true, "a folded key is still a key");
    assert.equal(namedElsewhere(census.named.get(current), `side:${current}`), true);
    assert.equal(namedElsewhere(census.named.get(loose), `side:${loose}`), false, "only a take nothing names is a candidate");
    assert.equal(census.unreadable, null);
  });

  it("leaves an artifact a record named after the plan was made (R-21; Codex on PR 3052)", async () => {
    const { dir, store, ask, settle } = await world();
    const late = await artifact(store, "late.png", randomBytes(6_000));
    const { plan } = await ask({ op: "plan" });
    const item = plan!.items.find(i => i.label === "late.png")!;
    // A chapter places the picture after the sheet opened: only that record names it.
    const bench = await openBenchSession(dir, () => new Date().toISOString(), { fresh: true, defaultModel: { provider: "fal", model: "x" } });
    await bench!.store.append({ type: "take-filed", takeId: `tk_${ulid()}` as never, artifactId: late.id as never }, { at: new Date().toISOString() });
    await ask({ op: "run", planId: plan!.id, items: [item.id] });
    const status = await settle();
    assert.equal(status.run?.classes[0]?.skipped, 1);
    assert.deepEqual(status.run?.classes[0]?.reasons, ["In use since plan"]);
    assert.ok(await lstat(join(dir, "artifacts", "late.png")));
  });

  it("reads no ledger line that names a path outside the world (Codex on PR 3052)", async () => {
    const dir = await tempDir("arke-ledger-paths-");
    const planId = `cp_${ulid()}`, at = new Date().toISOString();
    const item = (path: string) => ({ id: "ci_1", class: "old-exports", action: "hold", label: "x", bytes: 1, paths: [path], files: [{ path, size: 1, mtimeMs: 0 }] });
    await writeFile(join(dir, "cleanup.jsonl"), [
      { v: 1, kind: "intent", at, op: "run", planId: "..", item: item("exports/a.mp4") },
      { v: 1, kind: "intent", at, op: "run", planId, item: item("../other-world/world.json") },
      { v: 1, kind: "intent", at, op: "run", planId, item: item("C:/Windows/win.ini") },
      { v: 1, kind: "intent", at, op: "run", planId, item: item("exports/fine.mp4") },
    ].map(line => JSON.stringify(line)).join("\n") + "\n");
    const lines = await readLedger(dir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.kind === "intent" ? lines[0]!.item.paths[0] : null, "exports/fine.mp4");
  });

  it("finishes an export restore a crash cut short (Codex on PR 3052)", async () => {
    const { dir, store, cleanup } = await world();
    const planId = `cp_${ulid()}`, ledger = new Ledger(dir, () => new Date().toISOString());
    await mkdir(join(dir, ".held", planId, "exports"), { recursive: true });
    await writeFile(join(dir, ".held", planId, "exports", "book.zip.json"), "{}");
    await mkdir(join(dir, "exports"), { recursive: true });
    await writeFile(join(dir, "exports", "book.zip"), "zip");
    await ledger.append({ kind: "intent", op: "restore", planId, item: { id: "ci_1", class: "old-exports", action: "hold", label: "Player edition", bytes: 5, paths: ["exports/book.zip", "exports/book.zip.json"], files: [{ path: "exports/book.zip", size: 3, mtimeMs: 0 }, { path: "exports/book.zip.json", size: 2, mtimeMs: 0 }] } });
    await cleanup.opened(store);
    assert.ok(await lstat(join(dir, "exports", "book.zip.json")), "the rest of the unit came back");
    assert.equal(unsettled(await readLedger(dir)).length, 0);
  });

  it("admits one run at a time, and a plan's items go together at its longest hold (Codex on PR 3052)", async () => {
    const { dir, store, ask, settle, tick } = await world();
    await artifact(store, "solo.png", randomBytes(4_000));
    await mkdir(join(dir, "exports"), { recursive: true });
    await writeFile(join(dir, "exports", "promo-20261101120000.mp4"), randomBytes(3_000));
    await new Promise(r => setTimeout(r, 20));
    await writeFile(join(dir, "exports", "promo-20261102120000.mp4"), randomBytes(3_000));
    const first = (await ask({ op: "plan" })).plan!, second = (await ask({ op: "plan" })).plan!;
    const ids = first.items.filter(i => i.label === "solo.png" || i.class === "old-exports").map(i => i.id);
    assert.equal(ids.length, 2, "the artifact and the older export are offered");
    const a = ask({ op: "run", planId: first.id, items: ids });
    await assert.rejects(ask({ op: "run", planId: second.id, items: [second.items[0]!.id] }), /Running/);
    await a;
    await settle();
    // Eight days on, the export's own 7 days are over, but the card says the plan holds 30: nothing goes.
    tick(8 * 86_400_000 + 1);
    await ask({ op: "plan" });
    assert.ok(await lstat(join(dir, ".held", first.id, "exports", "promo-20261101120000.mp4")));
    tick(23 * 86_400_000);
    await ask({ op: "plan" });
    assert.equal(await lstat(join(dir, ".held")).catch(() => null), null);
  });

  it("never offers a retired artifact, and counts a retired one with no file apart (Codex on PR 3052)", async () => {
    const { dir, store, ask } = await world();
    await artifact(store, "retired.png", randomBytes(4_000), { retiredAt: new Date().toISOString() });
    await artifact(store, "retired-gone.png", randomBytes(4_000), { retiredAt: new Date().toISOString() });
    await rm(join(dir, "artifacts", "retired-gone.png"));
    const { plan } = await ask({ op: "plan" });
    assert.equal(plan!.items.some(i => i.label.startsWith("retired")), false);
    assert.equal(plan!.retiredWithoutMedia, 1);
    assert.equal(plan!.problems.some(p => p.kind === "missing-media" && p.label.startsWith("Artifacts")), false);
  });

  it("the ledger skips a torn last line and the next append starts on its own line (R-19)", async () => {
    const dir = await tempDir("arke-ledger-");
    await writeFile(join(dir, "cleanup.jsonl"), `${JSON.stringify({ v: 1, kind: "setting", at: new Date().toISOString(), autoMixes: true })}\n{"v":1,"kind":"inte`);
    assert.equal((await readLedger(dir)).length, 1);
    await new Ledger(dir, () => new Date().toISOString()).append({ kind: "setting", autoMixes: false });
    const lines = await readLedger(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines.at(-1)?.kind === "setting" && lines.at(-1)!.kind === "setting" ? (lines.at(-1) as { autoMixes: boolean }).autoMixes : null, false);
  });
});

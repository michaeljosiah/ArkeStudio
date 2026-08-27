import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent, WorldBundle } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "./helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * A world that will not open says so (issue 571).
 *
 * `open-world` used to catch every failure and drop it: the throw lands before both
 * `world.opened` and the snapshot that follows it, so the screen sat on "opening the world"
 * indefinitely while `app.jsonl` and `coordinator.jsonl` held nothing at all. The world in the
 * report was refused by its own derived `.index/` — moving that directory aside opened it at
 * once — and no part of the app was in a position to say so.
 */

const CLOCK = "2026-08-27T12:00:00.000Z";
const SNAPSHOT = join(".history", "characters", "bray-half-hitch", "v6.md");

type OpenFailed = Extract<DomainEvent, { type: "world.open-failed" }>;

async function harness(root: string) {
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  closeOnCleanup(() => provider.close());
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    appRoot: root,
    changeLogPath: join(root, "logs", "coordinator.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
  });
  const send = (msg: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
  const state = () => coordinator.getState();
  // The post-load and lost-race paths cannot be reached through a message: by construction the
  // world is already open by the time they throw.
  const fail = (worldId: string, err: unknown) =>
    (coordinator as unknown as { failWorldOpen(worldId: string, err: unknown): Promise<void> }).failWorldOpen(
      worldId,
      err,
    );
  // An ordinary refresh of whichever world is open — what a media-backfill callback or an
  // adopted Bible edit does, and the path that used to wipe an unrelated world's refusal.
  const refresh = (bundle: WorldBundle) =>
    (coordinator as unknown as { readModel: { setWorld(b: WorldBundle): void } }).readModel.setWorld(bundle);
  const repair = (worldId: string, step: string, run: () => unknown) =>
    (
      coordinator as unknown as {
        repairOnOpen(worldId: string, step: string, run: () => unknown): Promise<void>;
      }
    ).repairOnOpen(worldId, step, run);
  const failures = () => events.filter((e): e is OpenFailed => e.type === "world.open-failed");
  return { provider, events, send, state, fail, refresh, repair, failures };
}

/**
 * Make the world refuse to open, the way the reported one did: seeded history that disagrees
 * with the committed entity. The store already refuses this and words the refusal — what is
 * under test is what happens to the refusal afterwards.
 */
async function breakWorldOpen(root: string, worldDir: string): Promise<void> {
  const seeding = new FsWorldProvider(root, { clock: () => CLOCK });
  await seeding.loadWorld(WORLD_ID);
  await seeding.close();
  await writeFile(join(worldDir, SNAPSHOT), "conflicting history", "utf8");
}

describe("a refused world open (issue 571)", () => {
  it("states the reason instead of leaving the screen on the loader", async () => {
    const { root, worldDir } = await makeTempRoot();
    await breakWorldOpen(root, worldDir);
    const h = await harness(root);

    await h.send({ kind: "open-world", worldId: WORLD_ID });

    assert.equal(h.events.some((e) => e.type === "world.opened"), false, "the world did not open");
    const [failed] = h.failures();
    assert.ok(failed, "the refusal is an event of its own, not an absence of world.opened");
    assert.equal(failed.worldId, WORLD_ID);
    assert.match(failed.reason, /history snapshot conflicts/, "the store's own words, carried whole");
    assert.deepEqual(
      h.state().worldOpenFailure,
      { worldId: WORLD_ID, reason: failed.reason },
      "and in the snapshot, because the client's request carries no correlation to wait on",
    );
    assert.equal(h.state().world, null, "no world is open, and the state says so");
  });

  it("writes the cause to app.jsonl", async () => {
    const { root, worldDir } = await makeTempRoot();
    await breakWorldOpen(root, worldDir);
    const h = await harness(root);

    await h.send({ kind: "open-world", worldId: WORLD_ID });

    // Awaited rather than fired off, so the line is on disk by the time the message is answered:
    // the whole complaint was that there was nothing to read afterwards.
    const log = await readFile(join(root, "logs", "app.jsonl"), "utf8");
    const line = log
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((record) => record["event"] === "world.open-failed");
    assert.ok(line, "app.jsonl names the failure");
    assert.equal(line["level"], "error");
    assert.equal(line["worldId"], WORLD_ID);
    assert.equal(line["kind"], "commit-plan", "classified, in this repository's words");
  });

  it("keeps the world's own words out of app.jsonl, and only out of app.jsonl", async () => {
    /*
     * `buildDiagnosticsBundle` ships this file's tail verbatim and promises no world content. A
     * refusal's wording is world content more often than not: this one names a character's file,
     * and `world.json does not parse` carries V8's excerpt of the source — the world's own title.
     * So the log takes a classification and never the message.
     */
    const { root, worldDir } = await makeTempRoot();
    await breakWorldOpen(root, worldDir);
    const h = await harness(root);

    await h.send({ kind: "open-world", worldId: WORLD_ID });

    const log = await readFile(join(root, "logs", "app.jsonl"), "utf8");
    assert.equal(log.includes("bray-half-hitch"), false, "no character slug reaches the log");
    assert.equal(log.includes(".history"), false, "and no world path either");
    assert.equal(log.includes("history snapshot conflicts"), false, "nor the refusal's own words");
    assert.match(log, /"kind":"commit-plan"/, "what stands is a name this repository owns");

    // The screen and the event are not the bundle, and the person looking at the refusal is the
    // one who needs to know which file it was.
    assert.match(String(h.state().worldOpenFailure?.reason), /bray-half-hitch/);
    assert.match(h.failures()[0]!.reason, /bray-half-hitch/);
  });

  it("does not refuse a world that is open anyway", async () => {
    /*
     * Two overlapping `open-world` messages race for the world lock — `WorldLayout` and the screen
     * inside it each run the open guard — and the loser's "open in another process" lands after
     * the winner has succeeded. `openWorld` can also throw after the store is installed, from
     * `retryFinalizationsForWorld`. Recording either as a refusal hides a loaded world behind a
     * banner that Try again cannot clear, because the retry succeeds and changes nothing.
     */
    const { root } = await makeTempRoot();
    const h = await harness(root);
    await h.send({ kind: "open-world", worldId: WORLD_ID });
    assert.equal(h.state().world?.meta.worldId, WORLD_ID, "open to begin with");

    await h.fail(WORLD_ID, new Error("world is open in another Arke Studio process (pid 1)"));

    assert.equal(h.state().worldOpenFailure, null, "the world is open, so it is not refused");
    assert.equal(h.state().world?.meta.worldId, WORLD_ID, "and it is still the open one");
    assert.equal(h.failures().length, 0, "nothing announces a failure that did not happen");
    const log = await readFile(join(root, "logs", "app.jsonl"), "utf8");
    assert.match(log, /world.open-recovered/, "it is still worth a line — something did throw");
    assert.equal(log.includes("in another Arke Studio process"), false, "and that line is not the words either");
  });

  it("clears the refusal once the world opens", async () => {
    const { root, worldDir } = await makeTempRoot();
    const live = await readFile(join(worldDir, "characters", "bray-half-hitch.md"), "utf8");
    await breakWorldOpen(root, worldDir);
    const h = await harness(root);
    await h.send({ kind: "open-world", worldId: WORLD_ID });
    assert.ok(h.state().worldOpenFailure, "refused first");

    await writeFile(join(worldDir, SNAPSHOT), live, "utf8");
    await h.send({ kind: "open-world", worldId: WORLD_ID });

    assert.equal(h.state().worldOpenFailure, null, "a stale refusal outliving its question is worse than none");
    assert.equal(h.state().world?.meta.worldId, WORLD_ID);
  });

  it("keeps a refusal alive while the world it is not about is refreshed", async () => {
    /*
     * A refusal for one world sits beside another world that stays open, and that world gets
     * refreshed constantly — a media backfill, an adopted Bible edit. Each refresh reaches
     * `setWorld`, and clearing on any world at all wiped a refusal for a world that still had not
     * opened. Its route then fell back to the loader for good: `useOpenWorldGuard` sees an
     * unchanged route, connection and open-world id, so nothing re-asks.
     */
    const { root } = await makeTempRoot();
    const h = await harness(root);
    await h.send({ kind: "open-world", worldId: WORLD_ID });
    const missing = "01M0F0DPTXSFXA50JQTM391BXX";
    await h.send({ kind: "open-world", worldId: missing });
    assert.equal(h.state().worldOpenFailure?.worldId, missing, "refused to begin with");

    // An ordinary refresh of the world that IS open, which is all a backfill callback does.
    await h.provider.loadWorld(WORLD_ID);
    h.refresh(h.provider.openStore()!.getBundle());

    assert.equal(h.state().worldOpenFailure?.worldId, missing, "the refusal is not about this world");
    assert.equal(h.state().world?.meta.worldId, WORLD_ID, "and the open world still refreshed");
  });

  it("does not let a post-load repair decide whether the world opened", async () => {
    /*
     * The provider has installed the store before any of these run, so a jobs journal that will
     * not append used to escape into the open-world catch and be reported as a world that would
     * not open — taking `world.opened`, the founding-build resume and the media pass with it, and
     * leaving an interrupted conversation still marked running on a world you could click around.
     */
    const { root } = await makeTempRoot();
    const h = await harness(root);
    await h.send({ kind: "open-world", worldId: WORLD_ID });

    await h.repair(WORLD_ID, "job-finalizations", () => {
      throw new Error("jobs journal is not writable");
    });

    assert.equal(h.state().worldOpenFailure, null, "a repair that failed is not a world that did not open");
    assert.equal(h.state().world?.meta.worldId, WORLD_ID);
    const log = await readFile(join(root, "logs", "app.jsonl"), "utf8");
    const line = log
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((record) => record["event"] === "world.open-repair-failed");
    assert.ok(line, "and it is still stated — silence is the thing being fixed");
    assert.equal(line["step"], "job-finalizations", "by which repair, so the next one is findable");
  });

  it("does not close the open world when the id is the thing that was wrong", async () => {
    // The case the old catch was written for, and the reason it cannot simply report no world
    // open: an unknown id is refused before `loadWorld` closes anything, so the world the person
    // is still looking at is untouched.
    const { root } = await makeTempRoot();
    const h = await harness(root);
    await h.send({ kind: "open-world", worldId: WORLD_ID });
    assert.equal(h.state().world?.meta.worldId, WORLD_ID, "opened to begin with");

    const missing = "01M0F0DPTXSFXA50JQTM391BXX";
    await h.send({ kind: "open-world", worldId: missing });

    assert.equal(h.state().world?.meta.worldId, WORLD_ID, "the open world survives somebody else's typo");
    assert.equal(h.state().worldOpenFailure?.worldId, missing, "and the world that was asked for is answered");
  });
});

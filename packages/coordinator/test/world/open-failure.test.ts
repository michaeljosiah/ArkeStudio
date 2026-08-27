import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
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
  const failures = () => events.filter((e): e is OpenFailed => e.type === "world.open-failed");
  return { provider, events, send, state, failures };
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
    assert.match(String(line["reason"]), /history snapshot conflicts/);
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

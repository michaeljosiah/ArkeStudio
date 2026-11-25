import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientMessageSchema, ProductionSpineSchema, ulid, type ClientMessage } from "@arke-studio/contracts";
import { productionCommands } from "../../src/commands/productions.js";
import { CommandRouter } from "../../src/commands/router.js";
import type { CommandContext } from "../../src/commands/context.js";
import { describeCoordinatorError } from "../../src/errors/user-message.js";
import { WorldStore } from "../../src/world/store.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";

/**
 * The Studio's own spine command (issue 3088): Use as the song sends one semantic command through
 * the authority Arke's audio-spine card applies, so it passes the card's checks — a measured sound
 * file this production may use, the revision it was composed against — and a refusal is said under
 * its request rather than dropped.
 *
 * Driven through the router and the production commands module rather than a whole coordinator:
 * the routing, the world check and the refusal are the router's, and the write is the authority's.
 */
const PRODUCTION = "saltlight";
const BELLS = "ar_01J8G0000000000000000000R1";
const TREATMENT = "ar_01J8G0000000000000000000R2";

async function harness(options: { measured: boolean }) {
  const dir = await makeTempWorld();
  if (options.measured) {
    const sidecar = join(dir, "artifacts", "harbour-bells.wav.json");
    const record = JSON.parse(await readFile(sidecar, "utf8")) as Record<string, unknown>;
    await writeFile(sidecar, `${JSON.stringify({ ...record, mediaInfo: { durationSec: 30, hasAudio: true } }, null, 2)}\n`);
  }
  const store = await WorldStore.open(dir, { clock: () => "2026-11-15T09:00:00.000Z" });
  closeOnCleanup(() => store.close());
  const failures: Array<{ command: string; requestId: string | null; reason: string }> = [];
  const refreshed: string[] = [];
  const ctx: CommandContext = {
    stopping: () => false,
    openStore: () => store,
    emit: () => {},
    nowIso: () => "2026-11-15T09:00:00.000Z",
    refreshWorldSnapshot: async (worldId) => { refreshed.push(worldId); },
    fail: (command, requestId, error) => failures.push({ command, requestId, reason: typeof error === "string" ? error : describeCoordinatorError(error) }),
  };
  const module = productionCommands(ctx, {
    mediaProbe: null, runtimeStop: new AbortController().signal, backgroundWork: new Set(), shownWorldId: () => WORLD_ID,
    scheduleProductionSpend: async () => {}, broadcastSnapshot: () => {}, worldOpensSettled: async () => {},
    worldChatRunner: () => { throw new Error("no World Chat here"); }, refreshConversations: async () => {},
    openWorldChat: async () => {}, stillOpen: () => true, worldChat: () => null, setWorldChat: () => {}, checkTake: async () => "not-checkable",
    songSections: async () => ({ status: "unavailable", reason: "Not measured in this test." }),
  });
  const router = new CommandRouter(ctx, [module]);
  // Parsed as the transport parses it, so the frame itself is what is tested.
  const send = async (message: ClientMessage) => { assert.equal(await router.dispatch(ClientMessageSchema.parse(message)), true); };
  const spine = () => store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)?.spine ?? null;
  const onDisk = async () => ProductionSpineSchema.parse(JSON.parse(await readFile(join(dir, "productions", PRODUCTION, "spine.json"), "utf8")));
  const refusal = (requestId: string) => failures.find((failure) => failure.requestId === requestId)?.reason;
  return { dir, send, spine, onDisk, refusal, refreshed };
}

const command = (baseRevision: number | null, change: Extract<ClientMessage, { kind: "spine-command" }>["command"]) =>
  ({ kind: "spine-command", worldId: WORLD_ID, productionId: PRODUCTION, requestId: ulid(), baseRevision, command: change }) as const;

describe("spine-command (issue 3088)", () => {
  it("makes a measured sound file the song, and changes it only at the revision shown", async () => {
    const h = await harness({ measured: true });
    const create = command(null, { kind: "create", trackArtifactId: BELLS });
    await h.send(create);
    assert.equal(h.refusal(create.requestId), undefined);
    const written = await h.onDisk();
    assert.equal(written.revision, 1);
    assert.equal(written.trackArtifactId, BELLS);
    assert.deepEqual(h.spine(), written, "the bundle carries the spine just written");
    assert.deepEqual(h.refreshed, [WORLD_ID], "the snapshot is published");

    // A second create is refused by name: the spine already exists.
    const again = command(null, { kind: "create", trackArtifactId: BELLS });
    await h.send(again);
    assert.match(h.refusal(again.requestId) ?? "", /already has an audio spine/);

    // The same track again changes nothing, and a stale revision moves nothing.
    const same = command(1, { kind: "assign-track", trackArtifactId: BELLS });
    await h.send(same);
    assert.match(h.refusal(same.requestId) ?? "", /changes nothing/);
    const stale = command(2, { kind: "add-marker", marker: { kind: "section", id: `mk_${ulid()}`, label: "Verse 1", atSec: 4, source: "manual" } });
    await h.send(stale);
    assert.match(h.refusal(stale.requestId) ?? "", /moved from revision 2 to 1/);

    // A file with no sound is no song.
    const silent = command(1, { kind: "assign-track", trackArtifactId: TREATMENT });
    await h.send(silent);
    assert.match(h.refusal(silent.requestId) ?? "", /not known to carry sound/);

    // A marker past the end of the song is refused against its measured length.
    const late = command(1, { kind: "add-marker", marker: { kind: "section", id: `mk_${ulid()}`, label: "Coda", atSec: 31, source: "manual" } });
    await h.send(late);
    assert.match(h.refusal(late.requestId) ?? "", /past the track's 30s/);
    assert.equal((await h.onDisk()).revision, 1, "no refusal wrote anything");

    const marked = command(1, { kind: "add-marker", marker: { kind: "section", id: `mk_${ulid()}`, label: "Verse 1", atSec: 4, source: "manual" } });
    await h.send(marked);
    assert.equal(h.refusal(marked.requestId), undefined);
    const after = await h.onDisk();
    assert.equal(after.revision, 2);
    assert.deepEqual(after.markers.map((marker) => (marker.kind === "section" ? marker.label : marker.text)), ["Verse 1"]);
  });

  it("refuses an unmeasured master and writes nothing", async () => {
    const h = await harness({ measured: false });
    const create = command(null, { kind: "create", trackArtifactId: BELLS });
    await h.send(create);
    assert.match(h.refusal(create.requestId) ?? "", /has not been measured/);
    await assert.rejects(readFile(join(h.dir, "productions", PRODUCTION, "spine.json"), "utf8"), { code: "ENOENT" });
    assert.equal(h.spine(), null);
  });

  it("refuses a command for a world that is not open", async () => {
    const h = await harness({ measured: true });
    const elsewhere = { ...command(null, { kind: "create", trackArtifactId: BELLS }), worldId: ulid() };
    await h.send(elsewhere);
    assert.match(h.refusal(elsewhere.requestId) ?? "", /no longer open/);
    assert.equal(h.spine(), null);
  });
});

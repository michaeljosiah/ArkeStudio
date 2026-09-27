import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RoutingSchema, type ClientMessage, type DomainEvent, type RoutingCommand } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { applyRoutingCommand, saveRouting } from "../../src/productions/interactive.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * The branch map's hand edits (design turn 157): one closed routing command per frame, applied
 * to the routing on disk — the same commands world chat's production-routing action applies —
 * rather than a whole file the map composed from the copy it last saw.
 */

const PRODUCTION = "saltlight";

async function harness(t: TestContext) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => "2026-09-27T12:00:00.000Z" });
  await provider.loadWorld(WORLD_ID);
  // Counted from here: a routing edit that reloads the world would, with another world opened
  // while it was in flight, close that world to reopen this one.
  let loads = 0;
  const load = provider.loadWorld.bind(provider);
  provider.loadWorld = (...args: Parameters<typeof provider.loadWorld>) => {
    loads += 1;
    return load(...args);
  };
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
  });
  // The open world holds a lock heartbeat and file watchers; left open, they kept a Windows
  // test process alive until CI's silence guard killed the shard.
  t.after(async () => {
    await coordinator.stop();
    await provider.close();
  });
  const send = (command: RoutingCommand, worldId = WORLD_ID) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage({
      kind: "routing-command",
      worldId,
      productionId: PRODUCTION,
      command,
    });
  const routing = async () =>
    RoutingSchema.parse(JSON.parse(await readFile(join(worldDir, "productions", PRODUCTION, "routing.json"), "utf8")));
  return { events, send, routing, worldDir, store: () => provider.openStore()!, loads: () => loads };
}

describe("the branch map's routing commands", () => {
  it("starts the routing from nothing with a start, then edits it one command at a time", async (t) => {
    const { send, routing, events } = await harness(t);
    await send({ operation: "set-start", sceneId: "sc_02" });
    const first = await routing();
    assert.equal(first.start, "sc_02");
    assert.deepEqual(first.choices, [], "day one writes a start and nothing else");

    await send({ operation: "add-choice", choice: { id: "ch_on", from: "sc_02", label: "Go on", to: "sc_04" } });
    await send({ operation: "set-ending", sceneId: "sc_04", title: "The verse rises" });
    await send({ operation: "edit-choice", choiceId: "ch_on", changes: { label: "Keep going" } });
    const edited = await routing();
    assert.deepEqual(edited.choices, [{ id: "ch_on", from: "sc_02", label: "Keep going", to: "sc_04" }]);
    assert.deepEqual(edited.endings, [{ sceneId: "sc_04", title: "The verse rises" }]);
    assert.ok(edited.version > first.version, "every hand edit moves the routing version");
    assert.ok(
      events.some((event) => event.type === "production.routing-findings" && event.productionId === PRODUCTION),
      "the findings are re-served after the edit, so the map's count follows it",
    );
  });

  it("refreshes the open world's snapshot without reloading any world", async (t) => {
    const { send, routing, loads, events } = await harness(t);
    await send({ operation: "set-start", sceneId: "sc_02" });
    await send({ operation: "add-choice", choice: { id: "ch_on", from: "sc_02", label: "Go on", to: "sc_04" } });
    assert.equal((await routing()).choices.length, 1);
    assert.equal(loads(), 0, "no loadWorld: that is what closed a world opened mid-edit");
    assert.ok(events.some((event) => event.type === "production.routing-findings"), "the findings still follow the edit");
  });

  it("applies each command to what is on disk, so two edits in flight both land", async (t) => {
    const { send, routing } = await harness(t);
    await send({ operation: "set-start", sceneId: "sc_02" });
    // Two edits composed against the same starting file: a whole-file save would let the second
    // write over the first; a command applies to the other's result.
    await Promise.all([
      send({ operation: "add-choice", choice: { id: "ch_a", from: "sc_02", label: "A", to: "sc_04" } }),
      send({ operation: "add-choice", choice: { id: "ch_b", from: "sc_02", label: "B", to: "sc_06" } }),
    ]);
    const after = await routing();
    assert.deepEqual(after.choices.map((choice) => choice.id).sort(), ["ch_a", "ch_b"]);
  });

  it("waits for another routing writer rather than writing over its edit", async (t) => {
    const { send, routing, store } = await harness(t);
    await send({ operation: "set-start", sceneId: "sc_02" });
    const before = await routing();
    // An accepted production-routing action saves while a map edit is in flight. The map's
    // command used to read the file before that save committed and write its result over it.
    const chat = applyRoutingCommand(before, { operation: "add-choice", choice: { id: "ch_chat", from: "sc_02", label: "Chat", to: "sc_04" } });
    const [saved] = await Promise.allSettled([
      saveRouting(store(), PRODUCTION, chat, { source: "world-chat" }),
      send({ operation: "add-choice", choice: { id: "ch_map", from: "sc_02", label: "Map", to: "sc_06" } }),
    ]);
    const ids = (await routing()).choices.map((choice) => choice.id).sort();
    // Whichever reaches the store first, nothing is silently lost: the map's command applies to
    // what the save wrote, or the save — composed before the map's edit — is refused as stale.
    if (saved.status === "fulfilled") assert.deepEqual(ids, ["ch_chat", "ch_map"], "the command applied to the saved file");
    else {
      assert.match(String(saved.reason), /base moved/);
      assert.deepEqual(ids, ["ch_map"], "the stale save was refused, not merged over the map's edit");
    }
  });

  it("two quick adds with one label both land, the second under a suffixed id", async (t) => {
    const { send, routing } = await harness(t);
    await send({ operation: "set-start", sceneId: "sc_02" });
    // The map derives the id from the label against the routing it last saw, so both carry one id.
    await Promise.all([
      send({ operation: "add-choice", choice: { id: "ch_go-on", from: "sc_02", label: "Go on", to: "sc_04" } }),
      send({ operation: "add-choice", choice: { id: "ch_go-on", from: "sc_04", label: "Go on", to: "sc_06" } }),
    ]);
    const after = await routing();
    assert.deepEqual(
      after.choices.map((choice) => [choice.id, choice.from]),
      [["ch_go-on", "sc_02"], ["ch_go-on-2", "sc_04"]],
    );
  });

  it("refuses to put an excluded scene on a route, whichever command would", async (t) => {
    const { send, routing } = await harness(t);
    await send({ operation: "set-start", sceneId: "sc_02" });
    await send({ operation: "add-choice", choice: { id: "ch_on", from: "sc_02", label: "Go on", to: "sc_04" } });
    const before = await routing();
    // Excluding a scene the route reaches would ship its choice with nothing to play.
    await send({ operation: "exclude-scene", sceneId: "sc_04", reason: "held back" });
    await send({ operation: "exclude-scene", sceneId: "sc_02", reason: "the start" });
    assert.deepEqual(await routing(), before, "a scene on a route stays on it");

    // A scene no route reaches can be excluded; then nothing may route into it or start there.
    await send({ operation: "exclude-scene", sceneId: "sc_06", reason: "kept for the audio" });
    const excluded = await routing();
    assert.deepEqual(excluded.excluded, [{ sceneId: "sc_06", reason: "kept for the audio" }]);
    await send({ operation: "add-choice", choice: { id: "ch_down", from: "sc_04", label: "Go down", to: "sc_06" } });
    await send({ operation: "edit-choice", choiceId: "ch_on", changes: { to: "sc_06" } });
    await send({ operation: "set-start", sceneId: "sc_06" });
    assert.deepEqual(await routing(), excluded, "no command routes into an excluded scene");
  });

  it("refuses a command that does not apply, writes nothing, and tells the author why", async (t) => {
    const { send, routing, events } = await harness(t);
    await send({ operation: "set-start", sceneId: "sc_02" });
    const before = await routing();
    await send({ operation: "remove-choice", choiceId: "ch_missing" });
    await send({ operation: "clear-ending", sceneId: "sc_04" });
    assert.deepEqual(await routing(), before, "a refused edit leaves the file as it was");
    const refusals = events.filter((event) => event.type === "command.failed" && event.command === "routing-command");
    assert.deepEqual(
      refusals.map((event) => event.type === "command.failed" && event.reason),
      ["Choice ch_missing does not exist.", "sc_04 is not designated as an ending."],
      "a refusal is a notice with its reason, not an edit that silently vanishes",
    );
  });

  it("refuses a command that names a scene the production no longer has, but still lets a removal through", async (t) => {
    const { send, routing, worldDir } = await harness(t);
    await send({ operation: "set-start", sceneId: "sc_02" });
    await send({ operation: "add-choice", choice: { id: "ch_on", from: "sc_02", label: "Go on", to: "sc_04" } });
    const before = await routing();
    // The map's copy was stale: sc_99 was deleted (or never here) by the time the edit landed.
    await send({ operation: "add-choice", choice: { id: "ch_gone", from: "sc_02", label: "Gone", to: "sc_99" } });
    await send({ operation: "edit-choice", choiceId: "ch_on", changes: { to: "sc_99" } });
    await send({ operation: "set-ending", sceneId: "sc_99", title: "Nowhere" });
    await send({ operation: "add-group", group: { id: "grp_x", title: "X", scenes: ["sc_02", "sc_99"] } });
    assert.deepEqual(await routing(), before, "nothing that names a missing scene is written");

    // A file that already routes to a missing scene (written before the scene went) can still be
    // repaired by removing the choice. A version of its own, as a save would have given it.
    const path = join(worldDir, "productions", PRODUCTION, "routing.json");
    const stale = { ...before, version: before.version + 1, choices: [...before.choices, { id: "ch_old", from: "sc_02", label: "Old", to: "sc_99" }] };
    await writeFile(path, JSON.stringify(stale));
    await send({ operation: "remove-choice", choiceId: "ch_old" });
    assert.deepEqual((await routing()).choices.map((choice) => choice.id), ["ch_on"]);
  });

  it("never lands in a world other than the one the frame names", async (t) => {
    const { send, worldDir } = await harness(t);
    // Sent for another world while this one is open — it holds a production with the same slug.
    await send({ operation: "set-start", sceneId: "sc_02" }, "01J8F3K2QW9VZX4N7M0RTYB6ZZ");
    await assert.rejects(readFile(join(worldDir, "productions", PRODUCTION, "routing.json"), "utf8"), /ENOENT/);
  });

  it("a first edit that is not a start is refused, and no routing file appears", async (t) => {
    const { send, worldDir } = await harness(t);
    await send({ operation: "add-choice", choice: { id: "ch_on", from: "sc_02", label: "Go on", to: "sc_04" } });
    await assert.rejects(readFile(join(worldDir, "productions", PRODUCTION, "routing.json"), "utf8"), /ENOENT/);
  });
});

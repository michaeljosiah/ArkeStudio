import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RoutingSchema, type ClientMessage, type DomainEvent, type RoutingCommand } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * The branch map's hand edits (design turn 157): one closed routing command per frame, applied
 * to the routing on disk — the same commands world chat's production-routing action applies —
 * rather than a whole file the map composed from the copy it last saw.
 */

const PRODUCTION = "saltlight";

async function harness() {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => "2026-09-27T12:00:00.000Z" });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
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
  return { events, send, routing, worldDir };
}

describe("the branch map's routing commands", () => {
  it("starts the routing from nothing with a start, then edits it one command at a time", async () => {
    const { send, routing, events } = await harness();
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

  it("applies each command to what is on disk, so two edits in flight both land", async () => {
    const { send, routing } = await harness();
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

  it("two quick adds with one label both land, the second under a suffixed id", async () => {
    const { send, routing } = await harness();
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

  it("refuses to put an excluded scene on a route, whichever command would", async () => {
    const { send, routing } = await harness();
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

  it("refuses a command that does not apply, and writes nothing", async () => {
    const { send, routing } = await harness();
    await send({ operation: "set-start", sceneId: "sc_02" });
    const before = await routing();
    await send({ operation: "remove-choice", choiceId: "ch_missing" });
    await send({ operation: "clear-ending", sceneId: "sc_04" });
    assert.deepEqual(await routing(), before, "a refused edit leaves the file as it was");
  });

  it("refuses a command that names a scene the production no longer has, but still lets a removal through", async () => {
    const { send, routing, worldDir } = await harness();
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

  it("never lands in a world other than the one the frame names", async () => {
    const { send, worldDir } = await harness();
    // Sent for another world while this one is open — it holds a production with the same slug.
    await send({ operation: "set-start", sceneId: "sc_02" }, "01J8F3K2QW9VZX4N7M0RTYB6ZZ");
    await assert.rejects(readFile(join(worldDir, "productions", PRODUCTION, "routing.json"), "utf8"), /ENOENT/);
  });

  it("a first edit that is not a start is refused, and no routing file appears", async () => {
    const { send, worldDir } = await harness();
    await send({ operation: "add-choice", choice: { id: "ch_on", from: "sc_02", label: "Go on", to: "sc_04" } });
    await assert.rejects(readFile(join(worldDir, "productions", PRODUCTION, "routing.json"), "utf8"), /ENOENT/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
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
  const send = (command: RoutingCommand) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage({
      kind: "routing-command",
      worldId: WORLD_ID,
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

  it("refuses a command that does not apply, and writes nothing", async () => {
    const { send, routing } = await harness();
    await send({ operation: "set-start", sceneId: "sc_02" });
    const before = await routing();
    await send({ operation: "remove-choice", choiceId: "ch_missing" });
    await send({ operation: "clear-ending", sceneId: "sc_04" });
    assert.deepEqual(await routing(), before, "a refused edit leaves the file as it was");
  });

  it("a first edit that is not a start is refused, and no routing file appears", async () => {
    const { send, worldDir } = await harness();
    await send({ operation: "add-choice", choice: { id: "ch_on", from: "sc_02", label: "Go on", to: "sc_04" } });
    await assert.rejects(readFile(join(worldDir, "productions", PRODUCTION, "routing.json"), "utf8"), /ENOENT/);
  });
});

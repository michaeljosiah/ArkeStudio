import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type ConversationId } from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { stageWorldChatProductionAuthoredAction } from "../../src/world-chat/production-authoring.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Arke's scene edit takes the inherited context per field (issue 3153, SPEC-044 R-19): a value
 * sets, null clears, a field left out stays. It had no way to say "no location", so a request to
 * clear one was sent as an empty slug and refused, twice.
 */

const PRODUCTION = "saltlight";
const SCENE = "productions/saltlight/scenes/04-the-verse-rises.json";
const NOW = () => "2026-11-15T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: NOW });
  closeOnCleanup(() => store.close());
  const gate = new ProposalManager(store);
  const stage = (inherits: Record<string, string | null> | null) =>
    stageWorldChatProductionAuthoredAction(store, gate, { actionId: newId("act"), conversationId: newId("cv") as ConversationId }, {
      kind: "world-chat-production-scene",
      worldId: store.worldId,
      action: { kind: "production-scene", productionId: PRODUCTION, change: { operation: "edit", sceneId: "sc_04", changes: { inherits } }, checkReceiptIds: [] },
    } as Parameters<typeof stageWorldChatProductionAuthoredAction>[3]);
  const staged = async (proposalId: string) =>
    JSON.parse(await readFile(join(dir, ".proposals", proposalId, ...SCENE.split("/")), "utf8")) as { inherits?: Record<string, string> };
  return { stage, staged };
}

describe("a scene edit's inherited context (issue 3153)", () => {
  it("clears the location with null and keeps the time of day and tone", async () => {
    const { stage, staged } = await open();
    const proposal = await stage({ location: null });
    const record = await staged(proposal.id);
    assert.deepEqual(record.inherits, { timeOfDay: "night", tone: "quiet dread" });
    assert.equal("location" in (record.inherits ?? {}), false, "the scene is written without the key");
  });

  it("changes only the field it names", async () => {
    const { stage, staged } = await open();
    const proposal = await stage({ timeOfDay: "dawn" });
    assert.deepEqual((await staged(proposal.id)).inherits, { location: "the-vigil", timeOfDay: "dawn", tone: "quiet dread" });
  });

  it("drops the context whole once every field is cleared, as null for the whole context does", async () => {
    const { stage, staged } = await open();
    const fields = await stage({ location: null, timeOfDay: null, tone: null });
    assert.equal("inherits" in (await staged(fields.id)), false);
    const whole = await stage(null);
    assert.equal("inherits" in (await staged(whole.id)), false);
  });

  it("still refuses a place this world does not hold", async () => {
    const { stage } = await open();
    await assert.rejects(stage({ location: "nowhere-at-all" }), /location nowhere-at-all is not in this world/);
  });
});

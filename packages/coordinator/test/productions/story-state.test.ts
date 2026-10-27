import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { storyIdentity, storyReplay } from "@arke-studio/contracts";
import { applyRoutingCommandOnDisk, appendTraversal, readTraversal, saveRouting } from "../../src/productions/interactive.js";
import { WorldStore } from "../../src/world/store.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { makeTempWorld } from "../world/helpers.js";

it("native story commands persist, fence older readers, replay evidence and survive reopen", async () => {
  const dir = await makeTempWorld();
  let store = await WorldStore.open(dir);
  try {
    const production = store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
    const [from, to] = production.scenes;
    assert.ok(from && to);
    const run = (command: Parameters<typeof applyRoutingCommandOnDisk>[2]) => applyRoutingCommandOnDisk(store, production.meta.id, command);
    await run({ operation: "set-start", sceneId: from.id });
    await run({ operation: "set-facts", facts: [{ id: "elsie", label: "Elsie Ward", type: "enum", values: ["Alive", "Lost"], default: "Alive" }] });
    await run({ operation: "add-choice", choice: { id: "ch_seal", from: from.id, to: to.id, label: "Seal the bore", effects: [{ fact: "elsie", value: "Lost" }], unavailable:{reason:"The bore is already sealed."} } });
    await run({ operation: "set-ending-variants", sceneId: to.id, title: "Above the Quiet", variants: [{ id: "loss", title: "An empty seat", text: "Elsie was lost at the bore.", fallback: true }] });
    const routing = await run({ operation: "set-ending", sceneId: to.id, title: "A renamed map ending" });
    assert.deepEqual(routing.endings[0]!.variants, [{ id: "loss", title: "An empty seat", text: "Elsie was lost at the bore.", fallback: true }]);
    assert.equal((await readWorldMeta(dir)).schemaVersion, 113);
    await assert.rejects(run({ operation: "set-facts", baseVersion: 1, facts: [] }), /changed while/);
    const bytes = await readFile(join(dir, "productions/saltlight/routing.json"), "utf8");
    await assert.rejects(readWorldMeta(dir, { supports: 112 }), /newer|schema|version/i);
    await assert.rejects(run({ operation: "set-facts", facts: [] }), /Unknown story fact/);
    await assert.rejects(run({ operation: "set-presentation", presentation: { sceneId: to.id, blocks: [{ blockId: "blk_missing", when: { op: "eq", fact: "elsie", value: "Alive" } }], shots: [] } }), /missing dialogue/);
    assert.equal(await readFile(join(dir, "productions/saltlight/routing.json"), "utf8"), bytes);
    const before = storyReplay(routing), after = storyReplay(routing, ["ch_seal"]);
    const evidence = { ts: "2026-10-27T12:00:00.000Z", routingVersion: routing.version, choiceId: "ch_seal", from: from.id, to: to.id, route: [from.id], story: { identity: storyIdentity(routing), prefix: [], before: storyIdentity(before.state), after: storyIdentity(after.state), provenance: "human" as const } };
    await appendTraversal(store, production.meta.id, evidence);
    await assert.rejects(appendTraversal(store, production.meta.id, { ...evidence, story: { ...evidence.story, after: "corrupt" } }), /does not replay/);
    assert.equal((await readTraversal(store, production.meta.id)).length, 1);
    await store.close();
    store = await WorldStore.open(dir);
    const reopened = store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.routing!;
    assert.deepEqual(storyReplay(reopened, ["ch_seal"]).state, { elsie: "Lost" });
    assert.deepEqual(reopened.choices[0]!.unavailable,{reason:"The bore is already sealed."});
    assert.equal(await readFile(join(dir, "productions/saltlight/routing.json"), "utf8"), bytes);
    // Whole-file imports pass the same schema fence and semantic validation.
    await assert.rejects(saveRouting(store, production.meta.id, { ...reopened, facts: [] }), /Unknown story fact/);
    const cleared=await run({operation:"edit-choice",choiceId:"ch_seal",changes:{unavailable:null}});
    assert.equal(cleared.choices[0]!.unavailable,undefined);
  } finally { await store.close(); }
});

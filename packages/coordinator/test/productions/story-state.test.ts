import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { storyIdentity, storyReplay, routingFindings } from "@arke-studio/contracts";
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

it("keeps original walk evidence through harmless edits and reopen, refusing missing history (#2238)", async () => {
  const dir = await makeTempWorld();
  let store = await WorldStore.open(dir);
  try {
    const production = store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
    const [from, to] = production.scenes;
    assert.ok(from && to);
    const run = (command: Parameters<typeof applyRoutingCommandOnDisk>[2]) => applyRoutingCommandOnDisk(store, production.meta.id, command);
    await run({ operation: "set-start", sceneId: from.id });
    await run({ operation: "add-choice", choice: { id: "ch_go", from: from.id, to: to.id, label: "Go" } });
    let routing = await run({ operation: "set-ending", sceneId: to.id, title: "End" });
    const line = { ts: "2026-10-27T12:00:00.000Z", routingVersion: routing.version, choiceId: "ch_go", from: from.id, to: to.id, route: [from.id] };
    await appendTraversal(store, production.meta.id, line);
    routing = await run({ operation: "set-facts", facts: [{ id: "unused", label: "Unused", type: "boolean", default: false }] });
    const unwalked = async () => routingFindings(routing, production.scenes, await readTraversal(store, production.meta.id)).filter(f => f.kind === "untraversed-edge");
    assert.deepEqual(await unwalked(), [], "introducing an unused fact does not invalidate legacy edge proof");
    // Now capture state-aware proof and require history when projecting it across later edits.
    const before = storyReplay(routing), after = storyReplay(routing, ["ch_go"]);
    const stateLine = { ...line, routingVersion: routing.version, story: { identity: storyIdentity(routing), prefix: [], before: storyIdentity(before.state), after: storyIdentity(after.state), provenance: "human" as const } };
    const journal = join(dir, "productions", production.meta.id, "routing-evidence.jsonl");
    await writeFile(journal, "");
    await appendTraversal(store, production.meta.id, stateLine);
    const original = await readFile(journal, "utf8");
    routing = await run({ operation: "set-facts", facts: [...routing.facts!, { id: "also-unused", label: "Also unused", type: "boolean", default: true }] });
    routing = await run({ operation: "clear-ending", sceneId: to.id });
    assert.deepEqual(await unwalked(), []);
    await store.close(); store = await WorldStore.open(dir);
    assert.deepEqual(await unwalked(), []);
    assert.equal((store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.routingTraversals?.[0]?.story?.identity), storyIdentity(routing), "the client snapshot receives the same qualified projection");
    assert.equal(await readFile(journal, "utf8"), original, "no new human walk is appended");
    await writeFile(join(dir, ".history", "productions", production.meta.id, "routing", `v${stateLine.routingVersion}.json`), "invalid");
    assert.equal((await unwalked()).length, 1, "unverifiable historical proof stays stale");
  } finally { await store.close(); }
});

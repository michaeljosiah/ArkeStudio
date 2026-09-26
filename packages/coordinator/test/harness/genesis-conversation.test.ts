import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { carryGenesisConversation, genesisConversation, genesisControlDir, loadGenesisConversation, recordFoundingBlueprint, recordFoundingMessage } from "../../src/harness/genesis-conversation.js";
import { foldBlueprint } from "../../src/harness/blueprint.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { discoverConversations } from "../../src/world-chat/discover.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { FsWorldProvider } from "../../src/world/provider.js";

async function sandboxDir(prefix: string): Promise<string> {
  const dir = join(await tempDir(prefix), "workspace");
  await mkdir(dir);
  return dir;
}

it("restores only unreadable entities while keeping valid edits and removals", async () => {
  const dir = await sandboxDir("founding-partial-");
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour" }));
  await mkdir(join(dir, "draft", "characters"), { recursive: true });
  await writeFile(join(dir, "draft", "characters", "maren.json"), JSON.stringify({ name: "Maren", line: "Old keeper" }));
  await writeFile(join(dir, "draft", "characters", "rue.json"), JSON.stringify({ name: "Rue", line: "Old sailor" }));
  await recordFoundingBlueprint(dir, await foldBlueprint(dir));
  await writeFile(join(dir, "draft", "characters", "maren.json"), "{");
  await writeFile(join(dir, "draft", "characters", "rue.json"), JSON.stringify({ name: "Rue", line: "New captain" }));
  const loaded = await loadGenesisConversation(dir, "gen-partial");
  assert.equal(loaded.blueprint.characters.find(c => c.slug === "maren")?.line, "Old keeper");
  assert.equal(loaded.blueprint.characters.find(c => c.slug === "rue")?.line, "New captain");
  assert.deepEqual(loaded.blueprint.dropped, ["draft/characters/maren.json"]);
});

it("keeps the frozen founding input after creation starts and marks form handoff completion", async () => {
  const dir = await sandboxDir("founding-frozen-");
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Original" }));
  const blueprint = await foldBlueprint(dir);
  await writeFile(join(genesisControlDir(dir), "founding-input.json"), JSON.stringify({ blueprint, models: { image: "frozen-image-model" } }));
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Changed after crash" }));
  let loaded = await loadGenesisConversation(dir, "gen-frozen");
  assert.equal(loaded.founding, true);
  assert.deepEqual(loaded.frozenModels, { image: "frozen-image-model" });
  assert.equal(loaded.blueprint.name, "Original");
  const worldId = ulid();
  await writeFile(join(genesisControlDir(dir), "begun.json"), JSON.stringify({ worldId, form: true }));
  loaded = await loadGenesisConversation(dir, "gen-frozen");
  assert.equal(loaded.formHandoff, "pending");
  await writeFile(join(genesisControlDir(dir), "completed.json"), JSON.stringify({ worldId, form: true }));
  assert.equal((await loadGenesisConversation(dir, "gen-frozen")).formHandoff, "completed");
});

it("reopens a draft with its transcript, current blueprint and attachments", async () => {
  const dir = await sandboxDir("founding-resume-");
  const user = await recordFoundingMessage(dir, "user", "Maren guards the harbour.");
  await recordFoundingMessage(dir, "studio", "What does she fear?");
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour" }));
  await mkdir(join(dir, "attachments"));
  await writeFile(join(dir, "attachments", "notes.txt"), "Maren is the keeper.");
  const restored = await loadGenesisConversation(dir, "gen-resume");
  assert.equal(restored.blueprint.name, "Harbour");
  assert.equal(restored.turns.length, 2);
  assert.equal(restored.turns[0]?.id, user.id);
  assert.deepEqual(restored.attachments, [{ name: "notes.txt", kind: "document" }]);
  assert.equal(restored.conversationId, (await (await genesisConversation(dir)).readMeta())?.id);
});

it("replays an interrupted handoff exactly once into the ordinary world chat fold", async () => {
  const dir = await sandboxDir("founding-carry-");
  const world = await tempDir("founding-world-");
  await recordFoundingMessage(dir, "user", "Keep the gate closed.");
  await recordFoundingMessage(dir, "studio", "The gate stays closed.");
  const source = await genesisConversation(dir);
  const meta = (await source.readMeta())!;
  const { events } = await source.read();
  const target = new WorldChatStore(conversationDir(world, meta.id));
  await mkdir(target.dir, { recursive: true });
  await writeFile(join(target.dir, ".founding-incomplete"), "incomplete");
  await target.create(meta.id, meta.createdAt);
  for (const envelope of events.slice(0, 2)) {
    await target.append(envelope.event, { at: envelope.at, requestId: `founding:${envelope.eventId}` });
  }
  assert.equal((await discoverConversations(world)).summaries.length, 0);
  assert.equal(await target.readMeta(), null);
  await carryGenesisConversation(dir, world);
  await carryGenesisConversation(dir, world);
  assert.equal((await discoverConversations(world)).summaries.length, 1);
  const restored = await target.read();
  assert.equal(restored.events.length, events.length);
  const folded = foldConversation(meta.id, meta.createdAt, restored.events);
  assert.equal(folded.problems.length, 0);
  assert.deepEqual(folded.view.messages.map(m => m.text), ["Keep the gate closed.", "The gate stays closed."]);
});

it("concurrent draft discovery shares an identity and different drafts remain separate", async () => {
  const root = await tempDir("founding-discover-");
  const provider = new FsWorldProvider(root);
  const one = await provider.genesisDir("gen-one");
  const two = await provider.genesisDir("gen-two");
  const logs = await Promise.all([genesisConversation(one), genesisConversation(one)]);
  assert.equal((await logs[0]!.readMeta())?.id, (await logs[1]!.readMeta())?.id);
  await recordFoundingMessage(two, "user", "A different world.");
  assert.notEqual((await logs[0]!.readMeta())?.id, (await (await genesisConversation(two)).readMeta())?.id);
  assert.deepEqual((await provider.listGenesisIds()).sort(), ["gen-one", "gen-two"]);
});

it("a reserved founding identity reuses the world after a lost Begin response", async () => {
  const root = await tempDir("founding-create-");
  const provider = new FsWorldProvider(root);
  const input = { creationId: ulid(), name: "Harbour", bible: "The gates remain closed." };
  const first = await provider.createWorld(input);
  const second = await new FsWorldProvider(root).createWorld(input);
  assert.deepEqual(second, first);
  assert.equal((await provider.listWorlds()).length, 1);
});

it("a discarded conversation URL can create a fresh journal without a stale writer", async () => {
  const provider = new FsWorldProvider(await tempDir("founding-discard-"));
  const dir = await provider.genesisDir("gen-discard");
  await recordFoundingMessage(dir, "user", "Discard this.");
  const before = await loadGenesisConversation(dir, "gen-discard");
  await provider.discardGenesis("gen-discard");
  const recreated = await provider.genesisDir("gen-discard");
  await recordFoundingMessage(recreated, "user", "Start again.");
  const after = await loadGenesisConversation(recreated, "gen-discard");
  assert.notEqual(after.conversationId, before.conversationId);
  assert.deepEqual(after.turns.map(turn => turn.text), ["Start again."]);
});

it("rebuilds unpublished reserved worlds without stale optional documents", async () => {
  const root = await tempDir("founding-staging-");
  const provider = new FsWorldProvider(root);
  const creationId = ulid();
  const staging = join(root, ".world-creations", creationId);
  await mkdir(join(staging, "art-direction"), { recursive: true });
  await writeFile(join(staging, "art-direction", "art-direction.json"), "stale");
  await writeFile(join(staging, "bible.md"), "stale");
  const created = await provider.createWorld({ creationId, name: "Fresh" });
  const world = join(root, "worlds", created.slug);
  await assert.rejects(readFile(join(world, "bible.md")), { code: "ENOENT" });
  await assert.rejects(readFile(join(world, "art-direction", "art-direction.json")), { code: "ENOENT" });
});

it("migrates legacy draft content without giving the harness the conversation journal", async () => {
  const root = await tempDir("founding-migrate-");
  const old = join(root, ".genesis", "gen-old");
  await mkdir(old, { recursive: true });
  await writeFile(join(old, "draft.json"), JSON.stringify({ name: "Old Harbour" }));
  await writeFile(join(old, "begun.json"), JSON.stringify({ worldId: ulid() }));
  await writeFile(join(old, "creation.json"), JSON.stringify({ worldId: ulid() }));
  const provider = new FsWorldProvider(root);
  const workspace = await provider.genesisDir("gen-old");
  assert.equal(workspace, join(root, ".genesis-v2", "gen-old", "workspace"));
  const restored = await loadGenesisConversation(workspace, "gen-old");
  assert.equal(restored.blueprint.name, "Old Harbour");
  assert.equal(restored.worldId, undefined, "legacy agent files cannot assert an application handoff");
  assert.equal((await genesisConversation(workspace)).dir, join(root, ".genesis-v2", "gen-old", ".conversation"));
  await provider.genesisDir("gen-old");
  assert.equal((await loadGenesisConversation(workspace, "gen-old")).blueprint.name, "Old Harbour");
});
it("refuses reserved creation recovery when a published world's identity is unreadable", async () => {
  const root = await tempDir("founding-unreadable-");
  const provider = new FsWorldProvider(root);
  const input = { creationId: ulid(), name: "Harbour" };
  const first = await provider.createWorld(input);
  const path = join(root, "worlds", first.slug, "world.json");
  const original = await readFile(path, "utf8");
  await writeFile(path, "{ damaged");
  await assert.rejects(provider.createWorld(input), /world.*unreadable/);
  await writeFile(path, original);
  assert.deepEqual(await provider.createWorld(input), first);
  assert.equal((await provider.listWorlds()).length, 1);
});

import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { approvedBlueprintForFounding, decideGenesisContent, reviewGenesisContent } from "../../src/harness/genesis-review.js";
import { genesisConversation } from "../../src/harness/genesis-conversation.js";
import { parseDraftFrom } from "../../src/harness/genesis.js";

async function draft() {
  const provider = new FsWorldProvider(await tempDir("genesis-review-"));
  const dir = await provider.genesisDir("gen-review");
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour", bible: "The gates never open." }));
  await mkdir(join(dir, "draft", "characters"), { recursive: true });
  const path = join(dir, "draft", "characters", "maren.json");
  await writeFile(path, JSON.stringify({ name: "Maren", sheet: { sections: { Essence: "She keeps the gate.", Appearance: "A red coat." } } }));
  return { dir, path };
}

it("recovery keeps omitted canon, and a canon-only proposal is meaningful", () => {
  const canon = [{ slug: "closed", type: "rule", title: "Closed", statement: "The gate stays closed." }];
  assert.deepEqual(parseDraftFrom(JSON.stringify({ canon }))?.canon, canon);
  assert.deepEqual(parseDraftFrom('{"name":"Harbour"}', { canon })?.canon, canon);
  assert.deepEqual(parseDraftFrom('{"canon":[]}', { canon })?.canon, []);
});

it("partial sheets retain their summary and reordered questions retain approval identities", async () => {
  const { dir, path } = await draft();
  await writeFile(path, JSON.stringify({ name: "Maren", line: "She keeps the gate.", sheet: { sections: { Appearance: "A red coat." } } }));
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour", threads: ["Who built the gate?", "What lies beyond?"] }));
  await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour", threads: ["What lies beyond?", "Who built the gate?"] }));
  const review = await reviewGenesisContent(dir);
  assert.equal(review.selected.characters[0]?.sheet?.sections["Essence"], "She keeps the gate.");
  assert.ok(review.cards.every(card => card.status === "approved"));
  assert.equal(review.selected.threads.length, 2);
});

it("renaming an approved character invalidates key art naming the old identity", async () => {
  const { dir, path } = await draft();
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour", keyArt: { characters: ["Maren"] } }));
  await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
  await writeFile(path, JSON.stringify({ name: "The unseen keeper", neverDepicted: true }));
  await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards.filter(card => card.key === "character:maren"), "approve", ulid());
  await assert.rejects(approvedBlueprintForFounding(dir), /Key art names Maren/);
});

it("reverting to the selected version is approved, while an older superseded version needs approval", async () => {
  const { dir, path } = await draft();
  const first = (await reviewGenesisContent(dir)).cards.find(card => card.key === "character:maren")!;
  await decideGenesisContent(dir, [first], "approve", ulid());
  await writeFile(path, JSON.stringify({ name: "Maren the Second" }));
  const second = (await reviewGenesisContent(dir)).cards.find(card => card.key === first.key)!;
  await decideGenesisContent(dir, [second], "reject", ulid());
  assert.equal(first.content.kind, "character");
  await writeFile(path, JSON.stringify(first.content.value));
  assert.equal((await reviewGenesisContent(dir)).cards.find(card => card.key === first.key)?.status, "approved");
  await writeFile(path, JSON.stringify(second.content.value));
  await decideGenesisContent(dir, [second], "approve", ulid());
  await writeFile(path, JSON.stringify(first.content.value));
  assert.equal((await reviewGenesisContent(dir)).cards.find(card => card.key === first.key)?.status, "pending");
});

it("duplicate canon identities and oversized character roles block founding", async () => {
  const { dir, path } = await draft();
  const canon = { slug: "same", type: "rule", title: "One", statement: "One fact" };
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour", canon: [canon, { ...canon, title: "Two" }] }));
  assert.ok((await reviewGenesisContent(dir)).problems.some(problem => problem.includes("draft.json")));
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour" }));
  await writeFile(path, JSON.stringify({ name: "Maren", sheet: { sections: { Essence: "Keeper", Appearance: "Red coat" }, role: "A".repeat(29) } }));
  await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
  await assert.rejects(approvedBlueprintForFounding(dir), /28 characters/);
});

it("founding refuses unapproved content and keeps the exact approved version after a rejected edit", async () => {
  const { dir, path } = await draft();
  await assert.rejects(approvedBlueprintForFounding(dir), /Approve the world identity/);
  const review = await reviewGenesisContent(dir);
  await decideGenesisContent(dir, review.cards, "approve", ulid());
  await writeFile(path, JSON.stringify({ name: "Maren", sheet: { sections: { Essence: "She opens the gate.", Appearance: "A blue coat." } } }));
  const changed = await reviewGenesisContent(dir);
  const card = changed.cards.find(card => card.key === "character:maren")!;
  assert.equal(card.status, "pending");
  assert.ok(card.previous);
  await decideGenesisContent(dir, [card], "reject", ulid());
  const selected = await approvedBlueprintForFounding(dir);
  assert.equal(selected.characters[0]?.sheet?.sections["Essence"], "She keeps the gate.");
  assert.equal(selected.characters[0]?.sheet?.sections["Appearance"], "A red coat.");
});

it("a stale batch rejects every choice before writing a decision", async () => {
  const { dir, path } = await draft();
  const old = await reviewGenesisContent(dir);
  await writeFile(path, JSON.stringify({ name: "A different Maren" }));
  await assert.rejects(decideGenesisContent(dir, old.cards, "approve", ulid()), /content changed/);
  const { events } = await (await genesisConversation(dir)).read();
  assert.equal(events.filter(event => event.event.type === "founding.decision").length, 0);
});

it("replayed approval is idempotent and a removal needs its own decision", async () => {
  const { dir, path } = await draft();
  const initial = await reviewGenesisContent(dir);
  const requestId = ulid();
  await decideGenesisContent(dir, initial.cards, "approve", requestId);
  await decideGenesisContent(dir, initial.cards, "approve", requestId);
  assert.equal((await (await genesisConversation(dir)).read()).events.filter(event => event.event.type === "founding.decision").length, initial.cards.length);
  await writeFile(path, JSON.stringify({ name: "Maren", withdrawn: true }));
  const removal = (await reviewGenesisContent(dir)).cards.find(card => card.key === "character:maren")!;
  assert.equal(removal.content.kind, "remove");
  assert.equal((await approvedBlueprintForFounding(dir)).characters.length, 1);
  await decideGenesisContent(dir, [removal], "approve", ulid());
  assert.equal((await approvedBlueprintForFounding(dir)).characters.length, 0);
});

it("unapproved relationship targets block founding while open questions remain open", async () => {
  const { dir, path } = await draft();
  await writeFile(path, JSON.stringify({ name: "Maren", sheet: { sections: { Essence: "Keeper", Appearance: "Red coat" }, links: ["location:vigil"] } }));
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour", canon: [{ slug: "gate", type: "thread", title: "Who built it?", statement: "Who built the gate?" }] }));
  await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
  await assert.rejects(approvedBlueprintForFounding(dir), /relationship/);
  assert.equal((await reviewGenesisContent(dir)).selected.canon?.[0]?.type, "thread");
});

it("renaming an entity keeps its stable identity and relationship targets", async () => {
  const { dir, path } = await draft();
  await mkdir(join(dir, "draft", "locations"), { recursive: true });
  await writeFile(join(dir, "draft", "locations", "vigil.json"), JSON.stringify({
    name: "The Vigil", sheet: { sections: { Look: "A lighthouse" }, links: ["character:maren"] },
  }));
  await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
  await writeFile(path, JSON.stringify({ name: "Maren Kest", sheet: { sections: { Essence: "The keeper", Appearance: "Red coat" } } }));
  const renamed = (await reviewGenesisContent(dir)).cards.find(card => card.key === "character:maren")!;
  assert.equal(renamed.status, "pending");
  await decideGenesisContent(dir, [renamed], "approve", ulid());
  const selected = await approvedBlueprintForFounding(dir);
  assert.equal(selected.characters[0]?.slug, "maren");
  assert.equal(selected.characters[0]?.name, "Maren Kest");
  assert.deepEqual(selected.locations[0]?.sheet?.links, ["character:maren"]);
});

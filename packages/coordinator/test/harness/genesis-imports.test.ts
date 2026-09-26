import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "@arke-studio/contracts";
import { FsWorldProvider } from "../../src/world/provider.js";
import { tempDir } from "../tmp.js";
import { reviewGenesisImports, resolveGenesisImport, validateGenesisSources, recoverGenesisImports, carryGenesisSources } from "../../src/harness/genesis-imports.js";
import { decideGenesisContent, reviewGenesisContent, approvedBlueprintForFounding } from "../../src/harness/genesis-review.js";
import { foldBlueprint } from "../../src/harness/blueprint.js";
import { genesisControlDir, genesisConversation } from "../../src/harness/genesis-conversation.js";

async function setup() {
  const provider = new FsWorldProvider(await tempDir("founding-imports-"));
  const dir = await provider.genesisDir("gen-import");
  await mkdir(join(dir, "attachments"), { recursive: true });
  await mkdir(join(dir, "draft", "imports"), { recursive: true });
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour" }));
  await writeFile(join(dir, "attachments", "notes.md"), "# Cast\nMaren keeps the lighthouse.\nThe gate closes at dusk.");
  await writeFile(join(dir, "draft", "imports", "maren.json"), JSON.stringify({
    source: "notes.md", kind: "character", name: "Maren", body: "Keeper of the lighthouse",
    quote: "Maren keeps the lighthouse.", section: "Essence",
  }));
  return { provider, dir };
}
it("imports verified evidence as an editable proposal and requires separate exact content approval", async t => {
  const { provider, dir } = await setup(); t.after(() => provider.close());
  const review = await reviewGenesisImports(dir), card = review.cards[0]!;
  assert.equal(card.source.line, 2); assert.deepEqual(card.matches, []);
  await resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "prepare", name: "Maren Kest", body: "Maren guards the light.", mode: "distinct" });
  const draft = await foldBlueprint(dir), entity = draft.characters[0]!;
  assert.equal(entity.sources?.[0]?.modified, true);
  assert.equal(entity.sources?.[0]?.originalBody, "Keeper of the lighthouse");
  assert.match(entity.sheet!.sections["Essence"]!, /Source: notes.md, line 2/);
  assert.equal((await reviewGenesisContent(dir)).selected.characters.length, 0);
  const content = await reviewGenesisContent(dir);
  await decideGenesisContent(dir, content.cards.map(card => ({ key: card.key, digest: card.digest })), "approve", ulid());
  const approved = await approvedBlueprintForFounding(dir);
  assert.equal(approved.characters[0]!.name, "Maren Kest");
  const revised = { ...entity, name: "Maren of the Light", sources: undefined };
  await writeFile(join(dir, "draft", "characters", entity.slug + ".json"), JSON.stringify(revised));
  const revisedCard = (await reviewGenesisContent(dir)).cards.find(card => card.key === "character:" + entity.slug)!;
  assert.ok(revisedCard.content.kind === "character");
  assert.equal(revisedCard.content.value.sources?.[0]?.hash, card.source.hash);
  assert.equal(revisedCard.content.value.sources?.[0]?.modified, true);
  await writeFile(join(dir, "attachments", "notes.md"), "Replaced document");
  await validateGenesisSources(dir, approved);
  const { worldId } = await provider.createWorld({ name: "Harbour" }); await provider.loadWorld(worldId);
  await carryGenesisSources(dir, approved, provider.openStore()!);
  await carryGenesisSources(dir, approved, provider.openStore()!);
  assert.equal(provider.openStore()!.getBundle().artifacts.length, 1);
  assert.deepEqual(provider.openStore()!.getBundle().artifacts[0]!.links, ["character-" + entity.slug]);
  await resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "prepare", mode: "distinct" });
  assert.equal((await foldBlueprint(dir)).characters.length, 1);
});

it("refuses append or replace when the edited import has no merge target", async t => {
  const { provider, dir } = await setup(); t.after(() => provider.close());
  const card = (await reviewGenesisImports(dir)).cards[0]!;
  for (const mode of ["append", "replace"] as const) {
    await assert.rejects(resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "prepare", mode }), /Select the record/);
  }
  assert.equal((await foldBlueprint(dir)).characters.length, 0);
});
it("shows current conflicts, refuses stale merges, and leaves deferred material unapproved", async () => {
  const { dir } = await setup();
  await mkdir(join(dir, "draft", "characters"));
  await writeFile(join(dir, "draft", "characters", "maren.json"), JSON.stringify({ name: "Maren", line: "Never visits the lighthouse" }));
  let card = (await reviewGenesisImports(dir)).cards[0]!;
  assert.match(card.matches[0]!.text, /Never visits/);
  await writeFile(join(dir, "draft", "characters", "maren.json"), JSON.stringify({ name: "Maren", line: "Lives inland" }));
  await assert.rejects(resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "prepare", target: "character:maren", mode: "replace" }), /changed/);
  card = (await reviewGenesisImports(dir)).cards[0]!;
  await resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "defer" });
  assert.equal((await reviewGenesisImports(dir)).cards[0]!.status, "deferred");
  assert.equal((await reviewGenesisContent(dir)).selected.characters.length, 0);
  await resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "prepare", target: "character:maren", mode: "replace" });
  assert.equal((await foldBlueprint(dir)).characters.length, 1);
  assert.match((await foldBlueprint(dir)).characters[0]!.sheet!.sections["Essence"]!, /Keeper of the lighthouse/);
});
it("counts bad citations, reports unsupported documents and deduplicates repeated source bytes", async () => {
  const { dir } = await setup();
  await writeFile(join(dir, "attachments", "copy.md"), await readFile(join(dir, "attachments", "notes.md")));
  await writeFile(join(dir, "attachments", "archive.docx"), "unsupported");
  const original = JSON.parse(await readFile(join(dir, "draft", "imports", "maren.json"), "utf8"));
  await writeFile(join(dir, "draft", "imports", "copy.json"), JSON.stringify({ ...original, source: "copy.md" }));
  await writeFile(join(dir, "draft", "imports", "false.json"), JSON.stringify({ ...original, quote: "Maren can fly." }));
  const review = await reviewGenesisImports(dir);
  assert.equal(review.cards.length, 1);
  assert.equal(review.problems.length, 1); assert.match(review.problems[0]!, /quote not found/);
  assert.equal(review.documents.find(document => document.name === "archive.docx")?.supported, false);
  const card = review.cards[0]!;
  await resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "reject" });
  assert.equal((await reviewGenesisImports(dir)).cards[0]!.status, "rejected");
  assert.equal((await foldBlueprint(dir)).characters.length, 0);
});
it("replays an interrupted prepared write once and refuses altered private source bytes", async () => {
  const { dir } = await setup();
  const card = (await reviewGenesisImports(dir)).cards[0]!;
  await resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "prepare", mode: "distinct" });
  const path = join(genesisControlDir(dir), "imports.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.resolutions[card.id].applied = false;
  await writeFile(path, JSON.stringify(state));
  await recoverGenesisImports(dir); await recoverGenesisImports(dir);
  const draft = await foldBlueprint(dir);
  assert.equal(draft.characters.length, 1);
  await writeFile(join(genesisControlDir(dir), "sources", card.source.hash.slice(7), card.source.name), "tampered");
  await assert.rejects(validateGenesisSources(dir, draft), /source changed/);
});

it("binds evidence to its prepared target and verifies restored evidence before approval", async () => {
  const { dir } = await setup();
  const card = (await reviewGenesisImports(dir)).cards[0]!;
  await resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "prepare" });
  const draft = await foldBlueprint(dir), original = draft.characters[0]!;
  const copied = structuredClone(draft);
  copied.characters.push({ ...original, slug: "impostor", name: "Someone else" });
  await assert.rejects(validateGenesisSources(dir, copied), /prepared target/);
  await writeFile(join(dir, "draft", "characters", original.slug + ".json"), JSON.stringify({ ...original, sources: undefined }));
  const reviewed = await reviewGenesisContent(dir);
  await writeFile(join(genesisControlDir(dir), "sources", card.source.hash.slice(7), card.source.name), "corrupt");
  await assert.rejects(decideGenesisContent(dir, reviewed.cards, "approve", ulid()), /source changed/);
  assert.equal((await (await genesisConversation(dir)).read()).events.filter(row => row.event.type === "founding.decision").length, 0);
  const rejected = await decideGenesisContent(dir, reviewed.cards, "reject", ulid());
  assert.ok(rejected.cards.every(card => card.status === "rejected"));
});

it("refreshes deferred interpretations and checks duplicate names submitted by the author", async () => {
  const { dir } = await setup();
  const card = (await reviewGenesisImports(dir)).cards[0]!;
  await resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "defer" });
  const path = join(dir, "draft", "imports", "maren.json");
  const proposal = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...proposal, body: "Revised interpretation" }));
  const revised = (await reviewGenesisImports(dir)).cards[0]!;
  assert.equal(revised.proposal.body, "Revised interpretation");
  assert.notEqual(revised.digest, card.digest);
  await mkdir(join(dir, "draft", "characters"));
  await writeFile(join(dir, "draft", "characters", "other.json"), JSON.stringify({ name: "Other" }));
  await assert.rejects(resolveGenesisImport(dir, { id: revised.id, digest: revised.digest, decision: "prepare", name: "Other" }), /edited name matches/);
  await resolveGenesisImport(dir, { id: revised.id, digest: revised.digest, decision: "prepare", name: "Other", mode: "distinct" });
  assert.equal((await foldBlueprint(dir)).characters.length, 2);
});

it("retains long quoted evidence without overflowing the authored section", async () => {
  const { dir } = await setup();
  const quote = "a".repeat(7900);
  await writeFile(join(dir, "attachments", "notes.md"), quote);
  await writeFile(join(dir, "draft", "imports", "maren.json"), JSON.stringify({
    source: "notes.md", kind: "character", name: "Maren", body: "Interpretation ".repeat(20), quote, section: "Essence",
  }));
  const card = (await reviewGenesisImports(dir)).cards[0]!;
  await resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "prepare" });
  const entity = (await foldBlueprint(dir)).characters[0]!;
  assert.ok(entity.sheet!.sections["Essence"]!.length < 8000);
  assert.equal(entity.sources![0]!.quote, quote);
});

it("withdraws replaced proposals and does not restore superseded evidence", async () => {
  const { dir } = await setup();
  const path = join(dir, "draft", "imports", "maren.json");
  const initial = (await reviewGenesisImports(dir)).cards[0]!;
  await resolveGenesisImport(dir, { id: initial.id, digest: initial.digest, decision: "defer" });
  const proposal = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...proposal, name: "Maren Kest" }));
  const revised = (await reviewGenesisImports(dir)).cards;
  assert.equal(revised.length, 1);
  assert.notEqual(revised[0]!.id, initial.id);
  await assert.rejects(resolveGenesisImport(dir, { id: initial.id, digest: initial.digest, decision: "prepare" }), /unavailable/);
  await resolveGenesisImport(dir, { id: revised[0]!.id, digest: revised[0]!.digest, decision: "prepare" });
  const entity = (await foldBlueprint(dir)).characters[0]!;
  await writeFile(path, JSON.stringify({ ...proposal, name: "Maren Kest", quote: "The gate closes at dusk.", body: "Guards the evening gate." }));
  const next = (await reviewGenesisImports(dir)).cards.find(card => card.status === "pending")!;
  await resolveGenesisImport(dir, { id: next.id, digest: next.digest, decision: "prepare", mode: "replace", target: "character:" + entity.slug });
  const content = (await reviewGenesisContent(dir)).cards.find(card => card.key === "character:" + entity.slug)!;
  assert.ok(content.content.kind === "character");
  assert.deepEqual(content.content.value.sources?.map(source => source.candidateId), [next.id]);
});

it("bounds duplicate excerpts in large import reviews", async () => {
  const { dir } = await setup();
  const path = join(dir, "draft", "imports", "maren.json");
  const proposal = JSON.parse(await readFile(path, "utf8"));
  const quotes = Array.from({ length: 12 }, (_, i) => `Maren guards gate ${i}.`);
  await writeFile(join(dir, "attachments", "notes.md"), [proposal.quote, ...quotes].join("\n"));
  for (let i = 0; i < 12; i++) {
    await writeFile(join(dir, "draft", "imports", `copy-${i}.json`), JSON.stringify({ ...proposal, quote: quotes[i], body: "x".repeat(6000) }));
  }
  const review = await reviewGenesisImports(dir);
  assert.equal(review.cards.length, 13);
  assert.ok(review.cards.every(card => card.related.length <= 5 && card.related.every(other => other.text.length <= 601)));
});

it("replacing one section preserves the other section's evidence", async () => {
  const { dir } = await setup();
  const proposalPath = join(dir, "draft", "imports", "maren.json");
  const original = JSON.parse(await readFile(proposalPath, "utf8"));
  const first = (await reviewGenesisImports(dir)).cards[0]!;
  await resolveGenesisImport(dir, { id: first.id, digest: first.digest, decision: "prepare" });
  const target = "character:" + (await foldBlueprint(dir)).characters[0]!.slug;
  await writeFile(proposalPath, JSON.stringify({ ...original, section: "Appearance", body: "A dark coat." }));
  const appearance = (await reviewGenesisImports(dir)).cards.find(card => card.status === "pending")!;
  await resolveGenesisImport(dir, { id: appearance.id, digest: appearance.digest, decision: "prepare", target, mode: "replace" });
  await writeFile(proposalPath, JSON.stringify({ ...original, quote: "The gate closes at dusk.", body: "Closes the gate." }));
  const replacement = (await reviewGenesisImports(dir)).cards.find(card => card.status === "pending")!;
  await resolveGenesisImport(dir, { id: replacement.id, digest: replacement.digest, decision: "prepare", target, mode: "replace" });
  const card = (await reviewGenesisContent(dir)).cards.find(card => card.key === target)!;
  assert.ok(card.content.kind === "character");
  assert.deepEqual(card.content.value.sources?.map(source => source.candidateId).sort(), [appearance.id, replacement.id].sort());
  assert.match(card.content.value.sheet!.sections["Appearance"]!, /dark coat/);
});

it("conflicting duplicate proposal identities are visible and cannot be prepared", async () => {
  const { dir } = await setup();
  const original = JSON.parse(await readFile(join(dir, "draft", "imports", "maren.json"), "utf8"));
  await writeFile(join(dir, "draft", "imports", "conflict.json"), JSON.stringify({ ...original, body: "A different interpretation." }));
  const review = await reviewGenesisImports(dir);
  assert.equal(review.cards.length, 0);
  assert.match(review.problems.join(" "), /Conflicting files/);
});

it("new imported entities retain natural relationship keys and legacy source-shaped data stays readable", async () => {
  const { dir } = await setup();
  await writeFile(join(dir, "draft", "imports", "maren.json"), JSON.stringify({ source: "notes.md", kind: "character", name: "Maren",
    body: "Keeper", quote: "Maren keeps the lighthouse.", links: ["location:the-vigil"] }));
  await writeFile(join(dir, "draft", "imports", "vigil.json"), JSON.stringify({ source: "notes.md", kind: "location", name: "The Vigil",
    body: "Lighthouse", quote: "Maren keeps the lighthouse." }));
  for (const name of ["Maren", "The Vigil"]) {
    const card = (await reviewGenesisImports(dir)).cards.find(card => card.proposal.name === name)!;
    await resolveGenesisImport(dir, { id: card.id, digest: card.digest, decision: "prepare" });
  }
  await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
  const approved = await approvedBlueprintForFounding(dir);
  assert.equal(approved.locations[0]?.slug, "the-vigil");
  assert.deepEqual(approved.characters[0]?.sheet?.links, ["location:the-vigil"]);
  await writeFile(join(dir, "draft", "characters", "legacy.json"), JSON.stringify({ name: "Legacy keeper", sources: ["Old handwritten notes"], line: "Keeps the gate" }));
  const folded = await foldBlueprint(dir);
  assert.equal(folded.characters.find(entity => entity.slug === "legacy")?.line, "Keeps the gate");
  assert.deepEqual(folded.dropped, []);
});
it("reports proposal files beyond the review cap", async () => {
  const { dir } = await setup();
  const proposal = await readFile(join(dir, "draft", "imports", "maren.json"));
  await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(join(dir, "draft", "imports", `copy-${index}.json`), proposal)));
  assert.ok((await reviewGenesisImports(dir)).problems.some(problem => problem.includes("1 import proposal files exceed")));
});
it("normalizes default sections and whitespace, and preserves edits containing the original wording", async t => {
  const { provider, dir } = await setup(); t.after(() => provider.close());
  const file = join(dir, "draft", "imports", "maren.json");
  const proposal = JSON.parse(await readFile(file, "utf8"));
  delete proposal.section;
  await writeFile(file, JSON.stringify(proposal));
  const first = (await reviewGenesisImports(dir)).cards[0]!;
  await writeFile(file, JSON.stringify({ ...proposal, section: "Essence", name: " Maren " }));
  const normalized = (await reviewGenesisImports(dir)).cards[0]!;
  assert.equal(normalized.id, first.id);
  await resolveGenesisImport(dir, { id: normalized.id, digest: normalized.digest, decision: "prepare", body: proposal.body + " and harbour" });
  const reviewed = (await reviewGenesisContent(dir)).cards.find(card => card.content.kind === "character")!;
  assert.ok(reviewed.content.kind === "character");
  assert.equal(reviewed.content.value.sources?.[0]?.modified, true);
  await writeFile(file, JSON.stringify({ ...proposal, quote: "The gate closes at dusk.", name: " Maren " }));
  const next = (await reviewGenesisImports(dir)).cards.find(card => card.status === "pending")!;
  await assert.rejects(resolveGenesisImport(dir, { id: next.id, digest: next.digest, decision: "prepare", name: "Maren " }), /matches an existing/);
});

it("binds imported relationships across documents to the distinct prepared target", async t => {
  const { provider, dir } = await setup(); t.after(() => provider.close());
  await mkdir(join(dir, "draft", "locations"), { recursive: true });
  await writeFile(join(dir, "draft", "locations", "the-vigil.json"), JSON.stringify({ name: "The Vigil", line: "Old place" }));
  await writeFile(join(dir, "attachments", "places.md"), "The gate closes at dusk. A separate document.");
  await writeFile(join(dir, "draft", "imports", "vigil.json"), JSON.stringify({
    source: "places.md", kind: "location", name: "The Vigil", body: "The imported place", quote: "The gate closes at dusk.",
  }));
  const maren = JSON.parse(await readFile(join(dir, "draft", "imports", "maren.json"), "utf8"));
  await writeFile(join(dir, "draft", "imports", "maren.json"), JSON.stringify({ ...maren, links: ["location:the-vigil"] }));
  let cards = (await reviewGenesisImports(dir)).cards;
  const character = cards.find(card => card.proposal.kind === "character")!;
  await assert.rejects(resolveGenesisImport(dir, { id: character.id, digest: character.digest, decision: "prepare" }), /Prepare the imported relationship target/);
  const location = cards.find(card => card.proposal.kind === "location")!;
  await resolveGenesisImport(dir, { id: location.id, digest: location.digest, decision: "prepare", mode: "distinct" });
  cards = (await reviewGenesisImports(dir)).cards;
  const prepared = cards.find(card => card.id === location.id)!;
  const current = cards.find(card => card.id === character.id)!;
  await resolveGenesisImport(dir, { id: current.id, digest: current.digest, decision: "prepare" });
  assert.deepEqual((await foldBlueprint(dir)).characters[0]!.sheet!.links, [prepared.target]);
  assert.notEqual(prepared.target, "location:the-vigil");
});

it("bounds duplicate excerpts and refuses a canon import beyond the persisted limit", async t => {
  const { provider, dir } = await setup(); t.after(() => provider.close());
  await mkdir(join(dir, "draft", "characters"), { recursive: true });
  for (let i = 0; i < 25; i++) await writeFile(join(dir, "draft", "characters", "maren-" + i + ".json"),
    JSON.stringify({ name: "Maren", sheet: { sections: { Essence: "word ".repeat(1200) }, links: [] } }));
  const card = (await reviewGenesisImports(dir)).cards[0]!;
  assert.equal(card.matches.length, 20);
  assert.ok(card.matches.every(match => match.text.length <= 601));
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour",
    canon: Array.from({ length: 100 }, (_, i) => ({ slug: "entry-" + i, title: "Entry " + i, type: "lore", statement: "Existing" })) }));
  await writeFile(join(dir, "draft", "imports", "canon.json"), JSON.stringify({
    source: "notes.md", kind: "canon", name: "The gate", body: "Closed at dusk", quote: "The gate closes at dusk.",
  }));
  const canon = (await reviewGenesisImports(dir)).cards.find(card => card.proposal.kind === "canon")!;
  await assert.rejects(resolveGenesisImport(dir, { id: canon.id, digest: canon.digest, decision: "prepare" }));
  assert.equal((await foldBlueprint(dir)).canon?.length, 100);
  assert.equal((await reviewGenesisImports(dir)).cards.find(card => card.id === canon.id)?.status, "pending");
});

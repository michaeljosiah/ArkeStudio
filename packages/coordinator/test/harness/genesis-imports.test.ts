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

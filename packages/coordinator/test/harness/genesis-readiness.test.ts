import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { reviewGenesisContent, decideGenesisContent } from "../../src/harness/genesis-review.js";
import { reviewGenesisReadiness, leaveGenesisFinding } from "../../src/harness/genesis-readiness.js";
const inputs = { jobs: [], catalogue: [], models: [] };
async function setup() {
  const provider = new FsWorldProvider(await tempDir("readiness-"));
  const dir = await provider.genesisDir("gen-ready");
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour", threads: ["Who built the gate?"] }));
  await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
  return dir;
}
it("allows a minimal text world and intentional open questions, but refuses stale review choices", async () => {
  const dir = await setup();
  const review = await reviewGenesisReadiness(dir, inputs);
  assert.equal(review.canBegin, true);
  const question = review.findings.find(finding => finding.category === "open")!;
  const left = await leaveGenesisFinding(dir, inputs, review.digest, question.id);
  assert.equal(left.findings.find(finding => finding.id === question.id)?.leftOpen, true);
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Another harbour" }));
  await assert.rejects(leaveGenesisFinding(dir, inputs, left.digest, question.id), /review changed/);
});
it("separates invalid approved links from possible contradictory import interpretations", async () => {
  const dir = await setup();
  await mkdir(join(dir, "draft", "characters"), { recursive: true });
  await writeFile(join(dir, "draft", "characters", "maren.json"), JSON.stringify({ name: "Maren",
    sheet: { sections: { Essence: "Maren never visits the lighthouse." }, links: ["location:missing"] } }));
  await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
  await mkdir(join(dir, "draft", "imports"), { recursive: true });
  await mkdir(join(dir, "attachments"), { recursive: true });
  await writeFile(join(dir, "attachments", "notes.md"), "Maren lives in the lighthouse.");
  await writeFile(join(dir, "draft", "imports", "maren.json"), JSON.stringify({ source: "notes.md", kind: "character", name: "Maren",
    body: "Maren lives in the lighthouse.", quote: "Maren lives in the lighthouse.", section: "Essence" }));
  const review = await reviewGenesisReadiness(dir, inputs);
  assert.equal(review.canBegin, false);
  const blocker = review.findings.find(finding => finding.category === "blocker")!;
  await assert.rejects(leaveGenesisFinding(dir, inputs, review.digest, blocker.id), /requires repair/);
  const conflict = review.findings.find(finding => finding.category === "possible-conflict")!;
  assert.match(conflict.detail, /not a verified conflict/);
  assert.ok(conflict.records.some(record => record.key === "notes.md:1"));
  assert.ok(conflict.records.some(record => record.key === "character:maren"));
  const left = await leaveGenesisFinding(dir, inputs, review.digest, conflict.id);
  assert.equal(left.canBegin, false);
  assert.equal(left.findings.find(finding => finding.id === conflict.id)?.leftOpen, true);
});

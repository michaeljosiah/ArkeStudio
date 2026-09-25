import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GenesisBlueprintSchema, JobSchema, newId, ulid, compileBuildItems, type ManifestModel } from "@arke-studio/contracts";
import { FsWorldProvider } from "../../src/world/provider.js";
import { tempDir } from "../tmp.js";
import { pngBytes } from "../queue/fake-provider.js";
import { decideGenesisImage, genesisImageRequest, reviewGenesisImages, reviewedGenesisImages, savedGenesisImages } from "../../src/harness/genesis-images.js";
import { genesisControlDir, genesisConversation } from "../../src/harness/genesis-conversation.js";

const model: ManifestModel = { id: "test-image", provider: "fal", capability: "image", displayName: "Test Image",
  accepts: { referenceImages: 3, startFrame: false, endFrame: false }, limits: { maxReferenceAudioSec: 60 },
  pricing: { kind: "perImage", microUsdPerImage: 40000 } };
const blueprint = () => GenesisBlueprintSchema.parse({ name: "Harbour", reviewed: true,
  characters: [{ slug: "maren", name: "Maren" }], locations: [{ slug: "vigil", name: "The Vigil" }],
  images: [{ id: "portrait", target: "character:maren", prompt: "Maren in her red coat.", references: [] },
    { id: "view", target: "location:vigil", prompt: "The lighthouse under a winter sky.", references: [] }],
});
async function setup() {
  const provider = new FsWorldProvider(await tempDir("genesis-images-"));
  const dir = await provider.genesisDir("gen-images");
  await mkdir(join(dir, "attachments"), { recursive: true });
  await writeFile(join(dir, "attachments", "portrait.png"), pngBytes());
  return { dir, provider };
}

it("uploaded selection freezes the displayed bytes, survives rename and excludes a replacement generation", async () => {
  const { dir, provider } = await setup();
  const draft = blueprint();
  const review = await reviewGenesisImages(dir, draft, [], model);
  const candidate = review.candidates[0]!;
  const requestId = ulid();
  await decideGenesisImage(dir, draft, { target: "character:maren", requestId, decision: "approve", candidateId: candidate.id, hash: candidate.hash });
  await writeFile(join(dir, "attachments", "portrait.png"), Buffer.concat([pngBytes(), Buffer.from("changed")]));
  draft.characters[0]!.name = "Maren Kest";
  await reviewGenesisImages(dir, draft, [], model);
  const approved = await reviewedGenesisImages(dir, draft, []);
  assert.equal(approved.selectedImages?.[0]?.candidate.hash, candidate.hash);
  const served = await provider.serveGenesisMedia("gen-images", candidate.file);
  assert.ok(served?.path.includes("media"));
  const items = compileBuildItems(approved, { model, referenceImages: 3 });
  const photo = items.find(item => item.key === "main-photo:maren")!;
  assert.equal(photo.kind, "selected-image");
  assert.equal(photo.estimatedMicroUsd, 0);
  assert.equal(photo.idempotencyKey, undefined);
  await decideGenesisImage(dir, draft, { target: "character:maren", requestId, decision: "approve", candidateId: candidate.id, hash: candidate.hash });
  assert.equal((await (await genesisConversation(dir)).read()).events.filter(row => row.event.type === "founding.image-decision").length, 1);
  await decideGenesisImage(dir, draft, { target: "character:maren", requestId: ulid(), decision: "unassign" });
  assert.equal((await savedGenesisImages(dir)).selections.length, 0);
});

it("character and location generation authorizes a request but needs a separate exact-image decision", async () => {
  const { dir } = await setup();
  const draft = blueprint();
  const initial = await reviewGenesisImages(dir, draft, [], model);
  for (const plan of initial.plans) {
    const request = genesisImageRequest("gen-images", plan, ulid());
    assert.equal(request.estimatedMicroUsd, plan.estimatedMicroUsd);
    assert.equal(request.params["prompt"], plan.prompt);
    await mkdir(join(dir, "generated"), { recursive: true });
    const landed = `generated/${request.idempotencyKey}.png`;
    await writeFile(join(dir, landed), pngBytes());
    const job = JobSchema.parse({ ...request, id: newId("jb"), status: "succeeded", providerJobId: null, attempt: 1, error: null,
      landedFiles: [landed], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const ready = await reviewGenesisImages(dir, draft, [job], model);
    assert.ok(!ready.selections.some(selection => selection.target === plan.intent.target));
    const candidate = ready.candidates.find(candidate => candidate.jobId === job.id)!;
    await assert.rejects(decideGenesisImage(dir, draft, { target: plan.intent.target, requestId: ulid(), decision: "approve", candidateId: candidate.id, hash: "sha256:wrong" }), /current image/);
    await decideGenesisImage(dir, draft, { target: plan.intent.target, requestId: ulid(), decision: "reject", candidateId: candidate.id, hash: candidate.hash });
    assert.ok(!(await savedGenesisImages(dir)).selections.some(selection => selection.target === plan.intent.target));
    await decideGenesisImage(dir, draft, { target: plan.intent.target, requestId: ulid(), decision: "approve", candidateId: candidate.id, hash: candidate.hash });
    assert.ok((await savedGenesisImages(dir)).selections.some(selection => selection.target === plan.intent.target));
  }
  assert.equal((await savedGenesisImages(dir)).candidates.filter(candidate => candidate.source === "generated").length, 2);
});

it("a corrupted frozen image cannot be approved or founded", async () => {
  const { dir } = await setup();
  const draft = blueprint();
  const candidate = (await reviewGenesisImages(dir, draft, [], model)).candidates[0]!;
  await decideGenesisImage(dir, draft, { target: "character:maren", requestId: ulid(), decision: "approve", candidateId: candidate.id, hash: candidate.hash });
  await writeFile(join(genesisControlDir(dir), candidate.file), "corrupt");
  await assert.rejects(reviewedGenesisImages(dir, draft, []), /repair/);
  await assert.rejects(decideGenesisImage(dir, draft, { target: "location:vigil", requestId: ulid(), decision: "approve", candidateId: candidate.id, hash: candidate.hash }), /changed/);
});

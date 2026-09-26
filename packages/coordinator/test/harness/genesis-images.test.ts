import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { GenesisBlueprintSchema, GenesisDraftSchema, JobSchema, newId, ulid, compileBuildItems, canDeleteJob, isReplayableFinalization, type Job, type ManifestModel } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
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
  await decideGenesisImage(dir, draft, { target: "character:maren", requestId: ulid(), decision: "unassign", candidateId: candidate.id, hash: candidate.hash });
  assert.equal((await savedGenesisImages(dir)).selections.length, 0);
});

it("refuses a stale removal after another image has been selected", async () => {
  const { dir } = await setup();
  const draft = blueprint();
  const first = (await reviewGenesisImages(dir, draft, [], model)).candidates[0]!;
  await decideGenesisImage(dir, draft, { target: "character:maren", requestId: ulid(), decision: "approve", candidateId: first.id, hash: first.hash });
  await writeFile(join(dir, "attachments", "second.png"), Buffer.concat([pngBytes(), Buffer.from("second")]));
  const second = (await reviewGenesisImages(dir, draft, [], model)).candidates.find(candidate => candidate.label === "second.png")!;
  await decideGenesisImage(dir, draft, { target: "character:maren", requestId: ulid(), decision: "approve", candidateId: second.id, hash: second.hash });
  await assert.rejects(decideGenesisImage(dir, draft, { target: "character:maren", requestId: ulid(), decision: "unassign", candidateId: first.id, hash: first.hash }), /selected image changed/);
  assert.equal((await savedGenesisImages(dir)).selections[0]?.candidate.id, second.id);
});

it("preserves a completed generation during finalization before its Activity row can be deleted", async () => {
  const { dir, provider } = await setup();
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour", reviewed: true }));
  const plan = (await reviewGenesisImages(dir, blueprint(), [], model)).plans[0]!;
  const request = genesisImageRequest("gen-images", plan, ulid());
  await mkdir(join(dir, "generated"), { recursive: true });
  const landed = "generated/portrait.png";
  await writeFile(join(dir, landed), pngBytes());
  const job = JobSchema.parse({ ...request, id: newId("jb"), status: "succeeded", providerJobId: null, attempt: 1, error: null,
    landedFiles: [landed], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  assert.equal(isReplayableFinalization(job), true);
  assert.equal(canDeleteJob(job), false, "legacy rows also remain protected until repaired");
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(dir, "changes.jsonl"), appVersion: "test" });
  const finalizer = coordinator as unknown as { onJobTerminal(job: Job): Promise<void> };
  await finalizer.onJobTerminal(job);
  await finalizer.onJobTerminal(job);
  assert.equal((await savedGenesisImages(dir)).candidates.filter(candidate => candidate.jobId === job.id).length, 1);
  assert.equal(canDeleteJob({ ...job, finalization: { status: "complete", error: null, updatedAt: job.updatedAt } }), true);
  await rm(join(dir, landed));
  assert.ok((await reviewGenesisImages(dir, blueprint(), [], model)).candidates.some(candidate => candidate.jobId === job.id));
  await provider.close();
});

it("rejects duplicate image proposal identities in drafts and blueprints", () => {
  const draft = blueprint();
  const images = [draft.images![0]!, { ...draft.images![1]!, id: draft.images![0]!.id }];
  assert.equal(GenesisBlueprintSchema.safeParse({ ...draft, images }).success, false);
  assert.equal(GenesisDraftSchema.safeParse({ name: "Harbour", images }).success, false);
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

it("journal recovery preserves selected candidates and validates their bytes without the image cache", async () => {
  const { dir } = await setup();
  const draft = blueprint();
  const candidate = (await reviewGenesisImages(dir, draft, [], model)).candidates[0]!;
  await decideGenesisImage(dir, draft, { target: "character:maren", requestId: ulid(), decision: "approve", candidateId: candidate.id, hash: candidate.hash });
  await rm(join(genesisControlDir(dir), "images.json"));
  assert.equal((await savedGenesisImages(dir)).candidates[0]?.hash, candidate.hash);
  await reviewedGenesisImages(dir, draft, []);
  await writeFile(join(genesisControlDir(dir), candidate.file), "corrupted");
  await assert.rejects(reviewedGenesisImages(dir, draft, []), /changed|image/i);
});

it("unselected retained candidates are validated before any world is published", async () => {
  const { dir } = await setup();
  const draft = blueprint();
  const candidate = (await reviewGenesisImages(dir, draft, [], model)).candidates[0]!;
  await writeFile(join(genesisControlDir(dir), candidate.file), "corrupt");
  await assert.rejects(reviewedGenesisImages(dir, draft, []), /repair/);
});

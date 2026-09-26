import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  JobSchema,
  newId,
  ulid,
  type BuildReview,
  type DomainEvent,
  type FoundingBuildState,
  type Job,
  type JobStatus,
  type ManifestModel,
  type ModelManifest,
  type QueueStatus,
} from "@arke-studio/contracts";
import { editSheetContent } from "../../src/sheets/authoring.js";
import { MarkdownFile } from "../../src/world/text-files.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { FoundingBuildService, type FoundingBuildPorts } from "../../src/world/founding-build.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { readKit } from "../../src/references/kit.js";
import { assembleKeyArt, readKeyArtBrief } from "../../src/references/key-art-references.js";
import { approvedBlueprintForFounding, decideGenesisContent, reviewGenesisContent } from "../../src/harness/genesis-review.js";
import { reviewGenesisImports, resolveGenesisImport } from "../../src/harness/genesis-imports.js";
import { decideGenesisImage, reviewGenesisImages, reviewedGenesisImages } from "../../src/harness/genesis-images.js";
import { installGenesisImage } from "../../src/harness/genesis-image-carry.js";
import { genesisPropId, genesisPropStateId } from "../../src/harness/genesis-props.js";
import { decideGenesisVoice, reviewGenesisVoices, reviewedGenesisVoices, generateLocalGenesisVoice } from "../../src/harness/genesis-voices.js";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { sandboxAttachments } from "../../src/artifacts/genesis-attachments.js";

/**
 * The founding build, end to end against a real world on disk (SPEC-031 §4). The queue is
 * the one fake: jobs land their files and settle instantly, so the run's ordering, landing
 * and durability are what is under test — not a provider.
 */

const MODEL: ManifestModel = {
  id: "test-image",
  provider: "fal",
  capability: "image",
  displayName: "Test Image",
  accepts: { referenceImages: 3, startFrame: false, endFrame: false },
  limits: { maxReferenceAudioSec: 60 },
  pricing: { kind: "perImage", microUsdPerImage: 40000 },
};
const MANIFEST: ModelManifest = { manifestVersion: 1, generated: "2026-08-26", models: [MODEL] };

/** A one-pixel PNG — bytes enough for every copy the landing paths make. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

class FakeQueue {
  readonly jobs = new Map<string, Job>();
  private readonly byKey = new Map<string, string>();
  readonly cancelled: string[] = [];
  /** Targets that fail instead of landing, by target kind and optional id prefix. */
  failWhen: (input: EnqueueInput) => boolean = () => false;
  /** Targets that stay running until settled by hand. */
  holdWhen: (input: EnqueueInput) => boolean = () => false;

  constructor(private readonly worldDir: () => string | null) {}

  async enqueue(input: EnqueueInput): Promise<Job> {
    const known = input.idempotencyKey !== undefined ? this.byKey.get(input.idempotencyKey) : undefined;
    if (known !== undefined) return this.jobs.get(known)!;
    const id = newId("jb");
    const held = this.holdWhen(input);
    const failed = !held && this.failWhen(input);
    let landedFiles: string[] | undefined;
    const dir = this.worldDir();
    if (!held && !failed && input.landing && dir) {
      const rel = `${input.landing.dir}/${input.landing.name ?? "artifact.png"}`;
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), PNG);
      landedFiles = [rel];
    }
    const now = new Date().toISOString();
    const job = JobSchema.parse({
      id,
      idempotencyKey: input.idempotencyKey ?? ulid(),
      worldId: input.worldId,
      target: input.target,
      capability: input.capability,
      provider: input.provider,
      model: input.model,
      params: input.params,
      estimatedMicroUsd: input.estimatedMicroUsd,
      status: held ? "running" : failed ? "failed" : "succeeded",
      providerJobId: null,
      attempt: 1,
      error: failed ? "the provider rejected the credential (HTTP 401)" : null,
      ...(input.landing !== undefined ? { landing: input.landing } : {}),
      ...(landedFiles !== undefined ? { landedFiles } : {}),
      createdAt: now,
      updatedAt: now,
    });
    this.jobs.set(id, job);
    if (input.idempotencyKey !== undefined) this.byKey.set(input.idempotencyKey, id);
    return job;
  }

  async cancel(jobId: string): Promise<void> {
    this.cancelled.push(jobId);
    const job = this.jobs.get(jobId);
    if (job && (job.status === "running" || job.status === "queued")) {
      this.jobs.set(jobId, { ...job, status: "cancelled", updatedAt: new Date().toISOString() });
    }
  }
}

async function makeSandbox(root: string, genesisId: string): Promise<string> {
  const dir = join(root, ".genesis-v2", genesisId, "workspace");
  await mkdir(join(dir, "draft", "characters"), { recursive: true });
  await mkdir(join(dir, "draft", "locations"), { recursive: true });
  await writeFile(
    join(dir, "draft.json"),
    JSON.stringify({
      name: "The Undersong",
      logline: "A drowned god still sings beneath the harbour.",
      tone: "quiet dread",
      genre: "coastal fantasy",
      look: "salt-bleached watercolour, cold light off the water",
      bible: "The argument underneath it: the sea keeps what the town will not say aloud.",
      threads: ["Who governs what the water leaves behind?"],
      keyArt: { subject: "Maren at the tideline as the bell answers", characters: ["Maren Kest"] },
    }),
  );
  await writeFile(
    join(dir, "draft", "characters", "maren-kest.json"),
    JSON.stringify({
      name: "Maren Kest",
      line: "Tide-caller, the last one",
      brief: { apparentAge: "around forty", wardrobe: "her brother's coat" },
    }),
  );
  await writeFile(
    join(dir, "draft", "characters", "brother-ellum.json"),
    JSON.stringify({ name: "Brother Ellum", line: "Keeps the ledger of the drowned" }),
  );
  await writeFile(
    join(dir, "draft", "locations", "the-vigil.json"),
    JSON.stringify({
      name: "The Vigil",
      line: "A lighthouse that faces the wrong way",
      brief: { establishingView: "the lamp room from the causeway", hour: "dusk" },
    }),
  );
  return dir;
}

interface Harness {
  root: string;
  provider: FsWorldProvider;
  queue: FakeQueue;
  service: FoundingBuildService;
  events: DomainEvent[];
  queues: QueueStatus[];
  lastState(): FoundingBuildState | null;
  worldId(): string;
}

async function makeHarness(t: TestContext, overrides: Partial<FoundingBuildPorts> = {}): Promise<Harness> {
  const root = await tempDir("arke-build-");
  const provider = new FsWorldProvider(root);
  // Closed when the test ends, pass or fail — an open WorldStore hangs the runner.
  t.after(async () => {
    await provider.close().catch(() => {});
  });
  const queue = new FakeQueue(() => provider.openStore()?.dir ?? null);
  const events: DomainEvent[] = [];
  const queues: QueueStatus[] = [];
  const ports: FoundingBuildPorts = {
    nowIso: () => new Date().toISOString(),
    manifest: MANIFEST,
    loadSettings: async () => null,
    credentialFor: async () => "key",
    harnessReady: () => false,
    genesisDir: (genesisId) => provider.genesisDir(genesisId),
    discardGenesis: (genesisId) => provider.discardGenesis(genesisId),
    releaseGenesis: () => {},
    createWorld: (input) => provider.createWorld(input),
    openWorld: async (worldId) => {
      await provider.loadWorld(worldId);
    },
    openStore: () => provider.openStore(),
    gate: () => provider.gate(),
    carryAttachments: async () => {},
    adoptScopedJobs: async () => {},
    scopedJobs: (genesisId) => [...queue.jobs.values()].filter((job) => job.worldId === genesisId),
    cancelScopedJobs: async () => {},
    authorSheet: async () => {},
    enqueue: (input) => {
      if (input.target.kind === "world-image" && (input.params["droppedReferences"] as unknown[] | undefined)?.length) {
        const published = events.findLast((event) => event.type === "build.state");
        assert.ok(published?.type === "build.state" && published.state.items.some((item) => item.kind === "key-art" && item.detail), "reference loss is published before paid enqueue");
      }
      return queue.enqueue(input);
    },
    jobById: (jobId) => queue.jobs.get(jobId),
    ledgerEntryFor: async () => undefined,
    cancelJob: (jobId) => queue.cancel(jobId),
    queueStatuses: () => queues,
    refreshWorldSnapshot: async () => {},
    refreshWorldList: async () => {},
    emit: (event) => events.push(event),
    log: () => {},
    ...overrides,
  };
  const service = new FoundingBuildService(ports);
  return {
    root,
    provider,
    queue,
    service,
    events,
    queues,
    lastState: () => {
      const found = events.findLast((event) => event.type === "build.state");
      return found && found.type === "build.state" ? found.state : null;
    },
    worldId: () => provider.openStore()?.worldId ?? "",
  };
}

/** The preview as it waits in the sandbox: the image and the words it was made from (R-53). */
async function writePreview(sandbox: string, look: string): Promise<void> {
  await mkdir(join(sandbox, "previews"), { recursive: true });
  await writeFile(join(sandbox, "previews", "look-preview.png"), PNG);
  await writeFile(join(sandbox, "previews", "look-preview.json"), JSON.stringify({ look }) + "\n");
}

/** The receipt beside it: only a succeeded job proves a person pressed and paid (R-51, R-54). */
function addPreviewReceipt(h: Harness, genesisId: string, lookText: string, status: JobStatus = "succeeded"): string {
  const now = new Date().toISOString();
  const receipt = JobSchema.parse({
    id: newId("jb"),
    idempotencyKey: ulid(),
    worldId: genesisId,
    target: { kind: "look-preview", id: genesisId },
    capability: "image",
    provider: "fal",
    model: "test-image",
    params: { lookText },
    estimatedMicroUsd: 40000,
    status,
    providerJobId: null,
    attempt: 1,
    error: null,
    landedFiles: ["previews/look-preview.png"],
    createdAt: now,
    updatedAt: now,
  });
  h.queue.jobs.set(receipt.id, receipt);
  return receipt.id;
}

/** The review the coordinator answered with, which the screen renders verbatim. */
function lastPlan(h: Harness): BuildReview {
  const found = h.events.findLast((event) => event.type === "build.plan");
  assert.ok(found?.type === "build.plan" && found.plan !== null, "the build was sized");
  return found.plan;
}

// 45s predates supervisor.test.ts's budget tiers and already exceeds the settle tier — a
// founding build folds hundreds of in-process steps, so the larger number stays.
const BUILD_MS = 45_000;

describe("the founding build (SPEC-031)", () => {
  it("reuses uploaded and generated selections, preserves alternatives as artifacts, and replays without duplicates", async t => {
    let h!: Harness;
    h = await makeHarness(t, { manifest: MANIFEST,
      reviewedBlueprint: async id => reviewedGenesisImages(await h.provider.genesisDir(id),
        await approvedBlueprintForFounding(await h.provider.genesisDir(id)), [...h.queue.jobs.values()]),
      carryAttachments: async id => {
        for (const sourcePath of await sandboxAttachments(await h.provider.genesisDir(id))) {
          await fileArtifact(h.provider.openStore()!, { sourcePath });
        }
      },
    });
    const dir = await h.provider.genesisDir("gen-selected");
    await mkdir(join(dir, "draft", "characters"), { recursive: true });
    await mkdir(join(dir, "draft", "locations"), { recursive: true });
    await mkdir(join(dir, "attachments"), { recursive: true });
    await mkdir(join(dir, "generated"), { recursive: true });
    await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour" }));
    await writeFile(join(dir, "draft", "characters", "maren.json"), JSON.stringify({ name: "Maren" }));
    await writeFile(join(dir, "draft", "locations", "vigil.json"), JSON.stringify({ name: "The Vigil" }));
    await writeFile(join(dir, "attachments", "portrait.png"), PNG);
    await writeFile(join(dir, "attachments", "unassigned.png"), Buffer.concat([PNG, Buffer.from("alternative")]));
    await writeFile(join(dir, "attachments", "notes.txt"), "The gate is closed.");
    await writeFile(join(dir, "generated", "vigil.png"), PNG);
    const review = await reviewGenesisContent(dir);
    await decideGenesisContent(dir, review.cards, "approve", ulid());
    const approved = await approvedBlueprintForFounding(dir);
    const reference = (await reviewGenesisImages(dir, approved, [], MODEL)).candidates.find(candidate => candidate.label === "portrait.png")!;
    const now = new Date().toISOString();
    const job = JobSchema.parse({ id: newId("jb"), idempotencyKey: ulid(), worldId: "gen-selected",
      recipe: { id: "frozen-recipe", version: 2, templateDigest: "a".repeat(64), dependencyDigest: "b".repeat(64) },
      target: { kind: "genesis-image", id: "location:vigil" }, capability: "image", provider: "fal", model: "test-image",
      params: { prompt: "The lighthouse at dusk.", label: "The Vigil", references: [reference.file] }, estimatedMicroUsd: 40000, status: "succeeded",
      providerJobId: null, attempt: 1, error: null, landedFiles: ["generated/vigil.png"], createdAt: now, updatedAt: now });
    h.queue.jobs.set(job.id, job);
    const images = await reviewGenesisImages(dir, approved, [job], MODEL);
    const portrait = images.candidates.find(candidate => candidate.label === "portrait.png")!;
    const view = images.candidates.find(candidate => candidate.jobId === job.id)!;
    for (const [target, candidate] of [["character:maren", portrait], ["location:vigil", view]] as const) {
      await decideGenesisImage(dir, approved, { target, candidateId: candidate.id, hash: candidate.hash, decision: "approve", requestId: ulid() });
    }
    await h.service.begin("gen-selected", ulid());
    await until(() => h.lastState()?.status === "completed", "selected images to land", BUILD_MS);
    assert.ok(h.lastState()?.items.filter(item => item.authorized).every(item => item.state === "landed"), JSON.stringify(h.lastState()?.items));
    const store = h.provider.openStore()!, bundle = store.getBundle();
    const character = bundle.sheets.find(sheet => sheet.type === "character")!, location = bundle.sheets.find(sheet => sheet.type === "location")!;
    assert.ok((await readKit(store, character.id))?.kit.mainPhoto?.sourceTakeId);
    assert.ok((await readKit(store, location.id))?.kit.establishingViewId);
    const carriedReference = bundle.referenceTakes.find(take => take.jobId === job.id)!.references[0]!;
    assert.deepEqual(bundle.referenceTakes.find(take => take.jobId === job.id)?.provenance.recipe, job.recipe);
    const generated = bundle.artifacts.find(artifact => artifact.generation?.source === "founding");
    assert.ok(generated?.generation?.source === "founding");
    assert.deepEqual(generated.generation.recipe, job.recipe);
    assert.match(carriedReference, /^artifacts\//);
    assert.deepEqual(await readFile(join(store.dir, carriedReference)), PNG);
    assert.equal(bundle.artifacts.length, 4);
    assert.ok(bundle.artifacts.some(artifact => artifact.links.includes(character.id)));
    assert.ok(bundle.artifacts.some(artifact => artifact.links.includes(location.id) && artifact.generation?.source === "founding"));
    assert.ok(bundle.artifacts.some(artifact => artifact.file === "unassigned.png" && !artifact.links.length));
    assert.equal(h.queue.jobs.size, 2, "only the downstream character sheet was generated");
    assert.ok([...h.queue.jobs.values()].some(job => job.target.kind === "character-sheet" &&
      Array.isArray(job.params["references"]) && job.params["references"].some(reference => String(reference).includes(character.id))));
    assert.ok(![...h.queue.jobs.values()].some(job => job.target.kind === "main-photo-candidate" || job.target.kind === "location-view-candidate"));
    const selected = await reviewedGenesisImages(dir, approved, [job]);
    for (const selection of selected.selectedImages ?? []) await installGenesisImage(dir, selection, selected, store);
    await h.service.begin("gen-selected", ulid());
    assert.equal(store.getBundle().artifacts.length, 4);
    assert.equal(store.getBundle().referenceTakes.length, 3);
  });

  it("founds approved props and references with stable identities and no replay duplicates", async t => {
    let h!: Harness;
    h = await makeHarness(t, { manifest: null,
      reviewedBlueprint: async id => {
        const workspace = await h.provider.genesisDir(id);
        return reviewedGenesisImages(workspace, await approvedBlueprintForFounding(workspace), []);
      },
    });
    const id = "gen-props", dir = await h.provider.genesisDir(id);
    const draft = { name: "Harbour", props: [{ slug: "sword", name: "Tide sword", states: [{ slug: "whole", name: "Intact" }, { slug: "broken", name: "Broken" }] }] };
    await writeFile(join(dir, "draft.json"), JSON.stringify(draft));
    await mkdir(join(dir, "attachments"), { recursive: true });
    await writeFile(join(dir, "attachments", "sword.png"), PNG);
    await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
    const approved = await approvedBlueprintForFounding(dir);
    const candidate = (await reviewGenesisImages(dir, approved, [], null)).candidates[0]!;
    await decideGenesisImage(dir, approved, { target: "prop:sword:whole", candidateId: candidate.id, hash: candidate.hash, decision: "approve", requestId: ulid() });
    draft.props[0]!.name = "The restored sword";
    await writeFile(join(dir, "draft.json"), JSON.stringify(draft));
    const renamed = (await reviewGenesisContent(dir)).cards.find(card => card.key === "prop:sword")!;
    await decideGenesisContent(dir, [renamed], "approve", ulid());
    await h.service.begin(id, ulid());
    await until(() => h.lastState()?.status === "completed", "approved props", BUILD_MS);
    assert.ok(h.lastState()?.items.filter(item => item.authorized).every(item => item.state === "landed"), JSON.stringify(h.lastState()?.items));
    const store = h.provider.openStore()!, prop = store.getBundle().props[0]!;
    assert.equal(prop.id, genesisPropId(id, "sword"));
    assert.equal(prop.name, "The restored sword");
    assert.equal(prop.states[0]!.id, genesisPropStateId(id, "sword", "whole"));
    assert.ok(prop.states[0]!.reference?.sourceTakeId);
    assert.ok(!prop.states[1]!.reference);
    assert.ok(store.getBundle().artifacts.some(artifact => artifact.links.includes(prop.id)));
    await h.service.begin(id, ulid());
    const selected = await reviewedGenesisImages(dir, await approvedBlueprintForFounding(dir), []);
    await installGenesisImage(dir, selected.selectedImages![0]!, selected, store);
    assert.equal(store.getBundle().props.length, 1);
    assert.equal(store.getBundle().referenceTakes.length, 1);
    assert.equal(h.queue.jobs.size, 0);
  });

  it("binds Begin to current content and estimate, and supports declining all new images", async t => {
    let brokenCredential = false;
    const h = await makeHarness(t, { credentialFor: async () => {
      if (brokenCredential) throw new Error("Credential storage is unavailable");
      return "key";
    } });
    const dir = await makeSandbox(h.root, "gen-stale-review");
    await h.service.plan("gen-stale-review", ulid());
    const old = lastPlan(h);
    assert.ok(old.approvalDigest);
    const raw = JSON.parse(await readFile(join(dir, "draft.json"), "utf8"));
    await writeFile(join(dir, "draft.json"), JSON.stringify({ ...raw, bible: "A changed argument." }));
    await assert.rejects(h.service.begin("gen-stale-review", ulid(), undefined, undefined, old.approvalDigest), /estimate changed/);
    assert.equal(h.provider.openStore(), null);
    brokenCredential = true;
    await h.service.plan("gen-stale-review", ulid(), undefined, undefined, false);
    const current = lastPlan(h);
    assert.equal(current.generations, 0);
    assert.equal(current.estimateMicroUsd, 0);
    assert.match(current.approvedContent!.bible!, /changed argument/);
    await h.service.begin("gen-stale-review", ulid(), undefined, undefined, current.approvalDigest, false);
    await until(() => h.lastState()?.status === "completed", "text-only build", BUILD_MS);
    assert.equal(h.queue.jobs.size, 0);
    assert.equal(h.provider.openStore()!.getBundle().sheets.length, 3);
    assert.ok(h.lastState()!.items.filter(item => !item.authorized).every(item => item.detail?.includes("declined")));
  });

  it("saves an approved founding voice through sheet assignment without another audition", async t => {
    const voice = { provider: "kokoro", model: "kokoro-82m", voiceId: "af_heart", label: "Heart", attributes: [], local: true, canClone: false };
    let h!: Harness;
    h = await makeHarness(t, { manifest: null, reviewedBlueprint: async id =>
      reviewedGenesisVoices(await h.provider.genesisDir(id), await approvedBlueprintForFounding(await h.provider.genesisDir(id)), [], [voice]) });
    const dir = await h.provider.genesisDir("gen-voice");
    await mkdir(join(dir, "draft", "characters"), { recursive: true });
    await writeFile(join(dir, "draft", "characters", "maren.json"), JSON.stringify({ name: "Maren", neverDepicted: true }));
    await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour", voices: [{ id: "audition", target: "character:maren",
      voice: { provider: voice.provider, model: voice.model, voiceId: voice.voiceId }, text: "The gate stays closed." }] }));
    await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
    const { foldBlueprint } = await import("../../src/harness/blueprint.js");
    const draft = await foldBlueprint(dir), plan = (await reviewGenesisVoices(dir, draft, [], [voice], [])).plans[0]!;
    const wav = Buffer.alloc(52);
    wav.write("RIFF"); wav.writeUInt32LE(44, 4); wav.write("WAVE", 8); wav.write("fmt ", 12); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(8, 40);
    let syntheses = 0;
    await generateLocalGenesisVoice(dir, plan, ulid(), async () => { syntheses++; return wav; });
    const candidate = (await reviewGenesisVoices(dir, draft, [], [voice], [])).candidates[0]!;
    await decideGenesisVoice(dir, draft, [voice], { target: "character:maren", decision: "approve", requestId: ulid(), candidateId: candidate.id, hash: candidate.hash });
    await h.service.begin("gen-voice", ulid());
    await until(() => h.lastState()?.status === "completed", "voice founding", BUILD_MS);
    assert.ok(h.lastState()?.items.filter(item => item.authorized).every(item => item.state === "landed"), JSON.stringify(h.lastState()?.items));
    const store = h.provider.openStore()!, sheet = store.getBundle().sheets[0]!;
    assert.equal(sheet.voice?.voiceId, voice.voiceId);
    assert.equal(sheet.voice?.assignedAtVersion, sheet.version);
    await h.service.begin("gen-voice", ulid()); await h.service.runItems(store.worldId);
    assert.equal(store.getBundle().sheets[0]!.version, sheet.version);
    assert.equal(syntheses, 1);
    assert.equal(h.queue.jobs.size, 0);
  });

  it("replaying a generated main photo keeps the installed take accepted", async t => {
    let h!: Harness;
    h = await makeHarness(t, { manifest: null, reviewedBlueprint: async id => reviewedGenesisImages(await h.provider.genesisDir(id),
      await approvedBlueprintForFounding(await h.provider.genesisDir(id)), [...h.queue.jobs.values()]) });
    const dir = await h.provider.genesisDir("gen-photo-replay");
    await mkdir(join(dir, "draft", "characters"), { recursive: true });
    await mkdir(join(dir, "generated"), { recursive: true });
    await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour" }));
    await writeFile(join(dir, "draft", "characters", "maren.json"), JSON.stringify({ name: "Maren" }));
    await writeFile(join(dir, "generated", "portrait.png"), PNG);
    await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
    const approved = await approvedBlueprintForFounding(dir), now = new Date().toISOString();
    const job = JobSchema.parse({ id: newId("jb"), idempotencyKey: ulid(), worldId: "gen-photo-replay",
      target: { kind: "genesis-image", id: "character:maren" }, capability: "image", provider: "fal", model: "test-image",
      params: { prompt: "Maren at the gate." }, estimatedMicroUsd: 40000, status: "succeeded", providerJobId: null,
      attempt: 1, error: null, landedFiles: ["generated/portrait.png"], createdAt: now, updatedAt: now });
    h.queue.jobs.set(job.id, job);
    const candidate = (await reviewGenesisImages(dir, approved, [job], MODEL)).candidates[0]!;
    await decideGenesisImage(dir, approved, { target: "character:maren", candidateId: candidate.id, hash: candidate.hash, decision: "approve", requestId: ulid() });
    await h.service.begin("gen-photo-replay", ulid());
    await until(() => h.lastState()?.status === "completed", "selected generated portrait", BUILD_MS);
    const store = h.provider.openStore()!, sheet = store.getBundle().sheets[0]!;
    const before = await readKit(store, sheet.id);
    assert.ok(before?.kit.mainPhoto?.sourceTakeId);
    const selected = await reviewedGenesisImages(dir, approved, [job]);
    await installGenesisImage(dir, selected.selectedImages![0]!, selected, store);
    assert.deepEqual(await readKit(store, sheet.id), before);
    assert.equal(store.getBundle().referenceTakes.length, 1);
    assert.equal(h.queue.jobs.size, 1);
  });

  it("saves approved sheets, relationships and canon verbatim without reauthoring", async (t) => {
    let h!: Harness;
    h = await makeHarness(t, {
      manifest: null,
      harnessReady: () => true,
      authorSheet: async () => { throw new Error("Approved content must not be reauthored"); },
      reviewedBlueprint: async id => approvedBlueprintForFounding(await h.provider.genesisDir(id)),
    });
    const workspace = await h.provider.genesisDir("gen-reviewed");
    await mkdir(join(workspace, "draft", "characters"), { recursive: true });
    await mkdir(join(workspace, "draft", "locations"), { recursive: true });
    await writeFile(join(workspace, "draft.json"), JSON.stringify({ name: "Harbour", bible: "The gate stays closed.",
      canon: [
        { slug: "gate-rule", type: "rule", title: "The gate", statement: "Nobody opens the gate." },
        { slug: "gate-maker", type: "thread", title: "Who made it?", statement: "Who made the gate?" },
      ],
    }));
    await writeFile(join(workspace, "draft", "characters", "maren.json"), JSON.stringify({
      name: "Maren", sheet: { sections: { Essence: "She guards the gate.", Appearance: "A red coat." }, links: ["location:vigil"] },
    }));
    await writeFile(join(workspace, "draft", "locations", "vigil.json"), JSON.stringify({
      name: "The Vigil", sheet: { sections: { Look: "A silent lighthouse." }, links: ["character:maren"] },
    }));
    const review = await reviewGenesisContent(workspace);
    await decideGenesisContent(workspace, review.cards, "approve", ulid());
    const unapproved = "A different gate. ".repeat(300);
    await writeFile(join(workspace, "draft", "characters", "maren.json"), JSON.stringify({ name: "Maren", sheet: { sections: { Essence: unapproved, Appearance: "Blue coat" } } }));
    await h.service.plan("gen-reviewed", ulid());
    const planned = h.events.findLast(event => event.type === "build.plan");
    assert.ok(planned?.type === "build.plan" && planned.plan);
    assert.equal(planned.plan.counts.canon, 1);
    assert.equal(planned.plan.counts.threads, 1);
    await h.service.begin("gen-reviewed", ulid());
    await until(() => h.lastState()?.status === "completed", "the reviewed founding build", BUILD_MS);
    assert.ok(h.lastState()?.items.filter(item => item.authorized).every(item => item.state === "landed"), JSON.stringify(h.lastState()?.items));
    const bundle = h.provider.openStore()!.getBundle();
    const maren = bundle.sheets.find(sheet => sheet.name === "Maren")!;
    const vigil = bundle.sheets.find(sheet => sheet.name === "The Vigil")!;
    assert.ok(maren && vigil);
    assert.deepEqual(maren.links, [vigil.id]);
    assert.deepEqual(vigil.links, [maren.id]);
    assert.equal(maren.sections.find(section => section.heading === "Essence")?.body, "She guards the gate.");
    assert.equal(bundle.canon.find(entry => entry.title === "The gate")?.body, "Nobody opens the gate.");
    assert.equal(bundle.canon.find(entry => entry.title === "Who made it?")?.status, "open");
    assert.equal(bundle.proposals.length, 0);
    const carried = bundle.artifacts.find(artifact => artifact.kind === "document");
    assert.ok(carried);
    assert.match(await readFile(join(h.provider.openStore()!.dir, "artifacts", carried.file), "utf8"), /not established world content/);
    assert.ok((await readFile(join(h.provider.openStore()!.dir, "artifacts", carried.file), "utf8")).includes(unapproved.trim()));
    const id = h.worldId();
    await h.service.begin("gen-reviewed", ulid());
    assert.equal(h.worldId(), id);
    assert.equal((await h.provider.listWorlds()).length, 1);
    assert.equal(h.provider.openStore()!.getBundle().canon.length, 2);
  });

  it("rejoins staged approved sheets and canon after a lost staging response", async t => {
    let h!: Harness;
    const failed = new Set<string>(), patched = new WeakSet<object>();
    h = await makeHarness(t, { manifest: null,
      reviewedBlueprint: async id => approvedBlueprintForFounding(await h.provider.genesisDir(id)),
      gate: () => {
        const gate = h.provider.gate();
        if (gate && !patched.has(gate)) {
          patched.add(gate);
          const stage = gate.stage.bind(gate);
          gate.stage = async (...args) => {
            const proposal = await stage(...args);
            if (!failed.has(proposal.kind)) { failed.add(proposal.kind); throw new Error("Lost staging response"); }
            return proposal;
          };
        }
        return gate;
      },
    });
    const workspace = await h.provider.genesisDir("gen-staged");
    await mkdir(join(workspace, "draft", "characters"), { recursive: true });
    await writeFile(join(workspace, "draft.json"), JSON.stringify({ name: "Harbour",
      canon: [{ slug: "gate", type: "rule", title: "Closed", statement: "The gate stays closed." }] }));
    await writeFile(join(workspace, "draft", "characters", "maren.json"), JSON.stringify({ name: "Maren", line: "The keeper" }));
    await decideGenesisContent(workspace, (await reviewGenesisContent(workspace)).cards, "approve", ulid());
    await h.service.begin("gen-staged", ulid());
    await until(() => h.lastState()?.status === "completed", "interrupted staging", BUILD_MS);
    const store = h.provider.openStore()!;
    assert.equal(store.getBundle().proposals.length, 2);
    const nextCanonId = store.getBundle().meta.nextCanonId;
    await h.service.runItems(h.worldId());
    assert.equal(store.getBundle().proposals.length, 0);
    assert.equal(store.getBundle().sheets.length, 1);
    assert.equal(store.getBundle().canon.length, 1);
    assert.equal(store.getBundle().meta.nextCanonId, nextCanonId);
  });

  it("founds imported approved content with real source artifact links to sheets and canon", async t => {
    let h!: Harness;
    h = await makeHarness(t, { manifest: null, reviewedBlueprint: async id => approvedBlueprintForFounding(await h.provider.genesisDir(id)) });
    const workspace = await h.provider.genesisDir("gen-imported");
    await mkdir(join(workspace, "attachments"), { recursive: true });
    await mkdir(join(workspace, "draft", "imports"), { recursive: true });
    await writeFile(join(workspace, "draft.json"), JSON.stringify({ name: "Harbour" }));
    await writeFile(join(workspace, "attachments", "notes.txt"), "Maren guards the gate. The gate is always closed.");
    for (const proposal of [
      { kind: "character", name: "Maren", body: "Maren guards the gate.", quote: "Maren guards the gate." },
      { kind: "canon", name: "Closed gate", body: "The gate is always closed.", quote: "The gate is always closed." },
    ]) {
      await writeFile(join(workspace, "draft", "imports", proposal.kind + ".json"), JSON.stringify({ ...proposal, source: "notes.txt" }));
    }
    for (const initial of (await reviewGenesisImports(workspace)).cards) {
      const card = (await reviewGenesisImports(workspace)).cards.find(card => card.id === initial.id)!;
      await resolveGenesisImport(workspace, { id: card.id, digest: card.digest, decision: "prepare", mode: "distinct" });
    }
    await decideGenesisContent(workspace, (await reviewGenesisContent(workspace)).cards, "approve", ulid());
    await h.service.begin("gen-imported", ulid());
    await until(() => h.lastState()?.status === "completed", "import founding", BUILD_MS);
    assert.ok(h.lastState()?.items.filter(item => item.authorized).every(item => item.state === "landed"), JSON.stringify(h.lastState()?.items));
    const bundle = h.provider.openStore()!.getBundle();
    assert.equal(bundle.artifacts.length, 1);
    assert.ok(bundle.artifacts[0]!.links.includes(bundle.sheets[0]!.id));
    assert.ok(bundle.artifacts[0]!.links.includes(bundle.canon[0]!.id));
    assert.match(bundle.canon[0]!.body, /Source: notes.txt/);
    assert.equal(bundle.meta.schemaVersion, 36);
    await h.service.begin("gen-imported", ulid());
    assert.equal(h.provider.openStore()!.getBundle().artifacts.length, 1);
  });

  it("one press makes the whole world: files, sheets, anchors, key art — nothing left to decide", async (t) => {
    const h = await makeHarness(t);
    await makeSandbox(h.root, "gen-full");
    await h.service.begin("gen-full", ulid());
    await until(() => h.lastState()?.status === "completed", "the founding build to complete", BUILD_MS);

    const store = h.provider.openStore();
    assert.ok(store, "the run ends with the world open (R-24)");
    const bundle = store.getBundle();
    assert.equal(bundle.meta.name, "The Undersong");
    assert.equal(bundle.artDirection.description, "salt-bleached watercolour, cold light off the water");
    assert.equal(bundle.artDirection.version, 1);
    assert.equal(bundle.sheets.filter((sheet) => sheet.type === "character").length, 2);
    assert.equal(bundle.sheets.filter((sheet) => sheet.type === "location").length, 1);
    assert.ok(bundle.canon.length >= 1, "a canon thread opened from each blueprint thread");
    assert.equal(bundle.proposals.length, 0, "nothing rests in Needs you (R-30)");

    // Main photos land as the identity anchor, no acceptance step (R-26).
    const maren = bundle.sheets.find((sheet) => sheet.name === "Maren Kest")!;
    const kit = (await readKit(store, maren.id))?.kit;
    assert.ok(kit?.mainPhoto?.file, "the anchor is set");
    // The character sheet lands designated (R-27).
    assert.ok(kit?.designatedCompilation, "the composite is designated");
    // The establishing view lands as the location's anchor (R-28).
    const vigil = bundle.sheets.find((sheet) => sheet.name === "The Vigil")!;
    const vigilKit = (await readKit(store, vigil.id))?.kit;
    assert.equal(vigilKit?.locationViews?.length, 1);
    assert.ok(vigilKit?.establishingViewId, "the view is the establishing one");
    // Key art is adopted, not left waiting (R-28).
    assert.equal(bundle.keyArtCandidates.length, 0);
    assert.ok(bundle.keyArt, "the world has its key art");

    const state = h.lastState()!;
    assert.equal(state.progress.terminal, state.progress.authorized);
    assert.equal(state.shortfall, null);
    assert.ok(state.stages.every((stage) => stage.state === "complete"));

    // The record is on disk, written once; the journal beside it (R-13, R-31).
    const raw = await readFile(join(store.dir, "build", "build.json"), "utf8");
    assert.equal(JSON.parse(raw).capMicroUsd, state.capMicroUsd);
  });

  it("a failed image fails alone: the run reaches the end, the sheet is skipped, the notice counts one cause (rows 3, 5, 5a)", async (t) => {
    const h = await makeHarness(t);
    await makeSandbox(h.root, "gen-fail");
    h.queue.failWhen = (input) =>
      input.target.kind === "main-photo-candidate" && input.target.id?.startsWith("maren-kest/") === true;
    await h.service.begin("gen-fail", ulid());
    await until(() => h.lastState()?.status === "completed", "the founding build to complete", BUILD_MS);

    const state = h.lastState()!;
    const item = (key: string) => state.items.find((candidate) => candidate.key === key);
    assert.equal(item("main-photo:maren-kest")?.state, "failed");
    assert.equal(item("main-photo:brother-ellum")?.state, "landed", "the other photo was still attempted");
    assert.equal(item("sheet-image:maren-kest")?.state, "skipped", "no anchor, no sheet — skipped, not waited for (R-22)");
    assert.equal(item("sheet-image:brother-ellum")?.state, "landed");
    assert.equal(item("key-art:world")?.state, "landed", "key art still attempted (R-22)");
    assert.ok(state.shortfall && state.shortfall.count === 2, "one failure, one skip");

    const store = h.provider.openStore()!;
    const bundle = store.getBundle();
    const maren = bundle.sheets.find((sheet) => sheet.name === "Maren Kest")!;
    const kit = (await readKit(store, maren.id))?.kit ?? null;
    assert.equal(kit?.mainPhoto, undefined, "no anchor invented");
  });

  it("recovery lands the item it was killed inside without running it twice (rows 1, 22)", async (t) => {
    const h = await makeHarness(t);
    await makeSandbox(h.root, "gen-crash");
    await h.service.begin("gen-crash", ulid());
    await until(() => h.lastState()?.status === "completed", "the founding build to complete", BUILD_MS);
    const worldId = h.worldId();
    const store = h.provider.openStore()!;
    const bundle = store.getBundle();
    const maren = bundle.sheets.find((sheet) => sheet.name === "Maren Kest")!;
    const before = (await readKit(store, maren.id))?.kit?.mainPhoto;
    assert.ok(before);

    // Simulate the kill between an image landing and its journal append: drop the photo's
    // terminal entry (and everything after it) from the journal, then fold afresh.
    const journalPath = join(store.dir, "build", "build.jsonl");
    const lines = (await readFile(journalPath, "utf8")).split("\n").filter((line) => line.trim() !== "");
    const cut = lines.findIndex((line) => {
      const entry = JSON.parse(line) as { kind: string; key?: string };
      return entry.kind === "terminal" && entry.key === "main-photo:maren-kest";
    });
    assert.ok(cut > 0);
    await writeFile(journalPath, lines.slice(0, cut).join("\n") + "\n");

    const fresh = await makeHarness(t);
    // Same world, same disk — a new process over the same provider root.
    const h2 = await makeHarness(t, {
      genesisDir: (genesisId) => h.provider.genesisDir(genesisId),
      createWorld: (input) => h.provider.createWorld(input),
      openWorld: async (id) => {
        await h.provider.loadWorld(id);
      },
      openStore: () => h.provider.openStore(),
      gate: () => h.provider.gate(),
      enqueue: (input) => h.queue.enqueue(input),
      jobById: (jobId) => h.queue.jobs.get(jobId),
      cancelJob: (jobId) => h.queue.cancel(jobId),
    });
    void fresh;
    await h2.service.resume(worldId);
    await until(() => h2.lastState()?.status === "completed", "the resumed build to complete", BUILD_MS);
    const after = (await readKit(h.provider.openStore()!, maren.id))?.kit?.mainPhoto;
    assert.equal(after?.sourceTakeId, before.sourceTakeId, "no duplicate anchor (row 1)");
    const jobCount = [...h.queue.jobs.values()].filter(
      (job) => job.target.kind === "main-photo-candidate" && job.target.id?.startsWith("maren-kest/"),
    ).length;
    assert.equal(jobCount, 1, "the queue was reconciled by job id — no second job (row 22)");
  });

  it("a second press joins the run instead of founding a second world (row 8)", async (t) => {
    const h = await makeHarness(t);
    await makeSandbox(h.root, "gen-twice");
    const requestId = ulid();
    await Promise.all([h.service.begin("gen-twice", requestId), h.service.begin("gen-twice", requestId)]);
    await until(() => h.lastState()?.status === "completed", "the founding build to complete", BUILD_MS);
    await h.service.begin("gen-twice", ulid());
    const worlds = await h.provider.listWorlds();
    assert.equal(worlds.length, 1, "one world, however many presses");
  });

  it("no image model is a supported outcome: the text build completes and names what is missing (rows 4, 25)", async (t) => {
    const h = await makeHarness(t, { manifest: null });
    await makeSandbox(h.root, "gen-text");
    await h.service.begin("gen-text", ulid());
    await until(() => h.lastState()?.status === "completed", "the founding build to complete", BUILD_MS);

    const state = h.lastState()!;
    assert.equal(state.status, "completed");
    const unrun = state.items.filter((item) => item.state === "unauthorized");
    assert.equal(unrun.length, 6, "two photos, one view, two sheets, key art — each visible and runnable (R-48)");
    assert.ok(state.shortfall && state.shortfall.count >= 6, "the notice names them");
    const bundle = h.provider.openStore()!.getBundle();
    assert.equal(bundle.sheets.length, 3, "every sheet still written (R-11)");
    assert.equal(h.queue.jobs.size, 0, "nothing dispatched");
  });

  it("running the missing images later lands them exactly as the build would have (rows 5b, 25; R-49)", async (t) => {
    const h = await makeHarness(t, { manifest: null });
    await makeSandbox(h.root, "gen-later");
    await h.service.begin("gen-later", ulid());
    await until(() => h.lastState()?.status === "completed", "the founding build to complete", BUILD_MS);

    // A provider appears; one press runs everything outstanding (R-11).
    const h2 = await makeHarness(t, {
      genesisDir: (genesisId) => h.provider.genesisDir(genesisId),
      openStore: () => h.provider.openStore(),
      gate: () => h.provider.gate(),
      enqueue: (input) => h.queue.enqueue(input),
      jobById: (jobId) => h.queue.jobs.get(jobId),
    });
    await h2.service.runItems(h.worldId());
    const store = h.provider.openStore()!;
    const bundle = store.getBundle();
    const maren = bundle.sheets.find((sheet) => sheet.name === "Maren Kest")!;
    const kit = (await readKit(store, maren.id))?.kit;
    assert.ok(kit?.mainPhoto?.file, "the retried photo IS the anchor — settled, no proposal, no candidate (R-49)");
    assert.ok(kit?.designatedCompilation, "and the sheet became generatable and landed designated");
    const state = h2.lastState()!;
    assert.equal(
      state.items.filter((item) => item.state === "landed" && item.kind !== "world").length >= 6,
      true,
    );
  });

  it("an Activity re-run cut off by a restart still lands — and never buys twice", async (t) => {
    // The crash dimension of R-49: a text-only build completed, a provider appeared, the
    // author pressed run — and the app died between the enqueue and the landing. Resume
    // reconciles by the journalled identity: the paid job is landed, not re-bought.
    const h = await makeHarness(t, { manifest: null });
    await makeSandbox(h.root, "gen-rerun-crash");
    await h.service.begin("gen-rerun-crash", ulid());
    await until(() => h.lastState()?.status === "completed", "the founding build to complete", BUILD_MS);
    const worldId = h.worldId();

    const h2 = await makeHarness(t, {
      genesisDir: (genesisId) => h.provider.genesisDir(genesisId),
      openStore: () => h.provider.openStore(),
      gate: () => h.provider.gate(),
      enqueue: (input) => h.queue.enqueue(input),
      jobById: (jobId) => h.queue.jobs.get(jobId),
    });
    await h2.service.runItems(worldId, "main-photo:maren-kest");
    const store = h.provider.openStore()!;

    // Simulate the kill between the image landing and the journal append, then a restart:
    // drop the re-run's terminal entry and fold afresh in a new process.
    const journalPath = join(store.dir, "build", "build.jsonl");
    const lines = (await readFile(journalPath, "utf8")).split("\n").filter((line) => line.trim() !== "");
    const lastTerminal = lines.map((line) => JSON.parse(line) as { kind: string; key?: string }).reduce(
      (found, entry, index) =>
        entry.kind === "terminal" && entry.key === "main-photo:maren-kest" ? index : found,
      -1,
    );
    assert.ok(lastTerminal > 0);
    await writeFile(journalPath, lines.filter((_, index) => index !== lastTerminal).join("\n") + "\n");

    const h3 = await makeHarness(t, {
      genesisDir: (genesisId) => h.provider.genesisDir(genesisId),
      openStore: () => h.provider.openStore(),
      gate: () => h.provider.gate(),
      enqueue: (input) => h.queue.enqueue(input),
      jobById: (jobId) => h.queue.jobs.get(jobId),
    });
    await h3.service.resume(worldId);
    await until(
      () => {
        const state = h3.lastState();
        return state?.items.find((item) => item.key === "main-photo:maren-kest")?.state === "landed";
      },
      "the resumed main photo to land",
      BUILD_MS,
    );
    const jobCount = [...h.queue.jobs.values()].filter(
      (job) => job.target.kind === "main-photo-candidate" && job.target.id?.startsWith("maren-kest/") === true,
    ).length;
    assert.equal(jobCount, 1, "the journalled identity was rejoined — no second spend");
    const bundle = h.provider.openStore()!.getBundle();
    const maren = bundle.sheets.find((sheet) => sheet.name === "Maren Kest")!;
    const kit = (await readKit(h.provider.openStore()!, maren.id))?.kit;
    assert.ok(kit?.mainPhoto?.file, "the paid work is the anchor, not a stranded pending take");
  });

  it("key art carries the cast the brief names, in brief order, and drops the surplus by name (rows 18, 21)", async (t) => {
    // Two reference slots, three named characters and a named place: two anchors ride in the
    // brief's own order; the rest are dropped and named, never silently truncated (R-60).
    const twoSlot: ManifestModel = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 2 } };
    const h = await makeHarness(t, {
      manifest: { manifestVersion: 1, generated: "2026-08-26", models: [twoSlot] },
    });
    const sandbox = await makeSandbox(h.root, "gen-keyart");
    await writeFile(
      join(sandbox, "draft.json"),
      JSON.stringify({
        name: "The Undersong",
        logline: "A drowned god still sings beneath the harbour.",
        look: "salt-bleached watercolour",
        bible: "The sea keeps what the town will not say aloud, and Maren is done keeping it with it.",
        threads: [],
        keyArt: {
          prompt: "Maren Kest, Brother Ellum and The Warden stand at the tideline beneath The Vigil. Salt-bleached watercolour, a low amber light on their faces.",
          subject: "The cast at the tideline as the bell answers",
          characters: ["Maren Kest", "Brother Ellum", "The Warden"],
          location: "The Vigil",
        },
      }),
    );
    await writeFile(
      join(sandbox, "draft", "characters", "the-warden.json"),
      JSON.stringify({ name: "The Warden", line: "Keeps the harbour gate" }),
    );
    await h.service.begin("gen-keyart", ulid());
    await until(() => h.lastState()?.status === "completed", "the founding build to complete", BUILD_MS);

    const keyArtJob = [...h.queue.jobs.values()].find((job) => job.target.kind === "world-image")!;
    const references = keyArtJob.params["references"] as string[];
    const roles = keyArtJob.params["referenceRoles"] as Array<{ file: string; role: string }>;
    assert.equal(references.length, 2, "the route's slots are respected");
    assert.match(references[0]!, /^references\/maren-kest\//, "brief order, first");
    assert.match(references[1]!, /^references\/brother-ellum\//, "brief order, second");
    assert.ok(roles.every((role) => role.role === "identity"));
    const dropped = keyArtJob.params["droppedReferences"] as Array<{ name: string; reason: string }>;
    assert.ok(dropped.some((d) => d.name === "The Warden" && /2 reference images/.test(d.reason)), "the surplus is named");
    assert.ok(dropped.some((d) => d.name === "The Vigil"), "the place that did not fit is named too");
    const prompt = String(keyArtJob.params["prompt"]);
    assert.ok(prompt.startsWith("Maren Kest, Brother Ellum and The Warden stand at the tideline beneath The Vigil. Salt-bleached watercolour, a low amber light on their faces. No text, no logos."));
    assert.ok(!prompt.includes("the town will not say aloud"), "world lore informs the writer, never wraps the image prompt");
    const provenance = keyArtJob.params["provenance"] as { sheets: Record<string, number> };
    assert.ok(Object.keys(provenance.sheets).length === 2, "each carried reference's frozen version rides (R-61)");

    // Row 21: regeneration outside the build assembles references identically — the same
    // function reads the same durable brief from the world's own build record.
    const store = h.provider.openStore()!;
    const brief = await readKeyArtBrief(store.dir);
    assert.ok(brief, "the brief survives the conversation in the build record");
    assert.ok(prompt.startsWith(brief.prompt!), "regeneration reads the same durable authored prompt");
    const again = await assembleKeyArt(store, store.getBundle(), brief, twoSlot);
    assert.deepEqual(again.references, references, "same assembly, either path (R-62)");
    const bundle = store.getBundle();
    const aliased = { ...bundle, sheets: bundle.sheets.map((sheet) => sheet.id === "maren-kest" ? { ...sheet, name: 'Maren "Ade" Kest' } : sheet) };
    const byAlias = await assembleKeyArt(store, aliased, { ...brief, characters: ["Ade", "maren-kest"], location: "The Vigil, after midnight" }, MODEL);
    assert.equal(byAlias.carried.filter((r) => r.role === "identity").length, 1, "aliases of one person use one slot");
    assert.equal(byAlias.carried.find((r) => r.role === "environment")?.name, "The Vigil");
    const ambiguous = { ...aliased, sheets: [...aliased.sheets, { ...aliased.sheets.find((sheet) => sheet.id === "maren-kest")!, id: "other-ade" }] };
    const refused = await assembleKeyArt(store, ambiguous, { ...brief, characters: ["Ade"] }, MODEL);
    assert.ok(refused.dropped.some((r) => r.name === "Ade"), "ambiguous nicknames never guess an identity");
    assert.ok(!prompt.includes("In frame:"), "the authored prompt is never relabelled as the supplied cast");
    await assert.rejects(assembleKeyArt(store, { ...aliased, sheets: aliased.sheets.map((sheet) => sheet.id === "maren-kest" ? { ...sheet, neverDepicted: true } : sheet) }, { ...brief, characters: ["Ade"] }, MODEL), /never depicted/, "a nickname cannot bypass the depiction rule");
    assert.ok(h.lastState()?.items.find((item) => item.kind === "key-art")?.detail?.includes("The Warden"), "reference loss survives completion in the build state");
  });

  it("every anchor failed: key art is still made, from the lore and the look alone (row 20)", async (t) => {
    const h = await makeHarness(t);
    await makeSandbox(h.root, "gen-noanchors");
    h.queue.failWhen = (input) => input.target.kind === "main-photo-candidate";
    await h.service.begin("gen-noanchors", ulid());
    await until(() => h.lastState()?.status === "completed", "the founding build to complete", BUILD_MS);

    const state = h.lastState()!;
    assert.equal(state.items.find((item) => item.key === "key-art:world")?.state, "landed", "fewer references is a weaker picture, not a refused one");
    const keyArtJob = [...h.queue.jobs.values()].find((job) => job.target.kind === "world-image")!;
    assert.equal(keyArtJob.params["references"], undefined, "no anchors, no references field");
    const dropped = keyArtJob.params["droppedReferences"] as Array<{ name: string; reason: string }>;
    assert.ok(dropped.some((d) => d.name === "Maren Kest" && /no accepted main photo/.test(d.reason)), "the drop is named before dispatch (row 19)");
  });

  it("a kept preview carries in as v1's master look; the build generates none itself (rows 14, 17)", async (t) => {
    const h = await makeHarness(t);
    const sandbox = await makeSandbox(h.root, "gen-preview");
    await writePreview(sandbox, "salt-bleached watercolour, cold light off the water");
    addPreviewReceipt(h, "gen-preview", "salt-bleached watercolour, cold light off the water");
    // The author's words at Begin arrive as the look override, whitespace and all — the
    // carry test normalizes rather than failing on a trailing space (review round 3).
    await h.service.begin("gen-preview", ulid(), "salt-bleached watercolour, cold light off the water ");
    await until(() => h.lastState()?.status === "completed", "the founding build to complete", BUILD_MS);

    const store = h.provider.openStore()!;
    const record = JSON.parse(await readFile(join(store.dir, "art-direction", "art-direction.json"), "utf8")) as {
      version: number;
      masterLook?: string;
    };
    assert.equal(record.version, 1, "still v1 — the record gains the picture, not a version");
    assert.equal(record.masterLook, "art-direction/look-v1.png");
    assert.equal(await readFile(join(store.dir, ".history/art-direction/v1.json"), "utf8"),
      await readFile(join(store.dir, "art-direction/art-direction.json"), "utf8"), "founding completes the snapshot too (issue 979)");
    assert.ok(await readFile(join(store.dir, "art-direction", "look-v1.png")).catch(() => null));
    assert.ok(
      ![...h.queue.jobs.values()].some((job) => job.target.kind === "master-look"),
      "an author who liked what they saw is not asked to pay for it twice (row 17)",
    );
  });

  it("a preview that outlived its look is not carried — founded with none, never the wrong one (row 13)", async (t) => {
    const h = await makeHarness(t);
    const sandbox = await makeSandbox(h.root, "gen-stale-look");
    await writePreview(sandbox, "neon brutalism, hard flash, wet asphalt");
    addPreviewReceipt(h, "gen-stale-look", "neon brutalism, hard flash, wet asphalt");
    await h.service.begin("gen-stale-look", ulid());
    await until(() => h.lastState()?.status === "completed", "the founding build to complete", BUILD_MS);

    const store = h.provider.openStore()!;
    const record = JSON.parse(await readFile(join(store.dir, "art-direction", "art-direction.json"), "utf8")) as {
      masterLook?: string;
    };
    assert.equal(record.masterLook, undefined, "a picture of rejected words is worse than none");
    assert.equal(await readFile(join(store.dir, "art-direction", "look-v1.png")).catch(() => null), null);
  });

  // The review names both missing images or neither (issue 521). The build refuses to make a
  // master look by rule (R-18, D11), so a world founded without a carried preview simply has
  // none — and the only moment that is cheap to fix is before the press.
  it("the review names the missing master look beside the key-art refusal (issue 521)", async (t) => {
    const h = await makeHarness(t);
    const sandbox = await makeSandbox(h.root, "gen-no-preview");
    // No preview pressed, and the world's one image never settled: two losses, two notes.
    await writeFile(
      join(sandbox, "draft.json"),
      JSON.stringify({
        name: "The Undersong",
        look: "salt-bleached watercolour, cold light off the water",
      }),
    );
    await h.service.plan("gen-no-preview", ulid());

    const notes = lastPlan(h).notes;
    assert.ok(
      notes.includes("No look preview was made — this world will be founded without a master look."),
      "the loss is stated where See the look is one screen back",
    );
    assert.ok(notes.includes("The world's one image was never settled — key art will not be made."));
  });

  it("a preview that will carry is not reported as a loss (issue 521)", async (t) => {
    const h = await makeHarness(t);
    const look = "salt-bleached watercolour, cold light off the water";
    const sandbox = await makeSandbox(h.root, "gen-plan-carries");
    await writePreview(sandbox, look);
    addPreviewReceipt(h, "gen-plan-carries", look);
    await h.service.plan("gen-plan-carries", ulid());

    assert.ok(
      !lastPlan(h).notes.some((note) => /master look/.test(note)),
      "the world gets the picture the author already approved — nothing is lost to name",
    );
  });

  it("a preview the author then rewrote past is named as lost, not as carried (row 13, issue 521)", async (t) => {
    const h = await makeHarness(t);
    const sandbox = await makeSandbox(h.root, "gen-plan-stale");
    await writePreview(sandbox, "neon brutalism, hard flash, wet asphalt");
    addPreviewReceipt(h, "gen-plan-stale", "neon brutalism, hard flash, wet asphalt");
    // The review reads the look the author left the words step, exactly as the press will.
    await h.service.plan("gen-plan-stale", ulid(), "salt-bleached watercolour, cold light off the water");

    assert.ok(
      lastPlan(h).notes.includes(
        "The look changed after the preview was made — it will not carry, and this world will be founded without a master look.",
      ),
      "R-54's refusal is stated as the reason it is",
    );
  });

  it("a preview still generating is a condition, not a loss — the review does not report what the build would contradict", async (t) => {
    const h = await makeHarness(t);
    const look = "salt-bleached watercolour, cold light off the water";
    const sandbox = await makeSandbox(h.root, "gen-plan-inflight");
    // The author walked to the review while the preview was still running. Nothing has landed,
    // so carriablePreview refuses it — but it can succeed before the press and then carry.
    const jobId = addPreviewReceipt(h, "gen-plan-inflight", look, "running");
    await h.service.plan("gen-plan-inflight", ulid(), look);

    assert.ok(
      lastPlan(h).notes.includes("The look preview has not settled yet — it carries only if it lands before you press."),
      "the review states the condition rather than a loss the build is about to contradict",
    );

    // It lands. The same question, asked again, now answers the other way — which is what the
    // review screen re-asks for when the preview settles under it.
    await writePreview(sandbox, look);
    h.queue.jobs.set(jobId, { ...h.queue.jobs.get(jobId)!, status: "succeeded" });
    await h.service.plan("gen-plan-inflight", ulid(), look);
    assert.ok(
      !lastPlan(h).notes.some((note) => /master look/.test(note)),
      "a preview that landed in time is not reported as a loss",
    );
  });

  it("stop keeps what landed, cancels what is in flight, and skips the rest (rows 7, 26)", async (t) => {
    const h = await makeHarness(t);
    await makeSandbox(h.root, "gen-stop");
    h.queue.holdWhen = (input) => input.target.kind === "main-photo-candidate";
    await h.service.begin("gen-stop", ulid());
    // Stop with an image genuinely in flight (row 26), not merely a working line showing.
    await until(
      () => [...h.queue.jobs.values()].some((job) => job.status === "running"),
      "a build job to be running",
      BUILD_MS,
    );
    await h.service.stop(h.worldId());
    await until(
      () => h.lastState()?.status === "stopped" && (h.lastState()?.working.length ?? 0) === 0,
      "the stopped build to drain its working set",
      BUILD_MS,
    );

    assert.ok(h.queue.cancelled.length > 0, "cancellation was requested for the in-flight job");
    const state = h.lastState()!;
    const bundle = h.provider.openStore()!.getBundle();
    assert.equal(bundle.sheets.length, 3, "what landed is kept");
    assert.ok(
      state.items.some((item) => item.kind === "key-art" && item.state === "skipped"),
      "what was never dispatched is not dispatched",
    );
    await h.service.dismissNotice(h.worldId());
    const key = state.items.find(item => item.kind === "main-photo")!.key;
    const retry = h.service.runItems(h.worldId(), key);
    await until(() => [...h.queue.jobs.values()].some(job => job.status === "running"), "retried image running", BUILD_MS);
    const retried = [...h.queue.jobs.values()].find(job => job.status === "running")!;
    await h.service.stop(h.worldId());
    await retry;
    assert.ok(h.queue.cancelled.includes(retried.id), "Stop cancels a retry after the original build was already stopped");
  });
});


it("never-depicted characters keep their sheet but never enter either image wave (#905)", async (t) => {
  const h = await makeHarness(t, { harnessReady: () => true, authorSheet: async () => {
    throw new Error("drafting unavailable");
  } });
  const sandbox = await makeSandbox(h.root, "gen-unseen");
  const characterPath = join(sandbox, "draft", "characters", "maren-kest.json");
  const character = JSON.parse(await readFile(characterPath, "utf8"));
  await writeFile(characterPath, JSON.stringify({ ...character, neverDepicted: true }));
  await h.service.plan("gen-unseen", ulid());
  const plan = lastPlan(h);
  assert.ok(plan.notes.includes("Maren Kest — never depicted"));
  assert.ok(plan.notes.some((note) => note.startsWith("Key art names")));
  assert.equal(plan.generations, 3, "only the other character's two images and the location");
  await h.service.begin("gen-unseen", ulid());
  await until(() => h.lastState()?.status === "completed", "unseen build", BUILD_MS);
  const store = h.provider.openStore()!;
  const sheet = store.getBundle().sheets.find((s) => s.name === "Maren Kest")!;
  assert.equal(sheet.neverDepicted, true, "the seed keeps the rule even when authoring fails");
  const disk = MarkdownFile.parse(await readFile(join(store.dir, "characters", `${sheet.id}.md`), "utf8"));
  assert.equal(disk.data["neverDepicted"], true);
  const edited = editSheetContent({ sheet, sections: { Essence: "Still heard, never seen." }, date: "2026-09-07" });
  assert.equal(MarkdownFile.parse(edited).data["neverDepicted"], true, "prose editing preserves the rule");
  assert.equal(h.lastState()?.items.some((item) => item.subject === "maren-kest" &&
    (item.kind === "main-photo" || item.kind === "sheet-image")), false);
  const before = h.queue.jobs.size;
  await h.service.runItems(h.worldId());
  assert.equal(h.queue.jobs.size, before, "Run remaining work cannot resurrect omitted portraits");
  assert.equal((await readKit(store, sheet.id))?.kit.mainPhoto, undefined);
});

it("invalidates Begin when only an unapproved proposal changes", async t => {
  let h!: Harness;
  h = await makeHarness(t, { manifest: null, reviewedBlueprint: async id => approvedBlueprintForFounding(await h.provider.genesisDir(id)) });
  const id = "gen-pending-digest", dir = await h.provider.genesisDir(id);
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour" }));
  await decideGenesisContent(dir, (await reviewGenesisContent(dir)).cards, "approve", ulid());
  await h.service.plan(id, ulid(), undefined, undefined, false);
  const original = lastPlan(h).approvalDigest;
  await mkdir(join(dir, "draft", "characters"), { recursive: true });
  await writeFile(join(dir, "draft", "characters", "maren.json"), JSON.stringify({ name: "Maren", line: "Still a proposal" }));
  await assert.rejects(h.service.begin(id, ulid(), undefined, undefined, original, false), /estimate changed/);
  assert.equal(h.provider.openStore(), null);
});
it("recovers the authorized route, items and cap after a crash before world creation", async t => {
  let failCreation = true;
  const manifest = structuredClone(MANIFEST);
  const h = await makeHarness(t, { manifest, createWorld: async input => {
    if (failCreation) throw new Error("simulated crash before publish");
    return h.provider.createWorld(input);
  } });
  const id = "gen-frozen-authorization";
  await makeSandbox(h.root, id);
  await h.service.plan(id, ulid());
  const approved = lastPlan(h);
  await assert.rejects(h.service.begin(id, ulid(), undefined, undefined, approved.approvalDigest), /simulated crash/);
  const frozen = JSON.parse(await readFile(join(h.root, ".genesis-v2", id, "founding-input.json"), "utf8"));
  assert.ok(frozen.authorization.route);
  manifest.models.splice(0, manifest.models.length);
  failCreation = false;
  await h.service.plan(id, ulid());
  assert.deepEqual(lastPlan(h).work, approved.work);
  await h.service.begin(id, ulid());
  const record = JSON.parse(await readFile(join(h.provider.openStore()!.dir, "build", "build.json"), "utf8"));
  assert.equal(record.capMicroUsd, frozen.authorization.capMicroUsd);
  assert.deepEqual(record.items, frozen.authorization.items);
  assert.equal(record.image.model, frozen.authorization.route.model.id);
  await until(() => h.lastState()?.status === "completed", BUILD_MS);
});

it("refuses a different successful look receipt even when its look words are unchanged", async t => {
  const h = await makeHarness(t);
  const id = "gen-look-digest", look = "salt-bleached watercolour, cold light off the water";
  const dir = await makeSandbox(h.root, id);
  await writePreview(dir, look);
  const first = addPreviewReceipt(h, id, look);
  await h.service.plan(id, ulid());
  const approved = lastPlan(h);
  h.queue.jobs.delete(first);
  addPreviewReceipt(h, id, look);
  await assert.rejects(h.service.begin(id, ulid(), undefined, undefined, approved.approvalDigest), /changed/);
  assert.equal(h.worldId(), "");
});

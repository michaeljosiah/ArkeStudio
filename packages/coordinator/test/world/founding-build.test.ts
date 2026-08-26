import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  JobSchema,
  newId,
  ulid,
  type DomainEvent,
  type FoundingBuildState,
  type Job,
  type ManifestModel,
  type ModelManifest,
  type QueueStatus,
} from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { FoundingBuildService, type FoundingBuildPorts } from "../../src/world/founding-build.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { readKit } from "../../src/references/kit.js";

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
  const dir = join(root, ".genesis", genesisId);
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
    authorSheet: async () => {},
    enqueue: (input) => queue.enqueue(input),
    jobById: (jobId) => queue.jobs.get(jobId),
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

async function waitFor(check: () => boolean, ms = 15000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("the founding build (SPEC-031)", () => {
  it("one press makes the whole world: files, sheets, anchors, key art — nothing left to decide", async (t) => {
    const h = await makeHarness(t);
    await makeSandbox(h.root, "gen-full");
    await h.service.begin("gen-full", ulid());
    await waitFor(() => h.lastState()?.status === "completed");

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
    await waitFor(() => h.lastState()?.status === "completed");

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
    await waitFor(() => h.lastState()?.status === "completed");
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
    await waitFor(() => h2.lastState()?.status === "completed");
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
    await waitFor(() => h.lastState()?.status === "completed");
    await h.service.begin("gen-twice", ulid());
    const worlds = await h.provider.listWorlds();
    assert.equal(worlds.length, 1, "one world, however many presses");
  });

  it("no image model is a supported outcome: the text build completes and names what is missing (rows 4, 25)", async (t) => {
    const h = await makeHarness(t, { manifest: null });
    await makeSandbox(h.root, "gen-text");
    await h.service.begin("gen-text", ulid());
    await waitFor(() => h.lastState()?.status === "completed");

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
    await waitFor(() => h.lastState()?.status === "completed");

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

  it("stop keeps what landed, cancels what is in flight, and skips the rest (rows 7, 26)", async (t) => {
    const h = await makeHarness(t);
    await makeSandbox(h.root, "gen-stop");
    h.queue.holdWhen = (input) => input.target.kind === "main-photo-candidate";
    await h.service.begin("gen-stop", ulid());
    // Stop with an image genuinely in flight (row 26), not merely a working line showing.
    await waitFor(() => [...h.queue.jobs.values()].some((job) => job.status === "running"));
    await h.service.stop(h.worldId());
    await waitFor(() => h.lastState()?.status === "stopped" && (h.lastState()?.working.length ?? 0) === 0);

    assert.ok(h.queue.cancelled.length > 0, "cancellation was requested for the in-flight job");
    const state = h.lastState()!;
    const bundle = h.provider.openStore()!.getBundle();
    assert.equal(bundle.sheets.length, 3, "what landed is kept");
    assert.ok(
      state.items.some((item) => item.kind === "key-art" && item.state === "skipped"),
      "what was never dispatched is not dispatched",
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, Job, LedgerEntry, ReferenceKit, Take } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Recovering a location view that was paid for and never recorded (issue 274).
 *
 * v0.5.0 finalized `location-view-candidate` jobs without recording a take and reported the
 * finalization **complete**. Complete is what made these stranded rather than merely broken:
 * Activity offers a retry only for a failed finalization, so nothing would ever finalize them
 * again, and the picture sat in `candidates/` with no take for the screen to name.
 *
 * The fix is not a migration. Accepting a candidate by filename records the take its job always
 * owed and then accepts that — the same recovery `choose-anchor` performs for a main photo — so
 * it works without anyone having to know this bug ever happened.
 */

const CLOCK = "2026-08-10T21:12:08.834Z";
const FILE = "location-view-msnq84u3-1.png";
const CANDIDATE = `references/the-vigil/candidates/${FILE}`;

/** The exact shape v0.5.0 left behind: succeeded, complete, landed, and no take anywhere. */
function strandedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "jb_01KZPR883W8B49PZTR1GE3F1S4",
    idempotencyKey: "01KZPR883W8B49PZTR1GE3F1S5",
    worldId: WORLD_ID,
    target: { kind: "location-view-candidate", id: "the-vigil/msnq84u3/1" },
    capability: "image",
    provider: "openai",
    model: "gpt-image-2",
    params: {
      prompt: "the harbour mouth at night",
      references: [],
      provenance: { canonRevision: 42, sheets: { "the-vigil": 2 }, artDirectionVersion: 3 },
      locationView: { name: "Establishing view" },
    },
    estimatedMicroUsd: 53000,
    status: "succeeded",
    providerJobId: "img-msnq84u3",
    attempt: 1,
    landing: { dir: "references/the-vigil/candidates" },
    landedFiles: [CANDIDATE],
    finalization: { status: "complete", error: null, updatedAt: CLOCK },
    error: null,
    createdAt: CLOCK,
    updatedAt: CLOCK,
    ...overrides,
  };
}

function spend(jobId: string): LedgerEntry {
  return {
    ts: CLOCK,
    worldId: WORLD_ID,
    jobId: jobId as LedgerEntry["jobId"],
    provider: "openai",
    model: "gpt-image-2",
    outcome: "succeeded",
    estimatedMicroUsd: 53000,
    actualMicroUsd: 50000,
    actualSource: "provider-reported",
  };
}

async function harness(jobs: Job[], ledger: LedgerEntry[] = []) {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "references", "the-vigil", "candidates"), { recursive: true });
  await writeFile(join(worldDir, CANDIDATE), Buffer.from(encodePng(solidImage(640, 360, [20, 40, 90, 255]))));
  await mkdir(join(root, "queue"), { recursive: true });
  await writeFile(join(root, "queue", "jobs.jsonl"), jobs.map((job) => `${JSON.stringify(job)}\n`).join(""), "utf8");
  await writeFile(join(root, "ledger.jsonl"), ledger.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");

  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    // Any dispatch surface at all is enough for the queue to exist; nothing here submits.
    dispatchClients: {},
  });
  await coordinator.start(0);
  const takesDir = join(worldDir, "references", "the-vigil", "takes");
  const send = (msg: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
  const takeIds = async () => await readdir(takesDir).catch(() => [] as string[]);
  const take = async (id: string) => JSON.parse(await readFile(join(takesDir, id, "take.json"), "utf8")) as Take;
  const kit = async () =>
    JSON.parse(await readFile(join(worldDir, "references", "the-vigil", "kit.json"), "utf8")) as ReferenceKit;
  const close = async () => {
    await coordinator.stop();
    await provider.close();
  };
  return { root, worldDir, send, takeIds, take, kit, close };
}

function accept(file: string): ClientMessage {
  return {
    kind: "accept-location-view",
    worldId: WORLD_ID,
    sheetId: "the-vigil",
    selection: { source: "candidate", file },
    name: "Establishing view",
  };
}

describe("a location view stranded by a finalization that recorded no take (issue 274)", () => {
  it("is not reached by the queue's own recovery — the finalization already says complete", async () => {
    const { takeIds, close } = await harness([strandedJob()]);
    try {
      // start() replays every unsettled finalization. This one reports complete, so it is passed
      // over, and without the accept below there is no route to the image at all.
      assert.deepEqual(await takeIds(), []);
    } finally {
      await close();
    }
  });

  it("records the take its job owed and accepts it, carrying the cost the ledger recorded", async () => {
    const job = strandedJob();
    const { send, takeIds, take, kit, close } = await harness([job], [spend(job.id)]);
    try {
      await send(accept(FILE));

      // The take is the job's own, id and all: recovery is the finalization running late, not a
      // second creative result that happens to look like the first.
      assert.deepEqual(await takeIds(), [`tk_${job.id.slice(3)}`]);
      const recovered = await take(`tk_${job.id.slice(3)}`);
      assert.equal(recovered.kind, "location-view");
      assert.equal(recovered.jobId, job.id);
      assert.equal(recovered.provider, "openai");
      assert.equal(recovered.media, FILE);
      assert.equal(recovered.provenance.canonRevision, 42);
      // What was actually spent, from the ledger entry that was written when the job landed. A
      // recovered take reporting an unknown cost would invent a gap that is not there.
      assert.equal(recovered.cost.actualMicroUsd, 50000);
      assert.equal(recovered.cost.actualSource, "provider-reported");

      const accepted = await kit();
      const view = (accepted.locationViews ?? []).find((candidate) => candidate.name === "Establishing view");
      assert.ok(view, "the view is accepted under the name the accept carried");
      assert.equal(view.file, `takes/tk_${job.id.slice(3)}/${FILE}`);
      assert.equal(accepted.establishingViewId, view.id);
      assert.equal(accepted.designatedCompilation?.startsWith("location-sheet-"), true);
    } finally {
      await close();
    }
  });

  it("refuses a candidate no job landed, and leaves the world exactly as it was", async () => {
    // Nothing to recover provenance from, so there is no take to record and no view to accept.
    // The refusal is silence and an unchanged world, like every other refusal on this path.
    const { send, takeIds, worldDir, close } = await harness([]);
    try {
      await send(accept(FILE));
      assert.deepEqual(await takeIds(), []);
      assert.equal(
        await readFile(join(worldDir, "references", "the-vigil", "kit.json"), "utf8").catch(() => null),
        null,
        "no kit is written for a view that was never accepted",
      );
    } finally {
      await close();
    }
  });
});

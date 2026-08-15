import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "@arke-studio/contracts";
import {
  acceptMainPhoto,
  mainPhotoFailureReason,
  mainPhotoLogRecord,
} from "../../src/references/main-photo.js";
import { readKit } from "../../src/references/kit.js";
import { recordReferenceTake } from "../../src/references/takes.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-04T08:00:00.000Z";

async function candidateWorld() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  const relative = "references/maren-kest/candidates/upload-test.png";
  await store.gateOp(async () => {
    await mkdir(join(dir, "references", "maren-kest", "candidates"), { recursive: true });
    await writeFile(join(dir, relative), "candidate-bytes");
  });
  const sheet = store.getBundle().sheets.find((candidate) => candidate.id === "maren-kest")!;
  return { dir, store, sheet, relative };
}

describe("main-photo acceptance boundary", () => {
  it("records the exact generated source path in the immutable take", async () => {
    const { dir, store } = await candidateWorld();
    const job = {
      id: "jb_01J8E0000000000000000000J1",
      idempotencyKey: "01J8E1000000000000000000K1",
      worldId: store.worldId,
      target: { kind: "main-photo-candidate", id: "maren-kest/g1/1" },
      capability: "image",
      provider: "fal",
      model: "flux",
      params: {
        prompt: "portrait",
        provenance: { canonRevision: 42, sheets: { "maren-kest": 4 }, artDirectionVersion: 3 },
      },
      estimatedMicroUsd: 40000,
      status: "succeeded",
      providerJobId: "remote-1",
      attempt: 1,
      landedFiles: ["references/maren-kest/candidates/upload-test.png"],
      error: null,
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    } as Job;
    const take = await recordReferenceTake(store, job);
    assert.equal(take?.params["sourceCandidate"], "references/maren-kest/candidates/upload-test.png");
    await access(join(dir, "references", "maren-kest", "takes", take!.id, "upload-test.png"));
    await store.close();
  });

  it("copies an upload to a take, commits kit plus review, then removes staging", async () => {
    const { dir, store, sheet, relative } = await candidateWorld();
    const result = await acceptMainPhoto(store, sheet, store.getBundle(), {
      source: "candidate",
      file: "upload-test.png",
    });
    assert.deepEqual(result, { status: "accepted", candidateRetained: false });
    const kit = (await readKit(store, sheet.id))!.kit;
    assert.match(kit.mainPhoto!.file, /^takes\/tk_[0-9A-HJKMNP-TV-Z]{26}\/upload-test\.png$/);
    await access(join(dir, "references", sheet.id, kit.mainPhoto!.file));
    await access(join(dir, "references", sheet.id, kit.mainPhoto!.file.replace(/\/[^/]+$/, "/take.json")));
    await assert.rejects(access(join(dir, relative)));
    assert.equal(store.getBundle().referenceReviews.at(-1)?.decision, "accept");
    await store.close();
  });

  it("keeps the candidate and kit unchanged when take recording fails", async () => {
    const { dir, store, sheet, relative } = await candidateWorld();
    const before = await readFile(join(dir, "references", sheet.id, "kit.json"), "utf8");
    const result = await acceptMainPhoto(
      store,
      sheet,
      store.getBundle(),
      { source: "candidate", file: "upload-test.png" },
      null,
      { recordUpload: async () => { throw new Error("absolute C:/secret/path"); } },
    );
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.stage, "take-recording");
    assert.equal(await readFile(join(dir, "references", sheet.id, "kit.json"), "utf8"), before);
    await access(join(dir, relative));
    await store.close();
  });

  it("exposes safe stage copy and logs no raw path or exception detail", () => {
    const reason = mainPhotoFailureReason("take-recording");
    const record = mainPhotoLogRecord(
      "01J8F3K2QW9VZX4N7M0RTYB6HC",
      "maren-kest",
      "take-recording",
      "upload",
    );
    const serialised = JSON.stringify(record);
    assert.match(reason, /candidate is still here/);
    assert.doesNotMatch(reason, /C:\\|absolute|secret/i);
    assert.doesNotMatch(serialised, /path|prompt|message|providerPayload|secret/i);
    assert.deepEqual(record, {
      kind: "main-photo.accept-failed",
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      sheetId: "maren-kest",
      stage: "take-recording",
      source: "upload",
    });
  });

  it("keeps staging when the atomic kit/review commit fails", async () => {
    const { dir, store, sheet, relative } = await candidateWorld();
    const before = await readFile(join(dir, "references", sheet.id, "kit.json"), "utf8");
    const result = await acceptMainPhoto(
      store,
      sheet,
      store.getBundle(),
      { source: "candidate", file: "upload-test.png" },
      null,
      { commitAnchor: async () => { throw new Error("stale base"); } },
    );
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.stage, "kit-commit");
    assert.equal(await readFile(join(dir, "references", sheet.id, "kit.json"), "utf8"), before);
    await access(join(dir, relative));
    assert.equal(store.getBundle().referenceReviews.length, 0);
    const takesAfterFailure = store.getBundle().referenceTakes.length;
    const retry = await acceptMainPhoto(store, sheet, store.getBundle(), {
      source: "candidate",
      file: "upload-test.png",
    });
    assert.equal(retry.status, "accepted");
    assert.equal(store.getBundle().referenceTakes.length, takesAfterFailure, "retry reuses the immutable upload take");
    await store.close();
  });

  it("reports cleanup debt after a successful accept without undoing identity", async () => {
    const { dir, store, sheet, relative } = await candidateWorld();
    const result = await acceptMainPhoto(
      store,
      sheet,
      store.getBundle(),
      { source: "candidate", file: "upload-test.png" },
      null,
      { removeCandidate: async () => { throw new Error("file busy"); } },
    );
    assert.equal(result.status, "accepted");
    if (result.status === "accepted") {
      assert.equal(result.candidateRetained, true);
      assert.match(result.cleanupError ?? "", /file busy/);
    }
    assert.match((await readKit(store, sheet.id))!.kit.mainPhoto!.file, /^takes\//);
    await access(join(dir, relative));
    assert.equal(store.getBundle().referenceReviews.at(-1)?.decision, "accept");
    await store.close();
  });

  it("removes the generated source candidate only after accepting its immutable take", async () => {
    const { dir, store, sheet } = await candidateWorld();
    const take = store.getBundle().referenceTakes[0];
    assert.equal(take, undefined, "fixture begins without reference takes");
    const uploadResult = await acceptMainPhoto(store, sheet, store.getBundle(), {
      source: "candidate",
      file: "upload-test.png",
    });
    assert.equal(uploadResult.status, "accepted");
    const acceptedTake = store.getBundle().referenceTakes.at(-1)!;
    const source = "references/maren-kest/candidates/generated-copy.png";
    await store.gateOp(async () => {
      await writeFile(join(dir, source), "duplicate-source");
    });
    // Remove the first review from the supplied view to model a fresh generated take selection.
    const bundle = { ...store.getBundle(), referenceReviews: [] };
    const result = await acceptMainPhoto(
      store,
      sheet,
      bundle,
      { source: "take", takeId: acceptedTake.id },
      source,
    );
    assert.equal(result.status, "accepted");
    await assert.rejects(access(join(dir, source)));
    await store.close();
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job } from "@arke-studio/contracts";
import type { WorldStore } from "../../src/world/store.js";
import { pieceJobs, pieceOf, pieceParams, PieceReads } from "../../src/voice/pieces.js";

/**
 * The bookkeeping of a read made in pieces (issue 1208), on its own: the window between a block
 * being registered and the queue naming its jobs, which the coordinator test cannot open on
 * purpose — a vendor would have to answer inside the journalling of a batch.
 */
const REQUEST = "01J8F3K2QW9VZX4N7M0RTYB6P9";

function job(id: string, piece: number, pieces: number, status: Job["status"] = "failed"): Job {
  return {
    id,
    idempotencyKey: id,
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    target: { kind: "voice-preview", id: "maren-kest/mistral/voxtral-mini-tts/en_paul_neutral" },
    capability: "voice-tts",
    provider: "mistral",
    model: "voxtral-mini-tts",
    params: { requestId: REQUEST, ...pieceParams(0, piece, pieces) },
    estimatedMicroUsd: 0,
    status,
    providerJobId: null,
    attempt: 1,
    error: null,
    createdAt: "2026-09-16T12:00:00.000Z",
    updatedAt: "2026-09-16T12:00:00.000Z",
    ...(status === "succeeded" ? { landedFiles: [`.cache/voice-previews/${id}.wav`] } : {}),
  };
}

describe("a read's pieces, between registration and the queue naming their jobs (codex on PR 1210)", () => {
  it("a piece that fails before its siblings are named fails the block once, and the siblings are cancelled once they are", async () => {
    const reads = new PieceReads();
    reads.register({ requestId: REQUEST, blockIndex: 0, pieces: 3, file: ".cache/voice-previews/whole.wav", format: "wav", page: false, characters: 600 });
    const first = reads.failed(job("jb_1", 0, 3));
    assert.deepEqual(first, { page: false, cancel: [] }, "the failure is news; there is nothing to name yet");
    assert.equal(reads.failed(job("jb_1", 0, 3)), null, "and not news twice");
    // A sibling that lands in the same window is nobody's: never announced, never joined.
    const landed = await reads.landed(job("jb_2", 1, 3, "succeeded"), {} as WorldStore);
    assert.deepEqual(landed, { kind: "orphan" });
    // The queue names the jobs: the block is let go and its jobs are what to cancel.
    const inputs = [0, 1, 2].map((piece) => ({ params: { requestId: REQUEST, ...pieceParams(0, piece, 3) } }));
    assert.deepEqual(reads.queued(REQUEST, pieceJobs(inputs, ["jb_1", "jb_2", "jb_3"])), ["jb_1", "jb_2", "jb_3"]);
    assert.equal(reads.failed(job("jb_3", 2, 3, "cancelled")), null, "a cancelled sibling coming back is not a second failure");
    assert.deepEqual(await reads.landed(job("jb_2", 1, 3, "succeeded"), {} as WorldStore), { kind: "orphan" });
  });

  it("named in time, a failure cancels the siblings itself and the queue's answer is empty", () => {
    const reads = new PieceReads();
    reads.register({ requestId: REQUEST, blockIndex: 0, pieces: 3, file: ".cache/voice-previews/whole.wav", format: "wav", page: true, characters: 600 });
    const inputs = [0, 1, 2].map((piece) => ({ params: { requestId: REQUEST, ...pieceParams(0, piece, 3) } }));
    assert.deepEqual(reads.queued(REQUEST, pieceJobs(inputs, ["jb_1", "jb_2", "jb_3"])), []);
    assert.deepEqual(reads.failed(job("jb_2", 1, 3)), { page: true, cancel: ["jb_1", "jb_3"] });
    assert.equal(reads.failed(job("jb_1", 0, 3, "cancelled")), null);
  });

  it("a job that was never a piece is nobody's business here", () => {
    assert.equal(pieceOf({ params: { requestId: REQUEST, part: 0, parts: 2 } }), null);
    assert.deepEqual(pieceJobs([{ params: {} }, { params: pieceParams(1, 0, 1) }], ["jb_a", "jb_b"]), new Map([[1, ["jb_b"]]]));
  });
});

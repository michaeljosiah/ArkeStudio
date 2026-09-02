import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EditorRequestFileSchema,
  ProductionTimelineSchema,
  editorRequestUndone,
  orderedTrackClips,
  seedStoryPictureTimeline,
  storyTimelineFingerprint,
  type TimelineClipId,
  type TimelineCommand,
} from "@arke-studio/contracts";
import { decideEditorRequest, EditorRequestRefused, retainEditorRequests, stageEditorRequests } from "../../src/productions/editor-requests.js";
import { applyTimelineCommand } from "../../src/productions/timeline.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Arke's editor requests at the coordinator boundary (SPEC-039 R-27..R-36; issue 684): staged
 * only for the thread's production and only when they apply, accepted as one revision and one
 * Undo entry in the same commit as the record, rejected without touching the timeline, refused as
 * stale without rebasing, and read back from disk like any other production record.
 */

const CLOCK = () => "2026-09-02T12:00:00.000Z";
const NOW = "2026-09-02T12:00:00.000Z";
const PRODUCTION = "saltlight";
const CONVERSATION = "cv_01J8G0000000000000000000C1";
const THREAD = { kind: "production" as const, productionId: PRODUCTION };

async function open(): Promise<WorldStore> {
  const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

const productionOf = (store: WorldStore) => store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
const timelinePath = (store: WorldStore): string => join(store.dir, "productions", PRODUCTION, "timeline.json");
const requestsPath = (store: WorldStore): string => join(store.dir, "productions", PRODUCTION, "editor-requests.json");

function moveSecondEarlier(store: WorldStore): { commands: TimelineCommand[]; movingId: TimelineClipId; firstId: TimelineClipId } {
  const seeded = seedStoryPictureTimeline(productionOf(store));
  const clips = orderedTrackClips(seeded.tracks[0]!);
  return { commands: [{ kind: "move-adjacent", clipId: clips[1]!.id, direction: "earlier" }], movingId: clips[1]!.id, firstId: clips[0]!.id };
}

describe("Arke's editor requests (issue 684)", () => {
  it("stages only for the thread's production, and only what applies", async () => {
    const store = await open();
    const { commands } = moveSecondEarlier(store);
    await assert.rejects(
      stageEditorRequests(store, { conversationId: CONVERSATION, entryContext: { kind: "world" }, requests: [{ summary: "Swap", commands }], now: NOW }),
      (error: unknown) => error instanceof EditorRequestRefused && /production, episode or scene thread/.test(error.reason),
    );
    await assert.rejects(
      stageEditorRequests(store, {
        conversationId: CONVERSATION,
        entryContext: THREAD,
        requests: [{ summary: "Drop a clip that is not there", commands: [{ kind: "delete", clipId: "cl_nowhere" }] }],
        now: NOW,
      }),
      (error: unknown) => error instanceof EditorRequestRefused && /cannot apply/.test(error.reason),
    );
    await assert.rejects(readFile(requestsPath(store), "utf8"), { code: "ENOENT" });

    const staged = await stageEditorRequests(store, {
      conversationId: CONVERSATION,
      entryContext: THREAD,
      requests: [{ summary: "Swap the first two shots", commands }],
      now: NOW,
    });
    assert.equal(staged.length, 1);
    assert.equal(staged[0]!.status, "pending");
    assert.equal(staged[0]!.baseRevision, null, "prepared against the first assembly");
    assert.equal(staged[0]!.sourceFingerprint, storyTimelineFingerprint(productionOf(store)));
    const file = EditorRequestFileSchema.parse(JSON.parse(await readFile(requestsPath(store), "utf8")));
    assert.deepEqual(file.requests.map((request) => request.id), [staged[0]!.id]);
    assert.equal(productionOf(store).editorRequests.length, 1, "the bundle carries it after the write");
    assert.equal((await scanWorld(store.dir)).bundle.productions.find((candidate) => candidate.meta.id === PRODUCTION)?.editorRequests.length, 1, "a fresh scan reads it back");
  });

  it("accepts as one revision and one Undo entry, in the same commit as the record (R-30, A-8)", async () => {
    const store = await open();
    const { commands, movingId } = moveSecondEarlier(store);
    const [staged] = await stageEditorRequests(store, {
      conversationId: CONVERSATION,
      entryContext: THREAD,
      requests: [{ summary: "Swap the first two shots", commands }],
      now: NOW,
    });
    const accepted = await decideEditorRequest(store, { productionId: PRODUCTION, requestId: staged!.id, decision: "accept", now: NOW });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.resultRevision, 1);

    const saved = ProductionTimelineSchema.parse(JSON.parse(await readFile(timelinePath(store), "utf8")));
    assert.equal(saved.revision, 1);
    assert.equal(saved.history.undo.length, 1);
    const entry = saved.history.undo[0]!;
    assert.equal(entry.kind === "change" ? entry.requestId : null, staged!.id, "the Undo entry carries the request");
    assert.equal(orderedTrackClips(saved.tracks[0]!)[0]!.id, movingId);
    const file = EditorRequestFileSchema.parse(JSON.parse(await readFile(requestsPath(store), "utf8")));
    assert.equal(file.requests[0]!.status, "accepted");
    assert.equal(productionOf(store).editorRequests[0]!.status, "accepted");

    await assert.rejects(
      decideEditorRequest(store, { productionId: PRODUCTION, requestId: staged!.id, decision: "accept", now: NOW }),
      (error: unknown) => error instanceof EditorRequestRefused && /already accepted/.test(error.reason),
    );

    // Undo keeps the status and says the action was undone (R-36).
    await applyTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 1 });
    const production = productionOf(store);
    assert.equal(production.editorRequests[0]!.status, "accepted");
    assert.equal(editorRequestUndone(production.editorRequests[0]!, production.timeline), true);
  });

  it("rejects without touching the timeline (R-31, A-9)", async () => {
    const store = await open();
    const { commands } = moveSecondEarlier(store);
    const [staged] = await stageEditorRequests(store, {
      conversationId: CONVERSATION,
      entryContext: THREAD,
      requests: [{ summary: "Swap the first two shots", commands }],
      now: NOW,
    });
    const rejected = await decideEditorRequest(store, { productionId: PRODUCTION, requestId: staged!.id, decision: "reject", now: NOW });
    assert.equal(rejected.status, "rejected");
    await assert.rejects(readFile(timelinePath(store), "utf8"), { code: "ENOENT" });
    assert.deepEqual(productionOf(store).timeline, { status: "absent" });
  });

  it("refuses a stale request by name and marks it, without rebasing (R-32, A-9)", async () => {
    const store = await open();
    const { commands, movingId } = moveSecondEarlier(store);
    const [staged] = await stageEditorRequests(store, {
      conversationId: CONVERSATION,
      entryContext: THREAD,
      requests: [{ summary: "Swap the first two shots", commands }],
      now: NOW,
    });
    // The person makes the same move themselves, materialising revision 1 underneath the request.
    await applyTimelineCommand(store, PRODUCTION, {
      kind: "move-picture",
      clipId: movingId,
      direction: "earlier",
      baseRevision: null,
      sourceFingerprint: storyTimelineFingerprint(productionOf(store)),
    });
    const before = await readFile(timelinePath(store), "utf8");
    await assert.rejects(
      decideEditorRequest(store, { productionId: PRODUCTION, requestId: staged!.id, decision: "accept", now: NOW }),
      (error: unknown) => error instanceof EditorRequestRefused && /stale/.test(error.reason),
    );
    assert.equal(await readFile(timelinePath(store), "utf8"), before, "nothing was rebased or applied");
    const record = productionOf(store).editorRequests[0]!;
    assert.equal(record.status, "stale");
    assert.match(record.reason ?? "", /gone|moved/);
  });

  it("stages the same request once, however many times a turn repeats it", async () => {
    const store = await open();
    const { commands } = moveSecondEarlier(store);
    const request = { summary: "Swap the first two shots", commands };
    const first = await stageEditorRequests(store, { conversationId: CONVERSATION, entryContext: THREAD, requests: [request], now: NOW });
    // The corrective retry of the same turn, and a later turn that repeats itself, both land here.
    const again = await stageEditorRequests(store, { conversationId: CONVERSATION, entryContext: THREAD, requests: [request, request], now: NOW });
    assert.deepEqual(again.map((record) => record.id), [first[0]!.id, first[0]!.id]);
    const file = EditorRequestFileSchema.parse(JSON.parse(await readFile(requestsPath(store), "utf8")));
    assert.equal(file.requests.length, 1, "one record, one card");
  });

  it("dismisses a request the base moved under as stale, with the reason (round five)", async () => {
    const store = await open();
    const { commands, movingId } = moveSecondEarlier(store);
    const [staged] = await stageEditorRequests(store, { conversationId: CONVERSATION, entryContext: THREAD, requests: [{ summary: "Swap the first two shots", commands }], now: NOW });
    await applyTimelineCommand(store, PRODUCTION, {
      kind: "move-picture",
      clipId: movingId,
      direction: "earlier",
      baseRevision: null,
      sourceFingerprint: storyTimelineFingerprint(productionOf(store)),
    });
    const dismissed = await decideEditorRequest(store, { productionId: PRODUCTION, requestId: staged!.id, decision: "reject", now: NOW });
    assert.equal(dismissed.status, "stale");
    assert.match(dismissed.reason ?? "", /gone|moved/);
  });

  it("never evicts a pending request to make room, and refuses when nothing decided can go", () => {
    const record = (n: number, status: "pending" | "accepted" | "rejected" | "stale") => ({
      id: `req_01J8G00000000000000000${String(n).padStart(4, "0")}`,
      productionId: PRODUCTION,
      conversationId: CONVERSATION,
      baseRevision: null,
      sourceFingerprint: `story-picture-v1:${"a".repeat(16)}`,
      commands: [{ kind: "delete" as const, clipId: "cl_x" as const }],
      summary: `request ${n}`,
      createdAt: NOW,
      status,
    });
    const mixed = [record(1, "pending"), ...Array.from({ length: 199 }, (_, i) => record(i + 2, "accepted")), record(201, "pending")];
    const kept = retainEditorRequests(mixed);
    assert.equal(kept.length, 200);
    assert.ok(kept.some((request) => request.id === mixed[0]!.id), "the oldest pending request stays");
    assert.ok(!kept.some((request) => request.id === mixed[1]!.id), "the oldest decided one goes");
    assert.throws(
      () => retainEditorRequests(Array.from({ length: 201 }, (_, i) => record(i + 1, "pending"))),
      (error: unknown) => error instanceof EditorRequestRefused && /waiting for a decision/.test(error.reason),
    );
  });

  it("refuses a take switch that could never land, when it is staged (round six)", async () => {
    const store = await open();
    await assert.rejects(
      stageEditorRequests(store, {
        conversationId: CONVERSATION,
        entryContext: THREAD,
        requests: [{ summary: "Use a take that does not exist", commands: [{ kind: "switch-take", shotId: "sh_20", takeId: "tk_01J8F0000000000000000000ZZ" }] }],
        now: NOW,
      }),
      (error: unknown) => error instanceof EditorRequestRefused && /cannot apply/.test(error.reason),
    );
    await assert.rejects(readFile(requestsPath(store), "utf8"), { code: "ENOENT" });
  });

  it("refuses a forged decision that names no request (A-11)", async () => {
    const store = await open();
    await assert.rejects(
      decideEditorRequest(store, { productionId: PRODUCTION, requestId: "req_01J8G0000000000000000000Z9", decision: "accept", now: NOW }),
      (error: unknown) => error instanceof EditorRequestRefused && /not on this production/.test(error.reason),
    );
    await assert.rejects(readFile(timelinePath(store), "utf8"), { code: "ENOENT" });
  });
});

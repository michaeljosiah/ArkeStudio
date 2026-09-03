import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { QueueEnqueueResult } from "../src/lib/store.js";
import { enqueueNote, failedNote, readyNote, subjectOf } from "../src/components/queue-note.js";
import type { Job, ModelManifest } from "@arke-studio/contracts";

const result = (overrides: Partial<QueueEnqueueResult> = {}): QueueEnqueueResult => ({
  at: "2026-08-04T09:00:00Z",
  type: "queue.enqueue-result",
  requestId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
  command: "generate-main-photo",
  disposition: "accepted",
  requestedCount: 1,
  acceptedJobIds: ["jb_01J8E0000000000000000000J1"],
  failures: [],
  ...overrides,
});

const job = (overrides: Partial<Job> = {}): Job =>
  ({
    id: "jb_01J8E0000000000000000000J1",
    idempotencyKey: "01J8E1000000000000000000K9",
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    target: { kind: "main-photo-candidate", id: "maren-kest/g1/1" },
    capability: "image",
    provider: "fal",
    model: "gpt-image-2",
    params: {},
    estimatedMicroUsd: 610_000,
    status: "queued",
    providerJobId: null,
    attempt: 0,
    error: null,
    createdAt: "2026-08-04T09:00:00Z",
    updatedAt: "2026-08-04T09:00:00Z",
    ...overrides,
  }) as Job;

const manifest = {
  models: [
    { id: "gpt-image-2", provider: "fal", displayName: "GPT Image 2" },
    { id: "seedance-2.0", provider: "fal", displayName: "Seedance 2.0" },
    { id: "indextts-2-5", provider: "comfyui", displayName: "IndexTTS 2.5" },
  ],
} as unknown as ModelManifest;

describe("queue notification", () => {
  const batchIds = [
    "jb_01J8E0000000000000000000J1",
    "jb_01J8E0000000000000000000J2",
    "jb_01J8E0000000000000000000J3",
    "jb_01J8E0000000000000000000J4",
  ];

  it("mounts one top-center toaster clear of the desktop title bar", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const app = readFileSync(resolve(here, "../src/App.tsx"), "utf8");
    const toaster = readFileSync(resolve(here, "../src/components/queue-toaster.tsx"), "utf8");
    assert.equal(app.match(/<QueueToaster\s*\/>/g)?.length, 1);
    assert.match(toaster, /position="top-center"/);
    assert.match(toaster, /44px/);
  });

  it("names the work rather than its destination, in two lines", () => {
    const note = enqueueNote(result(), [job()], manifest);
    assert.equal(note?.title, "Maren Kest, main photo queued");
    assert.equal(note?.meta, "GPT Image 2 · ~$0.61");
    assert.equal(note?.tone, "queued");
    assert.deepEqual(note?.action, { label: "Activity", to: "/activity" });
    assert.equal(note?.reason, undefined);
  });

  it("does not repeat the path the user is standing on", () => {
    const note = enqueueNote(result(), [job()], manifest);
    assert.doesNotMatch(note!.meta, /Undersong|cast|maren-kest/i);
    assert.doesNotMatch(note!.title, /Undersong/i);
  });

  it("marks an estimate with a tilde and actual spend without one", () => {
    assert.match(enqueueNote(result(), [job()], manifest)!.meta, /~\$0\.61$/);
    assert.equal(readyNote(job({ status: "succeeded" }), manifest, undefined).meta, "GPT Image 2 · $0.61");
  });

  it("says local where the figure would be, because there is nothing to spend", () => {
    const local = job({ provider: "comfyui", model: "indextts-2-5", estimatedMicroUsd: 0, target: { kind: "voice-line", id: "sh_12" } });
    const note = enqueueNote(result({ command: "dispatch-scene" }), [local], manifest);
    assert.equal(note?.meta, "IndexTTS 2.5 · local");
    assert.doesNotMatch(note!.meta, /\$/);
  });

  it("does not count a batch's own siblings as ahead of it", () => {
    // Four looks dispatched by one press: nothing is in front of them but each other.
    const looks = batchIds.map((id, i) =>
      job({ id, estimatedMicroUsd: 152_500, target: { kind: "character-look", id: `maren-kest/g1/${i + 1}` } }),
    );
    const note = enqueueNote(result({ command: "generate-character-looks", requestedCount: 4, acceptedJobIds: batchIds }), looks, manifest);
    assert.doesNotMatch(note!.meta, /ahead/);
  });

  it("counts what is ahead only when something actually is", () => {
    const mine = job({ createdAt: "2026-08-04T09:00:02Z" });
    const ahead = [
      job({ id: "jb_01J8E0000000000000000000J8", createdAt: "2026-08-04T09:00:00Z", status: "queued" }),
      job({ id: "jb_01J8E0000000000000000000J9", createdAt: "2026-08-04T09:00:01Z", status: "queued" }),
      // Behind it, and a finished one: neither is ahead.
      job({ id: "jb_01J8E0000000000000000000JA", createdAt: "2026-08-04T09:00:05Z", status: "queued" }),
      job({ id: "jb_01J8E0000000000000000000JB", createdAt: "2026-08-04T08:00:00Z", status: "succeeded" }),
    ];
    assert.match(enqueueNote(result(), [mine, ...ahead], manifest)!.meta, /· 2 ahead$/);
    assert.doesNotMatch(enqueueNote(result(), [mine], manifest)!.meta, /ahead/);
  });

  it("states the batch total, which is the figure the surface quoted", () => {
    // The board's button read $5.46 for four shots; the notification must not answer $1.37.
    const pass = batchIds.map((id) =>
      job({ id, model: "seedance-2.0", estimatedMicroUsd: 1_365_000, target: { kind: "scene-pass", id: "sc_11" } }),
    );
    const note = enqueueNote(result({ command: "dispatch-scene", requestedCount: 4, acceptedJobIds: batchIds }), pass, manifest);
    assert.equal(note?.title, "Scene 11, 4 shots queued");
    assert.equal(note?.meta, "Seedance 2.0 · ~$5.46");
  });

  it("names no subject when the jobs in a batch do not share one", () => {
    const shots = batchIds.map((id, i) =>
      job({ id, model: "seedance-2.0", estimatedMicroUsd: 1_365_000, target: { kind: "shot", id: `sh_1${i}` } }),
    );
    const note = enqueueNote(result({ command: "dispatch-scene", requestedCount: 4, acceptedJobIds: batchIds }), shots, manifest);
    assert.equal(note?.title, "4 clips queued");
    // Four different shots, one shared total.
    assert.equal(note?.meta, "Seedance 2.0 · ~$5.46");
  });

  it("keeps a shared subject when every job in the batch has the same one", () => {
    const looks = batchIds.map((id, i) =>
      job({ id, estimatedMicroUsd: 152_500, target: { kind: "character-look", id: `maren-kest/g1/${i + 1}` } }),
    );
    const note = enqueueNote(result({ command: "generate-character-looks", requestedCount: 4, acceptedJobIds: batchIds }), looks, manifest);
    assert.equal(note?.title, "Maren Kest, 4 looks queued");
    assert.equal(note?.meta, "GPT Image 2 · ~$0.61");
  });

  it("states a partial by count and carries the reason as its own line", () => {
    const note = enqueueNote(
      result({
        disposition: "partial",
        requestedCount: 4,
        acceptedJobIds: ["jb_01J8E0000000000000000000J1", "jb_01J8E0000000000000000000J2"],
        failures: [{ index: 2, reason: "Shot 4 has no frame." }, { index: 3, reason: "Shot 4 has no frame." }],
      }),
      [job()],
      manifest,
    );
    assert.equal(note?.tone, "warning");
    assert.equal(note?.title, "Maren Kest, 2 of 4 main photos queued");
    // One reason, not the same sentence twice.
    assert.equal(note?.reason, "Shot 4 has no frame.");
  });

  it("sends a rejected credential to Providers, not to Activity", () => {
    const note = enqueueNote(
      result({ disposition: "rejected", acceptedJobIds: [], failures: [{ index: 0, reason: "FAL rejected the key (HTTP 401)." }] }),
      [],
      manifest,
    );
    assert.equal(note?.tone, "refused");
    assert.equal(note?.title, "Nothing was queued");
    assert.equal(note?.meta, "nothing spent");
    assert.equal(note?.reason, "FAL rejected the key (HTTP 401).");
    assert.deepEqual(note?.action, { label: "Providers", to: "/settings/providers" });
  });

  it("offers no action for work that never queued, because Activity would be empty", () => {
    const note = enqueueNote(
      result({ command: "upload-world-image", disposition: "rejected", acceptedJobIds: [], failures: [{ index: 0, reason: "The file is 8.4 MB; the ceiling is 6 MB." }] }),
      [],
      manifest,
    );
    assert.equal(note?.action, undefined);
    assert.equal(note?.title, "That image can’t be used");
    assert.equal(note?.reason, "The file is 8.4 MB; the ceiling is 6 MB.");
  });

  it("keeps a rejected shot-frame import away from an Activity row that cannot exist", () => {
    const note = enqueueNote(
      result({ command: "import-shot-frame", disposition: "rejected", acceptedJobIds: [], failures: [{ index: 0, reason: "Choose a PNG, JPEG or WebP image." }] }),
      [],
      manifest,
    );
    assert.equal(note?.action, undefined);
    assert.equal(note?.title, "That image can’t be used");
    assert.equal(note?.reason, "Choose a PNG, JPEG or WebP image.");
  });

  it("says when an upload was retained even though its older selection lost", () => {
    const note = enqueueNote(
      result({
        command: "import-shot-frame",
        disposition: "rejected",
        requestedCount: 1,
        acceptedJobIds: [],
        failures: [{ index: 0, reason: "The image was kept as a Variant, but the shot's frame changed before it could be selected." }],
      }),
      [],
      manifest,
    );
    assert.equal(note?.tone, "warning");
    assert.equal(note?.title, "Image kept as a Variant");
    assert.equal(note?.action, undefined);
  });

  it("confirms files added to the Library without inventing a queue job", () => {
    const note = enqueueNote(
      result({
        command: "upload-artifacts",
        disposition: "not-queued",
        requestedCount: 2,
        acceptedJobIds: [],
      }),
      [],
      manifest,
    );
    assert.equal(note?.tone, "back");
    assert.equal(note?.title, "2 files added to the Library");
    assert.equal(note?.meta, "ready to use");
    assert.equal(note?.action, undefined);
  });

  it("names failed files when only part of a Library upload lands", () => {
    const note = enqueueNote(
      result({
        command: "upload-artifacts",
        disposition: "not-queued",
        requestedCount: 2,
        acceptedJobIds: [],
        failures: [{ index: 1, reason: "broken.m4a: Unsupported audio container." }],
      }),
      [],
      manifest,
    );
    assert.equal(note?.tone, "warning");
    assert.equal(note?.title, "1 of 2 files added to the Library");
    assert.equal(note?.meta, "1 file not added");
    assert.equal(note?.reason, "broken.m4a: Unsupported audio container.");
  });

  it("reports an all-failed Library upload as a file refusal", () => {
    const note = enqueueNote(
      result({
        command: "upload-artifacts",
        disposition: "not-queued",
        requestedCount: 2,
        acceptedJobIds: [],
        failures: [
          { index: 0, reason: "broken.mp4: Unsupported video container." },
          { index: 1, reason: "broken.m4a: Unsupported audio container." },
        ],
      }),
      [],
      manifest,
    );
    assert.equal(note?.tone, "refused");
    assert.equal(note?.title, "No files added to the Library");
    assert.equal(note?.meta, "nothing spent");
    assert.match(note?.reason ?? "", /broken\.mp4.*broken\.m4a/);
    assert.doesNotMatch(note?.title ?? "", /image/i);
  });

  it("says nothing at all about work that never reached the queue", () => {
    assert.equal(enqueueNote(result({ disposition: "not-queued", requestedCount: 0, acceptedJobIds: [] }), [], manifest), null);
  });

  it("keeps the enqueue's id on the outcome, so the row is replaced rather than stacked", () => {
    const seed = enqueueNote(result(), [job()], manifest)!;
    assert.equal(readyNote(job({ status: "succeeded" }), manifest, seed.id).id, seed.id);
    assert.equal(failedNote(job({ status: "failed" }), manifest, seed.id).id, seed.id);
    assert.equal(readyNote(job({ status: "succeeded" }), manifest, undefined).id, "job:jb_01J8E0000000000000000000J1");
  });

  it("does not paint a queued job with the colour of one that came back", () => {
    assert.equal(enqueueNote(result(), [job()], manifest)?.tone, "queued");
    assert.equal(readyNote(job({ status: "succeeded" }), manifest, undefined).tone, "back");
  });

  it("takes a character sheet straight to the kit and everything else to Activity", () => {
    const sheet = job({ target: { kind: "character-sheet", id: "maren-kest/g1" }, params: { characterName: "Maren Kest" }, status: "succeeded" });
    assert.deepEqual(readyNote(sheet, manifest, undefined), {
      id: "job:jb_01J8E0000000000000000000J1",
      tone: "back",
      title: "Maren Kest, character sheet ready",
      meta: "GPT Image 2 · $0.61",
      action: { label: "View", to: "/w/01J8F3K2QW9VZX4N7M0RTYB6HC/cast/maren-kest/kit" },
    });
    assert.equal(readyNote(job({ status: "succeeded" }), manifest, undefined).action?.label, "Activity");
  });

  it("carries the picture that came back, and only when it is one", () => {
    const withFile = job({ status: "succeeded", landedFiles: ["references/maren-kest/sheet.png"] });
    assert.deepEqual(readyNote(withFile, manifest, undefined).thumb, {
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      path: "references/maren-kest/sheet.png",
    });
    assert.equal(readyNote(job({ status: "succeeded", landedFiles: ["audio/line.wav"] }), manifest, undefined).thumb, undefined);
    assert.equal(readyNote(job({ status: "succeeded" }), manifest, undefined).thumb, undefined);
  });

  it("names a failure with what it cost, which is nothing", () => {
    const note = failedNote(job({ status: "failed", error: "Provider timed out." }), manifest, undefined);
    assert.equal(note.title, "Maren Kest, main photo failed");
    assert.equal(note.meta, "GPT Image 2 · not charged");
    assert.equal(note.reason, "Provider timed out.");
  });

  it("falls back to the command's own noun when the job records have not landed yet", () => {
    const note = enqueueNote(result({ command: "dispatch-scene", requestedCount: 3, acceptedJobIds: ["a", "b", "c"] }), [], manifest);
    assert.equal(note?.title, "3 shots queued");
    assert.equal(note?.meta, "nothing to price yet");
  });

  it("names the subject the way the rest of the app does", () => {
    assert.equal(subjectOf(job({ target: { kind: "shot", id: "sh_12" } })), "Shot 12");
    assert.equal(subjectOf(job({ target: { kind: "scene-pass", id: "sc_04" } })), "Scene 4");
    assert.equal(subjectOf(job({ target: { kind: "character-look", id: "maren-kest/g1/2" } })), "Maren Kest");
    assert.equal(subjectOf(job({ params: { characterName: "Odile Rhee" } })), "Odile Rhee");
    // A world id is not a name the title can use.
    assert.equal(subjectOf(job({ target: { kind: "world-image", id: "01J8F3K2QW9VZX4N7M0RTYB6HC" } })), null);
    // Witnessed on a real bench dispatch: a prefixed opaque id must not become a subject.
    assert.equal(subjectOf(job({ target: { kind: "bench-take", id: "sess_01M0649N4RH2WC7QN50JXX9P7R/tk_3" } })), null);
  });

  it("uses the manifest's own name for the model, so picker and notification agree", () => {
    assert.match(enqueueNote(result(), [job()], manifest)!.meta, /^GPT Image 2 · /);
    // An unknown row still says something true rather than nothing.
    assert.match(enqueueNote(result(), [job({ model: "unlisted-1" })], manifest)!.meta, /^unlisted-1 · /);
  });
});

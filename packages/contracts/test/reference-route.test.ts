import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BenchRequestSnapshotSchema,
  BenchVideoParamsSchema,
  ManifestModelSchema,
  admitReference,
  castNameFor,
  cleanWho,
  referencePrompt,
  referenceRouteModel,
  referenceRouteRefusal,
  referenceSheetId,
  referenceSubjectLines,
  whoFor,
  type ManifestModel,
} from "../src/index.js";

/* The reference route's shared rules (design turn 179): one set, for the composer and the gate. */

const row = (over: Partial<ManifestModel> = {}): ManifestModel => ManifestModelSchema.parse({
  id: "comfyui-h3-video", provider: "comfyui", capability: "video", displayName: "Local · H3 Video",
  accepts: { referenceImages: 1, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 2000, durations: { "15": "15" }, resolutions: ["480p"] },
  pricing: { kind: "unmetered" },
  referenceRoute: { maxImages: 1, referenceSyntax: "minimax-h3" },
  ...over,
});
const h3 = row();
const h3768 = row({ id: "comfyui-h3-video-768", displayName: "Local · H3 Video 768p", accepts: { referenceImages: 0, startFrame: false, endFrame: false }, referenceRoute: undefined });

describe("the reference route's view of a row", () => {
  it("budgets and cites as the route, and leaves a row without one alone", () => {
    const view = referenceRouteModel(h3);
    assert.equal(view.accepts.referenceImages, 1);
    assert.equal(view.limits.referenceSyntax, "minimax-h3");
    assert.equal(h3.limits.referenceSyntax, undefined, "the row itself is untouched");
    assert.equal(referenceRouteModel(h3768), h3768);
    assert.equal(admitReference({ kind: "image", durationSec: 0 }, [{ kind: "image", durationSec: 0 }], view).ok, false);
    assert.equal(referencePrompt("The woman is @Image 1.", view), "The woman is <Picture 1>.");
  });

  it("a local video row without the route refuses pictures in exactly one clause", () => {
    assert.equal(referenceRouteRefusal(h3768, 1), "H3 Video 768p takes no reference pictures yet");
    assert.equal(referenceRouteRefusal(h3768, 0), null);
    assert.equal(referenceRouteRefusal(h3, 1), null);
    assert.equal(referenceRouteRefusal({ ...h3768, provider: "fal" }, 1), null, "a cloud row says what it takes itself");
  });

  it("rejects a route the manifest cannot describe", () => {
    assert.throws(() => row({ referenceRoute: { maxImages: 0, referenceSyntax: "minimax-h3" } }));
    assert.throws(() => row({ referenceRoute: { maxImages: 1, referenceSyntax: "seedance" as never } }));
  });
});

describe("who a picture is", () => {
  const world = {
    sheets: [{ id: "mara", name: "Mara Vey" }],
    artifacts: [{ id: "ar_01JKKKKKKKKKKKKKKKKKKKKKKK", generation: { source: "character-reference", sheetId: "mara" } as never }],
  };
  const hash = "sha256:deadbeefdeadbeef" as const;

  it("a Cast picture is its character, by prefill, folder or filing", () => {
    assert.equal(castNameFor({ sheetId: "mara", source: { source: "take", takeId: "tk_x" as never, hash } }, world), "Mara Vey");
    assert.equal(castNameFor({ source: { source: "world-file", path: "references/mara/identity.png" as never, hash } }, world), "Mara Vey");
    assert.equal(castNameFor({ source: { source: "artifact", artifactId: "ar_01JKKKKKKKKKKKKKKKKKKKKKKK" as never, hash } }, world), "Mara Vey");
    assert.equal(referenceSheetId({ source: { source: "world-file", path: "artifacts/dancer.png" as never, hash } }, world.artifacts), undefined);
  });

  it("the Cast name wins, then what was typed, then the person", () => {
    assert.equal(whoFor("Mara Vey", "the woman"), "Mara Vey");
    assert.equal(whoFor(undefined, " the   woman "), "the woman");
    assert.equal(whoFor(undefined, ""), "the person");
    assert.equal(whoFor(undefined, undefined), "the person");
    assert.equal(cleanWho("<Picture 2>\nher"), "Picture 2 her");
    assert.equal(cleanWho("x".repeat(100)).length, 80);
  });

  it("one subject line per picture, numbered as they ride", () => {
    assert.deepEqual(referenceSubjectLines(["the woman", "Mara Vey"]), [
      "<Subject 1> is the woman, shown in <Picture 1>.",
      "<Subject 2> is Mara Vey, shown in <Picture 2>.",
    ]);
  });
});

describe("what a take keeps", () => {
  it("the composer's labels and the snapshot's record parse, and the record refuses a bare picture", () => {
    assert.ok(BenchVideoParamsSchema.safeParse({ kind: "video", who: { "Image 1": "the woman", "Image 2": "" } }).success);
    assert.equal(BenchVideoParamsSchema.safeParse({ kind: "video", who: { "Video 1": "x" } }).success, false);
    const snapshot = {
      mode: "video", brief: "x", references: [], keyframes: [], provider: "comfyui", model: "comfyui-h3-video",
      params: { kind: "video" },
      referenceRoute: { route: "reference", prompt: "p", pictures: [{ token: "Image 1", file: "a.png", hash: "sha256:deadbeefdeadbeef", who: "the person" }] },
    };
    assert.ok(BenchRequestSnapshotSchema.safeParse(snapshot).success);
    assert.equal(BenchRequestSnapshotSchema.safeParse({ ...snapshot, referenceRoute: { ...snapshot.referenceRoute, pictures: [] } }).success, false);
  });
});

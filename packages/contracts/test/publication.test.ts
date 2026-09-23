import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  PublicationAssetPathSchema,
  PublicationCaptureSchema,
  VideoPublicationManifestSchema,
  fingerprintPublicationCapture,
  publicationCaptureText,
  readPublicationManifest,
  type PublicationCapture,
  type VideoPublicationManifest,
} from "../src/publication.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

// A contract fixture, not a playable package. Package IO/codec tests belong to the later host.
function movie(): VideoPublicationManifest {
  return {
    format: "arke-publication", schemaVersion: 1,
    id: "urn:uuid:1d27b674-7fb9-4de3-85df-e15f3d2df918", edition: "1",
    profile: "video", profileVersion: 1, title: "The Crossing", language: "en-GB",
    requires: ["video-v1", "webvtt-v1"],
    assets: {
      movie: { href: "media/movie.mp4", mediaType: "video/mp4", byteLength: 1024, sha256: digest("movie") },
      english: { href: "captions/en.vtt", mediaType: "text/vtt", byteLength: 128, sha256: digest("English captions") },
    },
    content: { video: "movie", textTracks: [{ asset: "english", kind: "captions", language: "en", label: "English CC", default: true }] },
    build: { compiler: "arke-publication", compilerVersion: "1.0.0", dependencyFingerprint: digest("capture") },
  };
}

function capture(): PublicationCapture {
  return {
    version: 1, compiler: { compiler: "arke-publication", compilerVersion: "1.0.0" },
    timelineRevision: 7,
    records: [{ key: "timeline", sha256: digest("timeline 7") }, { key: "selections", sha256: digest("take A") }],
    media: [{ key: "take-A", sha256: digest("source bytes"), byteLength: 123 }, { key: "sound", sha256: digest("audio"), byteLength: 456 }],
    resolvedPlanSha256: digest("take A at 0-10s"), settingsSha256: digest("1080p"),
  };
}

function invalid(manifest: unknown, message?: RegExp) {
  const result = readPublicationManifest(manifest);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected refusal");
  assert.equal(result.code, "invalid-manifest");
  if (message) assert.match(result.reason, message);
}

describe("video publication contract (SPEC-048 R-12..R-23)", () => {
  it("round trips a movie with captions and a second language without editing state", () => {
    const manifest = movie();
    manifest.assets.french = { ...manifest.assets.english!, href: "captions/fr.vtt", sha256: digest("French") };
    manifest.content.textTracks.push({ asset: "french", kind: "subtitles", language: "fr", label: "Français", default: false });
    manifest.metadata = { "https://example.org/credits": { director: "Mara", extra: [true, null, 3] } };
    const result = readPublicationManifest(JSON.parse(JSON.stringify(manifest)));
    assert.deepEqual(result, { ok: true, manifest });
    assert.deepEqual(manifest.content.textTracks.map((track) => track.kind), ["captions", "subtitles"]);
  });

  it("supports a clean movie without caption capability and does not mutate its input", () => {
    const manifest = movie();
    delete manifest.assets.english;
    manifest.content.textTracks = [];
    manifest.requires = ["video-v1"];
    const before = structuredClone(manifest);
    assert.equal(readPublicationManifest(manifest, ["video-v1"]).ok, true);
    assert.deepEqual(manifest, before);
  });

  it("classifies unsupported schema, profile and required capabilities before use", () => {
    for (const [patch, code] of [
      [{ schemaVersion: 2 }, "unsupported-schema"],
      [{ profile: "audiobook" }, "unsupported-profile"],
      [{ profileVersion: 2 }, "unsupported-profile"],
      [{ requires: ["video-v1", "webvtt-v1", "branching-v1"] }, "unsupported-capability"],
    ] as const) {
      const result = readPublicationManifest({ ...movie(), ...patch });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, code);
    }
    const result = readPublicationManifest(movie(), ["video-v1"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unsupported-capability");
  });

  it("requires capabilities implied by content, unique track assets and at most one default", () => {
    const manifest = movie();
    manifest.requires = ["video-v1"];
    invalid(manifest, /webvtt/);
    manifest.requires = ["webvtt-v1"];
    invalid(manifest, /video-v1/);
    manifest.requires = ["video-v1", "webvtt-v1", "video-v1"];
    invalid(manifest, /unique/);
    manifest.requires = ["video-v1", "webvtt-v1"];
    manifest.content.textTracks.push({ ...manifest.content.textTracks[0]!, default: false });
    invalid(manifest, /more than once/);
    manifest.assets.french = { ...manifest.assets.english!, href: "captions/fr.vtt" };
    manifest.content.textTracks[1] = { asset: "french", kind: "subtitles", language: "fr", label: "French", default: true };
    invalid(manifest, /one text track/);
  });

  it("refuses unresolved, empty, mistyped and surplus assets", () => {
    const missing = movie();
    missing.content.video = "constructor";
    invalid(missing, /not in the inventory/);
    const empty = movie();
    empty.assets.movie!.byteLength = 0;
    invalid(empty, /empty/);
    const mistyped = movie();
    mistyped.assets.english!.mediaType = "text/html";
    invalid(mistyped, /media type/);
    const surplus = movie();
    surplus.assets.draft = { ...surplus.assets.movie!, href: "draft.mp4" };
    invalid(surplus, /unreferenced/);
  });

  it("requires complete hashes and safe byte counts", () => {
    for (const sha256 of ["abc", "sha256:" + digest("x"), "G".repeat(64)]) {
      const manifest = movie();
      manifest.assets.movie!.sha256 = sha256;
      invalid(manifest);
    }
    for (const byteLength of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const manifest = movie();
      manifest.assets.movie!.byteLength = byteLength;
      invalid(manifest);
    }
  });

  it("rejects extra content instructions and world/session fields while accepting inert metadata", () => {
    invalid({ ...movie(), worldPath: "C:/private/world" });
    invalid({ ...movie(), content: { ...movie().content, followShot: "sh_current" } });
    invalid({ ...movie(), build: { ...movie().build, credential: "must not travel" } });
    invalid({ ...movie(), metadata: { unnamespaced: "text" } });
    invalid({ ...movie(), metadata: { "https://example.org/extra": new Date() } });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    invalid({ ...movie(), metadata: { "https://example.org/extra": cycle } });
    for (const input of [null, [], "text", { format: "another-format" }]) invalid(input);
  });
});

describe("portable publication asset paths", () => {
  it("refuses paths with platform, URL or archive aliases", () => {
    for (const href of [
      "", "/movie.mp4", "C:/movie.mp4", "C:movie.mp4", "\\\\server\\movie.mp4", "media\\movie.mp4",
      "../movie.mp4", "media/../movie.mp4", "./movie.mp4", "media//movie.mp4", "media/",
      "https://example.org/movie.mp4", "media/movie.mp4?token=x", "media/movie.mp4#fragment",
      "media/%2e%2e/movie.mp4", "media/movie.mp4:stream", "media/movie.mp4.", "media/movie.mp4 ",
      "media/NUL.mp4", "COM1/file.mp4", "aux.mp4", "LPT9.vtt", "media/a\u0000.mp4",
      "publication.json", "Publication.JSON", "publication.json/movie.mp4", "média/movie.mp4",
    ]) assert.equal(PublicationAssetPathSchema.safeParse(href).success, false, href);
    for (const href of ["media/movie-1.mp4", "captions/en-GB.vtt", "assets/A_01.webm"]) {
      assert.equal(PublicationAssetPathSchema.safeParse(href).success, true, href);
    }
  });

  it("refuses case collisions and file/directory conflicts independent of inventory order", () => {
    const collision = movie();
    collision.assets.english!.href = "MEDIA/MOVIE.MP4";
    invalid(collision, /collide/);
    for (const reverse of [false, true]) {
      const manifest = movie();
      manifest.assets.movie!.href = "media";
      manifest.assets.english!.href = "MEDIA/en.vtt";
      if (reverse) manifest.assets = Object.fromEntries(Object.entries(manifest.assets).reverse());
      invalid(manifest, /directory/);
    }
  });
});

describe("publication dependency fingerprints (SPEC-048 R-6..R-8)", () => {
  it("is stable across object and inventory order and matches standard SHA-256", async () => {
    const input = capture();
    const before = structuredClone(input);
    const fingerprint = await fingerprintPublicationCapture(input);
    assert.equal(fingerprint, "c3ce0ceb6bd766460e0274e7f3a64c5b80fcba26a8dab6e75b8bc0988d45ef8f");
    assert.equal(fingerprint, digest(publicationCaptureText(input)));
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as PublicationCapture;
    reordered.records = [...input.records].reverse();
    reordered.media = [...input.media].reverse();
    assert.equal(await fingerprintPublicationCapture(reordered), fingerprint);
    assert.deepEqual(input, before);
  });

  it("changes when a selection or trim changes without a new timeline revision", async () => {
    const input = capture();
    const first = await fingerprintPublicationCapture(input);
    input.records[1]!.sha256 = digest("take B");
    assert.notEqual(await fingerprintPublicationCapture(input), first);
    const trim = capture();
    trim.resolvedPlanSha256 = digest("take A at 1-10s");
    assert.notEqual(await fingerprintPublicationCapture(trim), first);
    assert.equal(trim.timelineRevision, input.timelineRevision);
  });

  it("binds media bytes, settings and compiler version and allows legacy null revisions", async () => {
    const first = await fingerprintPublicationCapture(capture());
    for (const change of [
      (input: PublicationCapture) => { input.media[0]!.sha256 = digest("changed bytes"); },
      (input: PublicationCapture) => { input.media[0]!.byteLength++; },
      (input: PublicationCapture) => { input.settingsSha256 = digest("720p"); },
      (input: PublicationCapture) => { input.compiler.compilerVersion = "2.0.0"; },
      (input: PublicationCapture) => { input.timelineRevision = null; },
    ]) {
      const input = capture();
      change(input);
      assert.notEqual(await fingerprintPublicationCapture(input), first);
    }
  });

  it("refuses ambiguous receipts rather than hiding duplicate source keys", async () => {
    for (const field of ["records", "media"] as const) {
      const input = capture();
      if (field === "media") input.media.push({ ...input.media[0]! });
      else input.records.push({ ...input.records[0]! });
      assert.equal(PublicationCaptureSchema.safeParse(input).success, false);
      await assert.rejects(fingerprintPublicationCapture(input));
    }
    assert.equal(VideoPublicationManifestSchema.safeParse({ ...movie(), capture: capture() }).success, false);
  });
});

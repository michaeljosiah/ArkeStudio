import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import type { VideoPublicationManifest } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { verifyPublicationDirectory } from "../../src/publications/verify.js";
import { PublicationFileError } from "../../src/publications/files.js";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const refusal = (code: PublicationFileError["code"]) => (error: unknown) => error instanceof PublicationFileError && error.code === code;

async function fixture() {
  const directory = await tempDir("arke-publication-verify-");
  await mkdir(join(directory, "media"));
  await mkdir(join(directory, "captions"));
  // File integrity fixtures, deliberately not decodable video. Codec validation is a player job.
  const video = Buffer.alloc(2 * 1024 * 1024 + 37, 7);
  const captions = Buffer.from("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n[Door closes]\n");
  await writeFile(join(directory, "media/movie.mp4"), video);
  await writeFile(join(directory, "captions/en.vtt"), captions);
  const manifest: VideoPublicationManifest = {
    format: "arke-publication", schemaVersion: 1, id: "urn:uuid:1d27b674-7fb9-4de3-85df-e15f3d2df918",
    edition: "1", profile: "video", profileVersion: 1, title: "Frozen movie", language: "en",
    requires: ["video-v1", "webvtt-v1"],
    assets: {
      movie: { href: "media/movie.mp4", mediaType: "video/mp4", byteLength: video.length, sha256: digest(video) },
      captions: { href: "captions/en.vtt", mediaType: "text/vtt", byteLength: captions.length, sha256: digest(captions) },
    },
    content: { video: "movie", textTracks: [{ asset: "captions", kind: "captions", language: "en", label: "English CC", default: true }] },
    build: { compiler: "arke-publication", compilerVersion: "1", dependencyFingerprint: digest("inputs") },
  };
  const save = () => writeFile(join(directory, "publication.json"), JSON.stringify(manifest));
  await save();
  return { directory, manifest, save, video, captions };
}

it("verifies all declared bytes after the package moves, without a world", async () => {
  const original = await fixture();
  const moved = join(await tempDir("arke-publication-moved-"), "edition");
  await cp(original.directory, moved, { recursive: true });
  await rm(original.directory, { recursive: true, force: true });
  const result = await verifyPublicationDirectory(moved);
  assert.deepEqual(result.manifest, original.manifest);
  assert.equal(result.manifestSha256, digest(await readFile(join(moved, "publication.json"))));
  assert.equal(result.byteLength, original.video.length + original.captions.length + Buffer.byteLength(JSON.stringify(original.manifest)));
});

it("refuses a same-length media edit and a lying declared length", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "media/movie.mp4"), Buffer.alloc(f.video.length, 8));
  await assert.rejects(verifyPublicationDirectory(f.directory), refusal("source-changed"));
  await writeFile(join(f.directory, "media/movie.mp4"), f.video);
  f.manifest.assets.movie!.byteLength++;
  await f.save();
  await assert.rejects(verifyPublicationDirectory(f.directory), refusal("source-changed"));
});

it("refuses missing and unlisted files instead of shipping private leftovers", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "draft.txt"), "private draft");
  await assert.rejects(verifyPublicationDirectory(f.directory), refusal("invalid-package"));
  await rm(join(f.directory, "draft.txt"));
  await rm(join(f.directory, "captions/en.vtt"));
  await assert.rejects(verifyPublicationDirectory(f.directory), refusal("invalid-package"));
});

it("bounds the manifest, assets, aggregate bytes and directory census", async () => {
  const f = await fixture();
  for (const limits of [{ manifestBytes: 20 }, { assetBytes: 100 }, { totalBytes: 100 }, { entries: 1 }]) {
    await assert.rejects(verifyPublicationDirectory(f.directory, { limits }), refusal("limit-exceeded"));
  }
  await assert.rejects(verifyPublicationDirectory(f.directory, { limits: { assetBytes: Infinity } }), refusal("limit-exceeded"));
});

it("keeps unsupported capabilities distinct from malformed packages", async () => {
  const f = await fixture();
  f.manifest.requires.push("hdr-v1");
  await f.save();
  await assert.rejects(verifyPublicationDirectory(f.directory), refusal("unsupported-capability"));
  await writeFile(join(f.directory, "publication.json"), Buffer.from([0xff, 0xfe, 0x7b]));
  await assert.rejects(verifyPublicationDirectory(f.directory), refusal("invalid-package"));
});

it("rejects linked asset directories and honors cancellation without altering the package", async () => {
  const f = await fixture();
  const outside = await tempDir("arke-publication-outside-");
  await cp(join(f.directory, "media"), outside, { recursive: true });
  await rm(join(f.directory, "media"), { recursive: true });
  await symlink(outside, join(f.directory, "media"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyPublicationDirectory(f.directory), refusal("unsafe-path"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(verifyPublicationDirectory(f.directory, { signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(await readFile(join(outside, "movie.mp4")), f.video);
});

it("refuses directory casing aliases on case-sensitive filesystems", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  await mkdir(join(f.directory, "MEDIA"));
  await assert.rejects(verifyPublicationDirectory(f.directory), refusal("unsafe-path"));
});

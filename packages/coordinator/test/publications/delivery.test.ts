import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipFile } from "yazl";
import { it } from "node:test";
import type { VideoPublicationManifest } from "@arke-studio/contracts";
import { writeZip, type ZipEntry } from "../../src/productions/zip.js";
import { extractPublicationZip, writePublicationZip } from "../../src/publications/archive.js";
import { PublicationFileError } from "../../src/publications/files.js";
import { publishPublication, type PublicationDeliveryRequest } from "../../src/publications/publish.js";
import { verifyPublicationDirectory } from "../../src/publications/verify.js";
import { tempDir } from "../tmp.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const publicationId = "urn:uuid:1d27b674-7fb9-4de3-85df-e15f3d2df918";
const refusal = (code: PublicationFileError["code"]) => (error: unknown) => error instanceof PublicationFileError && error.code === code;

function packageEntries(): ZipEntry[] {
  const movie = Buffer.alloc(2 * 1024 * 1024 + 7, 13);
  const captions = Buffer.from("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n[Door closes]\n");
  const manifest: VideoPublicationManifest = {
    format: "arke-publication", schemaVersion: 1, id: publicationId, edition: "1", profile: "video", profileVersion: 1,
    title: "Frozen film — édition", language: "en", requires: ["video-v1", "webvtt-v1"],
    assets: {
      movie: { href: "media/movie.mp4", mediaType: "video/mp4", byteLength: movie.length, sha256: hash(movie) },
      captions: { href: "text/en.vtt", mediaType: "text/vtt", byteLength: captions.length, sha256: hash(captions) },
    },
    content: { video: "movie", textTracks: [{ asset: "captions", language: "en", label: "English CC", kind: "captions", default: true }] },
    build: { compiler: "fixture", compilerVersion: "1", dependencyFingerprint: hash("frozen inputs") },
  };
  return [{ name: "publication.json", data: Buffer.from(JSON.stringify(manifest)) }, { name: "media/movie.mp4", data: movie }, { name: "text/en.vtt", data: captions }];
}

async function packageDirectory(root: string) {
  const directory = join(root, `source-${randomUUID()}`);
  await mkdir(directory);
  await mkdir(join(directory, "media")); await mkdir(join(directory, "text"));
  for (const entry of packageEntries()) await writeFile(join(directory, entry.name), entry.data);
  return { ...await verifyPublicationDirectory(directory), dispose: () => rm(directory, { recursive: true, force: true }) };
}

function request(format: PublicationDeliveryRequest["format"] = "directory"): PublicationDeliveryRequest {
  return { operationId: randomUUID(), publicationId, format, requestFingerprint: hash("request") };
}

it("writes a streamed portable ZIP and verifies it after moving away from the source", async () => {
  const root = await tempDir("arke-publication-zip-");
  const source = await packageDirectory(root);
  const archive = join(root, "film.zip");
  await writePublicationZip(source.directory, archive);
  await source.dispose();
  const extracted = await extractPublicationZip(archive, root);
  assert.equal(extracted.manifest.id, publicationId);
  assert.equal(extracted.manifestSha256, source.manifestSha256);
  assert.equal(extracted.byteLength, source.byteLength);
  assert.match(await readFile(join(extracted.directory, "text/en.vtt"), "utf8"), /Door closes/);
  await extracted.dispose(); await extracted.dispose();
  assert.deepEqual(await readdir(root), ["film.zip"]);
});

it("never overwrites an existing ZIP and cleans cancellation/failure output", async () => {
  const root = await tempDir("arke-publication-zip-exclusive-");
  const source = await packageDirectory(root);
  const archive = join(root, "film.zip");
  await writeFile(archive, "keep me");
  await assert.rejects(writePublicationZip(source.directory, archive), { code: "EEXIST" });
  assert.equal(await readFile(archive, "utf8"), "keep me");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(writePublicationZip(source.directory, join(root, "cancelled.zip"), { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(extractPublicationZip(archive, root, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(extractPublicationZip(archive, root));
  assert.equal((await readdir(root)).some(name => name.startsWith("arke-publication-unzip-")), false);
});

it("refuses duplicate, aliasing, traversal and file/directory ZIP collisions before extraction", async () => {
  const root = await tempDir("arke-publication-zip-paths-");
  const base = packageEntries();
  const cases: ZipEntry[][] = [
    [...base, base[0]!], [...base, { name: "MEDIA/unused.mp4", data: Buffer.from("x") }],
    [...base, { name: "../escape.txt", data: Buffer.from("x") }],
    [...base, { name: "C:/escape.txt", data: Buffer.from("x") }],
    [...base, { name: "media", data: Buffer.from("x") }],
    [...base, { name: "media\\other.mp4", data: Buffer.from("x") }],
    [...base, { name: "publication.json/child", data: Buffer.from("x") }],
  ];
  for (const entries of cases) {
    const archive = join(root, "bad.zip"); await writeFile(archive, writeZip(entries));
    await assert.rejects(extractPublicationZip(archive, root));
    assert.deepEqual(await readdir(root), ["bad.zip"]);
  }
});

it("accepts ordinary explicit directories and refuses linked ZIP entries", async () => {
  const root = await tempDir("arke-publication-zip-modes-");
  const archive = join(root, "film.zip");
  await writeFile(archive, writeZip([{ name: "media/", data: Buffer.alloc(0) }, ...packageEntries()]));
  const accepted = await extractPublicationZip(archive, root); await accepted.dispose();
  const hostile = Buffer.from(writeZip(packageEntries()));
  const central = hostile.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  hostile.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  await writeFile(archive, hostile);
  await assert.rejects(extractPublicationZip(archive, root), refusal("unsafe-path"));
});

it("bounds compressed extraction and refuses corrupt checksums or an unlisted payload", async () => {
  const root = await tempDir("arke-publication-zip-limits-");
  const archive = join(root, "film.zip");
  await writeFile(archive, writeZip(packageEntries()));
  for (const limits of [{ entries: 1 }, { assetBytes: 1024 }, { manifestBytes: 20 }, { totalBytes: 1024 }]) {
    await assert.rejects(extractPublicationZip(archive, root, { limits }), refusal("limit-exceeded"));
  }
  const corrupt = Buffer.from(writeZip(packageEntries()));
  const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  corrupt.writeUInt32LE(1234, central + 16);
  await writeFile(archive, corrupt);
  await assert.rejects(extractPublicationZip(archive, root), refusal("invalid-package"));
  await writeFile(archive, writeZip([...packageEntries(), { name: "private.txt", data: Buffer.from("private") }]));
  await assert.rejects(extractPublicationZip(archive, root), refusal("invalid-package"));
  assert.deepEqual(await readdir(root), ["film.zip"]);
});

it("reads ZIP64 and cleans an in-flight archive cancellation", async () => {
  const root = await tempDir("arke-publication-zip64-");
  const archive = join(root, "film.zip");
  const zip = new ZipFile(); const chunks: Buffer[] = [];
  const finished = new Promise<void>((resolve, reject) => {
    zip.outputStream.on("data", chunk => chunks.push(Buffer.from(chunk)));
    zip.outputStream.once("end", resolve); zip.once("error", reject);
  });
  for (const entry of packageEntries()) zip.addBuffer(Buffer.from(entry.data), entry.name, { forceZip64Format: true });
  zip.end({ forceZip64Format: true, comment: "" }); await finished;
  await writeFile(archive, Buffer.concat(chunks));
  const accepted = await extractPublicationZip(archive, root); await accepted.dispose();
  const controller = new AbortController();
  // Repeated filesystem/stream awaits let the abort interrupt actual archive work, rather
  // than testing only the entry-point pre-abort guard.
  const extracting = extractPublicationZip(archive, root, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 1);
  try { await assert.rejects(extracting, { name: "AbortError" }); }
  finally { clearTimeout(timer); }
  assert.deepEqual(await readdir(root), ["film.zip"]);
});

it("refuses unsupported ZIP encryption and compression before writing package files", async () => {
  const root = await tempDir("arke-publication-zip-encoding-");
  for (const kind of ["encrypted", "method"]) {
    const archive = Buffer.from(writeZip(packageEntries()));
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt16LE(kind === "encrypted" ? 1 : 99, central + (kind === "encrypted" ? 8 : 10));
    const path = join(root, "bad.zip"); await writeFile(path, archive);
    await assert.rejects(extractPublicationZip(path, root), refusal("unsafe-path"));
    assert.deepEqual(await readdir(root), ["bad.zip"]);
  }
});

for (const format of ["directory", "zip"] as const) {
  it(`publishes ${format} once, records completion and returns the same edition on retry`, async () => {
    const root = await tempDir("arke-publication-publish-");
    const operation = request(format);
    let builds = 0;
    const build = async (scratch: string) => { builds++; return packageDirectory(scratch); };
    const first = await publishPublication(operation, build, { outputRoot: root });
    const retry = await publishPublication(operation, build, { outputRoot: root });
    assert.deepEqual(retry, first); assert.equal(builds, 1);
    assert.equal(first.format, format);
    assert.equal(first.manifest.id, publicationId);
    assert.equal(JSON.parse(await readFile(join(root, operation.operationId, "complete.json"), "utf8")).manifestSha256, first.manifestSha256);
    await assert.rejects(publishPublication({ ...operation, requestFingerprint: hash("different") }, build, { outputRoot: root }), refusal("operation-conflict"));
    assert.equal(builds, 1);
  });

  for (const phase of ["prepared", "promoted", "completed"] as const) {
    it(`reconciles ${format} after interruption at ${phase} without invoking the compiler`, async () => {
      const root = await tempDir("arke-publication-recover-");
      const operation = request(format);
      await assert.rejects(publishPublication(operation, packageDirectory, { outputRoot: root, onPhase: value => {
        if (value === phase) throw new Error("interrupted");
      } }), /interrupted/);
      const result = await publishPublication(operation, async () => { throw new Error("must not rebuild"); }, { outputRoot: root });
      assert.equal(result.manifest.id, publicationId);
      const again = await publishPublication(operation, async () => { throw new Error("must not rebuild"); }, { outputRoot: root });
      assert.equal(again.path, result.path);
    });
  }
}

it("cancels before promotion and reconciles the prepared edition on retry", async () => {
  const root = await tempDir("arke-publication-cancel-");
  const operation = request();
  const controller = new AbortController();
  await assert.rejects(publishPublication(operation, packageDirectory, { outputRoot: root, signal: controller.signal,
    onPhase: phase => { if (phase === "prepared") controller.abort(); } }), { name: "AbortError" });
  await assert.rejects(readFile(join(root, operation.operationId, "complete.json")), { code: "ENOENT" });
  const result = await publishPublication(operation, async () => { throw new Error("must not rebuild"); }, { outputRoot: root });
  assert.equal(result.manifest.id, publicationId);
});

it("preserves corrupted or missing completed output and never replaces it with a new build", async () => {
  const root = await tempDir("arke-publication-corruption-");
  const operation = request();
  const result = await publishPublication(operation, packageDirectory, { outputRoot: root });
  await writeFile(join(result.path, "media/movie.mp4"), "externally changed");
  await assert.rejects(publishPublication(operation, async () => { throw new Error("must not rebuild"); }, { outputRoot: root }), refusal("source-changed"));
  assert.equal(await readFile(join(result.path, "media/movie.mp4"), "utf8"), "externally changed");
  await rm(result.path, { recursive: true });
  await assert.rejects(publishPublication(operation, packageDirectory, { outputRoot: root }), refusal("incomplete-publication"));
});

it("preserves an existing empty destination and cleans only its own failed attempts", async () => {
  const root = await tempDir("arke-publication-existing-");
  const operation = request();
  let target = "";
  await assert.rejects(publishPublication(operation, packageDirectory, { outputRoot: root, onPhase: async phase => {
    if (phase !== "prepared") return;
    const prepared = JSON.parse(await readFile(join(root, operation.operationId, "prepared.json"), "utf8"));
    target = join(root, operation.operationId, prepared.attempt, "publication");
    await mkdir(target);
  } }));
  assert.deepEqual(await readdir(target), []);
  await assert.rejects(readFile(join(root, operation.operationId, "complete.json")), { code: "ENOENT" });
  const failed = request();
  await assert.rejects(publishPublication(failed, async scratch => { await writeFile(join(scratch, "unrelated-name.txt"), "partial"); throw new Error("render failed"); }, { outputRoot: root }), /render failed/);
  assert.deepEqual(await readdir(join(root, failed.operationId)), ["operation.json"]);
});

it("serializes concurrent retries and rejects linked operation roots", async () => {
  const root = await tempDir("arke-publication-concurrent-");
  const operation = request();
  let builds = 0;
  const build = async (scratch: string) => { builds++; return packageDirectory(scratch); };
  const results = await Promise.all(Array.from({ length: 3 }, () => publishPublication(operation, build, { outputRoot: root })));
  assert.equal(builds, 1); assert.equal(new Set(results.map(result => result.path)).size, 1);
  const other = request(); const outside = await tempDir("arke-publication-outside-");
  await symlink(outside, join(root, other.operationId), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(publishPublication(other, build, { outputRoot: root }), refusal("unsafe-path"));
  assert.deepEqual(await readdir(outside), []);
});

async function child(root: string, source: string, operation: PublicationDeliveryRequest, phase = "") {
  const process = spawn(globalThis.process.execPath, ["--import", "tsx", fileURLToPath(new URL("./delivery-child.ts", import.meta.url)), root, source, JSON.stringify(operation), phase],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  process.stdout.on("data", data => { stdout += data; }); process.stderr.on("data", data => { stderr += data; });
  const timer = setTimeout(() => process.kill(), 60_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { process.once("exit", resolve); process.once("error", reject); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

it("recovers after abrupt process exit on both sides of directory promotion", async () => {
  for (const phase of ["prepared", "promoted"]) {
    const root = await tempDir("arke-publication-process-crash-");
    const source = await packageDirectory(root); const operation = request();
    const killed = await child(root, source.directory, operation, phase);
    assert.equal(killed.code, 71, killed.stderr);
    await source.dispose();
    const recovery = await child(root, "source-no-longer-exists", operation);
    assert.equal(recovery.code, 0, recovery.stderr);
    assert.equal((await verifyPublicationDirectory(JSON.parse(recovery.stdout).path)).manifest.id, publicationId);
  }
});

it("independent processes select one immutable candidate and reconcile concurrent promotion", async () => {
  const root = await tempDir("arke-publication-process-race-");
  const source = await packageDirectory(root); const operation = request();
  const children = await Promise.all([child(root, source.directory, operation), child(root, source.directory, operation)]);
  for (const result of children) assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(children[0]!.stdout).path, JSON.parse(children[1]!.stdout).path);
  const attempts = (await readdir(join(root, operation.operationId))).filter(name => name.startsWith("attempt-"));
  assert.equal(attempts.length, 1);
});

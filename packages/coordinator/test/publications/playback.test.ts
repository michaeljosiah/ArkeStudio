import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { openPublication, validatePublicationVtt } from "../../src/publications/playback.js";
import { writePublicationZip } from "../../src/publications/archive.js";
import { tempDir } from "../tmp.js";

const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n";
async function fixture() {
  const root = await tempDir("arke-player-"); const source = join(root, "source"); const scratch = join(root, "scratch");
  await mkdir(source); await mkdir(scratch);
  const asset = async (href: string, mediaType: string, bytes: string) => {
    await writeFile(join(source, href), bytes);
    return { href, mediaType, byteLength: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const manifest = { format: "arke-publication", schemaVersion: 1, id: "urn:uuid:00000000-0000-4000-8000-000000000001", edition: "1", profile: "video", profileVersion: 1,
    title: "Film", language: "en", requires: ["video-v1", "webvtt-v1"],
    assets: { movie: await asset("movie.mp4", "video/mp4", "MOVIE"), cc: await asset("en.vtt", "text/vtt", vtt) },
    content: { video: "movie", textTracks: [{ asset: "cc", kind: "captions", label: "English", language: "en", default: true }] },
    build: { compiler: "test", compilerVersion: "1", dependencyFingerprint: "a".repeat(64) } };
  await writeFile(join(source, "publication.json"), JSON.stringify(manifest));
  return { root, source, scratch, manifest, asset };
}
const probe = async () => ({ duration: 2, mediaType: 'video/mp4; codecs="avc1"' });
for (const kind of ["directory", "zip"] as const) it(`pins ${kind} playback independently of source files and releases only its scratch`, async () => {
  const f = await fixture(); const source = kind === "zip" ? join(f.root, "movie.zip") : f.source;
  if (kind === "zip") await writePublicationZip(f.source, source);
  const opened = await openPublication(source, kind, f.scratch, probe);
  await rm(f.source, { recursive: true });
  assert.equal(await readFile(join(opened.directory, "movie.mp4"), "utf8"), "MOVIE");
  assert.equal(opened.manifest.title, "Film");
  await opened.dispose(); await opened.dispose(); assert.deepEqual(await readdir(f.scratch), []);
});
it("refuses semantically broken captions even when their hashes match, and cleans failed playback", async () => {
  const f = await fixture();
  f.manifest.assets.cc = await f.asset("en.vtt", "text/vtt", "WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nToo late\n");
  await writeFile(join(f.source, "publication.json"), JSON.stringify(f.manifest));
  await assert.rejects(openPublication(f.source, "directory", f.scratch, probe), /WebVTT/);
  assert.deepEqual(await readdir(f.scratch), []);
});
it("rejects malformed, reversed, unordered or non-inert caption blocks", () => {
  for (const text of [vtt.replace("WEBVTT", "WEBVTTBAD"), vtt.replace("00:00:01.000", "00:00:00.000"), vtt.replace("Hello", ""),
    "WEBVTT\n\nSTYLE\n::cue { color: red; }\n", vtt + "\n00:00:00.500 --> 00:00:01.500\nNext\n\n00:00:00.100 --> 00:00:01.500\nEarlier\n"]) {
    assert.throws(() => validatePublicationVtt(text, 2), /WebVTT/);
  }
  validatePublicationVtt(vtt, 2); validatePublicationVtt("WEBVTT\n\n", 2);
});
it("refuses codec probe failures and already-cancelled opens without retaining a package", async () => {
  const f = await fixture();
  await assert.rejects(openPublication(f.source, "directory", f.scratch, async () => { throw new Error("codec unsupported"); }), /codec/);
  await assert.rejects(openPublication(f.source, "directory", f.scratch, probe, { signal: AbortSignal.abort() }));
  assert.deepEqual(await readdir(f.scratch), []);
});

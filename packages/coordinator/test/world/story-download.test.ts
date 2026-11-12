import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { ZipFile } from "yazl";
import { cleanupStoryDownload, discardStoryDownload, downloadStory, inspectStoryDownload, type StoryDownload } from "../../src/world/story-download.js";
import { isStoryReleaseAuthoredPath, isStoryReleaseHistoryFile, isStoryReleaseLegacyChange, referencesStoryArtifact } from "../../src/world/story-release-history.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { installSampleWorld } from "../../src/world/sample-world.js";
import { tempDir } from "../tmp.js";
import { untilAsync } from "../wait.js";
import { FIXTURE_WORLD } from "./helpers.js";
import { containedWorldFilePath } from "../../src/world/contained-file.js";

async function archive(extra: Array<{ name: string; mode?: number }> = []) {
  const world = await readFile(join(FIXTURE_WORLD, "world.json"));
  const zip = new ZipFile(), chunks: Buffer[] = [];
  const done = (async () => { for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); })();
  zip.addBuffer(world, "world.json");
  for (const e of extra) zip.addBuffer(Buffer.from("x"), e.name, e.mode ? { mode: e.mode } : {});
  zip.end(); await done;
  const data = Buffer.concat(chunks);
  const source: StoryDownload = { url: "https://github.com/owner/repo/releases/download/story/story.zip", bytes: data.length,
    unpackedBytes: world.length + extra.length, sha256: createHash("sha256").update(data).digest("hex"), version: "test", summary: "Unfinished" };
  const fetcher: typeof fetch = async () => new Response(new Uint8Array(data));
  return { data, source, fetcher };
}

it("downloads, verifies and installs independent copies without replacing the first", async () => {
  const { source, fetcher } = await archive(), root = await tempDir("story-download-");
  const progress: string[] = [];
  const downloaded = await downloadStory(source, join(root, "downloads"), { signal: new AbortController().signal, fetch: fetcher, progress: p => progress.push(p) });
  const first = await installSampleWorld({ sourceDir: downloaded.directory, appRoot: root });
  const second = await installSampleWorld({ sourceDir: downloaded.directory, appRoot: root });
  assert.notEqual(first.worldId, second.worldId);
  assert.notEqual(first.slug, second.slug);
  assert.match(progress.at(-1)!, /independent copy/);
  await downloaded.dispose();
  assert.deepEqual(await readdir(join(root, "downloads")), []);
});

for (const kind of ["hash", "size", "expanded", "offline", "redirect", "aborted"] as const) it(`refuses ${kind} and removes all partial downloads`, async () => {
  const { source, fetcher } = await archive(), root = await tempDir("story-refusal-");
  const control = new AbortController();
  if (kind === "hash") source.sha256 = "0".repeat(64);
  if (kind === "size") source.bytes--;
  if (kind === "expanded") source.unpackedBytes--;
  if (kind === "aborted") control.abort();
  const request: typeof fetch = kind === "offline" ? async () => { throw Error("offline"); }
    : kind === "redirect" ? async () => new Response(null, { status: 302, headers: { location: "https://evil.example/archive" } }) : fetcher;
  await assert.rejects(downloadStory(source, root, { signal: control.signal, fetch: request }));
  assert.deepEqual(await readdir(root), []);
});

for (const entries of [
  [{ name: "WORLD.json" }],
  [{ name: "world.json/child" }],
  [{ name: "folder/a" }, { name: "Folder/b" }],
  [{ name: "CON.png" }],
  [{ name: "linked", mode: 0o120777 }],
]) it(`refuses unsafe archive paths: ${entries.map(e => e.name).join(", ")}`, async () => {
  const { source, fetcher } = await archive(entries), root = await tempDir("story-unsafe-");
  await assert.rejects(downloadStory(source, root, { signal: new AbortController().signal, fetch: fetcher }), /Unsafe|Colliding/);
  assert.deepEqual(await readdir(root), []);
});

it("follows only the release asset redirect without sending credentials", async () => {
  const { source, data } = await archive(), root = await tempDir("story-redirect-");
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, "manual"); assert.equal(init?.headers, undefined);
    if (calls++ === 0) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/test" } });
    assert.equal(String(url), "https://release-assets.githubusercontent.com/test");
    return new Response(new Uint8Array(data));
  };
  const result = await downloadStory(source, root, { signal: new AbortController().signal, fetch: request });
  await result.dispose(); assert.equal(calls, 2);
});

it("keeps authored versions while excluding operational and unselected history", () => {
  const selected = new Set(["novel"]);
  for (const p of ["bible/v1.md", "characters/maren/v2.md", "productions/novel/chapters/neap/v4.md", "productions/novel/story/v6.json"]) assert.equal(isStoryReleaseHistoryFile(p, selected), true, p);
  for (const track of ["story", "prose-style", "routing", "season", "narrative"]) assert.equal(isStoryReleaseHistoryFile(`productions/novel/${track}/v2.json`, selected), true, track);
  for (const track of ["chapters", "scenes", "episodes", "scripts"]) assert.equal(isStoryReleaseHistoryFile(`productions/novel/${track}/opening/v2.json`, selected), true, track);
  for (const p of ["bible/prepared/act.json", "bible/prepared/v1.json", "world/prepared/action.generation.json", "world/transcription/v1.json", "world/conversation-actions/v1.json", "productions/other/chapters/neap/v1.md", "productions/novel/prepared/v1.json", "../bible/v1.md"]) assert.equal(isStoryReleaseHistoryFile(p, selected), false, p);
});

it("retains scoped legacy activity without importing unrelated or operational records", () => {
  const selected = new Set(["novel"]);
  for (const entity of ["world", "canon/CANON-044", "characters/maren", "productions/novel", "productions/novel/chapters/old-name"]) assert.equal(isStoryReleaseLegacyChange(entity, selected), true, entity);
  for (const entity of [undefined, ".proposals/private", "productions/other", "series/other", "../world", "C:/outside"]) assert.equal(isStoryReleaseLegacyChange(entity, selected), false);
});

it("finds media in normal Markdown links, encoded names and JSON references", () => {
  for (const text of ["![portrait](artifacts/maren.png)", "[plate](<artifacts/maren.png>)", '{"file":"artifacts/maren.png"}']) assert.equal(referencesStoryArtifact(text, "maren.png"), true);
  assert.equal(referencesStoryArtifact("[plate](artifacts/wide%20view.png)", "wide view.png"), true);
  assert.equal(referencesStoryArtifact("ordinary prose", "maren.png"), false);
});

it("retains deleted authored-file audit records by namespace without admitting operational paths", () => {
  const selected = new Set(["novel"]);
  for (const p of ["productions/novel/scenes/deleted.json", "art-direction/record.json", "characters/retired.md", "bible.md"]) assert.equal(isStoryReleaseAuthoredPath(p, selected), true, p);
  for (const p of ["productions/other/scenes/deleted.json", "productions/novel/.sessions/private.json", ".history/bible/prepared/action.json", "characters/../private", "C:/outside", "characters\\outside", "artifacts/unrelated.png.json"]) assert.equal(isStoryReleaseAuthoredPath(p, selected), false, p);
});

it("rejects linked release artifact media and sidecars before reading or copying", async t => {
  const root = await tempDir("story-artifact-link-"), outside = join(await tempDir("story-outside-"), "private.txt");
  await mkdir(join(root, "artifacts")); await writeFile(outside, "outside world");
  for (const name of ["image.png", "image.png.json"]) {
    try { await symlink(outside, join(root, "artifacts", name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM" && process.platform === "win32") { t.skip("Windows symlink privilege unavailable"); return; } throw error; }
    await assert.rejects(containedWorldFilePath(root, `artifacts/${name}`), /path-invalid/);
  }
});

it("reports scratch cleanup failure separately from installation success", async () => {
  assert.equal(await cleanupStoryDownload({ async dispose() { throw Object.assign(Error("scanner lock"), { code: "EPERM" }); } }), false);
  assert.equal(await cleanupStoryDownload({ async dispose() {} }), true);
});

it("allows a progressing transfer to take longer than one hour", async t => {
  const { source, data } = await archive(), root = await tempDir("story-slow-");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let offset = 0;
  const request: typeof fetch = async () => new Response(new ReadableStream({ async pull(controller) {
    await nextTurn();
    if (offset === data.length) { controller.close(); return; }
    t.mock.timers.tick(120_000);
    const end = Math.min(data.length, offset + 8);
    controller.enqueue(new Uint8Array(data.subarray(offset, end))); offset = end;
  } }));
  const result = await downloadStory(source, root, { signal: new AbortController().signal, fetch: request });
  await result.dispose();
  assert.ok(Math.ceil(data.length / 8) * 120_000 > 3_600_000);
});

it("aborts and cleans a transfer that stops making progress", async t => {
  const { source } = await archive(), root = await tempDir("story-idle-");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered!: () => void;
  const called = new Promise<void>(r => { entered = r; });
  const request: typeof fetch = async () => { entered(); return new Response(new ReadableStream()); };
  const attempt = downloadStory(source, root, { signal: new AbortController().signal, fetch: request });
  const refused = assert.rejects(attempt, /abort|progress/i);
  await called; await nextTurn(); t.mock.timers.tick(180_001);
  await refused; assert.deepEqual(await readdir(root), []);
});

async function interruptDownload(source: StoryDownload, data: Buffer, root: string, network = false) {
  const offset = Math.floor(data.length / 2), control = new AbortController();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const request: typeof fetch = async () => new Response(new ReadableStream({ start(c) { stream = c; c.enqueue(new Uint8Array(data.subarray(0, offset))); } }));
  const failed = assert.rejects(downloadStory(source, root, { signal: control.signal, fetch: request }));
  const file = join(root, `story-${source.sha256}.part`);
  await untilAsync(async () => (await stat(file)).size === offset, "download prefix reached disk").catch(async error => { control.abort(); await failed; throw error; });
  assert.equal((await stat(file)).size, offset, "the prefix has reached disk before interruption");
  if (network) stream.error(new Error("connection lost")); else control.abort();
  await failed;
  assert.deepEqual(await readdir(root), [`story-${source.sha256}.part`], "only the resumable prefix remains, not extraction scratch");
  return { offset, file };
}

for (const network of [false, true]) it(`resumes a ${network ? "network interruption" : "cancelled download"} after restarting the downloader`, async () => {
  const { source, data } = await archive(), root = await tempDir("story-resume-");
  const { offset } = await interruptDownload(source, data, root, network);
  const status = await inspectStoryDownload(source, root);
  assert.equal(status.retainedBytes, offset); assert.ok(status.freeBytes! > 0);
  assert.equal(status.requiredBytes, source.bytes - offset + source.unpackedBytes * 2 + 64 * 1024 * 1024);
  const request: typeof fetch = async (_url, init) => {
    assert.deepEqual(init?.headers, { Range: `bytes=${offset}-` });
    return new Response(new Uint8Array(data.subarray(offset)), { status: 206, headers: { "content-range": `bytes ${offset}-${data.length - 1}/${data.length}`, "content-length": String(data.length - offset) } });
  };
  const result = await downloadStory(source, root, { signal: new AbortController().signal, fetch: request });
  assert.equal(JSON.parse(await readFile(join(result.directory, "world.json"), "utf8")).schemaVersion > 0, true);
  await result.dispose(); assert.deepEqual(await readdir(root), []);
});

it("starts over safely when the server ignores Range", async () => {
  const { source, data, fetcher } = await archive(), root = await tempDir("story-no-range-");
  await interruptDownload(source, data, root);
  const result = await downloadStory(source, root, { signal: new AbortController().signal, fetch: fetcher });
  await result.dispose(); assert.deepEqual(await readdir(root), []);
});

for (const mismatch of ["start", "end", "total", "length", "prefix"] as const) it(`discards invalid resumed ${mismatch} before extraction`, async () => {
  const { source, data } = await archive(), root = await tempDir("story-bad-resume-");
  const { offset, file } = await interruptDownload(source, data, root);
  if (mismatch === "prefix") await writeFile(file, Buffer.alloc(offset));
  const request: typeof fetch = async () => new Response(new Uint8Array(data.subarray(offset)), { status: 206, headers: {
    "content-range": `bytes ${offset + (mismatch === "start" ? 1 : 0)}-${data.length - (mismatch === "end" ? 2 : 1)}/${data.length + (mismatch === "total" ? 1 : 0)}`,
    "content-length": String(data.length - offset + (mismatch === "length" ? 1 : 0)),
  } });
  await assert.rejects(downloadStory(source, root, { signal: new AbortController().signal, fetch: request }), /range|size|integrity/);
  assert.deepEqual(await readdir(root), []);
});

it("never resumes a different release and removes only the selected release's retained data", async () => {
  const first = await archive(), second = await archive([{ name: "other.txt" }]), root = await tempDir("story-release-change-");
  const { file } = await interruptDownload(first.source, first.data, root);
  const request: typeof fetch = async (_url, init) => { assert.equal(init?.headers, undefined); return second.fetcher(_url, init); };
  const result = await downloadStory(second.source, root, { signal: new AbortController().signal, fetch: request });
  await result.dispose(); assert.ok((await stat(file)).size > 0);
  await writeFile(join(root, "user-file.txt"), "keep");
  await discardStoryDownload(first.source, root);
  assert.deepEqual(await readdir(root), ["user-file.txt"]);
});

it("reuses a complete retained archive only after hashing it again", async () => {
  const { source, data } = await archive(), root = await tempDir("story-complete-cache-");
  const file = join(root, `story-${source.sha256}.part`);
  await writeFile(file, data);
  const noNetwork: typeof fetch = async () => { throw Error("a complete archive needs no transfer"); };
  const result = await downloadStory(source, root, { signal: new AbortController().signal, fetch: noNetwork });
  await result.dispose();
  await writeFile(file, Buffer.alloc(data.length));
  await assert.rejects(downloadStory(source, root, { signal: new AbortController().signal, fetch: noNetwork }), /integrity/);
  assert.deepEqual(await readdir(root), []);
});

it("refuses insufficient disk space before making a request", async () => {
  const { source } = await archive(), root = await tempDir("story-low-space-");
  source.unpackedBytes = 1_000_000_000_000_000;
  let called = false;
  await assert.rejects(downloadStory(source, root, { signal: new AbortController().signal, fetch: async () => { called = true; throw Error("must not fetch"); } }), /Not enough disk space/);
  assert.equal(called, false); assert.deepEqual(await readdir(root), []);
});

it("reports invalid retained data for removal without counting it toward the download", async () => {
  const { source } = await archive(), root = await tempDir("story-invalid-cache-");
  await writeFile(join(root, `story-${source.sha256}.part`), Buffer.alloc(source.bytes + 1));
  const status = await inspectStoryDownload(source, root);
  assert.equal(status.hasRetainedData, true); assert.equal(status.retainedBytes, 0);
  await assert.rejects(downloadStory(source, root, { signal: new AbortController().signal }), /Remove downloaded data/);
  await discardStoryDownload(source, root);
  assert.equal((await inspectStoryDownload(source, root)).hasRetainedData, false);
});

async function multipartArchive() {
  const { source: single, data } = await archive();
  const size = Math.ceil(data.length / 3), buffers = [data.subarray(0, size), data.subarray(size, size * 2), data.subarray(size * 2)] as const;
  const { url, ...metadata } = single;
  const source: StoryDownload & { parts: NonNullable<StoryDownload["parts"]> } = { ...metadata, parts: buffers.map((b, i) => ({
    url: `${url}.part-${i + 1}`, bytes: b.length, sha256: createHash("sha256").update(b).digest("hex"),
  })) };
  const calls: Array<{ part: number; offset: number }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const part = source.parts.findIndex(p => p.url === String(url));
    const bytes = buffers[part]; assert.ok(bytes);
    const range = new Headers(init?.headers).get("range"), offset = range ? Number(range.match(/^bytes=(\d+)-$/)![1]) : 0;
    calls.push({ part, offset });
    return new Response(new Uint8Array(bytes.subarray(offset)), { status: offset ? 206 : 200, headers: {
      "content-length": String(bytes.length - offset),
      ...(offset ? { "content-range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
    } });
  };
  return { source, data, buffers, calls, fetcher };
}

for (const position of ["empty", "boundary", "partial", "complete"] as const) it(`resumes ordered story parts from a ${position} cache with aggregate progress and space`, async () => {
  const { source, data, buffers, calls, fetcher } = await multipartArchive(), root = await tempDir("story-parts-");
  const retained = position === "empty" ? 0 : position === "boundary" ? buffers[0].length : position === "partial" ? buffers[0].length + 7 : data.length;
  if (retained) await writeFile(join(root, `story-${source.sha256}.part`), data.subarray(0, retained));
  assert.equal((await inspectStoryDownload(source, root)).requiredBytes, source.bytes - retained + source.unpackedBytes * 2 + 64 * 1024 * 1024);
  const progress: string[] = [];
  const result = await downloadStory(source, root, { signal: new AbortController().signal, fetch: fetcher, progress: p => progress.push(p) });
  assert.deepEqual(calls, position === "complete" ? [] : position === "empty" ? [{ part: 0, offset: 0 }, { part: 1, offset: 0 }, { part: 2, offset: 0 }] : [{ part: 1, offset: position === "partial" ? 7 : 0 }, { part: 2, offset: 0 }]);
  assert.deepEqual(await readFile(join(result.directory, "world.json")), await readFile(join(FIXTURE_WORLD, "world.json")));
  if (position !== "complete") assert.ok(progress.includes("Downloading The Undersong… 100%"));
  await result.dispose(); assert.deepEqual(await readdir(root), []);
});

it("replaces only the resumed part when the release host ignores Range", async () => {
  const { source, data, buffers, fetcher } = await multipartArchive(), root = await tempDir("story-part-no-range-");
  await writeFile(join(root, `story-${source.sha256}.part`), data.subarray(0, buffers[0].length + 7));
  const request: typeof fetch = async (url, init) => {
    if (String(url) === source.parts[1]!.url) { assert.equal(new Headers(init?.headers).get("range"), "bytes=7-"); return new Response(new Uint8Array(buffers[1])); }
    return fetcher(url, init);
  };
  const result = await downloadStory(source, root, { signal: new AbortController().signal, fetch: request });
  await result.dispose(); assert.deepEqual(await readdir(root), []);
});

for (const mismatch of ["cached-part", "received-part", "whole-digest", "oversized-part", "range", "redirect"] as const) it(`discards a multipart archive with invalid ${mismatch}`, async () => {
  const { source, data, buffers, fetcher } = await multipartArchive(), root = await tempDir("story-part-invalid-");
  if (mismatch === "whole-digest") source.sha256 = "0".repeat(64);
  if (mismatch === "cached-part") await writeFile(join(root, `story-${source.sha256}.part`), Buffer.alloc(buffers[0].length));
  if (mismatch === "range") await writeFile(join(root, `story-${source.sha256}.part`), data.subarray(0, buffers[0].length + 7));
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    if (mismatch === "received-part") return new Response(new Uint8Array(Buffer.alloc(buffers[0].length)));
    if (mismatch === "oversized-part") return new Response(new Uint8Array(Buffer.alloc(buffers[0].length + 1)));
    if (mismatch === "range") return new Response(new Uint8Array(buffers[1].subarray(7)), { status: 206, headers: { "content-range": `bytes ${buffers[0].length + 7}-${data.length - 1}/${data.length}` } });
    if (mismatch === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.example/part" } });
    return fetcher(url, init);
  };
  await assert.rejects(downloadStory(source, root, { signal: new AbortController().signal, fetch: request }), /integrity|size|range|release host/);
  if (mismatch === "cached-part") assert.equal(calls, 0, "verify completed cached parts before spending another request");
  assert.deepEqual(await readdir(root), []);
});

for (const interruption of ["short", "cancel", "network"] as const) it(`retains and resumes a ${interruption} second part without redownloading the first`, async t => {
  const { source, data, buffers, fetcher, calls } = await multipartArchive(), root = await tempDir("story-part-interrupted-");
  const control = new AbortController(), file = join(root, `story-${source.sha256}.part`);
  t.after(() => control.abort());
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const request: typeof fetch = async (url, init) => {
    if (String(url) !== source.parts[1]!.url) return fetcher(url, init);
    return new Response(new ReadableStream({ start(c) { stream = c; c.enqueue(new Uint8Array(buffers[1].subarray(0, 7))); if (interruption === "short") c.close(); } }));
  };
  const failed = assert.rejects(downloadStory(source, root, { signal: control.signal, fetch: request }));
  const retained = buffers[0].length + 7;
  await untilAsync(async () => (await stat(file)).size === retained, "second-part prefix reached disk");
  assert.equal((await stat(file)).size, retained);
  if (interruption === "cancel") control.abort();
  if (interruption === "network") stream.error(new Error("connection lost"));
  await failed;
  assert.deepEqual(await readFile(file), data.subarray(0, retained));
  calls.length = 0;
  const result = await downloadStory(source, root, { signal: new AbortController().signal, fetch: fetcher });
  assert.deepEqual(calls, [{ part: 1, offset: 7 }, { part: 2, offset: 0 }]);
  await result.dispose();
});

it("validates every pinned part before creating scratch or making requests", async () => {
  const { source } = await multipartArchive(), root = await tempDir("story-part-metadata-");
  const bad = [
    { parts: [] }, { parts: null }, { parts: Array(1001).fill(source.parts[0]) }, { url: source.parts[0]!.url },
    ...[0, -1, 1.5, 1024 ** 3 + 1, Number.MAX_SAFE_INTEGER].map(bytes => ({ parts: [{ ...source.parts[0], bytes }] })),
    { parts: source.parts.slice(1) },
    ...["http://github.com/part", "https://evil.example/part", "https://user:secret@github.com/part"].map(url => ({ parts: [...source.parts.slice(0, 2), { ...source.parts[2], url }] })),
    { parts: [{ ...source.parts[0], sha256: "invalid" }, ...source.parts.slice(1)] },
  ];
  for (const change of bad) {
    let called = false;
    await assert.rejects(downloadStory({ ...source, ...change } as StoryDownload, root, { signal: new AbortController().signal, fetch: async () => { called = true; throw Error("unexpected request"); } }));
    assert.equal(called, false); assert.deepEqual(await readdir(root), []);
  }
});

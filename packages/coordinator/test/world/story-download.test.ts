import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { ZipFile } from "yazl";
import { cleanupStoryDownload, downloadStory, type StoryDownload } from "../../src/world/story-download.js";
import { isStoryReleaseAuthoredPath, isStoryReleaseHistoryFile, isStoryReleaseLegacyChange, referencesStoryArtifact } from "../../src/world/story-release-history.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { installSampleWorld } from "../../src/world/sample-world.js";
import { tempDir } from "../tmp.js";
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

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { ZipFile } from "yazl";
import { downloadStory, type StoryDownload } from "../../src/world/story-download.js";
import { installSampleWorld } from "../../src/world/sample-world.js";
import { tempDir } from "../tmp.js";
import { FIXTURE_WORLD } from "./helpers.js";

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

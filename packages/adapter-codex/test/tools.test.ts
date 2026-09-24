import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { createServer } from "node:http";
import { confinementFor } from "@arke-studio/contracts";
import { captureRootIdentity, confinedTarget } from "../src/confined-files.js";
import { discoverWorldTools, executeTool, resolveRoot, toolsFor, worldRequest, type ToolSession } from "../src/tools.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZklEQVR42u3QQREAAAQAMEm89T/9yOHssQKLzprPQoAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECLhvAVR6kdJApJA8AAAAAElFTkSuQmCC", "base64");
async function fixture(readOnly = false) {
  const base = await mkdtemp(join(tmpdir(), "arke-codex-tools-")); const root = join(base, "proposal");
  await mkdir(root); await writeFile(join(base, "secret.txt"), "SECRET_MUST_NOT_LEAK");
  const canonical = await resolveRoot(root);
  const session: ToolSession = { root: canonical, rootIdentity: await captureRootIdentity(canonical), confinement: confinementFor({ readOnly }), worldTools: new Map() };
  return { base, root, session, run: (name: string, args: Record<string, unknown>) => executeTool(session, name, args, new AbortController().signal) };
}

test("host tools write and edit contained files, then return actual image content", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.run("write", { path: "nested/story.txt", content: "Hello stage" });
  await f.run("edit", { path: "nested/story.txt", oldText: "stage", newText: "world" });
  assert.equal(await readFile(join(f.root, "nested/story.txt"), "utf8"), "Hello world");
  await assert.rejects(f.run("edit", { path: "nested/story.txt", oldText: "absent", newText: "bad" }), /exactly one/);
  await writeFile(join(f.root, "frame.png"), png);
  const image = await f.run("read", { path: "frame.png" });
  assert.equal(image.summary, "read frame.png"); assert.equal(image.result.contentItems[1]?.type, "inputImage");
  assert.match(JSON.stringify(image.result), /data:image\/png;base64,/);
  const search = await f.run("search", { query: "world" });
  assert.ok(search.result.contentItems[0]?.type === "inputText");
  assert.match(search.result.contentItems[0].text, /nested[\\/]story.txt:1/);
});

test("read-only sessions cannot edit, unknown arguments and unknown tools are refused", async t => {
  const f = await fixture(true); t.after(() => rm(f.base, { recursive: true, force: true }));
  assert.deepEqual(toolsFor(f.session).map(tool => tool.name), ["read", "list", "search"]);
  await assert.rejects(f.run("write", { path: "new.txt", content: "bad" }), /confinement/);
  await assert.rejects(f.run("read", { path: "a", cwd: f.base }), /confinement/);
  await assert.rejects(f.run("exec", { command: "echo bad" }), /confinement/);
});

test("corrupt PNG data and text-only model image reads never produce a successful image receipt", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const corrupt = Buffer.from(png); corrupt[40] = (corrupt[40]! + 1) % 255;
  await writeFile(join(f.root, "bad.png"), corrupt);
  await assert.rejects(f.run("read", { path: "bad.png" }), /corrupt/);
  await writeFile(join(f.root, "frame.png"), png); f.session.inputModalities = ["text"];
  await assert.rejects(f.run("read", { path: "frame.png" }), /does not accept image/);
});

test("text search skips truncated images and retains matches in unrelated files", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await writeFile(join(f.root, "before.txt"), "The actor waits at the door.");
  // No NUL bytes: this must reach image classification, not the generic binary shortcut.
  await writeFile(join(f.root, "broken.png"), Buffer.concat([png.subarray(0, 8), Buffer.from("actor")]));
  await writeFile(join(f.root, "frame.jpg"), Buffer.from([255, 216, 255, ...Buffer.from("actor")]));
  await writeFile(join(f.root, "later.txt"), "The actor crosses the room.");
  const result = await f.run("search", { query: "actor" });
  assert.equal(result.result.success, true);
  assert.deepEqual(result.result.contentItems, [{ type: "inputText", text: "before.txt:1: The actor waits at the door.\nlater.txt:1: The actor crosses the room." }]);
  await assert.rejects(f.run("read", { path: "broken.png" }), /corrupt/);
});

test("parallel edits retain both changes and a cancelled queued write changes no file", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await writeFile(join(f.root, "draft.txt"), "alpha beta");
  await Promise.all([
    f.run("edit", { path: "draft.txt", oldText: "alpha", newText: "ALPHA" }),
    f.run("edit", { path: "draft.txt", oldText: "beta", newText: "BETA" }),
  ]);
  assert.equal(await readFile(join(f.root, "draft.txt"), "utf8"), "ALPHA BETA");
  const abort = new AbortController();
  const first = f.run("write", { path: "first.txt", content: "first" });
  const cancelled = executeTool(f.session, "write", { path: "draft.txt", content: "should not replace" }, abort.signal);
  abort.abort(); await assert.rejects(cancelled); await first;
  assert.equal(await readFile(join(f.root, "draft.txt"), "utf8"), "ALPHA BETA");
});

test("text edits and writes refuse image and binary bytes without changing the file", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  // A complete 1x1 JPEG, including its JFIF metadata and encoded image data.
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==", "base64");
  for (const [name, bytes, oldText] of [
    ["image.png", png, "IHDR"],
    ["image.jpg", jpeg, "JFIF"],
    ["truncated.png", Buffer.concat([png.subarray(0, 8), Buffer.from("target")]), "target"],
    ["truncated.gif", Buffer.from("GIF89a target"), "target"],
    ["null-bytes.bin", Buffer.from("before\0target after"), "target"],
    ["invalid-utf8.bin", Buffer.from([0xc0, 0xaf, ...Buffer.from("target")]), "target"],
  ] as const) {
    await writeFile(join(f.root, name), bytes);
    await assert.rejects(f.run("edit", { path: name, oldText, newText: "changed" }), /Only UTF-8 text files/, name);
    assert.deepEqual(await readFile(join(f.root, name)), bytes, `${name} remains byte-identical after edit refusal`);
    await assert.rejects(f.run("write", { path: name, content: "replacement text" }), /Only UTF-8 text files/, name);
    assert.deepEqual(await readFile(join(f.root, name)), bytes, `${name} remains byte-identical after write refusal`);
  }
});

test("text edits and replacements preserve valid Unicode, a BOM and line endings", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const original = "\ufeffcafé 猫 👩‍🚀 \ufffd\t\r\nThe stage awaits.\r\n";
  await writeFile(join(f.root, "unicode.txt"), original);
  const result = await f.run("edit", { path: "unicode.txt", oldText: "猫", newText: "犬" });
  assert.equal(result.result.success, true);
  assert.deepEqual(await readFile(join(f.root, "unicode.txt")), Buffer.from(original.replace("猫", "犬")));
  const replacement = "\ufeffA café scene with 猫 👩‍🚀 \ufffd\t\r\nThe curtain falls.\r\n";
  assert.equal((await f.run("write", { path: "unicode.txt", content: replacement })).result.success, true);
  assert.deepEqual(await readFile(join(f.root, "unicode.txt")), Buffer.from(replacement));
});

test("outside paths, sibling prefix collisions, symlinks, nested search links and hardlinks do not expose contents", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await assert.rejects(f.run("read", { path: "../secret.txt" }), /confinement/);
  await assert.rejects(f.run("write", { path: "../new.txt", content: "bad" }), /confinement/);
  const sibling = join(f.base, "proposal-extra"); await mkdir(sibling); await writeFile(join(sibling, "secret.txt"), "SECRET_MUST_NOT_LEAK");
  assert.throws(() => confinedTarget(f.session.root, join(sibling, "secret.txt")), /confinement/);
  await symlink(sibling, join(f.root, "external"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.run("read", { path: "external/secret.txt" }), /confinement/);
  await assert.rejects(f.run("write", { path: "external/new.txt", content: "bad" }), /confinement/);
  assert.doesNotMatch(JSON.stringify(await f.run("search", { query: "SECRET" })), /SECRET_MUST_NOT_LEAK/);
  await link(join(f.base, "secret.txt"), join(f.root, "hard.txt"));
  await assert.rejects(f.run("read", { path: "hard.txt" }), /confinement/);
  await assert.rejects(f.run("write", { path: "hard.txt", content: "bad" }), /confinement/);
  assert.equal(await readFile(join(f.base, "secret.txt"), "utf8"), "SECRET_MUST_NOT_LEAK");
});

test("Windows extended paths retain the same containment boundary", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await writeFile(join(f.root, "inside.txt"), "inside");
  // Codex receives the canonical session cwd. Windows CI's temp directory can instead use
  // an 8.3 alias, which is intentionally not another spelling admitted by the lexical gate.
  const read = await f.run("read", { path: toNamespacedPath(join(f.session.root, "inside.txt")) });
  assert.deepEqual(read.result.contentItems, [{ type: "inputText", text: "inside" }]);
  await assert.rejects(f.run("read", { path: toNamespacedPath(join(f.base, "secret.txt")) }), /confinement/);
});

test("world tools retain exact lease, citation blocks and research policy; closed lease never falls back", async t => {
  const f = await fixture(true); t.after(() => rm(f.base, { recursive: true, force: true }));
  const paths: string[] = []; let expired = false;
  const server = createServer(async (req, res) => {
    paths.push(req.url!); let raw = ""; for await (const part of req) raw += part;
    if (expired) { res.writeHead(404).end(); return; }
    const rpc = JSON.parse(raw);
    const result = rpc.method === "tools/list" ? { tools: ["get_sheet", "fetch_url"].map(name => ({ name, description: name, inputSchema: { type: "object", properties: { id: { type: "string" } } } })) } : { content: [{ type: "text", text: "sheet body" }, { type: "text", text: '{"checkReceiptId":"check_123"}' }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const path = `/mcp/${"a".repeat(64)}`; f.session.worldQueryUrl = `http://127.0.0.1:${address.port}${path}`;
  await discoverWorldTools(f.session);
  assert.equal(f.session.worldTools.has("world_fetch_url"), false);
  const result = await f.run("world_get_sheet", { id: "maren" });
  assert.equal(result.result.contentItems.length, 2); assert.match(JSON.stringify(result), /check_123/);
  expired = true; await assert.rejects(f.run("world_get_sheet", { id: "maren" }), /no longer available/);
  assert.ok(paths.every(url => url === path));
  await assert.rejects(worldRequest("https://example.com/mcp", "tools/list", {}), /confinement/);
});

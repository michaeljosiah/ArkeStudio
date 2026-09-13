import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { confinementFor } from "@arke-studio/contracts";
import { confinedPath, discoverWorldTools, executeTool, resolveRoot, toolsFor, worldRequest, type ToolSession } from "../src/tools.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZklEQVR42u3QQREAAAQAMEm89T/9yOHssQKLzprPQoAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECLhvAVR6kdJApJA8AAAAAElFTkSuQmCC", "base64");
async function fixture(readOnly = false) {
  const base = await mkdtemp(join(tmpdir(), "arke-codex-tools-")); const root = join(base, "proposal");
  await mkdir(root); await writeFile(join(base, "secret.txt"), "SECRET_MUST_NOT_LEAK");
  const session: ToolSession = { root: await resolveRoot(root), confinement: confinementFor({ readOnly }), worldTools: new Map() };
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

test("outside paths, sibling prefix collisions, symlinks, nested search links and hardlinks do not expose contents", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await assert.rejects(f.run("read", { path: "../secret.txt" }), /confinement/);
  await assert.rejects(f.run("write", { path: "../new.txt", content: "bad" }), /confinement/);
  const sibling = join(f.base, "proposal-extra"); await mkdir(sibling); await writeFile(join(sibling, "secret.txt"), "SECRET_MUST_NOT_LEAK");
  await assert.rejects(confinedPath(f.session.root, join(sibling, "secret.txt")), /confinement/);
  await symlink(sibling, join(f.root, "external"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.run("read", { path: "external/secret.txt" }), /confinement/);
  await assert.rejects(f.run("write", { path: "external/new.txt", content: "bad" }), /confinement/);
  assert.doesNotMatch(JSON.stringify(await f.run("search", { query: "SECRET" })), /SECRET_MUST_NOT_LEAK/);
  await link(join(f.base, "secret.txt"), join(f.root, "hard.txt"));
  await assert.rejects(f.run("read", { path: "hard.txt" }), /confinement/);
  await assert.rejects(f.run("write", { path: "hard.txt", content: "bad" }), /confinement/);
  assert.equal(await readFile(join(f.base, "secret.txt"), "utf8"), "SECRET_MUST_NOT_LEAK");
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

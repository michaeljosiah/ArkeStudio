import assert from "node:assert/strict";
import { once } from "node:events";
import { it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { FrameSchema, ulid, type ClientMessage, type DomainEvent, type Frame } from "@arke-studio/contracts";
import { StudioServer, type StudioServerApplication } from "../src/studio-server.js";
import { createNodeStudioHost } from "../src/node-studio-host.js";
import { writeServerSession } from "../src/server-session.js";
import { emptyClientState } from "./client-state.js";
import { makeTempRoot, WORLD_ID } from "./world/helpers.js";

const auth = { token: "a".repeat(64), allowedOrigins: ["http://localhost:5173"] };

async function connect(port: number, token = auth.token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "http://localhost:5173" });
  const frames: Frame[] = [];
  const notices = new Set<() => void>();
  socket.on("message", data => { frames.push(FrameSchema.parse(JSON.parse(String(data)))); for (const notify of notices) notify(); });
  await once(socket, "open");
  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
  const wait = async (predicate: (frame: Frame) => boolean) => {
    if (frames.some(predicate)) return frames.find(predicate)!;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => { notices.delete(check); reject(new Error("No matching server frame.")); }, 10000);
      const check = () => {
        const frame = frames.find(predicate);
        if (frame) { clearTimeout(timer); notices.delete(check); resolve(frame); }
      };
      notices.add(check); check();
    });
  };
  const event = async <K extends DomainEvent["type"]>(type: K, requestId?: string) => {
    const frame = await wait(frame => frame.kind === "event" && frame.event.type === type &&
      (requestId === undefined || ("requestId" in frame.event && frame.event.requestId === requestId)));
    return (frame as Extract<Frame, { kind: "event" }>).event as Extract<DomainEvent, { type: K }>;
  };
  send({ kind: "hello", token });
  return { socket, frames, send, wait, event };
}

it("the Node host serves authenticated prose editing, reconnect and restart without Electron", async t => {
  const { root } = await makeTempRoot();
  const credentials = join(root, "credentials.dev.dat");
  await writeFile(credentials, "Keep existing credentials untouched.");
  let host = await createNodeStudioHost({ appRoot: root, appVersion: "test", adapter: null, transportAuth: auth });
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await host.server.stop(); });
  let session = await host.server.start();
  const denied = await connect(session.port, "b".repeat(64)); sockets.push(denied.socket);
  const [code] = await once(denied.socket, "close");
  assert.equal(code, 1008); assert.equal(denied.frames.length, 0);

  const client = await connect(session.port); sockets.push(client.socket);
  await client.wait(frame => frame.kind === "snapshot");
  client.send({ kind: "open-world", worldId: WORLD_ID });
  await client.event("world.opened");
  const requestId = ulid();
  client.send({ kind: "create-production", worldId: WORLD_ID, requestId, title: "Server story", format: "story" });
  const production = await client.event("production.create-result", requestId);
  assert.equal(production.disposition, "created"); assert.ok(production.slug);
  const chapterRequest = ulid();
  client.send({ kind: "create-chapter", worldId: WORLD_ID, productionId: production.slug, requestId: chapterRequest, title: "A beginning", order: 1 });
  const created = await client.event("chapter.create-result", chapterRequest);
  assert.equal(created.disposition, "created"); assert.ok(created.chapterId);
  const openRequest = ulid();
  client.send({ kind: "open-chapter", worldId: WORLD_ID, productionId: production.slug, chapterId: created.chapterId, requestId: openRequest });
  const chapter = await client.event("chapter.open-result", openRequest);
  assert.ok(chapter.hash);
  const saveRequest = ulid();
  client.send({ kind: "save-chapter", worldId: WORLD_ID, productionId: production.slug, chapterFile: created.chapterId,
    requestId: saveRequest, baseHash: chapter.hash, body: "A story saved through the standalone host." });
  const saved = await client.event("chapter.save-result", saveRequest);
  assert.equal(saved.disposition, "saved");
  client.send({ kind: "export-manuscript", worldId: WORLD_ID, productionId: production.slug, format: "docx" });
  const exported = await client.wait(frame => frame.kind === "event" && frame.event.type === "export.progress" &&
    frame.event.productionId === production.slug && ["done", "failed"].includes(frame.event.status));
  assert.equal(exported.kind, "event");
  if (exported.kind !== "event" || exported.event.type !== "export.progress") throw new Error("Missing export.");
  assert.equal(exported.event.status, "done", exported.event.error ?? "");
  assert.ok(exported.event.output);
  const url = `http://127.0.0.1:${session.port}/media/the-undersong/${exported.event.output}`;
  assert.equal((await fetch(url)).status, 401);
  const download = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}` } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString(), "PK");
  const pickerRequest = ulid();
  client.send({ kind: "pick-manuscript", worldId: WORLD_ID, productionId: production.slug, requestId: pickerRequest });
  const picker = await client.event("manuscript.read-result", pickerRequest);
  assert.match(picker.reason ?? "", /desktop app/);
  const reconnected = await connect(session.port); sockets.push(reconnected.socket);
  const snapshot = await reconnected.wait(frame => frame.kind === "snapshot");
  assert.equal(snapshot.seq, 1);
  assert.equal((await reconnected.event("export.progress")).output, exported.event.output);
  for (const socket of sockets) socket.terminate();
  await host.server.stop();
  host = await createNodeStudioHost({ appRoot: root, appVersion: "test", adapter: null, transportAuth: auth });
  session = await host.server.start();
  const reopened = await connect(session.port); sockets.push(reopened.socket);
  await reopened.wait(frame => frame.kind === "snapshot");
  reopened.send({ kind: "open-world", worldId: WORLD_ID }); await reopened.event("world.opened");
  const restoredExport = await reopened.event("export.progress");
  assert.equal(restoredExport.status, "done");
  assert.equal(restoredExport.output, exported.event.output);
  const restoredDownload = await fetch(`http://127.0.0.1:${session.port}/media/the-undersong/${restoredExport.output}`,
    { headers: { Authorization: `Bearer ${auth.token}` } });
  assert.equal(restoredDownload.status, 200);
  assert.equal(Buffer.from(await restoredDownload.arrayBuffer()).subarray(0, 2).toString(), "PK");
  const rereadRequest = ulid();
  reopened.send({ kind: "open-chapter", worldId: WORLD_ID, productionId: production.slug, chapterId: created.chapterId, requestId: rereadRequest });
  const reread = await reopened.event("chapter.open-result", rereadRequest);
  assert.equal(reread.body?.trim(), "A story saved through the standalone host.");
  assert.equal(reread.hash, saved.hash);
  assert.equal(await readFile(credentials, "utf8"), "Keep existing credentials untouched.");
});

function application(overrides: Partial<StudioServerApplication> = {}): StudioServerApplication {
  return { getSnapshot: () => emptyClientState(), attachTransport() {}, registerSecret() {},
    async start() {}, async stop(connectionsClosed) { await connectionsClosed; }, ...overrides };
}

it("shutdown during initialization waits for startup and never opens admission afterward", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let stopped = false;
  const server = new StudioServer(application({ start: () => gate, async stop(closed) { await closed; stopped = true; } }));
  const starting = server.start();
  const refused = assert.rejects(starting, /stopping/);
  const stopping = server.stop();
  assert.equal(stopped, false);
  release(); await refused; await stopping;
  assert.equal(stopped, true);
  await assert.rejects(server.start(), /already started or stopped/);
});

it("failed host cleanup can retry while new admission stays closed", async () => {
  let attempts = 0;
  const server = new StudioServer(application({ async stop(closed) { await closed; if (++attempts === 1) throw new Error("Save unavailable"); } }));
  await server.start();
  await assert.rejects(server.stop(), /Save unavailable/);
  await assert.rejects(server.start(), /already started or stopped/);
  await server.stop(); assert.equal(attempts, 2);
});

it("an occupied port rejects startup and drains the failed host", async t => {
  const first = new StudioServer(application(), auth);
  let cleaned = false;
  const second = new StudioServer(application({ async stop(closed) { await closed; cleaned = true; } }), auth);
  t.after(async () => { await second.stop(); await first.stop(); });
  const session = await first.start();
  await assert.rejects(second.start(session.port), /EADDRINUSE/);
  assert.equal(cleaned, true);
  const client = await connect(session.port);
  try { await client.wait(frame => frame.kind === "snapshot"); }
  finally { client.socket.terminate(); }
});

it("private browser handoff replaces an expired session without publishing it in application state", async () => {
  const { root } = await makeTempRoot();
  const path = join(root, ".dev", "transport-8791.json");
  await writeServerSession(path, { port: 8791, token: auth.token });
  await writeServerSession(path, { port: 8791, token: "b".repeat(64) });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { port: 8791, token: "b".repeat(64) });
});

it("manuscript downloads remain confined to exports", async t => {
  const { root, worldDir } = await makeTempRoot();
  const host = await createNodeStudioHost({ appRoot: root, appVersion: "test", adapter: null, transportAuth: auth });
  t.after(() => host.server.stop());
  const session = await host.server.start();
  await mkdir(join(worldDir, "exports"), { recursive: true });
  await writeFile(join(worldDir, "exports", "book.epub"), "PK fixture");
  await writeFile(join(worldDir, "private.docx"), "private document");
  const get = (path: string) => fetch(`http://127.0.0.1:${session.port}/media/the-undersong/${path}`,
    { headers: { Authorization: `Bearer ${auth.token}` } });
  const allowed = await get("exports/book.epub");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("content-type"), "application/epub+zip");
  await allowed.arrayBuffer();
  assert.equal((await get("private.docx")).status, 404);
});

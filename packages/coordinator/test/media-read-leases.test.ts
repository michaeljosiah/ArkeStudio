import assert from "node:assert/strict";
import { once } from "node:events";
import { renameSync, writeFileSync } from "node:fs";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
import { it } from "node:test";
import { Transport } from "../src/transport.js";
import { emptyClientState } from "./client-state.js";
import { tempDir } from "./tmp.js";
import { until } from "./wait.js";

const token = "c".repeat(64);
const auth = { token, allowedOrigins: ["null"] };

it("streams the same opened file whose size was measured when its path is replaced", async t => {
  const root = await tempDir("arke-media-replaced-");
  const file = join(root, "preview.wav"); await writeFile(file, "RIFF-original");
  const probe = await open(file, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalStream = prototype.createReadStream; await probe.close();
  t.mock.method(prototype, "createReadStream", function(this: FileHandle, ...args: Parameters<FileHandle["createReadStream"]>) {
    renameSync(file, join(root, "retained.wav"));
    writeFileSync(file, "replacement-with-different-length");
    return originalStream.apply(this, args);
  });
  let releases = 0;
  const transport = new Transport({ auth, getSnapshot: () => emptyClientState(), serveFile: async () => ({
    path: file, contentType: "audio/wav", release: () => { releases++; },
  }) });
  const port = await transport.start(); t.after(() => transport.stop());
  const response = await fetch(`http://127.0.0.1:${port}/replaced?token=${token}`);
  assert.equal(response.headers.get("content-length"), "13");
  assert.equal(await response.text(), "RIFF-original");
  await until(() => releases === 1, "original descriptor lease to settle", 5000);
});

it("releases media ownership once after full/ranged reads, invalid ranges and open failures", async t => {
  const root = await tempDir("arke-media-leases-");
  const file = join(root, "preview.wav");
  await writeFile(file, "RIFF0123456789");
  const acquired: string[] = [], released: string[] = [];
  const transport = new Transport({ auth, getSnapshot: () => emptyClientState(), serveFile: async path => {
    acquired.push(path);
    return { path: path === "/missing" ? join(root, "absent") : file, contentType: "audio/wav", release: () => released.push(path) };
  } });
  const port = await transport.start(); t.after(() => transport.stop());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + "/refused")).status, 401);
  assert.equal(acquired.length, 0, "authentication precedes acquisition");
  for (const [path, range, status, text] of [["/whole", "", 200, "RIFF0123456789"], ["/range", "bytes=0-3", 206, "RIFF"],
    ["/invalid", "bytes=999-", 416, ""], ["/missing", "", 404, ""]] as const) {
    const response = await fetch(base + path, { headers: { Authorization: `Bearer ${token}`, ...(range ? { Range: range } : {}) } });
    assert.equal(response.status, status); assert.equal(await response.text(), text);
    await until(() => released.includes(path), "media lease to settle after its read", 5000);
  }
  assert.deepEqual(released, acquired);
});

it("keeps an unfinished media resolver leased through disconnect and releases its late result", async t => {
  const root = await tempDir("arke-media-pending-");
  const file = join(root, "preview.wav"); await writeFile(file, "RIFF");
  let resolve!: (value: { path: string; contentType: string; release(): void }) => void;
  let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  let releases = 0;
  const transport = new Transport({ auth, getSnapshot: () => emptyClientState(), serveFile: async () => {
    entered(); return new Promise(done => { resolve = done; });
  } });
  const port = await transport.start(); t.after(() => transport.stop());
  const request = get(`http://127.0.0.1:${port}/pending?token=${token}`);
  request.on("error", () => {}); t.after(() => request.destroy());
  await started;
  const closed = new Promise<void>(done => request.once("close", done)); request.destroy(); await closed;
  await transport.stop();
  assert.equal(releases, 0, "disconnect does not claim the pending owner settled");
  resolve({ path: file, contentType: "audio/wav", release: () => { releases++; } });
  await until(() => releases === 1, "late resolver lease to be returned without opening a new stream", 5000);
});

for (const stop of [false, true]) it(`closes a backpressured media read before releasing ownership on ${stop ? "shutdown" : "disconnect"}`, async t => {
  const root = await tempDir("arke-media-stream-");
  const file = join(root, "preview.wav");
  const handle = await open(file, "wx");
  try { await handle.truncate(64 * 1024 * 1024); } finally { await handle.close(); }
  let releases = 0;
  const transport = new Transport({ auth, getSnapshot: () => emptyClientState(), serveFile: async () => ({
    path: file, contentType: "audio/wav", release: () => { releases++; },
  }) });
  const port = await transport.start(); t.after(() => transport.stop());
  const request = get(`http://127.0.0.1:${port}/large?token=${token}`);
  request.on("error", () => {}); t.after(() => request.destroy());
  const [response] = await once(request, "response");
  response.on("error", () => {}); response.pause();
  assert.equal(releases, 0, "backpressure keeps the reader's lease");
  if (stop) await transport.stop(); else request.destroy();
  await until(() => releases === 1, "destroyed native reader to close and release", 5000);
  assert.equal(releases, 1);
});

for (const failClose of [false, true]) it(`retains the media lease while descriptor closure ${failClose ? "fails" : "is pending"}`, async t => {
  const root = await tempDir("arke-media-close-");
  const file = join(root, "preview.wav"); await writeFile(file, "RIFF");
  const probe = await open(file, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalStream = prototype.createReadStream;
  await probe.close();
  let entered!: () => void, finish!: () => void;
  const closing = new Promise<void>(done => { entered = done; });
  const gate = new Promise<void>(done => { finish = done; });
  let descriptor: (() => number) | undefined;
  let closeOwned: (() => Promise<void>) | undefined;
  const mocked = t.mock.method(prototype, "createReadStream", function(this: FileHandle, ...args: Parameters<FileHandle["createReadStream"]>) {
    descriptor = () => this.fd; closeOwned = this.close.bind(this);
    t.mock.method(this, "close", async () => {
      entered(); await gate;
      if (failClose) throw new Error("private native failure details");
      return closeOwned!();
    });
    return originalStream.apply(this, args);
  });
  let releases = 0; const logs: string[] = [];
  const transport = new Transport({ auth, getSnapshot: () => emptyClientState(), log: line => logs.push(line), serveFile: async () => ({
    path: file, contentType: "audio/wav", release: () => { assert.equal(descriptor?.(), -1); releases++; },
  }) });
  const port = await transport.start();
  t.after(async () => { finish(); mocked.mock.restore(); if (descriptor && descriptor() !== -1) await closeOwned?.(); await transport.stop(); });
  const response = await fetch(`http://127.0.0.1:${port}/close?token=${token}`);
  assert.equal(await response.text(), "RIFF");
  await closing;
  assert.equal(releases, 0); assert.notEqual(descriptor?.(), -1);
  finish();
  if (failClose) {
    await until(() => logs.length === 1, "uncertain descriptor closure to be reported", 5000);
    assert.equal(releases, 0);
    assert.deepEqual(logs, ["media descriptor cleanup is unknown"]);
  } else await until(() => releases === 1, "confirmed descriptor closure to release ownership", 5000);
});

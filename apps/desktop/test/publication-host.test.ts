import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { publishPublication, verifyPublicationDirectory, PublicationFileError, type VideoPublicationCompilerOptions, type WorldProvider } from "@arke-studio/coordinator";
import { VideoPublicationRequestSchema, type VideoPublicationRequest } from "@arke-studio/contracts";
import { PublicationHost } from "../src/publication-host.js";
import { publicationMedia } from "../src/publication-media.js";
import { authenticatedMediaHeaders } from "../src/transport-auth.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const request: VideoPublicationRequest = { productionId: "film", id: `urn:uuid:${randomUUID()}`, title: "Test film", edition: "1", language: "en",
  preset: "review-cut", scope: { kind: "production" }, timelineRevision: null, textTracks: [] };
const compiler: Omit<VideoPublicationCompilerOptions, "scratchRoot"> = { encoderVersion: "test-1", encoder: { slateFont: "", run: async () => {} }, probe: { info: async () => null } };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "arke-publication-host-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const source = join(root, "source"); const output = join(root, "output");
  await mkdir(source); await mkdir(output);
  await writeFile(join(source, "movie.mp4"), "movie-bytes");
  const manifest = { format: "arke-publication", schemaVersion: 1, id: request.id, edition: "1", profile: "video", profileVersion: 1,
    title: "Film", language: "en", requires: ["video-v1"],
    assets: { movie: { href: "movie.mp4", mediaType: "video/mp4", byteLength: 11, sha256: hash("movie-bytes") } },
    content: { video: "movie", textTracks: [] }, build: { compiler: "test", compilerVersion: "1", dependencyFingerprint: hash("source") } };
  await writeFile(join(source, "publication.json"), JSON.stringify(manifest));
  const ports = { root: join(root, "host"), origins: ["null"], providers: () => ({ starting: null, live: null }), pick: async () => source,
    reveal: (_path: string) => {}, compiler: async () => compiler, probe: async () => ({ duration: 1, mediaType: "video/mp4" }) };
  return { root, source, output, ports };
}
it("serves only pinned inventory IDs with private authorization, origin checks and seek ranges", async t => {
  const f = await fixture(t); const host = new PublicationHost(f.ports); t.after(() => host.stop());
  const result = await host.open("directory"); assert.ok(result.ok);
  assert.ok(!JSON.stringify(result).includes(f.root)); assert.ok(!JSON.stringify(result).includes(host.session!.token));
  const url = result.value.assets.movie!;
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: `Bearer ${host.session!.token}`, Origin: "null" };
  assert.equal((await fetch(url, { headers: { ...headers, Origin: "https://untrusted.test" } })).status, 401);
  await writeFile(join(f.source, "movie.mp4"), "changed-original");
  const response = await fetch(url, { headers: { ...headers, Range: "bytes=6-10" } });
  assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), "bytes 6-10/11"); assert.equal(await response.text(), "bytes");
  assert.equal((await fetch(url.replace(/movie$/, "publication.json"), { headers })).status, 404);
  assert.equal((await fetch(url, { headers: { ...headers, Range: "bytes=11-20" } })).status, 416);
  const injected = authenticatedMediaHeaders({ url, webContentsId: 7, requestHeaders: {} }, host.session, 7);
  assert.equal(injected.Authorization, headers.Authorization);
  assert.deepEqual(authenticatedMediaHeaders({ url: "https://elsewhere.test/media/x", webContentsId: 7, requestHeaders: injected }, host.session, 7), {});
  await host.close(result.value.sessionId); assert.equal((await fetch(url, { headers })).status, 404);
});
it("restart reconciliation returns the prepared edition without a world, encoder or second build", async t => {
  const f = await fixture(t); const operationId = randomUUID();
  const intent = { worldId: "world", request, encoderVersion: "test-1", format: "directory" as const, outputRoot: f.output, operationId };
  const requestFingerprint = hash(JSON.stringify({ request: VideoPublicationRequestSchema.parse(request), world: "world", encoder: "test-1" }));
  await assert.rejects(publishPublication({ operationId, publicationId: request.id, requestFingerprint, format: "directory" },
    async () => ({ ...await verifyPublicationDirectory(f.source), dispose: async () => {} }),
    { outputRoot: f.output, onPhase: phase => { if (phase === "promoted") throw new Error("simulated crash"); } }), /crash/);
  await mkdir(join(f.ports.root, "operations"), { recursive: true });
  await writeFile(join(f.ports.root, "operations", `${operationId}.json`), JSON.stringify(intent));
  const host = new PublicationHost({ ...f.ports, compiler: async () => { throw new Error("must not rebuild"); } }); t.after(() => host.stop());
  const list = await host.list(); assert.ok(list.ok); assert.equal(list.value[0]!.status, "interrupted");
  assert.ok((await host.retry(operationId)).ok);
  for (let n = 0; n < 600; n++) { const state = await host.list(); if (state.ok && state.value[0]?.status !== "running") break; await new Promise(resolve => setTimeout(resolve, 25)); }
  const finished = await host.list(); assert.ok(finished.ok); assert.equal(finished.value[0]!.status, "completed");
  assert.ok((await host.open({ operationId })).ok);
  assert.equal((await readdir(join(f.output, operationId))).filter(name => name.startsWith("attempt-")).length, 1);
  const attempt = (await readdir(join(f.output, operationId))).find(name => name.startsWith("attempt-"))!;
  const movie = join(f.output, operationId, attempt, "publication", "movie.mp4");
  await writeFile(movie, "damaged");
  assert.ok((await host.retry(operationId)).ok);
  for (let n = 0; n < 600; n++) { const state = await host.list(); if (state.ok && state.value[0]?.status !== "running") break; await new Promise(resolve => setTimeout(resolve, 25)); }
  const damaged = await host.list(); assert.ok(damaged.ok);
  assert.equal(damaged.value[0]!.status, "failed"); assert.equal(damaged.value[0]!.retryable, false);
  assert.match(damaged.value[0]!.reason!, /preserved.*Create a new edition/);
  assert.equal(await readFile(movie, "utf8"), "damaged");
});

for (const action of ["start", "open"] as const) it(`shutdown leaves a pending ${action} picker without resuming late work`, { timeout: 15_000 }, async t => {
  const f = await fixture(t); let entered!: () => void, release!: (value: string) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const choice = new Promise<string>(resolve => { release = resolve; });
  const host = new PublicationHost({ ...f.ports, pick: async () => { entered(); return choice; } });
  t.after(async () => { release(f.source); await host.stop(); });
  const work = action === "open" ? host.open("directory") : host.start({ worldId: "world", request, format: "zip" });
  await waiting;
  await host.stop();
  const reply = await work; assert.ok(!reply.ok && reply.cancelled);
  release(f.source); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.session, null);
  assert.deepEqual(await readdir(join(f.ports.root, "playback")), []);
  if (action === "start") assert.deepEqual(await readdir(join(f.ports.root, "operations")), []);
});
it("flushes the intent before work and drains cancellation during shutdown", async t => {
  const f = await fixture(t); let calls = 0; let entered!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  const host = new PublicationHost({ ...f.ports, pick: async () => f.output,
    providers: () => ({ starting: null, live: { listWorlds: async () => [], loadWorld: async () => { throw new Error(); }, assertWritingScratch: async () => {} } }),
    compiler: async signal => {
      if (++calls === 1) return compiler;
      const [name] = await readdir(join(f.ports.root, "operations")); assert.ok(name?.endsWith(".json"));
      assert.equal(JSON.parse(await readFile(join(f.ports.root, "operations", name), "utf8")).request.title, request.title);
      entered();
      await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted(); return compiler;
    } });
  assert.ok((await host.start({ worldId: "world", request, format: "zip" })).ok);
  await running; await host.resetPlayback();
  const active = await host.list(); assert.ok(active.ok); assert.equal(active.value[0]!.status, "running", "renderer reset leaves export running");
  await host.stop();
  assert.equal((await host.list()).ok, false, "shutdown does not resurrect work");
});
it("preflights real codec metadata and reports unsupported pixel formats", async () => {
  let pix_fmt = "yuv420p", extra: string | undefined;
  const media = publicationMedia({ run: async () => ({ code: 0, stdout: Buffer.from(JSON.stringify({ format: { duration: "2", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
    streams: [{ codec_type: "video", codec_name: "h264", pix_fmt }, { codec_type: "audio", codec_name: "aac" }, ...(extra ? [{ codec_type: extra }] : [])] })), stderr: "", timedOut: false, outputLimitExceeded: false, cancelled: false }) });
  assert.deepEqual(await media.playback("opaque", "video/mp4"), { duration: 2, mediaType: 'video/mp4; codecs="avc1, mp4a.40.2"' });
  pix_fmt = "yuv420p10le"; await assert.rejects(media.playback("opaque", "video/mp4"), /Unsupported publication codec/);
  pix_fmt = "yuv420p";
  for (extra of ["subtitle", "data", "attachment", "unknown"]) await assert.rejects(media.playback("opaque", "video/mp4"), /Unsupported publication codec/);
});

it("refuses drawtext before encoding a clean publication without rejecting ordinary input names", async () => {
  const calls: string[][] = [];
  const media = publicationMedia({ run: async (_tool, args) => { calls.push(args); return { code: 0, stdout: Buffer.from("test-version"), stderr: "", timedOut: false, outputLimitExceeded: false, cancelled: false }; } });
  const signal = new AbortController().signal;
  const options = await media.compiler(signal);
  await assert.rejects(options.encoder.run(["-filter_complex", "drawtext=fontfile=:text=Missing"], () => {}, signal), /do not support drawn text/);
  assert.equal(calls.length, 1, "only the version probe runs; no font fallback or encode");
  await options.encoder.run(["-i", "drawtext=ordinary-file.mp4", "output.mp4"], () => {}, signal);
  assert.equal(calls.length, 2);
});

for (const cause of ["encoder", "conflict"] as const) it(`requires a new edition after saved ${cause} incompatibility instead of an endless retry`, async t => {
  const f = await fixture(t); const operationId = randomUUID();
  await mkdir(join(f.ports.root, "operations"), { recursive: true });
  await writeFile(join(f.ports.root, "operations", `${operationId}.json`), JSON.stringify({ worldId: "world", request,
    encoderVersion: cause === "encoder" ? "older-build" : "test-1", format: "directory", outputRoot: f.output, operationId }));
  if (cause === "conflict") {
    await mkdir(join(f.output, operationId));
    await writeFile(join(f.output, operationId, "operation.json"), JSON.stringify({ version: 1, operationId, publicationId: request.id, format: "zip", requestFingerprint: "0".repeat(64) }));
  }
  const host = new PublicationHost(f.ports); t.after(() => host.stop());
  assert.ok((await host.retry(operationId)).ok);
  for (let n = 0; n < 600; n++) { const state = await host.list(); if (state.ok && state.value[0]?.status !== "running") break; await new Promise(resolve => setTimeout(resolve, 25)); }
  const state = await host.list(); assert.ok(state.ok);
  assert.equal(state.value[0]!.status, "failed"); assert.equal(state.value[0]!.retryable, false);
  assert.match(state.value[0]!.reason!, /Create a new edition/);
  assert.match(state.value[0]!.reason!, cause === "encoder" ? /encoder changed/ : /operation-conflict/);
});

it("preserves unreadable recovery records while listing valid jobs, opening packages and starting new work", async t => {
  const f = await fixture(t); const brokenId = randomUUID(), validId = randomUUID();
  const operations = join(f.ports.root, "operations"); await mkdir(operations, { recursive: true });
  const brokenPath = join(operations, `${brokenId}.json`); const broken = `{ truncated private path ${f.root}`;
  await writeFile(brokenPath, broken);
  await writeFile(join(operations, `${validId}.json`), JSON.stringify({ worldId: "world", request,
    encoderVersion: "test-1", format: "directory", outputRoot: f.output, operationId: validId }));
  const host = new PublicationHost({ ...f.ports, pick: async kind => kind === "output" ? f.output : f.source,
    providers: () => ({ starting: null, live: { listWorlds: async () => [], loadWorld: async () => { throw new Error(); }, assertWritingScratch: async () => {} } }) });
  t.after(() => host.stop());
  assert.ok((await host.open("directory")).ok);
  const listed = await host.list(); assert.ok(listed.ok); assert.equal(listed.value.length, 2);
  assert.equal(listed.value.find(job => job.operationId === validId)!.status, "interrupted");
  const bad = listed.value.find(job => job.operationId === brokenId)!;
  assert.equal(bad.retryable, false); assert.match(bad.reason!, /preserved.*Create a new edition/);
  assert.ok(!JSON.stringify(listed).includes(f.root)); assert.equal(await readFile(brokenPath, "utf8"), broken);
  assert.ok((await host.start({ worldId: "world", request, format: "directory" })).ok);
});

it("releases lost renderer sessions and cancels a pending open", async t => {
  const f = await fixture(t); let delay = false; let entered!: () => void; let release!: () => void;
  const picking = new Promise<void>(resolve => { entered = resolve; });
  const picker = new Promise<void>(resolve => { release = resolve; });
  const host = new PublicationHost({ ...f.ports, pick: async () => { if (delay) { entered(); await picker; } return f.source; } });
  t.after(() => host.stop());
  const first = await host.open("directory"); assert.ok(first.ok);
  delay = true; const opening = host.open("directory"); await picking;
  await host.resetPlayback(); release();
  const abandoned = await opening; assert.ok(!abandoned.ok && abandoned.cancelled);
  assert.deepEqual(await readdir(join(f.ports.root, "playback")), []);
  assert.equal((await fetch(first.value.assets.movie!, { headers: { Authorization: `Bearer ${host.session!.token}` } })).status, 404);
  delay = false;
  for (let n = 0; n < 3; n++) { assert.ok((await host.open("directory")).ok); await host.resetPlayback(); }
  assert.ok((await host.list()).ok, "renderer lifetime does not stop the host");
});

it("keeps an existing player session after cancellation or failed replacement", async t => {
  const f = await fixture(t); let cancelled = false;
  const host = new PublicationHost({ ...f.ports, pick: async () => cancelled ? null : f.source }); t.after(() => host.stop());
  const first = await host.open("directory"); assert.ok(first.ok);
  cancelled = true;
  const cancel = await host.open("zip"); assert.ok(!cancel.ok && cancel.cancelled);
  cancelled = false; await writeFile(join(f.source, "movie.mp4"), "corrupt");
  assert.equal((await host.open("directory")).ok, false);
  const response = await fetch(first.value.assets.movie!, { headers: { Authorization: `Bearer ${host.session!.token}` } });
  assert.equal(response.status, 200); assert.equal(await response.text(), "movie-bytes");
});

it("never forwards nested filesystem paths inside domain refusals", async t => {
  const f = await fixture(t);
  const host = new PublicationHost({ ...f.ports, probe: async () => { throw new PublicationFileError("source-changed", `ENOENT: ${f.root}/private-world/secret-file`); } });
  t.after(() => host.stop());
  const result = await host.open("directory"); assert.ok(!result.ok);
  assert.match(result.reason, /^source-changed:/);
  assert.ok(!result.reason.includes(f.root)); assert.ok(!result.reason.includes("secret-file"));
});

it("keeps publishing available after startup hands its provider to the live coordinator", { timeout: 30_000 }, async t => {
  const f = await fixture(t); let checked = false; let acquired!: () => void;
  const captured = new Promise<void>(resolve => { acquired = resolve; });
  const provider: WorldProvider = {
    listWorlds: async () => [], loadWorld: async () => { throw new Error("unused"); },
    assertWritingScratch: async path => { assert.equal(path, f.output); checked = true; },
    withWorldStore: async worldId => { assert.equal(worldId, "world"); acquired(); throw new Error("test stops at source capture"); },
  };
  const providers: { starting: WorldProvider | null; live: WorldProvider | null } = { starting: provider, live: null };
  const host = new PublicationHost({ ...f.ports, providers: () => providers, pick: async () => f.output });
  t.after(() => host.stop());
  // This is initialize()'s handoff: the IPC handler already exists when startup clears its slot.
  providers.live = providers.starting; providers.starting = null;
  assert.ok((await host.start({ worldId: "world", request, format: "directory" })).ok);
  assert.ok(checked);
  await captured;
});

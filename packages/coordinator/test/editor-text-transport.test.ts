import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { FrameSchema, ProductionTimelineSchema, storyTimelineFingerprint, textPicturePath, ulid, TEXT_PICTURE_DIR, TEXT_TYPEFACE_IDS, type TextDraftAnswer, type TextLook, type TimelineClip, type TimelineCommand } from "@arke-studio/contracts";
import { Coordinator } from "../src/coordinator.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { applyHumanTimelineCommand } from "../src/productions/timeline.js";
import { decodePng } from "../src/references/png.js";
import { sha256 } from "../src/world/text-files.js";
import { makeTempRoot, WORLD_ID } from "./world/helpers.js";

/**
 * A kept text picture through the authenticated media route (SPEC-065 R-20, §3.2): it needs the
 * capability like any media, it is painted on its first GET when the open world names it, a path
 * that is not exactly a kept picture's is not found, and a picture that cannot be drawn is not
 * found either, with its reason in the log and the capability nowhere. Then the two answers the
 * socket gives a text command: a rule-out of R-2 by name, and a bound of R-26 as `invalid` (O10).
 * Then the sweep that opening a world runs: a kept picture nothing names any more goes (§2.3).
 * Last, a title drawn while it is typed (R-32): asked and answered on one socket, refused like any
 * message before the capability, bounded by the wire, and written nowhere.
 */

const PRODUCTION = "saltlight", ORIGIN = "http://localhost:5173";
const LOOK: TextLook = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2,
  capitals: false, align: "center", x: 0.5, y: 0.5, room: 0.8, fill: { kind: "solid", color: "#ffffff" } };
const text = (id: `cl_${string}`, words: string, startFrame: number): TimelineClip =>
  ({ id, startFrame, durationFrames: 48, sourceInFrames: 0, source: { kind: "text", label: words, text: words, look: LOOK } });
/** The name and path the plan gives these words at the master frame, where a wide production is delivered. */
function kept(words: string) {
  const ref = textPicturePath({ text: words, look: LOOK }, { width: 1920, height: 1080 });
  if (!ref.ok) throw new Error(ref.reason);
  return ref;
}

async function serve(t: { after: (fn: () => unknown) => void }) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, changeLogPath: join(root, "logs/changes.jsonl"), appVersion: "test",
    transportAuth: { token: "a".repeat(64), allowedOrigins: [ORIGIN] } });
  t.after(async () => { await coordinator.stop(); await provider.close(); });
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore(); assert.ok(store);
  const production = () => store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
  const timelineFile = join(worldDir, "productions", PRODUCTION, "timeline.json");
  const still = store.getBundle().artifacts.find(value => value.kind === "board")!;
  const send = (commands: TimelineCommand[], baseRevision: number | null) => applyHumanTimelineCommand(store, PRODUCTION,
    { kind: "commands", baseRevision, sourceFingerprint: storyTimelineFingerprint(production()), commands });
  await send([{ kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } },
    { kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" },
    { kind: "place", trackId: "tr_names", clip: text("cl_name", "ADE", 24) }], null);
  const { port, token } = await coordinator.start(0);
  const base = `http://127.0.0.1:${port}/media/${store.getBundle().meta.slug}/`;
  const authenticated = { headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN } };
  const folder = join(worldDir, TEXT_PICTURE_DIR);
  const files = () => readdir(folder).catch(() => [] as string[]);
  return { root, worldDir, store, production, timelineFile, send, port, token, base, authenticated, folder, files };
}

test("a kept picture needs the capability", async t => {
  const { base, token, authenticated, files } = await serve(t), { path } = kept("ADE");
  for (const suffix of ["", "?token=wrong"]) {
    const denied = await fetch(base + path + suffix); assert.equal(denied.status, 401); await denied.text();
  }
  assert.deepEqual(await files(), [], "a refused GET paints nothing");
  for (const response of [await fetch(base + path, authenticated), await fetch(`${base}${path}?token=${token}`)]) {
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const picture = decodePng(bytes);
    assert.deepEqual([picture.width, picture.height], [1920, 1080]);
  }
});

test("a picture the world names is painted when it is asked for", async t => {
  const { base, authenticated, folder, files } = await serve(t), { name, path } = kept("ADE");
  await assert.rejects(stat(folder), { code: "ENOENT" }, "nothing is painted until something asks to see it");
  const first = await fetch(base + path, authenticated); assert.equal(first.status, 200); await first.arrayBuffer();
  assert.deepEqual(await files(), [`${name}.png`]);
  const painted = await stat(join(folder, `${name}.png`));
  const second = await fetch(base + path, authenticated); assert.equal(second.status, 200); await second.arrayBuffer();
  assert.equal((await stat(join(folder, `${name}.png`))).mtimeMs, painted.mtimeMs, "a kept picture is never written again");
  // Each delivery size is a picture of its own; the portrait frame's name is held too.
  const portrait = textPicturePath({ text: "ADE", look: LOOK }, { width: 1080, height: 1920 });
  assert.ok(portrait.ok);
  const tall = await fetch(base + portrait.path, authenticated); assert.equal(tall.status, 200); await tall.arrayBuffer();
  assert.equal((await files()).length, 2);
});

test("a path outside the folder refuses", async t => {
  const { root, port, base, authenticated, files, store } = await serve(t), { name, path } = kept("ADE");
  await writeFile(join(store.dir, "artifacts/private-record.json"), '{"private":"not media"}');
  // A real kept picture under another world's slug cannot borrow this world's route.
  const otherFolder = join(root, "worlds/another-world", TEXT_PICTURE_DIR);
  await mkdir(otherFolder, { recursive: true }); await writeFile(join(otherFolder, `${name}.png`), "not this world's");
  const unnamed = textPicturePath({ text: "NOBODY", look: LOOK }, { width: 1920, height: 1080 });
  assert.ok(unnamed.ok);
  for (const relative of [
    `${TEXT_PICTURE_DIR}/../../artifacts/private-record.json`, `${TEXT_PICTURE_DIR}/..%2f..%2fartifacts%2fprivate-record.json`,
    `${TEXT_PICTURE_DIR}/%2e%2e%2f%2e%2e%2fartifacts%2fprivate-record.json`, `${TEXT_PICTURE_DIR}/%2e%2e%5c%2e%2e%5cartifacts%5cprivate-record.json`,
    `${TEXT_PICTURE_DIR}/x/${name}.png`, `${TEXT_PICTURE_DIR}/${name.toUpperCase()}.png`, `${TEXT_PICTURE_DIR}/${name}.png.tmp`,
    `${TEXT_PICTURE_DIR}/${name.slice(1)}.png`, `${TEXT_PICTURE_DIR}/${name}.png%00`, `${TEXT_PICTURE_DIR}/`, unnamed.path,
  ]) {
    const denied = await fetch(base + relative, authenticated); assert.equal(denied.status, 404, relative); await denied.text();
  }
  const other = await fetch(`http://127.0.0.1:${port}/media/another-world/${path}`, authenticated);
  assert.equal(other.status, 404); await other.text();
  assert.deepEqual(await files(), [], "nothing was painted for any of them");
});

test("a picture that cannot be drawn is a 404 and no file, and its reason reaches the log without the capability", async t => {
  const { root, store, timelineFile, base, token, authenticated, files } = await serve(t);
  // Words no command would let in (the painter refuses them), as a hand-edited timeline holds them.
  // On the base track: the saved history must still replay, and Undo of `add-track` would find
  // the Names track holding a clip no entry put there.
  const before = await readFile(timelineFile, "utf8"), timeline = ProductionTimelineSchema.parse(JSON.parse(before));
  timeline.tracks.find(track => track.id === "tr_picture")!.clips.push(text("cl_undrawn", "漢", 96));
  await store.commit({ kind: "adopt-timeline", source: "test", files: [{ path: `productions/${PRODUCTION}/timeline.json`, action: "replace",
    content: `${JSON.stringify(timeline, null, 2)}\n`, baseHash: sha256(before) }] });
  const { path } = kept("漢");
  const missing = await fetch(`${base}${path}?token=${token}`, authenticated); assert.equal(missing.status, 404); await missing.text();
  assert.deepEqual(await files(), [], "never a slate, never a blank picture under its name");
  const log = join(root, "logs", "app.jsonl");
  let lines: Array<Record<string, unknown>> = [];
  for (let waited = 0; waited < 5_000; waited += 50) {
    lines = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    if (lines.some(line => line.kind === "editor-text.not-served")) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const line = lines.find(row => row.kind === "editor-text.not-served");
  assert.ok(line, `the refusal is logged: ${JSON.stringify(lines.slice(-5))}`);
  assert.equal(line.reason, "Geist has no 漢");
  const written = await readFile(log, "utf8");
  assert.equal(written.includes(token), false, "the capability is never logged");
  assert.equal(written.includes(path), false, "nor the path that was asked for");
});

/** A socket that keeps every message as sent, frames and refusals alike: a refusal is not a frame. */
async function connect(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
  const messages: Array<Record<string, unknown>> = [];
  socket.on("message", data => { messages.push(JSON.parse(String(data)) as Record<string, unknown>); });
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  socket.send(JSON.stringify({ kind: "hello", token, lastSeq: 0 }));
  const until = async (match: (message: Record<string, unknown>) => boolean, label: string) => {
    for (let waited = 0; waited < 8_000; waited += 25) {
      const hit = messages.find(match);
      if (hit) return hit;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  await until(message => message.kind === "snapshot" || message.kind === "snapshot-page", "snapshot");
  return { socket, messages, until, send: (value: unknown) => socket.send(JSON.stringify(value)) };
}
const refusedEvent = (message: Record<string, unknown>) => {
  const event = message.kind === "event" ? message.event as { type?: string; reason?: string } : undefined;
  return event?.type === "timeline.command-refused" ? event : undefined;
};

test("a place carrying a gain on a text clip is refused as \"Text has no gain\", not as invalid", async t => {
  const { port, token, production, timelineFile } = await serve(t);
  const client = await connect(port, token); t.after(() => client.socket.close());
  const before = await readFile(timelineFile, "utf8"), revision = ProductionTimelineSchema.parse(JSON.parse(before)).revision;
  client.send({ kind: "timeline-command", worldId: WORLD_ID, productionId: PRODUCTION, baseRevision: revision, sourceFingerprint: storyTimelineFingerprint(production()),
    commands: [{ kind: "place", trackId: "tr_names", clip: { ...text("cl_gain", "IFE", 200), gainDb: -3 } }] });
  const refused = refusedEvent(await client.until(message => refusedEvent(message) !== undefined, "the refusal"));
  assert.equal(refused?.reason, "Text has no gain");
  assert.equal(client.messages.some(message => message.kind === "command-refused"), false);
  assert.equal(await readFile(timelineFile, "utf8"), before);
});

test("a text-set of 501 characters over the socket is refused as invalid and writes nothing (O10)", async t => {
  const { port, token, production, timelineFile } = await serve(t);
  const client = await connect(port, token); t.after(() => client.socket.close());
  const before = await readFile(timelineFile, "utf8"), revision = ProductionTimelineSchema.parse(JSON.parse(before)).revision;
  client.send({ kind: "timeline-command", worldId: WORLD_ID, productionId: PRODUCTION, baseRevision: revision, sourceFingerprint: storyTimelineFingerprint(production()),
    commands: [{ kind: "text-set", clipIds: ["cl_name"], text: "A".repeat(501) }] });
  const refused = await client.until(message => message.kind === "command-refused", "the refusal");
  assert.deepEqual(refused, { kind: "command-refused", refused: "invalid", command: "timeline-command" });
  // Five hundred is let in, which is what shows the bound and not something else refused it.
  client.send({ kind: "timeline-command", worldId: WORLD_ID, productionId: PRODUCTION, baseRevision: revision, sourceFingerprint: storyTimelineFingerprint(production()),
    commands: [{ kind: "text-set", clipIds: ["cl_name"], text: "A".repeat(500) }] });
  for (let waited = 0; waited < 8_000 && await readFile(timelineFile, "utf8") === before; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  const after = ProductionTimelineSchema.parse(JSON.parse(await readFile(timelineFile, "utf8")));
  assert.equal(after.revision, revision + 1, "only the command within the bound was written");
  assert.equal(client.messages.filter(message => message.kind === "command-refused").length, 1);
});

test("opening a world sweeps the kept pictures nothing names, and leaves everything else", async () => {
  const { root, worldDir } = await makeTempRoot();
  // The words are placed in one session and the world closed, as a person quits the Studio.
  const first = new FsWorldProvider(root);
  try {
    await first.loadWorld(WORLD_ID);
    const store = first.openStore(); assert.ok(store);
    const production = store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
    const still = store.getBundle().artifacts.find(value => value.kind === "board")!;
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production), commands: [
      { kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } },
      { kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" },
      { kind: "place", trackId: "tr_names", clip: text("cl_name", "ADE", 24) }] });
  } finally { await first.close(); }
  const folder = join(worldDir, TEXT_PICTURE_DIR), named = kept("ADE").name, unnamed = kept("RETYPED").name, stage = `.tmp-${ulid()}`;
  await mkdir(folder, { recursive: true });
  for (const file of [`${named}.png`, `${unnamed}.png`, stage, "notes.txt"]) await writeFile(join(folder, file), "kept");

  const provider = new FsWorldProvider(root);
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, changeLogPath: join(root, "logs/changes.jsonl"), appVersion: "test" });
  try {
    await coordinator.dispatch({ kind: "open-world", worldId: WORLD_ID });
    assert.equal(provider.openStore()?.worldId, WORLD_ID);
    // The words a clip holds keep their picture; a picture of words nobody holds, and a write cut
    // short, go. Anything else in the folder is not the sweep's to touch.
    assert.deepEqual((await readdir(folder)).sort(), [`${named}.png`, "notes.txt"].sort());
  } finally { await coordinator.stop(); await provider.close(); }
});

const DRAFT_ID = "12345678-1234-4234-8234-123456789abc";
const draft = (text: string, requestId = DRAFT_ID) => ({ kind: "text-draft", requestId, frame: { width: 1920, height: 1080 }, ask: { kind: "paint", item: { text, look: LOOK } } });
const isDraft = (requestId: string) => (message: Record<string, unknown>) => message.kind === "text-draft" && message.requestId === requestId;
/** Lets any answer that should not come have time to arrive. */
const quiet = () => new Promise(resolve => setTimeout(resolve, 400));
/** A frame read as the window reads it, by the frame schema: a draft's answer and its sequence. */
function answerOf(message: Record<string, unknown>): { seq: number; answer: TextDraftAnswer } {
  const frame = FrameSchema.parse(message);
  assert.equal(frame.kind, "text-draft");
  if (frame.kind !== "text-draft") throw new Error("not a draft");
  return frame;
}

test("a draft needs the capability: asked before hello, the socket closes and nothing is answered", async t => {
  const { port, files } = await serve(t);
  for (const opening of [[], [{ kind: "hello", token: "b".repeat(64), lastSeq: 0 }]]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
    const messages: unknown[] = [];
    socket.on("message", data => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    const closed = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
    for (const message of opening) socket.send(JSON.stringify(message));
    socket.send(JSON.stringify(draft("ADE")));
    assert.equal(await closed, 1008, opening.length ? "a wrong capability" : "no hello");
    assert.deepEqual(messages, [], "no snapshot, no draft, no refusal naming it");
  }
  assert.deepEqual(await files(), [], "and nothing painted to keep");
});

test("a draft is answered on the asking socket only; another window receives nothing", async t => {
  const { port, token } = await serve(t);
  const asking = await connect(port, token), other = await connect(port, token);
  t.after(() => { asking.socket.close(); other.socket.close(); });
  asking.send(draft("Harbour lights"));
  const frame = answerOf(await asking.until(isDraft(DRAFT_ID), "the draft"));
  if (frame.answer.kind !== "drawn") throw new Error(`answered ${frame.answer.kind}`);
  assert.deepEqual(frame.answer.results, [{ ok: true, drawnSize: 0.08 }]);
  const ref = textPicturePath({ text: "Harbour lights", look: LOOK }, { width: 1920, height: 1080 });
  assert.ok(ref.ok);
  assert.equal(frame.answer.picture?.name, ref.name);
  const picture = decodePng(Buffer.from(frame.answer.picture.png, "base64"));
  assert.deepEqual([picture.width, picture.height], [1920, 1080]);
  assert.ok(Number.isInteger(frame.seq) && frame.seq > 0, "sequenced on its own connection like any frame");
  // The typeface files answer the window that asked for them, too.
  other.send({ kind: "text-typefaces", requestId: DRAFT_ID });
  const faces = FrameSchema.parse(await other.until(message => message.kind === "text-typefaces", "the faces"));
  assert.ok(faces.kind === "text-typefaces");
  assert.deepEqual(faces.faces.map(face => face.id), [...TEXT_TYPEFACE_IDS]);
  await quiet();
  assert.equal(other.messages.some(message => message.kind === "text-draft" || JSON.stringify(message).includes("Harbour lights")), false, "the other window never sees the words");
  assert.equal(asking.messages.some(message => message.kind === "text-typefaces"), false);
});

test("a draft of 51 items is refused as invalid with its request id", async t => {
  const { port, token } = await serve(t);
  const client = await connect(port, token); t.after(() => client.socket.close());
  const items = (count: number) => Array.from({ length: count }, (_, index) => ({ text: `Name ${index}`, look: LOOK }));
  client.send({ ...draft("ADE"), ask: { kind: "measure", items: items(51) } });
  const refused = await client.until(message => message.kind === "command-refused", "the refusal");
  assert.deepEqual(refused, { kind: "command-refused", refused: "invalid", command: "text-draft", requestId: DRAFT_ID });
  // Fifty is answered, which is what shows the bound and not something else refused it.
  const fifty = "12345678-1234-4234-8234-000000000050";
  client.send({ ...draft("ADE", fifty), ask: { kind: "measure", items: items(50) } });
  const { answer } = answerOf(await client.until(isDraft(fifty), "fifty measured"));
  assert.ok(answer.kind === "drawn");
  assert.equal(answer.results.length, 50);
  assert.equal(answer.picture, undefined);
  assert.equal(client.messages.some(isDraft(DRAFT_ID)), false, "the refused ask was never drawn");
});

test("a draft writes nothing: no file in the world, no event, no log line", async t => {
  const { root, port, token, timelineFile, files } = await serve(t);
  const client = await connect(port, token); t.after(() => client.socket.close());
  const words = "Unsaved words 7f3a", timeline = await readFile(timelineFile, "utf8");
  const logs = async () => Promise.all(["changes.jsonl", "app.jsonl"].map(file => readFile(join(root, "logs", file), "utf8").catch(() => "")));
  client.send(draft(words));
  // Answered before the next ask goes: a window holds one paint at a time, so a second ask sent at
  // once would supersede this one, nothing would be painted, and what follows would prove nothing.
  const painted = answerOf(await client.until(isDraft(DRAFT_ID), "the draft"));
  assert.equal(painted.answer.kind, "drawn", "the draft was painted");
  assert.ok(painted.answer.kind === "drawn" && painted.answer.picture !== undefined && painted.answer.picture.png.length > 0, "and its picture sent to the window");
  // Words the face cannot draw are refused the same way, and are not written either.
  client.send(draft("Unsaved ṣ 7f3a", "12345678-1234-4234-8234-000000000002"));
  const refused = answerOf(await client.until(isDraft("12345678-1234-4234-8234-000000000002"), "the refusal"));
  assert.deepEqual(refused.answer, { kind: "drawn", results: [{ ok: false, reason: "Geist has no ṣ", field: "words" }] });
  await quiet();
  assert.deepEqual(await files(), [], "no picture is kept");
  assert.equal(await readFile(timelineFile, "utf8"), timeline, "no revision");
  // Read by what they carry rather than counted: an idle coordinator may still say something of its own.
  assert.equal(client.messages.some(message => message.kind === "event" && JSON.stringify(message).includes("7f3a")), false, "no event carries the words");
  assert.equal(client.messages.some(message => message.kind === "event" && /text-draft|command\.failed/.test(JSON.stringify(message))), false, "nor answers the draft");
  const after = await logs();
  assert.deepEqual(after.map(text => text.includes("7f3a")), [false, false], "neither log holds the words");
  assert.equal(after.some(text => text.includes(token)), false);
});

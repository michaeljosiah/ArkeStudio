import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";
import { BROWSER_MEDIA_IMPORT_MAX_BYTES, ClientMessageSchema, type ClientMessage } from "@arke-studio/contracts";
import { pickBrowserMedia, readBrowserMedia } from "../src/lib/browser-media-import.js";
import { __applyEventForTest, __connectionStatusForTest, __setBridgeForTest, __setStateForTest, importEditorMedia, subscribeQueueResults } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import type { ArkeBridge } from "../src/arke-bridge.js";

function browser() {
  const { window } = parseHTML("<html><head></head><body></body></html>");
  Object.assign(globalThis, { window, document: window.document });
  return window;
}
function setup() {
  const window = browser(); const messages: ClientMessage[] = [];
  const bridge: ArkeBridge = { appVersion: "test", platform: "browser", connect() {}, subscribe() {}, send(json) { messages.push(ClientMessageSchema.parse(JSON.parse(json))); } };
  __setBridgeForTest(bridge); __setStateForTest(FIXTURE_STATE);
  return { window, messages, bridge, worldId: FIXTURE_STATE.world!.meta.worldId };
}
afterEach(() => { __connectionStatusForTest("closed"); __setBridgeForTest(null); });
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

it("opens a real file input synchronously and removes it on selection or cancellation", async () => {
  const window = browser(); const selected = pickBrowserMedia();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  assert.ok(input); assert.equal(input.multiple, true);
  const file = new File(["image"], "title.png");
  Object.defineProperty(input, "files", { value: [file] }); input.dispatchEvent(new window.Event("change"));
  assert.deepEqual(await selected, [file]); assert.equal(document.querySelector("input"), null);
  const cancelled = pickBrowserMedia(); document.querySelector("input")!.dispatchEvent(new window.Event("cancel"));
  assert.deepEqual(await cancelled, []); assert.equal(document.querySelector("input"), null);
});

it("reads files in order and refuses oversized or stale selections before submission", async () => {
  const files = [new File(["picture"], "title.png"), new File(["sound"], "song.mp3")];
  assert.deepEqual(await readBrowserMedia(files, () => true), [{ name: "title.png", data: "cGljdHVyZQ==" }, { name: "song.mp3", data: "c291bmQ=" }]);
  const large = { name: "big.mp4", size: BROWSER_MEDIA_IMPORT_MAX_BYTES + 1, arrayBuffer: () => assert.fail("must not read") } as unknown as File;
  await assert.rejects(readBrowserMedia([large], () => true), /48 MB/);
  let current = true;
  const delayed = { name: "song.mp3", size: 1, async arrayBuffer() { current = false; return new Uint8Array([1]).buffer; } } as File;
  await assert.rejects(readBrowserMedia([delayed], () => current), /studio or world changed/);
});

it("sends browser bytes with exact editor fence and never a host path", async () => {
  const { messages, worldId } = setup();
  const editor = { productionId: "saltlight", destination: "library" as const, baseRevision: null, sourceFingerprint: "story-picture-v1:1234567890abcdef" };
  const result = importEditorMedia(worldId, editor, [new File(["song"], "song.mp3")]);
  assert.ok(result.requestId); await settle();
  assert.deepEqual(messages, [{ kind: "upload-artifacts", worldId, requestId: result.requestId, editor, browserFiles: [{ name: "song.mp3", data: "c29uZw==" }] }]);
  assert.match(importEditorMedia(worldId, editor, []).reason!, /Another import/);
  __applyEventForTest({ type: "queue.enqueue-result", at: new Date().toISOString(), requestId: result.requestId, command: "upload-artifacts",
    disposition: "not-queued", requestedCount: 1, acceptedJobIds: [], failures: [] });
});

it("reports cancelled browser pickers locally and refuses remembered remote sessions", async () => {
  const { window, messages, worldId } = setup(); const results: unknown[] = [];
  const stop = subscribeQueueResults(result => results.push(result));
  try {
    const requested = importEditorMedia(worldId, undefined);
    document.querySelector("input")!.dispatchEvent(new window.Event("cancel")); await settle();
    assert.ok(requested.requestId); assert.equal(results.length, 1); assert.deepEqual(messages, []);
    document.head.innerHTML = '<meta name="arke-remote" content="true">';
    assert.deepEqual(importEditorMedia(worldId, undefined, [new File(["x"], "x.png")]), { requestId: null, reason: "Import media on the desktop app." });
    assert.deepEqual(messages, []);
  } finally { stop(); }
});

it("preserves the desktop native picker and File-object courier", () => {
  const { window, messages, bridge, worldId } = setup(); const calls: unknown[] = [];
  bridge.importDroppedMedia = (request, files) => { calls.push({ request, files }); return { submitted: true, unresolved: [] }; };
  Object.assign(window, { arke: bridge });
  importEditorMedia(worldId, undefined);
  assert.equal(messages[0]?.kind, "upload-artifacts"); assert.equal("browserFiles" in messages[0]!, false);
  const file = new File(["x"], "clip.mp4"); importEditorMedia(worldId, undefined, [file]);
  assert.equal(calls.length, 1); assert.equal(document.querySelector("input"), null);
});

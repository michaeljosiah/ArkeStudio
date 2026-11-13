import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage } from "@arke-studio/contracts";
import { useAudioStudioPlayer } from "../src/lib/audio-studio.js";
import { emitForTest, playbackSnapshot, setAudioFactoryForTest } from "../src/lib/audio.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("releases a finished audition and lets Play start again from the selected position", async () => {
  const { document, window } = parseHTML("<html><body><main></main></body></html>");
  Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const sent: ClientMessage[] = [], worldId = FIXTURE_STATE.world!.meta.worldId;
  __setStateForTest(FIXTURE_STATE, { connection: "open" });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const element = { src: "", currentTime: 0, duration: 1, play: async () => {}, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
  setAudioFactoryForTest(() => element);
  let player: ReturnType<typeof useAudioStudioPlayer> | undefined;
  function Probe() {
    player = useAudioStudioPlayer({ worldId, productionId: "story", chapterId: "chapter", chapterFile: "chapter", slug: "world", title: "Chapter", connection: "open" });
    return null;
  }
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => player!.play("a".repeat(64), { window: { from: player!.at ?? 0, to: 48000 } }));
    const first = sent.find(message => message.kind === "preview-audio-studio")!;
    assert.equal(first.kind, "preview-audio-studio");
    await act(async () => {
      __applyEventForTest({ type: "audiobook.mix", at: "2026-10-15T12:00:00Z", requestId: first.requestId, worldId, productionId: "story", chapterId: "chapter", mix: { file: "mix.wav", seconds: 1, from: 0 } });
      emitForTest("loadedmetadata"); emitForTest("play");
    });
    await act(async () => { element.currentTime = 1; emitForTest("ended"); });
    assert.equal(player!.at, null); assert.equal(player!.playing, false);
    assert.equal(playbackSnapshot().clip, null);
    assert.ok(sent.some(message => message.kind === "stop-audio-studio-preview" && message.requestId === first.requestId), "natural end releases the server cache pin");
    await act(async () => player!.play("a".repeat(64), { window: { from: player!.at ?? 0, to: 48000 } }));
    const next = sent.filter(message => message.kind === "preview-audio-studio").at(-1)!;
    assert.deepEqual(next.window, { from: 0, to: 48000 }); assert.notEqual(next.requestId, first.requestId);
  } finally {
    await act(async () => root.unmount()); setAudioFactoryForTest(null); __setBridgeForTest(null);
  }
});


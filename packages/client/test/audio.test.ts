import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dismissPlayback,
  emitForTest,
  playbackSnapshot,
  playClip,
  seekTo,
  setAudioFactoryForTest,
  togglePlayback,
} from "../src/lib/audio.js";

function fakeAudio() {
  const calls: string[] = [];
  const element = {
    src: "",
    currentTime: 0,
    duration: NaN,
    play: async () => {
      calls.push(`play:${element.src}`);
    },
    pause: () => calls.push(`pause:${element.src}`),
    load: () => calls.push("load"),
    removeAttribute: (name: string) => {
      calls.push(`remove:${name}`);
      element.src = "";
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { element, calls };
}

const clip = (id: string, url: string) => ({ id, url, title: id });

describe("audio playback controller", () => {
  it("keeps one active clip and stops the prior source", async () => {
    const { element, calls } = fakeAudio();
    setAudioFactoryForTest(() => element as never);
    await playClip(clip("one", "one.wav"));
    await playClip(clip("two", "two.wav"));
    assert.deepEqual(calls, ["pause:", "play:one.wav", "pause:one.wav", "play:two.wav"]);
    setAudioFactoryForTest(null);
  });

  it("detaches the source on dismiss instead of loading an empty src", async () => {
    const { element, calls } = fakeAudio();
    setAudioFactoryForTest(() => element as never);
    await playClip(clip("one", "one.wav"));
    calls.length = 0;
    dismissPlayback();
    assert.deepEqual(calls, ["pause:one.wav", "remove:src", "load"]);
    setAudioFactoryForTest(null);
  });

  it("ignores a media error that arrives after the dock has gone idle", async () => {
    const { element } = fakeAudio();
    setAudioFactoryForTest(() => element as never);
    await playClip(clip("one", "one.wav"));
    dismissPlayback();
    // The abort from detaching the source lands a tick later; it must not resurrect the dock.
    emitForTest("error");
    assert.equal(playbackSnapshot().status, "idle");
    assert.equal(playbackSnapshot().clip, null);
    assert.equal(playbackSnapshot().error, null);
    setAudioFactoryForTest(null);
  });

  it("keeps a decode failure rather than replacing it with the autoplay message", async () => {
    const { element } = fakeAudio();
    // A source that cannot decode fires `error` before play() rejects.
    element.play = async () => {
      emitForTest("error");
      throw new Error("NotSupportedError");
    };
    setAudioFactoryForTest(() => element as never);
    await playClip(clip("bad", "bad.wav"));
    assert.equal(playbackSnapshot().status, "error");
    assert.equal(playbackSnapshot().error, "This audio could not be played.");
    setAudioFactoryForTest(null);
  });

  it("mirrors the element rather than predicting it", async () => {
    const { element, calls } = fakeAudio();
    setAudioFactoryForTest(() => element as never);
    await playClip(clip("one", "one.wav"));
    element.duration = 12;
    emitForTest("loadedmetadata");
    assert.equal(playbackSnapshot().duration, 12);
    element.currentTime = 3;
    emitForTest("timeupdate");
    assert.equal(playbackSnapshot().currentTime, 3);

    // Pausing goes through the element; the store follows the event it emits.
    togglePlayback();
    assert.equal(calls.at(-1), "pause:one.wav");
    emitForTest("pause");

    // Seeking is clamped to the known duration.
    seekTo(99);
    assert.equal(element.currentTime, 12);
    seekTo(-4);
    assert.equal(element.currentTime, 0);
    setAudioFactoryForTest(null);
  });
});

import { loadPlaylist, playPlaylistLine, playlistSnapshot, nextPlaylistLine, setPlaylistRate, setPlaylistSolo, clearPlaylist, restartPlaylistLine } from "../src/lib/audio.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearQueue,
  dismissPlayback,
  emitForTest,
  enqueueClip,
  jumpQueue,
  playbackSnapshot,
  playClip,
  seekTo,
  setAudioFactoryForTest,
  togglePlayback,
} from "../src/lib/audio.js";

function fakeAudio() {
  const calls: string[] = [];
  const element = {
    playbackRate: 1,
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
  it("auditions only the reviewed physical range and bounds keyboard seeking", async () => {
    const { element } = fakeAudio();
    setAudioFactoryForTest(() => element as never);
    const excerpt = { ...clip("excerpt", "source.mp4"), range: { inSec: 3, outSec: 5 } };
    await playClip(excerpt);
    element.duration = 10;
    emitForTest("loadedmetadata");
    assert.equal(element.currentTime, 3);
    seekTo(99); assert.equal(element.currentTime, 5);
    seekTo(0); assert.equal(element.currentTime, 3);
    element.currentTime = 5.1; emitForTest("timeupdate");
    assert.equal(playbackSnapshot().status, "ended");
    await playClip(excerpt); assert.equal(element.currentTime, 3);
    setAudioFactoryForTest(null);
  });
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


describe("table-read playlist uses the existing single element", () => {
  it("advances, changes rate, solos, restarts and relinquishes ownership to ordinary playback", async () => {
    const { element } = fakeAudio(); setAudioFactoryForTest(() => element);
    const items = [0, 1, 2].map(i => ({ ...clip(`table/${i}`, `/${i}.wav`), lineId: `line/${i}`, speakerSheetId: i === 1 ? "bray" : "maren" }));
    loadPlaylist(items); await playPlaylistLine(); assert.equal(element.src, "/0.wav");
    setPlaylistRate(1.25); assert.equal(element.playbackRate, 1.25);
    emitForTest("ended"); await Promise.resolve(); assert.equal(element.src, "/1.wav");
    setPlaylistSolo("maren"); await Promise.resolve(); assert.equal(element.src, "/0.wav");
    nextPlaylistLine(); await Promise.resolve(); assert.equal(element.src, "/2.wav");
    element.currentTime = 3; restartPlaylistLine(); await Promise.resolve(); assert.equal(element.currentTime, 0);
    assert.equal(playlistSnapshot()?.index, 2);
    await playClip(clip("ordinary", "/ordinary.wav")); assert.equal(playlistSnapshot(), null); assert.equal(element.playbackRate, 1);
    clearPlaylist(); assert.equal(playbackSnapshot().clip?.id, "ordinary", "route cleanup cannot dismiss another clip's player");
    setAudioFactoryForTest(null);
  });
  it("clears its active source and reports a failed line before advancing", async () => {
    const { element } = fakeAudio(); setAudioFactoryForTest(() => element);
    loadPlaylist([0, 1].map(i => ({ ...clip(`table/${i}`, `/${i}.wav`), lineId: `${i}`, speakerSheetId: "maren" })));
    await playPlaylistLine(); emitForTest("error"); nextPlaylistLine(); await Promise.resolve();
    assert.match(playlistSnapshot()!.notice, /Skipped.*could not be decoded/);
    clearPlaylist(); assert.equal(playbackSnapshot().status, "idle"); assert.equal(playlistSnapshot(), null);
    setAudioFactoryForTest(null);
  });
});

describe("a page read walks its blocks", () => {
  it("names each block as it plays it, and steps between the ones that exist", async () => {
    const { element } = fakeAudio();
    setAudioFactoryForTest(() => element as never);
    clearQueue();
    const block = (part: number, heading: string) => ({
      id: "page",
      url: `/${heading}.wav`,
      title: `Maren Kest · ${heading}`,
      sub: `read aloud · George · ${part + 1} of 3`,
      part,
    });
    await enqueueClip(block(0, "Essence"));
    assert.equal(playbackSnapshot().clip?.title, "Maren Kest · Essence");
    // The third block lands before the second — a page read on a cloud voice is several jobs
    // and they finish in whatever order they finish.
    await enqueueClip(block(2, "Relationships"));
    emitForTest("ended");
    await Promise.resolve();
    assert.equal(element.src, "/Essence.wav", "a gap waits rather than skipping the block in it");
    await enqueueClip(block(1, "Appearance"));
    assert.equal(element.src, "/Appearance.wav");
    assert.equal(playbackSnapshot().clip?.sub, "read aloud · George · 2 of 3");

    jumpQueue(0);
    await Promise.resolve();
    assert.equal(element.src, "/Essence.wav");
    jumpQueue(9);
    await Promise.resolve();
    assert.equal(element.src, "/Essence.wav", "a block that was never made is not somewhere to skip to");
    setAudioFactoryForTest(null);
  });
});

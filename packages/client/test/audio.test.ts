import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pauseAudio, playAudio, setAudioFactoryForTest, stopAudio } from "../src/lib/audio.js";

describe("audio playback controller", () => {
  it("keeps one active clip and stops the prior source", async () => {
    const calls: string[] = [];
    const listeners = new Map<string, () => void>();
    const fake = {
      src: "", currentTime: 0,
      play: async () => { calls.push(`play:${fake.src}`); },
      pause: () => calls.push(`pause:${fake.src}`),
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    };
    setAudioFactoryForTest(() => fake as never);
    await playAudio("one", "one.wav");
    await playAudio("two", "two.wav");
    pauseAudio();
    stopAudio();
    assert.deepEqual(calls, ["pause:", "play:one.wav", "pause:one.wav", "play:two.wav", "pause:two.wav", "pause:two.wav"]);
    setAudioFactoryForTest(null);
  });
});

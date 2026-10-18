import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveEpisodeArrangement, episodeAudioScript } from "../src/audio-drama-studio.js";
import { resolveAudioArrangement } from "../src/audio-arrangement.js";
import { dramaLineHash, type EpisodeScriptBlock, type EpisodeTakes } from "../src/audio-drama.js";
import type { AudioSource } from "../src/audio-arrangement-schema.js";
import { ulid } from "../src/ids.js";

/** An episode's first arrangement (SPEC-057 R-67, R-68), resolved to where each clip is heard. */
const RATE = 48_000;
const VOICE = { provider: "elevenlabs", model: "m", voiceId: "v" };
type Line = Extract<EpisodeScriptBlock, { kind: "dialogue" }>;
const line = (words: string, extra: Partial<Line> = {}): Line => ({ id: ulid(), kind: "dialogue", speaker: "maren", words, ...extra });
const source = (file: string, seconds: number): AudioSource => ({ file, hash: `sha256:${"0".repeat(64)}`, samples: Math.round(seconds * RATE), rate: RATE, channels: 1, label: file });

/** Each spoken line performed for the seconds given; each cue's sound as long as given. */
function arrange(blocks: EpisodeScriptBlock[], seconds: Record<string, number>, voice: () => typeof VOICE | undefined = () => VOICE) {
  const sources = new Map(Object.entries(seconds).map(([id, length]) => [`artifacts/${id}.wav`, source(`artifacts/${id}.wav`, length)]));
  const lines: EpisodeTakes["lines"] = {};
  for (const block of blocks) {
    if (seconds[block.id] === undefined || (block.kind !== "dialogue" && block.kind !== "narration")) continue;
    lines[block.id] = { kept: { artifactId: `ar_${block.id}` as never, file: `artifacts/${block.id}.wav`, textHash: dramaLineHash(block), voice: VOICE, estimatedMicroUsd: 0, madeAt: "2026-10-18T12:00:00.000Z" } };
  }
  const script = episodeAudioScript("sha256:script", blocks);
  const state = deriveEpisodeArrangement(script, blocks, { version: 1, episode: 1, lines }, (id) => `artifacts/${id}.wav`, sources, (slug) => slug, voice);
  const resolved = resolveAudioArrangement(state, script);
  const at = (id: string) => resolved.clips.find((entry) => entry.clip.id.endsWith(id));
  return { state, resolved, at };
}

describe("codex round 1 on PR 1879", () => {
  it("starts a bed at its cue, ahead of a silence, and runs an ambience to the block it stops before", () => {
    const a = line("Climb."), b = line("Now."), c = line("Down.");
    const bell: EpisodeScriptBlock = { id: ulid(), kind: "sound", heard: "The bell.", soundArtifact: ulid() };
    const wind: EpisodeScriptBlock = { id: ulid(), kind: "ambience", heard: "Wind.", soundArtifact: ulid(), until: bell.id };
    const blocks: EpisodeScriptBlock[] = [{ id: ulid(), kind: "heading", place: "Tower" }, wind, { id: ulid(), kind: "silence", seconds: 1 }, a, b, bell,
      { id: ulid(), kind: "heading", place: "Quay" }, c];
    const { resolved, at } = arrange(blocks, { [a.id]: 1, [b.id]: 1, [c.id]: 1, [(bell as { soundArtifact: string }).soundArtifact]: 0.5, [(wind as { soundArtifact: string }).soundArtifact]: 2 });
    assert.equal(resolved.issues.length, 0, JSON.stringify(resolved.issues));
    assert.deepEqual([at(wind.id)!.at, at(wind.id)!.samples], [0, 3 * RATE], "from its cue, through the silence, to the bell");
    assert.equal(at(a.id)!.at, RATE);
    assert.equal(at(c.id)!.at, 4.3 * RATE, "the bell, then a scene change");
  });

  it("cuts in on the line just before, never before that line starts", () => {
    const a = line("He said—", { cut: true }), b = line("Two.", { overlapsPrevious: true });
    const short = arrange([a, b], { [a.id]: 0.2, [b.id]: 1 });
    assert.equal(short.at(b.id)!.at, 0, "a 0.2 s take is cut in on 0.2 s");
    const missing = line("Wait—", { cut: true }), c = line("Now.", { overlapsPrevious: true });
    const unperformed = arrange([a, missing, c], { [a.id]: 1, [c.id]: 1 });
    assert.equal(unperformed.at(c.id)!.at, RATE, "the broken line has no take, so nothing earlier is overlapped");
  });

  it("hears a scene change after a sound-only cold open", () => {
    const a = line("Climb.");
    const bell: EpisodeScriptBlock = { id: ulid(), kind: "sound", heard: "The bell.", soundArtifact: ulid() };
    const { at } = arrange([{ id: ulid(), kind: "heading", place: "Cold open" }, bell, { id: ulid(), kind: "heading", place: "Tower" }, a],
      { [a.id]: 1, [(bell as { soundArtifact: string }).soundArtifact]: 0.5 });
    assert.equal(at(a.id)!.at, 1.3 * RATE);
  });

  it("leaves out a take in a voice the role no longer has", () => {
    const a = line("Climb.");
    const { at } = arrange([a], { [a.id]: 1 }, () => ({ ...VOICE, voiceId: "recast" }));
    assert.equal(at(a.id), undefined);
  });
});

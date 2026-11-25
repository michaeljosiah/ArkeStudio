import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { currentTakeChecks, MEASURED_WORD_TIMING_ENGINE, type AgentMediaInventory } from "@arke-studio/contracts";
import {
  askedCamera, cameraPath, checkTake, judgeCamera, judgeCuts, judgeLight, judgeSync, judgeWords, spokenWords,
} from "../../src/takes/checks.js";
import type { AgentMediaTools } from "../../src/media/agent-media-tools.js";
import { writeSpeechWav } from "../../src/audio/speech-wav.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/*
 * The checks after a take (design turns 287 and 288c). Each judgement is the fault Gold on Gold's
 * first Wan pass went out with: a dissolve inside take 69, voices nobody wrote after the lines of
 * 69 and 72, fifty takes that drifted and never breathed in a handheld film.
 */

const word = (text: string, startSec: number, probability = .9) => ({ text, startSec, endSec: startSec + .25, probability });

describe("the checks after a take: words", () => {
  it("hears the line as written, whatever its case and stops", () => {
    const { words, voice } = judgeWords("The verse, under the water.", ["the", "verse", "under", "the", "water"].map((w, i) => word(w, .5 + i * .3)));
    assert.deepEqual(words, { id: "words", result: "pass", says: "as written" });
    assert.deepEqual(voice, { id: "unwritten-voice", result: "pass", says: "none" });
  });

  it("says where a voice nobody wrote starts after the line, and where the take could end", () => {
    const heard = [...["ehen"].map(w => word(w, .6)), word("na", 7.6), word("so", 7.9)];
    const { words, voice } = judgeWords("Ehen.", heard);
    assert.equal(words?.result, "pass");
    assert.equal(voice.result, "fix");
    assert.equal(voice.says, "at 7.6 s");
    assert.equal(voice.endAtSec, 7.5, "a little before the voice");
  });

  it("does not take a breath the recogniser was unsure of for a voice", () => {
    const { voice } = judgeWords("Ehen.", [word("ehen", .6), word("ah", 7.6, .2), word("mm", 7.9, .3)]);
    assert.equal(voice.result, "pass");
  });

  it("tells a line spoken wrong, and lets a recogniser's slip pass", () => {
    const line = "The goat was in the boot, Tunde.";
    assert.equal(judgeWords(line, ["the", "goat", "was", "in", "a", "boot", "tunde"].map((w, i) => word(w, i * .3))).words?.result, "pass", "six of seven");
    const wrong = judgeWords(line, ["i", "was", "looking", "at", "the", "bar"].map((w, i) => word(w, i * .3))).words!;
    assert.equal(wrong.result, "fix");
    assert.match(wrong.says, /^heard “i was looking at the bar”$/);
    assert.deepEqual(judgeWords(line, []).words, { id: "words", result: "fix", says: "nothing heard" });
  });

  it("finds a voice in a shot with no line at all", () => {
    const { words, voice } = judgeWords(null, [word("thank", 4.2), word("you", 4.5)]);
    assert.equal(words, null);
    assert.equal(voice.says, "at 4.2 s");
  });

  it("compares words, not their spelling on the page", () => {
    assert.deepEqual(spokenWords("“Ehn-ehn.” He’s IN front!"), ["ehn", "ehn", "he's", "in", "front"]);
  });
});

describe("the checks after a take: cuts, camera, light, sync", () => {
  it("names a cut inside the take, and where to end before a late one", () => {
    assert.deepEqual(judgeCuts([], 8), { id: "cuts-inside", result: "pass", says: "none" });
    assert.deepEqual(judgeCuts([6.2], 8), { id: "cuts-inside", result: "fix", says: "at 6.2 s", endAtSec: 6.1 });
    assert.deepEqual(judgeCuts([1.2, 5], 8), { id: "cuts-inside", result: "fix", says: "2 · first at 1.2 s" });
  });

  it("reads what the shot asked of the camera from its words", () => {
    assert.equal(askedCamera("handheld, gently breathing and drifting; eases closer on the word"), "handheld");
    assert.equal(askedCamera("the camera is locked off and does not move"), "still");
    assert.equal(askedCamera("slow push in"), null);
    assert.equal(askedCamera(undefined), null);
  });

  it("finds the camera's breath and its drift, and holds them against what was asked", () => {
    const breathing = Array.from({ length: 60 }, (_, i) => ({ dx: 1.2 * Math.cos(i * 1.3), dy: .8 * Math.sin(i * 1.7) }));
    const drifting = Array.from({ length: 60 }, () => ({ dx: .05, dy: 0 }));
    const still = Array.from({ length: 60 }, () => ({ dx: 0, dy: 0 }));
    assert.match(judgeCamera(breathing, 256, "handheld").says, /^handheld · \d+ px$/);
    assert.equal(judgeCamera(breathing, 256, "handheld").result, "pass");
    const drift = judgeCamera(drifting, 256, "handheld");
    assert.equal(drift.result, "fix", "Gold on Gold: drifted and never breathed");
    assert.match(drift.says, /^drifts \d+ px, no breath$/);
    assert.deepEqual(judgeCamera(still, 256, "handheld"), { id: "camera", result: "fix", says: "still · asked handheld" });
    assert.equal(judgeCamera(breathing, 256, "still").result, "fix");
    assert.deepEqual(judgeCamera(still, 256, null), { id: "camera", result: "pass", says: "still" });
  });

  it("measures how far the picture moved between two frames, to a fraction of a pixel", () => {
    const width = 128, height = 72;
    const texture = (shift: number) => {
      const frame = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const u = x + shift;
        frame[y * width + x] = Math.round(128 + 50 * Math.sin(u * .31) * Math.cos(y * .27) + 25 * Math.sin(u * .11 + y * .07));
      }
      return frame;
    };
    const [step] = cameraPath([texture(0), texture(3)], width, height);
    assert.ok(Math.abs(Math.abs(step!.dx) - 3) < .35, `moved ${step!.dx}`);
    assert.ok(Math.abs(step!.dy) < .35);
  });

  it("reads a black hold or a fade as a camera that did not move (codex on PR 3306)", () => {
    const width = 256, height = 144, flat = Array.from({ length: 60 }, () => new Uint8Array(width * height).fill(30));
    const steps = cameraPath(flat, width, height);
    assert.ok(steps.every(step => step.dx === 0 && step.dy === 0));
    assert.deepEqual(judgeCamera(steps, width, "still"), { id: "camera", result: "pass", says: "still" });
  });

  it("holds the light against the shots either side", () => {
    assert.equal(judgeLight({ first: 100, last: 100 }, null, null), null);
    assert.deepEqual(judgeLight({ first: 100, last: 104 }, { number: 12, last: 96 }, { number: 14, first: 110 }),
      { id: "light", result: "pass", says: "as shots 12 and 14" });
    assert.deepEqual(judgeLight({ first: 60, last: 100 }, { number: 12, last: 110 }, null), { id: "light", result: "fix", says: "darker than shot 12" });
  });

  it("says how far the take's voice sits from the read it was sent", () => {
    assert.deepEqual(judgeSync({ lagSec: .01, follows: true }), { id: "lip-sync", result: "pass", says: "10 ms" });
    assert.deepEqual(judgeSync({ lagSec: .12, follows: true }), { id: "lip-sync", result: "fix", says: "late 120 ms" });
    assert.deepEqual(judgeSync({ lagSec: null, follows: false }), { id: "lip-sync", result: "fix", says: "does not follow the read" });
  });
});

const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const W = 256, H = 144, CUT_AT = 3;
/** The take: a textured room the camera sways across as a hand holds it, cut at 3 s to another. */
const swayFrame = (i: number) => {
  const t = i / 10, sway = 3 * Math.sin(2 * Math.PI * t / 1.1), lift = 2 * Math.sin(2 * Math.PI * t / 1.7), other = t >= CUT_AT;
  const frame = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x + sway, v = y + lift;
    frame[y * W + x] = Math.max(0, Math.min(255, Math.round(other ? 128 + 60 * Math.sin(u * .19 + v * .05) * Math.sin(v * .33)
      : 128 + 50 * Math.sin(u * .31) * Math.cos(v * .27) + 25 * Math.sin(u * .11 + v * .07))));
  }
  return frame;
};

/**
 * Shot 12 of the fixture's Saltlight (a voice-over line) with a new clip, and shot 13 after it
 * with a chosen take that opens dark. The clip's sound stops at 5.5 s of its 6 s picture, and a
 * read of it past there is refused, as the native decoder refuses one (codex on PR 3306).
 */
async function landed(options: { soundKind?: string } = {}) {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir); closeOnCleanup(() => store.close());
  const scenePath = "productions/saltlight/scenes/04-the-verse-rises.json", sceneRaw = await readFile(join(dir, scenePath));
  const scene = JSON.parse(sceneRaw.toString("utf8"));
  scene.shots = scene.shots.map((shot: { id: string; audio?: object }) => (shot.id === "sh_12" && options.soundKind ? { ...shot, audio: { ...shot.audio, kind: options.soundKind } } : shot));
  const sceneEdit = options.soundKind ? [{ path: scenePath, action: "replace" as const, baseHash: sha(sceneRaw), content: JSON.stringify(scene, null, 2) }] : [];
  {
    const clip = Buffer.from("CLIP fixture"), next = Buffer.from("NEXT fixture");
    const base = JSON.parse(await readFile(join(dir, "productions/saltlight/takes/tk_01J8C0000000000000000000C3/take.json"), "utf8"));
    const takeId = "tk_01M8CHECK00000000000000001", nextId = "tk_01M8CHECK00000000000000002";
    const take = { ...base, id: takeId, coversShots: ["sh_12"], mediaHash: sha(clip) };
    const neighbour = { ...base, id: nextId, coversShots: ["sh_13"], mediaHash: sha(next) };
    const selectionsRaw = await readFile(join(dir, "productions/saltlight/selections.json")), selections = JSON.parse(selectionsRaw.toString("utf8"));
    await store.commit({ kind: "media-fixture", source: "test", files: [
      { path: `productions/saltlight/takes/${takeId}/take.json`, action: "create", baseHash: null, content: JSON.stringify(take) },
      { path: `productions/saltlight/takes/${takeId}/clip.mp4`, action: "create", baseHash: null, encoding: "base64", content: clip.toString("base64") },
      { path: `productions/saltlight/takes/${nextId}/take.json`, action: "create", baseHash: null, content: JSON.stringify(neighbour) },
      { path: `productions/saltlight/takes/${nextId}/clip.mp4`, action: "create", baseHash: null, encoding: "base64", content: next.toString("base64") },
      { path: "productions/saltlight/selections.json", action: "replace", baseHash: sha(selectionsRaw),
        content: JSON.stringify({ ...selections, sh_13: { acceptedTakeId: nextId } }) },
      ...sceneEdit,
    ] });
    const SOUND_SEC = 5.5;
    const inventory: AgentMediaInventory = { durationSec: 6, streams: [
      { index: 0, kind: "video", codec: "fixture", width: 1280, height: 720, frameRate: "24/1", durationSec: 6, startTimeSec: 0 },
      { index: 1, kind: "audio", codec: "fixture", sampleRate: 32000, channels: 2, durationSec: SOUND_SEC, startTimeSec: 0 },
    ] };
    const isNext = async (path: string) => (await readFile(path)).equals(next);
    const tools: AgentMediaTools = {
      version: async () => "fixture", probeVersion: async () => "fixture", probe: async () => inventory,
      frame: async () => { throw new Error("no stills in this fixture"); },
      audio: async () => { throw new Error("no channel QC in this fixture"); },
      speechAudio: async (_path, _stream, startSec, endSec) => {
        if (endSec > SOUND_SEC + .025) throw new Error("decoded audio fell short of the interval");
        return { bytes: writeSpeechWav({ rate: 16000, samples: new Float32Array(Math.round((endSec - startSec) * 16000)) }), durationSec: Math.round((endSec - startSec) * 16000) / 16000 };
      },
      grayFrames: async (path, _stream, startSec, endSec, options) => {
        const count = Math.max(1, Math.round((endSec - startSec) * (options.fps ?? 10)));
        // The next shot opens dark: a level the take's last frame is well above.
        if (await isNext(path)) return { frames: Array.from({ length: count }, () => new Uint8Array(64 * 36).fill(40)), width: 64, height: 36, fps: options.fps };
        return { frames: Array.from({ length: count }, (_, i) => swayFrame(Math.round(startSec * 10) + i)), width: W, height: H, fps: options.fps };
      },
    };
    const heard = ["the", "verse", "under", "the", "water"].map((w, i) => word(w, .5 + i * .3)).concat([word("listen", 4.8), word("here", 5.1)]);
    const ports = {
      tools, now: () => "2026-11-25T12:00:00.000Z",
      speech: async (bytes: Uint8Array) => ({ text: heard.map(w => w.text).join(" "), seconds: (bytes.length - 44) / 2 / 16000,
        engine: { id: MEASURED_WORD_TIMING_ENGINE, version: "1", model: "base-en" }, words: heard }),
    };
    return { store, take, tools, ports, takeId };
  }
}

describe("a take checked when it lands", () => {
  it("measures a clip of a shot with a line, records it beside the take, and the scan reads it back", async () => {
    const { store, take, tools, ports, takeId } = await landed();
    const result = await checkTake(store, "saltlight", takeId, ports, new AbortController().signal);
    assert.equal(result, "checked");
    const record = currentTakeChecks(store.getBundle().productions.find(p => p.meta.id === "saltlight")!, take)!;
    assert.ok(record, "the scan read the record back, current for the take's media");
    const by = Object.fromEntries(record.items.map(item => [item.id, item]));
    assert.deepEqual(record.items.map(item => item.id), ["words", "unwritten-voice", "cuts-inside", "camera", "light"], "in the list's order");
    assert.equal(by["words"]!.says, "as written");
    assert.equal(by["unwritten-voice"]!.result, "fix");
    assert.equal(by["unwritten-voice"]!.says, "at 4.8 s");
    assert.equal(by["cuts-inside"]!.result, "fix");
    assert.equal(by["cuts-inside"]!.says, "at 3.0 s");
    assert.match(by["camera"]!.says, /^handheld · \d+ px$/, "the sway is a hand's");
    assert.deepEqual(by["light"], { id: "light", result: "fix", says: "brighter than shot 2" });
    assert.deepEqual(record.skipped, [{ id: "lip-sync", reason: "no-voice-sent" }]);
    // A clip that is not a take of one shot is passed over.
    assert.equal(await checkTake(store, "saltlight", "tk_01J8A0000000000000000000A1", { tools, now: () => "2026-11-25T12:00:00.000Z" }, new AbortController().signal), "not-checkable");
  });

  it("does not hold a song's words against a shot whose sound is the song", async () => {
    const { store, take, ports, takeId } = await landed({ soundKind: "music" });
    assert.equal(await checkTake(store, "saltlight", takeId, ports, new AbortController().signal), "checked");
    const record = currentTakeChecks(store.getBundle().productions.find(p => p.meta.id === "saltlight")!, take)!;
    assert.deepEqual(record.items.map(item => item.id), ["cuts-inside", "camera", "light"]);
    assert.deepEqual(record.skipped.filter(item => item.id !== "lip-sync"), [{ id: "words", reason: "sung" }, { id: "unwritten-voice", reason: "sung" }]);
  });

  it("measures a segment of a pass over its own range, its times from the segment's start (0.5.135)", async () => {
    const { store, ports } = await landed();
    const dir = store.dir, passBytes = Buffer.from("PASS fixture");
    const base = JSON.parse(await readFile(join(dir, "productions/saltlight/takes/tk_01J8C0000000000000000000C3/take.json"), "utf8"));
    const passId = "tk_01M8CHECK00000000000000003", segmentId = "tk_01M8CHECK00000000000000004";
    const { media: _media, ...unfiled } = base;
    const pass = { ...base, id: passId, coversShots: ["sh_12", "sh_13"], mediaHash: sha(passBytes) };
    const segment = { ...unfiled, id: segmentId, coversShots: ["sh_12"], segment: { passTakeId: passId, inSec: 2, outSec: 6 } };
    await store.commit({ kind: "media-fixture", source: "test", files: [
      { path: `productions/saltlight/takes/${passId}/take.json`, action: "create", baseHash: null, content: JSON.stringify(pass) },
      { path: `productions/saltlight/takes/${passId}/clip.mp4`, action: "create", baseHash: null, encoding: "base64", content: passBytes.toString("base64") },
      { path: `productions/saltlight/takes/${segmentId}/take.json`, action: "create", baseHash: null, content: JSON.stringify(segment) },
    ] });
    assert.equal(await checkTake(store, "saltlight", passId, ports, new AbortController().signal), "not-checkable", "a pass covers two shots");
    assert.equal(await checkTake(store, "saltlight", segmentId, ports, new AbortController().signal), "checked");
    const production = store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
    const record = currentTakeChecks(production, production.takes.find(t => t.id === segmentId)!)!;
    assert.equal(record.sourceHash, sha(passBytes), "fenced on the pass's clip");
    assert.deepEqual(record.items.find(item => item.id === "cuts-inside"), { id: "cuts-inside", result: "fix", says: "at 1.0 s" }, "the pass's cut at 3 s is 1 s into the segment that starts at 2");
  });

  it("keeps the picture's checks when the sound cannot be read", async () => {
    const { store, take, tools, ports, takeId } = await landed();
    const refused = { ...ports, tools: { ...tools, speechAudio: async () => { throw new Error("decoder refused"); } } };
    assert.equal(await checkTake(store, "saltlight", takeId, refused, new AbortController().signal), "checked");
    const record = currentTakeChecks(store.getBundle().productions.find(p => p.meta.id === "saltlight")!, take)!;
    assert.deepEqual(record.items.map(item => item.id), ["cuts-inside", "camera", "light"]);
    assert.ok(record.skipped.some(item => item.id === "words" && item.reason === "unavailable"));
  });

  it("reads the newest line for a take and reports a damaged one without losing the rest", async () => {
    const dir = await makeTempWorld();
    const line = (says: string, ts: string) => JSON.stringify({ schemaVersion: 1, kind: "after-take", ts, takeId: "tk_01J8C0000000000000000000C3", shotId: "sh_12",
      sourceHash: "sha256:00000000", items: [{ id: "cuts-inside", result: "pass", says }], skipped: [] });
    await writeFile(join(dir, "productions/saltlight/take-checks.jsonl"), `${line("none", "2026-11-25T10:00:00.000Z")}\nnot json\n${line("still none", "2026-11-25T11:00:00.000Z")}\n`);
    const store = await WorldStore.open(dir); closeOnCleanup(() => store.close());
    const production = store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
    assert.equal(production.takeChecks?.["tk_01J8C0000000000000000000C3"]?.items[0]?.says, "still none");
    assert.ok(store.getBundle().problems.some(problem => problem.path === "productions/saltlight/take-checks.jsonl" && /line 2/.test(problem.message)));
  });
});

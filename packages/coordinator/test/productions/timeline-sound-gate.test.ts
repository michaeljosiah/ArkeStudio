import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, ProductionTimelineSchema, SOUND_GATE, storyTimelineFingerprint, type AgentMediaInventory, type ConversationId, type ModelEditorRequest,
  type TimelineCommand } from "@arke-studio/contracts";
import { writeSpeechWav } from "../../src/audio/speech-wav.js";
import type { AgentMediaTools } from "../../src/media/agent-media-tools.js";
import { decideEditorRequest, EditorRequestRefused, previewProductionEditorRequest, stageEditorRequests } from "../../src/productions/editor-requests.js";
import { applyHumanTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { carriesSoundGate, carriesSoundLevels } from "../../src/productions/timeline-record.js";
import { measureEditorRequestSound, measureTimelineSound } from "../../src/productions/timeline-sound.js";
import { EDITOR_SOUND_GATE_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * A gate and a clip set to a loudness are measured before anything is written (SPEC-038
 * R-57..R-60). The decoder here is a stand-in that answers from samples the test made, so what is
 * asserted is the coordinator's part: which file is read and how much of it, what the measured
 * command is, what is refused and in what words, and what the world is raised to.
 * `sound-gate-native.test.ts` runs the same measurement and the export's graph on real FFmpeg.
 */

const AT = "2026-11-26T12:00:00.000Z", PRODUCTION = "saltlight", RATE = 16_000;
const relativeTimeline = `productions/${PRODUCTION}/timeline.json`, relativeRequests = `productions/${PRODUCTION}/editor-requests.json`;
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const signal = () => new AbortController().signal;

/** A take's own sound: a room that is never silent, near -50 dBFS, and a voice near -20 wherever `lines` says. */
function takeSound(seconds: number, lines: Array<[number, number]>): Float32Array {
  let state = 7;
  const noise = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2147483648 - 1; };
  const samples = new Float32Array(Math.round(seconds * RATE)).map(() => .0055 * noise());
  for (const [from, to] of lines) for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) samples[i]! += .15 * Math.sin(2 * Math.PI * 220 * i / RATE);
  return samples;
}
const LINES: Array<[number, number]> = [[1.5, 2.6], [3.4, 4.8]];

/** The decoder: it answers from `sound`, and records what it was asked for. */
function decoder(sound: Float32Array, options: { seconds?: number; lufs?: number | null } = {}) {
  const reads: Array<[number, number, number]> = [], loud: Array<[number, number]> = [], paths: string[] = [], heardAs: unknown[] = [], seconds = options.seconds ?? sound.length / RATE;
  const inventory: AgentMediaInventory = { durationSec: seconds, streams: [{ index: 0, kind: "audio", codec: "pcm_s16le", sampleRate: RATE, channels: 1, durationSec: seconds, startTimeSec: 0 }] };
  const tools: Pick<AgentMediaTools, "probe" | "monoAudio" | "loudness"> = {
    probe: async path => { paths.push(path); return inventory; },
    monoAudio: async (_path, _stream, from, to, rate) => { reads.push([from, to, rate]); return sound.slice(Math.round(from * rate), Math.round(to * rate)); },
    loudness: async (_path, _stream, from, to, _stop, as) => { loud.push([from, to]); heardAs.push(as);
      return { integratedLufs: options.lufs === undefined ? -27.4 : options.lufs, rangeLu: 3, truePeakDbtp: -12, shortTermMaxLufs: -25 }; },
  };
  return { tools, reads, loud, paths, heardAs };
}

/** A still on the Picture track and a take's line on a Voice track, a second into its file, two seconds into the film. */
async function placed() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => AT }); closeOnCleanup(() => store.close());
  const sound = takeSound(6, LINES), bytes = writeSpeechWav({ rate: RATE, samples: sound }), line = newId("ar");
  await store.commit({ kind: "media-fixture", source: "test", files: [
    { path: "artifacts/line.wav", action: "create", baseHash: null, encoding: "base64", content: Buffer.from(bytes).toString("base64") },
    { path: "artifacts/line.json", action: "create", baseHash: null, content: JSON.stringify({ id: line, kind: "audio", file: "line.wav", hash: hash(bytes), links: [], origin: { by: "user" }, created: AT }) },
  ] });
  const production = store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!, still = store.getBundle().artifacts.find(value => value.kind === "board")!;
  const voice = (id: string, startFrame: number, durationFrames: number) => ({ kind: "place" as const, trackId: "tr_voice" as const,
    clip: { id, startFrame, durationFrames, sourceInFrames: 24, source: { kind: "artifact" as const, artifactId: line, label: "Tunde's line" } } });
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production), commands: [
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 240, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } },
    { kind: "add-track", trackId: "tr_voice", trackKind: "dialogue", name: "Voice" }, voice("cl_line", 48, 96) as TimelineCommand] });
  const raw = () => readFile(join(store.dir, relativeTimeline), "utf8");
  const read = async () => ProductionTimelineSchema.parse(JSON.parse(await raw()));
  const send = async (commands: TimelineCommand[]) => applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: (await read()).revision,
    sourceFingerprint: storyTimelineFingerprint(production), commands });
  const version = async () => (await readWorldMeta(store.dir)).schemaVersion;
  const clip = async (id = "cl_line") => (await read()).tracks.flatMap(track => track.clips).find(value => value.id === id)!;
  const measure = (commands: TimelineCommand[], tools: ReturnType<typeof decoder>["tools"] | undefined) => measureTimelineSound(store, PRODUCTION, commands, tools, signal());
  return { store, sound, bytes, voice, raw, read, send, version, clip, measure, rate: (await read()).frameRate };
}

test("a gate asked for is measured from the clip's whole file, off a private copy, and written as what was measured", async () => {
  const { store, sound, bytes, raw, read, send, version, clip, measure } = await placed(), d = decoder(sound);
  const seen: Uint8Array[] = [], probe = d.tools.probe;
  d.tools.probe = async (path, stop) => { seen.push(await readFile(path)); return probe(path, stop); };

  const measured = await measure([{ kind: "sound-gate", clipId: "cl_line", on: true }], d.tools);
  assert.equal(measured.length, 1);
  const gate = measured[0]!.kind === "sound-gate" ? measured[0]!.gate! : assert.fail("the command is still a gate");
  assert.deepEqual(gate.open, LINES, "kept where the voice stands over the room, in seconds of the file");
  assert.ok(gate.thresholdDb > -43.5 && gate.thresholdDb < -41, `8 dB over a room near -50 dBFS, not ${gate.thresholdDb}`);
  // The whole file, though the clip plays four seconds of it: trimmed wider later, it is still gated by what was measured.
  assert.deepEqual(d.reads, [[0, 6, RATE]]);
  assert.deepEqual(d.loud, [], "a gate measures no loudness");
  assert.equal(d.paths.length, 1);
  assert.ok(!d.paths[0]!.startsWith(store.dir), "the decoder never opens a path in the world");
  assert.deepEqual(seen[0], Buffer.from(bytes), "and what it opens is the verified file");

  // Nothing is written by measuring, and the world is raised by the write that follows it.
  assert.equal(carriesSoundGate(await raw()), false);
  assert.ok(await version() < EDITOR_SOUND_GATE_SCHEMA_VERSION);
  await send(measured);
  assert.deepEqual((await clip()).soundGate, gate);
  assert.equal(await version(), EDITOR_SOUND_GATE_SCHEMA_VERSION);
  await assert.rejects(readWorldMeta(store.dir, { supports: EDITOR_SOUND_GATE_SCHEMA_VERSION - 1 }), /newer Arke Studio/);
  const lines = (await readFile(join(store.dir, "changes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const raised = lines.find(line => line.entity === "world" && line.toVersion === EDITOR_SOUND_GATE_SCHEMA_VERSION), written = lines.filter(line => line.path === relativeTimeline).at(-1);
  assert.ok(written && raised);
  assert.equal(written.commitId, raised.commitId, "an older build never sees the gate without the boundary");

  // Measured again from the same sound it is the gate it was; Undo takes it off and Redo holds it.
  await assert.rejects(async () => send(await measure([{ kind: "sound-gate", clipId: "cl_line", on: true }], d.tools)), TimelineCommandRefused);
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: (await read()).revision });
  assert.equal("soundGate" in await clip(), false);
  assert.equal(carriesSoundGate(await raw()), true, "Redo still holds the gate");
  assert.equal(await version(), EDITOR_SOUND_GATE_SCHEMA_VERSION);
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "redo", baseRevision: (await read()).revision });
  assert.deepEqual((await clip()).soundGate, gate);
  // Off needs no measurement, and no decoder.
  await send(await measure([{ kind: "sound-gate", clipId: "cl_line", on: false }], undefined));
  assert.equal("soundGate" in await clip(), false);
});

test("a long file is read a minute at a time, a file past ten minutes is not gated, and commands with nothing to measure pass untouched", async () => {
  const { sound, measure } = await placed(), long = decoder(sound, { seconds: 150 });
  await measure([{ kind: "sound-gate", clipId: "cl_line", on: true }], long.tools);
  assert.deepEqual(long.reads, [[0, 60, RATE], [60, 120, RATE], [120, 150, RATE]]);
  await assert.rejects(measure([{ kind: "sound-gate", clipId: "cl_line", on: true }], decoder(sound, { seconds: SOUND_GATE.maxSourceSec + 30 }).tools),
    (error: unknown) => error instanceof TimelineCommandRefused && error.reason === "A gate is measured from sound up to 10 minutes long; this is 11");
  const plain: TimelineCommand[] = [{ kind: "set-clip-gain", clipId: "cl_line", gainDb: -3 }, { kind: "sound-fade", clipId: "cl_line", inFrames: 12 }];
  const idle = decoder(sound);
  assert.deepEqual(await measure(plain, idle.tools), plain);
  assert.deepEqual(await measure(plain, undefined), plain, "and need no decoder");
  assert.deepEqual([idle.reads, idle.loud, idle.paths], [[], [], []]);
});

test("a clip set to a loudness becomes the gain that reaches it, measured over the stretch the clip plays", async () => {
  const { sound, send, clip, measure, voice, rate, raw } = await placed(), d = decoder(sound);
  const loud = (lufs: number, clipId: `cl_${string}` = "cl_line"): TimelineCommand => ({ kind: "match-loudness", clipId, lufs });
  assert.deepEqual(await measure([loud(-20)], d.tools), [{ kind: "set-clip-gain", clipId: "cl_line", gainDb: 7.4 }]);
  // A second into the file, for as long as the clip plays: the line it plays, not the take around it.
  assert.deepEqual(d.loud, [[24 / rate, 24 / rate + 96 / rate]]);
  assert.deepEqual(d.heardAs, ["film"], "as the film plays it: a take in one channel is 3 LU louder there than its file measures");
  assert.deepEqual(d.reads, [], "a loudness decodes no samples here");
  // What plays is the clip's gain and its track's level together, so the track's level is in the sum.
  await send([{ kind: "set-track", trackId: "tr_voice", levelDb: -3 }]);
  assert.deepEqual(await measure([loud(-20)], d.tools), [{ kind: "set-clip-gain", clipId: "cl_line", gainDb: 10.4 }]);
  await send(await measure([loud(-20)], d.tools));
  assert.equal((await clip()).gainDb, 10.4);
  assert.equal(carriesSoundGate(await raw()), false, "a loudness is a gain on the record: an older build reads it");

  // Said, not clamped; and each sound that cannot be measured says why.
  const refused = async (commands: TimelineCommand[], tools: ReturnType<typeof decoder>["tools"] | undefined, reason: string | RegExp) =>
    assert.rejects(measure(commands, tools), (error: unknown) => error instanceof TimelineCommandRefused && (typeof reason === "string" ? error.reason === reason : reason.test(error.reason)), String(reason));
  await refused([loud(-10)], decoder(sound, { lufs: -30.4 }).tools, "Tunde's line measures -30.4 LUFS: -10 LUFS would take a gain of +23.4 dB, and a clip's gain is -60 to +12");
  await refused([loud(-20)], decoder(sound, { lufs: null }).tools, "Tunde's line is too quiet to measure a loudness from");
  await send([voice("cl_blip", 200, 6) as TimelineCommand]);
  await refused([loud(-20, "cl_blip")], d.tools, "Tunde's line plays too little sound to measure a loudness from");
  await refused([loud(-20, "cl_still")], d.tools, "Choose a clip on an audio track");
  await refused([{ kind: "sound-gate", clipId: "cl_still", on: true }], d.tools, "Choose a clip on an audio track");
  await refused([loud(-20, "cl_gone")], d.tools, "cl_gone is not on the timeline");
  await refused([loud(-20)], undefined, "Sound cannot be measured on this host, so a gate or a loudness cannot be set here");
  await refused([{ kind: "sound-gate", clipId: "cl_line", on: true }], { probe: d.tools.probe }, /^Sound cannot be measured on this host/);

  // A clip placed earlier in the same batch is found, and what was not measured is never applied.
  const batch = await measure([voice("cl_new", 150, 48) as TimelineCommand, { kind: "sound-gate", clipId: "cl_new", on: true }, loud(-23, "cl_new")], d.tools);
  assert.deepEqual(batch.map(command => command.kind), ["place", "sound-gate", "set-clip-gain"]);
  assert.deepEqual(batch[1]!.kind === "sound-gate" ? batch[1]!.gate?.open : null, LINES);
  assert.deepEqual(batch[2], { kind: "set-clip-gain", clipId: "cl_new", gainDb: 7.4 }, "on the Voice track at -3 dB: -23 less -27.4, less the track's level");
  const before = await raw();
  await assert.rejects(send([{ kind: "sound-gate", clipId: "cl_line", on: true }]), /A gate is measured from the clip's sound before it is set/);
  await assert.rejects(send([loud(-20)]), /set to a loudness by measuring it first/);
  assert.equal(await raw(), before);
});

test("a file that is gone or is no longer the one the world recorded is refused in plain words", async () => {
  const { store, sound, measure } = await placed(), d = decoder(sound);
  await writeFile(join(store.dir, "artifacts", "line.wav"), "changed");
  await assert.rejects(measure([{ kind: "sound-gate", clipId: "cl_line", on: true }], d.tools),
    (error: unknown) => error instanceof TimelineCommandRefused && error.reason === "Tunde's line's sound file is missing or has changed, so it cannot be measured");
  assert.deepEqual(d.paths, [], "nothing is decoded from a file that is not the one recorded");
});

test("the floor is read from a clip, from Undo and Redo and from a request, and never from a gain or typed words", () => {
  const gate = { thresholdDb: -42, open: [[1, 2]] }, gated = { id: "cl_line", soundGate: gate };
  const carried: Array<[string, unknown]> = [
    ["a gate on a clip", { tracks: [{ kind: "dialogue", clips: [gated] }] }],
    ["a gate that kept nothing", { tracks: [{ kind: "dialogue", clips: [{ id: "cl_line", soundGate: { thresholdDb: -6, open: [] } }] }] }],
    ["a gate in Undo", { tracks: [], history: { undo: [{ kind: "change", clips: [{ before: gated, after: { id: "cl_line" } }] }], redo: [] } }],
    ["a gate in Redo", { tracks: [], history: { undo: [], redo: [{ kind: "change", clips: [{ before: { id: "cl_line" }, after: gated }] }] } }],
    ["a request's gate", { schemaVersion: 1, requests: [{ commands: [{ kind: "sound-gate", clipId: "cl_line", on: true, gate }] }] }],
    ["a request that takes one off", { schemaVersion: 1, requests: [{ commands: [{ kind: "sound-gate", clipId: "cl_line", on: false }] }] }],
    ["a request's placed clip", { schemaVersion: 1, requests: [{ commands: [{ kind: "place", trackId: "tr_voice", clip: gated }] }] }],
  ];
  for (const [where, value] of carried) assert.equal(carriesSoundGate(JSON.stringify(value)), true, where);
  const plain: Array<[string, unknown]> = [
    ["a clip's own gain", { tracks: [{ kind: "dialogue", clips: [{ id: "cl_line", gainDb: 7.4 }] }] }],
    ["a loudness as it is recorded", { schemaVersion: 1, requests: [{ commands: [{ kind: "set-clip-gain", clipId: "cl_line", gainDb: 7.4 }] }] }],
    ["a track's level", { tracks: [{ id: "tr_voice", kind: "dialogue", levelDb: -3, clips: [] }] }],
    ["words that say it", { tracks: [{ kind: "picture", clips: [{ source: { kind: "text", text: "soundGate sound-gate match-loudness", label: "soundGate" } }] }] }],
    ["a summary that says it", { schemaVersion: 1, requests: [{ summary: "sound-gate on, match-loudness -20", commands: [{ kind: "set-clip-gain", clipId: "cl_line", gainDb: -3 }] }] }],
  ];
  for (const [where, value] of plain) assert.equal(carriesSoundGate(JSON.stringify(value)), false, where);
  assert.equal(carriesSoundLevels(JSON.stringify(carried[0]![1])), false, "a gate is its own floor, above a track's level");
  assert.equal(carriesSoundGate("not json"), false);
});

test("Arke's request is measured before it is checked: its card says what the gate keeps, and Accept applies what was measured", async () => {
  const { store, sound, raw, version, clip } = await placed(), d = decoder(sound);
  const asked: ModelEditorRequest = { summary: "Cut the room under Tunde's line", commands: [{ kind: "sound-gate", clipId: "cl_line", on: true }, { kind: "match-loudness", clipId: "cl_line", lufs: -20 }] };
  const before = await raw();
  // As written, no reducer will set it: the dry run that checks a turn's requests refuses the unmeasured command.
  assert.deepEqual(previewProductionEditorRequest(store, PRODUCTION, asked, AT), { ok: false, reason: "A gate is measured from the clip's sound before it is set" });

  const [measured] = await measureEditorRequestSound(store, PRODUCTION, [asked], d.tools, signal());
  assert.deepEqual(measured!.commands.map(command => command.kind), ["sound-gate", "set-clip-gain"]);
  assert.equal(measured!.summary, asked.summary);
  const preview = previewProductionEditorRequest(store, PRODUCTION, measured!, AT);
  assert.equal(preview.ok, true, preview.ok ? "" : preview.reason);
  if (preview.ok) assert.match(preview.digest.effects.map(effect => effect.detail ?? "").join("\n"), /-> tr_voice, frames 48-144, source 24-120, 7\.4 dB, gate keeps 2 stretches/);
  assert.equal(await raw(), before, "measuring and previewing write nothing");

  // A request with nothing to measure, or in a thread about no production, is handed back as it came.
  const plain: ModelEditorRequest[] = [{ summary: "Lower the line", commands: [{ kind: "set-clip-gain", clipId: "cl_line", gainDb: -3 }] }], elsewhere = [asked], idle = decoder(sound);
  assert.equal(await measureEditorRequestSound(store, PRODUCTION, plain, idle.tools, signal()), plain);
  assert.equal(await measureEditorRequestSound(store, null, elsewhere, idle.tools, signal()), elsewhere);
  assert.deepEqual([idle.reads, idle.loud], [[], []]);
  // A refusal names the request, as one that cannot apply is named, so the model reads which of its two it was.
  await assert.rejects(measureEditorRequestSound(store, PRODUCTION, [plain[0]!, { summary: "Bring the line right up", commands: [{ kind: "match-loudness", clipId: "cl_line", lufs: -10 }] }], decoder(sound, { lufs: -30.4 }).tools, signal()),
    (error: unknown) => error instanceof EditorRequestRefused && error.reason === "\"Bring the line right up\" cannot apply: Tunde's line measures -30.4 LUFS: -10 LUFS would take a gain of +20.4 dB, and a clip's gain is -60 to +12");

  // Staged as measured: the request's file raises the world, and Accept decodes nothing.
  assert.ok(await version() < EDITOR_SOUND_GATE_SCHEMA_VERSION);
  const [request] = await stageEditorRequests(store, { conversationId: newId("cv") as ConversationId, entryContext: { kind: "production", productionId: PRODUCTION }, requests: [measured!], now: AT });
  assert.equal(carriesSoundGate(await readFile(join(store.dir, relativeRequests), "utf8")), true);
  assert.equal(await version(), EDITOR_SOUND_GATE_SCHEMA_VERSION);
  const decoded = d.reads.length + d.loud.length;
  await decideEditorRequest(store, { productionId: PRODUCTION, requestId: request!.id, decision: "accept", now: AT });
  assert.deepEqual([(await clip()).soundGate?.open, (await clip()).gainDb], [LINES, 7.4]);
  assert.equal(d.reads.length + d.loud.length, decoded);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioLevelAt, buildCanonicalAudioGraph, buildRenderPlan, DEFAULT_MIX, newId, ProductionTimelineSchema, SOUND_GATE, storyTimelineFingerprint,
  type ExportPlan, type RenderAudioItem, type TimelineCommand } from "@arke-studio/contracts";
import { createAgentMediaTools } from "../../src/media/agent-media-tools.js";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-host.js";
import { applyHumanTimelineCommand } from "../../src/productions/timeline.js";
import { measureTimelineSound } from "../../src/productions/timeline-sound.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * A gate and a loudness on real FFmpeg (SPEC-038 R-57..R-59, R-42). Two things a stand-in decoder
 * cannot show: that the export's graph plays a gated clip at the level `audioLevelAt` states, and
 * that a take's sound measured by the real decoder gives the stretches its voice is in and the
 * gain that brings its line to the loudness asked for.
 */

const ffmpeg = process.env["ARKE_FFMPEG"] ?? "ffmpeg";
const media = createNodeMediaProcessRunner({ ffmpeg, ffprobe: process.env["ARKE_FFPROBE"] ?? "ffprobe" }), tools = createAgentMediaTools(media);
const signal = () => new AbortController().signal;
const version = await media.run("ffmpeg", ["-version"], { signal: signal(), timeoutMs: 10000, maxStdoutBytes: 65536, maxStderrBytes: 16384 });
const available = version.code === 0;

async function run(args: string[]): Promise<Uint8Array> {
  const result = await media.run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], {
    signal: signal(), timeoutMs: 30000, maxStdoutBytes: 8 * 1024 * 1024, maxStderrBytes: 16384,
  });
  assert.equal(result.code, 0, result.stderr); return result.stdout;
}

const RATE = 48000, TONE = 0.5, HEARD = TONE / Math.SQRT2, FLOOR = Math.pow(10, SOUND_GATE.floorDb / 20);
type Mix = Pick<ExportPlan, "audio" | "mix" | "speech" | "totalSec">;

/** The mix's left channel, read before the limiter, which is transparent here and delays what it passes. */
async function heard(plan: Mix, paths: string[] = plan.audio.map(clip => clip.path)): Promise<Float32Array> {
  const graph = buildCanonicalAudioGraph(plan, paths);
  graph.filters[graph.filters.length - 1] = `${graph.preLimiter}[aout]`;
  const bytes = await run([...graph.args, "-filter_complex", graph.filters.join(";"), "-map", "[aout]", "-ar", String(RATE), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]);
  const both = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return both.filter((_, index) => index % 2 === 0);
}

/** The level over `spanSec` around `sec`. A fiftieth of a second is whole cycles of the 400 Hz tone, so a steady level measures exactly. */
function rms(samples: Float32Array, sec: number, spanSec = .02): number {
  const half = Math.round(spanSec * RATE / 2), from = Math.max(0, Math.round(sec * RATE) - half), window = samples.slice(from, from + 2 * half);
  return Math.sqrt(window.reduce((sum, value) => sum + value * value, 0) / window.length);
}

test("the export plays a gated clip at the plan's level: whole in a kept stretch, 15 dB down outside one, and along the release between", { skip: !available }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "arke-sound-gate-"));
  try {
    const tone = join(dir, "tone.wav");
    await run(["-y", "-f", "lavfi", "-i", `aevalsrc=${TONE}*sin(2*PI*400*t):s=${RATE}:d=6`, "-c:a", "pcm_f32le", tone]);
    const mix = { ...DEFAULT_MIX }, item: RenderAudioItem = { path: tone, clipId: "cl_take", startSec: 0.5, endSec: 5.5, gainDb: -6, role: "dialogue", sourceInSec: 0,
      gate: [{ startSec: 1.5, endSec: 2.5 }, { startSec: 3.5, endSec: 4.5 }] };
    const film = await heard({ audio: [item], totalSec: 6, mix, speech: [] });
    assert.equal(film.length, 6 * RATE, "a gate changes no length");
    // Before the first stretch, just short of its attack, inside it, halfway down its release, past it, between the two, inside the second, after it.
    for (const sec of [1, 1.47, 2, 2.48, 2.575, 2.7, 3, 4, 5]) {
      const want = HEARD * audioLevelAt({ mix, speech: [] }, item, sec), got = rms(film, sec);
      assert.ok(Math.abs(got - want) <= want * 0.025 + 0.0005, `at ${sec}s the export plays ${got.toFixed(5)}, the plan says ${want.toFixed(5)}`);
    }
    const db = (sec: number) => 20 * Math.log10(rms(film, sec) / HEARD);
    assert.ok(Math.abs(db(2) + 6) < 0.05 && Math.abs(db(4) + 6) < 0.05, "kept sound is at the clip's own gain");
    assert.ok(Math.abs(db(1) + 21) < 0.1 && Math.abs(db(3) + 21) < 0.1 && Math.abs(db(5) + 21) < 0.1, "and the rest is 15 dB under it, not silent");

    // With a fade as well, the two multiply in one stage: the same film, read through its fade in.
    const faded: RenderAudioItem = { ...item, fadeIn: { startSec: 0.5, durationSec: 2, power: true } };
    const both = await heard({ audio: [faded], totalSec: 6, mix, speech: [] });
    assert.equal(both.length, 6 * RATE);
    for (const sec of [1, 2, 2.3, 3, 4]) {
      const want = HEARD * audioLevelAt({ mix, speech: [] }, faded, sec), got = rms(both, sec);
      assert.ok(Math.abs(got - want) <= want * 0.03 + 0.0005, `with a fade, at ${sec}s the export plays ${got.toFixed(5)}, the plan says ${want.toFixed(5)}`);
    }
    // A gate that kept nothing is down throughout, and is still a film of the same length.
    const shut = await heard({ audio: [{ ...item, gate: [] }], totalSec: 6, mix, speech: [] });
    assert.equal(shut.length, 6 * RATE);
    assert.ok(Math.abs(rms(shut, 2) / HEARD - Math.pow(10, -6 / 20) * FLOOR) < 0.002);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a take's sound measured by the decoder gives the stretches its voice is in and the gain that reaches a loudness, and the export plays both", { skip: !available }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "arke-sound-gate-"));
  try {
    // A take: a room that never stops, and a voice from 1.5 s to 2.6 s and from 3.4 s to 4.8 s of its file.
    const take = join(dir, "take.wav"), LINES = [[1.5, 2.6], [3.4, 4.8]] as const;
    await run(["-y", "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.02:seed=11:r=${RATE}:d=6`,
      "-f", "lavfi", "-i", `aevalsrc=0.2*sin(2*PI*220*t)*(between(t\\,1.5\\,2.6)+between(t\\,3.4\\,4.8)):s=${RATE}:d=6`,
      "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0[a]", "-map", "[a]", "-c:a", "pcm_s16le", take]);
    const bytes = await readFile(take), PRODUCTION = "saltlight", line = newId("ar");
    const store = await WorldStore.open(await makeTempWorld(), { clock: () => "2026-11-26T12:00:00.000Z" }); closeOnCleanup(() => store.close());
    await store.commit({ kind: "media-fixture", source: "test", files: [
      { path: "artifacts/take.wav", action: "create", baseHash: null, encoding: "base64", content: bytes.toString("base64") },
      { path: "artifacts/take.json", action: "create", baseHash: null, content: JSON.stringify({ id: line, kind: "audio", file: "take.wav",
        hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, links: [], origin: { by: "user" }, created: "2026-11-26T12:00:00.000Z" }) },
    ] });
    const production = () => store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!, still = store.getBundle().artifacts.find(value => value.kind === "board")!;
    const read = async () => ProductionTimelineSchema.parse(JSON.parse(await readFile(join(store.dir, "productions", PRODUCTION, "timeline.json"), "utf8")));
    const send = async (commands: TimelineCommand[], first = false) => applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: first ? null : (await read()).revision,
      sourceFingerprint: storyTimelineFingerprint(production()), commands });
    await send([{ kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 240, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } },
      { kind: "add-track", trackId: "tr_voice", trackKind: "dialogue", name: "Voice" },
      { kind: "place", trackId: "tr_voice", clip: { id: "cl_line", startFrame: 48, durationFrames: 96, sourceInFrames: 24, source: { kind: "artifact", artifactId: line, label: "Tunde's line" } } }], true);
    const rate = (await read()).frameRate, inSec = 24 / rate, startSec = 48 / rate;

    // Measured from the real file, through the verified copy, by the real decoder.
    const measured = await measureTimelineSound(store, PRODUCTION, [{ kind: "sound-gate", clipId: "cl_line", on: true }, { kind: "match-loudness", clipId: "cl_line", lufs: -23 }], tools, signal());
    const gate = measured[0]!.kind === "sound-gate" ? measured[0]!.gate! : assert.fail("a gate"), gain = measured[1]!.kind === "set-clip-gain" ? measured[1]!.gainDb : assert.fail("a gain");
    assert.equal(gate.open.length, 2, JSON.stringify(gate));
    for (const [index, [from, to]] of LINES.entries()) {
      assert.ok(Math.abs(gate.open[index]![0] - from) <= .03 && Math.abs(gate.open[index]![1] - to) <= .03, `the voice from ${from}s to ${to}s was kept as ${gate.open[index]}`);
    }
    await send(measured);

    // The film's plan, and its sound through the export's graph, with the gate and without it.
    const planned = buildRenderPlan({ production: production(), artifacts: store.getBundle().artifacts, timeline: { status: "ready", timeline: await read() }, scope: { kind: "production" }, preset: "review-cut" });
    if (!planned.ok) assert.fail(planned.reason);
    const item = planned.plan.audio.find(clip => clip.clipId === "cl_line")!;
    assert.equal(item.gainDb, gain);
    assert.deepEqual(item.gate!.map(window => [Math.round((window.startSec - startSec + inSec) * 1000) / 1000, Math.round((window.endSec - startSec + inSec) * 1000) / 1000]), gate.open, "the plan holds the stretches in film seconds");
    const mix = { ...DEFAULT_MIX }, total = planned.plan.totalSec, path = [join(store.dir, item.path)];
    const gated = await heard({ audio: [item], totalSec: total, mix, speech: [] }, path);
    const { gate: _gate, ...open } = item, whole = await heard({ audio: [open], totalSec: total, mix, speech: [] }, path);
    const film = (fileSec: number) => fileSec - inSec + startSec, ratio = (fileSec: number) => 20 * Math.log10(rms(gated, film(fileSec), .1) / rms(whole, film(fileSec), .1));
    // The same samples either way, so the difference is the gate's alone: nothing in the voice, 15 dB in the room.
    for (const fileSec of [2, 2.4, 3.8, 4.5]) assert.ok(Math.abs(ratio(fileSec)) < 0.05, `the voice at ${fileSec}s of the take is ${ratio(fileSec).toFixed(2)} dB from itself`);
    for (const fileSec of [1.2, 3, 3.2]) assert.ok(Math.abs(ratio(fileSec) + 15) < 0.3, `the room at ${fileSec}s of the take is ${ratio(fileSec).toFixed(2)} dB down`);

    // The line the clip plays, measured again in the export, is at the loudness asked for.
    const out = join(dir, "film.wav"), graph = buildCanonicalAudioGraph({ audio: [open], totalSec: total, mix, speech: [] }, path);
    graph.filters[graph.filters.length - 1] = `${graph.preLimiter}[aout]`;
    await run(["-y", ...graph.args, "-filter_complex", graph.filters.join(";"), "-map", "[aout]", "-ar", String(RATE), "-c:a", "pcm_s16le", out]);
    const exported = await tools.probe(out, signal()), stream = exported.streams.find(value => value.kind === "audio")!;
    const loud = await tools.loudness!(out, stream, item.startSec, item.endSec, signal());
    assert.ok(loud.integratedLufs !== null && Math.abs(loud.integratedLufs + 23) <= 0.3, `the line plays at ${loud.integratedLufs} LUFS, asked for -23`);
    // Why it is measured as the film plays it: this take is one channel, and the film plays it whole in both.
    const file = (await tools.probe(take, signal())).streams.find(value => value.kind === "audio")!;
    const own = (await tools.loudness!(take, file, inSec, inSec + 96 / rate, signal())).integratedLufs!, inFilm = (await tools.loudness!(take, file, inSec, inSec + 96 / rate, signal(), "film")).integratedLufs!;
    assert.ok(Math.abs(inFilm - own - 3) <= 0.15, `in the film it measures ${inFilm} LUFS, in its own file ${own}`);
    assert.ok(Math.abs(-23 - inFilm - gain) <= 0.05, "and the gain is counted from the film's figure");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

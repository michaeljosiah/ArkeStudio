import { readFile } from "node:fs/promises";
import {
  orderedShots, referenceAudioMediaPath, sceneUnderLook, takeIsCheckable, TakeChecksRecordSchema,
  type AcousticWord, type AgentMediaInventory, type CharacterAudioPlan, type ProductionBundle, type SceneRecord,
  type Shot, type Take, type TakeCheck, type TakeCheckSkip, type TakeChecksRecord,
} from "@arke-studio/contracts";
import type { AgentMediaTools } from "../media/agent-media-tools.js";
import { findCuts } from "../media/contact-sheet.js";
import { frameMotion, measureSoundtrackSync } from "../media/measure-sync.js";
import { recognizeAgentSpeech, type AgentSpeechReader } from "../media/agent-speech.js";
import { audioWorldPath } from "../audio/storage.js";
import { appendFlushed } from "../flushed-append.js";
import { withContainedProductionMedia } from "../world/reference-files.js";
import type { WorldStore } from "../world/store.js";

/*
 * The checks after a take comes back (design turns 287 and 288c). Gold on Gold's first Wan pass
 * was watched shot by shot and still went out with a dissolve inside take 69, voices nobody wrote
 * near the ends of 69 and 72, and fifty takes that drifted and never breathed in a film meant to
 * be handheld. Each of those is a number. Here they are measured the same way every time a take
 * lands: once, from one decode of its picture and one of its sound, with nothing sent anywhere
 * (speech is the local Voxa seam Arke's transcribe_audio uses, and nothing else).
 */

type Stream = AgentMediaInventory["streams"][number];
const round1 = (value: number) => Math.round(value * 10) / 10;
const sec = (value: number) => `${round1(value).toFixed(1)} s`;

/** The picture is read ten times a second; a take longer than a minute is read for its first minute. */
const FPS = 10, EDGE = 256, MAX_SEC = 60;

// ---------- Words ----------

/** Words as compared: one case, apostrophes kept inside a word, everything that is not a letter or a digit dropped. */
export function spokenWords(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").split(/[^\p{L}\p{N}']+/u)
    .map(word => word.replace(/^'+|'+$/g, "")).filter(Boolean);
}

/** Which heard words the longest in-order run of the line's words used, by index into `heard`. */
function matchedHeard(line: readonly string[], heard: readonly string[]): number[] {
  const width = heard.length + 1, dp = new Uint16Array((line.length + 1) * width);
  for (let i = line.length - 1; i >= 0; i--) for (let j = heard.length - 1; j >= 0; j--) {
    dp[i * width + j] = line[i] === heard[j] ? 1 + dp[(i + 1) * width + j + 1]! : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
  }
  const used: number[] = [];
  for (let i = 0, j = 0; i < line.length && j < heard.length;) {
    if (line[i] === heard[j]) { used.push(j); i++; j++; }
    else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) i++;
    else j++;
  }
  return used;
}

/** A word the recogniser is this sure of is a voice; below it, a breath or the room can read as one. */
const SURE = .5;

/**
 * The words heard against the line, and any voice nobody wrote: words outside the line's run, two
 * or more of them, which is what 69 and 72 did after their lines ended. A voice after the line
 * says where the take could end. A shot with no line has no words to compare; any voice in it is
 * one nobody wrote.
 */
export function judgeWords(line: string | null, heard: readonly AcousticWord[]): { words: TakeCheck | null; voice: TakeCheck } {
  const spoken = heard.flatMap(word => spokenWords(word.text).map(text => ({ text, startSec: word.startSec, probability: word.probability })));
  const voiceAt = (words: typeof spoken, trimmable: boolean): TakeCheck => {
    const sure = words.filter(word => word.probability >= SURE);
    if (sure.length < 2) return { id: "unwritten-voice", result: "pass", says: "none" };
    const at = sure[0]!.startSec;
    return { id: "unwritten-voice", result: "fix", says: `at ${sec(at)}`, ...(trimmable && at - .15 >= .5 ? { endAtSec: round1(at - .15) } : {}) };
  };
  const lineWords = line === null ? [] : spokenWords(line);
  if (lineWords.length === 0) return { words: null, voice: voiceAt(spoken, true) };
  if (spoken.length === 0) return { words: { id: "words", result: "fix", says: "nothing heard" }, voice: { id: "unwritten-voice", result: "pass", says: "none" } };
  const used = matchedHeard(lineWords, spoken.map(word => word.text));
  const share = used.length / lineWords.length;
  const heardText = spoken.map(word => word.text).join(" ");
  const words: TakeCheck = share === 1 ? { id: "words", result: "pass", says: "as written" }
    : share >= .6 ? { id: "words", result: "pass", says: `${used.length} of ${lineWords.length} words` }
    : { id: "words", result: "fix", says: `heard “${heardText.length > 48 ? `${heardText.slice(0, 47)}…` : heardText}”` };
  if (used.length === 0) return { words, voice: voiceAt(spoken, false) };
  const after = voiceAt(spoken.slice(used[used.length - 1]! + 1), true);
  return { words, voice: after.result === "fix" ? after : voiceAt(spoken.slice(0, used[0]!), false) };
}

// ---------- Cuts inside ----------

/** A cut inside the take; one late in it says where the take could end before it. */
export function judgeCuts(cuts: readonly number[], durationSec: number): TakeCheck {
  if (cuts.length === 0) return { id: "cuts-inside", result: "pass", says: "none" };
  const first = cuts[0]!;
  return { id: "cuts-inside", result: "fix", says: cuts.length === 1 ? `at ${sec(first)}` : `${cuts.length} · first at ${sec(first)}`,
    ...(cuts.length === 1 && first >= durationSec / 2 && first - .1 >= .5 ? { endAtSec: round1(first - .1) } : {}) };
}

// ---------- Camera ----------

/** Mean absolute difference of `b` shifted by (dx, dy) against `a`, over the frame less a margin. */
function shiftCost(a: Uint8Array, b: Uint8Array, width: number, height: number, dx: number, dy: number, margin: number, step: number): number {
  let sum = 0, count = 0;
  for (let y = margin; y < height - margin; y += step) {
    const row = y * width, shifted = (y + dy) * width + dx;
    for (let x = margin; x < width - margin; x += step) { sum += Math.abs(a[row + x]! - b[shifted + x]!); count++; }
  }
  return count ? sum / count : Infinity;
}

/** Half the picture each way, box-averaged, for the coarse search. */
function half(frame: Uint8Array, width: number, height: number): { frame: Uint8Array; width: number; height: number } {
  const w = width >> 1, h = height >> 1, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * width + 2 * x;
    out[y * w + x] = (frame[i]! + frame[i + 1]! + frame[i + width]! + frame[i + width + 1]!) >> 2;
  }
  return { frame: out, width: w, height: h };
}

/**
 * How the picture moved from one frame to the next, in pixels of the frames given: the shift that
 * best lays the second on the first, found on a half-size picture, refined at full size and to a
 * fraction of a pixel. A person moving in the frame pulls on it; the room behind them, which is
 * most of a frame, holds it. Advice, not proof, which is why the camera is not a hard check.
 */
export function cameraPath(frames: readonly Uint8Array[], width: number, height: number): Array<{ dx: number; dy: number }> {
  const steps: Array<{ dx: number; dy: number }> = [];
  const COARSE = 6, coarseMargin = COARSE + 2, fineMargin = 2 * COARSE + 4;
  if (width < 4 * fineMargin || height < 4 * fineMargin) return frames.slice(1).map(() => ({ dx: 0, dy: 0 }));
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!, b = frames[i]!, ha = half(a, width, height), hb = half(b, width, height);
    let best = { dx: 0, dy: 0, cost: Infinity };
    for (let dy = -COARSE; dy <= COARSE; dy++) for (let dx = -COARSE; dx <= COARSE; dx++) {
      const cost = shiftCost(ha.frame, hb.frame, ha.width, ha.height, dx, dy, coarseMargin, 1);
      if (cost < best.cost) best = { dx, dy, cost };
    }
    const costs = new Map<string, number>(), at = (dx: number, dy: number) => {
      const key = `${dx},${dy}`; let cost = costs.get(key);
      if (cost === undefined) { cost = shiftCost(a, b, width, height, dx, dy, fineMargin, 2); costs.set(key, cost); }
      return cost;
    };
    let fine = { dx: 2 * best.dx, dy: 2 * best.dy, cost: Infinity };
    for (let dy = 2 * best.dy - 2; dy <= 2 * best.dy + 2; dy++) for (let dx = 2 * best.dx - 2; dx <= 2 * best.dx + 2; dx++) {
      const cost = at(dx, dy);
      if (cost < fine.cost) fine = { dx, dy, cost };
    }
    // A parabola through the best cost and its neighbours places the minimum between pixels.
    const vertex = (left: number, middle: number, right: number) => { const curve = left - 2 * middle + right; return curve > 1e-9 ? Math.max(-.5, Math.min(.5, (left - right) / (2 * curve))) : 0; };
    steps.push({ dx: fine.dx + vertex(at(fine.dx - 1, fine.dy), fine.cost, at(fine.dx + 1, fine.dy)),
      dy: fine.dy + vertex(at(fine.dx, fine.dy - 1), fine.cost, at(fine.dx, fine.dy + 1)) });
  }
  return steps;
}

/** What the shot asked of the camera, from its movement words: to hold still, to move as a hand holds it, or something a measure cannot judge (a push, a pan). */
export function askedCamera(movement: string | undefined): "still" | "handheld" | null {
  if (!movement) return null;
  if (/hand-?held|shak|breath|wobbl/i.test(movement)) return "handheld";
  if (/locked|static|tripod|does not move|no movement|holds still/i.test(movement)) return "still";
  return null;
}

/** Pixels are reported as a 1920-wide frame's, whatever size the take is, so 7 px means the same everywhere. */
const REPORT_WIDTH = 1920;
/** Below these the camera is still: drift across the take, and the breath left after a half-second average. */
const STILL_DRIFT = 6, BREATH = 1.5;

export function judgeCamera(steps: ReadonlyArray<{ dx: number; dy: number }>, frameWidth: number, asked: "still" | "handheld" | null): TakeCheck {
  const scale = REPORT_WIDTH / frameWidth, x = [0], y = [0];
  for (const step of steps) { x.push(x[x.length - 1]! + step.dx * scale); y.push(y[y.length - 1]! + step.dy * scale); }
  const smooth = (values: number[]) => values.map((_, i) => {
    const from = Math.max(0, i - 2), to = Math.min(values.length - 1, i + 2);
    let sum = 0; for (let j = from; j <= to; j++) sum += values[j]!; return sum / (to - from + 1);
  });
  const sx = smooth(x), sy = smooth(y);
  let drift = 0, breath = 0;
  for (let i = 0; i < x.length; i++) {
    drift = Math.max(drift, Math.hypot(sx[i]! - sx[0]!, sy[i]! - sy[0]!));
    breath += (x[i]! - sx[i]!) ** 2 + (y[i]! - sy[i]!) ** 2;
  }
  breath = Math.sqrt(breath / x.length);
  const px = Math.round(drift), breathes = breath >= BREATH, moves = breathes || drift >= STILL_DRIFT;
  const says = !moves ? "still" : breathes ? `handheld · ${px} px` : `drifts ${px} px`;
  if (asked === "handheld" && !breathes) return { id: "camera", result: "fix", says: moves ? `${says}, no breath` : "still · asked handheld" };
  if (asked === "still" && moves) return { id: "camera", result: "fix", says: `moves ${px} px · asked still` };
  return { id: "camera", result: "pass", says };
}

// ---------- Light ----------

export function meanLevel(frame: Uint8Array): number {
  let sum = 0; for (let i = 0; i < frame.length; i++) sum += frame[i]!; return frame.length ? sum / frame.length : 0;
}

/** A tenth of the grey scale between one shot's last frame and the next one's first is a jump a viewer sees. */
const LIGHT_STEP = 26;

/** The take's first frame against the shot before's last, and its last against the next shot's first, where those shots have takes in the film. */
export function judgeLight(own: { first: number; last: number }, before: { number: number; last: number } | null, after: { number: number; first: number } | null): TakeCheck | null {
  const sides = [before && { number: before.number, step: own.first - before.last }, after && { number: after.number, step: own.last - after.first }]
    .filter((side): side is { number: number; step: number } => side !== null);
  if (sides.length === 0) return null;
  const worst = sides.reduce((a, b) => (Math.abs(b.step) > Math.abs(a.step) ? b : a));
  if (Math.abs(worst.step) >= LIGHT_STEP) return { id: "light", result: "fix", says: `${worst.step < 0 ? "darker" : "brighter"} than shot ${worst.number}` };
  return { id: "light", result: "pass", says: sides.length === 2 ? `as shots ${sides[0]!.number} and ${sides[1]!.number}` : `as shot ${sides[0]!.number}` };
}

// ---------- Lip sync ----------

/** Within this, the take's voice follows the read it was sent; the laid lines of Gold on Gold that read as off sat 60 to 120 ms away. */
const SYNC_MS = 60;

export function judgeSync(result: { lagSec: number | null; follows: boolean }): TakeCheck {
  if (result.lagSec === null || !result.follows) return { id: "lip-sync", result: "fix", says: "does not follow the read" };
  const ms = Math.round(result.lagSec * 100) * 10;
  if (Math.abs(ms) <= SYNC_MS) return { id: "lip-sync", result: "pass", says: `${Math.abs(ms)} ms` };
  return { id: "lip-sync", result: "fix", says: `${ms > 0 ? "late" : "early"} ${Math.abs(ms)} ms` };
}

/** The read a take was sent to follow in time: a performance or a slice of the song, not a voice to sound like. */
function syncReference(take: Take): CharacterAudioPlan["references"][number] | null {
  const plan = take.params["audioReferences"] as CharacterAudioPlan | undefined;
  if (!plan || plan.disabled || !Array.isArray(plan.references)) return null;
  return plan.references.find(ref => ref.intent === "performance-sync") ?? null;
}

/** The hash a sent read is fenced on: its prepared file's name says it; an unprepared performance carries it. */
function syncReferenceHash(ref: CharacterAudioPlan["references"][number]): string | null {
  const prepared = "prepared" in ref ? ref.prepared?.file.match(/sha256-([a-f0-9]{64})\.wav$/)?.[1] : undefined;
  if (prepared) return `sha256:${prepared}`;
  return "performance" in ref ? ref.performance.provenance.outputHash : null;
}

// ---------- The take, measured ----------

export interface TakeCheckPorts {
  tools: AgentMediaTools;
  speech?: AgentSpeechReader;
  speechReady?: (signal: AbortSignal) => Promise<boolean>;
  now: () => string;
}

interface Neighbours { before: { number: number; take: Take } | null; after: { number: number; take: Take } | null }

/** The shot, its scene and the shots either side that have a chosen take, in the scene's order. */
function placeOf(production: ProductionBundle, shotId: string): { scene: SceneRecord; shot: Shot; neighbours: Neighbours } | null {
  for (const scene of production.scenes) {
    let shots: Shot[];
    try { shots = orderedShots(scene); } catch { continue; }
    const index = shots.findIndex(shot => shot.id === shotId);
    if (index < 0) continue;
    const chosen = (at: number) => {
      const shot = shots[at], id = shot ? production.selections[shot.id]?.acceptedTakeId : undefined;
      const take = id ? production.takes.find(candidate => candidate.id === id && takeIsCheckable(candidate)) : undefined;
      return take ? { number: at + 1, take } : null;
    };
    return { scene, shot: shots[index]!, neighbours: { before: chosen(index - 1), after: chosen(index + 1) } };
  }
  return null;
}

const SPOKEN_KINDS = new Set(["dialogue", "vo", "voice", "voice-over", "voiceover", "line", "speech"]);

/** The line the shot is meant to carry, when its sound is a spoken one. */
function lineOf(shot: Shot): string | null {
  const audio = shot.audio;
  if (!audio?.line?.trim() || !SPOKEN_KINDS.has(audio.kind.trim().toLowerCase())) return null;
  return audio.line;
}

const takePath = (productionId: string, take: Take) => `productions/${productionId}/takes/${take.id}/${take.media}`;

async function streamsOf(tools: AgentMediaTools, path: string, signal: AbortSignal): Promise<{ video: Stream | null; audio: Stream | null; durationSec: number | null }> {
  const inventory = await tools.probe(path, signal);
  return { video: inventory.streams.find(stream => stream.kind === "video") ?? null,
    audio: inventory.streams.find(stream => stream.kind === "audio") ?? null, durationSec: inventory.durationSec };
}

/** A neighbour's frame at its start or end, as one grey level. */
async function edgeLevel(store: WorldStore, tools: AgentMediaTools, productionId: string, take: Take, edge: "first" | "last", signal: AbortSignal): Promise<number | null> {
  return withContainedProductionMedia(store.dir, takePath(productionId, take), take.mediaHash!, signal, async snapshot => {
    const { video, durationSec } = await streamsOf(tools, snapshot.path, signal);
    if (!video || durationSec === null || durationSec <= .1) return null;
    const from = edge === "first" ? 0 : Math.max(0, durationSec - .3), read = await tools.grayFrames!(snapshot.path, video, from, Math.min(durationSec, from + .3), { fps: FPS, edge: 64 }, signal);
    const frame = edge === "first" ? read.frames[0] : read.frames[read.frames.length - 1];
    return frame ? meanLevel(frame) : null;
  }).catch(() => null);
}

/**
 * Measure one take. Null when it is not one the checks measure (a still, a voice, a segment of a
 * pass) or the host has no picture tools; otherwise every item measured or skipped with a reason.
 */
export async function measureTake(store: WorldStore, productionId: string, takeId: string, ports: TakeCheckPorts, signal: AbortSignal): Promise<TakeChecksRecord | null> {
  const { tools } = ports;
  const production = store.getBundle().productions.find(p => p.meta.id === productionId);
  const take = production?.takes.find(candidate => candidate.id === takeId);
  if (!production || !take || !takeIsCheckable(take) || !tools.grayFrames) return null;
  const place = placeOf(production, take.coversShots[0]!);
  if (!place) return null;
  const items: TakeCheck[] = [], skipped: TakeCheckSkip[] = [];
  const line = lineOf(place.shot);
  const sync = syncReference(take);
  // Set inside the read below; cast so the checker does not keep them at their first null.
  let level = null as { first: number; last: number } | null;
  let takeSound = null as Float32Array | null;
  await withContainedProductionMedia(store.dir, takePath(productionId, take), take.mediaHash!, signal, async snapshot => {
    const { video, audio, durationSec } = await streamsOf(tools, snapshot.path, signal);
    if (!video || durationSec === null || durationSec <= 0) throw new Error("The take has no picture to measure.");
    const end = Math.min(durationSec, MAX_SEC);
    const picture = await tools.grayFrames!(snapshot.path, video, 0, end, { fps: FPS, edge: EDGE }, signal);
    const cuts = findCuts([...frameMotion(picture.frames)], FPS);
    items.push(judgeCuts(cuts, end));
    const movement = place.shot.framing?.movement ?? sceneUnderLook(place.scene, production.meta.look).defaults?.movement;
    // Across a cut there is no move to find, only another picture: that step is left out of the camera's path.
    const across = new Set(cuts.map(at => Math.round(at * FPS) - 1));
    const steps = cameraPath(picture.frames, picture.width, picture.height).map((step, i) => (across.has(i) ? { dx: 0, dy: 0 } : step));
    items.push(judgeCamera(steps, picture.width, askedCamera(movement)));
    const first = picture.frames[0], last = picture.frames[picture.frames.length - 1];
    if (first && last) level = { first: meanLevel(first), last: meanLevel(last) };
    if (!audio) {
      skipped.push({ id: "unwritten-voice", reason: "no-sound" });
      if (line !== null) skipped.push({ id: "words", reason: "no-sound" });
    } else if (!ports.speech || !tools.speechAudio || (ports.speechReady && !await ports.speechReady(signal))) {
      skipped.push({ id: "unwritten-voice", reason: "unavailable" });
      if (line !== null) skipped.push({ id: "words", reason: "unavailable" });
    } else {
      const derivative = await tools.speechAudio(snapshot.path, audio, 0, end, signal);
      const heard = await recognizeAgentSpeech({ bytes: derivative.bytes, durationSec: derivative.durationSec, streamIndex: audio.index,
        sourceStartSec: 0, viewStartSec: 0, read: ports.speech, signal }).then(transcript => transcript.words as AcousticWord[])
        .catch((error: unknown) => { if (signal.aborted) throw error; return null; });
      if (heard === null) {
        skipped.push({ id: "unwritten-voice", reason: "unavailable" });
        if (line !== null) skipped.push({ id: "words", reason: "unavailable" });
      } else {
        const judged = judgeWords(line, heard);
        if (judged.words) items.push(judged.words);
        items.push(judged.voice);
      }
    }
    if (line === null && !items.some(item => item.id === "words") && !skipped.some(item => item.id === "words")) skipped.push({ id: "words", reason: "no-line" });
    if (sync && audio && tools.monoAudio) takeSound = await tools.monoAudio(snapshot.path, audio, 0, end, 16_000, signal);
  });
  if (!sync) skipped.push({ id: "lip-sync", reason: "no-voice-sent" });
  else {
    const expected = syncReferenceHash(sync);
    const reference = expected && takeSound && tools.monoAudio ? await withContainedProductionMedia(store.dir, referenceAudioMediaPath(sync), expected, signal, async snapshot => {
      const { audio, durationSec } = await streamsOf(tools, snapshot.path, signal);
      return audio && durationSec ? tools.monoAudio!(snapshot.path, audio, 0, Math.min(durationSec, MAX_SEC), 16_000, signal) : null;
    }).catch(() => null) : null;
    if (!reference || !takeSound) skipped.push({ id: "lip-sync", reason: "unavailable" });
    else items.push(judgeSync(measureSoundtrackSync(takeSound, reference, 16_000, .6)));
  }
  const [before, after] = await Promise.all([
    place.neighbours.before ? edgeLevel(store, tools, productionId, place.neighbours.before.take, "last", signal) : null,
    place.neighbours.after ? edgeLevel(store, tools, productionId, place.neighbours.after.take, "first", signal) : null,
  ]);
  const light = level === null ? null : judgeLight(level, before === null ? null : { number: place.neighbours.before!.number, last: before },
    after === null ? null : { number: place.neighbours.after!.number, first: after });
  if (light) items.push(light);
  else skipped.push({ id: "light", reason: "no-neighbour" });
  const order = ["lip-sync", "words", "unwritten-voice", "cuts-inside", "camera", "light"];
  items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return TakeChecksRecordSchema.parse({ schemaVersion: 1, kind: "after-take", ts: ports.now(), takeId: take.id, shotId: take.coversShots[0],
    sourceHash: take.mediaHash, items, skipped });
}

const queues = new WeakMap<WorldStore, Promise<unknown>>();

/**
 * Measure a take and record what was found, one take at a time in a world: each is a decode of a
 * clip's picture and sound, and a scene's takes landing together must not decode at once.
 */
export function checkTake(store: WorldStore, productionId: string, takeId: string, ports: TakeCheckPorts, signal: AbortSignal): Promise<"checked" | "not-checkable" | "changed"> {
  const run = (queues.get(store) ?? Promise.resolve()).then(async () => {
    signal.throwIfAborted();
    const record = await measureTake(store, productionId, takeId, ports, signal);
    if (record === null) return "not-checkable" as const;
    signal.throwIfAborted();
    return await recordTakeChecks(store, productionId, record) ? "checked" as const : "changed" as const;
  });
  queues.set(store, run.catch(() => {}));
  return run;
}

/**
 * Add a take's checks to the production's record of them, if the take is still what was measured.
 * Appended, as dialogue feedback is: the newest line for a take is its checks.
 */
export async function recordTakeChecks(store: WorldStore, productionId: string, record: TakeChecksRecord): Promise<boolean> {
  return store.ownedWrite(async () => {
    const take = store.getBundle().productions.find(p => p.meta.id === productionId)?.takes.find(candidate => candidate.id === record.takeId);
    if (!take || take.mediaHash !== record.sourceHash) return false;
    const path = await audioWorldPath(store.dir, `productions/${productionId}/take-checks.jsonl`, true);
    const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    // A torn last line is left for repair rather than glued to the next record.
    if (raw && !raw.endsWith("\n")) throw new Error("The take checks need repair before more are added.");
    await appendFlushed(path, `${JSON.stringify(TakeChecksRecordSchema.parse(record))}\n`);
    return true;
  });
}

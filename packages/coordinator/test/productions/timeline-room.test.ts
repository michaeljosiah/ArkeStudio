import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, ProductionTimelineSchema, roomFrames, storyTimelineFingerprint, type AgentMediaInventory, type ConversationId, type ModelEditorRequest,
  type TimelineCommand } from "@arke-studio/contracts";
import { writeSpeechWav } from "../../src/audio/speech-wav.js";
import type { AgentMediaTools } from "../../src/media/agent-media-tools.js";
import { decideEditorRequest, EditorRequestRefused, previewProductionEditorRequest, stageEditorRequests } from "../../src/productions/editor-requests.js";
import { applyHumanTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { carriesLaidRoom, carriesSoundLevels } from "../../src/productions/timeline-record.js";
import { measureEditorRequestSound, measureTimelineSound } from "../../src/productions/timeline-sound.js";
import { EDITOR_ROOM_SCHEMA_VERSION, EDITOR_SOUND_LEVELS_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * A room's beds are measured before it is laid (SPEC-038 R-61..R-64). The decoder here is a
 * stand-in, so what is asserted is the coordinator's part: which files are read and how much of
 * each, what the measured command carries, what is refused and in what words, and what raises the
 * world. `sound-room-native.test.ts` lays a room from real sound and listens to the export.
 */

const AT = "2026-11-26T12:00:00.000Z", PRODUCTION = "saltlight", RATE = 16_000;
const relativeTimeline = `productions/${PRODUCTION}/timeline.json`, relativeRequests = `productions/${PRODUCTION}/editor-requests.json`;
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const signal = () => new AbortController().signal;

/** A bed: a room's tone, never silent, as long as asked. Each seed is a different file. */
function bedSound(seconds: number, seed: number): Uint8Array {
  let state = seed;
  const noise = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2147483648 - 1; };
  return writeSpeechWav({ rate: RATE, samples: new Float32Array(Math.round(seconds * RATE)).map(() => .05 * noise()) });
}

/** A still on the Picture track, and three beds in the world: 20.5 s, 14 s and one only 3 s long. */
async function placed() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => AT }); closeOnCleanup(() => store.close());
  const beds = [{ name: "crowd", seconds: 20.5, lufs: -25 }, { name: "bar", seconds: 14, lufs: -18.4 }, { name: "blip", seconds: 3, lufs: -30 }]
    .map((bed, index) => ({ ...bed, id: newId("ar"), bytes: bedSound(bed.seconds, index + 3) }));
  await store.commit({ kind: "media-fixture", source: "test", files: beds.flatMap(bed => [
    { path: `artifacts/${bed.name}.wav`, action: "create" as const, baseHash: null, encoding: "base64" as const, content: Buffer.from(bed.bytes).toString("base64") },
    { path: `artifacts/${bed.name}.json`, action: "create" as const, baseHash: null, content: JSON.stringify({ id: bed.id, kind: "audio", file: `${bed.name}.wav`, hash: hash(bed.bytes), links: [], origin: { by: "user" }, created: AT }) },
  ]) });
  const production = store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!, still = store.getBundle().artifacts.find(value => value.kind === "board")!;
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production), commands: [
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 2400, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } }] });
  const raw = () => readFile(join(store.dir, relativeTimeline), "utf8");
  const read = async () => ProductionTimelineSchema.parse(JSON.parse(await raw()));
  const send = async (commands: TimelineCommand[]) => applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: (await read()).revision,
    sourceFingerprint: storyTimelineFingerprint(production), commands });
  const version = async () => (await readWorldMeta(store.dir)).schemaVersion;
  // The decoder answers by the file it is shown, which is a private copy with no name of its own.
  const asked: Array<{ bed: string; what: "probe" | "loudness"; from?: number; to?: number; as?: unknown }> = [];
  const bedAt = async (path: string) => { const bytes = await readFile(path); return beds.find(bed => Buffer.compare(Buffer.from(bed.bytes), bytes) === 0) ?? null; };
  const tools = (over: { lufs?: number | null; silent?: boolean } = {}): Pick<AgentMediaTools, "probe" | "monoAudio" | "loudness"> => ({
    probe: async path => {
      const bed = await bedAt(path); asked.push({ bed: bed?.name ?? "other", what: "probe" });
      assert.ok(!path.startsWith(store.dir), "the decoder never opens a path in the world");
      const seconds = bed?.seconds ?? 1;
      return { durationSec: seconds, streams: over.silent ? [] : [{ index: 0, kind: "audio", codec: "pcm_s16le", sampleRate: RATE, channels: 1, durationSec: seconds, startTimeSec: 0 }] } as AgentMediaInventory;
    },
    monoAudio: async () => assert.fail("a room decodes no samples here"),
    loudness: async (path, _stream, from, to, _stop, as) => {
      const bed = await bedAt(path); asked.push({ bed: bed?.name ?? "other", what: "loudness", from, to, as });
      return { integratedLufs: over.lufs === undefined ? bed!.lufs : over.lufs, rangeLu: 2, truePeakDbtp: -9, shortTermMaxLufs: -20 };
    },
  });
  const [crowd, bar, blip] = beds;
  const room = (over: Record<string, unknown> = {}): TimelineCommand => ({ kind: "lay-room", clipId: "cl_room", trackIds: ["tr_room1", "tr_room2"],
    sources: [{ artifactId: crowd!.id, label: "Crowd" }, { artifactId: bar!.id, label: "Bar", inSec: 2 }], startFrame: 48, durationFrames: 720, lufs: -33, ...over }) as TimelineCommand;
  /** `null` is a host that cannot measure sound. */
  const measure = (commands: TimelineCommand[], decoder: ReturnType<typeof tools> | null = tools()) => measureTimelineSound(store, PRODUCTION, commands, decoder ?? undefined, signal());
  return { store, crowd: crowd!, bar: bar!, blip: blip!, still, raw, read, send, version, asked, tools, room, measure, rate: (await read()).frameRate };
}

test("a room's beds are measured from private copies, as a film plays them, and the room is laid from what was measured", async () => {
  const { store, crowd, bar, raw, read, send, version, asked, room, measure, rate } = await placed();
  const [measured] = await measure([room()]);
  if (measured!.kind !== "lay-room") assert.fail("still a room");
  // Each bed's own length and loudness, over the stretch it is cut from; nothing else about the command moves.
  assert.deepEqual(measured.sources, [{ artifactId: crowd.id, label: "Crowd", outSec: 20.5, measuredLufs: -25 }, { artifactId: bar.id, label: "Bar", inSec: 2, outSec: 14, measuredLufs: -18.4 }]);
  assert.ok(Number.isInteger(measured.seed) && measured.seed! >= 0, "and a seed is settled, so the card and Accept lay one room");
  assert.deepEqual(asked, [{ bed: "crowd", what: "probe" }, { bed: "crowd", what: "loudness", from: 0, to: 20.5, as: "film" }, { bed: "bar", what: "probe" }, { bed: "bar", what: "loudness", from: 2, to: 14, as: "film" }]);
  assert.deepEqual({ ...measured, sources: null, seed: null }, { ...room(), sources: null, seed: null });
  // A seed that was given is kept, and a room already measured is handed on untouched and unheard.
  assert.equal(((await measure([room({ seed: 7 })]))[0] as { seed?: number }).seed, 7);
  const before = asked.length;
  assert.deepEqual(await measure([measured], null), [measured]);
  assert.equal(asked.length, before);

  // Laid: two held Ambience tracks and the pieces, as one write. The timeline holds clips an older build reads.
  await send([measured]);
  const timeline = await read(), tracks = timeline.tracks.filter(track => track.id.startsWith("tr_room")), pieces = tracks.flatMap(track => track.clips), { cross } = roomFrames(rate);
  assert.deepEqual(tracks.map(track => [track.kind, track.name, track.ducks]), [["ambience", "Room 1", false], ["ambience", "Room 2", false]]);
  assert.ok(pieces.length >= 4);
  assert.deepEqual([Math.min(...pieces.map(clip => clip.startFrame)), Math.max(...pieces.map(clip => clip.startFrame + clip.durationFrames))], [48, 48 + 720]);
  for (const clip of pieces) {
    const bed = clip.source.kind === "artifact" && clip.source.artifactId === crowd.id ? "Crowd" : "Bar";
    assert.deepEqual([clip.gainDb, clip.soundFade, clip.role], [bed === "Crowd" ? -8 : -14.6, { inFrames: cross, outFrames: cross, power: true }, "ambience"]);
    if (bed === "Bar") assert.ok(clip.sourceInFrames >= 2 * rate && clip.sourceInFrames + clip.durationFrames <= 14 * rate, "cut from the stretch named, inside the file");
    else assert.ok(clip.sourceInFrames + clip.durationFrames <= 20.5 * rate);
  }
  assert.deepEqual([carriesLaidRoom(await raw()), carriesSoundLevels(await raw()), await version()], [false, true, EDITOR_SOUND_LEVELS_SCHEMA_VERSION], "the record is held tracks and even-power fades, no more");
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: timeline.revision });
  assert.deepEqual((await read()).tracks.map(track => track.id), ["tr_picture"], "one Undo takes the room and the tracks it made");
});

test("a room that cannot be laid says why, and is never laid from what nobody measured", async () => {
  const { store, bar, blip, still, raw, send, asked, tools, room, measure } = await placed(), before = await raw();
  const refused = async (commands: TimelineCommand[], decoder: ReturnType<typeof tools> | null, reason: string | RegExp) =>
    assert.rejects(measure(commands, decoder), (error: unknown) => error instanceof TimelineCommandRefused && (typeof reason === "string" ? error.reason === reason : reason.test(error.reason)), String(reason));
  await refused([room({ sources: [{ artifactId: blip.id, label: "Blip" }] })], tools(), "Blip has 3 s to cut from, and a room's piece is at least 4.5 s");
  await refused([room({ sources: [{ artifactId: bar.id, label: "Bar", inSec: 11 }] })], tools(), "Bar has 3 s to cut from, and a room's piece is at least 4.5 s");
  await refused([room({ sources: [{ artifactId: "ar_01J8G0000000000000000000ZZ", label: "Gone" }] })], tools(), "Gone cites a file which this world does not have");
  await refused([room()], tools({ lufs: null }), "Crowd is too quiet to measure a loudness from");
  await refused([room({ sources: [{ artifactId: still.id, label: "Still" }] })], tools({ silent: true }), /^Still (cannot be measured: its sound file is missing or has changed|has no sound a room can be cut from)$/);
  await refused([room()], null, "Sound cannot be measured on this host, so a gate, a loudness or a room cannot be set here");
  // The unmeasured command straight to the reducer, a bed that is a picture, and a gain no clip may have.
  await assert.rejects(send([room()]), /A room is laid from its beds as they were measured; this host did not measure them/);
  const loud = await measure([room({ lufs: -6 })], tools({ lufs: -40 }));
  // Whichever bed the seed plays first is the one named.
  await assert.rejects(send(loud), /: (Crowd|Bar) measures -40 LUFS: a room at -6 LUFS would take a gain of \+34 dB, and a clip's gain is -60 to \+12$/);
  assert.deepEqual(previewProductionEditorRequest(store, PRODUCTION, { summary: "Lay the room", commands: [room({ sources: [{ artifactId: still.id, label: "Still", outSec: 20, measuredLufs: -25 }], seed: 1 })] as never }, AT),
    { ok: false, reason: `Still cites ${still.file}, which is not known to carry sound` });
  assert.equal(await raw(), before, "nothing was written");
  // A file changed on disk is not the bed the world recorded.
  const from = asked.length;
  await writeFile(join(store.dir, "artifacts", "crowd.wav"), "changed");
  await refused([room()], tools(), "Crowd cannot be measured: its sound file is missing or has changed");
  assert.equal(asked.length, from, "and nothing is decoded from it");
});

test("Arke's room is measured before it is checked, its request raises the world, and Accept lays it without listening again", async () => {
  const { store, raw, read, version, asked, tools, room } = await placed();
  const wanted: ModelEditorRequest = { summary: "Lay the club's room under the scene", commands: [room()] as never };
  assert.deepEqual(previewProductionEditorRequest(store, PRODUCTION, wanted, AT), { ok: false, reason: "A room is laid from its beds as they were measured; this host did not measure them" });
  const [measured] = await measureEditorRequestSound(store, PRODUCTION, [wanted], tools(), signal());
  const preview = previewProductionEditorRequest(store, PRODUCTION, measured!, AT);
  if (!preview.ok) assert.fail(preview.reason);
  assert.deepEqual(preview.digest.tracks, ["adds tr_room1", "adds tr_room2"]);
  assert.ok(preview.digest.added.length >= 4 && preview.digest.added.every(label => label === "Crowd" || label === "Bar"));
  assert.match(preview.digest.effects.map(effect => effect.detail ?? "").join("\n"), /not present -> tr_room1, frames 48-\d+, source \d+-\d+, -(8|14\.6) dB, sound fade in \d+ out \d+ even-power/);
  await assert.rejects(measureEditorRequestSound(store, PRODUCTION, [{ summary: "Lay a room from nothing", commands: [room({ sources: [{ artifactId: "ar_01J8G0000000000000000000ZZ", label: "Gone" }] })] as never }], tools(), signal()),
    (error: unknown) => error instanceof EditorRequestRefused && error.reason === "\"Lay a room from nothing\" cannot apply: Gone cites a file which this world does not have");

  // The request holds the command whole, with what was measured, so a build that cannot read it is kept out.
  const before = await raw();
  assert.ok(await version() < EDITOR_ROOM_SCHEMA_VERSION);
  const [request] = await stageEditorRequests(store, { conversationId: newId("cv") as ConversationId, entryContext: { kind: "production", productionId: PRODUCTION }, requests: [measured!], now: AT });
  assert.equal(carriesLaidRoom(await readFile(join(store.dir, relativeRequests), "utf8")), true);
  assert.equal(await version(), EDITOR_ROOM_SCHEMA_VERSION);
  await assert.rejects(readWorldMeta(store.dir, { supports: EDITOR_ROOM_SCHEMA_VERSION - 1 }), /newer Arke Studio/);
  assert.equal(await raw(), before, "a staged request lays nothing");
  const heard = asked.length;
  await decideEditorRequest(store, { productionId: PRODUCTION, requestId: request!.id, decision: "accept", now: AT });
  assert.equal(asked.length, heard, "Accept decodes nothing");
  const laid = (await read()).tracks.filter(track => track.id.startsWith("tr_room")).flatMap(track => track.clips);
  assert.deepEqual(laid.map(clip => clip.id).sort(), preview.timeline.tracks.filter(track => track.id.startsWith("tr_room")).flatMap(track => track.clips).map(clip => clip.id).sort(), "the room the card showed");
});

test("the room's floor is read from a request's command and from nothing a laid room leaves behind", () => {
  const command = { kind: "lay-room", clipId: "cl_room", trackIds: ["tr_room1", "tr_room2"], sources: [{ artifactId: "ar_01J8G0000000000000000000R1", label: "Crowd", outSec: 20, measuredLufs: -25 }], startFrame: 0, durationFrames: 720, lufs: -33, seed: 3 };
  assert.equal(carriesLaidRoom(JSON.stringify({ schemaVersion: 1, requests: [{ commands: [command] }] })), true);
  assert.equal(carriesLaidRoom(JSON.stringify({ schemaVersion: 1, requests: [{ commands: [{ kind: "set-clip-gain", clipId: "cl_a", gainDb: -3 }, { ...command, sources: [{ artifactId: "ar_01J8G0000000000000000000R1", label: "Crowd" }] }] }] })), true);
  for (const [where, value] of [
    ["a laid room's clips", { tracks: [{ id: "tr_room1", kind: "ambience", ducks: false, clips: [{ id: "cl_room-1", gainDb: -8, role: "ambience", soundFade: { inFrames: 29, outFrames: 29, power: true } }] }] }],
    ["its Undo entry", { tracks: [], history: { undo: [{ kind: "change", label: "Lay a room", clips: [{ before: null, after: { id: "cl_room-1" } }], tracks: [{ trackId: "tr_room1", kind: "ambience", before: null, after: { name: "Room 1", order: 2, muted: false, ducks: false } }] }], redo: [] } }],
    ["a summary that says it", { schemaVersion: 1, requests: [{ summary: "lay-room under the scene", commands: [{ kind: "set-clip-gain", clipId: "cl_a", gainDb: -3 }] }] }],
    ["words that say it", { tracks: [{ kind: "picture", clips: [{ source: { kind: "text", text: "lay-room", label: "lay-room" } }] }] }],
  ] as Array<[string, unknown]>) assert.equal(carriesLaidRoom(JSON.stringify(value)), false, where);
  assert.equal(carriesLaidRoom("not json"), false);
});

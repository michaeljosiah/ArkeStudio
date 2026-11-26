import { applyTimelineCommands, clipSoundFile, clipSourceInSec, framesToSeconds, isMatchLoudnessCommand, isSoundGateCommand, migrateLegacyCut,
  needsSoundMeasure, seedFirstPictureTimeline, soundGateFromLevels, soundGateProblem, sourceLengthFramesFor, SOUND_GATE, TimelineOperationRefused,
  type ModelEditorRequest, type ProductionBundle, type ProductionTimeline, type SoundGate, type TimelineClip, type TimelineClipCommand, type TimelineCommand,
  type TimelineTrack } from "@arke-studio/contracts";
import type { AgentMediaTools } from "../media/agent-media-tools.js";
import { stepLevels } from "../media/song-map.js";
import { agentMediaSource } from "../world-chat/media-inspection.js";
import { RetrievalError } from "../world-chat/retrieval.js";
import { withContainedProductionMedia, WorldReferenceError } from "../world/reference-files.js";
import type { WorldStore } from "../world/store.js";
import { EditorRequestRefused } from "./editor-requests.js";
import { TimelineCommandRefused } from "./timeline.js";

/*
 * The two timeline commands that need a sound measured before anything pure can apply them
 * (SPEC-038 R-58, R-59): a gate, kept as the stretches where a clip's sound stands over its own
 * floor, and a clip set to a loudness, applied as the gain that reaches the figure.
 *
 * They are measured here, before the write and outside the world's write gate, and never inside
 * it: decoding a take is seconds of FFmpeg, and the gate holds every other write in the world
 * while it is closed. What goes on to the reducer, to a request's file and to Undo is the
 * measured form: a `sound-gate` with its stretches, and a plain `set-clip-gain`. So a record
 * never holds a gate nobody measured, a card shows the gain it will apply, and replaying history
 * measures nothing.
 *
 * Nothing here is fenced by a revision, because nothing here depends on one: a sound clip's
 * source is a take or an artifact by identity, and its file is read through the same verified
 * snapshot the take checks use. The write that follows carries the fence it always did.
 */

/** Sound is measured at this rate, in one channel: level and loudness of a voice need no more. */
const RATE = 16_000;
/** The decoder gives a minute at most in one read. */
const READ_SEC = 60;

type SoundTools = Pick<AgentMediaTools, "probe" | "monoAudio" | "loudness">;

const refuse = (reason: string): never => { throw new TimelineCommandRefused(reason); };

/** The timeline as the commands will find it: the saved one, or the first one a production gets. */
function currentTimeline(store: WorldStore, production: ProductionBundle): ProductionTimeline {
  const seed = production.timeline?.status === "ready" ? production.timeline.timeline : seedFirstPictureTimeline(production);
  return migrateLegacyCut(seed, production, store.getBundle().artifacts).timeline;
}

function findClip(timeline: ProductionTimeline, clipId: string): { track: TimelineTrack; clip: TimelineClip } | null {
  for (const track of timeline.tracks) { const clip = track.clips.find(row => row.id === clipId); if (clip) return { track, clip }; }
  return null;
}

/** A clip's sound file, read through a verified private snapshot: its path, its hash, and where the clip's window starts in it. */
async function soundOf<T>(store: WorldStore, production: ProductionBundle, clip: TimelineClip, signal: AbortSignal,
  consume: (file: { path: string; inSec: number; outSec: number | undefined }) => Promise<T>): Promise<T> {
  const artifacts = store.getBundle().artifacts, file = clipSoundFile(clip, production, artifacts);
  if (!file.ok) return refuse(file.reason);
  try {
    const source = clip.source.kind === "artifact" ? await agentMediaSource(store, { kind: "artifact", id: clip.source.artifactId })
      : clip.source.kind === "take" ? await agentMediaSource(store, { kind: "production-take", productionId: production.meta.id, takeId: clip.source.takeId }) : null;
    // The plan's file is the one to measure. Where the catalogue names another, a gate would keep the wrong stretches.
    if (!source || source.path !== file.path) return refuse(`${clip.source.label}'s sound cannot be measured: its file is not the one the cut plays`);
    return await withContainedProductionMedia(store.dir, file.path, source.expectedHash, signal, snapshot =>
      consume({ path: snapshot.path, inSec: file.segmentInSec, outSec: file.sourceOutSec }));
  } catch (error) {
    // A file that is gone, or is no longer the one the world recorded, is said as a refusal: a screen and Arke both show those.
    if (error instanceof RetrievalError || error instanceof WorldReferenceError) return refuse(`${clip.source.label}'s sound file is missing or has changed, so it cannot be measured`);
    throw error;
  }
}

/** Where a sound stands over its own floor, across its whole file, so a clip trimmed wider later is still gated by what was measured. */
export async function measureSoundGate(tools: SoundTools, path: string, signal: AbortSignal): Promise<SoundGate> {
  const inventory = await tools.probe(path, signal), audio = inventory.streams.find(stream => stream.kind === "audio"), seconds = inventory.durationSec;
  if (!audio || !tools.monoAudio) return refuse("This sound cannot be measured on this host");
  if (seconds === null || !(seconds > 0)) return refuse("This sound has no known length to measure");
  if (seconds > SOUND_GATE.maxSourceSec) return refuse(`A gate is measured from sound up to ${SOUND_GATE.maxSourceSec / 60} minutes long; this is ${Math.round(seconds / 60)}`);
  const levels: number[] = [];
  // A minute at a time, each on whole steps, so the steps of one read follow the last read's with none split between them.
  for (let at = 0; at < seconds - .001; at += READ_SEC) {
    const samples = await tools.monoAudio(path, audio, at, Math.min(seconds, at + READ_SEC), RATE, signal);
    levels.push(...stepLevels(samples, RATE, SOUND_GATE.stepSec));
  }
  return soundGateFromLevels(levels);
}

/**
 * The gain that brings the stretch a clip plays to a loudness, with its track's level in the sum,
 * to a tenth of a decibel. Measured as the film plays it and not as the file holds it: a take in
 * one channel lands whole in both of the film's, 3 LU louder than its file measures, and a line
 * set from the file's own figure would sit that far over every stereo sound set to the same one.
 */
async function loudnessGain(tools: SoundTools, path: string, fromSec: number, toSec: number, lufs: number, track: TimelineTrack, label: string, signal: AbortSignal): Promise<number> {
  const inventory = await tools.probe(path, signal), audio = inventory.streams.find(stream => stream.kind === "audio");
  if (!audio || !tools.loudness) return refuse("This sound cannot be measured on this host");
  const end = Math.min(toSec, inventory.durationSec ?? toSec);
  if (!(end - fromSec >= .4)) return refuse(`${label} plays too little sound to measure a loudness from`);
  const measured = (await tools.loudness(path, audio, fromSec, end, signal, "film")).integratedLufs;
  if (measured === null) return refuse(`${label} is too quiet to measure a loudness from`);
  const gain = Math.round((lufs - measured - (track.levelDb ?? 0)) * 10) / 10;
  // Said, not clamped: a clip quietly left 9 dB short of what was asked would be found by ear in the mix.
  if (gain > 12 || gain < -60) return refuse(`${label} measures ${measured} LUFS: ${lufs} LUFS would take a gain of ${gain > 0 ? "+" : ""}${gain} dB, and a clip's gain is -60 to +12`);
  return gain;
}

/**
 * The commands with every measurement made: each `sound-gate` that asked for a gate carrying its
 * stretches, and each `match-loudness` as the `set-clip-gain` that reaches its figure. Commands
 * that need nothing measured come back as they went in, and a batch with none is not looked at.
 */
export async function measureTimelineSound(store: WorldStore, productionId: string, commands: readonly TimelineCommand[],
  tools: SoundTools | undefined, signal: AbortSignal): Promise<TimelineCommand[]> {
  if (!commands.some(needsSoundMeasure)) return [...commands];
  const production = store.getBundle().productions.find(candidate => candidate.meta.id === productionId);
  if (!production) return refuse(`production ${productionId} is not in this world`);
  if (!tools?.monoAudio || !tools.loudness) return refuse("Sound cannot be measured on this host, so a gate or a loudness cannot be set here");
  const artifacts = store.getBundle().artifacts, base = currentTimeline(store, production), measured: TimelineCommand[] = [];
  // A clip placed earlier in the same batch is found by applying what comes before it, on a copy nothing keeps.
  const before = (): ProductionTimeline => {
    // A take switch is the coordinator's own write and changes no clip a measurement reads, so the copy goes without it.
    const pure = measured.filter((command): command is TimelineClipCommand => command.kind !== "switch-take");
    if (pure.length === 0) return base;
    try {
      return applyTimelineCommands(base, pure, { effectAuthority: "human", label: "measure", sourceLength: sourceLengthFramesFor(production, artifacts), sources: { production, artifacts } });
    } catch (error) { return error instanceof TimelineOperationRefused ? refuse(error.reason) : (() => { throw error; })(); }
  };
  const clipFor = (clipId: string, what: "gate" | "loudness") => {
    const timeline = before(), found = findClip(timeline, clipId);
    if (!found) return refuse(`${clipId} is not on the timeline`);
    const problem = soundGateProblem(found.track.kind, found.clip);
    if (problem !== null) return refuse(what === "gate" ? problem : problem.replace("A gate is", "A loudness is set"));
    return { ...found, rate: timeline.frameRate };
  };
  for (const command of commands) {
    if (isSoundGateCommand(command) && command.on && command.gate === undefined) {
      const { clip } = clipFor(command.clipId, "gate");
      const gate = await soundOf(store, production, clip, signal, file => measureSoundGate(tools, file.path, signal));
      measured.push({ kind: "sound-gate", clipId: command.clipId, on: true, gate });
    } else if (isMatchLoudnessCommand(command)) {
      const { clip, track, rate } = clipFor(command.clipId, "loudness"), playsSec = framesToSeconds(clip.durationFrames, rate);
      const gainDb = await soundOf(store, production, clip, signal, file => {
        const from = file.inSec + clipSourceInSec(clip, rate), to = Math.min(from + playsSec, file.outSec ?? Infinity);
        return loudnessGain(tools, file.path, from, to, command.lufs, track, clip.source.label, signal);
      });
      measured.push({ kind: "set-clip-gain", clipId: command.clipId, gainDb });
    } else measured.push(command);
  }
  return measured;
}

/**
 * A turn's editor requests with every measurement made (R-60), for the production the thread is
 * about. Each request is measured against the timeline as it stands, as each is previewed, and a
 * sound that cannot be measured refuses the turn in the words a request that cannot apply is
 * refused in, so the model reads which of its requests it was.
 */
export async function measureEditorRequestSound(store: WorldStore, productionId: string | null, requests: readonly ModelEditorRequest[],
  tools: SoundTools | undefined, signal: AbortSignal): Promise<readonly ModelEditorRequest[]> {
  if (productionId === null || !requests.some(request => request.commands.some(needsSoundMeasure))) return requests;
  const measured: ModelEditorRequest[] = [];
  for (const request of requests) {
    try {
      // What comes back is a gate with its stretches or a plain gain: both commands a request may carry.
      measured.push({ ...request, commands: await measureTimelineSound(store, productionId, request.commands, tools, signal) as ModelEditorRequest["commands"] });
    } catch (error) {
      if (error instanceof TimelineCommandRefused) throw new EditorRequestRefused(`"${request.summary.slice(0, 80)}" cannot apply: ${error.reason}`);
      throw error;
    }
  }
  return measured;
}

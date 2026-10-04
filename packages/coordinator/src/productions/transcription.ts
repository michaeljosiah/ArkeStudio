import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ulid, type TimelineTrackId, type TimelineClip, type ProductionBundle, audibleTracks, AUDIO_TRACK_KINDS, orderedTrackClips, effectiveAudioRole, buildRenderPlan, playsWholeAudioSource, type TimelineCommand } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { FfmpegRunner } from "../takes/export.js";
import { toExtendedLength } from "../world/paths.js";
import { audioWorldPath } from "../audio/storage.js";
export interface TranscriptionPorts { ffmpeg?: FfmpegRunner; transcribe?: (audio: Uint8Array, contentType: string) => Promise<string>; }
const AUDIO_CONTENT_TYPES: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac" };
function sourceLengthSec(store: WorldStore, production: ProductionBundle, clip: TimelineClip): number | null {
  const source = clip.source;
  if (source.kind === "take") {
    const take = production.takes.find(t => t.id === source.takeId);
    return production.takeMediaInfo[take?.segment?.passTakeId ?? source.takeId]?.mediaInfo.durationSec ?? null;
  }
  if (source.kind === "artifact") return store.getBundle().artifacts.find(a => a.id === source.artifactId)?.mediaInfo?.durationSec ?? null;
  if (source.kind === "performance") return production.performances.find(p => p.id === source.performanceId)?.provenance.outputTechnical.durationSec ?? null;
  return null;
}

export function dialogueTranscriptionInputs(store: WorldStore, productionId: string) {
  const production = store.getBundle().productions.find(p => p.meta.id === productionId);
  if (!production || production.timeline?.status !== "ready") throw new Error("Speech-to-text needs a saved timeline with Dialogue clips.");
  const dialogue = audibleTracks(production.timeline.timeline).filter(t => AUDIO_TRACK_KINDS.has(t.kind)).flatMap(t => orderedTrackClips(t).filter(c => effectiveAudioRole(t, c) === "dialogue"));
  if (!dialogue.length) throw new Error("There are no audible Dialogue clips to transcribe.");
  const result = buildRenderPlan({ production, artifacts: store.getBundle().artifacts, timeline: production.timeline, scope: { kind: "production" }, preset: "review-cut" });
  if (!result.ok) throw new Error(result.reason);
  for (const clip of dialogue) if (!result.plan.audio.some(item => item.clipId === clip.id)) throw new Error(clip.id + ": this dialogue source is not audible in the cut");
  return { dialogue, plan: result.plan };
}
export function validateDialogueTranscription(store: WorldStore, productionId: string, trackId: TimelineTrackId, language: string, ports: TranscriptionPorts) {
  const input = dialogueTranscriptionInputs(store, productionId);
  const production = store.getBundle().productions.find(p => p.meta.id === productionId)!;
  if (production.timeline?.status !== "ready") throw new Error("The timeline is unavailable.");
  const record = production.timeline.timeline;
  const target = record.tracks.find(t => t.id === trackId);
  if (target && target.kind !== "subtitle") throw new Error("Choose a subtitle track for the transcription draft.");
  if (target?.language && target.language !== language) throw new Error("The requested language differs from this subtitle track.");
  if (target?.cues?.some(cue => input.dialogue.some(clip => cue.startFrame < clip.startFrame + clip.durationFrames && cue.endFrame > clip.startFrame))) throw new Error("Existing subtitle cues overlap these dialogue windows. Choose a new subtitle track.");
  if (!ports.ffmpeg) for (const clip of input.dialogue) {
    const source = input.plan.audio.find(item => item.clipId === clip.id)!;
    if (!playsWholeAudioSource(source, sourceLengthSec(store, production, clip), record.frameRate)) throw new Error(`${clip.id} may play only part of its source, and ffmpeg is needed to transcribe only what it plays`);
    const extension = source.path.toLowerCase().split(".").pop() ?? "";
    if (!AUDIO_CONTENT_TYPES[extension]) throw new Error(`${clip.id} needs ffmpeg to extract audio from its .${extension} source`);
  }
  return input;
}

/** Shared native and chat path: windowed, local STT with cited editable subtitle drafts. */
export async function draftDialogueSubtitles(store: WorldStore, productionId: string, trackId: TimelineTrackId, language: string, ports: TranscriptionPorts): Promise<TimelineCommand[]> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new Error("The production is unavailable.");
  if (production.timeline?.status !== "ready") throw new Error("speech-to-text needs a saved timeline with Dialogue clips");
  if (!ports.transcribe) throw new Error("Voxa is not running — speech-to-text is off");
  validateDialogueTranscription(store, productionId, trackId, language, ports);
  const record = production.timeline.timeline;
  // The same audible set the plan mixes (SPEC-038 R-6): a solo elsewhere silences these
  // clips in preview and export, so it silences them here too (round five).
  const dialogue = audibleTracks(record)
    .filter((track) => AUDIO_TRACK_KINDS.has(track.kind))
    .flatMap((track) => orderedTrackClips(track).filter(clip => effectiveAudioRole(track, clip) === "dialogue"));
  if (dialogue.length === 0) throw new Error("there are no Dialogue clips to transcribe");
  const takesById = new Map(production.takes.map((take) => [take.id, take] as const));
  const commands: TimelineCommand[] = [];
  if (!record.tracks.some((track) => track.id === trackId)) {
    commands.push({ kind: "add-subtitle-track", trackId: trackId, name: `Subtitles (${language})`, language: language });
  }
  const at = new Date().toISOString();
  const ffmpeg = ports.ffmpeg;
  const heard: Array<{ startFrame: number; endFrame: number; text: string; clip: (typeof dialogue)[number] }> = [];
  const transcriptionPlan = buildRenderPlan({ production, artifacts: store.getBundle().artifacts, timeline: production.timeline, scope: { kind: "production" }, preset: "review-cut" });
  if (!transcriptionPlan.ok) throw new Error(transcriptionPlan.reason);
  for (const clip of dialogue) {
    const heardSource = transcriptionPlan.plan.audio.find(item => item.clipId === clip.id);
    if (!heardSource) throw new Error(clip.id + ": the Voice source is not audible in this cut");
    const path = await audioWorldPath(store.dir, heardSource.path);
    let sourceLengthSec: number | null = null;
    if (clip.source.kind === "take") {
      const take = takesById.get(clip.source.takeId);
      sourceLengthSec = production.takeMediaInfo[take?.segment?.passTakeId ?? clip.source.takeId]?.mediaInfo.durationSec ?? null;
    } else if (clip.source.kind === "artifact") {
      const source = clip.source;
      sourceLengthSec = store.getBundle().artifacts.find(artifact => artifact.id === source.artifactId)?.mediaInfo?.durationSec ?? null;
    } else if (clip.source.kind === "performance") {
      const source = clip.source;
      sourceLengthSec = production.performances.find(performance => performance.id === source.performanceId)?.provenance.outputTechnical.durationSec ?? null;
    }
    const sourceInSec = heardSource.sourceInSec;
    const clipSec = heardSource.endSec - heardSource.startSec;
    // Whole-source equivalence has to be established, not assumed: an unmeasured source
    // under a tail-trimmed clip is windowed like any other (round four).
    const wholeSource = playsWholeAudioSource(heardSource, sourceLengthSec, record.frameRate);
    let audio: Buffer;
    let contentType: string;
    if (ffmpeg !== undefined) {
      // Through ffmpeg whenever it is there: the window when the clip plays part of its
      // source, a plain extraction otherwise, so a video container never reaches the
      // model labelled as WAV (round five).
      const windowDir = join(store.dir, ".cache", "transcribe");
      const windowed = join(windowDir, `${ulid()}.wav`);
      await mkdir(toExtendedLength(windowDir), { recursive: true });
      try {
        await ffmpeg.run(
          ["-y", ...(wholeSource ? [] : ["-ss", String(sourceInSec), "-t", String(clipSec)]), "-i", path, "-vn", "-ac", "1", "-ar", "16000", windowed],
          () => {},
          store.closingSignal,
        );
        audio = await readFile(toExtendedLength(windowed));
      } finally {
        await rm(toExtendedLength(windowed), { force: true }).catch(() => {});
      }
      contentType = "audio/wav";
    } else {
      if (!wholeSource) {
        throw new Error(`${clip.id} may play only part of its source, and ffmpeg is needed to transcribe only what it plays`);
      }
      const extension = path.toLowerCase().split(".").pop() ?? "";
      const known: Record<string, string> = {
        wav: "audio/wav",
        mp3: "audio/mpeg",
        m4a: "audio/mp4",
        aac: "audio/aac",
        ogg: "audio/ogg",
        oga: "audio/ogg",
        opus: "audio/ogg",
        flac: "audio/flac",
      };
      const type = known[extension];
      if (type === undefined) throw new Error(`${clip.id} plays a .${extension} source, and ffmpeg is needed to extract its audio for speech-to-text`);
      contentType = type;
      audio = await readFile(toExtendedLength(path));
    }
    const text = (await ports.transcribe(Uint8Array.from(audio), contentType)).trim();
    if (text === "") continue;
    heard.push({ startFrame: clip.startFrame, endFrame: clip.startFrame + clip.durationFrames, text, clip });
  }
  /*
   * Two Dialogue tracks may overlap in time; a subtitle track may not. Overlapping windows
   * become one cue carrying both lines, cited to the first, rather than a second add-cue
   * the batch refuses — which would have thrown away every transcription with it (round
   * four).
   */
  heard.sort((a, b) => a.startFrame - b.startFrame);
  const merged: typeof heard = [];
  for (const item of heard) {
    const last = merged[merged.length - 1];
    if (last !== undefined && item.startFrame < last.endFrame) {
      last.endFrame = Math.max(last.endFrame, item.endFrame);
      last.text = `${last.text} ${item.text}`;
    } else merged.push({ ...item });
  }
  for (const item of merged) {
    const clip = item.clip;
    commands.push({
      kind: "add-cue",
      trackId: trackId,
      cue: {
        id: `cu_${ulid()}`,
        text: item.text.slice(0, 500),
        startFrame: item.startFrame,
        endFrame: item.endFrame,
        ...(clip.source.kind === "take" && clip.source.sheetId !== undefined ? { speaker: clip.source.sheetId } : {}),
        citation: { kind: "clip", clipId: clip.id },
        provenance: { kind: "speech-to-text", model: "voxa", clipId: clip.id, at },
      },
    });
  }
  if (!commands.some((command) => command.kind === "add-cue")) throw new Error("the model heard no words in the Dialogue clips");
  return commands;
}

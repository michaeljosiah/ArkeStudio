import type { ChapterTiming } from "./audiobook-timing.js";
import { AudioArrangementRefusal, audioPassageId, audioSamples, newAudioClip, validateAudioArrangement, type AudioScript } from "./audio-arrangement.js";
import type { AudioArrangementState, AudioSource, AudioArrangementTrack } from "./audio-arrangement-schema.js";

/**
 * Derive on open, persist only with the first accepted edit. File measurement/fingerprinting is
 * supplied by the coordinator; a missing legacy source refuses migration instead of losing it.
 */
/**
 * The chapter's timing keeps seconds to the millisecond, so a take of 41.9196 s is timed as
 * 41.92 s: 18 samples past the end of its own file. The arrangement's trim check is exact and
 * refused the whole chapter for it, which left a read chapter unable to open Audio Studio at all
 * (issue 1827). An end within a millisecond of the source is that rounding and is the source's
 * end; one further out is a real disagreement and is still refused.
 */
const ROUNDING_SAMPLES = audioSamples(0.001);
function endOf(seconds: number, source: AudioSource): number {
  const end = audioSamples(seconds);
  return end > source.samples && end - source.samples <= ROUNDING_SAMPLES ? source.samples : end;
}

export function migrateAudioArrangement(script: AudioScript, timing: ChapterTiming, sources: ReadonlyMap<string, AudioSource>): AudioArrangementState {
  if (Object.values(timing.lost).some(entries => entries.length > 0) || timing.beds.some(bed => bed.cut !== null)) {
    throw new AudioArrangementRefusal("Repair the chapter's unresolved timing cues before migrating its arrangement");
  }
  const passages = script.passages.map(passage => ({ ...passage, id: audioPassageId(passage.key, passage.textHash) }));
  const state: AudioArrangementState = { manuscriptHash: script.hash, passages, tracks: [], clips: [], omissions: [], master: { targetLufs: -18, ceilingDb: -1.5 } };
  const sourceFor = (file: string) => {
    const source = sources.get(file);
    if (!source) throw new AudioArrangementRefusal(`Restore ${file.split("/").pop()} before migrating this chapter`);
    return source;
  };
  const track = (id: string, name: string): AudioArrangementTrack => {
    let held = state.tracks.find(entry => entry.id === id);
    if (!held) { held = { id, name, gainDb: 0, muted: false }; state.tracks.push(held); }
    return held;
  };
  const passageAt = (index: number) => {
    const passage = passages[index];
    if (!passage) throw new AudioArrangementRefusal("The chapter's timing no longer matches its script");
    return passage.id;
  };
  /*
   * A clip cut to its file's end (endOf) is up to a millisecond short of its timing. Positions keep
   * the timing's: a segment follows the ones before it by their timed lengths, and the next
   * passage, placed from where this one actually ends, carries its shortfall (codex on PR 1832),
   * or each rounded take would move the rest of the chapter earlier.
   */
  let previousEnd = 0, carry = 0;
  for (const bar of timing.bars.filter(bar => bar.kind === "block").sort((a, b) => a.index - b.index)) {
    if (!bar.made) continue;
    const lane = track(`voice:${bar.lane}`, bar.lane === "narration" ? "Narrator" : bar.lane);
    let offset = 0, timedEnd = 0, actualEnd = 0;
    for (const [index, segment] of bar.segments.entries()) {
      const source = sourceFor(segment.file);
      const clip = newAudioClip(`voice:${bar.key}:${index}`, lane.id, source, source.samples);
      clip.label = source.label; clip.role = "speech"; clip.passageId = passageAt(bar.index);
      clip.sourceIn = audioSamples(segment.from); clip.sourceOut = endOf(segment.to, source);
      clip.placement = bar.under === null ? { kind: "sequence", offset: audioSamples(bar.at - previousEnd) + carry + offset }
        : { kind: "passage", anchor: { passageId: passages.find(passage => passage.key === bar.under!.host)?.id ?? `missing:${bar.under.host}`, edge: "start", offset: audioSamples(bar.under.offset) + offset } };
      state.clips.push(clip);
      const timed = audioSamples(segment.to) - clip.sourceIn;
      timedEnd = Math.max(timedEnd, offset + timed); actualEnd = Math.max(actualEnd, offset + clip.sourceOut - clip.sourceIn);
      offset += timed;
    }
    if (bar.under === null) { previousEnd = bar.at + bar.seconds; carry = timedEnd - actualEnd; }
  }
  for (const bar of timing.bars.filter(bar => bar.kind === "reaction" && bar.made)) {
    const lane = track(`voice:${bar.lane}`, bar.lane === "narration" ? "Narrator" : bar.lane);
    let offset = 0;
    for (const [index, segment] of bar.segments.entries()) {
      const source = sourceFor(segment.file), clip = newAudioClip(`reaction:${bar.key}:${index}`, lane.id, source, source.samples);
      clip.role = "speech"; clip.sourceIn = audioSamples(segment.from); clip.sourceOut = endOf(segment.to, source);
      clip.placement = { kind: "passage", anchor: { passageId: passageAt(bar.index), edge: "start", offset: audioSamples(bar.under?.offset ?? 0) + offset } };
      state.clips.push(clip); offset += audioSamples(segment.to) - clip.sourceIn;
    }
  }
  for (const bed of timing.beds) {
    const source = sourceFor(bed.source.file), lane = track("beds", "Music & ambience"), clip = newAudioClip(`bed:${bed.id}`, lane.id, source, source.samples);
    clip.role = "music"; clip.loop = true; clip.gainDb = bed.levelDb; clip.fadeIn = audioSamples(bed.fadeInSec); clip.fadeOut = audioSamples(bed.fadeOutSec); clip.duckDb = bed.duckDb;
    clip.placement = { kind: "range", from: { passageId: passageAt(bed.fromIndex), edge: "start", offset: 0 }, to: { passageId: passageAt(bed.toIndex), edge: "end", offset: 0 } };
    state.clips.push(clip);
  }
  for (const sound of timing.sounds) {
    const source = sourceFor(sound.source.file), lane = track("sounds", "Sound effects"), clip = newAudioClip(`sound:${sound.id}`, lane.id, source, source.samples);
    clip.gainDb = sound.levelDb;
    clip.placement = { kind: "passage", anchor: { passageId: passageAt(sound.index), edge: "start", offset: 0 } };
    state.clips.push(clip);
  }
  if (state.tracks.length === 0) track("voice:narration", "Narrator");
  return validateAudioArrangement(state);
}

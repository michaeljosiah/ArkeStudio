import { audioSeconds, audiobookTextHash, listeningChapter, validateAcousticWords,
  type AudiobookPicture, type ListeningChapter } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { FfmpegRunner } from "../takes/export.js";
import type { AudiobookPlan } from "./audiobook.js";
import { audioStudioScript } from "./audio-studio.js";
import { renderAudioStudioMix } from "./audio-studio-mix.js";

/** A migrated chapter never falls back to a newly selected take or the old timing fields. */
export async function audioStudioListening(store: WorldStore, plan: AudiobookPlan, input: {
  chapterId: string; title: string; order: number; cover: string | null;
  pictures: Record<string, AudiobookPicture>; usable: (file: string) => boolean;
  ffmpeg?: FfmpegRunner; signal?: AbortSignal; final?: boolean;
}): Promise<ListeningChapter> {
  const record = plan.record === "unreadable" ? null : plan.record;
  const arrangement = record?.arrangement;
  if (!arrangement) throw new Error("The chapter has no saved audio arrangement");
  const state = arrangement.current;
  const rendered = await renderAudioStudioMix(store.dir, state, audioStudioScript(plan), { ...input, signal: input.signal ? AbortSignal.any([store.closingSignal, input.signal]) : store.closingSignal });
  const badSources = new Set(rendered.plan.issues.filter(issue => issue.kind === "source").map(issue => issue.id));
  const performances = rendered.plan.clips.filter(entry => entry.clip.role === "speech" && entry.clip.source && !badSources.has(entry.clip.id));
  const spans = rendered.plan.passages.filter(passage => passage.samples > 0 && performances.some(entry => entry.clip.passageId === passage.id));
  const chapter = listeningChapter({ ...input,
    blocks: plan.blocks.map(({ block }) => {
      const span = spans.find(passage => passage.key === block.key);
      const performance = span ? performances.find(entry => entry.clip.passageId === span.id) : undefined;
      return { key: block.key, text: block.text, ...(block.starts ? { starts: block.starts } : {}),
        ...(span && performance ? { take: { file: performance.clip.source!.file, seconds: audioSeconds(span.samples), grouped: true,
          ...(performance.clip.source!.artifactId ? { artifactId: performance.clip.source!.artifactId } : {}) } } : {}) };
    }),
    timed: { bars: spans.map(passage => ({ key: passage.key, at: audioSeconds(passage.at), seconds: audioSeconds(passage.samples) })), seconds: rendered.seconds, mix: { file: rendered.file, seconds: rendered.seconds } },
  });
  chapter.seconds = rendered.seconds; chapter.mix = { file: rendered.file, seconds: rendered.seconds };
  chapter.state = rendered.issues.length ? "part" : "read";
  chapter.audioStudio = { revision: arrangement.revision, issues: rendered.issues.map(issue => issue.message), omissions: state.omissions.filter(entry => entry.acknowledged).map(entry => entry.label) };
  // Retain exact sample positions for captions; the legacy helper deliberately rounds to milliseconds.
  for (const block of chapter.blocks) {
    const span = spans.find(passage => passage.key === block.key)!;
    const shift = audioSeconds(span.at) - block.at; block.at += shift; block.seconds = audioSeconds(span.samples);
    for (const sentence of block.sentences) sentence.at += shift;
    const entries = performances.filter(entry => entry.clip.passageId === span.id);
    const text = plan.blocks.find(entry => entry.block.key === block.key)!.block.text;
    const words = [];
    let reason: string | undefined;
    for (const entry of entries) {
      const timing = Object.values(record!.wordTiming ?? {}).find(value => value.audioHash === entry.clip.source!.hash && value.textHash === audiobookTextHash(text));
      if (!timing || !validateAcousticWords(text, { text, seconds: timing.seconds, engine: timing.engine, words: timing.words }).ok) { reason = "word timing not prepared for this exact arranged take"; break; }
      if (entry.clip.loop || performances.some(other => other.clip.id !== entry.clip.id && other.at < entry.at + entry.samples && other.at + other.samples > entry.at)) { reason = "overlapping or looped voices need a caption lane"; break; }
      const from = audioSeconds(entry.clip.sourceIn), to = audioSeconds(entry.clip.sourceOut), at = audioSeconds(entry.at);
      for (const word of timing.words) if (word.endSec > from && word.startSec < to) words.push({ ...word,
        startSec: at + Math.max(from, word.startSec) - from, endSec: at + Math.min(to, word.endSec) - from });
    }
    if (reason || !words.length) block.wordTimingReason = reason ?? "word timing not prepared";
    else block.words = words.sort((a, b) => a.startSec - b.startSec);
  }
  return chapter;
}

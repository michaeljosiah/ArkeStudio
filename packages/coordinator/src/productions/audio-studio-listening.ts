import { audioSeconds, audiobookTextHash, listeningChapter, validateAcousticWords,
  type AudiobookPicture, type ListeningChapter } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { FfmpegRunner } from "../takes/export.js";
import type { AudiobookPlan } from "./audiobook.js";
import { audioStudioScript, audioStudioSourceProblems, openAudioStudio } from "./audio-studio.js";
import { renderAudioStudioMix } from "./audio-studio-mix.js";

/** A migrated chapter never falls back to a newly selected take or the old timing fields. */
export async function audioStudioListening(store: WorldStore, plan: AudiobookPlan, input: {
  productionId: string; chapterId: string; title: string; order: number; cover: string | null;
  pictures: Record<string, AudiobookPicture>; usable: (file: string) => boolean;
  ffmpeg?: FfmpegRunner; signal?: AbortSignal; final?: boolean;
}): Promise<ListeningChapter> {
  const record = plan.record === "unreadable" ? null : plan.record;
  const arrangement = record?.arrangement;
  if (!arrangement) throw new Error("The chapter has no saved audio arrangement");
  const opened = await openAudioStudio(store, input.productionId, input.chapterId, input);
  if (JSON.stringify(opened.saved) !== JSON.stringify(arrangement) || opened.script.hash !== plan.chapter.hash) throw new Error("The chapter changed while preparing Listen; open it again");
  const state = arrangement.current;
  const unavailable = await audioStudioSourceProblems(store, input.productionId, state);
  const rendered = await renderAudioStudioMix(store.dir, state, audioStudioScript(plan), { ...input, unavailable, retainUntil: store.closingSignal, signal: input.signal ? AbortSignal.any([store.closingSignal, input.signal]) : store.closingSignal });
  const fresh = await openAudioStudio(store, input.productionId, input.chapterId, input);
  const currentAvailability = await audioStudioSourceProblems(store, input.productionId, state);
  if (fresh.base !== opened.base || JSON.stringify([...currentAvailability]) !== JSON.stringify([...unavailable])) throw new Error("The chapter or source clearance changed during rendering; open Listen again");
  const badSources = new Set(rendered.plan.issues.filter(issue => issue.kind === "source").map(issue => issue.id));
  const performances = rendered.plan.clips.filter(entry => entry.clip.role === "speech" && entry.clip.source && !entry.muted && !badSources.has(entry.clip.id));
  const spans = rendered.plan.passages.filter(passage => passage.samples > 0 && performances.some(entry => entry.clip.passageId === passage.id && !entry.clip.repeated));
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
  const repeated = new Map<string, typeof performances[number]>();
  for (const entry of performances.filter(entry => entry.clip.repeated)) {
    const passage = rendered.plan.passages.find(passage => passage.id === entry.clip.passageId);
    const block = plan.blocks.find(row => row.block.key === passage?.key)?.block;
    if (!block) continue;
    const key = `${block.key}:repeat:${entry.clip.id}`;
    const copy = listeningChapter({ ...input, blocks: [{ key, text: block.text, take: { file: entry.clip.source!.file, seconds: audioSeconds(entry.samples), grouped: true } }],
      timed: { bars: [{ key, at: audioSeconds(entry.at), seconds: audioSeconds(entry.samples) }], seconds: rendered.seconds, mix: { file: rendered.file, seconds: rendered.seconds } } }).blocks[0];
    if (copy) { chapter.blocks.push(copy); repeated.set(key, entry); }
  }
  // Retain exact sample positions for captions; the legacy helper deliberately rounds to milliseconds.
  for (const block of chapter.blocks) {
    const repeat = repeated.get(block.key);
    const span = repeat ? { id: repeat.clip.passageId!, at: repeat.at, samples: repeat.samples } : spans.find(passage => passage.key === block.key)!;
    const shift = audioSeconds(span.at) - block.at; block.at += shift; block.seconds = audioSeconds(span.samples);
    for (const sentence of block.sentences) sentence.at += shift;
    const entries = repeat ? [repeat] : performances.filter(entry => entry.clip.passageId === span.id && !entry.clip.repeated);
    const textKey = repeat ? rendered.plan.passages.find(passage => passage.id === repeat.clip.passageId)!.key : block.key;
    const text = plan.blocks.find(entry => entry.block.key === textKey)!.block.text;
    const words = [];
    let reason: string | undefined;
    for (const entry of entries) {
      const timing = Object.values(record!.wordTiming ?? {}).find(value => value.audioHash === entry.clip.source!.hash && value.textHash === audiobookTextHash(text));
      if (!timing || !validateAcousticWords(text, { text, seconds: timing.seconds, engine: timing.engine, words: timing.words }).ok) { reason = "word timing not prepared for this exact arranged take"; break; }
      if (entry.clip.loop || performances.some(other => other.clip.id !== entry.clip.id && other.at < entry.at + entry.samples && other.at + other.samples > entry.at)) { reason = "overlapping or looped voices need a caption lane"; break; }
      const from = audioSeconds(entry.clip.sourceIn), to = Math.min(audioSeconds(entry.clip.sourceOut), from + audioSeconds(entry.samples)), at = audioSeconds(entry.at);
      const included = timing.words.filter(word => word.endSec > from && word.startSec < to);
      if (included.some(word => word.startSec < from || word.endSec > to)) { reason = "the arranged trim cuts through a word; move the trim to a word boundary"; break; }
      for (const word of included) words.push({ ...word, startSec: at + word.startSec - from, endSec: at + word.endSec - from });
    }
    if (reason || !words.length) block.wordTimingReason = reason ?? "word timing not prepared";
    else block.words = words.sort((a, b) => a.startSec - b.startSec);
  }
  chapter.blocks.sort((a, b) => a.at - b.at);
  return chapter;
}

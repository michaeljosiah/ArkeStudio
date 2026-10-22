import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GUIDE_RECORD_FILE,
  GuideRecordSchema,
  EMPTY_GUIDE_RECORD,
  guideProductionsOf,
  MAX_GUIDE_VOICE_MS,
  type GuideProductionChapters,
  type GuideRecord,
  type GuideRecordVoice,
  type GuideVoiceLine,
  type ListeningChapter,
  type SetGuideEntry,
} from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { sha256 } from "../world/text-files.js";
import { planAudiobook } from "./audiobook.js";
import { anyNarrator, audiobookListening } from "./audiobook-listening.js";

/**
 * A world's Guide in the coordinator (SPEC-059 R-1 – R-8): the record's one write, the chapters an
 * `after` can name, and the lines a character's voice line is chosen from. What the record makes
 * public is read by `guideDocument` in contracts, for the Studio's preview and the package alike.
 */

/** The record as on disk; a world without one has chosen nothing (R-2). */
async function liveGuide(store: WorldStore): Promise<{ raw: string | null; record: GuideRecord }> {
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, GUIDE_RECORD_FILE)), "utf8");
  } catch {
    return { raw: null, record: EMPTY_GUIDE_RECORD };
  }
  // A record that will not read is not written over: the choices in it are the author's, and an
  // empty Guide in their place would quietly unpublish everything at the next package.
  const parsed = GuideRecordSchema.safeParse((() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })());
  if (!parsed.success) throw new Error("guide.json can't be read · fix it or remove it");
  return { raw, record: parsed.data };
}

/** Replaces one entry's choices, or clears them (R-4, R-8), through the world's own write. */
export async function setGuideEntry(store: WorldStore, change: SetGuideEntry, source: string): Promise<void> {
  const { raw, record } = await liveGuide(store);
  const kind = record[change.entryKind] as Record<string, unknown>;
  const next = { ...kind };
  if (change.entry === null) delete next[change.id];
  else next[change.id] = change.entry;
  const written: GuideRecord = GuideRecordSchema.parse({ ...record, [change.entryKind]: next });
  await store.commit({
    kind: "guide-save",
    source,
    files: [{ path: GUIDE_RECORD_FILE, action: raw === null ? "create" : "replace", content: `${JSON.stringify(written, null, 2)}\n`, baseHash: raw === null ? null : sha256(raw) }],
  });
}

/** Each production's chapters as the Guide numbers them (contracts' `guideProductionsOf`). */
export function guideProductions(store: WorldStore): GuideProductionChapters[] {
  return guideProductionsOf(store.getBundle().productions);
}

/** A chapter read whole: every block made, as the package's narration needs. */
const readWhole = (chapter: ListeningChapter) => chapter.state === "read" && (chapter.blocks.length > 0 || (chapter.audioStudio !== undefined && chapter.mix !== undefined));

/**
 * Each sentence of a block the character's own voice reads (R-6), in a chapter read whole, short
 * enough to be a voice line. A block the narrator reads for them is the narrator's voice, not
 * theirs, so a character with no line of their own read has none. Times come from the take: a
 * sentence starts where the plan places it in its block, and runs to the next one.
 */
export async function guideVoiceLines(store: WorldStore, characterId: string, signal?: AbortSignal): Promise<GuideVoiceLine[]> {
  const lines: GuideVoiceLine[] = [];
  for (const production of guideProductions(store)) {
    signal?.throwIfAborted();
    const numbers = new Map(production.chapters.map((chapter) => [chapter.id, chapter.number]));
    const listening = await audiobookListening(store, production.id, signal !== undefined ? { signal } : {}).catch(() => null);
    if (listening === null) continue;
    const narrator = await anyNarrator(store, production.id);
    for (const chapter of listening.chapters.filter(readWhole)) {
      const plan = await planAudiobook(store, production.id, chapter.chapterId, { narrator }).catch(() => null);
      if (plan === null) continue;
      const theirs = new Set(plan.blocks.filter((planned) => planned.sheet === characterId && planned.substituted === undefined).map((planned) => planned.block.key));
      for (const block of chapter.blocks) {
        if (!theirs.has(block.key)) continue;
        block.sentences.forEach((sentence, index) => {
          const start = Math.max(0, sentence.at - block.at);
          const end = (block.sentences[index + 1]?.at ?? block.at + block.seconds) - block.at;
          const seconds = end - start;
          const text = sentence.text.trim();
          if (text === "" || seconds <= 0 || seconds * 1000 > MAX_GUIDE_VOICE_MS) return;
          lines.push({
            production: production.id,
            productionTitle: production.title,
            chapter: chapter.chapterId,
            chapterNumber: numbers.get(chapter.chapterId) ?? chapter.order,
            block: block.key,
            sentence: index,
            text,
            file: block.file,
            start,
            seconds,
          });
        });
      }
    }
  }
  return lines;
}

/** The line a record names, as it is now: null when its take, block or sentence is gone. */
export function resolveGuideVoice(lines: readonly GuideVoiceLine[], voice: GuideRecordVoice): GuideVoiceLine | null {
  return lines.find((line) => line.production === voice.production && line.chapter === voice.chapter && line.block === voice.block && line.sentence === voice.sentence) ?? null;
}

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  audiobookDirectionFor,
  audiobookTakeDirectionHash,
  audiobookTextHash,
  holdDirection,
  performanceNote,
  DEFAULT_AUDIOBOOK_BOOK,
  type AudiobookReader,
  type AudiobookTake,
  type AudiobookDoor,
  type AudiobookPriceLine,
  type AudiobookRow,
  type AudiobookVoiceRow,
  type ChapterAudiobook,
  type ChapterSummary,
  type ClonedVoice,
} from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { castRefusal, checkDirection, effectiveReader, planAudiobook, readAudiobookBook, readerLanguage, updateAudiobook, type AudiobookPlan } from "./audiobook.js";
import { directableBlocks, type DirectableBlock } from "./audiobook-direction.js";
import { chapterPriceToken, missIdentity, prepareChapter, type ChapterPreparation, type ReadingRoom, type Speaking } from "./audiobook-run.js";

/**
 * The book (design turn 146, SPEC-047 R-15..R-17, R-29): every chapter prepared as its own
 * press would prepare it, read together. The door is that preparation shown — a row a chapter
 * with its counts, the voices the book reads in and what stands in for whom, the price of one
 * press — and `Read the book` is that preparation run: priced once for every chapter's cloud
 * blocks, then a chapter at a time in order, each on the book's answer rather than its own.
 */

export interface PreparedBook {
  chapters: Array<{ summary: ChapterSummary; preparation: ChapterPreparation }>;
}

/** Every chapter of the production, in order, retired ones left out, prepared as a press would. */
export async function prepareBook(store: WorldStore, productionId: string, room: ReadingRoom, now: () => string): Promise<PreparedBook> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new Error("That production is no longer in this world.");
  const chapters: PreparedBook["chapters"] = [];
  for (const summary of [...production.chapters].filter((c) => !c.retired).sort((a, b) => a.order - b.order)) {
    chapters.push({ summary, preparation: await prepareChapter(store, productionId, summary.id, room, now) });
  }
  return { chapters };
}

/** The made takes' running time, when every one of them was measured; null otherwise. */
function runningTime(store: WorldStore, plan: Pick<AudiobookPlan, "blocks">, record: ChapterAudiobook | "unreadable" | null): number | null {
  if (record === null || record === "unreadable") return 0;
  let seconds = 0;
  for (const planned of plan.blocks) {
    if (planned.state !== "made") continue;
    const take = record.takes[planned.block.key];
    const artifact = take === undefined ? undefined : store.getBundle().artifacts.find((candidate) => candidate.id === take.artifactId);
    const duration = artifact?.mediaInfo?.durationSec;
    if (duration === undefined) return null;
    seconds += duration;
  }
  return seconds;
}

/**
 * The price's lines for a book (R-17), by who speaks: every cloud voice with its characters and
 * its share, each voice on this machine — the narrator's, and a cast voice that reads on the
 * same engine as a line of its own (codex on PR 1187) — with its characters and nothing to
 * pay, and each speaker the narrator stands in for as a line of its own — said in warning on
 * the card, and counted apart from the narrator's own share so the sum is exact.
 */
export function bookPriceLines(narrator: ReadingRoom["narrator"], speaking: readonly Speaking[], misses: readonly Speaking[], priceOf: (block: Speaking) => number, sheetName: (sheet: string) => string): AudiobookPriceLine[] {
  const stoodIn = new Map<string, AudiobookPriceLine>();
  const own: Speaking[] = [];
  const isNarrator = (reader: Speaking["reader"]) => reader.provider === narrator.provider && reader.model === narrator.model && reader.voiceId === narrator.voiceId;
  for (const block of speaking) {
    if (block.refusal !== undefined) continue;
    const substituted = block.substitutedNow ?? block.substituted;
    // A speaker with no sheet at all is stood in for like one with no voice (codex on PR
    // 1187): named by the name the cast gave, never folded into the narrator's own words.
    const speaker = block.sheet !== undefined ? sheetName(block.sheet) : block.block.speaker;
    if (substituted === undefined || speaker === undefined) {
      own.push(block);
      continue;
    }
    const key = block.sheet ?? `:${speaker}`;
    const held = stoodIn.get(key) ?? {
      label: block.reader.label ?? block.reader.voiceId,
      provider: block.reader.provider,
      speaker,
      substituted,
      local: block.local,
      characters: 0,
      estimatedMicroUsd: 0,
    };
    held.characters += block.text.length;
    held.estimatedMicroUsd += misses.includes(block) ? priceOf(block) : 0;
    stoodIn.set(key, held);
  }
  // A line a voice: every block of a voice on this machine, free; the cloud misses of a cloud
  // voice, priced — as `priceLines` counts them for the chapter's own card.
  const lines = new Map<string, AudiobookPriceLine>();
  for (const block of own) {
    if (!block.local && !misses.includes(block)) continue;
    const key = `${block.reader.provider}\n${block.reader.voiceId}`;
    const held = lines.get(key) ?? {
      label: block.reader.label ?? block.reader.voiceId,
      provider: block.reader.provider,
      ...(isNarrator(block.reader) ? { narrator: true as const } : {}),
      local: block.local,
      characters: 0,
      estimatedMicroUsd: 0,
    };
    held.characters += block.text.length;
    held.estimatedMicroUsd += block.local ? 0 : priceOf(block);
    lines.set(key, held);
  }
  return [...lines.values(), ...stoodIn.values()];
}

/** What every chapter stands at, who reads, and what a press would spend (R-15, R-29). */
export async function audiobookDoor(store: WorldStore, productionId: string, room: ReadingRoom, now: () => string): Promise<AudiobookDoor> {
  const book = await prepareBook(store, productionId, room, now);
  const sheets = store.getBundle().sheets;
  const sheetName = (id: string) => sheets.find((sheet) => sheet.id === id)?.name ?? id;
  const rows: AudiobookRow[] = [];
  const voices = new Map<string, AudiobookVoiceRow>();
  const narratorRow: AudiobookVoiceRow = {
    name: room.narrator.label ?? room.narrator.voiceId,
    voice: { label: room.narrator.label ?? room.narrator.voiceId, provider: room.narrator.provider, local: room.narrator.provider === "kokoro" },
    state: "narrator",
    blocks: 0,
  };
  let unattributed = 0;
  // The reading is the book's own (R-11), read from its file rather than off a chapter's plan:
  // a production with no chapter yet still holds the seg where it was put (codex on PR 1187).
  const bookFile = await readAudiobookBook(store, productionId);
  const reading: AudiobookDoor["reading"] = bookFile === null || bookFile === "unreadable" ? DEFAULT_AUDIOBOOK_BOOK.reading : bookFile.reading;
  // The book's own narrator, when it has one and it speaks now (R-46), is said on its chip.
  const own = bookFile === null || bookFile === "unreadable" ? undefined : bookFile.narrator;
  if (own !== undefined && sameVoice(own, room.narrator)) narratorRow.book = true;
  // A narrator whose row takes no phrase cannot play a note (R-45): said on each noted speaker
  // before anything is made.
  const narratorModel = room.models.find((m) => m.provider === room.narrator.provider && m.id === room.narrator.model && m.capability === "voice-tts") ?? null;
  const narratorLanguage = readerLanguage(store.getBundle().clonedVoices ?? [], room.narrator);
  const toRead: Array<Extract<ChapterPreparation, { kind: "ready" }>["prepared"]> = [];
  for (const { summary, preparation } of book.chapters) {
    const base = { chapterId: summary.id, file: summary.file, order: summary.order, title: summary.title, version: summary.version };
    if (preparation.kind === "unavailable") {
      rows.push({ ...base, planned: false, total: 0, made: 0, stale: 0, flagged: 0, notMade: 0, seconds: null, castTrouble: preparation.reason });
      continue;
    }
    const plan = preparation.kind === "ready" ? preparation.prepared.plan : preparation.plan;
    unattributed += plan.cast !== null && plan.cast !== "unreadable" ? plan.ambiguous : 0;
    const counts: { total: number; made: number; stale: number; flagged: number; notMade: number; awaiting?: number } = { total: plan.blocks.length, made: 0, stale: 0, flagged: 0, notMade: 0 };
    for (const planned of plan.blocks) {
      if (planned.state === "made") counts.made += 1;
      else if (planned.state === "stale") counts.stale += 1;
      else if (planned.state === "flagged") counts.flagged += 1;
      else if (planned.state === "awaiting") counts.awaiting = (counts.awaiting ?? 0) + 1;
      else counts.notMade += 1;
    }
    // Who reads what, across the book (R-12): the narrator's row counts narration and every
    // block that falls to it; a speaker's row names the voice that reads them, or why it does
    // not — no sheet, no voice, or a voice that cannot speak now.
    for (const planned of plan.blocks) {
      // A speaker a person records is their own chip under every reading (R-37, R-38): who
      // records them, and how many of their blocks wait on a recording.
      if (planned.recorded === true && planned.block.speaker !== undefined) {
        const key = planned.sheet ?? planned.block.sheet ?? `:${planned.block.speaker}`;
        const sheet = planned.sheet ?? planned.block.sheet;
        const held = voices.get(key) ?? { ...(sheet !== undefined ? { sheet } : {}), name: sheet !== undefined ? sheetName(sheet) : planned.block.speaker, state: "recorded" as const, blocks: 0 };
        held.state = "recorded";
        held.blocks += 1;
        if (planned.state === "awaiting") held.awaiting = (held.awaiting ?? 0) + 1;
        voices.set(key, held);
        continue;
      }
      if (plan.reading === "performed" && planned.block.speaker !== undefined) {
        // One narrator performs the cast (R-44): the narrator reads the line, and the speaker's
        // row carries the note it is played with.
        narratorRow.blocks += 1;
        const key = planned.sheet ?? planned.block.sheet ?? `:${planned.block.speaker}`;
        const sheet = planned.sheet ?? planned.block.sheet;
        const held = voices.get(key) ?? { ...(sheet !== undefined ? { sheet } : {}), name: sheet !== undefined ? sheetName(sheet) : planned.block.speaker, state: "narrator" as const, blocks: 0 };
        held.blocks += 1;
        if (planned.note !== undefined) {
          held.note = planned.note;
          if (narratorModel === null || performanceNote(planned.note, narratorModel, narratorLanguage).mode === "unsupported") held.noteHeld = true;
        }
        voices.set(key, held);
        continue;
      }
      if (planned.block.speaker === undefined || plan.reading !== "cast") {
        narratorRow.blocks += 1;
        continue;
      }
      const key = planned.sheet ?? `:${planned.block.speaker}`;
      const held = voices.get(key) ?? {
        ...(planned.sheet !== undefined ? { sheet: planned.sheet } : {}),
        name: planned.sheet !== undefined ? sheetName(planned.sheet) : planned.block.speaker,
        state: "no voice" as const,
        blocks: 0,
      };
      held.blocks += 1;
      if (planned.substituted === undefined) {
        const speaks = await effectiveReader(store, planned.assigned, room);
        if (speaks !== null && speaks.substitutedNow === undefined) {
          held.state = "reads";
          held.voice = { label: planned.assigned.label ?? planned.assigned.voiceId, provider: planned.assigned.provider, local: planned.assigned.provider === "kokoro" };
        } else {
          held.state = "voice unavailable";
          held.voice = { label: planned.assigned.label ?? planned.assigned.voiceId, provider: planned.assigned.provider, local: planned.assigned.provider === "kokoro" };
          narratorRow.blocks += 1;
        }
      } else narratorRow.blocks += 1;
      voices.set(key, held);
    }
    // The takes made stand whatever the reading (R-13), so a chapter refused under `cast` —
    // its cast not current — keeps its running time on the row and in the door's line (issue
    // 1191): the time is the kept takes', and they are still there.
    const seconds = counts.made > 0 ? runningTime(store, plan, plan.record) : 0;
    if (preparation.kind === "refused") {
      rows.push({ ...base, planned: plan.blocks.length === 0, ...counts, seconds, castTrouble: preparation.reason });
      continue;
    }
    rows.push({ ...base, planned: plan.blocks.length === 0, ...counts, seconds });
    if (preparation.prepared.toMake.length > 0) toRead.push(preparation.prepared);
  }
  const speaking = toRead.flatMap((prepared) => prepared.speaking);
  const misses = toRead.flatMap((prepared) => prepared.misses);
  const priceOf = (block: Speaking) => toRead.find((prepared) => prepared.speaking.includes(block))!.priceOf(block);
  return {
    reading,
    voices: [narratorRow, ...voices.values()],
    unattributed,
    rows,
    price: {
      chapters: toRead.length,
      blocks: toRead.reduce((sum, prepared) => sum + prepared.toMake.length, 0),
      cloudBlocks: misses.length,
      characters: misses.reduce((sum, block) => sum + block.text.length, 0),
      estimatedMicroUsd: toRead.reduce((sum, prepared) => sum + prepared.estimate, 0),
      voices: bookPriceLines(room.narrator, speaking, misses, priceOf, sheetName),
    },
  };
}

export type AudiobookBookEvent =
  | { type: "started"; chapters: number; blocks: number }
  | { type: "priced"; chapters: number; blocks: number; cloudBlocks: number; characters: number; estimatedMicroUsd: number; confirmationToken: string; voices: AudiobookPriceLine[] }
  | { type: "progress"; chapterId: string; done: number; chapters: number }
  | { type: "finished"; outcome: "read" | "stopped" | "unavailable" | "failed"; chaptersRead: number; chaptersRefused: number; made: number; flagged: number; reason?: string };

export interface AudiobookBookDeps {
  store: WorldStore;
  worldId: string;
  productionId: string;
  room: ReadingRoom;
  signal: AbortSignal;
  confirmationToken?: string;
  requireUploadConfirmation: (reader: { provider: string; voice: ClonedVoice }) => boolean | Promise<boolean>;
  /** One chapter read on the book's answer: the chapter's own run under the book's signal, `priced` carrying the chapter's price token as the book priced it. */
  runChapter: (chapterId: string, priced: string) => Promise<{ outcome: "read" | "stopped" | "unavailable" | "failed" | "refused"; made: number; flagged: number; reason?: string }>;
  emit: (event: AudiobookBookEvent) => void;
  now: () => string;
}

/**
 * `Read the book` (R-16..R-18): every chapter with prose in order, the ones under `cast` whose
 * cast is not current left to their rows and counted, priced once for every cloud block the
 * cache lacks, each cloned voice's consent asked first, then a chapter at a time — its own run,
 * on the book's answer — the takes made so far standing at a stop.
 */
export async function runAudiobookBook(deps: AudiobookBookDeps): Promise<void> {
  const { store, productionId, room, signal, emit } = deps;
  const book = await prepareBook(store, productionId, room, deps.now);
  let refused = 0;
  const toRead: Array<{ summary: ChapterSummary; prepared: Extract<ChapterPreparation, { kind: "ready" }>["prepared"] }> = [];
  for (const { summary, preparation } of book.chapters) {
    if (preparation.kind === "unavailable") {
      emit({ type: "started", chapters: 0, blocks: 0 });
      emit({ type: "finished", outcome: "unavailable", chaptersRead: 0, chaptersRefused: 0, made: 0, flagged: 0, reason: preparation.reason });
      return;
    }
    if (preparation.kind === "refused") {
      refused += 1;
      continue;
    }
    if (preparation.prepared.toMake.length > 0) toRead.push({ summary, prepared: preparation.prepared });
  }
  emit({ type: "started", chapters: toRead.length, blocks: toRead.reduce((sum, entry) => sum + entry.prepared.toMake.length, 0) });
  if (toRead.length === 0) {
    emit({ type: "finished", outcome: "read", chaptersRead: 0, chaptersRefused: refused, made: 0, flagged: 0 });
    return;
  }
  // Every cloned voice among the book's misses, once, hosted readers first (R-17).
  const clones = new Map<string, { provider: string; voice: ClonedVoice }>();
  for (const entry of toRead) for (const reader of entry.prepared.clones) clones.set(`${reader.provider}\n${reader.voice.id}`, reader);
  const askOrder = [...clones.values()].sort((a, b) => Number(a.provider === "comfyui") - Number(b.provider === "comfyui"));
  for (const reader of askOrder) {
    if (await deps.requireUploadConfirmation(reader)) return;
  }
  const estimate = toRead.reduce((sum, entry) => sum + entry.prepared.estimate, 0);
  if (estimate > 0) {
    const token = createHash("sha256")
      .update(
        [
          "audiobook-book",
          deps.worldId,
          productionId,
          ...toRead.flatMap((entry) => [`${entry.summary.id}:${entry.prepared.plan.chapter.version}:${entry.prepared.plan.chapter.hash}`, ...entry.prepared.misses.map(missIdentity)]),
        ].join("\n"),
      )
      .digest("hex");
    if (deps.confirmationToken !== token) {
      const speaking = toRead.flatMap((entry) => entry.prepared.speaking);
      const misses = toRead.flatMap((entry) => entry.prepared.misses);
      const priceOf = (block: Speaking) => toRead.find((entry) => entry.prepared.speaking.includes(block))!.prepared.priceOf(block);
      const sheets = store.getBundle().sheets;
      emit({
        type: "priced",
        chapters: toRead.length,
        blocks: toRead.reduce((sum, entry) => sum + entry.prepared.toMake.length, 0),
        cloudBlocks: misses.length,
        characters: misses.reduce((sum, block) => sum + block.text.length, 0),
        estimatedMicroUsd: estimate,
        confirmationToken: token,
        voices: bookPriceLines(room.narrator, speaking, misses, priceOf, (id) => sheets.find((sheet) => sheet.id === id)?.name ?? id),
      });
      return;
    }
  }
  let made = 0;
  let flagged = 0;
  let read = 0;
  let done = 0;
  for (const entry of toRead) {
    if (signal.aborted) break;
    // The chapter's price as the book priced it (R-17): the chapter's run reads on it only
    // while the chapter is still what was priced (codex on PR 1187).
    const result = await deps.runChapter(entry.summary.id, chapterPriceToken(deps.worldId, productionId, entry.summary.id, entry.prepared.plan.chapter, entry.prepared.misses));
    made += result.made;
    flagged += result.flagged;
    if (result.outcome === "refused") refused += 1;
    else if (result.outcome === "failed" || result.outcome === "unavailable") {
      emit({ type: "finished", outcome: result.outcome, chaptersRead: read, chaptersRefused: refused, made, flagged, ...(result.reason !== undefined ? { reason: result.reason } : {}) });
      return;
    } else if (result.outcome === "read") read += 1;
    if (result.outcome === "stopped") break;
    // The progress counts the chapters the book is past, a refused one included (codex on PR
    // 1187): the count on the door is how far the book is, and the refused are named at the end.
    done += 1;
    emit({ type: "progress", chapterId: entry.summary.id, done, chapters: toRead.length });
  }
  emit({ type: "finished", outcome: signal.aborted ? "stopped" : "read", chaptersRead: read, chaptersRefused: refused, made, flagged });
}

/**
 * Directions re-checked against changed readers (R-13, amended by R-47): the reading switched,
 * or a sheet's voice reassigned, moves blocks to the narrator or to a new voice. What the new
 * reader cannot express is held, not dropped — kept on the record, left out of what is sent,
 * counted here — so a reader that can express it again gets it back. Only a direction wrong for
 * its words is dropped and written. A chapter whose cast is not current is left alone: its run
 * refuses before any direction matters.
 */
export async function conformDirections(store: WorldStore, productionId: string, room: ReadingRoom): Promise<{ dropped: number; held: number; chapters: number }> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) return { dropped: 0, held: 0, chapters: 0 };
  let dropped = 0;
  let heldCount = 0;
  let chapters = 0;
  for (const summary of production.chapters.filter((c) => !c.retired)) {
    const stamp = summary.audiobook;
    if (stamp === undefined || "unreadable" in stamp || summary.bodyHash === undefined) continue;
    // Every standing direction held to its reader's row: the blocks with the readers that
    // speak them now, and the record, both read under the chapter's lane (codex on PR 1187,
    // twice): a direction another window set meanwhile is conformed with the rest rather than
    // erased by a stale map, and two changes of reading or voice close together are judged
    // in the order they land, each against the readers that stand when its turn comes, rather
    // than the slower one applying a superseded reader's limits last.
    const conform = (blocks: DirectableBlock[], record: Pick<ChapterAudiobook, "direction">): { direction: ChapterAudiobook["direction"]; dropped: number; held: number; changed: boolean } => {
      const next: ChapterAudiobook["direction"] = { ...record.direction };
      let count = 0;
      let held = 0;
      let changed = false;
      for (const block of blocks) {
        const direction = audiobookDirectionFor(record, block);
        if (direction === null) continue;
        const check = checkDirection(block.text, direction.plan, block.model, block.language, "hold");
        if (check.ok) {
          held += check.held.length;
          continue;
        }
        count += 1;
        delete next[block.key];
        changed = true;
      }
      return { direction: next, dropped: count, held, changed };
    };
    let applied = { dropped: 0, held: 0, changed: false };
    await updateAudiobook(store, productionId, { file: summary.file, version: summary.version, hash: summary.bodyHash }, async (current) => {
      if (Object.keys(current.direction).length === 0) return null;
      let readable: Awaited<ReturnType<typeof directableBlocks>>;
      try {
        readable = await directableBlocks(store, productionId, summary.id, room);
      } catch {
        // A chapter whose cast is not current, or whose narrator's model is gone, is left as
        // it stands: its run refuses before any direction matters.
        return null;
      }
      const conformed = conform(readable.blocks, current);
      applied = { dropped: conformed.dropped, held: conformed.held, changed: conformed.changed };
      return conformed.changed ? { ...current, updatedAt: store.now(), direction: conformed.direction } : null;
    });
    dropped += applied.dropped;
    heldCount += applied.held;
    if (applied.changed || applied.held > 0) chapters += 1;
  }
  return { dropped, held: heldCount, chapters };
}

/**
 * Takes follow the reader (design turn 155h, SPEC-047 R-48): when a block's reader changes, a
 * take on the shelf that is current for the block now — the same words, the reader it is meant
 * for, the same direction and note, not retired, its media still there — becomes the record's
 * choice again without a call, the newest if several. Switching back to a narrator makes their
 * kept takes current at no cost; a switch never deletes a take. A recorded speaker's blocks are
 * left to their recordings. Returns how many blocks it chose a take for.
 */
export async function followTakes(store: WorldStore, productionId: string, room: ReadingRoom): Promise<number> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) return 0;
  let chosen = 0;
  for (const summary of production.chapters.filter((c) => !c.retired)) {
    let plan: AudiobookPlan;
    try {
      plan = await planAudiobook(store, productionId, summary.id, { narrator: room.narrator });
    } catch {
      continue;
    }
    if (castRefusal(plan) !== null || plan.record === null || plan.record === "unreadable") continue;
    const record = plan.record;
    const picks: Record<string, AudiobookTake> = {};
    for (const planned of plan.blocks) {
      if (planned.recorded === true || (planned.state !== "stale" && planned.state !== "not made" && planned.state !== "flagged")) continue;
      const textHash = audiobookTextHash(planned.block.text);
      const want = audiobookTakeDirectionHash(audiobookDirectionFor(record, planned.block)?.plan ?? null, planned.note);
      const candidates = store
        .getBundle()
        .artifacts.filter((artifact) => {
          const g = artifact.generation;
          return (
            artifact.retiredAt === undefined &&
            g?.source === "audiobook" &&
            g.recording === undefined &&
            g.productionId === productionId &&
            g.chapterId === plan.chapter.id &&
            g.block === planned.block.key &&
            g.textHash === textHash &&
            sameVoice(g, planned.assigned) &&
            g.directionHash === want
          );
        })
        .sort((a, b) => (a.created < b.created ? 1 : -1));
      for (const artifact of candidates) {
        if (artifact.id === record.takes[planned.block.key]?.artifactId) break;
        const there = await stat(toExtendedLength(join(store.dir, "artifacts", fromPortable(artifact.file)))).then((s) => s.isFile(), () => false);
        if (!there) continue;
        const g = artifact.generation as Extract<NonNullable<typeof artifact.generation>, { source: "audiobook" }>;
        const format = artifact.file.toLowerCase().endsWith(".mp3") ? "mp3" : artifact.file.toLowerCase().endsWith(".flac") ? "flac" : "wav";
        picks[planned.block.key] = {
          artifactId: artifact.id,
          textHash,
          reader: { provider: g.provider, model: g.model, voiceId: g.voiceId, ...(g.voiceLabel !== undefined ? { label: g.voiceLabel } : {}) },
          ...(g.sheetId !== undefined ? { sheet: g.sheetId } : {}),
          format,
          characters: g.characters,
          parts: g.parts,
          estimatedMicroUsd: g.estimatedMicroUsd,
          costMicroUsd: g.costMicroUsd,
          ...(g.directionHash !== undefined ? { directionHash: g.directionHash } : {}),
          madeAt: artifact.created,
        };
        break;
      }
    }
    if (Object.keys(picks).length === 0) continue;
    await updateAudiobook(store, productionId, { file: summary.file, version: plan.chapter.version, hash: plan.chapter.hash }, (current) => {
      const flags = Object.fromEntries(Object.entries(current.flags).filter(([key]) => picks[key] === undefined));
      return { ...current, updatedAt: store.now(), takes: { ...current.takes, ...picks }, flags };
    });
    chosen += Object.keys(picks).length;
  }
  return chosen;
}

function sameVoice(g: { provider: string; model: string; voiceId: string }, reader: AudiobookReader): boolean {
  return g.provider === reader.provider && g.model === reader.model && g.voiceId === reader.voiceId;
}

/**
 * What a narrator switch would do, before it is made (R-46): the blocks made now that the new
 * narrator would leave stale or unmade, the direction controls it would hold of all those that
 * stand, the price of reading the book again as `Read the book` would price it, and the takes
 * of the narrator now kept on the shelf. Nothing written.
 */
export async function quoteNarrator(store: WorldStore, productionId: string, now: ReadingRoom, next: ReadingRoom, at: () => string): Promise<{ stale: number; held: number; directed: number; estimatedMicroUsd: number; kept: number }> {
  const before = await prepareBook(store, productionId, now, at);
  const after = await prepareBook(store, productionId, next, at);
  const ready = (book: PreparedBook) => book.chapters.flatMap((chapter) => (chapter.preparation.kind === "ready" ? [chapter.preparation.prepared] : []));
  const toMake = (book: PreparedBook) => ready(book).reduce((sum, prepared) => sum + prepared.toMake.length, 0);
  const stale = Math.max(0, toMake(after) - toMake(before));
  const estimatedMicroUsd = ready(after).reduce((sum, prepared) => sum + prepared.estimate, 0);
  let held = 0;
  let directed = 0;
  let kept = 0;
  const clonedVoices = store.getBundle().clonedVoices ?? [];
  for (const prepared of ready(after)) {
    const record = prepared.record;
    for (const take of Object.values(record.takes)) if (sameVoice(take.reader, now.narrator)) kept += 1;
    for (const planned of prepared.plan.blocks) {
      const direction = audiobookDirectionFor(record, planned.block);
      if (direction === null) continue;
      const speaks = await effectiveReader(store, planned.assigned, next);
      if (speaks === null) continue;
      const controls = 1 + (direction.plan.speed !== 1 ? 1 : 0) + (direction.plan.phrase !== undefined ? 1 : 0) + direction.plan.cues.length;
      directed += controls;
      try {
        held += holdDirection(planned.block.text, direction.plan, speaks.model, readerLanguage(clonedVoices, speaks.reader)).held.length;
      } catch {
        /* a direction wrong for its words is the run's to refuse */
      }
    }
  }
  return { stale, held, directed, estimatedMicroUsd, kept };
}

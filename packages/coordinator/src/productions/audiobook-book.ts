import { createHash } from "node:crypto";
import {
  audiobookDirectionFor,
  audiobookDirectionHash,
  audiobookTextHash,
  cadenceSupport,
  type AudiobookDoor,
  type AudiobookPriceLine,
  type AudiobookRow,
  type AudiobookVoiceRow,
  type ChapterSummary,
  type ClonedVoice,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { checkDirection, directionPlan, effectiveReader, readAudiobook, updateAudiobook } from "./audiobook.js";
import { conformInput, directableBlocks } from "./audiobook-direction.js";
import { prepareChapter, priceLines, type ChapterPreparation, type ReadingRoom, type Speaking } from "./audiobook-run.js";

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
function runningTime(store: WorldStore, preparation: Extract<ChapterPreparation, { kind: "ready" }>): number | null {
  const { plan, record } = preparation.prepared;
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
 * its share, the narrator on this machine with its characters and nothing to pay, and each
 * speaker the narrator stands in for as a line of its own — said in warning on the card, and
 * counted apart from the narrator's own share so the sum is exact.
 */
export function bookPriceLines(narrator: ReadingRoom["narrator"], speaking: readonly Speaking[], misses: readonly Speaking[], priceOf: (block: Speaking) => number, sheetName: (sheet: string) => string): AudiobookPriceLine[] {
  const stoodIn = new Map<string, AudiobookPriceLine>();
  const own: Speaking[] = [];
  for (const block of speaking) {
    if (block.refusal !== undefined) continue;
    const substituted = block.substitutedNow ?? block.substituted;
    if (substituted === undefined || block.sheet === undefined) {
      own.push(block);
      continue;
    }
    const held = stoodIn.get(block.sheet) ?? {
      label: block.reader.label ?? block.reader.voiceId,
      provider: block.reader.provider,
      speaker: sheetName(block.sheet),
      substituted,
      local: block.local,
      characters: 0,
      estimatedMicroUsd: 0,
    };
    held.characters += block.text.length;
    held.estimatedMicroUsd += misses.includes(block) ? priceOf(block) : 0;
    stoodIn.set(block.sheet, held);
  }
  const lines: AudiobookPriceLine[] = [];
  const local = own.filter((block) => block.local);
  if (local.length > 0) {
    lines.push({ label: narrator.label ?? narrator.voiceId, provider: narrator.provider, local: true, characters: local.reduce((sum, block) => sum + block.text.length, 0), estimatedMicroUsd: 0 });
  }
  for (const line of priceLines(misses.filter((block) => own.includes(block)), priceOf)) lines.push({ ...line, local: false });
  return [...lines, ...stoodIn.values()];
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
  let reading: AudiobookDoor["reading"] = "narrator";
  const toRead: Array<Extract<ChapterPreparation, { kind: "ready" }>["prepared"]> = [];
  for (const { summary, preparation } of book.chapters) {
    const base = { chapterId: summary.id, file: summary.file, order: summary.order, title: summary.title, version: summary.version };
    if (preparation.kind === "unavailable") {
      rows.push({ ...base, planned: false, total: 0, made: 0, stale: 0, flagged: 0, notMade: 0, seconds: null, castTrouble: preparation.reason });
      continue;
    }
    const plan = preparation.kind === "ready" ? preparation.prepared.plan : preparation.plan;
    reading = plan.reading;
    unattributed += plan.cast !== null && plan.cast !== "unreadable" ? plan.ambiguous : 0;
    const counts = { total: plan.blocks.length, made: 0, stale: 0, flagged: 0, notMade: 0 };
    for (const planned of plan.blocks) {
      if (planned.state === "made") counts.made += 1;
      else if (planned.state === "stale") counts.stale += 1;
      else if (planned.state === "flagged") counts.flagged += 1;
      else counts.notMade += 1;
    }
    // Who reads what, across the book (R-12): the narrator's row counts narration and every
    // block that falls to it; a speaker's row names the voice that reads them, or why it does
    // not — no sheet, no voice, or a voice that cannot speak now.
    for (const planned of plan.blocks) {
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
    if (preparation.kind === "refused") {
      rows.push({ ...base, planned: plan.blocks.length === 0, ...counts, seconds: null, castTrouble: preparation.reason });
      continue;
    }
    rows.push({ ...base, planned: plan.blocks.length === 0, ...counts, seconds: counts.made > 0 ? runningTime(store, preparation) : 0 });
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
  /** One chapter read on the book's answer: the chapter's own run, with `priced` set, under the book's signal. */
  runChapter: (chapterId: string) => Promise<{ outcome: "read" | "stopped" | "unavailable" | "failed" | "refused"; made: number; flagged: number; reason?: string }>;
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
          ...toRead.flatMap((entry) => [
            `${entry.summary.id}:${entry.prepared.plan.chapter.version}:${entry.prepared.plan.chapter.hash}`,
            ...entry.prepared.misses.map((block) => `${block.block.key}:${block.reader.provider}/${block.reader.model}/${block.reader.voiceId}:${block.direction?.hash ?? ""}`),
          ]),
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
  let done = 0;
  for (const entry of toRead) {
    if (signal.aborted) break;
    const result = await deps.runChapter(entry.summary.id);
    made += result.made;
    flagged += result.flagged;
    if (result.outcome === "refused") refused += 1;
    else if (result.outcome === "failed" || result.outcome === "unavailable") {
      emit({ type: "finished", outcome: result.outcome, chaptersRead: done, chaptersRefused: refused, made, flagged, ...(result.reason !== undefined ? { reason: result.reason } : {}) });
      return;
    } else if (result.outcome === "read") done += 1;
    emit({ type: "progress", chapterId: entry.summary.id, done, chapters: toRead.length });
    if (result.outcome === "stopped") break;
  }
  emit({ type: "finished", outcome: signal.aborted ? "stopped" : "read", chaptersRead: done, chaptersRefused: refused, made, flagged });
}

/**
 * Directions re-checked against changed readers (R-13): the reading switched, or a sheet's
 * voice reassigned, moves blocks to the narrator or to a new voice, and a direction accepted
 * for one row is not carried to another to be flagged on every retry. Each standing direction
 * is conformed to its new reader — the controls that reader declares unsupported dropped and
 * counted — and written where anything changed. A chapter whose cast is not current is left
 * alone: its run refuses before any direction matters.
 */
export async function conformDirections(store: WorldStore, productionId: string, room: ReadingRoom): Promise<{ dropped: number; chapters: number }> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) return { dropped: 0, chapters: 0 };
  let dropped = 0;
  let chapters = 0;
  for (const summary of production.chapters.filter((c) => !c.retired)) {
    const stamp = summary.audiobook;
    if (stamp === undefined || "unreadable" in stamp) continue;
    let readable: Awaited<ReturnType<typeof directableBlocks>>;
    try {
      readable = await directableBlocks(store, productionId, summary.id, room);
    } catch {
      continue;
    }
    const { chapter, blocks } = readable;
    const held = await readAudiobook(store, productionId, chapter.file);
    if (held === null || held === "unreadable") continue;
    const next: typeof held.direction = { ...held.direction };
    let changed = false;
    for (const block of blocks) {
      const direction = audiobookDirectionFor(held, block);
      if (direction === null) continue;
      const support = cadenceSupport(block.model, block.language);
      const input = { delivery: direction.plan.delivery, speed: direction.plan.speed, cues: direction.plan.cues, ...(direction.plan.phrase !== undefined ? { phrase: direction.plan.phrase } : {}) };
      const conformed = conformInput(input, support);
      const plan = conformed.input === null ? null : directionPlan(block.text, conformed.input);
      const ok = plan !== null && checkDirection(block.text, plan, block.model, block.language).ok;
      if (conformed.dropped === 0 && ok) continue;
      if (!ok || plan === null) {
        dropped += conformed.dropped + 1;
        delete next[block.key];
        changed = true;
        continue;
      }
      if (audiobookDirectionHash(plan) === audiobookDirectionHash(direction.plan)) continue;
      dropped += conformed.dropped;
      next[block.key] = { textHash: audiobookTextHash(block.text), plan, at: store.now() };
      changed = true;
    }
    if (!changed) continue;
    chapters += 1;
    await updateAudiobook(store, productionId, chapter, (current) => ({ ...current, updatedAt: store.now(), direction: next }));
  }
  return { dropped, chapters };
}

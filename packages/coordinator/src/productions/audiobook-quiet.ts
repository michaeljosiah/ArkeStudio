import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { audiobookBlockPlan, audiobookTextHash, type CadenceCue } from "@arke-studio/contracts";
import { decodeWav } from "@arke-studio/voice";
import { audioHash } from "../audio/qc.js";
import { audioWorldPath } from "../audio/storage.js";
import { readAudioBytes, type AudioMediaTools } from "../audio/media-tools.js";
import { quietStretches, readingLevel, readingProfile, type ReadingProfile } from "../audio/quiet-stretches.js";
import type { WorldStore } from "../world/store.js";
import { planAudiobook } from "./audiobook.js";
import { anyNarrator } from "./audiobook-listening.js";

/**
 * Where a chapter's reading goes quiet and breathy, beside what its direction asked for (SPEC-047
 * R-196): Arke's read for a whisper that runs on past its words. The measure is the audio's;
 * whether the prose calls for the hush is Arke's to judge from the words, so every block the
 * direction asks to whisper is listed too, quiet or not.
 */

export interface AudiobookQuietStretch {
  /** Seconds into the block's take. */
  readonly seconds: readonly [number, number];
  /** How far under the chapter's usual level, in dB, and the share of it voiced. */
  readonly underUsualDb: number;
  readonly voiced: number;
  /** The block's words read in it: from the take's word timing, else placed by time and marked so. */
  readonly words: string;
  readonly estimated: boolean;
}
export interface AudiobookQuietMarker {
  readonly delivery?: string;
  readonly phrase?: string;
  /** The marker's characters in the block's text, and its words. */
  readonly at: readonly [number, number];
  readonly words: string;
}
export interface AudiobookQuietBlock {
  readonly key: string;
  readonly label: string;
  readonly text: string;
  readonly direction: { readonly delivery?: string; readonly note?: string; readonly markers: readonly AudiobookQuietMarker[] } | null;
  readonly seconds: number;
  readonly quiet: readonly AudiobookQuietStretch[];
}
export interface AudiobookQuietRead {
  readonly chapterId: string;
  readonly title: string;
  /** The chapter's usual reading level, dBFS; null when nothing could be measured. */
  readonly usualDb: number | null;
  readonly measured: number;
  /** The takes that are part of the fence: a reread changes the read. */
  readonly takes: readonly string[];
  readonly unmeasured: readonly { readonly key: string; readonly reason: string }[];
  readonly blocks: readonly AudiobookQuietBlock[];
}

const WHISPER = /whisper|hush/i;
/** A profile is the audio's, and a take never changes: kept by artifact and hash across reads. */
const profiles = new Map<string, { profile: ReadingProfile; hash: string }>();
const PROFILES_KEPT = 4_000;

function remember(key: string, measured: { profile: ReadingProfile; hash: string }) {
  if (profiles.size >= PROFILES_KEPT) profiles.delete(profiles.keys().next().value!);
  profiles.set(key, measured);
  return measured;
}

/** The text's words between two character offsets, widened to whole words. */
function wordsBetween(text: string, from: number, to: number): string {
  let start = Math.max(0, Math.min(text.length, from)), end = Math.max(start, Math.min(text.length, to));
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

async function samples(path: string, bytes: Uint8Array, hash: string, tools: AudioMediaTools | undefined, signal: AbortSignal) {
  const wav = decodeWav(bytes);
  if (wav !== null) return wav;
  if (tools === undefined) return null;
  const dir = await mkdtemp(join(tmpdir(), "arke-quiet-"));
  try {
    const file = join(dir, "prepared.wav");
    await tools.preparePcmWav({ sourcePath: path, expectedSourceHash: hash, destinationPath: file, signal });
    return decodeWav(await readAudioBytes(file, signal));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function readAudiobookQuiet(store: WorldStore, productionId: string, chapterFile: string,
  deps: { tools?: AudioMediaTools; signal?: AbortSignal } = {}): Promise<AudiobookQuietRead> {
  const signal = deps.signal ?? new AbortController().signal;
  const plan = await planAudiobook(store, productionId, chapterFile, { narrator: await anyNarrator(store, productionId, chapterFile) });
  const record = plan.record === "unreadable" ? null : plan.record;
  const artifacts = store.getBundle().artifacts;
  const unmeasured: { key: string; reason: string }[] = [];
  const measured: { index: number; profile: ReadingProfile; artifactId: string; hash: string }[] = [];
  for (const [index, planned] of plan.blocks.entries()) {
    signal.throwIfAborted();
    const { key, text } = planned.block;
    const take = record?.takes[key];
    const artifact = take ? artifacts.find((entry) => entry.id === take.artifactId) : undefined;
    if (!take || !artifact || !plan.present.has(take.artifactId) || take.textHash !== audiobookTextHash(text)) {
      unmeasured.push({ key, reason: "no current reading" });
      continue;
    }
    const cached = profiles.get(`${artifact.id}:${artifact.hash}`);
    if (cached !== undefined) { measured.push({ index, ...cached, artifactId: artifact.id }); continue; }
    try {
      const path = await audioWorldPath(store.dir, `artifacts/${artifact.file}`);
      const bytes = await readAudioBytes(path, signal);
      const hash = audioHash(bytes);
      if (!hash.startsWith(artifact.hash)) throw new Error("changed");
      const wav = await samples(path, bytes, hash, deps.tools, signal);
      if (wav === null) { unmeasured.push({ key, reason: "this reading could not be decoded here" }); continue; }
      measured.push({ index, ...remember(`${artifact.id}:${artifact.hash}`, { profile: await readingProfile(wav.mono, wav.rate, signal), hash }), artifactId: artifact.id });
    } catch (error) {
      signal.throwIfAborted();
      unmeasured.push({ key, reason: error instanceof Error && error.message === "changed" ? "this reading changed on disk" : "this reading is unavailable" });
    }
  }
  const usual = readingLevel(measured.map((entry) => entry.profile));
  const blocks: AudiobookQuietBlock[] = [];
  for (const { index, profile, hash } of measured) {
    const planned = plan.blocks[index]!;
    const { key, text } = planned.block;
    // The direction the take was read and is judged under: on a block a seam shaped, the one
    // its blocks make together, which the record never keeps for it (design turn 198).
    const direction = audiobookBlockPlan(record, planned.block);
    const markers = (direction?.cues ?? []).flatMap((cue: CadenceCue) => cue.kind !== "delivery" ? [] : [{
      ...(cue.delivery !== undefined ? { delivery: cue.delivery } : {}), ...(cue.phrase !== undefined ? { phrase: cue.phrase } : {}),
      at: [cue.span.from, cue.span.to] as const, words: cue.span.text }]);
    const asked = direction !== null && (direction.delivery === "whispered" || WHISPER.test(direction.note ?? "") ||
      markers.some((marker) => marker.delivery === "whispered" || WHISPER.test(marker.phrase ?? "")));
    // Word timing is the take's own when it was measured on these bytes and words; otherwise a
    // stretch is placed by its share of the take, which can be a clause out either way.
    const timing = record?.wordTiming?.[key];
    const timed = timing !== undefined && timing.audioHash === hash && timing.textHash === audiobookTextHash(text) ? timing.words : null;
    const quiet = usual === null ? [] : quietStretches(profile, usual).map((stretch) => ({
      seconds: [stretch.fromSec, stretch.toSec] as const, underUsualDb: Math.round((usual - stretch.levelDb) * 10) / 10, voiced: stretch.voiced,
      ...(timed !== null
        ? { words: timed.filter((word) => word.endSec > stretch.fromSec && word.startSec < stretch.toSec).map((word) => word.text).join(" "), estimated: false }
        : { words: wordsBetween(text, Math.floor(stretch.fromSec / profile.seconds * text.length), Math.ceil(stretch.toSec / profile.seconds * text.length)), estimated: true }),
    }));
    if (quiet.length === 0 && !asked) continue;
    blocks.push({ key, label: key === "title" ? "Title" : `Block ${index + 1}`, text,
      direction: direction === null ? null : { ...(direction.delivery !== undefined ? { delivery: direction.delivery } : {}),
        ...(direction.note !== undefined ? { note: direction.note } : {}), markers },
      seconds: Math.round(profile.seconds * 100) / 100, quiet });
  }
  return { chapterId: plan.chapter.id, title: plan.chapter.title, usualDb: usual, measured: measured.length,
    takes: measured.map((entry) => entry.artifactId), unmeasured, blocks };
}

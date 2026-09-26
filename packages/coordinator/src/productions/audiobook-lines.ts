import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  audiobookDirectionFor,
  audiobookRecordingKey,
  audiobookTextHash,
  type AudiobookReader,
  type ChapterAudiobook,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { castRefusal, planAudiobook } from "./audiobook.js";
import { RecordedTakeRefusal, stageRecording, type RecordedTakeDeps, type StagedRecording } from "./audiobook-recorded.js";
import { writeScriptPdf, type ScriptRun } from "./script-pdf.js";

/**
 * A recorded speaker's lines, out to a performer and back (design turn 155d, SPEC-047 R-39).
 *
 * Out: a script of the speaker's lines in book order, each with its id, the narration before it
 * for context, and its direction as a note — the delivery and the phrase a performer reads.
 * Back: many files at once, each matched to its line by the id in its name, prepared and checked
 * as one upload is, and refused in one clause when it names no line, another speaker's line, or
 * a line whose words have changed since the script was made.
 */

/**
 * A line's id, `CC-PPP-N` (R-39): the chapter's order, the paragraph counted from 1, and the
 * block's place in that paragraph counted from 1 — the address the audiobook already keys a
 * block by (`p<paragraph>.<n>`). The title is paragraph 000.
 */
export function lineId(chapterOrder: number, blockKey: string): string {
  const chapter = String(chapterOrder).padStart(2, "0");
  if (blockKey === "title") return `${chapter}-000-1`;
  const match = /^p(\d+)\.(\d+)$/.exec(blockKey);
  if (match === null) throw new Error(`not a block key: ${blockKey}`);
  return `${chapter}-${String(Number(match[1]) + 1).padStart(3, "0")}-${Number(match[2]) + 1}`;
}

/** The id a file's name carries, anywhere in it, or null. */
export function parseLineId(fileName: string): { id: string; chapterOrder: number; blockKey: string } | null {
  const match = /(?:^|[^0-9])(\d{2,3})-(\d{3})-(\d{1,2})(?:[^0-9]|$)/.exec(basename(fileName));
  if (match === null) return null;
  const chapterOrder = Number(match[1]);
  const paragraph = Number(match[2]);
  const place = Number(match[3]);
  if (chapterOrder < 1 || place < 1) return null;
  const blockKey = paragraph === 0 ? (place === 1 ? "title" : null) : `p${paragraph - 1}.${place - 1}`;
  if (blockKey === null) return null;
  return { id: `${match[1]!.padStart(2, "0")}-${match[2]}-${match[3]}`, chapterOrder, blockKey };
}

export interface SpeakerLine {
  id: string;
  chapterId: string;
  chapterFile: string;
  chapterTitle: string;
  chapterOrder: number;
  chapterVersion: number;
  block: string;
  text: string;
  textHash: string;
  /** The narration just before the line, in the same paragraph or the one before, for context. */
  context?: string;
  /** The line's direction as a performer's note: the delivery, then the phrase. */
  note?: string;
  state: string;
}

/** Every line a recorded speaker has across the book, in order, and the chapters whose cast could not say. */
export async function speakerLines(
  store: WorldStore,
  productionId: string,
  speaker: string,
  narrator: AudiobookReader,
): Promise<{ lines: SpeakerLine[]; chapters: number; notCast: number }> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new RecordedTakeRefusal("that production is gone");
  const lines: SpeakerLine[] = [];
  const chapters = new Set<string>();
  let notCast = 0;
  for (const summary of [...production.chapters].filter((c) => !c.retired).sort((a, b) => a.order - b.order)) {
    const plan = await planAudiobook(store, productionId, summary.id, { narrator });
    if (plan.blocks.length === 0) continue;
    // A line is a speaker's only by a current cast (SPEC-047 R-12); the narrator's blocks need none.
    if (speaker !== "narrator" && castRefusal({ ...plan, reading: "cast" }) !== null) {
      notCast += 1;
      continue;
    }
    const record: ChapterAudiobook | null = plan.record === "unreadable" ? null : plan.record;
    for (const [index, planned] of plan.blocks.entries()) {
      if (audiobookRecordingKey(planned.block) !== speaker) continue;
      const before = index > 0 ? plan.blocks[index - 1]! : undefined;
      // The narration before a character's line, for who they are answering; the narrator's own
      // script has none, since the block before is the narrator's own last line.
      const context = speaker !== "narrator" && before !== undefined && before.block.speaker === undefined && before.block.key !== "title" ? before.block.text : undefined;
      const direction = audiobookDirectionFor(record, planned.block);
      const note = direction === null ? undefined : [direction.plan.delivery, direction.plan.phrase].filter((part) => part !== undefined && part !== "").join(" · ");
      lines.push({
        id: lineId(plan.chapter.order, planned.block.key),
        chapterId: plan.chapter.id,
        chapterFile: plan.chapter.file,
        chapterTitle: plan.chapter.title,
        chapterOrder: plan.chapter.order,
        chapterVersion: plan.chapter.version,
        block: planned.block.key,
        text: planned.block.text,
        textHash: audiobookTextHash(planned.block.text),
        ...(context !== undefined ? { context } : {}),
        ...(note !== undefined && note !== "" ? { note } : {}),
        state: planned.state,
      });
      chapters.add(plan.chapter.id);
    }
  }
  return { lines, chapters: chapters.size, notCast };
}

/** What the last script held, by line id: the words it asked for, so a file for since-changed words is refused (R-39). */
const ScriptManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    speaker: z.string().min(1),
    exportedAt: z.string().min(1),
    lines: z.record(z.string(), z.object({ chapterId: z.string().min(1), block: z.string().min(1), textHash: z.string().min(1), chapterVersion: z.number().int().min(1) }).strict()),
  })
  .strict();
type ScriptManifest = z.infer<typeof ScriptManifestSchema>;

/** Where a speaker's last script manifest lives: beside the book's record, named by a slug of the speaker. */
export function scriptManifestPath(productionId: string, speaker: string): string {
  const slug = speaker.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "speaker";
  return `productions/${productionId}/.audiobook/scripts/${slug}.json`;
}

async function readManifest(store: WorldStore, productionId: string, speaker: string): Promise<ScriptManifest | null> {
  try {
    const parsed = ScriptManifestSchema.safeParse(JSON.parse(await readFile(toExtendedLength(join(store.dir, fromPortable(scriptManifestPath(productionId, speaker)))), "utf8")));
    return parsed.success && parsed.data.speaker === speaker ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface ScriptExport {
  /** World-relative, under `exports/`. */
  output: string;
  lines: number;
  chapters: number;
  notCast: number;
}

/**
 * Write the script (R-39): the speaker's lines — `awaiting` alone or all of them — as a PDF under
 * `exports/`, staged and renamed into place through the store's ownership-checked write as the
 * manuscript is, and the manifest the returned files are judged against beside the book's record.
 */
export async function exportScript(
  store: WorldStore,
  productionId: string,
  speaker: string,
  input: { scope: "awaiting" | "all"; label: string; narrator: AudiobookReader; exportId: string; now: () => string },
): Promise<ScriptExport> {
  const found = await speakerLines(store, productionId, speaker, input.narrator);
  const lines = input.scope === "all" ? found.lines : found.lines.filter((line) => line.state !== "made");
  if (lines.length === 0) throw new RecordedTakeRefusal(input.scope === "all" ? "no lines to record" : "nothing awaiting");
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId)!;
  const runs: ScriptRun[] = [
    { text: `${input.label} · ${production.meta.title}`, style: "title" },
    { text: `${lines.length} line${lines.length === 1 ? "" : "s"} · ${input.scope === "all" ? "all" : "awaiting"} · ${input.now().slice(0, 10)} · name each file by its id, e.g. ${lines[0]!.id}.wav`, style: "meta" },
  ];
  let chapter = "";
  for (const line of lines) {
    if (line.chapterId !== chapter) {
      chapter = line.chapterId;
      runs.push({ text: `Chapter ${line.chapterOrder} · ${line.chapterTitle} · v${line.chapterVersion}`, style: "meta" });
    }
    runs.push({ text: line.id, style: "id" });
    if (line.context !== undefined) runs.push({ text: line.context, style: "context" });
    runs.push({ text: line.text, style: "line" });
    if (line.note !== undefined) runs.push({ text: line.note, style: "note" });
  }
  const bytes = writeScriptPdf(runs, { title: `${input.label} · lines` });
  const stamp = input.now().replace(/[-:TZ.]/g, "").slice(0, 14);
  const slug = input.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "speaker";
  const name = `${productionId}-${slug}-lines-${stamp}-${input.exportId.slice(-6).toLowerCase()}.pdf`;
  const stageDir = join(store.dir, ".cache", "exports");
  const stage = join(stageDir, `${input.exportId}.pdf`);
  const finalDir = join(store.dir, "exports");
  await mkdir(toExtendedLength(stageDir), { recursive: true });
  await mkdir(toExtendedLength(finalDir), { recursive: true });
  const manifest: ScriptManifest = {
    schemaVersion: 1,
    speaker,
    exportedAt: input.now(),
    lines: Object.fromEntries(found.lines.map((line) => [line.id, { chapterId: line.chapterId, block: line.block, textHash: line.textHash, chapterVersion: line.chapterVersion }])),
  };
  const manifestPath = join(store.dir, fromPortable(scriptManifestPath(productionId, speaker)));
  try {
    await writeFile(toExtendedLength(stage), bytes);
    await store.ownedWrite(async () => {
      await rename(toExtendedLength(stage), toExtendedLength(join(finalDir, name)));
      await mkdir(toExtendedLength(join(manifestPath, "..")), { recursive: true });
      await atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    });
  } catch (error) {
    await rm(toExtendedLength(stage), { force: true }).catch(() => {});
    throw error;
  }
  return { output: `exports/${name}`, lines: lines.length, chapters: found.chapters, notCast: found.notCast };
}

export interface MatchedFile {
  file: string;
  id?: string;
  /** The staged recording, ready to keep; absent when the file was refused. */
  staged?: StagedRecording & { chapterFile: string };
  quote?: string;
  refused?: string;
}

/**
 * Match returned files to a speaker's lines and stage each (R-39): the id in the name finds the
 * line; a file whose id names no line of this speaker's, or whose line's words differ from the
 * last script's, is refused in one clause; the rest are prepared and checked as one upload is.
 */
export async function matchFiles(
  store: WorldStore,
  productionId: string,
  speaker: string,
  paths: readonly string[],
  deps: RecordedTakeDeps,
): Promise<MatchedFile[]> {
  const found = await speakerLines(store, productionId, speaker, deps.narrator);
  const byId = new Map(found.lines.map((line) => [line.id, line]));
  const manifest = await readManifest(store, productionId, speaker);
  const seen = new Set<string>();
  const out: MatchedFile[] = [];
  for (const path of paths) {
    const file = basename(path);
    const parsed = parseLineId(file);
    if (parsed === null) {
      out.push({ file, refused: "no line id" });
      continue;
    }
    const line = byId.get(parsed.id);
    if (line === undefined) {
      out.push({ file, id: parsed.id, refused: "not one of these lines" });
      continue;
    }
    const scripted = manifest?.lines[parsed.id];
    if (scripted !== undefined && scripted.textHash !== line.textHash) {
      out.push({ file, id: parsed.id, quote: line.text, refused: "words changed" });
      continue;
    }
    if (seen.has(parsed.id)) {
      out.push({ file, id: parsed.id, quote: line.text, refused: "another file has this id" });
      continue;
    }
    seen.add(parsed.id);
    try {
      const staged = await stageRecording(store, deps, { productionId, chapterId: line.chapterId, block: line.block, sourcePath: path });
      out.push({ file, id: parsed.id, quote: line.text, staged: { ...staged, chapterFile: line.chapterFile } });
    } catch (err) {
      out.push({ file, id: parsed.id, quote: line.text, refused: err instanceof RecordedTakeRefusal ? err.message : err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

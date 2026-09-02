import { z } from "zod";
import type { ProductionBundle } from "./client-state.js";
import { SlugSchema } from "./ids.js";
import type { FrameRate } from "./world.js";

/**
 * Subtitles as editable timed text (SPEC-038 R-21..R-29; issue #683).
 *
 * A cue is authored subtitle state: words, a whole-frame range, an optional speaker, and an
 * optional citation of the script block or Dialogue clip that seeded it. Burn-in is an output
 * and never the source (D4): the same cues drive the preview, the burned pixels and the sidecar,
 * and a later script change marks a cited cue stale rather than rewriting the words.
 *
 * Import and export speak SRT and WebVTT at millisecond resolution on the way in and the way
 * out, converted to the production frame grid at the boundary and nowhere else, so a file that
 * goes in and comes out at one rate lands on the same frames (R-28).
 */

export type SubtitleCueId = `cu_${string}`;
export const SubtitleCueIdSchema = z
  .string()
  .regex(/^cu_[A-Za-z0-9][A-Za-z0-9_-]*$/, "expected a cu_<stable-id> id") as z.ZodType<SubtitleCueId>;

/** A BCP-47 tag, loosely: a primary subtag and optional subtags. `en`, `en-GB`, `pt-BR`. */
export const LanguageTagSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "expected a BCP-47 language tag");

const WholeFrameSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The shared style one track applies to every cue (§2.3): no per-word motion, no arbitrary CSS. */
export const SubtitleStyleSchema = z
  .object({
    fontFamily: z.enum(["Geist"]),
    /** Cap height as a fraction of picture height. */
    relativeSize: z.number().min(0.02).max(0.12),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    background: z.enum(["none", "box", "outline"]),
    /** Distance from the bottom edge as a fraction of picture height. */
    bottomMargin: z.number().min(0).max(0.4),
  })
  .strict();
export type SubtitleStyle = z.infer<typeof SubtitleStyleSchema>;

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: "Geist",
  relativeSize: 0.045,
  color: "#ffffff",
  background: "outline",
  bottomMargin: 0.06,
};

/** What seeded a cue, so a later change to that source can mark the cue stale (R-23). */
export const SubtitleCitationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("script"),
      sceneId: z.string().min(1),
      blockId: z.string().regex(/^blk_[a-z0-9-]+$/),
      /** A fingerprint of the block text the cue was written from. */
      textDigest: z.string().regex(/^text-v1:[0-9a-f]{16}$/),
    })
    .strict(),
  z.object({ kind: z.literal("clip"), clipId: z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/) }).strict(),
]);
export type SubtitleCitation = z.infer<typeof SubtitleCitationSchema>;

/** Where a draft came from (R-25): model output is recorded as provenance, never as authority. */
export const SubtitleProvenanceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("speech-to-text"),
      model: z.string().min(1).max(120),
      /** The clip the words were heard on. */
      clipId: z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/).optional(),
      at: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("import"), format: z.enum(["srt", "vtt"]), at: z.string().min(1) }).strict(),
]);
export type SubtitleProvenance = z.infer<typeof SubtitleProvenanceSchema>;

export const SubtitleCueSchema = z
  .object({
    id: SubtitleCueIdSchema,
    text: z.string().min(1).max(500),
    startFrame: WholeFrameSchema,
    endFrame: WholeFrameSchema,
    speaker: SlugSchema.optional(),
    citation: SubtitleCitationSchema.optional(),
    provenance: SubtitleProvenanceSchema.optional(),
  })
  .strict()
  .refine((cue) => cue.endFrame > cue.startFrame, { message: "a cue must end after it starts", path: ["endFrame"] });
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>;

export const SubtitleOutputModeSchema = z.enum(["none", "burn-in", "sidecar", "burn-in+sidecar"]);
export type SubtitleOutputMode = z.infer<typeof SubtitleOutputModeSchema>;

export const SidecarFormatSchema = z.enum(["srt", "vtt"]);
export type SidecarFormat = z.infer<typeof SidecarFormatSchema>;

/** Cues in display order; ties on start cannot survive validation, but the sort stays total. */
export function orderedCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return [...cues].sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Overlapping cues on one track, named (R-26). Cross-track overlap is fine; only one track is viewed. */
export function cueOverlaps(cues: readonly SubtitleCue[]): string[] {
  const ordered = orderedCues(cues);
  const problems: string[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const cue = ordered[index]!;
    if (cue.startFrame < previous.endFrame) problems.push(`cues ${previous.id} and ${cue.id} overlap`);
  }
  return problems;
}

/** The cue showing at a frame, if any. */
export function cueAtFrame(cues: readonly SubtitleCue[], frame: number): SubtitleCue | null {
  return cues.find((cue) => frame >= cue.startFrame && frame < cue.endFrame) ?? null;
}

// ---------------------------------------------------------------------------
// Text fingerprints and staleness (R-23)
// ---------------------------------------------------------------------------

/** The same 64-bit FNV the timeline fingerprint uses, over the block's exact text. */
export function textDigest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `text-v1:${hash.toString(16).padStart(16, "0")}`;
}

export type CueStaleness = { stale: false } | { stale: true; reason: string };

/**
 * Whether the source a cue cites still says what the cue was written from. Derived on read and
 * never stored, so a stale flag cannot lie: the block's current text is fingerprinted and
 * compared with the digest the cue recorded.
 */
export function cueStaleness(cue: SubtitleCue, production: Pick<ProductionBundle, "scenes">): CueStaleness {
  const citation = cue.citation;
  if (citation === undefined || citation.kind !== "script") return { stale: false };
  const scene = production.scenes.find((candidate) => candidate.id === citation.sceneId);
  const block = scene?.script?.blocks.find((candidate) => candidate.id === citation.blockId);
  if (block === undefined) return { stale: true, reason: `script block ${citation.blockId} is no longer in ${citation.sceneId}` };
  if (textDigest(block.text) !== citation.textDigest) return { stale: true, reason: `script block ${citation.blockId} changed since this cue was written` };
  return { stale: false };
}

// ---------------------------------------------------------------------------
// SRT and WebVTT (R-24, R-27, R-28)
// ---------------------------------------------------------------------------

export interface ParsedCue {
  text: string;
  startFrame: number;
  endFrame: number;
}

export interface SubtitleImportProblem {
  /** One-based line of the offending row, as an editor shows it. */
  line: number;
  message: string;
}

export interface SubtitleImport {
  cues: ParsedCue[];
  /** Rows that could not be imported, named rather than dropped (R-24). */
  problems: SubtitleImportProblem[];
}

const STAMP = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/;
const SHORT_STAMP = /^(\d{1,2}):(\d{2})[,.](\d{1,3})$/;

function stampToMs(stamp: string): number | null {
  const long = STAMP.exec(stamp.trim());
  if (long) {
    return (Number(long[1]) * 3600 + Number(long[2]) * 60 + Number(long[3])) * 1000 + Number(long[4]!.padEnd(3, "0"));
  }
  const short = SHORT_STAMP.exec(stamp.trim());
  if (short) return (Number(short[1]) * 60 + Number(short[2])) * 1000 + Number(short[3]!.padEnd(3, "0"));
  return null;
}

/** Milliseconds to the nearest production frame; the one place import quantises. */
export function msToFrames(ms: number, frameRate: FrameRate): number {
  return Math.round((ms * frameRate) / 1000 + 1e-6);
}

/** Frames to whole milliseconds; the one place export quantises. */
export function framesToMs(frames: number, frameRate: FrameRate): number {
  return Math.round((frames * 1000) / frameRate);
}

function decodeVttText(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Parse SRT or WebVTT into frame-ranged cues. Strict about timing, forgiving about decoration:
 * a row whose timestamps do not parse, run backwards, or carry no words is reported by line and
 * skipped; every other row lands on the frame grid.
 */
export function parseSubtitles(text: string, format: SidecarFormat, frameRate: FrameRate): SubtitleImport {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const cues: ParsedCue[] = [];
  const problems: SubtitleImportProblem[] = [];
  let index = 0;
  if (format === "vtt") {
    if (!(lines[0] ?? "").startsWith("WEBVTT")) {
      problems.push({ line: 1, message: "a WebVTT file begins with WEBVTT" });
      return { cues, problems };
    }
    index = 1;
  }
  while (index < lines.length) {
    const line = lines[index]!.trim();
    if (line === "" || (format === "vtt" && /^(NOTE|STYLE|REGION)\b/.test(line))) {
      // Skip a blank line, or a VTT block that is not a cue, through to its own blank line.
      if (line !== "") while (index < lines.length && lines[index]!.trim() !== "") index += 1;
      index += 1;
      continue;
    }
    let timingLine = index;
    if (!line.includes("-->")) {
      // An SRT counter or a VTT cue identifier precedes the timing.
      timingLine = index + 1;
    }
    const timing = lines[timingLine]?.trim() ?? "";
    const arrow = timing.split("-->");
    const startMs = arrow.length === 2 ? stampToMs(arrow[0]!) : null;
    const endMs = arrow.length === 2 ? stampToMs(arrow[1]!.trim().split(/\s+/)[0] ?? "") : null;
    let body = timingLine + 1;
    const words: string[] = [];
    while (body < lines.length && lines[body]!.trim() !== "") {
      words.push(format === "vtt" ? decodeVttText(lines[body]!) : lines[body]!);
      body += 1;
    }
    if (startMs === null || endMs === null) {
      problems.push({ line: timingLine + 1, message: `${timing || "(missing)"} is not a subtitle timing` });
    } else if (endMs <= startMs) {
      problems.push({ line: timingLine + 1, message: `${timing} ends before it starts` });
    } else if (words.join("").trim() === "") {
      problems.push({ line: timingLine + 1, message: `${timing} carries no words` });
    } else {
      const startFrame = msToFrames(startMs, frameRate);
      const endFrame = Math.max(startFrame + 1, msToFrames(endMs, frameRate));
      cues.push({ text: words.join("\n").trim(), startFrame, endFrame });
    }
    index = body + 1;
  }
  return { cues, problems };
}

/**
 * A sidecar from cues already on the second clock — the render plan's — so the file names the
 * same windows the burned pixels and the preview show, clipped to the film exactly as they are.
 */
export function serializeTimedText(cues: readonly { text: string; startSec: number; endSec: number }[], format: SidecarFormat): string {
  const ordered = [...cues].sort((a, b) => a.startSec - b.startSec);
  const blocks = ordered.map((cue, index) => {
    const timing = `${stamp(Math.round(cue.startSec * 1000), format)} --> ${stamp(Math.round(cue.endSec * 1000), format)}`;
    const text = format === "vtt" ? cue.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : cue.text;
    return format === "srt" ? `${index + 1}\n${timing}\n${text}` : `${timing}\n${text}`;
  });
  return (format === "vtt" ? "WEBVTT\n\n" : "") + blocks.join("\n\n") + (blocks.length > 0 ? "\n" : "");
}

function stamp(ms: number, format: SidecarFormat): string {
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}${format === "srt" ? "," : "."}${pad(mmm, 3)}`;
}

/**
 * Serialise cues as SRT or WebVTT with timestamps derived from frame boundaries (R-28). Gaps
 * carry no text unless a real cue covers them (R-35): nothing here invents a row.
 */
export function serializeSubtitles(cues: readonly Pick<SubtitleCue, "text" | "startFrame" | "endFrame">[], format: SidecarFormat, frameRate: FrameRate): string {
  const ordered = [...cues].sort((a, b) => a.startFrame - b.startFrame);
  const blocks = ordered.map((cue, index) => {
    const timing = `${stamp(framesToMs(cue.startFrame, frameRate), format)} --> ${stamp(framesToMs(cue.endFrame, frameRate), format)}`;
    const text = format === "vtt" ? cue.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : cue.text;
    return format === "srt" ? `${index + 1}\n${timing}\n${text}` : `${timing}\n${text}`;
  });
  return (format === "vtt" ? "WEBVTT\n\n" : "") + blocks.join("\n\n") + (blocks.length > 0 ? "\n" : "");
}

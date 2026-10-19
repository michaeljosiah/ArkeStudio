import { EpisodeScriptSchema, episodeScriptProblems, ulid, type EpisodeScriptBlock, type ScriptHeading } from "@arke-studio/contracts";

/**
 * Why a draft cannot be saved yet, or null (codex on PR 1870): an emptied scene place or cue would
 * be dropped by the transport unanswered, and a save waiting for that answer would wait forever.
 * It is said here instead, and the draft stays, unsaved, for the author to finish.
 */
export function scriptSaveProblem(title: string, blocks: readonly EpisodeScriptBlock[]): string | null {
  if (title.trim().length > 160) return "The title is too long.";
  const relations = episodeScriptProblems(blocks)[0];
  if (relations) return relations;
  const parsed = EpisodeScriptSchema.safeParse({ version: 1, episode: 1, title, blocks });
  if (!parsed.success) {
    const at = parsed.error.issues[0]?.path[1];
    const block = typeof at === "number" ? blocks[at] : undefined;
    if (block?.kind === "heading") return "A scene needs a place.";
    if (block?.kind === "sound" || block?.kind === "ambience" || block?.kind === "music") return "A cue needs what is heard.";
    if (block?.kind === "note") return "A note needs words.";
    return "A block is incomplete.";
  }
  return null;
}

/**
 * A chapter's paragraphs as every surface numbers them: the shared splitter, so a source pin's
 * paragraph number means the same passage here as in the rest of the chapter tooling (codex on
 * PR 1870).
 */
export { chapterParagraphs } from "@arke-studio/contracts";

/**
 * The episode score's pure parts (SPEC-057 R-11..R-24, design turn 230d–f): which scene a block is
 * in, where beds run, which voice colour a speaker wears, and the edits that keep block ids.
 */

/** Each block's scene: the nearest heading above it, or null before the first heading. */
export function scenesOf(blocks: readonly EpisodeScriptBlock[]): Array<ScriptHeading | null> {
  let scene: ScriptHeading | null = null;
  return blocks.map((block) => {
    if (block.kind === "heading") scene = block;
    return scene;
  });
}

export type BedLane = "ambience" | "music";
/** Where a bed is drawn on one row: its start (the cue's own row), a row it runs under, or its last. */
export type BedMark = { lane: BedLane; bed: string; at: "start" | "run" | "end"; stops: boolean };

/**
 * Where every bed runs, row by row (R-15): from its cue down to the block named by `until` (which
 * it stops before) or to the end of its scene. `stops` says the bed is cut by `until`, drawn as a
 * foot; a bed that runs out with its scene has none. Beds may not cross a heading on their own —
 * crossing one is what `until` below the heading is for.
 */
export function bedMarks(blocks: readonly EpisodeScriptBlock[]): Array<BedMark[]> {
  const marks: Array<BedMark[]> = blocks.map(() => []);
  blocks.forEach((block, i) => {
    if (block.kind !== "ambience" && block.kind !== "music") return;
    const stopAt = block.until !== undefined ? blocks.findIndex((candidate) => candidate.id === block.until) : -1;
    let last = i;
    if (stopAt > i) last = stopAt - 1;
    else {
      while (last + 1 < blocks.length && blocks[last + 1]!.kind !== "heading") last++;
    }
    for (let row = i; row <= last; row++) {
      marks[row]!.push({ lane: block.kind, bed: block.id, at: row === i ? "start" : row === last ? "end" : "run", stops: stopAt > i });
    }
  });
  return marks;
}

/**
 * A speaker no sheet carries (R-55), named from its key: "crowd" is Crowd, "someone-2" Someone 2,
 * "a-dockhand" A dockhand. The score offered only the world's characters (issue 1883), so a line
 * for an unnamed speaker or a crowd could not be written.
 */
export function speakerLabel(key: string): string {
  const words = key.replace(/-(\d+)$/u, " $1").split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A direction as typed, without the parentheses the score draws round it (issue 1883): typed ones
 * read "((quietly))". Only a pair wrapping the whole direction, or an opener or closer left
 * unmatched at its ends, is the score's (codex on PR 1884): "quiet (but urgent)" keeps its own.
 */
export function directionText(typed: string): string | undefined {
  const balanced = (text: string) => {
    let depth = 0;
    for (const char of text) { if (char === "(") depth += 1; else if (char === ")" && --depth < 0) return false; }
    return depth === 0;
  };
  let text = typed;
  for (let wrapped = /^\s*\((.*)\)\s*$/su.exec(text); wrapped && balanced(wrapped[1]!); wrapped = /^\s*\((.*)\)\s*$/su.exec(text)) text = wrapped[1]!;
  const count = (char: string) => [...text].filter((candidate) => candidate === char).length;
  while (count("(") > count(")") && /^\s*\(/u.test(text)) text = text.replace(/^\s*\(/u, "");
  while (count(")") > count("(") && /\)\s*$/u.test(text)) text = text.replace(/\)\s*$/u, "");
  return text || undefined;
}

/**
 * The key a new unnamed speaker takes: someone, then someone-2, and so on. Every key already
 * meaning someone is taken (codex on PR 1884) — a sheet or a cast role as well as a line's
 * speaker — or the new line would speak as them, in their voice.
 */
export function unnamedSpeaker(taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has("someone")) return "someone";
  let n = 2;
  while (used.has(`someone-${n}`)) n += 1;
  return `someone-${n}`;
}

/** A speaker's voice colour, 1–6, in the order they first speak (the audiobook's tones). */
export function speakerTones(blocks: readonly EpisodeScriptBlock[]): Map<string, number> {
  const tones = new Map<string, number>();
  for (const block of blocks) {
    if (block.kind === "dialogue" && !tones.has(block.speaker)) tones.set(block.speaker, (tones.size % 6) + 1);
  }
  return tones;
}

/**
 * Split a line at the caret (R-24): the first part keeps the block's id, so a take or a note on it
 * stays put; the rest becomes a new block of the same kind and speaker, with a new id. A line that
 * was broken off passes that on to the part that now ends it.
 */
export function splitBlock(blocks: readonly EpisodeScriptBlock[], id: string, at: number): EpisodeScriptBlock[] {
  const index = blocks.findIndex((block) => block.id === id);
  const block = blocks[index];
  if (!block || (block.kind !== "dialogue" && block.kind !== "narration")) return [...blocks];
  const head = block.words.slice(0, at).trimEnd();
  const tail = block.words.slice(at).trimStart();
  const first = { ...block, words: head } as EpisodeScriptBlock;
  const second = { ...block, id: ulid(), words: tail } as EpisodeScriptBlock;
  if (first.kind === "dialogue") { delete first.cut; }
  if (second.kind === "dialogue") { delete second.overlapsPrevious; delete second.direction; }
  if (second.kind === "narration") delete second.direction;
  delete (second as { paragraphs?: number[] }).paragraphs;
  return [...blocks.slice(0, index), first, second, ...blocks.slice(index + 1)];
}

/**
 * Join a line into the one above it (R-24) when both are the same kind and, for dialogue, the same
 * speaker. The upper block keeps its id; the lower one's id is gone, as its words now belong above.
 */
export function joinBlock(blocks: readonly EpisodeScriptBlock[], id: string): EpisodeScriptBlock[] | null {
  const index = blocks.findIndex((block) => block.id === id);
  const lower = blocks[index];
  const upper = blocks[index - 1];
  if (!lower || !upper) return null;
  if (upper.kind === "dialogue" && lower.kind === "dialogue" && upper.speaker === lower.speaker) {
    const merged = { ...upper, words: [upper.words, lower.words].filter(Boolean).join(" ") };
    if (lower.cut) merged.cut = true; else delete merged.cut;
    return [...blocks.slice(0, index - 1), merged, ...blocks.slice(index + 1)];
  }
  if (upper.kind === "narration" && lower.kind === "narration") {
    return [...blocks.slice(0, index - 1), { ...upper, words: [upper.words, lower.words].filter(Boolean).join(" ") }, ...blocks.slice(index + 1)];
  }
  return null;
}

/** A new block of a kind, ready to edit: every block is born with its id (R-24). */
export function newBlock(kind: EpisodeScriptBlock["kind"], speaker?: string): EpisodeScriptBlock {
  const id = ulid();
  switch (kind) {
    case "heading": return { id, kind, place: "New scene" };
    case "dialogue": return { id, kind, speaker: speaker ?? "narrator", words: "" };
    case "narration": return { id, kind, words: "" };
    case "silence": return { id, kind, seconds: 1 };
    case "note": return { id, kind, text: "Note" };
    default: return { id, kind, heard: kind === "music" ? "Music" : kind === "ambience" ? "Ambience" : "A sound" };
  }
}

/**
 * Keep the relations whole after an edit (R-18): a line marked broken off with no line breaking in
 * below it is no longer broken off, and a line breaking in with no line above it no longer does.
 */
export function mendRelations(blocks: readonly EpisodeScriptBlock[]): EpisodeScriptBlock[] {
  return blocks.map((block, i) => {
    if (block.kind !== "dialogue") return block;
    const next = blocks[i + 1];
    const previous = blocks[i - 1];
    let mended = block;
    if (block.cut && !(next?.kind === "dialogue" && next.overlapsPrevious)) { mended = { ...mended }; delete mended.cut; }
    if (block.overlapsPrevious && !(previous?.kind === "dialogue" && previous.cut)) { mended = { ...mended }; delete mended.overlapsPrevious; }
    return mended;
  }).map((block, i, all) => {
    if ((block.kind === "ambience" || block.kind === "music") && block.until !== undefined) {
      const at = all.findIndex((candidate) => candidate.id === block.until);
      if (at <= i) { const mended = { ...block }; delete mended.until; return mended; }
    }
    return block;
  });
}

/** "14–17" or "14, 16" from the numbers a block cites. */
export function paragraphLabel(paragraphs: readonly number[] | undefined): string {
  if (!paragraphs?.length) return "";
  const sorted = [...paragraphs].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return `¶${contiguous && sorted.length > 1 ? `${sorted[0]}–${sorted.at(-1)}` : sorted.join(", ")}`;
}

/** "14-17, 20" typed into a field, as the paragraph numbers it names; nonsense yields none. */
export function parseParagraphs(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const range = /^(\d+)[-–](\d+)$/.exec(part);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      for (let n = Math.min(from, to); n <= Math.max(from, to) && out.size < 200; n++) out.add(n);
    } else if (/^\d+$/.test(part) && Number(part) > 0) out.add(Number(part));
  }
  return [...out].sort((a, b) => a - b);
}

// The radio script lives in contracts now (S-7b), so a published edition carries the same text.
export { heardAsLabel, episodeScriptText as scriptAsText } from "@arke-studio/contracts";

/** One row of Arke's draft against the script (SPEC-057 R-54): kept, added, changed or removed. */
export type DraftRow =
  | { state: "same" | "added" | "removed" | "moved"; block: EpisodeScriptBlock }
  | { state: "changed"; block: EpisodeScriptBlock; was: EpisodeScriptBlock };

/**
 * Arke's draft as tracked edits, by block id: what it adds is shown where it goes, what it removes
 * where it was, and a block it rewrites as the old struck beside the new.
 */
export function draftRows(current: readonly EpisodeScriptBlock[], proposed: readonly EpisodeScriptBlock[]): DraftRow[] {
  const kept = new Set(proposed.map((block) => block.id));
  const before = new Map(current.map((block) => [block.id, block]));
  const rows: DraftRow[] = [];
  let at = 0;
  const flushRemoved = (until: string | null) => {
    while (at < current.length && current[at]!.id !== until) {
      if (!kept.has(current[at]!.id)) rows.push({ state: "removed", block: current[at]! });
      at++;
    }
  };
  // A block kept but put elsewhere is a change too (codex on PR 1874): Keep writes the new order.
  const keptOrder = current.filter((block) => kept.has(block.id)).map((block) => block.id);
  const newOrder = proposed.filter((block) => before.has(block.id)).map((block) => block.id);
  const moved = new Set(newOrder.filter((id, i) => keptOrder[i] !== id));
  for (const block of proposed) {
    const was = before.get(block.id);
    if (was) {
      if (moved.has(block.id)) { rows.push(JSON.stringify(was) === JSON.stringify(block) ? { state: "moved", block } : { state: "changed", block, was }); continue; }
      flushRemoved(block.id);
      at++;
      rows.push(JSON.stringify(was) === JSON.stringify(block) ? { state: "same", block } : { state: "changed", block, was });
    } else {
      // Struck lines read before the new ones that take their place.
      while (at < current.length && !kept.has(current[at]!.id)) rows.push({ state: "removed", block: current[at++]! });
      rows.push({ state: "added", block });
    }
  }
  flushRemoved(null);
  return rows;
}

/** A draft row's key, as the score names it: one change of Arke's to take or leave. */
export const draftRowKey = (row: DraftRow): string => `${row.state}:${row.block.id}`;

/** Whether a row is a change the author can take or leave: an order kept as drafted is not. */
export const draftRowChoosable = (row: DraftRow): boolean => row.state === "added" || row.state === "removed" || row.state === "changed";

/**
 * The script Keep writes when some of Arke's changes are left out (issue 1882): Arke's draft was
 * kept or discarded whole. Each row is taken as drafted or as it was — an addition left out, a
 * removal undone where the line stood, a rewrite kept in its old words — in the draft's order.
 * A bed whose stop was left out runs to its scene's end, and interruptions are mended.
 */
export function keepDraftRows(current: readonly EpisodeScriptBlock[], rows: readonly DraftRow[], declined: ReadonlySet<string>): EpisodeScriptBlock[] {
  const leave = (row: DraftRow) => draftRowChoosable(row) && declined.has(draftRowKey(row));
  const kept: EpisodeScriptBlock[] = [];
  for (const row of rows) {
    if (row.state === "removed") continue;
    if (row.state === "added") { if (!leave(row)) kept.push(row.block); }
    else if (row.state === "changed") kept.push(leave(row) ? row.was : row.block);
    else kept.push(row.block);
  }
  // A removal left out goes back after the line it followed (codex on PR 1884): where a draft
  // also moves lines, its struck row trails them, and [A, B, C] drafted as [C, B] kept A last.
  const restored = new Set(rows.filter((row) => row.state === "removed" && leave(row)).map((row) => row.block.id));
  current.forEach((block, i) => {
    if (!restored.has(block.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const before = kept.findIndex((candidate) => candidate.id === current[j]!.id);
      if (before >= 0) { at = before + 1; break; }
    }
    kept.splice(at, 0, block);
  });
  const ids = new Set(kept.map((block) => block.id));
  return mendRelations(kept.map((block) => {
    if ((block.kind !== "ambience" && block.kind !== "music") || block.until === undefined || ids.has(block.until)) return block;
    const { until: _gone, ...rest } = block;
    return rest as EpisodeScriptBlock;
  }));
}

/**
 * The fields a rewrite changes beyond its words (codex on PR 1874): a channel, a bed's stop, a
 * source pin — written by Keep, so said beside the line.
 */
export function changedFields(was: EpisodeScriptBlock, now: EpisodeScriptBlock): string[] {
  const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
  const shown = new Set(["id", "kind", "words", "direction", "speaker", "heard", "place", "time", "text", "seconds", "cut"]);
  return [...keys].filter((key) => !shown.has(key) && JSON.stringify((was as Record<string, unknown>)[key]) !== JSON.stringify((now as Record<string, unknown>)[key]));
}

/** A block in one line, as the draft shows it. */
export function blockLine(block: EpisodeScriptBlock, name: (slug: string) => string): { who: string; text: string } {
  switch (block.kind) {
    case "heading": return { who: "Scene", text: `${block.place}${block.time ? ` — ${block.time}` : ""}` };
    case "dialogue": return { who: name(block.speaker), text: `${block.direction ? `(${block.direction}) ` : ""}${block.words}${block.cut ? " —" : ""}` };
    case "narration": return { who: "Narrator", text: `${block.direction ? `(${block.direction}) ` : ""}${block.words}` };
    case "sound": case "ambience": case "music": return { who: block.kind[0]!.toUpperCase() + block.kind.slice(1), text: block.heard };
    case "silence": return { who: "Silence", text: `${block.seconds} s${block.note ? ` · ${block.note}` : ""}` };
    case "note": return { who: "Note", text: block.text };
  }
}

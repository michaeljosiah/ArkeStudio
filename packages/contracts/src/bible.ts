import { z } from "zod";
import { IsoDateSchema } from "./ids.js";

/**
 * The world bible — the author's own thinking about the world, in their own prose.
 *
 * It is deliberately not canon, and the distinction is the whole design. Canon holds what the
 * world has *decided*: numbered entries, gated, ripple-checked, cited by takes and sheets. The
 * bible holds what the author *thinks*: intent, mood, direction, the half-formed. Nothing cites
 * it, nothing generates from it, and the grounded Q&A pipeline never answers out of it — an
 * answer sourced from a musing would look exactly like an answer sourced from canon, which is
 * the one failure SPEC-006 exists to prevent.
 *
 * Because nothing cites it, it does not pass the accept gate. It belongs to the master spec's
 * **direct authored** class (§3.1) beside chapter prose: written in place, versioned at every
 * save, snapshotted to `.history/`, logged to `changes.jsonl`. Versioning is the safety, and it
 * is what makes an ungated agent write acceptable — every edit is one restore away from undone.
 */

/** Where the bible lives. World root, next to `world.json`, so it is the first file anyone finds. */
export const BIBLE_PATH = "bible.md";

/**
 * The bible as the open world carries it.
 *
 * `text` is the body below the frontmatter, whole. There is no bound on it: the whole document
 * goes to the model every turn, by design (see `bibleContext`). What protects the user from an
 * unbounded prompt is a visible meter and an agent that does not append unprompted, not a
 * silent truncation of the document they wrote.
 */
export const WorldBibleSchema = z
  .object({
    version: z.number().int().min(1),
    updated: IsoDateSchema,
    text: z.string(),
    /** False when there is no `bible.md` yet — every world created before this existed. */
    present: z.boolean(),
  })
  .strict();
export type WorldBible = z.infer<typeof WorldBibleSchema>;

export const EMPTY_BIBLE: WorldBible = { version: 1, updated: "1970-01-01", text: "", present: false };

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface BibleSection {
  heading: string;
  body: string;
}

export interface BibleOutline {
  /** Prose before the first `## ` heading. Editable only by replacing the document. */
  preamble: string;
  sections: BibleSection[];
}

/**
 * Split the bible into its `## ` sections, tolerating a preamble.
 *
 * Deliberately not `splitSections` from the sheet parser, which throws on prose above the first
 * heading. A sheet's shape is authored by the app and may be insisted upon; a bible is a blank
 * page somebody types into, and refusing to parse one because they opened with a paragraph
 * rather than a heading would be the app telling the author how to write.
 */
export function splitBible(text: string): BibleOutline {
  const sections: BibleSection[] = [];
  const preamble: string[] = [];
  let current: BibleSection | null = null;
  for (const line of text.split("\n")) {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      if (current) sections.push({ ...current, body: current.body.trim() });
      current = { heading: match[1]!.trim(), body: "" };
    } else if (current) {
      current.body += (current.body ? "\n" : "") + line;
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push({ ...current, body: current.body.trim() });
  return { preamble: preamble.join("\n").trim(), sections };
}

export function joinBible(outline: BibleOutline): string {
  const blocks = outline.sections.map((s) => `## ${s.heading}\n\n${s.body}`.trimEnd());
  return [outline.preamble, ...blocks].filter((block) => block !== "").join("\n\n");
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * What one turn may do to the bible.
 *
 * Section-scoped rather than whole-document, for the reason `currentLookContext` gives about art
 * direction: a model told to restate a long document whole in order to change one line will
 * paraphrase the parts it was not thinking about, and the drift is invisible because nothing on
 * screen shows what went. Addressing a heading means the diff is exactly what was asked for.
 *
 * `replace-document` remains, for a bible with no headings at all and for a genuine rewrite.
 */
export const BIBLE_EDIT_BOUNDS = {
  /** Per turn. A turn that wants to rewrite more of the bible than this wants a rewrite. */
  edits: 6,
  heading: 120,
  text: 20_000,
} as const;

const HeadingSchema = z.string().trim().min(1).max(BIBLE_EDIT_BOUNDS.heading);
const BodySchema = z.string().max(BIBLE_EDIT_BOUNDS.text);

export const BibleEditSchema = z.discriminatedUnion("op", [
  /** Replace the section's body, or add the section at the end when the heading is new. */
  z.object({ op: z.literal("set-section"), heading: HeadingSchema, text: BodySchema }).strict(),
  /** Add to the end of an existing section. Refused when the heading is not there. */
  z.object({ op: z.literal("append-to-section"), heading: HeadingSchema, text: BodySchema }).strict(),
  /** Refused when the heading is not there — deleting nothing should not report success. */
  z.object({ op: z.literal("remove-section"), heading: HeadingSchema }).strict(),
  z.object({ op: z.literal("replace-document"), text: BodySchema }).strict(),
]);
export type BibleEdit = z.infer<typeof BibleEditSchema>;

export class BibleEditError extends Error {
  constructor(
    readonly heading: string,
    message: string,
  ) {
    super(message);
    this.name = "BibleEditError";
  }
}

/** Case- and whitespace-insensitive: the model is matching a heading it read, not a key. */
function findSection(sections: BibleSection[], heading: string): number {
  const wanted = heading.trim().toLowerCase();
  return sections.findIndex((s) => s.heading.trim().toLowerCase() === wanted);
}

export interface AppliedBibleEdits {
  text: string;
  /** The headings this turn touched, in the order it touched them — what the undo card names. */
  headings: string[];
}

/**
 * Apply edits in order, or throw.
 *
 * All-or-nothing, like the turn that carries them ([turn-result.ts]): a turn whose reply says
 * "I've added that to your bible" must not land with two of its three edits applied, because the
 * reply would then be a confident account of work that only partly exists.
 */
export function applyBibleEdits(text: string, edits: readonly BibleEdit[]): AppliedBibleEdits {
  let outline = splitBible(text);
  const headings: string[] = [];

  for (const edit of edits) {
    if (edit.op === "replace-document") {
      outline = splitBible(edit.text);
      headings.push("the whole bible");
      continue;
    }

    const index = findSection(outline.sections, edit.heading);

    if (edit.op === "set-section") {
      if (index === -1) outline.sections.push({ heading: edit.heading, body: edit.text.trim() });
      else outline.sections[index] = { heading: outline.sections[index]!.heading, body: edit.text.trim() };
      headings.push(edit.heading);
      continue;
    }

    if (index === -1) {
      // Never resolved to "near enough". A heading that has moved or been renamed means the model
      // is editing a document it no longer has in front of it, and guessing which section it meant
      // would write the user's notes somewhere they did not ask for.
      throw new BibleEditError(edit.heading, `the bible has no section headed "${edit.heading}"`);
    }

    const section = outline.sections[index]!;
    if (edit.op === "append-to-section") {
      outline.sections[index] = {
        heading: section.heading,
        body: section.body ? `${section.body}\n\n${edit.text.trim()}` : edit.text.trim(),
      };
    } else {
      outline.sections.splice(index, 1);
    }
    headings.push(section.heading);
  }

  return { text: joinBible(outline), headings };
}

// ---------------------------------------------------------------------------
// What the client renders
// ---------------------------------------------------------------------------

/**
 * One landed bible edit, as the conversation shows it.
 *
 * Distinct from a proposition on purpose. A proposition is waiting for a yes; this has already
 * happened. Rendering them the same way would make "I changed your bible" and "I propose
 * changing canon" look like the same offer, and only one of them is an offer.
 */
export const BibleEditRecordSchema = z
  .object({
    fromVersion: z.number().int().min(1),
    toVersion: z.number().int().min(2),
    headings: z.array(z.string()),
    at: z.string().min(1),
  })
  .strict();
export type BibleEditRecord = z.infer<typeof BibleEditRecordSchema>;

/**
 * Roughly what the bible costs to carry, for the meter on the Bible screen.
 *
 * Four characters to the token is the usual English approximation and is honest enough for a
 * gauge whose job is to tell somebody their bible has grown, not to bill them. The meter exists
 * because the document is loaded whole on every turn: no cap, no truncation, but never a cost
 * the author cannot see.
 */
export function bibleSize(text: string): { characters: number; words: number; approxTokens: number } {
  const trimmed = text.trim();
  return {
    characters: text.length,
    words: trimmed === "" ? 0 : trimmed.split(/\s+/).length,
    approxTokens: Math.ceil(text.length / 4),
  };
}

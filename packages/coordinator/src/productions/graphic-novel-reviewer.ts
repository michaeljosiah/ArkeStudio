import { z } from "zod";
import { PageBoxSchema, PageReviewFindingKindSchema, type PageReviewFinding } from "@arke-studio/contracts";
import type { ImageJsonRunner } from "../harness/review-task.js";

/**
 * What looks at a comic page as a picture (SPEC-064 R-67 – R-73, turn 253). The lettering reader
 * reads the words and nothing else; on The Ledger of Nights, drawn, it passed a caption about
 * stopping a pen drawn over a woman at a rail, faces in the water no panel asked for and Bray
 * without his collar, and it failed the ledger's own handwriting as invented text. A named,
 * versioned port, as the reader is, so a different reviewer is a different review (R-71).
 */
export interface PageReviewer {
  review(input: PageReviewInput, signal: AbortSignal): Promise<{ findings: PageReviewFinding[]; cleared: Array<{ finding: string; reason: string }>; reviewer: { id: string; version: string } }>;
}

export interface PageReviewInput {
  /** The page's script as the reviewer reads it: never the prose (R-67). */
  script: string;
  /** Words the lettering check found that the script never lettered, to say which are writing in the scene (R-70). */
  extras: ReadonlyArray<{ id: string; text: string }>;
  page: { bytes: Uint8Array; extension: string };
  /** The accepted take of the page before it, for continuity (R-21). */
  previous?: { bytes: Uint8Array; extension: string };
  references: ReadonlyArray<{ name: string; bytes: Uint8Array; extension: string }>;
}

export const PAGE_REVIEW_PROMPT = [
  "You review one generated comic book page against the script it was drawn from. Judge only what is drawn; the words are checked separately.",
  "Image block page is the page. Image block previous, when present, is the page before it in the book. Each image block ref:<name> is the reference picture for that person or place.",
  "Report a finding only for a fault a reader would see. Kinds:",
  "content: a panel does not show what its description says (the action, the place, or an object its lettering relies on).",
  "cast: a person the panel names is missing, the wrong person is drawn, or a person appears whom the description does not call for.",
  "caption: a caption or thought says something the panel's picture contradicts.",
  "defect: extra or merged faces, figures or limbs, broken anatomy, a duplicated person, or letter-like marks no line asked for.",
  "speaker: a balloon's tail points at someone other than its speaker.",
  "likeness: a person does not match their reference (face, hair, build, costume).",
  "continuity: a person or place shared with the previous page differs (costume, injury, prop, light, time of day) with no reason in the script.",
  "layout: the panels differ in count or arrangement from the layout.",
  "For each finding give its panel number in reading order (omit for the whole page), a note of at most twelve plain words, and its box as fractions of the page when you can place it.",
  "Then, for each listed extra text, say whether it is writing drawn in the scene that a panel's description calls for (a ledger, a notice, a sign). List only those that are, each with a reason of at most eight words.",
  'Return ONLY JSON: {"findings":[{"kind":"caption","panel":1,"note":"...","box":{"x":0.1,"y":0.1,"w":0.3,"h":0.2}}],"cleared":[{"finding":"extra:0","reason":"..."}]}. A page with no faults returns {"findings":[],"cleared":[]}.',
].join("\n");

const AnswerSchema = z.object({ findings: z.array(z.unknown()).max(60), cleared: z.array(z.unknown()).max(60).default([]) }).passthrough();

/** A finding a model phrased loosely is kept if its kind is one we know; boxes are estimates and clamped. */
function finding(raw: unknown, index: number): PageReviewFinding | null {
  if (typeof raw !== "object" || raw === null) throw new Error("the reviewer answered a finding that is not one");
  const entry = raw as { kind?: unknown; panel?: unknown; note?: unknown; box?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } };
  const kind = PageReviewFindingKindSchema.safeParse(entry.kind);
  if (!kind.success) throw new Error(`the reviewer answered an unknown kind ${String(entry.kind)}`);
  const note = typeof entry.note === "string" ? entry.note.trim().slice(0, 300) : "";
  if (!note) return null;
  const unit = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null);
  const box = entry.box && [entry.box.x, entry.box.y, entry.box.w, entry.box.h].every((value) => unit(value) !== null)
    ? PageBoxSchema.parse({ x: unit(entry.box.x), y: unit(entry.box.y), w: unit(entry.box.w), h: unit(entry.box.h) }) : undefined;
  const panel = typeof entry.panel === "number" && Number.isInteger(entry.panel) && entry.panel >= 1 && entry.panel <= 40 ? entry.panel : undefined;
  return { id: `review:${kind.data}:${index}`, kind: kind.data, note, ...(panel !== undefined ? { panel } : {}), ...(box ? { box } : {}) };
}

export function harnessPageReviewer(ask: ImageJsonRunner): PageReviewer {
  return {
    async review(input, signal) {
      let model: string | undefined;
      const extras = input.extras.length ? `\n\nEXTRA TEXT THE LETTERING CHECK FOUND:\n${input.extras.map((extra) => `${extra.id}: "${extra.text}"`).join("\n")}` : "";
      const answer = AnswerSchema.parse(await ask({
        agent: "comic-page-reviewer",
        prompt: `${PAGE_REVIEW_PROMPT}\n\nTHE PAGE'S SCRIPT:\n${input.script}${extras}`,
        images: [
          { block: "page", ...input.page },
          ...(input.previous ? [{ block: "previous", ...input.previous }] : []),
          ...input.references.map((reference) => ({ block: `ref:${reference.name}`, bytes: reference.bytes, extension: reference.extension })),
        ],
      }, signal, async (receipt) => { model = receipt.model; }));
      const known = new Set(input.extras.map((extra) => extra.id));
      // Only the extras it was asked about can be cleared: a model naming a finding it was never shown clears nothing.
      const cleared = answer.cleared.flatMap((raw) => {
        const entry = raw as { finding?: unknown; reason?: unknown };
        return typeof entry.finding === "string" && known.has(entry.finding) && typeof entry.reason === "string" && entry.reason.trim()
          ? [{ finding: entry.finding, reason: entry.reason.trim().slice(0, 200) }] : [];
      });
      return {
        findings: answer.findings.map(finding).filter((entry): entry is PageReviewFinding => entry !== null),
        cleared,
        reviewer: { id: "harness-vision", version: `1${model ? `:${model}` : ""}` },
      };
    },
  };
}

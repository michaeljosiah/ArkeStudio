import { z } from "zod";
import { ComicScriptReadFindingSchema, type ComicPage, type ComicScriptReadFinding, type DraftComicPage } from "@arke-studio/contracts";
import type { ImageJsonRunner } from "../harness/review-task.js";

/**
 * A reader who has only the pages (SPEC-064 R-64 – R-66, turn 254d). Arke drafted The Ledger of
 * Nights, drawn, having read the whole novel, and wrote for someone who had too: people spoken of
 * before they were shown, a chain and bell pins nothing set up. This reader is given the pages as a
 * reader meets them — the chapters before, then the draft — and never the prose, the bible, the
 * plan or Arke's reasons, so what it cannot follow is what a reader cannot.
 */
export interface ScriptReader {
  read(input: { before: string; draft: string; mysteries?: readonly string[] }, signal: AbortSignal): Promise<{ findings: ComicScriptReadFinding[]; reader: { id: string; version: string } }>;
}

type PageLike = Pick<ComicPage, "panels"> | DraftComicPage;

/** Pages as a reader meets them: what is drawn, who is in it, and every word on it. */
export function pagesForReading(pages: readonly PageLike[], name: (id: string) => string, label: (index: number) => string): string {
  return pages.map((page, index) => [
    `${label(index)}:`,
    ...page.panels.map((panel, p) => [
      `  Panel ${p + 1}: ${panel.description}`,
      ...(panel.characters.length ? [`    Drawn: ${panel.characters.map(name).join(", ")}`] : []),
      ...panel.lettering.map((item) => `    ${item.kind}${item.speaker ? ` (${name(item.speaker)})` : ""}: "${item.text}"`),
    ].join("\n")),
  ].join("\n")).join("\n");
}

export const SCRIPT_READ_PROMPT = [
  "You are reading a graphic novel as its reader will, with nothing but its pages. You have not read the book it came from.",
  "Each panel says what is drawn and gives every word lettered on it. A Drawn line lists who appears; a reader sees their faces but learns a name only when the words give it.",
  "Read THE DRAFT after THE PAGES BEFORE IT, and list every place in the draft where you could not follow it. Kinds:",
  "who: someone speaks, is spoken to or is spoken of before the pages have shown or named them.",
  "what: an object, rule, place or event is relied on and never set up.",
  "why: someone acts or reacts for a reason the pages never give.",
  "where: a change of place or time you cannot follow.",
  "voice: a caption, or writing in the world, whose speaker, owner or time you cannot place.",
  "picture: words that rely on something the panel does not show, or that the panel contradicts.",
  "load: more than three balloons in a panel, or about twelve on a page.",
  "kept: a question you would ask that is one of THE BOOK'S KEPT MYSTERIES, which the book means its reader to carry unanswered. Report it as kept, never as what or why.",
  "For each, give the draft's page number, the panel when you can, and the question you would ask, in a few plain words.",
  'Return ONLY JSON: {"findings":[{"kind":"who","page":3,"panel":2,"question":"Who is Jory?"}]}. A draft you can follow returns {"findings":[]}.',
].join("\n");

const AnswerSchema = z.object({ findings: z.array(z.unknown()).max(60) }).passthrough();

export function harnessScriptReader(ask: ImageJsonRunner): ScriptReader {
  return {
    async read(input, signal) {
      let model: string | undefined;
      const answer = AnswerSchema.parse(await ask({
        agent: "comic-script-reader",
        prompt: `${SCRIPT_READ_PROMPT}\n\nTHE BOOK'S KEPT MYSTERIES:\n${input.mysteries?.length ? input.mysteries.map((question) => `- ${question}`).join("\n") : "(none)"}\n\nTHE PAGES BEFORE IT:\n${input.before || "(none: this is the start of the book)"}\n\nTHE DRAFT:\n${input.draft}`,
        images: [],
      }, signal, async (receipt) => { model = receipt.model; }));
      // A finding outside the schema fails the read rather than being dropped: dropped, it could
      // make a draft a reader could not follow look like one they could.
      const findings = answer.findings.map((raw) => {
        const parsed = ComicScriptReadFindingSchema.safeParse(raw);
        if (!parsed.success) throw new Error(`the reader answered a finding that is not one: ${parsed.error.issues[0]?.message ?? "invalid"}`);
        return parsed.data;
      });
      return { findings, reader: { id: "harness", version: `1${model ? `:${model}` : ""}` } };
    },
  };
}

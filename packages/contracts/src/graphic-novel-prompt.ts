import { PICTURE_IDENTITY_LINE, referenceBriefLine } from "./audiobook-illustrate.js";
import { layoutTemplate, pageAspect, pageReading, type ComicMode, type ComicPage, type ComicSettings, type LetteringItem } from "./graphic-novel.js";

/**
 * The page brief (SPEC-064 R-16, R-23): the look, the layout, each panel in reading order, then the
 * lettering with its exact words. It is the whole brief as sent — never wrapped in the audiobook's
 * closing lines, whose "no added text" would undo every balloon on the page.
 */

/** Story media's bound for one page prompt (R-23); a model's own lower bound wins. */
export const COMIC_PROMPT_MAX = 8_000;

const KIND_WORDS: Record<LetteringItem["kind"], string> = {
  speech: "speech balloon", thought: "thought balloon", shout: "jagged shout balloon",
  whisper: "dashed whisper balloon", caption: "caption box", sfx: "sound effect lettered into the art",
};

const READING_WORDS = {
  ltr: "Panels read left to right, top to bottom.",
  rtl: "Panels read right to left, top to bottom, as manga.",
  scroll: "Panels read top to bottom as one vertical scroll.",
} as const;

export interface ComicCited { name: string; kind: "character" | "place"; token: string }

export function comicPagePrompt(input: {
  page: ComicPage;
  settings: Pick<ComicSettings, "reading" | "aspect">;
  mode: ComicMode;
  /** The world's look in words; absent leaves the style to the references. */
  look?: string;
  /** Sheet id → the name the page calls them, for speakers and panel casts. */
  names: (sheet: string) => string;
  cited: readonly ComicCited[];
}): string {
  const { page, mode } = input;
  const reading = pageReading(page, input.settings);
  const template = layoutTemplate(page.layout);
  const lines: string[] = [];
  lines.push(`A single finished comic book page, ${pageAspect(page, input.settings)}, ${template?.describe ?? `${page.panels.length} panels`}. ${READING_WORDS[reading]} Clean panel borders and gutters.`);
  if (input.look) lines.push(`Look: ${input.look.replace(/\s+/g, " ").trim()}`);
  page.panels.forEach((panel, index) => {
    const who = panel.characters.map(input.names);
    const parts = [
      `Panel ${index + 1}${panel.size && panel.size !== "normal" ? ` (${panel.size})` : ""}: ${panel.description.replace(/\s+/g, " ").trim()}`,
      panel.shot ? `Shot: ${panel.shot}.` : "",
      who.length ? `Shows ${who.join(", ")}.` : "",
      panel.location ? `At ${input.names(panel.location)}.` : "",
    ];
    if (mode === "baked") {
      for (const item of panel.lettering) {
        const speaker = item.speaker ? `${input.names(item.speaker)}'s ` : "";
        parts.push(`${speaker}${KIND_WORDS[item.kind]}${item.speaker ? ", its tail pointing at them" : ""}, lettered exactly: "${item.text}"`);
      }
    } else if (panel.lettering.length) {
      parts.push(`Leave clear space for ${panel.lettering.length} ${panel.lettering.length === 1 ? "balloon" : "balloons"}.`);
    }
    lines.push(parts.filter(Boolean).join(" "));
  });
  const references = [referenceBriefLine(input.cited), input.cited.some((entry) => entry.kind === "character") ? PICTURE_IDENTITY_LINE : ""].filter(Boolean).join(" ");
  if (references) lines.push(references);
  lines.push(mode === "baked"
    ? "Letter every balloon, caption and sound effect with exactly the words given, spelled exactly, in clear comic lettering, fully inside the page and its panel. Add no other words, signs, titles, page numbers or credits."
    : "Draw no lettering at all: no balloons, captions, sound effects, signs, titles or page numbers.");
  return lines.join("\n\n");
}

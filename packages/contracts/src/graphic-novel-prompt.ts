import { PICTURE_IDENTITY_LINE, referenceBriefLine } from "./audiobook-illustrate.js";
import { layoutTemplate, pageAspect, pageReading, type ComicMode, type ComicPage, type ComicPanel, type ComicSettings, type LetteringItem } from "./graphic-novel.js";

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

/** The accepted panel that rides to hold the book's drawing (R-37b), by the name the Bench cites it. */
export const COMIC_STYLE_REFERENCE = "Style reference";

/**
 * One panel's brief (R-37a): what it shows and nothing it says. The line about the style reference
 * names everything not to take from it: told to match an anchor panel, the trial's cells drew the
 * anchor's statue in nearly every panel (2026-11-04).
 */
export function comicPanelPrompt(input: {
  panel: ComicPanel;
  shape: string;
  look?: string;
  style?: string;
  names: (sheet: string) => string;
  cited: readonly ComicCited[];
  /** What the review found in the last take, when this one is drawn to correct it (turn 269c). */
  fix?: string;
}): string {
  const { panel } = input;
  const who = panel.characters.map(input.names);
  const lines = [`One comic book panel, a single image exactly ${input.shape} in shape, filling the whole frame with no border and no gutter.`];
  if (input.look) lines.push(`Look: ${input.look.replace(/\s+/g, " ").trim()}`);
  if (input.style?.trim()) lines.push(`Style: ${input.style.replace(/\s+/g, " ").trim()}${input.look ? " Where this style and the look above differ, follow the style." : ""}`);
  lines.push([
    `The panel: ${panel.description.replace(/\s+/g, " ").trim()}`,
    panel.shot ? `Shot: ${panel.shot}.` : "",
    who.length ? `Shows ${who.join(", ")}.` : "",
    panel.location ? `At ${input.names(panel.location)}.` : "",
  ].filter(Boolean).join(" "));
  if (input.fix?.trim()) lines.push(`Correct this from the last attempt: ${input.fix.replace(/\s+/g, " ").trim()}`);
  const anchor = input.cited.find((entry) => entry.name === COMIC_STYLE_REFERENCE);
  const cast = input.cited.filter((entry) => entry !== anchor);
  const references = [referenceBriefLine(cast), cast.some((entry) => entry.kind === "character") ? PICTURE_IDENTITY_LINE : ""].filter(Boolean).join(" ");
  if (references) lines.push(references);
  if (anchor) lines.push(`@${anchor.token} is another panel of this book, shown only for how it is drawn: its line, colour and finish. Take no person, place, object or composition from it.`);
  lines.push("Every person has natural anatomy: two arms, two hands, five fingers on each hand, each hand joined to its own arm and turned the way a real wrist allows.");
  if (panel.lettering.length) lines.push("Leave a calm area of the picture clear of faces and hands, where words will be set later.");
  lines.push("Draw no lettering at all: no balloons, captions, sound effects, titles or page numbers. Writing only where the panel's description calls for it.");
  return lines.join("\n\n");
}

export function comicPagePrompt(input: {
  page: ComicPage;
  settings: Pick<ComicSettings, "reading" | "aspect">;
  mode: ComicMode;
  /** The world's look in words; absent leaves the style to the references. */
  look?: string;
  /** The book's comic style in words (R-21a); after the look, so it is the last word on drawing. */
  style?: string;
  /** Sheet id → the name the page calls them, for speakers and panel casts. */
  names: (sheet: string) => string;
  cited: readonly ComicCited[];
}): string {
  const { page, mode } = input;
  const reading = pageReading(page, input.settings);
  // A template describes its own count. Sent for a page holding more or fewer panels, "five panels"
  // won over the six that followed: every six-panel page came back with five and failed review.
  const template = layoutTemplate(page.layout);
  const count = page.panels.length;
  const layout = template?.panels.length === count ? template.describe : `exactly ${count} ${count === 1 ? "panel" : "panels"} of varied size`;
  const lines: string[] = [];
  lines.push(`A single finished comic book page, ${pageAspect(page, input.settings)}, ${layout}. ${READING_WORDS[reading]} Clean panel borders and gutters.`);
  if (input.look) lines.push(`Look: ${input.look.replace(/\s+/g, " ").trim()}`);
  // A world's mood can fight the chosen style: "playful" beside Noir is how a smiling heroine reached a tense panel (issue 2424).
  if (input.style?.trim()) lines.push(`Style: ${input.style.replace(/\s+/g, " ").trim()}${input.look ? " Where this style and the look above differ, follow the style." : ""}`);
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

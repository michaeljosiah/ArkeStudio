/**
 * A graphic novel's comic styles (design turn 248, SPEC-064 R-21a), offered when the book is made
 * and in Pages.
 *
 * As with the art-direction presets (turn 38), a preset seeds the words and the words are the
 * record: an edited preset and a style written from nothing are the same thing to every brief.
 * The id is kept beside the words only so the picker can show which card seeded them.
 *
 * Every card's picture is the same page — Low Water's page 3, Maren on the flooded pier — drawn in
 * that style by ChatGPT Image on 29 October 2026, so the cards differ only in how a page is drawn.
 * They ship in `public/comic-styles`; nothing is generated when the cards are shown.
 */

export interface ComicStylePreset {
  id: string;
  name: string;
  /** The card's line: the treatment, not the subject. */
  blurb: string;
  /** The first draft of the words; always editable. */
  words: string;
}

export const COMIC_STYLE_PRESETS: readonly ComicStylePreset[] = [
  {
    id: "manga",
    name: "Manga",
    blurb: "Black and white, screentone",
    words: "Japanese manga: black and white only, crisp pen line, grey screentone shading, speed lines and dramatic close-ups.",
  },
  {
    id: "superhero",
    name: "Superhero",
    blurb: "Bold ink, four colours",
    words: "American superhero comic: bold confident ink contour, four-colour flat fills with hard cel shadows, dramatic angles and foreshortening, saturated primaries.",
  },
  {
    id: "clean-line",
    name: "Clean line",
    blurb: "Even line, flat colour",
    words: "European clean-line comic: one even unbroken ink line, flat bright colour with no hatching and no gradients, clear detailed backgrounds, calm readable staging.",
  },
  {
    id: "noir",
    name: "Noir",
    blurb: "Black, white, hard light",
    words: "Crime noir comic: solid black shapes and stark white, hard light carving the figure, almost no midtones, rain and shadow as graphic shapes.",
  },
  {
    id: "webtoon",
    name: "Webtoon",
    blurb: "Soft digital colour",
    words: "Modern webtoon: soft full-colour digital painting, clean thin line, gentle cel shading with soft glow, smooth gradients in the sky.",
  },
  {
    id: "painted",
    name: "Painted",
    blurb: "Brushwork, no outline",
    words: "Fully painted graphic novel: every panel painted in oils or gouache with visible brushwork, rich atmospheric light, no ink outlines.",
  },
  {
    id: "watercolour",
    name: "Watercolour",
    blurb: "Ink over washes",
    words: "Indie watercolour comic: loose ink line over transparent watercolour washes, warm paper showing through, soft bleeding edges.",
  },
  {
    id: "ink-wash",
    name: "Ink and wash",
    blurb: "Brush and greys",
    words: "Black ink and grey wash comic: brush contour, washed greys, dramatic negative space, the paper grain showing, no colour.",
  },
  {
    id: "vintage",
    name: "Vintage print",
    blurb: "Halftone on newsprint",
    words: "Vintage newsprint comic from the 1950s: thick ink line, flat four-colour printing with visible halftone dots, slight misregistration.",
  },
];

/**
 * What the picker has chosen: World look (the world's art direction, no style), a preset that
 * seeded the words, or Your own.
 */
export type ComicStyleChoice = "world" | "own" | string;

export interface ComicStyleDraft {
  choice: ComicStyleChoice;
  words: string;
}

export function comicStylePreset(id: string | undefined): ComicStylePreset | undefined {
  return COMIC_STYLE_PRESETS.find((preset) => preset.id === id);
}

/** Relative, not absolute: the packaged app loads from file://, where a leading slash is the disk's root. */
export const comicStylePicture = (id: string) => `./comic-styles/${id}.jpg`;

/** The draft a stored style reads back as: no style is World look; a preset id the app no longer has is Your own. */
export function draftFromStyle(style: { words: string; preset?: string | undefined } | undefined): ComicStyleDraft {
  if (!style) return { choice: "world", words: "" };
  return { choice: comicStylePreset(style.preset) ? style.preset! : "own", words: style.words };
}

/** Choosing a card: a preset seeds its words, World look and Your own empty them. */
export function chooseComicStyle(choice: ComicStyleChoice): ComicStyleDraft {
  return { choice, words: comicStylePreset(choice)?.words ?? "" };
}

/**
 * What a draft saves as: null is World look, as is Your own with nothing written, since a style
 * with no words would brief nothing.
 */
export function styleFromDraft(draft: ComicStyleDraft): { words: string; preset?: string } | null {
  const words = draft.words.trim();
  if (draft.choice === "world" || words === "") return null;
  return comicStylePreset(draft.choice) ? { words, preset: draft.choice } : { words };
}

/**
 * The preset look library (design turn 38), offered in two places: the art-direction step of
 * genesis, and the proposal screen for a world that already has a look.
 *
 * A preset *seeds* the style description and is then discarded. Only the text is stored, so an
 * edited preset and a hand-written custom look are the same record — there is no "this world is
 * on Painterly realism" state to keep in step with words the author has since rewritten.
 *
 * The blurb is what the card says; the description is what rides along with every generation.
 */

export interface ArtStylePreset {
  id: string;
  name: string;
  /** One line on the card — the treatment, not the subject. */
  blurb: string;
  /** The first draft of the style description. Always editable, never locked. */
  description: string;
}

export const ART_STYLE_PRESETS: ArtStylePreset[] = [
  {
    id: "painterly-realism",
    name: "Painterly realism",
    blurb: "Brushwork you can see, colour held back.",
    description:
      "Weathered realism with visible brushwork. Natural light, a restrained palette, soft edges that still carry weight.",
  },
  {
    id: "cinematic-photoreal",
    name: "Cinematic photoreal",
    blurb: "Lensed and lit like film.",
    description:
      "Photographic realism, lensed and lit like film. Motivated light with deep falloff, shallow depth of field, colour graded rather than saturated.",
  },
  {
    id: "ink-and-wash",
    name: "Ink and wash",
    blurb: "Brush contour, washed tone, paper beneath.",
    description:
      "Brushed ink contour over washed tone. Few values, generous empty space, the paper grain left showing through.",
  },
  {
    id: "watercolour-storybook",
    name: "Watercolour storybook",
    blurb: "Soft bleeds on warm paper.",
    description:
      "Watercolour on warm paper. Soft bleeds and blooming edges, a light hand with detail, pencil under-drawing left visible.",
  },
  {
    id: "graphic-novel",
    name: "Graphic novel",
    blurb: "Heavy contour, flat fills, hard shadow.",
    description:
      "Heavy contour line with flat fills. Hard-edged shadow shapes, a tight palette, texture carried by hatching rather than gradient.",
  },
  {
    id: "cel-animation",
    name: "Cel animation",
    blurb: "Clean line, flat colour, two-tone shading.",
    description:
      "Clean animation line over flat colour. Two-tone shading, simplified forms, painted backgrounds softer than the figures on them.",
  },
  {
    id: "editorial-print",
    name: "Editorial print",
    blurb: "Limited palette, halftone, poster-flat.",
    description:
      "Screen-printed poster flatness. Three inks, visible halftone, shapes that read before any detail does.",
  },
  {
    id: "analogue-photo",
    name: "Analogue photo",
    blurb: "Faded emulsion, soft bloom, muted chemistry.",
    description:
      "Faded film emulsion. Soft highlight bloom, muted chemistry in the shadows, visible grain and a slight colour shift.",
  },
  {
    id: "tactile-miniature",
    name: "Tactile miniature",
    blurb: "Stop-motion materials, real depth of field.",
    description:
      "Stop-motion materials photographed for real: felt, wood, wire and clay, macro depth of field, practical lighting with honest shadows.",
  },
];

export function presetById(id: string): ArtStylePreset | undefined {
  return ART_STYLE_PRESETS.find((preset) => preset.id === id);
}

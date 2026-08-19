import type { ProductionFormat, ProductionMedium } from "./world.js";

/**
 * The one place classification becomes behaviour (SPEC-023 R-4). Every surface that used to
 * compare `meta.format` against a string literal reads this instead, so the legacy resolve
 * rule, the Stills disposition, and the display vocabulary each exist exactly once.
 */
export interface ProductionShape {
  medium: ProductionMedium;
  /** The stored (or defaulted) kind — kept verbatim for display even when unknown. */
  kind: string;
  /** Whether episodes exist for this production (SPEC-023 R-11). */
  isEpisodic: boolean;
  hasChapters: boolean;
  hasScenes: boolean;
  /** Branching belongs only to Interactive video (turn 78, binding rule 3). */
  isBranching: boolean;
  /** What the dispatch dialog resolves models against (legacy stills → image). */
  dispatchCapability: "image" | "video";
  mediumLabel: string;
  kindLabel: string;
  /** What a badge or eyebrow prints: the kind where it says something, the medium otherwise. */
  displayLabel: string;
}

const MEDIUM_LABEL: Record<ProductionMedium, string> = {
  story: "Story",
  video: "Video",
  "interactive-video": "Interactive video",
};

/** The plain kind each medium defaults to when none is stored (SPEC-023 R-2). */
const DEFAULT_KIND: Record<ProductionMedium, string> = {
  story: "book",
  video: "film",
  "interactive-video": "interactive",
};

/** The kinds whose behaviour differs from their medium's default. */
const EPISODIC_KINDS = new Set(["microdrama", "series"]);

const KIND_LABEL: Record<string, string> = {
  book: "Book",
  script: "Script",
  serial: "Serial",
  film: "Film",
  series: "Series",
  microdrama: "Microdrama",
  "promotional-short": "Promotional short",
  stills: "Stills",
  interactive: "Interactive",
};

export function resolveMedium(meta: { format: ProductionFormat; medium?: ProductionMedium }): ProductionMedium {
  return meta.medium ?? (meta.format === "story" ? "story" : "video");
}

/** The legacy value a medium maps back to — what `format` is written as (SPEC-023 R-1). */
export function legacyFormatFor(medium: ProductionMedium): ProductionFormat {
  return medium === "story" ? "story" : "video";
}

export function productionShape(meta: {
  format: ProductionFormat;
  medium?: ProductionMedium;
  kind?: string;
}): ProductionShape {
  const medium = resolveMedium(meta);
  const kind = meta.kind ?? (meta.format === "stills" ? "stills" : DEFAULT_KIND[medium]);
  const isEpisodic = medium === "video" && EPISODIC_KINDS.has(kind);
  const mediumLabel = MEDIUM_LABEL[medium];
  const kindLabel = KIND_LABEL[kind] ?? kind;
  return {
    medium,
    kind,
    isEpisodic,
    hasChapters: medium === "story",
    hasScenes: medium !== "story",
    isBranching: medium === "interactive-video",
    dispatchCapability: kind === "stills" ? "image" : "video",
    mediumLabel,
    kindLabel,
    displayLabel: kind === DEFAULT_KIND[medium] ? mediumLabel : kindLabel,
  };
}

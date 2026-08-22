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
  /** Branching belongs to the interactive kind (turn 100; was a medium of its own, turn 84). */
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
  // Retired as a medium by turn 100 and never resolved to any more; the label stays because
  // the enum still reads the value off disk.
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

/**
 * Branching belongs to the interactive *kind* (turn 100). It was a medium of its own for two
 * turns, which put it beside Story and Video on the first question, where it never belonged: a
 * medium is what the audience receives, and interactive video receives moving pictures. It has
 * the same scenes, shots, takes and cut as every other video, and what it adds — scenes that
 * route by choice — is exactly what a kind is.
 */
const BRANCHING_KIND = "interactive";

const KIND_LABEL: Record<string, string> = {
  book: "Book",
  script: "Script",
  serial: "Serial",
  film: "Film",
  series: "Series",
  microdrama: "Microdrama",
  "promotional-short": "Promotional short",
  // A kind of Video, not a medium of its own (turn 53): same scenes, shots, takes and cut.
  "music-video": "Music video",
  stills: "Stills",
  // Reads as the whole name wherever a badge prints it; step two's card says just "Interactive",
  // because the question above it already said video.
  interactive: "Interactive video",
};

export function resolveMedium(meta: { format: ProductionFormat; medium?: ProductionMedium }): ProductionMedium {
  // A world written between turns 84 and 100 stores `interactive-video` as its medium. It reads
  // as Video from here on, carrying the interactive *kind* — the resolve widens rather than the
  // schema narrowing, so nothing on disk stops parsing and no production changes behaviour.
  if (meta.medium === "interactive-video") return "video";
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
  // A production stored under the retired medium keeps branching without a kind on disk: the
  // medium it was created with is the kind it now has (turn 100).
  const legacyInteractive = meta.medium === "interactive-video";
  const kind =
    meta.kind ??
    (legacyInteractive ? BRANCHING_KIND : meta.format === "stills" ? "stills" : DEFAULT_KIND[medium]);
  const isEpisodic = medium === "video" && EPISODIC_KINDS.has(kind);
  const mediumLabel = MEDIUM_LABEL[medium];
  const kindLabel = KIND_LABEL[kind] ?? kind;
  return {
    medium,
    kind,
    isEpisodic,
    hasChapters: medium === "story",
    hasScenes: medium !== "story",
    isBranching: kind === BRANCHING_KIND,
    dispatchCapability: kind === "stills" ? "image" : "video",
    mediumLabel,
    kindLabel,
    displayLabel: kind === DEFAULT_KIND[medium] ? mediumLabel : kindLabel,
  };
}

/**
 * The documented default delivery aspect (issue 389): landscape 16:9, because that is what
 * every production made before aspect existed actually rendered — stills came out landscape
 * and every video route's first offered shape is 16:9. Stated once, here, rather than as a
 * hidden fallback scattered through call sites; there is deliberately no world-level default
 * to consult, because a world routinely holds a 16:9 film and a 9:16 cut of the same material.
 */
export const DEFAULT_PRODUCTION_ASPECT = "16:9";

/** The aspect this production delivers in (SPEC-019 R-36; issue 389) — never silently absent. */
export function productionAspect(meta: { aspect?: string }): string {
  return meta.aspect ?? DEFAULT_PRODUCTION_ASPECT;
}

import { z } from "zod";
import { ArtifactIdSchema, IsoDateTimeSchema, JobIdSchema, SlugSchema, UlidSchema } from "./ids.js";
import { normalizeAspect } from "./manifest.js";
import { textDigest } from "./subtitles.js";

/**
 * The graphic novel (SPEC-064): a Story production whose unit is the page. The comic script —
 * chapters hold pages, pages hold panels, panels hold lettering — is the source of truth, and a page
 * picture is made from it, never the other way. It is not the visual novel, which is a Video kind
 * that plays scenes as beats (R-2): nothing here reads beats, scenes or a cut.
 */
export const GRAPHIC_NOVEL_KIND = "graphic-novel";

/** How a reader moves through the book (R-12): page-turn either way, or one tall scroll. */
export const ComicReadingSchema = z.enum(["ltr", "rtl", "scroll"]);
export type ComicReading = z.infer<typeof ComicReadingSchema>;

/** Who lettered the page (R-36): the model, inside the picture, or Arke, over clean art. */
export const ComicModeSchema = z.enum(["baked", "overlay"]);
export type ComicMode = z.infer<typeof ComicModeSchema>;

export const LetteringKindSchema = z.enum(["speech", "thought", "shout", "whisper", "caption", "sfx"]);
export type LetteringKind = z.infer<typeof LetteringKindSchema>;
/** Kinds nobody says: a caption is the book's voice, a sound effect is the world's (R-8). */
const UNSPOKEN: ReadonlySet<LetteringKind> = new Set(["caption", "sfx"]);

export const COMIC_LIMITS = { pagesPerChapter: 200, panelsPerPage: 12, letteringPerPage: 40, textMax: 400, descriptionMax: 2000, takesPerPage: 100 } as const;

/**
 * One balloon, caption or sound (R-8). `text` is stored exactly as authored: setting it in capitals
 * is how a comic looks, not what was written, so verification folds case (R-29) rather than the
 * script storing an upper-cased copy that could drift from the words.
 */
export const LetteringItemSchema = z.object({
  id: UlidSchema,
  kind: LetteringKindSchema,
  /** A character sheet; absent for a caption or a sound effect. */
  speaker: SlugSchema.optional(),
  text: z.string().trim().min(1).max(COMIC_LIMITS.textMax),
}).strict().refine((item) => !(UNSPOKEN.has(item.kind) && item.speaker), {
  message: "A caption or sound effect has no speaker.", path: ["speaker"],
});
export type LetteringItem = z.infer<typeof LetteringItemSchema>;

export const PanelSizeSchema = z.enum(["small", "normal", "large"]);

/**
 * What one panel shows (R-7). Order is the panel's place in its page's array: a stored `order`
 * beside the array would be a second answer to the same question, and the two could disagree.
 */
export const ComicPanelSchema = z.object({
  id: UlidSchema,
  description: z.string().trim().min(1).max(COMIC_LIMITS.descriptionMax),
  shot: z.string().trim().min(1).max(120).optional(),
  characters: z.array(SlugSchema).max(8).default([]),
  location: SlugSchema.optional(),
  size: PanelSizeSchema.optional(),
  lettering: z.array(LetteringItemSchema).max(COMIC_LIMITS.letteringPerPage).default([]),
}).strict();
export type ComicPanel = z.infer<typeof ComicPanelSchema>;

export const ComicPageStatusSchema = z.enum(["draft", "ready"]);

/**
 * One page (R-6). Its number is derived from where it stands in the book (D-2) rather than stored,
 * for the same reason panels carry no order: a moved page must not keep a stale number.
 */
export const ComicPageSchema = z.object({
  id: UlidSchema,
  layout: z.string().min(1).max(60),
  notes: z.string().trim().min(1).max(2000).optional(),
  reading: ComicReadingSchema.optional(),
  aspect: z.string().min(3).max(12).optional(),
  status: ComicPageStatusSchema.default("draft"),
  panels: z.array(ComicPanelSchema).max(COMIC_LIMITS.panelsPerPage).default([]),
  /** Alt text the author wrote; absent derives it from the panels (R-53). */
  alt: z.string().trim().min(1).max(4000).optional(),
}).strict().superRefine((page, ctx) => {
  const lettering = page.panels.reduce((count, panel) => count + panel.lettering.length, 0);
  if (lettering > COMIC_LIMITS.letteringPerPage) ctx.addIssue({ code: "custom", path: ["panels"],
    message: `A page holds at most ${COMIC_LIMITS.letteringPerPage} lettering items; this one has ${lettering}.` });
  if (page.aspect !== undefined && normalizeAspect(page.aspect) !== page.aspect) ctx.addIssue({ code: "custom", path: ["aspect"],
    message: `“${page.aspect}” is not an aspect.` });
});
export type ComicPage = z.infer<typeof ComicPageSchema>;

/**
 * `productions/<id>/comic/<chapter>.json`, one chapter's script (R-5, R-10). Ids are unique across
 * the whole document, because takes, findings and translations point at them by id alone. It rides
 * the committer's JSON track, which stamps `version` on every accepted change, as an episode script's.
 */
export const ComicScriptSchema = z.object({
  version: z.number().int().min(1),
  pages: z.array(ComicPageSchema).max(COMIC_LIMITS.pagesPerChapter).default([]),
}).strict().superRefine((script, ctx) => {
  const seen = new Set<string>();
  const once = (id: string, path: (string | number)[]) => {
    if (seen.has(id)) ctx.addIssue({ code: "custom", path, message: `The id ${id} is used twice.` });
    seen.add(id);
  };
  script.pages.forEach((page, p) => {
    once(page.id, ["pages", p, "id"]);
    page.panels.forEach((panel, q) => {
      once(panel.id, ["pages", p, "panels", q, "id"]);
      panel.lettering.forEach((item, l) => once(item.id, ["pages", p, "panels", q, "lettering", l, "id"]));
    });
  });
});
export type ComicScript = z.infer<typeof ComicScriptSchema>;
export const EMPTY_COMIC_SCRIPT: ComicScript = { version: 1, pages: [] };

/** The checks' numbers (D-7), kept on each take as they stood when it was checked (R-31). */
export const LetteringThresholdsSchema = z.object({
  /** At or above: the words are the script's. */
  exact: z.number().min(0.5).max(1),
  /** Below: the item is not on the page at all. */
  missing: z.number().min(0).max(1),
}).strict().refine((t) => t.missing < t.exact, { message: "Missing must be below exact." });
export type LetteringThresholds = z.infer<typeof LetteringThresholdsSchema>;
export const DEFAULT_LETTERING_THRESHOLDS: LetteringThresholds = { exact: 0.97, missing: 0.75 };

/** Try until it passes (D-6, R-27): whichever cap comes first stops it. */
export const ComicAttemptCapSchema = z.object({
  attempts: z.number().int().min(1).max(10),
  usd: z.number().min(0.01).max(100),
}).strict();
export const DEFAULT_COMIC_ATTEMPT_CAP = { attempts: 3, usd: 5 } as const;

export const DEFAULT_COMIC_ASPECT = "2:3";

/** `productions/<id>/comic.json` (R-12): how the book reads and how its pages are checked. */
export const ComicSettingsSchema = z.object({
  version: z.literal(1),
  reading: ComicReadingSchema.default("ltr"),
  aspect: z.string().min(3).max(12).default(DEFAULT_COMIC_ASPECT),
  mode: ComicModeSchema.default("baked"),
  language: z.string().min(2).max(35).default("en"),
  thresholds: LetteringThresholdsSchema.default(DEFAULT_LETTERING_THRESHOLDS),
  cap: ComicAttemptCapSchema.default(DEFAULT_COMIC_ATTEMPT_CAP),
}).strict().superRefine((settings, ctx) => {
  if (normalizeAspect(settings.aspect) !== settings.aspect) ctx.addIssue({ code: "custom", path: ["aspect"], message: `“${settings.aspect}” is not an aspect.` });
});
export type ComicSettings = z.infer<typeof ComicSettingsSchema>;
export const DEFAULT_COMIC_SETTINGS: ComicSettings = ComicSettingsSchema.parse({ version: 1 });

// ---------------------------------------------------------------------------
// Layout templates (R-14 – R-17)
// ---------------------------------------------------------------------------

/** A panel's rectangle as fractions of the page, origin top-left. */
export interface LayoutRect { x: number; y: number; w: number; h: number }
export interface LayoutTemplate {
  id: string;
  label: string;
  /** The shape this layout is drawn for; a page's own aspect wins (R-12). */
  aspect: string;
  /** Webtoon pages scroll; every other template turns (R-15). */
  scroll?: true;
  /** Rectangles in left-to-right reading order; a right-to-left page reads them mirrored (R-9). */
  panels: readonly LayoutRect[];
  /** How the layout is described to the model (R-16). */
  describe: string;
}

const grid = (cols: number, rows: number): LayoutRect[] => Array.from({ length: cols * rows }, (_, i) =>
  ({ x: (i % cols) / cols, y: Math.floor(i / cols) / rows, w: 1 / cols, h: 1 / rows }));

export const LAYOUT_TEMPLATES: readonly LayoutTemplate[] = [
  { id: "grid-2x2", label: "Grid 2×2", aspect: "2:3", panels: grid(2, 2), describe: "four equal panels in a 2 by 2 grid" },
  { id: "grid-3x3", label: "Grid 3×3", aspect: "2:3", panels: grid(3, 3), describe: "nine equal panels in a 3 by 3 grid" },
  { id: "strip-3", label: "Widescreen", aspect: "2:3", panels: grid(1, 3), describe: "three full-width widescreen panels stacked top to bottom" },
  { id: "splash", label: "Splash", aspect: "2:3", panels: [{ x: 0, y: 0, w: 1, h: 1 }], describe: "a single full-page splash panel" },
  {
    id: "feature", label: "Feature", aspect: "2:3",
    panels: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }],
    describe: "one large panel across the top half, then two equal panels side by side below it",
  },
  {
    id: "manga", label: "Manga", aspect: "2:3",
    panels: [{ x: 0, y: 0, w: 0.4, h: 0.35 }, { x: 0.4, y: 0, w: 0.6, h: 0.35 }, { x: 0, y: 0.35, w: 1, h: 0.3 }, { x: 0, y: 0.65, w: 0.6, h: 0.35 }, { x: 0.6, y: 0.65, w: 0.4, h: 0.35 }],
    describe: "five panels of varied size in three tiers: two across the top, one wide panel in the middle, two across the bottom",
  },
  { id: "webtoon", label: "Webtoon", aspect: "9:16", scroll: true, panels: grid(1, 3), describe: "a tall vertical strip of three panels read top to bottom with space between them" },
];

export function layoutTemplate(id: string): LayoutTemplate | undefined {
  return LAYOUT_TEMPLATES.find((template) => template.id === id);
}

/** How the page reads: its own setting over the book's (R-12). A webtoon layout always scrolls. */
export function pageReading(page: Pick<ComicPage, "reading" | "layout">, settings: Pick<ComicSettings, "reading">): ComicReading {
  if (layoutTemplate(page.layout)?.scroll) return "scroll";
  return page.reading ?? settings.reading;
}

export function pageAspect(page: Pick<ComicPage, "aspect" | "layout">, settings: Pick<ComicSettings, "aspect">): string {
  const template = layoutTemplate(page.layout);
  return page.aspect ?? (template?.scroll ? template.aspect : settings.aspect);
}

/**
 * The rectangle each panel is drawn in, in the panel array's order (R-9). A right-to-left page
 * mirrors the template, which mirrors its reading order with it; lettering inside a panel keeps its
 * order either way. Panels past the template's count have no rectangle and review says so (R-40).
 */
export function panelRects(page: Pick<ComicPage, "layout">, reading: ComicReading): LayoutRect[] {
  return (layoutTemplate(page.layout)?.panels ?? []).map((rect) => reading === "rtl" ? { ...rect, x: 1 - rect.x - rect.w } : rect);
}

// ---------------------------------------------------------------------------
// Reading order and the picture's fingerprint (R-9, R-11)
// ---------------------------------------------------------------------------

export interface ComicReadingEntry { pageId: string; panelId: string; item: LetteringItem; panelIndex: number; pageNumber: number }

/** Every lettering item in reading order: page, then panel, then lettering (R-9). */
export function letteringInOrder(pages: readonly ComicPage[], firstPage = 1): ComicReadingEntry[] {
  return pages.flatMap((page, p) => page.panels.flatMap((panel, panelIndex) =>
    panel.lettering.map((item) => ({ pageId: page.id, panelId: panel.id, item, panelIndex, pageNumber: firstPage + p }))));
}

/**
 * What makes a page's picture what it is (R-11, R-25), and nothing else: a typo fixed in `notes` or
 * a status change is not a stale page. In overlay mode the art carries no words, so lettering text
 * is left out — retyping a balloon must not throw away clean art that never showed it.
 */
export function comicPageHash(page: ComicPage, settings: Pick<ComicSettings, "reading" | "aspect">, mode: ComicMode): string {
  const reading = pageReading(page, settings);
  const picture = {
    layout: page.layout, reading, aspect: pageAspect(page, settings), mode,
    panels: page.panels.map((panel) => ({
      description: panel.description, shot: panel.shot ?? null, characters: panel.characters,
      location: panel.location ?? null, size: panel.size ?? null,
      lettering: mode === "baked" ? panel.lettering.map((item) => [item.kind, item.speaker ?? null, item.text]) : panel.lettering.length,
    })),
  };
  return textDigest(JSON.stringify(picture));
}

// ---------------------------------------------------------------------------
// Takes and their verification (R-26, R-29 – R-33)
// ---------------------------------------------------------------------------

export const LetteringFindingKindSchema = z.enum(["missing", "altered", "extra", "order", "clipped", "speaker"]);
export type LetteringFindingKind = z.infer<typeof LetteringFindingKindSchema>;
/** R-31: these stop an accept; order and speaker only warn. */
export const BLOCKING_FINDINGS: ReadonlySet<LetteringFindingKind> = new Set(["missing", "altered", "extra", "clipped"]);

/** A box as fractions of the page, origin top-left. */
export const PageBoxSchema = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1),
}).strict();
export type PageBox = z.infer<typeof PageBoxSchema>;

/** What a page reader found: text and where (R-29). */
export const PageTextRegionSchema = z.object({ text: z.string().max(2000), box: PageBoxSchema.optional() }).strict();
export type PageTextRegion = z.infer<typeof PageTextRegionSchema>;

export const LetteringFindingSchema = z.object({
  id: z.string().min(1).max(80),
  kind: LetteringFindingKindSchema,
  /** The lettering item it concerns; absent for extra text. */
  item: UlidSchema.optional(),
  expected: z.string().max(2000).optional(),
  found: z.string().max(2000).optional(),
  box: PageBoxSchema.optional(),
  similarity: z.number().min(0).max(1).optional(),
}).strict();
export type LetteringFinding = z.infer<typeof LetteringFindingSchema>;

export const LETTERING_NORMALIZATION_VERSION = 1;

export const LetteringVerificationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("compared"),
    reader: z.object({ id: z.string().min(1).max(80), version: z.string().min(1).max(80) }).strict(),
    normalizationVersion: z.number().int().min(1),
    thresholds: LetteringThresholdsSchema,
    score: z.number().min(0).max(1),
    findings: z.array(LetteringFindingSchema).max(200),
    /** Speaker attribution is checked only when the reader reports balloon tails (R-30). */
    speaker: z.enum(["checked", "not-checked"]),
    regions: z.array(PageTextRegionSchema).max(200).default([]),
    at: IsoDateTimeSchema,
  }).strict(),
  z.object({
    /** No completed comparison: never a pass (R-32). */
    status: z.literal("unavailable"),
    reason: z.enum(["no-reader", "reader-failed", "unreadable", "language", "no-lettering"]),
    detail: z.string().max(400).optional(),
    at: IsoDateTimeSchema,
  }).strict(),
]);
export type LetteringVerification = z.infer<typeof LetteringVerificationSchema>;

/** An accept past blocking findings or an unavailable check, on the record (R-33). */
export const LetteringOverrideSchema = z.object({
  at: IsoDateTimeSchema,
  /** The findings it covers; empty when the check was unavailable. */
  findings: z.array(z.string().min(1).max(80)).max(200),
  reason: z.string().trim().min(1).max(400).optional(),
}).strict();
export type LetteringOverride = z.infer<typeof LetteringOverrideSchema>;

/** One generated page (R-26). */
export const ComicPageTakeSchema = z.object({
  id: UlidSchema,
  artifact: ArtifactIdSchema,
  job: JobIdSchema.optional(),
  /** The fingerprint it was made from (R-25); a different current hash is out of date. */
  hash: z.string().min(1).max(80),
  mode: ComicModeSchema,
  model: z.string().min(1).max(200),
  language: z.string().min(2).max(35),
  usd: z.number().min(0).optional(),
  at: IsoDateTimeSchema,
  verification: LetteringVerificationSchema.optional(),
  override: LetteringOverrideSchema.optional(),
}).strict();
export type ComicPageTake = z.infer<typeof ComicPageTakeSchema>;

/**
 * A placed balloon or caption over clean art (R-38). It points at its lettering item by id and
 * reads the words from the script, so editing or translating the text never touches the layer.
 */
export const LetteringPlacementSchema = z.object({
  item: UlidSchema,
  box: PageBoxSchema,
  /** Where the tail points, as a page fraction; absent draws none. */
  tail: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict().optional(),
}).strict();
export type LetteringPlacement = z.infer<typeof LetteringPlacementSchema>;

export const ComicPageMakingSchema = z.object({
  requestId: UlidSchema,
  hash: z.string().min(1).max(80),
  mode: ComicModeSchema,
  model: z.string().min(1).max(200),
  language: z.string().min(2).max(35),
  at: IsoDateTimeSchema,
  /** The Bench session it is made in, once one is open. */
  session: z.string().min(1).max(80).optional(),
}).strict();
export type ComicPageMaking = z.infer<typeof ComicPageMakingSchema>;

/** `productions/<id>/comic-pages/<page>.json`: a page's takes and what the author chose. */
export const ComicPageRecordSchema = z.object({
  version: z.literal(1),
  takes: z.array(ComicPageTakeSchema).max(COMIC_LIMITS.takesPerPage).default([]),
  /** Accepted take id by language (R-26). */
  accepted: z.record(z.string().min(2).max(35), UlidSchema).default({}),
  /** The overlay layer, by take id (R-38). */
  lettering: z.record(UlidSchema, z.array(LetteringPlacementSchema).max(COMIC_LIMITS.letteringPerPage)).default({}),
  /** Layout and continuity checks the author has looked at, by take id (R-17, R-21). */
  acknowledged: z.record(UlidSchema, z.array(z.enum(["layout", "continuity"])).max(2)).default({}),
  /**
   * Generations admitted and not yet landed (R-25). Written before any job exists, so a restart
   * finds the Bench session the picture is landing in and files it, rather than asking again.
   */
  making: z.array(ComicPageMakingSchema).max(10).default([]),
}).strict().superRefine((record, ctx) => {
  const ids = new Set(record.takes.map((take) => take.id));
  for (const [language, take] of Object.entries(record.accepted)) {
    if (!ids.has(take)) ctx.addIssue({ code: "custom", path: ["accepted", language], message: `No take ${take}.` });
  }
});
export type ComicPageRecord = z.infer<typeof ComicPageRecordSchema>;
export const EMPTY_COMIC_PAGE_RECORD: ComicPageRecord = { version: 1, takes: [], accepted: {}, lettering: {}, acknowledged: {}, making: [] };

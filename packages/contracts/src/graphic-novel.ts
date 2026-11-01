import { z } from "zod";
import { ArtifactIdSchema, IsoDateTimeSchema, JobIdSchema, SlugSchema, UlidSchema, ulid } from "./ids.js";
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
 * Where a panel came from (R-13, turn 249d): one version of one chapter, and its paragraphs by
 * number, as an episode's scene pins its source (SPEC-052 R-29). The story is the book's own when
 * its chapters hold the prose, or the story it adapts. Not part of a page's picture: a cited
 * passage never makes a take out of date.
 */
export const ComicSourceSchema = z.object({
  story: SlugSchema,
  chapter: z.string().min(1).max(200),
  version: z.number().int().min(1),
  /** The chapter file's hash when pinned: a direct save keeps the version, so only the hash shows the prose moved. */
  hash: z.string().min(1).max(200).optional(),
  /** 1-based paragraph numbers in the pinned version, never text. */
  paragraphs: z.array(z.number().int().min(1).max(100_000)).min(1).max(200),
}).strict();
export type ComicSource = z.infer<typeof ComicSourceSchema>;

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
  source: ComicSourceSchema.optional(),
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
/**
 * A chapter's page plan (SPEC-064 R-60 – R-63, turn 254b): what of the prose is kept, cut or merged,
 * what each page does, and what the reader has been shown where. The Ledger of Nights, drawn, was
 * drafted straight from the prose with no such step, and its cuts left later lines leaning on what
 * was cut.
 */
export const COMIC_PLAN_VERDICTS = ["keep", "cut", "merge", "show", "invent"] as const;
export const ComicChapterPlanSchema = z.object({
  passages: z.array(z.object({
    /** Where in the prose, as the reader of the plan finds it: "¶ 1–6". */
    where: z.string().trim().min(1).max(80),
    what: z.string().trim().min(1).max(200),
    verdict: z.enum(COMIC_PLAN_VERDICTS),
    why: z.string().trim().min(1).max(200),
  }).strict()).min(1).max(120),
  pages: z.array(z.object({
    change: z.string().trim().min(1).max(200),
    /** The turn the page ends on. */
    turn: z.string().trim().min(1).max(200),
  }).strict()).min(1).max(COMIC_LIMITS.pagesPerChapter),
  /** What the reader holds (R-61): each person, place, thing or rule, and the page that first shows or names it. */
  knows: z.array(z.object({ name: z.string().trim().min(1).max(120), page: z.number().int().min(1).max(COMIC_LIMITS.pagesPerChapter), how: z.string().trim().min(1).max(40) }).strict()).max(200).default([]),
  /**
   * Questions the book means the reader to carry (turn 256c): the cold read is told them and does
   * not count them as faults. Nineteen of a draft's flags in the owner's run were mysteries the
   * book keeps on purpose.
   */
  mysteries: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  /** Lines that lean on a cut, or on anything the reader was not shown (R-61, R-62): named, never hidden. */
  leans: z.array(z.object({ page: z.number().int().min(1).max(COMIC_LIMITS.pagesPerChapter), line: z.string().trim().min(1).max(300), why: z.string().trim().min(1).max(200) }).strict()).max(60).default([]),
}).strict();
export type ComicChapterPlan = z.infer<typeof ComicChapterPlanSchema>;

/**
 * What a reader with only the pages asked of a draft (R-64 – R-66, turn 254d). `who`, `what`, `why`
 * and `voice` block; the rest warn. Kept on the chapter's script with the draft, so a draft kept
 * past them carries what it was kept with.
 */
export const SCRIPT_READ_KINDS = ["who", "what", "why", "where", "voice", "picture", "load", "kept"] as const;
export const SCRIPT_READ_BLOCKING: ReadonlySet<string> = new Set(["who", "what", "why", "voice"]);
export const ComicScriptReadFindingSchema = z.object({
  kind: z.enum(SCRIPT_READ_KINDS),
  page: z.number().int().min(1).max(COMIC_LIMITS.pagesPerChapter),
  panel: z.number().int().min(1).max(COMIC_LIMITS.panelsPerPage).optional(),
  /** The question the reader would ask, in its words. */
  question: z.string().trim().min(1).max(300),
}).strict();
export type ComicScriptReadFinding = z.infer<typeof ComicScriptReadFindingSchema>;
export const ComicScriptReadSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("read"),
    reader: z.object({ id: z.string().min(1).max(80), version: z.string().min(1).max(80) }).strict(),
    findings: z.array(ComicScriptReadFindingSchema).max(60),
    /** Drafts read before this one in the same turn: the redrafts Arke made for the reader (R-65). */
    redrafts: z.number().int().min(0).max(5).default(0),
    at: IsoDateTimeSchema,
  }).strict(),
  z.object({
    /** Never a pass (R-66). */
    status: z.literal("not-read"),
    reason: z.enum(["no-reader", "reader-failed"]),
    detail: z.string().max(400).optional(),
    at: IsoDateTimeSchema,
  }).strict(),
]);
export type ComicScriptRead = z.infer<typeof ComicScriptReadSchema>;

export const ComicScriptSchema = z.object({
  version: z.number().int().min(1),
  pages: z.array(ComicPageSchema).max(COMIC_LIMITS.pagesPerChapter).default([]),
  /** The plan the pages were drafted from (R-60); a chapter Arke drafts has one kept first. */
  plan: ComicChapterPlanSchema.optional(),
  /** The cold read of Arke's draft (R-64); dropped once the author edits the pages by hand. */
  read: ComicScriptReadSchema.optional(),
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

/**
 * A chapter's pages as Arke drafts them (R-13, turn 249d): the script's shapes with every id
 * optional, since a new page, panel or line has none until it is kept. `settleComicDraft` gives
 * them ids; the script's own schema then judges the whole.
 */
const DraftId = z.string().min(1).max(40);
export const DraftLetteringSchema = z.object({
  id: DraftId.optional(),
  kind: LetteringKindSchema,
  speaker: SlugSchema.optional(),
  text: z.string().trim().min(1).max(COMIC_LIMITS.textMax),
}).strict();
export const DraftComicPanelSchema = z.object({
  id: DraftId.optional(),
  description: z.string().trim().min(1).max(COMIC_LIMITS.descriptionMax),
  shot: z.string().trim().min(1).max(120).optional(),
  characters: z.array(SlugSchema).max(8).default([]),
  location: SlugSchema.optional(),
  size: PanelSizeSchema.optional(),
  lettering: z.array(DraftLetteringSchema).max(COMIC_LIMITS.letteringPerPage).default([]),
  source: ComicSourceSchema.extend({ version: z.number().int().min(1).optional() }).optional(),
}).strict();
export const DraftComicPageSchema = z.object({
  id: DraftId.optional(),
  layout: z.string().min(1).max(60),
  notes: z.string().trim().min(1).max(2000).optional(),
  reading: ComicReadingSchema.optional(),
  aspect: z.string().min(3).max(12).optional(),
  panels: z.array(DraftComicPanelSchema).min(1).max(COMIC_LIMITS.panelsPerPage),
  alt: z.string().trim().min(1).max(4000).optional(),
}).strict();
export type DraftComicPage = z.infer<typeof DraftComicPageSchema>;

/**
 * Arke's pages as the script's: an id the chapter's script already holds is kept, once; any other
 * id, or none, becomes a new ULID, so a draft can never claim another page's takes by guessing its
 * id. A source with no version is left for the caller to pin to the chapter as it stands.
 */
export function settleComicDraft(draft: readonly DraftComicPage[], current: readonly ComicPage[]): Array<Omit<ComicPage, "panels"> & { panels: Array<Omit<ComicPanel, "source"> & { source?: DraftComicPage["panels"][number]["source"] }> }> {
  const known = new Set(current.flatMap((page) => [page.id, ...page.panels.flatMap((panel) => [panel.id, ...panel.lettering.map((item) => item.id)])]));
  const used = new Set<string>();
  const settle = (id: string | undefined) => {
    if (id !== undefined && known.has(id) && !used.has(id)) { used.add(id); return id; }
    return ulid();
  };
  return draft.map((page) => ({
    ...page,
    id: settle(page.id),
    status: "draft" as const,
    panels: page.panels.map((panel) => ({
      ...panel,
      id: settle(panel.id),
      lettering: panel.lettering.map((item) => ({ ...item, id: settle(item.id) })),
    })),
  }));
}
export const EMPTY_COMIC_SCRIPT: ComicScript = { version: 1, pages: [] };

/**
 * How prose becomes pages a reader can follow without the prose (R-13). The Ledger of Nights, drawn
 * (30 October 2026) was drafted to the letter of "exact lettering" with nothing on craft: fourteen
 * balloons were the prose's dialogue with its "she said" cut and its comma left, a ledger's lines
 * stood as bare captions, Bray was named eight pages after he first spoke and Jory, Beren and Rusk
 * never were, and one page carried twelve balloons with tails nobody could follow.
 */
export const COMIC_ADAPTATION_CRAFT = "Write for a reader who has only the pages, never the prose. " +
  "Lettering is what is said, thought or narrated, never the prose with its tags cut: no \"she said\", every line whole and never ending in a comma; rewrite a line whose prose version leans on its tag or on what came before. " +
  "Name each person in the lettering the first time they matter, in what someone says or in a caption, and never speak of anyone the pages have not shown or named. " +
  "Writing in the world, a ledger entry, a notice or a letter, is drawn on the thing in the panel or set in a caption that says whose it is and when, never a bare fragment the reader cannot place. " +
  "At most three balloons to a panel and about twelve to a page, so each points to one clear speaker; spread a long exchange over more panels. " +
  "A page read on its own still says who is speaking, where they are and what changed.";

/**
 * The first line that ends in a comma: the prose's dialogue with its tag cut ("Give me the
 * addresses," she said), which leaves the reader holding an unfinished line. Refused when Arke
 * drafts, so the draft comes back whole (COMIC_ADAPTATION_CRAFT).
 */
export function unfinishedLettering(pages: readonly { panels: readonly { lettering: readonly { text: string }[] }[] }[]): { page: number; text: string } | undefined {
  for (const [index, page] of pages.entries()) {
    for (const panel of page.panels) {
      for (const item of panel.lettering) {
        if (/,\s*$/.test(item.text)) return { page: index + 1, text: item.text };
      }
    }
  }
  return undefined;
}

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

/** The style's words are sent with every page brief, so they are bounded like a look is. */
export const COMIC_STYLE_WORDS_MAX = 600;

/**
 * How a book's pages are drawn (R-21a, turn 248). The words are the record; `preset` is only the
 * card that seeded them, so the picker can show it as chosen. An edited preset is the author's own
 * words like any other: nothing re-reads the preset's text.
 */
export const ComicStyleSchema = z.object({
  words: z.string().trim().min(1).max(COMIC_STYLE_WORDS_MAX),
  preset: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
}).strict();
export type ComicStyle = z.infer<typeof ComicStyleSchema>;

/**
 * The story a graphic novel adapts (R-3, turn 249): its own chapter for each of the story's, so
 * Pages and Arke know which prose a chapter's pages are drawn from. Ids, not text: the prose is
 * read where it lives.
 */
export const ComicAdaptsSchema = z.object({
  story: SlugSchema,
  chapters: z.array(z.object({ chapter: z.string().min(1).max(200), from: z.string().min(1).max(200) }).strict()).max(500),
}).strict();
export type ComicAdapts = z.infer<typeof ComicAdaptsSchema>;

/** `productions/<id>/comic.json` (R-12): how the book reads and how its pages are checked. */
export const ComicSettingsSchema = z.object({
  version: z.literal(1),
  reading: ComicReadingSchema.default("ltr"),
  aspect: z.string().min(3).max(12).default(DEFAULT_COMIC_ASPECT),
  mode: ComicModeSchema.default("baked"),
  language: z.string().min(2).max(35).default("en"),
  thresholds: LetteringThresholdsSchema.default(DEFAULT_LETTERING_THRESHOLDS),
  cap: ComicAttemptCapSchema.default(DEFAULT_COMIC_ATTEMPT_CAP),
  /** Absent is World look: the world's art direction alone, as before there was a style. */
  style: ComicStyleSchema.optional(),
  /** The story it adapts, when Plan with Arke made it from one (turn 249). */
  adapts: ComicAdaptsSchema.optional(),
}).strict().superRefine((settings, ctx) => {
  if (normalizeAspect(settings.aspect) !== settings.aspect) ctx.addIssue({ code: "custom", path: ["aspect"], message: `“${settings.aspect}” is not an aspect.` });
});
export type ComicSettings = z.infer<typeof ComicSettingsSchema>;
export const DEFAULT_COMIC_SETTINGS: ComicSettings = ComicSettingsSchema.parse({ version: 1 });

/**
 * A graphic novel's plan in setup (R-4, turn 249b): how it reads, its page shape and style, whether
 * Arke drafts a pilot chapter first, and a chapter of pages for each chapter of the story it adapts,
 * named by that chapter's number. Page counts and layouts are first guesses, never limits.
 */
export interface ComicPlanChapter {
  /** The adapted story's chapter number. */
  from: number;
  title: string;
  pages: number;
  layout?: string | undefined;
}
/**
 * Named rather than inferred, as `Frame` is: the plan rides in every setup draft and its review,
 * inside the conversation's loaded schema, and inferred there it took the engine's bundled
 * declarations past what the compiler will write (TS7056).
 */
export interface ComicPlan {
  reading: ComicReading;
  aspect: string;
  style?: ComicStyle | undefined;
  pilot: boolean;
  /** Source chapter number chosen for the pilot; absent keeps older plans on their first row. */
  pilotFrom?: number | undefined;
  chapters: ComicPlanChapter[];
}
export const ComicPlanChapterSchema: z.ZodType<ComicPlanChapter, z.ZodTypeDef, unknown> = z.object({
  from: z.number().int().min(1).max(500),
  title: z.string().trim().min(1).max(200),
  pages: z.number().int().min(1).max(COMIC_LIMITS.pagesPerChapter),
  layout: z.string().min(1).max(60).optional(),
}).strict();
export const ComicPlanSchema: z.ZodType<ComicPlan, z.ZodTypeDef, unknown> = z.object({
  reading: ComicReadingSchema,
  aspect: z.string().min(3).max(12),
  style: ComicStyleSchema.optional(),
  pilot: z.boolean(),
  pilotFrom: z.number().int().min(1).max(500).optional(),
  chapters: z.array(ComicPlanChapterSchema).max(500),
}).strict().superRefine((plan, ctx) => {
  if (normalizeAspect(plan.aspect) !== plan.aspect) ctx.addIssue({ code: "custom", path: ["aspect"], message: `“${plan.aspect}” is not an aspect.` });
  if (plan.pilot && plan.pilotFrom !== undefined && plan.chapters.length > 0 && plan.chapters.filter(chapter => chapter.from === plan.pilotFrom).length !== 1) {
    ctx.addIssue({ code: "custom", path: ["pilotFrom"], message: "Choose one chapter in the plan as the pilot." });
  }
});

/** The same pilot for the plan, creation review and first drafting ask (issue 2252). */
export function comicPilotChapter(plan: ComicPlan | undefined): ComicPlanChapter | undefined {
  if (!plan?.pilot) return undefined;
  return plan.pilotFrom === undefined ? plan.chapters[0] : plan.chapters.find(chapter => chapter.from === plan.pilotFrom);
}

/** What a graphic novel made from a plan is created with (turn 249b); named for the same reason. */
export interface ComicCreation {
  reading: ComicReading;
  aspect: string;
  style?: ComicStyle | undefined;
  adapts?: ComicAdapts | undefined;
  chapters: Array<{ stem: string; title: string }>;
}
export const ComicCreationSchema: z.ZodType<ComicCreation, z.ZodTypeDef, unknown> = z.object({
  reading: ComicReadingSchema,
  aspect: z.string().min(3).max(12),
  style: ComicStyleSchema.optional(),
  adapts: ComicAdaptsSchema.optional(),
  chapters: z.array(z.object({ stem: SlugSchema, title: z.string().trim().min(1).max(200) }).strict()).max(500),
}).strict();
export const DEFAULT_COMIC_PLAN: ComicPlan = { reading: "ltr", aspect: DEFAULT_COMIC_ASPECT, pilot: true, chapters: [] };

/** The three things setup asks by example (R-4): the page draws example cards for the one open. */
/** What setup is asking (turn 249b), or the usual three as one card to use or change (turn 256a). */
export const ComicAskSchema = z.enum(["usual", "reading", "aspect", "pilot"]);
export type ComicAsk = z.infer<typeof ComicAskSchema>;

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
/**
 * The layout a page's panels fit (turn 256): its own when the counts agree, otherwise the first
 * template with exactly that many panels, otherwise its own. Arke gave every page of a draft the
 * five-panel Manga template, one of them holding nine panels.
 */
export function fitLayout(layout: string, panels: number): string {
  if (layoutTemplate(layout)?.panels.length === panels) return layout;
  return LAYOUT_TEMPLATES.find((template) => !template.scroll && template.panels.length === panels)?.id ?? layout;
}

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
export const PageTextRegionSchema = z.object({
  text: z.string().max(2000),
  box: PageBoxSchema.optional(),
  /** The reader saw these words cut off by the page edge or a panel border (R-30). */
  cut: z.boolean().optional(),
}).strict();
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

/**
 * What the page review finds in the picture (R-67 – R-69, turn 253). The lettering check reads the
 * words alone; on The Ledger of Nights, drawn, it passed a caption about stopping a pen drawn over a
 * woman at a rail and faces in the water no panel asked for.
 */
export const PageReviewFindingKindSchema = z.enum(["content", "cast", "caption", "defect", "speaker", "likeness", "continuity", "layout"]);
export type PageReviewFindingKind = z.infer<typeof PageReviewFindingKindSchema>;
/** R-69: these stop an accept; likeness, continuity and layout are looked at, not fixed. */
export const REVIEW_BLOCKING: ReadonlySet<PageReviewFindingKind> = new Set(["content", "cast", "caption", "defect", "speaker"]);
/** The warnings the author marks Seen, kept by take in the page record's `acknowledged`. */
export const REVIEW_WARNINGS = ["layout", "continuity", "likeness"] as const;
export type ReviewWarning = typeof REVIEW_WARNINGS[number];

export const PageReviewFindingSchema = z.object({
  /** `review:` first, so an override names it beside the lettering's findings without a clash. */
  id: z.string().regex(/^review:/).max(80),
  kind: PageReviewFindingKindSchema,
  /** The panel, counted from 1 in reading order; absent for the page as a whole. */
  panel: z.number().int().min(1).max(40).optional(),
  note: z.string().trim().min(1).max(300),
  box: PageBoxSchema.optional(),
}).strict();
export type PageReviewFinding = z.infer<typeof PageReviewFindingSchema>;

export const PageReviewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("compared"),
    reviewer: z.object({ id: z.string().min(1).max(80), version: z.string().min(1).max(80) }).strict(),
    /** The references it was shown, by name, and the page before it by take (R-67, R-71). */
    references: z.array(z.string().min(1).max(120)).max(20).default([]),
    previous: UlidSchema.optional(),
    findings: z.array(PageReviewFindingSchema).max(60),
    /** Lettering `extra` findings it found to be writing the panel calls for (R-70), with why. */
    cleared: z.array(z.object({ finding: z.string().min(1).max(80), reason: z.string().trim().min(1).max(200) }).strict()).max(60).default([]),
    at: IsoDateTimeSchema,
  }).strict(),
  z.object({
    /** No completed review: never a pass (R-72). */
    status: z.literal("unavailable"),
    reason: z.enum(["no-reviewer", "reviewer-failed", "unreadable"]),
    detail: z.string().max(400).optional(),
    at: IsoDateTimeSchema,
  }).strict(),
]);
export type PageReview = z.infer<typeof PageReviewSchema>;
/** The id an override names to keep a take whose picture could not be reviewed (R-72). */
export const REVIEW_UNAVAILABLE = "review:unavailable";

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
  /** The picture's review (R-67); absent on a take made before there was one. */
  review: PageReviewSchema.optional(),
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
  /** The review's warnings the author has marked Seen, by take id (R-17, R-21, R-69). */
  acknowledged: z.record(UlidSchema, z.array(z.enum(REVIEW_WARNINGS)).max(REVIEW_WARNINGS.length)).default({}),
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

/**
 * Every finding that stops a take being accepted, its words' and its picture's together (R-31,
 * R-69): one list, so Accept, Accept anyway, Until it passes and the book read it the same way. An
 * `extra` the review found to be writing the panel calls for is not one (R-70). A picture that could
 * not be reviewed blocks by name (R-72); a take made before there was a review has none, and its
 * picture is unchecked, not failed.
 */
export function takeBlocking(take: Pick<ComicPageTake, "verification" | "review">): string[] {
  const review = take.review;
  const cleared = new Set(review?.status === "compared" ? review.cleared.map((entry) => entry.finding) : []);
  const lettering = take.verification?.status === "compared"
    ? take.verification.findings.filter((finding) => BLOCKING_FINDINGS.has(finding.kind) && !(finding.kind === "extra" && cleared.has(finding.id))).map((finding) => finding.id)
    : [];
  const picture = review?.status === "compared" ? review.findings.filter((finding) => REVIEW_BLOCKING.has(finding.kind)).map((finding) => finding.id)
    : review?.status === "unavailable" ? [REVIEW_UNAVAILABLE] : [];
  return [...lettering, ...picture];
}

/** A take that may be accepted as it stands: its words read and nothing of either check blocking. */
export function takeClears(take: Pick<ComicPageTake, "verification" | "review">): boolean {
  return take.verification?.status === "compared" && takeBlocking(take).length === 0;
}

// ---------------------------------------------------------------------------
// The book as it stands (R-40, R-41, R-47)
// ---------------------------------------------------------------------------

export interface ComicBookPage {
  id: string;
  chapter: string;
  number: number;
  page: ComicPage;
  /** The accepted take in the book's language, if any. */
  take?: ComicPageTake;
  /** Accepted, but made from words or panels the script no longer says (R-25). */
  outOfDate: boolean;
  /** Its lettering passed, or the author overrode what was found (R-33). */
  cleared: boolean;
  /** Kept with an override rather than a pass. */
  overridden: boolean;
}

/**
 * Every page of the book in reading order with what its accepted take is (R-9, R-41). A retired
 * chapter's pages are in no book. Shared by readiness, review and export, so the three never
 * disagree about which pages are done.
 */
export function comicBook(production: {
  chapters: ReadonlyArray<{ id: string; order: number; retired?: boolean | undefined }>;
  comic?: ComicSettings | null | undefined;
  comicScripts?: ReadonlyArray<{ chapter: string; script: ComicScript }> | undefined;
  comicPages?: ReadonlyArray<{ page: string; record: ComicPageRecord }> | undefined;
}): ComicBookPage[] {
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const order = new Map(production.chapters.filter((chapter) => !chapter.retired).map((chapter) => [chapter.id, chapter.order]));
  const records = new Map((production.comicPages ?? []).map((entry) => [entry.page, entry.record]));
  const pages: ComicBookPage[] = [];
  for (const entry of [...(production.comicScripts ?? [])].filter((candidate) => order.has(candidate.chapter)).sort((a, b) => order.get(a.chapter)! - order.get(b.chapter)!)) {
    for (const page of entry.script.pages) {
      const record = records.get(page.id);
      const accepted = record?.accepted[settings.language];
      const take = accepted === undefined ? undefined : record!.takes.find((candidate) => candidate.id === accepted);
      const blocking = take ? takeBlocking(take) : [];
      const passed = take !== undefined && takeClears(take);
      // An override clears only the findings it names: one made before a re-check that found more
      // covers nothing new (codex on PR 2225).
      const covered = take?.override !== undefined && blocking.every((id) => take.override!.findings.includes(id));
      pages.push({
        id: page.id, chapter: entry.chapter, number: pages.length + 1, page,
        ...(take ? { take } : {}),
        outOfDate: take !== undefined && take.hash !== comicPageHash(page, settings, take.mode),
        cleared: take !== undefined && (passed || covered),
        overridden: take !== undefined && !passed && covered,
      });
    }
  }
  return pages;
}

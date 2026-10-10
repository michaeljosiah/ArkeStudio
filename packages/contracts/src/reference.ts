import { CharacterVoiceSampleSchema } from "./voice-sample.js";
import { z } from "zod";
import { IsoDateTimeSchema, JobIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";
import type { AudiobookLook, LookLibrary } from "./audiobook-look.js";

/**
 * Reference kits and model sheets (SPEC-010; master spec §6). `references/<sheet>/kit.json` is
 * the tile inventory. Identity is established once — the anchor — then propagated by reference
 * (D1): only locked tiles are references (D3), regeneration supersedes rather than overwrites
 * (D11), and tiles are unversioned but carry the sheet version they were made against, which
 * is what makes "14 reference images predate v5" computable.
 */

export const ReferenceAngleSchema = z.enum([
  "head-front",
  "head-left-three-quarter",
  "head-right-three-quarter",
  "head-profile",
  "body-full",
  "body-back",
  "detail",
  "expression",
]);
export type ReferenceAngle = z.infer<typeof ReferenceAngleSchema>;

/** The head turnaround that gates body work (R-7, D4). */
export const HEAD_ANGLES: ReferenceAngle[] = [
  "head-front",
  "head-left-three-quarter",
  "head-right-three-quarter",
  "head-profile",
];
export const BODY_ANGLES: ReferenceAngle[] = ["body-full", "body-back"];

/**
 * Tile states (R-2): empty is an unfilled slot; pending/rendering are queue states; generated
 * means a take arrived unreviewed; locked means accepted into the reference set; superseded
 * means a newer tile took the slot — the row stays, because takes made against it must remain
 * explicable (D11).
 */
export const ReferenceTileStatusSchema = z.enum([
  "empty",
  "pending",
  "rendering",
  "generated",
  "locked",
  "superseded",
]);
export type ReferenceTileStatus = z.infer<typeof ReferenceTileStatusSchema>;

export const ReferenceTileSchema = z
  .object({
    angle: ReferenceAngleSchema,
    /** Open-ended poses/expressions may name themselves; turnaround slots omit this. */
    name: z.string().optional(),
    status: ReferenceTileStatusSchema,
    /** Filename within the kit directory; absent while the slot is empty/pending. */
    file: z.string().optional(),
    /** The take that produced the tile, when generated rather than uploaded. */
    sourceTakeId: TakeIdSchema.optional(),
    /** The sheet version the tile was made against (R-2). */
    sheetVersion: z.number().int().min(1).optional(),
  })
  .strict();
export type ReferenceTile = z.infer<typeof ReferenceTileSchema>;

export const CompilationFormatSchema = z.enum([
  "classic-grid",
  "pitch-board",
  "expression-board",
  "character-sheet",
  /** A location's accepted views, stacked and labelled — assembled locally, never generated. */
  "location-sheet",
]);
export type CompilationFormat = z.infer<typeof CompilationFormatSchema>;

/** A compiled model sheet (R-9): records the sheet version and exact tile set (R-12). */
export const CompilationSchema = z
  .object({
    /** Filename within the kit directory; doubles as the compilation's identity. */
    file: z.string().min(1),
    format: CompilationFormatSchema,
    sheetVersion: z.number().int().min(1),
    /** The exact tile files compiled in, in layout order (R-12). */
    tiles: z.array(z.string()),
    compiledAt: IsoDateTimeSchema,
    /** "local" for the deterministic grid (R-10); the producing take for generated formats. */
    source: z.union([z.literal("local"), TakeIdSchema, JobIdSchema]),
    /** Generated formats land only on acceptance (R-11); the local grid is born accepted. */
    accepted: z.boolean(),
    /** Direct sheets record the main photo that conditioned the generation (SPEC-017 R-15). */
    anchorFile: z.string().min(1).optional(),
    artDirectionVersion: z.number().int().min(1).optional(),
  })
  .strict();
export type Compilation = z.infer<typeof CompilationSchema>;

export const MainPhotoSchema = z
  .object({
    file: z.string().min(1),
    source: z.enum(["generated", "upload", "promotion", "legacy"]),
    sourceJobId: JobIdSchema.optional(),
    sourceTakeId: TakeIdSchema.optional(),
    sheetVersion: z.number().int().min(1).optional(),
    artDirectionVersion: z.number().int().min(1).optional(),
    acceptedAt: IsoDateTimeSchema.optional(),
  })
  .strict();
export type MainPhoto = z.infer<typeof MainPhotoSchema>;

export const CharacterLookSchema = z
  .object({
    id: z.string().min(1),
    file: z.string().min(1),
    // "view" is a place's look — a plate chosen for a scene rides the way a costume does (SPEC-044 §2.1).
    kind: z.enum(["costume", "pose-expression", "condition-age", "view"]),
    prompt: z.string().min(1),
    /** An author's label, never part of generation or reference identity (turn 207). */
    name: z.string().trim().min(1).max(60).optional(),
    sourceJobId: JobIdSchema.optional(),
    sourceTakeId: TakeIdSchema.optional(),
    artDirectionVersion: z.number().int().min(1).optional(),
    acceptedAt: IsoDateTimeSchema,
    attachedTo: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("production"), productionId: SlugSchema }).strict(),
        z.object({ kind: z.literal("scene"), productionId: SlugSchema, sceneId: z.string().min(1) }).strict(),
      ])
      .optional(),
    /**
     * A look made for a chapter's pictures (design turn 193, SPEC-047 R-112): `full-body` is a
     * full-length image in the clothing its `prompt` says, `portrait` the head and shoulders. Absent
     * on every look made before it, which are read as they were.
     */
    framing: z.enum(["full-body", "portrait"]).optional(),
    /** The main photo (file within the kit directory) the look was made from, so a later photo marks it `older face` (R-113). */
    mainFile: z.string().min(1).optional(),
    /**
     * The look's close view (R-118): a head-and-shoulders image of the same person in the same
     * clothes, made with it, for the frames that show faces. A file within the kit directory,
     * like `file`; `closeTakeId` the take that made it.
     */
    closeFile: z.string().min(1).optional(),
    closeTakeId: TakeIdSchema.optional(),
  })
  .strict();
export type CharacterLook = z.infer<typeof CharacterLookSchema>;

/**
 * Whether a look was made from a face the character no longer has (R-113): replacing the main
 * photo marks the looks made from the old one `older face`. A look made before looks recorded
 * their photo is never marked; it still rides until the author makes it again.
 */
export function lookOlderFace(kit: Pick<ReferenceKit, "mainPhoto" | "anchor" | "tiles" | "sheetId">, look: Pick<CharacterLook, "mainFile">): boolean {
  if (look.mainFile === undefined) return false;
  const photo = mainPhotoFor({ ...kit, compilations: [] });
  return photo !== null && photo.file !== look.mainFile;
}

/**
 * The looks a chapter may choose for a character (R-112): every kit look of kind costume, newest
 * first — those made for chapters and those a Cast page made before them, which have no framing
 * and are taken as the image they are. Whether a look is attached to a production or a scene
 * is no matter here: a chapter chooses by pointer and attaches nothing (R-18 holds).
 */
export function chapterLooksOf(kit: Pick<ReferenceKit, "looks"> | null | undefined): CharacterLook[] {
  return [...(kit?.looks ?? [])]
    .filter((look) => look.kind === "costume")
    .sort((a, b) => (a.acceptedAt < b.acceptedAt ? 1 : a.acceptedAt > b.acceptedAt ? -1 : 0));
}

/** Longest clothing line a look gives a chapter: the chapter look's own bound (`LOOK_LINE_MAX`). */
const LOOK_CLOTHING_MAX = 400;
/** A sentence of a Cast page's exploration prompt that tells the image model how to draw, not what is worn. */
const DIRECTIVE = /\b(references?|backdrop|studio|in frame|full[- ]length|full body|head to (?:toe|shoes)|looking at the camera|soft light|overriding|identity|proportions)\b/i;

/**
 * The clothing line of a look (design turn 193, SPEC-047 R-112): the words a chapter's pictures take
 * for the person wearing it. A look made for a chapter (it has a `framing`) was made from exactly
 * this line, so it is its prompt. A look the Cast page made holds the exploration prompt it was
 * made from — on Na Love or Juju, `OUTFIT FOR THIS LOOK, overriding any clothing…` then the backdrop,
 * then the clothes — and the instructions to the image model must not become a person's clothes in
 * every picture. So the sentences that say what someone wears are kept and the drawing directions
 * dropped; a prompt with no such sentence keeps every sentence that is not a direction.
 */
export function lookClothing(look: Pick<CharacterLook, "prompt" | "framing">): string {
  const whole = look.prompt.replace(/\s+/g, " ").trim();
  if (look.framing !== undefined) return clipWords(whole, LOOK_CLOTHING_MAX);
  const sentences = whole.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "");
  const shouted = (sentence: string): boolean => /^[A-Z][A-Z ,'-]{8,}\b/.test(sentence);
  const negative = (sentence: string): boolean => /^no\s/i.test(sentence);
  const plain = sentences.filter((sentence) => !shouted(sentence) && !negative(sentence) && !DIRECTIVE.test(sentence));
  const worn = plain.filter((sentence) => /\bwears?\b|\bwearing\b|\bdressed\b/i.test(sentence));
  const kept = worn.length > 0 ? worn : plain;
  return clipWords(kept.length > 0 ? kept.join(" ") : whole, LOOK_CLOTHING_MAX);
}

/**
 * The kit looks as a picture's look lines read them for a look chosen for one picture alone
 * (R-115, R-146): the person's kit — by the sheet the chapter's look names for them, else by their
 * key, which is the sheet's id — and that costume look's clothing line. The coordinator stamps a
 * picture with it and the card judges `look changed` with it, so the two agree.
 */
export function kitLookLibrary(kits: ReadonlyArray<Pick<ReferenceKit, "sheetId" | "looks">>, look: Pick<AudiobookLook, "characters"> | null | undefined): LookLibrary {
  return (key, lookId) => {
    const sheet = look?.characters[key]?.sheet ?? key;
    const found = kits.find((kit) => kit.sheetId === sheet)?.looks?.find((candidate) => candidate.id === lookId && candidate.kind === "costume");
    return found === undefined ? undefined : { text: lookClothing(found) };
  };
}

/** Hair-first prompts are not outfit names. Legacy looks use their saved date, never guessed clothing. */
export function lookName(look: Pick<CharacterLook, "prompt" | "framing"> & Partial<Pick<CharacterLook, "name" | "acceptedAt" | "id">>, siblings: readonly CharacterLook[] = []): string {
  if (look.name?.trim()) return look.name.trim();
  const formatter = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const date = (at: string | undefined) => at === undefined || !Number.isFinite(Date.parse(at)) ? null : formatter.format(new Date(at));
  const when = date(look.acceptedAt);
  const label = when === null ? "Look" : `Look · ${when}`;
  const collision = siblings.some((other) => other.id !== look.id && !other.name && date(other.acceptedAt) === when);
  return collision && look.id !== undefined ? `${label} · ${look.id.slice(-6)}` : label;
}

// ---------------------------------------------------------------------------
// Clothing named neutrally (2026-10-04, after 0.5.60-local.14)
// ---------------------------------------------------------------------------

/** A body part a line can say is bare. */
const BARE_PART = "(?:shoulders?|back|arms?|legs?|skin|neck|midriff|stomach|chest|thighs?|collarbones?|décolletage)";
/** Words for how much a garment shows, its cut, or the body under it: never in a picture's words once the look image rides. */
const CUT_WORDS = [
  "low[- ]backed", "open[- ]backed", "backless", "strapless", "off[- ]the[- ]shoulder", "one[- ]shoulder(?:ed)?", "spaghetti[- ]strap(?:ped|s)?",
  "halter[- ]?neck(?:ed)?", "plunging (?:neckline|v|back)", "low[- ]cut", "deep[- ]cut", "deep[- ]v", "low[- ]necked", "sweetheart neckline",
  // Only words that say how a garment shows the body: "sheer" before a cloth, never a sheer drop;
  // "revealing" or "sultry" before a garment, never the box revealing the map or a sultry voice
  // (codex on PR 1559): the prompt's action and expressions are not clothing.
  `(?:sheer|revealing|sultry|seductive)(?= (?:silk|satin|chiffon|fabric|lace|mesh|organza|tulle|${"dress|gown|blouse|top|robe|slip|outfit|neckline|costume|skirt|bodice"}))`,
  "see[- ]through", "skin[- ]tight", "figure[- ]hugging", "body[- ]hugging", "curve[- ]hugging", "form[- ]fitting", "body[- ]?con", "tight[- ]fitting", "sexy", "racy", "skimpy",
  // The garment's cut-outs, never the verb: "they cut out the lights" is an action (codex on PR 1559).
  "cut-?outs?",
];
/** A phrase that is only about skin or the body: bare shoulders, a slit to the thigh, the back beneath her braids. */
const EXPOSURE_PHRASES = [
  `(?:with |and |showing |leaving |baring |revealing |her |his |their |its )*(?:bare|exposed|naked) ${BARE_PART}`,
  `${BARE_PART} (?:left )?(?:bare|exposed)`,
  "(?:with )?(?:a )?(?:thigh[- ]high|high|side|deep|leg) slit(?: to the (?:thigh|hip))?",
  "slit to the (?:thigh|hip)",
  "(?:showing|revealing|baring) (?:off )?(?:her |his |their )?(?:skin|cleavage|figure|curves|legs|body)",
  "cleavage", "décolletage", "voluptuous",
  "(?:bare |exposed )?(?:beneath|under|below) (?:her|his|their) braids",
];
const CUT = new RegExp(`\\b(?:${CUT_WORDS.join("|")})\\b[ ,]*`, "gi");
const EXPOSURE = new RegExp(`(?:^|\\s|,)(?:${EXPOSURE_PHRASES.join("|")})(?=$|[\\s,;.)])`, "gi");
const SHOWS = new RegExp(`\\b(?:${[...CUT_WORDS, ...EXPOSURE_PHRASES].join("|")})(?=$|[\\s,;.)])`, "i");
/** Words that say nothing on their own once the skin and the cut are out of a clause. */
const EMPTY_WORDS = new Set(["her", "his", "their", "its", "a", "an", "the", "and", "with", "in", "on", "of", "to", "at", "by", "is", "are", "was", "left", "showing", "bare", "beneath", "under", "below", "she", "he", "they"]);

/**
 * Whether a clause still says something once the skin and the cut are taken out: anything worn,
 * carried, done or seen (`bare arms in elbow-length white gloves` keeps the gloves, `bare
 * shoulders catching the light` keeps the light), and not only a pronoun left over (`her back bare
 * beneath her braids` goes whole). Codex on PR 1559: a list of garments dropped what it did not name.
 */
function saysSomething(clause: string): boolean {
  return (clause.toLowerCase().match(/[\p{L}][\p{L}'-]*/gu) ?? []).filter((word) => !EMPTY_WORDS.has(word)).length > 0;
}

/** The clauses of a line: split on commas and semicolons outside brackets, each with the separator after it. */
function clauses(text: string): Array<{ words: string; after: string }> {
  const out: Array<{ words: string; after: string }> = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === "," || char === ";")) {
      out.push({ words: text.slice(start, index), after: char });
      start = index + 1;
    }
  }
  out.push({ words: text.slice(start), after: "" });
  return out;
}

/**
 * Clothing named neutrally (2026-10-04): the garment and its colour — `her cream-gold silk evening
 * dress` — never how much skin it shows, its cut, or the body under it. On Na Love or Juju the
 * pictures of Ife at the club table and her close view were refused by the image provider's safety
 * check: their words repeated `bare shoulders`, `low-backed silk slip dress` and `beneath her
 * braids` while her full-body look image, the same dress, rode as the reference. The look image
 * carries the clothes; the words only have to name them. A clause that is only about skin goes; a
 * clause that names a garment keeps the garment and loses the cut. A slip dress is named an evening
 * dress, which is what it is in a picture.
 */
export function neutralClothing(text: string): string {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const kept = sentences.map((sentence) => {
    const parts = clauses(sentence).flatMap(({ words, after }) => {
      if (!SHOWS.test(words)) return [{ words, after }];
      const cleaned = words.replace(EXPOSURE, " ").replace(CUT, "").replace(/\s+(?:with|and)\s*$/i, "").replace(/\s{2,}/g, " ");
      // A clause with nothing left once the skin is out was only about the body: it goes, its separator with it.
      return saysSomething(cleaned) ? [{ words: cleaned, after }] : [];
    });
    let joined = parts.map((part, index) => `${part.words}${index < parts.length - 1 ? part.after : ""}`).join("");
    // A sentence whose last clause went keeps its full stop.
    const stop = /[.!?]$/.test(sentence.trim()) && !/[.!?]$/.test(joined.trim()) ? sentence.trim().slice(-1) : "";
    joined = `${joined.trim().replace(/[,;]\s*$/, "")}${stop}`;
    return joined;
  });
  return kept
    .filter((sentence) => sentence.replace(/[.!?\s]/g, "") !== "")
    .join(" ")
    .replace(/\bslip[- ]dress\b/gi, "evening dress")
    .replace(/\b([Aa]) evening\b/g, "$1n evening")
    .replace(/\s+([,;.])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Whether a line says how much a garment shows, its cut, or names bare skin. */
export function namesExposure(text: string): boolean {
  return SHOWS.test(text);
}

function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/**
 * One accepted angle on a place (#243, design turn 57).
 *
 * A character is established by a face; a place is established by geometry, and geometry needs
 * more than one angle before a model stops inventing the half of the room it was not shown.
 * Each view is an accepted immutable take, exactly like a main photo — `file` points into
 * `takes/<takeId>/`, never at a loose file somebody could replace underneath it.
 *
 * Superseded rather than deleted: a take made against an older view has to stay explicable
 * (the same reasoning as D11 for tiles).
 */
export const LocationViewSchema = z
  .object({
    id: z.string().min(1),
    /** What this angle is called — "Establishing view", "Reverse angle", "Day". */
    name: z.string().trim().min(1).max(80),
    /** Relative to `references/<sheetId>/`. */
    file: z.string().min(1),
    sourceTakeId: TakeIdSchema,
    sheetVersion: z.number().int().min(1),
    artDirectionVersion: z.number().int().min(1),
    acceptedAt: IsoDateTimeSchema,
    /**
     * When this view's *panel slot* was opened, which is not always when the view was accepted.
     *
     * A replacement inherits the slot of the view it supersedes, because design turn 57 settles
     * that replacing a view "leaves the panel order unchanged" — and it has to: a prompt that
     * already cited panel 2 is wrong the moment panel 2 silently becomes something else.
     * Ordering on `acceptedAt` alone pushed every replacement to the end of the sheet.
     *
     * Optional so a kit written before this existed still reads; those fall back to `acceptedAt`,
     * which is what they were ordered by anyway.
     */
    slotAt: IsoDateTimeSchema.optional(),
    status: z.enum(["active", "superseded"]).default("active"),
  })
  .strict();
export type LocationView = z.infer<typeof LocationViewSchema>;

/** The instant a view's panel slot was opened — its own, or the acceptance that stood in for it. */
export function locationViewSlotAt(view: LocationView): string {
  return view.slotAt ?? view.acceptedAt;
}

/** Past this a sheet stops reading as one room (design turn 57). */
export const MAX_ACTIVE_LOCATION_VIEWS = 6;

/** Two names are the same name if they differ only by case or spacing. */
export function normalizeViewName(name: string): string {
  // toLowerCase, not toLocaleLowerCase: this invariant is shared between the coordinator and the
  // renderer, and under a Turkish default locale those two processes disagree about whether "I"
  // and "i" are the same name — so a kit would validate in one and be refused by the other.
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export const ReferenceKitSchema = z
  .object({
    sheetId: SlugSchema,
    /**
     * The anchor: the accepted first look, the reference every later generation carries (R-5,
     * D2). By convention the locked head-front tile's file.
     */
    anchor: z.string().optional(),
    /** SPEC-017 identity anchor. `anchor` remains for existing six-tile kits. */
    mainPhoto: MainPhotoSchema.optional(),
    tiles: z.array(ReferenceTileSchema),
    compilations: z.array(CompilationSchema).default([]),
    /** Exactly one compilation rides along with dispatches (R-13, D8); file reference. */
    designatedCompilation: z.string().optional(),
    /** Per-sheet rendering-style override; travels with this sheet only (R-16, D12). */
    styleOverride: z.string().optional(),
    /** Optional exploration; never dispatches unless attached to a production or scene. */
    looks: z.array(CharacterLookSchema).optional(),
    /**
     * The one audio asset that represents this character's voice (SPEC-019 R-45, D31).
     *
     * SPEC-011 assigns a provider voice *identity* to the sheet (R-11) and produces a voice take
     * per dialogue line (R-16); neither is a canonical sample to transmit. So one is nominated,
     * exactly as a model sheet's designated compilation is nominated among many. A character
     * with none carries no audio reference, and the absence is stated rather than resolved by
     * picking a take at random.
     */
    designatedVoiceSample: z.union([CharacterVoiceSampleSchema, z
      .object({
        file: z.string().min(1),
        source: z.enum(["cloning-recording", "voice-take"]),
        sourceTakeId: TakeIdSchema.optional(),
        designatedAt: IsoDateTimeSchema,
      })
      .strict()]).optional(),
    /**
     * A location's accepted angles (#243). Optional so every character kit written before this
     * existed round-trips unchanged, and so opening an old world rewrites nothing.
     */
    locationViews: z.array(LocationViewSchema).optional(),
    /** Which view is the establishing one — the anchor later views are generated against. */
    establishingViewId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((kit, ctx) => {
    // Invariants that a strict object cannot state on its own. Checked here rather than only at
    // the mutation boundary because kit.json is hand-editable: a world someone edited into an
    // impossible shape should be refused at the door, not discovered at dispatch.
    const views = kit.locationViews ?? [];
    if (views.length === 0) {
      if (kit.establishingViewId !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["establishingViewId"], message: "no location views to establish" });
      }
      return;
    }
    const active = views.filter((view) => view.status === "active");
    if (active.length > MAX_ACTIVE_LOCATION_VIEWS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["locationViews"],
        message: `at most ${MAX_ACTIVE_LOCATION_VIEWS} active location views`,
      });
    }
    if (active.length > 0 && kit.establishingViewId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["establishingViewId"], message: "active views need an establishing view" });
    }
    if (kit.establishingViewId !== undefined) {
      const matches = active.filter((view) => view.id === kit.establishingViewId);
      if (matches.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["establishingViewId"],
          message: "establishingViewId must resolve to exactly one active view",
        });
      }
    }
    const seen = new Set<string>();
    for (const view of active) {
      const key = normalizeViewName(view.name);
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["locationViews"], message: `duplicate active view name: ${view.name}` });
      }
      seen.add(key);
    }
    const ids = new Set<string>();
    for (const view of views) {
      if (ids.has(view.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["locationViews"], message: `duplicate view id: ${view.id}` });
      }
      ids.add(view.id);
    }
  });
export type ReferenceKit = z.infer<typeof ReferenceKitSchema>;

/**
 * The views a location sheet is built from, in panel order: the establishing view first, then
 * acceptance order (design turn 57's binding rule). Never alphabetical and never generation
 * order — a panel map that reordered itself would make every prompt citing "panel 2" wrong.
 */
export function orderedLocationViews(kit: ReferenceKit): LocationView[] {
  const active = (kit.locationViews ?? []).filter((view) => view.status === "active");
  const establishing = active.find((view) => view.id === kit.establishingViewId);
  const rest = active
    .filter((view) => view.id !== kit.establishingViewId)
    .sort((a, b) => {
      // Parsed, not compared as strings: IsoDateTimeSchema accepts an offset, and
      // "2026-08-10T09:00:00+02:00" is earlier than "2026-08-10T08:00:00Z" while sorting after
      // it. A panel map in the wrong order is a prompt citing the wrong side of the room.
      const gap = Date.parse(locationViewSlotAt(a)) - Date.parse(locationViewSlotAt(b));
      return gap === 0 ? a.id.localeCompare(b.id) : gap;
    });
  return establishing ? [establishing, ...rest] : rest;
}

// ---------------------------------------------------------------------------
// Pure judgements the coordinator and the client share
// ---------------------------------------------------------------------------

/** Tiles admitted to the reference set (R-3, D3): locked, nothing else. */
export function lockedTiles(kit: ReferenceKit): ReferenceTile[] {
  return kit.tiles.filter((t) => t.status === "locked" && t.file !== undefined);
}

/** The head-before-body gate (R-7, D4, D5): names what is outstanding, never just "no". */
export function headGate(kit: ReferenceKit): { ready: boolean; outstanding: ReferenceAngle[] } {
  const locked = new Set(kit.tiles.filter((t) => t.status === "locked").map((t) => t.angle));
  const outstanding = HEAD_ANGLES.filter((a) => !locked.has(a));
  return { ready: outstanding.length === 0, outstanding };
}

/** A tile is stale when the sheet advanced past the version it was made against (R-17, §2.8). */
export function tileIsStale(tile: ReferenceTile, sheetVersion: number): boolean {
  if (tile.status !== "locked" && tile.status !== "generated") return false;
  return tile.sheetVersion !== undefined && tile.sheetVersion < sheetVersion;
}

/** A compilation is stale when the sheet advanced or the locked set no longer matches (§2.8). */
export function compilationIsStale(
  kit: ReferenceKit,
  compilation: Compilation,
  sheetVersion: number,
): boolean {
  if (compilation.sheetVersion < sheetVersion) return true;
  if (compilation.format === "character-sheet") {
    // No anchor claimed, nothing to contradict: an uploaded sheet was drawn somewhere else, by
    // someone who never saw the main photo, so a later main photo cannot make it out of date.
    // Only generation records an anchor here, and it always records one — so this stays a
    // statement about uploads rather than a hole in the generated path's staleness.
    if (compilation.anchorFile === undefined) return false;
    const photo = mainPhotoFor(kit);
    return photo === null || compilation.anchorFile !== photo.file;
  }
  if (compilation.format === "location-sheet") {
    // A location kit has no locked tiles at all, so falling through to the grid comparison below
    // reported every location sheet stale — a permanent warning on the dispatch dialog that no
    // rebuild could clear. Its tiles are view files in panel order, and order is content here:
    // the same set stacked differently is a different sheet.
    return orderedLocationViews(kit)
      .map((view) => view.file)
      .join("\n") !== compilation.tiles.join("\n");
  }
  const lockedNow = lockedTiles(kit)
    .map((t) => t.file!)
    .sort();
  const compiledFrom = [...compilation.tiles].sort();
  return lockedNow.join("\n") !== compiledFrom.join("\n");
}

/** Accepted identity anchor, with a synthesized record for existing six-tile kits (R-24). */
export function mainPhotoFor(kit: ReferenceKit): MainPhoto | null {
  if (kit.mainPhoto) return kit.mainPhoto;
  if (!kit.anchor) return null;
  const tile = kit.tiles.find((candidate) => candidate.file === kit.anchor && candidate.status === "locked");
  return {
    file: kit.anchor,
    source: "legacy",
    ...(tile?.sheetVersion ? { sheetVersion: tile.sheetVersion } : {}),
  };
}

export function mainPhotoGate(kit: ReferenceKit | null): { ready: boolean; outstanding: string } {
  return {
    ready: kit !== null && mainPhotoFor(kit) !== null,
    outstanding: "an accepted main photo",
  };
}

export function characterSheetFor(kit: ReferenceKit): Compilation | null {
  return designatedCompilation(kit);
}

/** The one that rides along (R-13, D8): explicit designation, else the newest accepted. */
export function designatedCompilation(kit: ReferenceKit): Compilation | null {
  if (kit.designatedCompilation !== undefined) {
    const explicit = kit.compilations.find((c) => c.file === kit.designatedCompilation && c.accepted);
    if (explicit) return explicit;
  }
  const accepted = kit.compilations.filter((c) => c.accepted);
  if (accepted.length === 0) return null;
  return accepted.reduce((a, b) => (b.compiledAt > a.compiledAt ? b : a));
}


/** The voice sample that would travel with this character, or null (SPEC-019 R-45). */
export function designatedVoiceSample(kit: ReferenceKit | null): { file: string } | null {
  const sample = kit?.designatedVoiceSample;
  return sample ? { file: `references/${kit!.sheetId}/${sample.file}` } : null;
}

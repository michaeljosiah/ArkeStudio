import { z } from "zod";
import { IsoDateTimeSchema, JobIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";

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
    kind: z.enum(["costume", "pose-expression", "condition-age"]),
    prompt: z.string().min(1),
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
  })
  .strict();
export type CharacterLook = z.infer<typeof CharacterLookSchema>;

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
    designatedVoiceSample: z
      .object({
        file: z.string().min(1),
        source: z.enum(["cloning-recording", "voice-take"]),
        sourceTakeId: TakeIdSchema.optional(),
        designatedAt: IsoDateTimeSchema,
      })
      .strict()
      .optional(),
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

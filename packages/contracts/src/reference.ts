import { z } from "zod";
import { IsoDateTimeSchema, SlugSchema, TakeIdSchema } from "./ids.js";

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

export const CompilationFormatSchema = z.enum(["classic-grid", "pitch-board", "expression-board"]);
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
    source: z.union([z.literal("local"), TakeIdSchema]),
    /** Generated formats land only on acceptance (R-11); the local grid is born accepted. */
    accepted: z.boolean(),
  })
  .strict();
export type Compilation = z.infer<typeof CompilationSchema>;

export const ReferenceKitSchema = z
  .object({
    sheetId: SlugSchema,
    /**
     * The anchor: the accepted first look, the reference every later generation carries (R-5,
     * D2). By convention the locked head-front tile's file.
     */
    anchor: z.string().optional(),
    tiles: z.array(ReferenceTileSchema),
    compilations: z.array(CompilationSchema).default([]),
    /** Exactly one compilation rides along with dispatches (R-13, D8); file reference. */
    designatedCompilation: z.string().optional(),
    /** Per-sheet rendering-style override; travels with this sheet only (R-16, D12). */
    styleOverride: z.string().optional(),
  })
  .strict();
export type ReferenceKit = z.infer<typeof ReferenceKitSchema>;

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
export function compilationIsStale(kit: ReferenceKit, compilation: Compilation, sheetVersion: number): boolean {
  if (compilation.sheetVersion < sheetVersion) return true;
  const lockedNow = lockedTiles(kit)
    .map((t) => t.file!)
    .sort();
  const compiledFrom = [...compilation.tiles].sort();
  return lockedNow.join("\n") !== compiledFrom.join("\n");
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

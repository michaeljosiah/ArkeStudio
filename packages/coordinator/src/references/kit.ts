import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compilationIsStale,
  designatedCompilation,
  headGate,
  lockedTiles,
  ReferenceKitSchema,
  type Compilation,
  type ReferenceAngle,
  type ReferenceKit,
  type Sheet,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { sha256 } from "../world/text-files.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { decodePng, drawScaled, encodePng, solidImage, type RgbaImage } from "./png.js";

/**
 * Kit operations (SPEC-010): every mutation goes through the world's one commit primitive, so
 * kits get the same base-hash staleness, journalling and history as every other file. The
 * classic grid compiles locally — no provider, no cost, no ledger entry, byte-deterministic
 * (R-10, D6).
 */

const kitPath = (sheetId: string): string => `references/${sheetId}/kit.json`;

export async function readKit(store: WorldStore, sheetId: string): Promise<{ kit: ReferenceKit; raw: string } | null> {
  try {
    const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(kitPath(sheetId)))), "utf8");
    return { kit: ReferenceKitSchema.parse(JSON.parse(raw)), raw };
  } catch {
    return null;
  }
}

async function writeKit(store: WorldStore, sheetId: string, kit: ReferenceKit, baseRaw: string | null): Promise<void> {
  await store.commit({
    kind: "kit-edit",
    source: "form",
    files: [
      {
        path: kitPath(sheetId),
        action: baseRaw === null ? "create" : "replace",
        content: JSON.stringify(kit, null, 2) + "\n",
        baseHash: baseRaw === null ? null : sha256(baseRaw),
      },
    ],
  });
}

/** A fresh kit with the standard slots (R-1). */
export function emptyKit(sheetId: string): ReferenceKit {
  return {
    sheetId,
    tiles: [
      { angle: "head-front", status: "empty" },
      { angle: "head-left-three-quarter", status: "empty" },
      { angle: "head-right-three-quarter", status: "empty" },
      { angle: "head-profile", status: "empty" },
      { angle: "body-full", status: "empty" },
      { angle: "body-back", status: "empty" },
    ],
    compilations: [],
  };
}

async function loadOrEmpty(store: WorldStore, sheetId: string): Promise<{ kit: ReferenceKit; raw: string | null }> {
  const existing = await readKit(store, sheetId);
  return existing ?? { kit: emptyKit(sheetId), raw: null };
}

/** Lock a generated tile into the reference set (R-3, D3). */
export async function lockTile(store: WorldStore, sheetId: string, angle: ReferenceAngle, name?: string): Promise<void> {
  const { kit, raw } = await loadOrEmpty(store, sheetId);
  const tile = kit.tiles.find(
    (t) => t.angle === angle && (name === undefined || t.name === name) && t.status === "generated",
  );
  if (!tile) throw new Error(`no generated ${angle} tile to lock`);
  tile.status = "locked";
  const next: ReferenceKit = {
    ...kit,
    // The first locked head-front becomes the anchor if none exists (D2).
    ...(kit.anchor === undefined && angle === "head-front" && tile.file !== undefined ? { anchor: tile.file } : {}),
  };
  await writeKit(store, sheetId, next, raw);
}

/**
 * A regenerated tile arrived (R-4, D11): the accepted newcomer supersedes the old row — which
 * stays, because takes made against it must remain explicable.
 */
export async function supersedeTile(
  store: WorldStore,
  sheetId: string,
  angle: ReferenceAngle,
  incoming: { file: string; takeId?: string; sheetVersion: number; lock?: boolean },
): Promise<void> {
  const { kit, raw } = await loadOrEmpty(store, sheetId);
  for (const tile of kit.tiles) {
    if (tile.angle === angle && (tile.status === "locked" || tile.status === "generated")) {
      tile.status = "superseded";
    }
  }
  kit.tiles.push({
    angle,
    status: incoming.lock ? "locked" : "generated",
    file: incoming.file,
    sheetVersion: incoming.sheetVersion,
    ...(incoming.takeId !== undefined ? { sourceTakeId: incoming.takeId as ReferenceKit["tiles"][number]["sourceTakeId"] } : {}),
  });
  const next: ReferenceKit = {
    ...kit,
    ...(kit.anchor !== undefined && angle === "head-front" && incoming.lock ? { anchor: incoming.file } : {}),
  };
  await writeKit(store, sheetId, next, raw);
}

/** The anchor chosen from establish candidates (R-5, D2): head-front, locked, the face. */
export async function chooseAnchor(
  store: WorldStore,
  sheetId: string,
  input: { file: string; takeId?: string; sheetVersion: number },
): Promise<void> {
  const { kit, raw } = await loadOrEmpty(store, sheetId);
  for (const tile of kit.tiles) {
    if (tile.angle === "head-front" && (tile.status === "locked" || tile.status === "generated")) {
      tile.status = "superseded";
    }
  }
  kit.tiles.push({
    angle: "head-front",
    status: "locked",
    file: input.file,
    sheetVersion: input.sheetVersion,
    ...(input.takeId !== undefined ? { sourceTakeId: input.takeId as ReferenceKit["tiles"][number]["sourceTakeId"] } : {}),
  });
  // The most consequential accept in the product: everything downstream inherits this face.
  await writeKit(store, sheetId, { ...kit, anchor: input.file }, raw);
}

export async function setStyleOverride(store: WorldStore, sheetId: string, style: string | null): Promise<void> {
  const { kit, raw } = await loadOrEmpty(store, sheetId);
  const next = { ...kit };
  if (style === null) delete next.styleOverride;
  else next.styleOverride = style;
  await writeKit(store, sheetId, next, raw);
}

/** Designate the compilation that rides along (R-13, D8). */
export async function designate(store: WorldStore, sheetId: string, file: string): Promise<void> {
  const { kit, raw } = await loadOrEmpty(store, sheetId);
  if (!kit.compilations.some((c) => c.file === file && c.accepted)) {
    throw new Error(`no accepted compilation "${file}" to designate`);
  }
  await writeKit(store, sheetId, { ...kit, designatedCompilation: file }, raw);
}

// ---------------------------------------------------------------------------
// The classic grid (R-10, D6, D7): local, free, deterministic, fixed template
// ---------------------------------------------------------------------------

/** Fixed template: 4 columns × 3 rows (head / body / poses), gaps stay gaps (D7). */
const CELL = 320;
const GAP = 12;
const COLS = 4;
const ROWS = 3;

const ROW_ANGLES: ReferenceAngle[][] = [
  ["head-front", "head-left-three-quarter", "head-right-three-quarter", "head-profile"],
  ["body-full", "body-back", "detail", "detail"],
  ["expression", "expression", "expression", "expression"],
];

export interface GridResult {
  compilation: Compilation;
  png: Uint8Array;
}

/**
 * Compile the classic grid from locked tiles alone (R-3): same tiles in, identical bytes out
 * (R-10). No provider is called and no ledger entry is written — this function cannot spend.
 */
export async function compileGrid(store: WorldStore, sheet: Sheet, clock: () => string): Promise<GridResult> {
  const loaded = await loadOrEmpty(store, sheet.id);
  const kit = loaded.kit;
  const locked = lockedTiles(kit);
  if (locked.length === 0) throw new Error("no locked tiles to compile — establish a look first");

  const width = COLS * CELL + (COLS + 1) * GAP;
  const height = ROWS * CELL + (ROWS + 1) * GAP;
  const canvas: RgbaImage = solidImage(width, height, [24, 24, 26, 255]);

  // Deterministic placement: fixed template rows; open-ended tiles fill their row's slots in
  // kit order; a slot with no tile stays a gap (D7).
  const used = new Set<string>();
  const placedFiles: string[] = [];
  for (let row = 0; row < ROWS; row++) {
    let col = 0;
    for (const angle of ROW_ANGLES[row]!) {
      if (col >= COLS) break;
      const tile = locked.find((t) => t.angle === angle && !used.has(t.file!));
      const x = GAP + col * (CELL + GAP);
      const y = GAP + row * (CELL + GAP);
      if (tile) {
        used.add(tile.file!);
        const bytes = await readFile(toExtendedLength(join(store.dir, "references", sheet.id, tile.file!)));
        const image = decodePng(Uint8Array.from(bytes));
        drawScaled(canvas, image, x, y, CELL, CELL);
        placedFiles.push(tile.file!);
      }
      col += 1;
    }
  }

  const png = encodePng(canvas);
  const file = `model-sheet-v${sheet.version}-grid.png`;
  const compilation: Compilation = {
    file,
    format: "classic-grid",
    sheetVersion: sheet.version,
    tiles: locked.map((t) => t.file!),
    compiledAt: clock(),
    source: "local",
    accepted: true, // born accepted: it is a composite, not a generation (R-10)
  };
  return { compilation, png };
}

/**
 * Land a grid: the PNG writes atomically inside the store's suppression envelope (our own
 * write must never read as an external edit), and kit.json records it in the same op.
 */
export async function landGrid(store: WorldStore, sheet: Sheet, result: GridResult): Promise<void> {
  await store.gateOp(async () => {
    const loaded = await loadOrEmpty(store, sheet.id);
    const kit = loaded.kit;
    const others = kit.compilations.filter((c) => c.file !== result.compilation.file);
    const previouslyPinnedToGrid =
      kit.designatedCompilation === undefined ||
      kit.compilations.some((c) => c.file === kit.designatedCompilation && c.format === "classic-grid");
    const next: ReferenceKit = {
      ...kit,
      compilations: [...others, result.compilation],
      // The newest grid becomes designated unless the user pinned a non-grid explicitly (R-13).
      ...(previouslyPinnedToGrid ? { designatedCompilation: result.compilation.file } : {}),
    };
    await atomicWriteFile(join(store.dir, "references", sheet.id, result.compilation.file), result.png);
    await store.commitUnserialised({
      kind: "kit-compile",
      source: "form",
      files: [
        {
          path: kitPath(sheet.id),
          action: loaded.raw === null ? "create" : "replace",
          content: JSON.stringify(next, null, 2) + "\n",
          baseHash: loaded.raw === null ? null : sha256(loaded.raw),
        },
      ],
    });
  });
}

// ---------------------------------------------------------------------------
// Attachment (R-14): what a dispatch citing this sheet actually carries
// ---------------------------------------------------------------------------

export interface AttachmentDecision {
  sheetId: string;
  /** World-relative file to attach, or null when nothing rides. */
  file: string | null;
  /** "sketch-citation" when no compilation exists (R-14). */
  mode: "designated" | "sketch-citation";
  /** Named gap when the designation predates the sheet (D10), e.g. "model sheet is v4; sheet is at v5". */
  staleGap: string | null;
}

/** Resolve what rides along for one sheet — every dispatch path calls this one function (D8). */
export function attachmentFor(kit: ReferenceKit | null, sheet: Sheet): AttachmentDecision {
  const designated = kit ? designatedCompilation(kit) : null;
  if (!kit || !designated) {
    return { sheetId: sheet.id, file: null, mode: "sketch-citation", staleGap: null };
  }
  const stale = compilationIsStale(kit, designated, sheet.version);
  return {
    sheetId: sheet.id,
    file: `references/${sheet.id}/${designated.file}`,
    mode: "designated",
    // Attached anyway, gap named, recompiling offered (D10) — never silently dropped.
    staleGap: stale ? `model sheet is v${designated.sheetVersion}; ${sheet.name} is at v${sheet.version}` : null,
  };
}

/** The head-before-body report (R-7, D5) plus batch-missing summary (R-18), for the surface. */
export function kitReport(kit: ReferenceKit | null): {
  gate: { ready: boolean; outstanding: ReferenceAngle[] };
  missing: ReferenceAngle[];
} {
  const effective = kit ?? emptyKit("placeholder");
  const gate = headGate(effective);
  const filled = new Set(
    effective.tiles.filter((t) => t.status === "locked" || t.status === "generated").map((t) => t.angle),
  );
  const missing = ([...new Set(effective.tiles.map((t) => t.angle))] as ReferenceAngle[]).filter((a) => !filled.has(a));
  return { gate, missing };
}

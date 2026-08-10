import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  headGate,
  lockedTiles,
  MAX_ACTIVE_LOCATION_VIEWS,
  locationViewSlotAt,
  normalizeViewName,
  orderedLocationViews,
  ReferenceKitSchema,
  type Job,
  type Compilation,
  type LocationView,
  type ReferenceAngle,
  type ReferenceKit,
  type ReviewDecision,
  type Sheet,
  type Take,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { sha256 } from "../world/text-files.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { decodePng, drawScaled, encodePng, solidImage, type RgbaImage } from "./png.js";
import { composeLocationSheet, type LocationSheetPanel } from "./location-sheet.js";

/**
 * Kit operations (SPEC-010): every mutation goes through the world's one commit primitive, so
 * kits get the same base-hash staleness, journalling and history as every other file. The
 * classic grid compiles locally — no provider, no cost, no ledger entry, byte-deterministic
 * (R-10, D6).
 */

const kitPath = (sheetId: string): string => `references/${sheetId}/kit.json`;

export async function readKit(
  store: WorldStore,
  sheetId: string,
): Promise<{ kit: ReferenceKit; raw: string } | null> {
  try {
    const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(kitPath(sheetId)))), "utf8");
    return { kit: ReferenceKitSchema.parse(JSON.parse(raw)), raw };
  } catch {
    return null;
  }
}

async function writeKit(
  store: WorldStore,
  sheetId: string,
  kit: ReferenceKit,
  baseRaw: string | null,
  review?: ReviewDecision,
): Promise<void> {
  const files: import("../world/commit.js").CommitFileInput[] = [
    {
      path: kitPath(sheetId),
      action: baseRaw === null ? "create" : "replace",
      content: JSON.stringify(kit, null, 2) + "\n",
      baseHash: baseRaw === null ? null : sha256(baseRaw),
    },
  ];
  if (review) {
    const path = "references/reviews.jsonl";
    let raw = "";
    let existed = false;
    try {
      raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
      existed = true;
    } catch {
      /* first review */
    }
    files.push({
      path,
      action: existed ? "replace" : "create",
      content: raw + JSON.stringify(review) + "\n",
      baseHash: existed ? sha256(raw) : null,
    });
  }
  await store.commit({
    kind: review ? "reference-accept" : "kit-edit",
    source: review ? "review:user" : "form",
    files,
  });
}

/** A fresh SPEC-017 kit. Legacy tile arrays remain readable but new kits generate no angle tiles. */
export function emptyKit(sheetId: string): ReferenceKit {
  return {
    sheetId,
    tiles: [],
    compilations: [],
    looks: [],
  };
}

async function loadOrEmpty(
  store: WorldStore,
  sheetId: string,
): Promise<{ kit: ReferenceKit; raw: string | null }> {
  const existing = await readKit(store, sheetId);
  return existing ?? { kit: emptyKit(sheetId), raw: null };
}

/** Lock a generated tile into the reference set (R-3, D3). */
export async function lockTile(
  store: WorldStore,
  sheetId: string,
  angle: ReferenceAngle,
  name?: string,
): Promise<void> {
  const { kit, raw } = await loadOrEmpty(store, sheetId);
  const tile = kit.tiles.find(
    (t) => t.angle === angle && (name === undefined || t.name === name) && t.status === "generated",
  );
  if (!tile) throw new Error(`no generated ${angle} tile to lock`);
  tile.status = "locked";
  const next: ReferenceKit = {
    ...kit,
    // The first locked head-front becomes the anchor if none exists (D2).
    ...(kit.anchor === undefined && angle === "head-front" && tile.file !== undefined
      ? { anchor: tile.file }
      : {}),
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
    ...(incoming.takeId !== undefined
      ? { sourceTakeId: incoming.takeId as ReferenceKit["tiles"][number]["sourceTakeId"] }
      : {}),
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
  input: {
    file: string;
    jobId?: Job["id"];
    takeId?: Take["id"];
    sheetVersion: number;
    artDirectionVersion?: number;
    source?: "generated" | "upload" | "promotion";
    acceptedAt?: string;
    review?: ReviewDecision;
  },
): Promise<void> {
  const { kit, raw } = await loadOrEmpty(store, sheetId);
  for (const tile of kit.tiles) {
    if (tile.angle === "head-front" && (tile.status === "locked" || tile.status === "generated")) {
      tile.status = "superseded";
    }
  }
  if (kit.tiles.length > 0) {
    kit.tiles.push({
      angle: "head-front",
      status: "locked",
      file: input.file,
      sheetVersion: input.sheetVersion,
      ...(input.takeId !== undefined
        ? { sourceTakeId: input.takeId as ReferenceKit["tiles"][number]["sourceTakeId"] }
        : {}),
    });
  }
  // The most consequential accept in the product: everything downstream inherits this face.
  await writeKit(
    store,
    sheetId,
    {
      ...kit,
      anchor: input.file,
      mainPhoto: {
        file: input.file,
        source: input.source ?? "generated",
        ...(input.jobId ? { sourceJobId: input.jobId } : {}),
        ...(input.takeId ? { sourceTakeId: input.takeId } : {}),
        sheetVersion: input.sheetVersion,
        ...(input.artDirectionVersion ? { artDirectionVersion: input.artDirectionVersion } : {}),
        ...(input.acceptedAt ? { acceptedAt: input.acceptedAt } : {}),
      },
    },
    raw,
    input.review,
  );
}

export async function acceptCharacterSheet(
  store: WorldStore,
  sheet: Sheet,
  input: {
    file: string;
    takeId: Take["id"];
    sheetVersion: number;
    /**
     * The main photo the generation was conditioned on. Optional only for an upload, which was
     * conditioned on nothing: recording an anchor it never saw would claim a lineage that does
     * not exist, and `compilationIsStale` reads the absence as "no anchor to fall out of date".
     */
    anchorFile?: string;
    artDirectionVersion: number;
    review?: ReviewDecision;
  },
): Promise<void> {
  const { kit, raw } = await loadOrEmpty(store, sheet.id);
  const compilation: Compilation = {
    file: input.file,
    format: "character-sheet",
    sheetVersion: input.sheetVersion,
    tiles: [],
    compiledAt: store.now(),
    source: input.takeId,
    accepted: true,
    ...(input.anchorFile !== undefined ? { anchorFile: input.anchorFile } : {}),
    artDirectionVersion: input.artDirectionVersion,
  };
  const others = kit.compilations.filter((candidate) => candidate.file !== input.file);
  await writeKit(
    store,
    sheet.id,
    { ...kit, compilations: [...others, compilation], designatedCompilation: input.file },
    raw,
    input.review,
  );
}

/**
 * Accept one angle on a location, and rebuild the sheet it belongs to (#243, design turn 57).
 *
 * The order below is the whole of the "a failed assembly changes nothing" rule: the sheet's
 * pixels are composed and its PNG written *before* the kit is committed, so the designation can
 * never point at a file that does not exist. If composition throws, nothing has been written —
 * the candidate stays unreviewed, the previous sheet stays the one shots carry, and retrying
 * costs nothing because no provider was involved.
 */
export async function acceptLocationView(
  store: WorldStore,
  sheet: Sheet,
  input: {
    id: string;
    name: string;
    /** Relative to `references/<sheetId>/` — inside the take directory, never a loose file. */
    file: string;
    takeId: Take["id"];
    sheetVersion: number;
    artDirectionVersion: number;
    /** Replace the establishing view rather than appending an additional angle. */
    establishing?: boolean;
    /**
     * The caller confirmed the replacement of an active view by this name. Without it a
     * collision refuses, because silently superseding an angle somebody may still want is a
     * loss they would only notice much later.
     */
    replaceExistingName?: boolean;
    review?: ReviewDecision;
  },
): Promise<void> {
  const { kit, raw } = await loadOrEmpty(store, sheet.id);
  const views = kit.locationViews ?? [];
  const active = views.filter((view) => view.status === "active");
  const collision = active.find((view) => normalizeViewName(view.name) === normalizeViewName(input.name));
  const isFirst = active.length === 0;
  const establishing = input.establishing === true || isFirst;

  if (collision !== undefined && input.replaceExistingName !== true) {
    throw new Error(`"${input.name}" is already an active view of ${sheet.name}; confirm the replacement`);
  }
  // The ceiling is checked against what this acceptance would leave behind: replacing a view
  // costs nothing, adding one does.
  const supersededByThis = new Set<string>();
  if (collision !== undefined) supersededByThis.add(collision.id);
  if (establishing && kit.establishingViewId !== undefined) supersededByThis.add(kit.establishingViewId);
  if (active.length - supersededByThis.size + 1 > MAX_ACTIVE_LOCATION_VIEWS) {
    throw new Error(`${sheet.name} already has ${MAX_ACTIVE_LOCATION_VIEWS} active views`);
  }

  const now = store.now();
  const accepted: LocationView = {
    id: input.id,
    name: input.name.trim().replace(/\s+/g, " "),
    file: input.file,
    sourceTakeId: input.takeId,
    sheetVersion: input.sheetVersion,
    artDirectionVersion: input.artDirectionVersion,
    acceptedAt: now,
    // A replacement takes over the panel the superseded view held, which is what design turn 57
    // means by leaving the panel order unchanged. Ordering on acceptedAt alone would sort the
    // replacement — always the newest thing here — to the bottom of the sheet, and a prompt that
    // already cited panel 2 would be describing a different side of the room.
    slotAt: collision !== undefined ? locationViewSlotAt(collision) : now,
    status: "active",
  };
  const nextViews: LocationView[] = [
    ...views.map((view) => (supersededByThis.has(view.id) ? { ...view, status: "superseded" as const } : view)),
    accepted,
  ];
  const nextKit: ReferenceKit = {
    ...kit,
    locationViews: nextViews,
    // Replacing the establishing view leaves the additional views' order untouched: they are
    // ordered by their own acceptance, and this one was not theirs.
    establishingViewId: establishing ? accepted.id : kit.establishingViewId,
  };

  const sheetFile = await rebuildLocationSheet(store, sheet, nextKit);
  await writeKit(
    store,
    sheet.id,
    {
      ...nextKit,
      compilations: [
        ...nextKit.compilations.filter((candidate) => candidate.format !== "location-sheet"),
        sheetFile.compilation,
      ],
      designatedCompilation: sheetFile.compilation.file,
    },
    raw,
    input.review,
  );
}

/**
 * Compose the sheet from a kit's active views and write the PNG. Returns the compilation record
 * to commit alongside it. Writes no kit state itself — the caller commits, so a throw here
 * leaves the world exactly as it was.
 */
async function rebuildLocationSheet(
  store: WorldStore,
  sheet: Sheet,
  kit: ReferenceKit,
): Promise<{ compilation: Compilation }> {
  const ordered = orderedLocationViews(kit);
  if (ordered.length === 0) throw new Error("no active views to assemble");

  const panels: LocationSheetPanel[] = [];
  for (const view of ordered) {
    const bytes = await readFile(
      toExtendedLength(join(store.dir, fromPortable(`references/${sheet.id}/${view.file}`))),
    );
    panels.push({ id: view.id, name: view.name, image: decodePng(bytes) });
  }
  const composed = composeLocationSheet(panels);
  await atomicWriteFile(join(store.dir, "references", sheet.id, composed.file), Buffer.from(composed.png));
  return {
    compilation: {
      file: composed.file,
      format: "location-sheet",
      sheetVersion: sheet.version,
      tiles: ordered.map((view) => view.file),
      compiledAt: store.now(),
      source: "local",
      accepted: true,
    },
  };
}

export async function acceptCharacterLook(
  store: WorldStore,
  sheetId: string,
  input: {
    id: string;
    file: string;
    kind: "costume" | "pose-expression" | "condition-age";
    prompt: string;
    jobId?: Job["id"];
    takeId: Take["id"];
    artDirectionVersion: number;
    review?: ReviewDecision;
  },
): Promise<void> {
  const { kit, raw } = await loadOrEmpty(store, sheetId);
  const others = (kit.looks ?? []).filter((look) => look.id !== input.id);
  await writeKit(
    store,
    sheetId,
    {
      ...kit,
      looks: [
        ...others,
        {
          id: input.id,
          file: input.file,
          kind: input.kind,
          prompt: input.prompt,
          ...(input.jobId ? { sourceJobId: input.jobId } : {}),
          sourceTakeId: input.takeId,
          artDirectionVersion: input.artDirectionVersion,
          acceptedAt: store.now(),
        },
      ],
    },
    raw,
    input.review,
  );
}

export async function promoteCharacterLook(store: WorldStore, sheet: Sheet, lookId: string): Promise<void> {
  const loaded = await loadOrEmpty(store, sheet.id);
  const look = loaded.kit.looks?.find((candidate) => candidate.id === lookId);
  if (!look) throw new Error(`no accepted look "${lookId}"`);
  await chooseAnchor(store, sheet.id, {
    file: look.file,
    jobId: look.sourceJobId,
    takeId: look.sourceTakeId,
    sheetVersion: sheet.version,
    artDirectionVersion: look.artDirectionVersion,
    source: "promotion",
    acceptedAt: store.now(),
  });
}

export async function attachCharacterLook(
  store: WorldStore,
  sheetId: string,
  lookId: string,
  scope: NonNullable<ReferenceKit["looks"]>[number]["attachedTo"] | null,
): Promise<void> {
  const { kit, raw } = await loadOrEmpty(store, sheetId);
  const looks = [...(kit.looks ?? [])];
  const index = looks.findIndex((look) => look.id === lookId);
  if (index === -1) throw new Error(`no accepted look "${lookId}"`);
  const next = { ...looks[index]! };
  if (scope) next.attachedTo = scope;
  else delete next.attachedTo;
  looks[index] = next;
  await writeKit(store, sheetId, { ...kit, looks }, raw);
}

export async function setStyleOverride(
  store: WorldStore,
  sheetId: string,
  style: string | null,
): Promise<void> {
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

// The attachment resolver moved to @arke-studio/contracts (SPEC-012 planning shares it with
// the renderer); `attachmentFor` re-exports from there via the barrel.

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
  const missing = ([...new Set(effective.tiles.map((t) => t.angle))] as ReferenceAngle[]).filter(
    (a) => !filled.has(a),
  );
  return { gate, missing };
}

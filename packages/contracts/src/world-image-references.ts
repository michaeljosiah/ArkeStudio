import type { WorldBundle } from "./client-state.js";
import { pickableArtifacts } from "./artifact.js";

export interface WorldImageReference {
  file: string;
  name: string;
  group: "Cast" | "Places" | "This world" | "Takes and stills" | "Uploads";
  role: "identity" | "environment" | "style";
  sheetId?: string;
  sheetVersion?: number;
}

/** Portable image addresses only; neither an OS path nor a traversal is a world image. */
export function isWorldImagePath(file: string): boolean {
  return !/[\\:]/.test(file) && ![...file].some((char) => char.charCodeAt(0) < 32) && file.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    && /\.(png|jpe?g|webp)$/i.test(file);
}

/** The same current-world catalogue supplies the picker and validates its selections. */
export function worldImageReferences(world: WorldBundle): WorldImageReference[] {
  const rows = new Map<string, WorldImageReference>();
  const add = (file: string | undefined | null, name: string, group: WorldImageReference["group"], role: WorldImageReference["role"] = "style", sheetId?: string) => {
    if (!file || !isWorldImagePath(file) || rows.has(file)) return;
    const sheet = world.sheets.find((s) => s.id === sheetId);
    rows.set(file, { file, name, group, role, ...(sheet ? { sheetId: sheet.id, sheetVersion: sheet.version } : {}) });
  };
  for (const kit of world.referenceKits) {
    const sheet = world.sheets.find((s) => s.id === kit.sheetId);
    const group = sheet?.type === "location" ? "Places" : "Cast";
    const role = sheet?.type === "location" ? "environment" : "identity";
    const image = (file: string | undefined, label: string) => {
      if (file) add(`references/${kit.sheetId}/${file}`, `${sheet?.name ?? kit.sheetId} · ${label}`, group, role, kit.sheetId);
    };
    image(kit.mainPhoto?.file, "Main photo");
    image(kit.anchor, "Main photo");
    image(kit.designatedCompilation, "Character sheet");
    for (const compilation of kit.compilations) image(compilation.file, "Character sheet");
    for (const tile of kit.tiles) image(tile.file, tile.angle);
    for (const look of kit.looks ?? []) image(look.file, `Look · ${look.kind}`);
    for (const view of kit.locationViews ?? []) image(view.file, view.name);
  }
  for (const [sheetId, files] of Object.entries(world.referenceCandidates)) {
    const sheet = world.sheets.find((s) => s.id === sheetId);
    for (const file of files) add(file, `${sheet?.name ?? sheetId} · Preview`, sheet?.type === "location" ? "Places" : "Cast", sheet?.type === "location" ? "environment" : "identity", sheetId);
  }
  for (const take of world.referenceTakes) {
    const sheet = world.sheets.find((s) => s.id === take.reference?.sheetId);
    if (take.media && sheet) add(`references/${sheet.id}/takes/${take.id}/${take.media}`, `${sheet.name} · Take`, sheet.type === "location" ? "Places" : "Cast", sheet.type === "location" ? "environment" : "identity", sheet.id);
  }
  add(world.keyArt, "Key art", "This world");
  add(world.artDirection.masterLook, "Master look", "This world");
  for (const file of world.keyArtCandidates) add(file, "Key art preview", "This world");
  for (const file of world.masterLookCandidates) add(file, "Look preview", "This world");
  for (const production of world.productions) {
    for (const take of production.takes) {
      if (take.media) add(`productions/${production.meta.id}/takes/${take.id}/${take.media}`, `${production.meta.title} · ${take.coversShots.join(", ") || take.id}`, "Takes and stills");
      add(take.startFrame, `${production.meta.title} · Boundary frame`, "Takes and stills");
    }
  }
  for (const artifact of pickableArtifacts(world.artifacts)) {
    if (artifact.kind !== "image" && artifact.kind !== "board") continue;
    const source = artifact.generation?.source === "character-reference" ? rows.get(artifact.generation.sourceFile) : undefined;
    add(`artifacts/${artifact.file}`, source?.name ?? artifact.file, source?.group ?? (artifact.generation || artifact.boundaryExtraction ? "Takes and stills" : "Uploads"), source?.role ?? "style", source?.sheetId);
  }
  return [...rows.values()];
}

export function stagedWorldImage(world: WorldBundle, key: string): { file: string; role: WorldImageReference["role"] } | undefined {
  const file = world.stagedReferences[key];
  return file ? { file, role: worldImageReferences(world).find((r) => r.file === file)?.role ?? "style" } : undefined;
}

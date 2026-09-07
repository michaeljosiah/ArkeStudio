import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GenesisKeyArtBriefSchema,
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
  keyArtBriefProse,
  keyArtBriefSettled,
  orderedLocationViews,
  type GenesisKeyArtBrief,
  type ManifestModel,
  type ResolvedArtDirection,
  type Sheet,
  type WorldBundle,
  type WorldMeta,
} from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { readKit } from "./kit.js";
import { referenceBudgetFor } from "./generate.js";

/**
 * Key art is a picture of this world, not of its genre (SPEC-031 Â§1.11).
 *
 * The prompt draws on the bible and the cast alongside the key-art brief, and the frame
 * carries the main photos of the characters the brief names as identity references â€” which
 * characters appear is the brief's to say, never the model's to guess (R-58, R-59). One
 * assembly, used by the founding build and by the world screen's own Regenerate alike: a
 * frame that could only do this during a build would make Regenerate produce a worse picture
 * than the one it replaces (R-62).
 */

export interface KeyArtCarriedReference {
  file: string;
  role: "identity" | "environment" | "style";
  /** Who or where this is, and the version it was frozen at (R-61). */
  sheetId: string | null;
  sheetVersion: number | null;
  name: string;
}

export interface KeyArtAssembly {
  references: string[];
  referenceRoles: Array<{ file: string; role: string }>;
  carried: KeyArtCarriedReference[];
  /** Named before dispatch, never silently truncated (R-59, R-60; SPEC-010 R-15). */
  dropped: Array<{ name: string; reason: string }>;
  /** The sheets each carried reference was frozen at, for the take-shaped record (R-61). */
  sheets: Record<string, number>;
}

/**
 * The key-art brief survives the conversation in the world's own build record â€” the durable
 * copy R-62's regeneration reads. Null for a world founded before builds existed, or by hand.
 */
export async function readKeyArtBrief(worldDir: string): Promise<GenesisKeyArtBrief | null> {
  try {
    const raw = await readFile(toExtendedLength(join(worldDir, ...ART_DIRECTION_PATH.split("/"))), "utf8");
    const record = ArtDirectionRecordSchema.parse(JSON.parse(raw));
    if ("keyArtIntent" in record) {
      return record.keyArtIntent && keyArtBriefSettled(record.keyArtIntent) ? record.keyArtIntent : null;
    }
  } catch {
    // Worlds founded before this field existed keep their brief in the build record below.
  }
  try {
    const raw = await readFile(toExtendedLength(join(worldDir, "build", "build.json")), "utf8");
    const record = JSON.parse(raw) as { blueprint?: { keyArt?: unknown } };
    const parsed = GenesisKeyArtBriefSchema.safeParse(record.blueprint?.keyArt);
    return parsed.success && keyArtBriefSettled(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Everything the brief names, resolved against the world as it stands: identity anchors in
 * the brief's own order, the establishing view of a named place, and the style reference the
 * author staged â€” which is never displaced (R-60). A named character whose anchor did not
 * land is dropped and named; with no anchors at all the picture is still made from the lore
 * and the look â€” fewer references is a weaker picture, not a refused one (R-59).
 */
export async function assembleKeyArt(
  store: WorldStore,
  bundle: WorldBundle,
  brief: GenesisKeyArtBrief | null,
  model: ManifestModel,
  staged?: string,
): Promise<KeyArtAssembly> {
  const budget = referenceBudgetFor(model);
  const carried: KeyArtCarriedReference[] = [];
  const dropped: Array<{ name: string; reason: string }> = [];
  const sheets: Record<string, number> = {};

  // The style role is reserved first and never lost to identity overflow (R-60). Callers
  // already withhold a staged image from a zero-slot route (`stagedFor`), so no drop entry.
  if (staged !== undefined && budget > 0) {
    carried.push({ file: staged, role: "style", sheetId: null, sheetVersion: null, name: "staged reference" });
  }

  const room = () => carried.length < budget;
  const normalize = (name: string) => name.trim().toLowerCase().replace(/[’‘]/g, "'");
  const sheetByName = (type: Sheet["type"], name: string): Sheet | undefined => {
    const wanted = normalize(name);
    const candidates = bundle.sheets.filter((sheet) => sheet.type === type);
    const exact = candidates.filter((sheet) => normalize(sheet.name) === wanted || normalize(sheet.id) === wanted);
    if (exact.length) return exact.length === 1 ? exact[0] : undefined;
    const aliases = candidates.filter((sheet) => type === "character"
      ? [...sheet.name.matchAll(/["“]([^"“”]+)["”]/g)].some((match) => normalize(match[1]!) === wanted)
      : wanted.startsWith(`${normalize(sheet.name)},`));
    // Never guess between people with the same nickname. For places, prefer the longest
    // complete name: "House, Ikoyi" is more specific than "House".
    if (type === "location") aliases.sort((a, b) => b.name.length - a.name.length);
    if (aliases.length === 1 || (type === "location" && aliases[0] && aliases[1] && aliases[0].name.length > aliases[1].name.length)) return aliases[0];
    return undefined;
  };

  const seen = new Set<string>();
  for (const name of brief?.characters ?? []) {
    // A name the brief repeats is one person, one slot.
    if (seen.has(name.toLowerCase())) continue;

    const sheet = sheetByName("character", name);
    if (!sheet) {
      dropped.push({ name, reason: "is not in the world" });
      continue;
    }
    if (seen.has(sheet.id)) continue;
    seen.add(sheet.id);
    const kit = (await readKit(store, sheet.id))?.kit ?? null;
    const photo = kit?.mainPhoto?.file ?? kit?.anchor;
    if (photo === undefined) {
      // The anchor did not land; the image is still made (R-59).
      dropped.push({ name, reason: "no accepted main photo" });
      continue;
    }
    if (!room()) {
      // Surplus drops in the brief's own order, and says so (R-60).
      dropped.push({ name, reason: `${model.displayName} takes ${budget} reference image${budget === 1 ? "" : "s"}` });
      continue;
    }
    carried.push({
      file: `references/${sheet.id}/${photo}`,
      role: "identity",
      sheetId: sheet.id,
      sheetVersion: sheet.version,
      name: sheet.name,
    });
    sheets[sheet.id] = sheet.version;
  }

  if (brief?.location !== undefined) {
    const sheet = sheetByName("location", brief.location);
    const kit = sheet ? ((await readKit(store, sheet.id))?.kit ?? null) : null;
    const view = kit ? orderedLocationViews(kit)[0] : undefined;
    if (!sheet) dropped.push({ name: brief.location, reason: "is not in the world" });
    else if (view === undefined) dropped.push({ name: brief.location, reason: "no accepted establishing view" });
    else if (!room()) {
      dropped.push({ name: brief.location, reason: `${model.displayName} takes ${budget} reference image${budget === 1 ? "" : "s"}` });
    } else {
      carried.push({
        file: `references/${sheet.id}/${view.file}`,
        role: "environment",
        sheetId: sheet.id,
        sheetVersion: sheet.version,
        name: sheet.name,
      });
      sheets[sheet.id] = sheet.version;
    }
  }

  return {
    references: carried.map((reference) => reference.file),
    referenceRoles: carried.map((reference) => ({ file: reference.file, role: reference.role })),
    carried,
    dropped,
    sheets,
  };
}

/** The first stretch of the bible, sized for a prompt rather than a reader. */
export function bibleExcerpt(text: string, max = 500): string {
  const clean = text.replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(". ") + 1, max - 80))}`.trim();
}

/**
 * The composed prompt, drawing on more than the world's surface (R-58): the look, the
 * logline, the bible's argument, who is in the frame, and the brief's subject, moment and
 * stakes. Only the floor of `keyArtPrompt`'s precedence â€” an authored prompt or an art
 * director's rewrite still outranks it.
 */
export function keyArtComposition(input: {
  meta: WorldMeta;
  direction: ResolvedArtDirection;
  bible: string;
  brief: GenesisKeyArtBrief;
  /** The characters actually carried, in order â€” the prompt and the frame must agree. */
  cast: readonly string[];
}): string {
  const excerpt = bibleExcerpt(input.bible);
  const lines = [
    `Key art for "${input.meta.name}". ${input.direction.description}.`,
    input.meta.logline?.trim() ?? "",
    input.meta.tone?.trim() ? `Tone: ${input.meta.tone.trim()}.` : "",
    input.meta.genre?.trim() ? `Genre: ${input.meta.genre.trim()}.` : "",
    excerpt !== "" ? `The story: ${excerpt}` : "",
    `The image: ${keyArtBriefProse(input.brief)}.`,
    input.cast.length > 0
      ? `Identity references supplied for: ${input.cast.join(", ")} â€” preserve each supplied identity exactly.`
      : "",
    "A single evocative cinematic image of this world and what is at stake in it. No text, no logos.",
  ];
  return lines.filter((line) => line !== "").join(" ");
}

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GenesisBlueprintSchema,
  GenesisCharacterFileSchema,
  GenesisDraftSchema,
  GenesisFactionFileSchema,
  GenesisLocationFileSchema,
  type GenesisBlueprint,
} from "@arke-studio/contracts";
import type { z } from "zod";
import { slugify } from "../world/slug.js";

/**
 * The blueprint fold (SPEC-031 R-2): the sandbox directory read into one aggregate.
 *
 * `draft.json` holds identity, look, bible, threads and the key-art brief; entities live one
 * file each under `draft/characters/`, `draft/locations/` and `draft/factions/`. A file that
 * fails to parse is dropped from the fold and named, never a failure of the fold itself —
 * the conversation must keep working around one bad write. Withdrawn entities are removed:
 * without that the directory model only ever accumulates, and the build would spend on
 * someone the author explicitly took out.
 */

export const BLUEPRINT_DIR = "draft";

const KINDS = [
  { key: "characters", schema: GenesisCharacterFileSchema },
  { key: "locations", schema: GenesisLocationFileSchema },
  { key: "factions", schema: GenesisFactionFileSchema },
] as const;

interface FoldedEntity {
  slug: string;
  name: string;
  line?: string;
  description?: string;
  brief?: Record<string, unknown>;
}

async function foldKind(
  dir: string,
  kind: (typeof KINDS)[number],
  dropped: string[],
): Promise<FoldedEntity[]> {
  const kindDir = join(dir, BLUEPRINT_DIR, kind.key);
  const names = (await readdir(kindDir).catch(() => [] as string[]))
    .filter((n) => n.endsWith(".json"))
    .sort();
  const entities: FoldedEntity[] = [];
  for (const file of names) {
    const relative = `${BLUEPRINT_DIR}/${kind.key}/${file}`;
    let parsed: z.infer<(typeof KINDS)[number]["schema"]> | null = null;
    try {
      const result = kind.schema.safeParse(JSON.parse(await readFile(join(kindDir, file), "utf8")));
      if (result.success) parsed = result.data;
    } catch {
      /* unreadable or not JSON — dropped below */
    }
    if (parsed === null) {
      dropped.push(relative);
      continue;
    }
    if (parsed.withdrawn === true) continue;
    entities.push({
      // The filename is the identity (R-2): renaming the entity changes `name`, never the slug.
      slug: file.slice(0, -".json".length),
      name: parsed.name,
      ...(parsed.line !== undefined ? { line: parsed.line } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      ...("brief" in parsed && parsed.brief !== undefined ? { brief: parsed.brief } : {}),
    });
  }
  return entities;
}

/**
 * Fold the sandbox into one blueprint aggregate. Absent files read as an empty plan, never as
 * an error — the fold is called on every turn, including the first.
 */
export async function foldBlueprint(dir: string): Promise<GenesisBlueprint> {
  const dropped: string[] = [];

  let draft = GenesisDraftSchema.parse({});
  try {
    const raw = await readFile(join(dir, "draft.json"), "utf8");
    const parsed = GenesisDraftSchema.safeParse(JSON.parse(raw));
    if (parsed.success) draft = parsed.data;
    else dropped.push("draft.json");
  } catch (err) {
    // Absent is the ordinary first-turn state; anything else is a real file gone wrong.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") dropped.push("draft.json");
  }

  const [characters, locations, factions] = await Promise.all([
    foldKind(dir, KINDS[0], dropped),
    foldKind(dir, KINDS[1], dropped),
    foldKind(dir, KINDS[2], dropped),
  ]);

  // Older sandboxes kept entities as one-line arrays on draft.json. Fold them in behind the
  // directory: a directory file with the same slug wins, because it is the richer record.
  const merge = (folded: FoldedEntity[], legacy: readonly { name: string; line: string }[]) => {
    const taken = new Set(folded.map((e) => e.slug));
    for (const entry of legacy) {
      const slug = slugify(entry.name);
      if (slug === "" || taken.has(slug)) continue;
      taken.add(slug);
      folded.push({ slug, name: entry.name, line: entry.line });
    }
    return folded;
  };

  return GenesisBlueprintSchema.parse({
    ...(draft.name !== undefined ? { name: draft.name } : {}),
    ...(draft.logline !== undefined ? { logline: draft.logline } : {}),
    ...(draft.tone !== undefined ? { tone: draft.tone } : {}),
    ...(draft.genre !== undefined ? { genre: draft.genre } : {}),
    ...(draft.look !== undefined ? { look: draft.look } : {}),
    ...(draft.bible !== undefined ? { bible: draft.bible } : {}),
    threads: draft.threads,
    ...(draft.keyArt !== undefined ? { keyArt: draft.keyArt } : {}),
    characters: merge(characters, draft.characters),
    locations: merge(locations, draft.locations),
    factions,
    dropped: dropped.sort(),
  });
}

/** Two blueprints are the same when they say the same thing — the rail should not flicker. */
export function sameBlueprint(a: GenesisBlueprint | null, b: GenesisBlueprint | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Has anything actually been settled? An empty plan is a blueprint of nothing. */
export function blueprintSaysSomething(blueprint: GenesisBlueprint): boolean {
  return (
    blueprint.name !== undefined ||
    blueprint.logline !== undefined ||
    blueprint.tone !== undefined ||
    blueprint.genre !== undefined ||
    blueprint.look !== undefined ||
    blueprint.bible !== undefined ||
    blueprint.keyArt !== undefined ||
    blueprint.threads.length > 0 ||
    blueprint.characters.length > 0 ||
    blueprint.locations.length > 0 ||
    blueprint.factions.length > 0
  );
}

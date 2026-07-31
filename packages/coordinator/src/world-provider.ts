import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ArtifactSidecarSchema,
  CanonEntrySchema,
  ChangeRecordSchema,
  ChapterSummarySchema,
  ProductionSchema,
  ProposalSchema,
  ReferenceKitSchema,
  ReviewDecisionSchema,
  RipplePreviewSchema,
  SceneSchema,
  SelectionsSchema,
  SheetSchema,
  StoryOverviewSchema,
  TakeSchema,
  WorldMetaSchema,
  type ProductionBundle,
  type Sheet,
  type SheetKind,
  type StagedProposal,
  type WorldBundle,
  type WorldSummary,
} from "@arke-studio/contracts";
import { parseFrontmatter, splitSections } from "./frontmatter.js";

/**
 * Reads the world model (SPEC-001 §2.6). The mock provider reads the committed fixture world;
 * SPEC-002 replaces it with the real filesystem provider and owns writing entirely.
 */
export interface WorldProvider {
  listWorlds(): Promise<WorldSummary[]>;
  loadWorld(worldId: string): Promise<WorldBundle>;
}

const SHEET_DIRS: ReadonlyArray<{ dir: string; type: SheetKind }> = [
  { dir: "characters", type: "character" },
  { dir: "locations", type: "location" },
  { dir: "factions", type: "faction" },
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readJsonl(path: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
}

async function parseSheet(path: string, type: SheetKind): Promise<Sheet> {
  const { data, body } = parseFrontmatter(await readFile(path, "utf8"));
  return SheetSchema.parse({ ...data, type, sections: splitSections(body) });
}

async function loadProduction(dir: string, id: string): Promise<ProductionBundle> {
  const meta = ProductionSchema.parse(await readJson(join(dir, "production.json")));
  if (meta.id !== id) {
    throw new Error(`production.json id "${meta.id}" does not match its directory "${id}"`);
  }

  const story = (await exists(join(dir, "story.json")))
    ? StoryOverviewSchema.parse(await readJson(join(dir, "story.json")))
    : null;
  const treatment = (await exists(join(dir, "story.md")))
    ? (await readFile(join(dir, "story.md"), "utf8")).replace(/\r\n/g, "\n")
    : null;

  const chapters = [];
  for (const file of (await listDir(join(dir, "chapters"))).filter((f) => f.endsWith(".md")).sort()) {
    const { data } = parseFrontmatter(await readFile(join(dir, "chapters", file), "utf8"));
    chapters.push(ChapterSummarySchema.parse(data));
  }

  const scenes = [];
  for (const file of (await listDir(join(dir, "scenes"))).filter((f) => f.endsWith(".json")).sort()) {
    scenes.push(SceneSchema.parse(await readJson(join(dir, "scenes", file))));
  }

  const takes = [];
  for (const takeDir of await listDir(join(dir, "takes"))) {
    const takePath = join(dir, "takes", takeDir, "take.json");
    if (await exists(takePath)) takes.push(TakeSchema.parse(await readJson(takePath)));
  }
  takes.sort((a, b) => a.dispatchedAt.localeCompare(b.dispatchedAt));

  const reviews = (await readJsonl(join(dir, "reviews.jsonl"))).map((r) => ReviewDecisionSchema.parse(r));

  const selections = (await exists(join(dir, "selections.json")))
    ? SelectionsSchema.parse(await readJson(join(dir, "selections.json")))
    : {};

  return { meta, story, treatment, chapters, scenes, takes, reviews, selections };
}

async function loadProposals(worldDir: string): Promise<StagedProposal[]> {
  const out: StagedProposal[] = [];
  for (const id of await listDir(join(worldDir, ".proposals"))) {
    const dir = join(worldDir, ".proposals", id);
    const manifestPath = join(dir, "proposal.json");
    if (!(await exists(manifestPath))) continue;
    const proposal = ProposalSchema.parse(await readJson(manifestPath));
    const ripple = (await exists(join(dir, "ripple.json")))
      ? RipplePreviewSchema.parse(await readJson(join(dir, "ripple.json")))
      : null;
    out.push({ proposal, ripple });
  }
  return out;
}

/** Reads a fixture layout shaped like %USERPROFILE%\ArkeStudio (master spec §2.2). */
export class MockWorldProvider implements WorldProvider {
  constructor(private readonly root: string) {}

  private worldsDir(): string {
    return join(this.root, "worlds");
  }

  async listWorlds(): Promise<WorldSummary[]> {
    const out: WorldSummary[] = [];
    for (const slug of await listDir(this.worldsDir())) {
      const dir = join(this.worldsDir(), slug);
      const metaPath = join(dir, "world.json");
      if (!(await exists(metaPath))) continue;
      const meta = WorldMetaSchema.parse(await readJson(metaPath));
      const countMd = async (sub: string) =>
        (await listDir(join(dir, sub))).filter((f) => f.endsWith(".md")).length;
      out.push({
        worldId: meta.worldId,
        slug: meta.slug,
        name: meta.name,
        ...(meta.logline !== undefined ? { logline: meta.logline } : {}),
        counts: {
          characters: await countMd("characters"),
          locations: await countMd("locations"),
          factions: await countMd("factions"),
          canonEntries: await countMd("canon"),
          productions: (
            await Promise.all(
              (await listDir(join(dir, "productions"))).map((p) =>
                exists(join(dir, "productions", p, "production.json")),
              ),
            )
          ).filter(Boolean).length,
        },
        updated: meta.updated,
      });
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  async loadWorld(worldId: string): Promise<WorldBundle> {
    const summaries = await this.listWorlds();
    const summary = summaries.find((w) => w.worldId === worldId);
    if (!summary) throw new Error(`no world with id ${worldId}`);
    const dir = join(this.worldsDir(), summary.slug);

    const meta = WorldMetaSchema.parse(await readJson(join(dir, "world.json")));

    const sheets: Sheet[] = [];
    for (const { dir: sub, type } of SHEET_DIRS) {
      for (const file of (await listDir(join(dir, sub))).filter((f) => f.endsWith(".md")).sort()) {
        sheets.push(await parseSheet(join(dir, sub, file), type));
      }
    }

    const canon = [];
    for (const file of (await listDir(join(dir, "canon"))).filter((f) => f.endsWith(".md")).sort()) {
      const { data, body } = parseFrontmatter(await readFile(join(dir, "canon", file), "utf8"));
      canon.push(CanonEntrySchema.parse({ ...data, body: body.trim() }));
    }

    const referenceKits = [];
    for (const sheetId of await listDir(join(dir, "references"))) {
      const kitPath = join(dir, "references", sheetId, "kit.json");
      if (await exists(kitPath)) referenceKits.push(ReferenceKitSchema.parse(await readJson(kitPath)));
    }

    const artifacts = [];
    for (const file of (await listDir(join(dir, "artifacts"))).filter((f) => f.endsWith(".json")).sort()) {
      artifacts.push(ArtifactSidecarSchema.parse(await readJson(join(dir, "artifacts", file))));
    }

    const productions = [];
    for (const id of (await listDir(join(dir, "productions"))).sort()) {
      if (await exists(join(dir, "productions", id, "production.json"))) {
        productions.push(await loadProduction(join(dir, "productions", id), id));
      }
    }

    const proposals = await loadProposals(dir);

    const changes = (await readJsonl(join(dir, "changes.jsonl")))
      .map((c) => ChangeRecordSchema.parse(c))
      .slice(-50);

    return { meta, sheets, canon, referenceKits, artifacts, productions, proposals, changes };
  }
}

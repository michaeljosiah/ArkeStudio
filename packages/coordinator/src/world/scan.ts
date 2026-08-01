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
  type WorldMeta,
  type WorldProblem,
} from "@arke-studio/contracts";
import { MarkdownFile, sha256 } from "./text-files.js";
import { toExtendedLength, toPortable } from "./paths.js";
import { readChanges } from "./change-writer.js";

/**
 * The world scan (SPEC-002 R-2, §2.12): parse and validate every entity, collecting per-file
 * failures instead of dying on the first — for a hand-editable format, one stray character
 * must never make a world inaccessible. Also produces the manifest (path → content hash) that
 * closed-world reconciliation compares against (R-28).
 */

export const SUPPORTED_SCHEMA_VERSION = 1;

export class WorldOpenError extends Error {
  constructor(
    message: string,
    readonly reason: "not-a-world" | "schema-newer" | "unreadable",
  ) {
    super(message);
  }
}

export interface ScanResult {
  meta: WorldMeta;
  bundle: WorldBundle;
  problems: WorldProblem[];
  /** Gated text files only — the reconciliation surface. Portable paths. */
  manifest: Record<string, string>;
}

const SHEET_DIRS: ReadonlyArray<{ dir: string; type: SheetKind }> = [
  { dir: "characters", type: "character" },
  { dir: "locations", type: "location" },
  { dir: "factions", type: "faction" },
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(toExtendedLength(path));
    return true;
  } catch {
    return false;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(toExtendedLength(path));
  } catch {
    return [];
  }
}

async function read(path: string): Promise<string> {
  return readFile(toExtendedLength(path), "utf8");
}

/** Read world.json alone — the openability gate (R-1, R-25). */
export async function readWorldMeta(dir: string): Promise<WorldMeta> {
  let raw: string;
  try {
    raw = await read(join(dir, "world.json"));
  } catch {
    throw new WorldOpenError(`${dir} has no world.json`, "not-a-world");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (err) {
    throw new WorldOpenError(`world.json does not parse: ${String(err)}`, "unreadable");
  }
  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (typeof schemaVersion === "number" && schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new WorldOpenError(
      `this world was written by a newer Arke Studio (schema ${schemaVersion}; this build supports ${SUPPORTED_SCHEMA_VERSION}). Update the app — the world has not been modified.`,
      "schema-newer",
    );
  }
  return WorldMetaSchema.parse(parsed);
}

export async function scanWorld(dir: string): Promise<ScanResult> {
  const meta = await readWorldMeta(dir);
  const problems: WorldProblem[] = [];
  const manifest: Record<string, string> = {};

  const tryParse = async <T>(rel: string, parse: (raw: string) => T): Promise<T | null> => {
    try {
      const raw = await read(join(dir, rel));
      const value = parse(raw);
      manifest[toPortable(rel)] = sha256(raw);
      return value;
    } catch (err) {
      problems.push({ path: toPortable(rel), message: (err as Error).message.slice(0, 500) });
      return null;
    }
  };

  manifest["world.json"] = sha256(await read(join(dir, "world.json")));

  const sheets: Sheet[] = [];
  for (const { dir: sub, type } of SHEET_DIRS) {
    for (const file of (await listDir(join(dir, sub))).filter((f) => f.endsWith(".md")).sort()) {
      const sheet = await tryParse(`${sub}/${file}`, (raw) => {
        const doc = MarkdownFile.parse(raw);
        return SheetSchema.parse({ ...doc.data, type, sections: doc.sections() });
      });
      if (sheet) sheets.push(sheet);
    }
  }

  const canon = [];
  for (const file of (await listDir(join(dir, "canon"))).filter((f) => f.endsWith(".md")).sort()) {
    const entry = await tryParse(`canon/${file}`, (raw) => {
      const doc = MarkdownFile.parse(raw);
      return CanonEntrySchema.parse({ ...doc.data, body: doc.body.trim() });
    });
    if (entry) canon.push(entry);
  }

  const referenceKits = [];
  for (const sheetId of await listDir(join(dir, "references"))) {
    if (await exists(join(dir, "references", sheetId, "kit.json"))) {
      const kit = await tryParse(`references/${sheetId}/kit.json`, (raw) =>
        ReferenceKitSchema.parse(JSON.parse(raw)),
      );
      if (kit) referenceKits.push(kit);
    }
  }

  const artifacts = [];
  for (const file of (await listDir(join(dir, "artifacts"))).filter((f) => f.endsWith(".json")).sort()) {
    const sidecar = await tryParse(`artifacts/${file}`, (raw) => ArtifactSidecarSchema.parse(JSON.parse(raw)));
    if (sidecar) artifacts.push(sidecar);
  }

  const productions: ProductionBundle[] = [];
  for (const id of (await listDir(join(dir, "productions"))).sort()) {
    const pdir = join(dir, "productions", id);
    if (!(await exists(join(pdir, "production.json")))) continue;
    const metaDoc = await tryParse(`productions/${id}/production.json`, (raw) => {
      const value = ProductionSchema.parse(JSON.parse(raw));
      if (value.id !== id) throw new Error(`production.json id "${value.id}" does not match directory "${id}"`);
      return value;
    });
    if (!metaDoc) continue;

    const story = (await exists(join(pdir, "story.json")))
      ? await tryParse(`productions/${id}/story.json`, (raw) => StoryOverviewSchema.parse(JSON.parse(raw)))
      : null;
    const treatment = (await exists(join(pdir, "story.md")))
      ? (await read(join(pdir, "story.md"))).replace(/\r\n/g, "\n")
      : null;

    const chapters = [];
    for (const file of (await listDir(join(pdir, "chapters"))).filter((f) => f.endsWith(".md")).sort()) {
      const chapter = await tryParse(`productions/${id}/chapters/${file}`, (raw) =>
        ChapterSummarySchema.parse(MarkdownFile.parse(raw).data),
      );
      if (chapter) chapters.push(chapter);
    }

    const scenes = [];
    for (const file of (await listDir(join(pdir, "scenes"))).filter((f) => f.endsWith(".json")).sort()) {
      const scene = await tryParse(`productions/${id}/scenes/${file}`, (raw) => SceneSchema.parse(JSON.parse(raw)));
      if (scene) scenes.push(scene);
    }

    const takes = [];
    for (const takeDir of await listDir(join(pdir, "takes"))) {
      if (!(await exists(join(pdir, "takes", takeDir, "take.json")))) continue;
      const take = await tryParse(`productions/${id}/takes/${takeDir}/take.json`, (raw) =>
        TakeSchema.parse(JSON.parse(raw)),
      );
      if (take) takes.push(take);
    }
    takes.sort((a, b) => a.dispatchedAt.localeCompare(b.dispatchedAt));

    let reviews: ProductionBundle["reviews"] = [];
    if (await exists(join(pdir, "reviews.jsonl"))) {
      reviews = (await readChanges(join(pdir, "reviews.jsonl")))
        .map((line) => {
          const r = ReviewDecisionSchema.safeParse(line);
          return r.success ? r.data : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
    }

    const selections = (await exists(join(pdir, "selections.json")))
      ? ((await tryParse(`productions/${id}/selections.json`, (raw) => SelectionsSchema.parse(JSON.parse(raw)))) ?? {})
      : {};

    productions.push({ meta: metaDoc, story, treatment, chapters, scenes, takes, reviews, selections });
  }

  const proposals: StagedProposal[] = [];
  for (const pid of await listDir(join(dir, ".proposals"))) {
    if (!(await exists(join(dir, ".proposals", pid, "proposal.json")))) continue;
    const proposal = await tryParse(`.proposals/${pid}/proposal.json`, (raw) => ProposalSchema.parse(JSON.parse(raw)));
    if (!proposal) continue;
    const ripple = (await exists(join(dir, ".proposals", pid, "ripple.json")))
      ? await tryParse(`.proposals/${pid}/ripple.json`, (raw) => RipplePreviewSchema.parse(JSON.parse(raw)))
      : null;
    proposals.push({ proposal, ripple });
  }

  const changes = (await readChanges(join(dir, "changes.jsonl")))
    .map((line) => {
      const r = ChangeRecordSchema.safeParse(line);
      return r.success ? r.data : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .slice(-50);

  const bundle: WorldBundle = {
    meta,
    sheets,
    canon,
    referenceKits,
    artifacts,
    productions,
    proposals,
    changes,
    problems,
    externalEdits: [],
    stale: false,
  };
  return { meta, bundle, problems, manifest };
}

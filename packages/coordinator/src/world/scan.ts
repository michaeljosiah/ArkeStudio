import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { discoverConversations } from "../world-chat/discover.js";
import {
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
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
  resolveArtDirection,
  type ArtDirectionOverride,
  type ArtDirectionRecord,
  type ProductionBundle,
  type Sheet,
  type SheetKind,
  type StagedProposal,
  type WorldBundle,
  type WorldMeta,
  type WorldProblem,
} from "@arke-studio/contracts";
import { MarkdownFile, sha256 } from "./text-files.js";
import { projectReview } from "../gate/review.js";
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
      manifest[toPortable(rel)] = sha256(raw);
      return parse(raw);
    } catch (err) {
      problems.push({ path: toPortable(rel), message: (err as Error).message.slice(0, 500) });
      return null;
    }
  };

  manifest["world.json"] = sha256(await read(join(dir, "world.json")));

  let artDirectionRecord: ArtDirectionRecord | null = null;
  const artDirectionPath = ART_DIRECTION_PATH;
  if (await exists(join(dir, artDirectionPath))) {
    artDirectionRecord = await tryParse(artDirectionPath, (raw) =>
      ArtDirectionRecordSchema.parse(JSON.parse(raw)),
    );
  }

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
  const referenceCandidates: Record<string, string[]> = {};
  const referenceTakes = [];
  for (const sheetId of await listDir(join(dir, "references"))) {
    if (await exists(join(dir, "references", sheetId, "kit.json"))) {
      const kit = await tryParse(`references/${sheetId}/kit.json`, (raw) =>
        ReferenceKitSchema.parse(JSON.parse(raw)),
      );
      if (kit) referenceKits.push(kit);
    }
    const candidates = (await listDir(join(dir, "references", sheetId, "candidates")))
      .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
      .sort();
    const sheetTakes = [];
    for (const takeDir of await listDir(join(dir, "references", sheetId, "takes"))) {
      if (!(await exists(join(dir, "references", sheetId, "takes", takeDir, "take.json")))) continue;
      const take = await tryParse(`references/${sheetId}/takes/${takeDir}/take.json`, (raw) =>
        TakeSchema.parse(JSON.parse(raw)),
      );
      if (take) {
        referenceTakes.push(take);
        sheetTakes.push(take);
      }
    }
    // Generated media is copied into its immutable take. The source candidate is staging, not
    // a second creative result, and must not reappear after restart if queue state is absent.
    const generatedSources = new Set(
      sheetTakes
        .filter((take) => take.kind === "main-photo" && take.jobId !== undefined)
        .map((take) =>
          typeof take.params["sourceCandidate"] === "string"
            ? take.params["sourceCandidate"]
            : take.media
              ? `references/${sheetId}/candidates/${take.media}`
              : undefined,
        )
        .filter((path): path is string => typeof path === "string"),
    );
    const visibleCandidates = candidates
      .map((file) => `references/${sheetId}/candidates/${file}`)
      .filter((path) => !generatedSources.has(path));
    if (visibleCandidates.length > 0) referenceCandidates[sheetId] = visibleCandidates;
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

  let referenceReviews: WorldBundle["referenceReviews"] = [];
  if (await exists(join(dir, "references", "reviews.jsonl"))) {
    referenceReviews = (await readChanges(join(dir, "references", "reviews.jsonl")))
      .map((line) => {
        const parsed = ReviewDecisionSchema.safeParse(line);
        return parsed.success ? parsed.data : null;
      })
      .filter((review): review is NonNullable<typeof review> => review !== null);
  }

  const proposals: StagedProposal[] = [];
  for (const pid of await listDir(join(dir, ".proposals"))) {
    if (!(await exists(join(dir, ".proposals", pid, "proposal.json")))) continue;
    const proposal = await tryParse(`.proposals/${pid}/proposal.json`, (raw) => ProposalSchema.parse(JSON.parse(raw)));
    if (!proposal) continue;
    const ripple = (await exists(join(dir, ".proposals", pid, "ripple.json")))
      ? await tryParse(`.proposals/${pid}/ripple.json`, (raw) => RipplePreviewSchema.parse(JSON.parse(raw)))
      : null;
    const proposedArtDirection =
      proposal.kind === "art-direction"
        ? await tryParse(`.proposals/${pid}/${artDirectionPath}`, (raw) =>
            ArtDirectionRecordSchema.parse(JSON.parse(raw)),
          )
        : null;
    // The review is computed here because this is the one place that has both halves: the
    // proposed file and the base captured beside it.
    const readStaged = async (rel: string): Promise<string | null> =>
      (await exists(join(dir, ".proposals", pid, ...rel.split("/"))))
        ? await readFile(toExtendedLength(join(dir, ".proposals", pid, ...rel.split("/"))), "utf8").catch(() => null)
        : null;
    const proposedByPath = new Map<string, string | null>();
    const baseByPath = new Map<string, string | null>();
    for (const t of proposal.targets) {
      proposedByPath.set(t.path, await readStaged(t.path));
      baseByPath.set(t.path, await readStaged(`_base/${t.path}`));
    }
    const review = projectReview({
      proposal,
      proposed: (path) => proposedByPath.get(path) ?? null,
      base: (path) => baseByPath.get(path) ?? null,
    });

    proposals.push({
      proposal,
      ripple,
      ...(proposedArtDirection ? { artDirection: proposedArtDirection } : {}),
      ...(review.targets.length > 0 ? { review } : {}),
    });
  }

  const changes = (await readChanges(join(dir, "changes.jsonl")))
    .map((line) => {
      const r = ChangeRecordSchema.safeParse(line);
      return r.success ? r.data : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .slice(-50);

  // One stat, not a walk: either the candidate is there or it is not.
  const keyArtCandidate = await stat(toExtendedLength(join(dir, "incoming", "world-image", "candidate.png")))
    .then(() => "incoming/world-image/candidate.png")
    .catch(() => null);
  // Same rule for the accepted key art: the disk is the truth. The art-direction page needs to
  // know it exists to stand it in while no master look is set.
  const hasKeyArt = await stat(toExtendedLength(join(dir, "world-art.png")))
    .then(() => true)
    .catch(() => false);

  const resolved = resolveArtDirection(meta, artDirectionRecord);
  const overrides: ArtDirectionOverride[] = [];
  for (const kit of referenceKits) {
    if (!kit.styleOverride?.trim()) continue;
    const sheet = sheets.find((candidate) => candidate.id === kit.sheetId);
    if (!sheet) continue;
    overrides.push({
      id: sheet.id,
      name: sheet.name,
      kind: sheet.type,
      description: kit.styleOverride.trim(),
    });
  }
  for (const production of productions) {
    if (!production.meta.styleOverride?.trim()) continue;
    overrides.push({
      id: production.meta.id,
      name: production.meta.title,
      kind: "production",
      description: production.meta.styleOverride.trim(),
    });
  }
  overrides.sort((a, b) => a.name.localeCompare(b.name));

  const visualAssets = new Set<string>();
  if (resolved.masterLook) visualAssets.add(resolved.masterLook);
  for (const entry of resolved.history) if (entry.masterLook) visualAssets.add(entry.masterLook);
  for (const artifact of artifacts) {
    if (artifact.kind === "image" || artifact.kind === "board") visualAssets.add(`artifacts/${artifact.file}`);
  }
  for (const kit of referenceKits) {
    for (const tile of kit.tiles) if (tile.file) visualAssets.add(`references/${kit.sheetId}/${tile.file}`);
    for (const compilation of kit.compilations) {
      visualAssets.add(`references/${kit.sheetId}/${compilation.file}`);
    }
  }
  for (const take of referenceTakes) {
    if (take.media && take.reference) {
      visualAssets.add(`references/${take.reference.sheetId}/takes/${take.id}/${take.media}`);
    }
  }
  for (const production of productions) {
    for (const scene of production.scenes) {
      if (scene.board) visualAssets.add(`productions/${production.meta.id}/${scene.board.image}`);
    }
    for (const take of production.takes) {
      if (take.kind !== "voice" && take.media) {
        visualAssets.add(`productions/${production.meta.id}/takes/${take.id}/${take.media}`);
      }
    }
  }

  let earlierAcceptedTakes = 0;
  // Counted alongside, because a proposal replacing the current look turns all of these into
  // earlier ones the moment it lands — see acceptedTakesAtCurrentVersion.
  let acceptedTakesAtCurrentVersion = 0;
  const countTake = (take: { kind?: string; provenance: { artDirectionVersion?: number } }): void => {
    // Voice is not a look. A line of audio records no art direction version — nothing about it
    // depends on one — and the fallback below would otherwise read that silence as "made under
    // the current look" and count it among the work a new look strands. The same scan already
    // leaves voice out of visual assets for the same reason.
    if (take.kind === "voice") return;
    // A visual take with no recorded version is a legacy or uploaded one, and the rest of the app
    // resolves that to the current look — accepting a character reference does exactly this.
    // Dropping it from both counts told somebody less work would be pinned than actually is.
    const at = take.provenance.artDirectionVersion ?? resolved.version;
    if (at < resolved.version) earlierAcceptedTakes += 1;
    else if (at === resolved.version) acceptedTakesAtCurrentVersion += 1;
  };

  const latestReferenceReviews = new Map<string, "accept" | "reject">();
  for (const review of referenceReviews) latestReferenceReviews.set(review.takeId, review.decision);
  for (const take of referenceTakes) {
    if (latestReferenceReviews.get(take.id) !== "accept") continue;
    countTake(take);
  }
  for (const production of productions) {
    const latest = new Map<string, "accept" | "reject">();
    for (const review of production.reviews) latest.set(review.takeId, review.decision);
    for (const take of production.takes) {
      if (latest.get(take.id) !== "accept") continue;
      countTake(take);
    }
  }

  const bundle: WorldBundle = {
    meta,
    artDirection: {
      ...resolved,
      reach: {
        visualAssets: visualAssets.size,
        referenceKits: referenceKits.filter((kit) => !kit.styleOverride?.trim()).length,
        productions: productions.filter((production) => !production.meta.styleOverride?.trim()).length,
        earlierAcceptedTakes,
        acceptedTakesAtCurrentVersion,
      },
      overrides,
    },
    keyArtCandidate,
    hasKeyArt,
    sheets,
    canon,
    referenceKits,
    referenceCandidates,
    referenceTakes,
    referenceReviews,
    artifacts,
    productions,
    proposals,
    // Rows only. discoverConversations reads summaries, never transcripts.
    conversations: (await discoverConversations(dir)).summaries,
    changes,
    problems,
    externalEdits: [],
    stale: false,
  };
  return { meta, bundle, problems, manifest };
}

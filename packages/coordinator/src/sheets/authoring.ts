import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SHEET_SHAPES,
  sheetDir,
  type Proposal,
  type SheetKind,
  type VoiceAssignment,
} from "@arke-studio/contracts";
import type { CommitResult } from "../world/commit.js";
import type { ProposalManager } from "../gate/proposals.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { uniqueSlug } from "../world/slug.js";
import { MarkdownFile, sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";

/**
 * Sheet authoring flows over the gate (SPEC-007). One entity, three shapes (D1): every path
 * here reads the declarative shape table and stages through SPEC-004 — nothing sheet-specific
 * touches the commit path.
 */

async function readLive(store: WorldStore, path: string): Promise<string | null> {
  try {
    return await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  } catch {
    return null;
  }
}

async function takenSlugs(store: WorldStore, type: SheetKind): Promise<string[]> {
  // Uniqueness is checked across ALL sheet collections — a location and a character sharing a
  // slug would collide in citations, which key on the slug alone.
  const slugs: string[] = [];
  for (const dir of ["characters", "locations", "factions"]) {
    const entries = await readdir(toExtendedLength(join(store.dir, dir))).catch(() => [] as string[]);
    slugs.push(...entries.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));
  }
  void type;
  return slugs;
}

/** Build a sheet file from its shape, sections ordered per the schema (D2). */
export function buildSheetContent(input: {
  id: string;
  type: SheetKind;
  name: string;
  status: "sketch" | "locked";
  sections: Record<string, string>;
  extra?: Record<string, unknown>;
  origin?: { sheet: string; version: number };
  date: string;
}): string {
  const shape = SHEET_SHAPES[input.type];
  const body = shape.sections
    .map((section) => {
      const text = (input.sections[section.heading] ?? "").trim();
      if (text === "" && !section.required) return null;
      return `## ${section.heading}\n${text === "" ? "—" : text}`;
    })
    .filter((s): s is string => s !== null)
    .join("\n\n");
  const doc = MarkdownFile.create(
    {
      id: input.id,
      type: input.type,
      name: input.name,
      ...input.extra,
      version: 1, // the committer stamps the real version
      status: input.status,
      canonRules: [],
      links: [],
      ...(input.origin ? { origin: input.origin } : {}),
      created: input.date,
      updated: input.date,
    },
    body,
  );
  return doc.serialize();
}

export interface SentenceDraft {
  proposal: Proposal;
  slug: string;
  path: string;
  /** The retrieval-scope statement the drafting agent is given (§2.5, T-6). */
  scope: string;
}

/** Creation from a sentence (R-10): a sketch skeleton staged; the agent drafts inside it. */
export async function createSheetFromSentence(
  store: WorldStore,
  gate: ProposalManager,
  input: { sheetType: SheetKind; name: string; sentence: string },
): Promise<SentenceDraft> {
  const bundle = store.getBundle();
  const slug = uniqueSlug(input.name, input.sheetType, await takenSlugs(store, input.sheetType));
  const path = `${sheetDir(input.sheetType)}/${slug}.md`;
  const shape = SHEET_SHAPES[input.sheetType];

  const sections: Record<string, string> = {};
  const firstRequired = shape.sections.find((s) => s.required)?.heading ?? shape.sections[0]!.heading;
  sections[firstRequired] = input.sentence.trim();

  const content = buildSheetContent({
    id: slug,
    type: input.sheetType,
    name: input.name,
    status: "sketch",
    sections,
    date: store.now().slice(0, 10),
  });

  const proposal = await gate.stage({
    kind: "new-sheet",
    summary: `New ${input.sheetType}: ${input.name}`,
    source: "chat:studio",
    targets: [{ path, content }],
  });

  const characters = bundle.sheets.filter((s) => s.type === "character").length;
  const scope = `drafts with: ${bundle.meta.name} · canon v${bundle.meta.canonRevision}${
    bundle.meta.tone ? ` · tone: ${bundle.meta.tone}` : ""
  } · ${characters} existing character${characters === 1 ? "" : "s"}`;

  return { proposal, slug, path, scope };
}

/** Duplication (R-12, D9): a sketch recording origin at the source's version at copy time. */
export async function duplicateSheet(
  store: WorldStore,
  gate: ProposalManager,
  input: { path: string; newName: string },
): Promise<Proposal> {
  const live = await readLive(store, input.path);
  if (live === null) throw new Error(`${input.path} does not exist`);
  const doc = MarkdownFile.parse(live);
  const type = doc.data["type"] as SheetKind;
  const sourceId = String(doc.data["id"]);
  const sourceVersion = (doc.data["version"] as number | undefined) ?? 1;
  const slug = uniqueSlug(input.newName, type, await takenSlugs(store, type));

  const copy = MarkdownFile.parse(live);
  copy.setData({
    id: slug,
    name: input.newName,
    version: 1,
    status: "sketch",
    origin: { sheet: sourceId, version: sourceVersion },
    created: store.now().slice(0, 10),
    updated: store.now().slice(0, 10),
  });

  return gate.stage({
    kind: "new-sheet",
    summary: `Duplicate ${String(doc.data["name"])} as ${input.newName} (from v${sourceVersion})`,
    source: "form",
    targets: [{ path: `${sheetDir(type)}/${slug}.md`, content: copy.serialize() }],
  });
}

/** Lock/unlock through the gate (R-6, R-8, D6) — the ripple is the honesty. */
export async function stageSheetStatus(
  store: WorldStore,
  gate: ProposalManager,
  input: { path: string; status: "sketch" | "locked" },
): Promise<Proposal> {
  const live = await readLive(store, input.path);
  if (live === null) throw new Error(`${input.path} does not exist`);
  const doc = MarkdownFile.parse(live);
  doc.setData({ status: input.status });
  return gate.stage({
    kind: "sheet-edit",
    summary:
      input.status === "locked"
        ? `Lock ${String(doc.data["name"])} to canon`
        : `Unlock ${String(doc.data["name"])} — everything citing it did so as settled`,
    source: "form",
    targets: [{ path: input.path, content: doc.serialize() }],
  });
}

/** Rename (R-2, R-3, D3): frontmatter only; the id and the file never move. */
export async function stageSheetRename(
  store: WorldStore,
  gate: ProposalManager,
  input: { path: string; name: string },
): Promise<Proposal> {
  const live = await readLive(store, input.path);
  if (live === null) throw new Error(`${input.path} does not exist`);
  const doc = MarkdownFile.parse(live);
  const oldName = String(doc.data["name"]);
  doc.setData({ name: input.name });
  return gate.stage({
    kind: "sheet-edit",
    summary: `Rename ${oldName} to ${input.name} — the id and every citation stay`,
    source: "form",
    targets: [{ path: input.path, content: doc.serialize() }],
  });
}

/** Voice assignment as a gated change (R-15): versions and ripples like any other edit. */
/**
 * Assign or clear a character's voice. This is the human's own action — the person clicking
 * Assign *is* the approval — so it commits straight to the sheet rather than staging a proposal
 * for that same person to accept. It still versions and ripples like any sheet edit; it just
 * does not wait at the gate. (Cf. `retire`/`restoreVersion`: direct human commits, not drafts.)
 */
export async function applyVoiceAssignment(
  store: WorldStore,
  input: { path: string; voice: { provider: string; voiceId: string; label?: string } | null },
): Promise<CommitResult> {
  const live = await readLive(store, input.path);
  if (live === null) throw new Error(`${input.path} does not exist`);
  const doc = MarkdownFile.parse(live);
  const currentVersion = (doc.data["version"] as number | undefined) ?? 1;
  if (input.voice === null) {
    const next = { ...doc.data };
    delete next["voice"];
    doc.data = next;
    doc.setData({});
  } else {
    const assignment: VoiceAssignment = {
      provider: input.voice.provider,
      voiceId: input.voice.voiceId,
      ...(input.voice.label !== undefined ? { label: input.voice.label } : {}),
      // The commit bumps the sheet to base + 1; the assignment lands at that version.
      assignedAtVersion: currentVersion + 1,
    };
    doc.setData({ voice: assignment });
  }
  return store.commit({
    kind: "sheet-edit",
    source: "form",
    files: [{ path: input.path, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
  });
}

// ---------------------------------------------------------------------------
// Image extraction scoping (R-11, D7) — the adversarial surface
// ---------------------------------------------------------------------------

/** What a vision pass may claim to have seen. Everything else is discarded unread. */
export interface ImageExtraction {
  appearance?: string;
  wardrobe?: string;
  apparentAge?: string;
  mood?: string;
  /** Anything else a model volunteers — names, histories, relationships — lands here and dies. */
  [key: string]: string | undefined;
}

const EVIDENCE_FIELDS = new Set(["appearance", "wardrobe", "apparentAge", "mood"]);

/**
 * Scope an extraction to what an image can evidence (D7): a vision model asked for "a
 * character sheet" invents a name and a history with the same confidence as the coat colour.
 * Name, voice, relationships and canon rules stay the author's, always.
 */
export function scopeImageExtraction(
  type: SheetKind,
  extraction: ImageExtraction,
): Record<string, string> {
  const shape = SHEET_SHAPES[type];
  const allowedSection = shape.imageEvidenceSections[0];
  if (!allowedSection) return {};
  const parts: string[] = [];
  for (const field of ["appearance", "wardrobe", "apparentAge", "mood"]) {
    const value = extraction[field];
    if (typeof value === "string" && value.trim().length > 0 && EVIDENCE_FIELDS.has(field)) {
      parts.push(value.trim());
    }
  }
  if (parts.length === 0) return {};
  return { [allowedSection]: parts.join(" ") };
}

/** Stage a sheet drafted from an image: evidenced fields only, the rest empty (R-11). */
export async function createSheetFromImage(
  store: WorldStore,
  gate: ProposalManager,
  input: {
    sheetType: SheetKind;
    /** Placeholder name — the author's to change; extraction never invents one. */
    name: string;
    extraction: ImageExtraction;
    /** The filed source artifact id, recorded as the drafting source. */
    sourceArtifactId: string;
  },
): Promise<Proposal> {
  const slug = uniqueSlug(input.name, input.sheetType, await takenSlugs(store, input.sheetType));
  const sections = scopeImageExtraction(input.sheetType, input.extraction);
  const content = buildSheetContent({
    id: slug,
    type: input.sheetType,
    name: input.name,
    status: "sketch",
    sections,
    date: store.now().slice(0, 10),
  });
  return gate.stage({
    kind: "new-sheet",
    summary: `New ${input.sheetType} from an image: ${input.name}`,
    source: `import:${input.sourceArtifactId}`,
    targets: [{ path: `${sheetDir(input.sheetType)}/${slug}.md`, content }],
  });
}

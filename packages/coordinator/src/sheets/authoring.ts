import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SHEET_SHAPES,
  sheetDir,
  worldSheets,
  type Proposal,
  type Sheet,
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
  // slug would collide in citations, which key on the slug alone. Guests are included without
  // being special-cased, because they are in the same directories: a production's one-off shares
  // the world's namespace, which is what lets promotion move nothing (SPEC-020 R-2, D2).
  const slugs: string[] = [];
  for (const dir of ["characters", "locations", "factions"]) {
    const entries = await readdir(toExtendedLength(join(store.dir, dir))).catch(() => [] as string[]);
    slugs.push(...entries.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));
  }
  void type;
  return slugs;
}

/** The prose of a sheet, sections ordered per the schema and the empty optional ones dropped (D2). */
function sheetBody(type: SheetKind, sections: Record<string, string>): string {
  return SHEET_SHAPES[type].sections
    .map((section) => {
      const text = (sections[section.heading] ?? "").trim();
      if (text === "" && !section.required) return null;
      return `## ${section.heading}\n${text === "" ? "—" : text}`;
    })
    .filter((s): s is string => s !== null)
    .join("\n\n");
}

/**
 * The same sheet with part of it changed, and every other part carried through (SPEC-007 §2.3.2).
 *
 * `buildSheetContent` writes a sheet from nothing, so whatever it is not given it omits. That is
 * right for a create and quietly destructive for an edit, which is what World Chat's sheet edits
 * used to go through: the file was rebuilt from the name, the status and the sections alone, so
 * the role, the billing, the region, the assigned voice and the duplication origin were dropped,
 * `canonRules` and `links` were reset to empty, `created` was restamped as today, and the
 * `production` that makes a sheet a guest went with them — an edit to one paragraph erased a
 * character's canon references and promoted somebody else's guest into the world.
 *
 * Written against the parsed `Sheet` rather than the file's text because `SheetSchema` is strict:
 * a sheet on disk carries these keys and no others, so restating them is faithful rather than
 * best-effort. What a conversation may not reach is taken from the sheet and never from the
 * caller — the version, the status, the retirement and the ownership each have their own flow.
 */
export function editSheetContent(input: {
  sheet: Sheet;
  /** Absent leaves the name as it is. */
  name?: string;
  /** The sections after the edit, already merged over the live ones. */
  sections: Record<string, string>;
  /**
   * Frontmatter a conversation may change. Absent leaves the field alone; null clears it — the
   * distinction the draft schema's nullable fields exist to carry, and one an edit has to keep:
   * "say nothing about the role" and "he has no role any more" are different instructions.
   */
  role?: string | null;
  billing?: string | null;
  region?: string | null;
  date: string;
}): string {
  const { sheet } = input;
  const settle = (next: string | null | undefined, current: string | undefined) =>
    next === undefined ? current : next === null ? undefined : next;
  const role = settle(input.role, sheet.role);
  const billing = settle(input.billing, sheet.billing);
  const region = settle(input.region, sheet.region);

  const doc = MarkdownFile.create(
    {
      id: sheet.id,
      type: sheet.type,
      name: input.name ?? sheet.name,
      ...(role !== undefined ? { role } : {}),
      ...(billing !== undefined ? { billing } : {}),
      ...(region !== undefined ? { region } : {}),
      // The live version, not 1: the committer stamps the real one either way, and restating what
      // the sheet actually says keeps the staged file readable as the thing it is a version of.
      version: sheet.version,
      status: sheet.status,
      ...(sheet.retired !== undefined ? { retired: sheet.retired } : {}),
      ...(sheet.production !== undefined ? { production: sheet.production } : {}),
      canonRules: [...sheet.canonRules],
      links: [...sheet.links],
      ...(sheet.origin ? { origin: sheet.origin } : {}),
      ...(sheet.voice ? { voice: sheet.voice } : {}),
      // Created once, and not by an edit. Only `updated` moves.
      created: sheet.created,
      updated: input.date,
    },
    sheetBody(sheet.type, input.sections),
  );
  return doc.serialize();
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
  /** Set to file this as a guest of that production (SPEC-020 R-1); absent means the world's. */
  production?: string;
  date: string;
}): string {
  const body = sheetBody(input.type, input.sections);
  const doc = MarkdownFile.create(
    {
      id: input.id,
      type: input.type,
      name: input.name,
      ...input.extra,
      version: 1, // the committer stamps the real version
      status: input.status,
      // Ownership sits with status: both say what this sheet currently *is*, and promotion
      // reads as a state change in the diff rather than a field appearing from nowhere.
      ...(input.production !== undefined ? { production: input.production } : {}),
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
  input: {
    sheetType: SheetKind;
    name: string;
    sentence: string;
    /** Creating from inside a production files a guest (SPEC-020 R-1). */
    production?: string;
  },
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
    ...(input.production !== undefined ? { production: input.production } : {}),
    date: store.now().slice(0, 10),
  });

  const proposal = await gate.stage({
    kind: "new-sheet",
    summary:
      input.production !== undefined
        ? `New ${input.sheetType} for ${input.production}: ${input.name}`
        : `New ${input.sheetType}: ${input.name}`,
    source: "chat:studio",
    targets: [{ path, content }],
    // Ownership on the proposal, not only in the staged file: the world's surfaces read pending
    // sheets from the proposal and would otherwise show this guest all through its review.
    ...(input.production !== undefined ? { production: input.production } : {}),
  });

  // The count the agent is told about is the world's own cast. A guest drafting against "nine
  // existing characters" when six of them belong to another production would be told the world
  // is more populated than it is.
  const characters = worldSheets(bundle.sheets).filter((s) => s.type === "character").length;
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

  // A duplicate inherits the source's frontmatter, ownership included, so duplicating a guest
  // makes another guest of the same production. The proposal has to say so or the copy shows on
  // the world's surfaces for the length of its review (SPEC-020 R-8).
  const owner = copy.data["production"];
  return gate.stage({
    kind: "new-sheet",
    summary: `Duplicate ${String(doc.data["name"])} as ${input.newName} (from v${sourceVersion})`,
    source: "form",
    targets: [{ path: `${sheetDir(type)}/${slug}.md`, content: copy.serialize() }],
    ...(typeof owner === "string" && owner !== "" ? { production: owner } : {}),
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

/**
 * Promote a guest into the world (SPEC-020 R-14, R-15): clear `production`, nothing else.
 *
 * The whole design is here. The slug does not change, so every `@` mention still resolves; the
 * file does not move, so `.history/` continues unbroken and `references/<slug>/kit.json` is
 * already in the right place; the version is not reset, so `take_sheets` rows keep pointing at
 * the take's actual provenance. Promotion is a frontmatter edit because the namespace was flat
 * from the start (D1, D2).
 *
 * Gated rather than committed direct, following rename and lock: it is a frontmatter-only human
 * edit whose effect is that the sheet appears somewhere it did not before, and the diff is worth
 * a look. There is no inverse (D7) — a sheet promoted by mistake is retired, not demoted.
 */
export async function stageGuestPromotion(
  store: WorldStore,
  gate: ProposalManager,
  input: { path: string },
): Promise<Proposal> {
  const live = await readLive(store, input.path);
  if (live === null) throw new Error(`${input.path} does not exist`);
  const doc = MarkdownFile.parse(live);
  const owner = doc.data["production"];
  if (typeof owner !== "string" || owner === "") {
    throw new Error(`${input.path} is not a guest — it already belongs to the world`);
  }
  // Deleting the key, not setting it empty: absent is what "the world owns this" means, and an
  // empty string would read as a guest of a production with no name everywhere downstream.
  const next = { ...doc.data };
  delete next["production"];
  doc.data = next;
  doc.setData({});
  return gate.stage({
    kind: "sheet-edit",
    summary: `Promote ${String(doc.data["name"])} out of ${owner} and into the world — the id and every citation stay`,
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
    /** Drafting from inside a production files a guest (SPEC-020 R-1). */
    production?: string;
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
    ...(input.production !== undefined ? { production: input.production } : {}),
    date: store.now().slice(0, 10),
  });
  return gate.stage({
    kind: "new-sheet",
    summary: `New ${input.sheetType} from an image: ${input.name}`,
    source: `import:${input.sourceArtifactId}`,
    targets: [{ path: `${sheetDir(input.sheetType)}/${slug}.md`, content }],
    ...(input.production !== undefined ? { production: input.production } : {}),
  });
}

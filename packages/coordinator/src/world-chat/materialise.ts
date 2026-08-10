import {
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
  CanonEntrySchema,
  SheetSchema,
  type Sheet,
  type WorldBundle,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { ZodError } from "zod";
import { entryContent } from "../canon/authoring.js";
import { buildSheetContent } from "../sheets/authoring.js";
import { uniqueSlug } from "../world/slug.js";
import { MarkdownFile } from "../world/text-files.js";

/**
 * Turning a proposition into the files a proposal is made of (#70 §11.2).
 *
 * The coordinator writes every one of them. The model never serialises anything authoritative,
 * and this is where that promise is kept: it proposed a title and a statement, and the frontmatter,
 * the id, the version, the section order and the file's shape are all decided here.
 *
 * Everything is parsed through its own domain schema before a single file is written. A malformed
 * candidate has to fail wrap-up without leaving a proposal directory behind, because a directory
 * that exists but cannot be accepted is worse than no directory: it sits on the approvals screen
 * asking for a decision nobody can make.
 */

export class MaterialiseError extends Error {
  constructor(
    readonly candidateId: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "MaterialiseError";
  }
}

export interface Identities {
  /** Canon ids reserved for this wrap-up, in the order its creates were planned. */
  canonIds: string[];
  /** Slugs chosen for new sheets, keyed by the candidate that creates them. */
  slugBy: Map<string, string>;
}

export interface MaterialisedTarget {
  path: string;
  content: string;
}

export interface Materialised {
  candidate: WorldChangeCandidate;
  targets: MaterialisedTarget[];
  /** Which fields this proposition actually changes, for the origin record. */
  fields: string[];
  reservedCanonIds: string[];
}

/**
 * Choose the identities a wrap-up needs, all at once (§11.3 step 3).
 *
 * Together rather than one at a time because two new entities in the same wrap-up may refer to
 * each other: the graph can only be resolved once every name in it exists.
 */
export function planIdentities(
  carried: readonly WorldChangeCandidate[],
  reservedCanonIds: readonly string[],
  bundle: WorldBundle,
): Identities {
  const canonIds = [...reservedCanonIds];
  const slugBy = new Map<string, string>();
  const taken = bundle.sheets.map((s) => s.id);

  for (const candidate of carried) {
    if (candidate.classification !== "sheet.create") continue;
    const draft = candidate.draft as { type: Sheet["type"]; name: string };
    // Uniqueness is checked against slugs chosen earlier in this same wrap-up as well as those
    // on disk: two new characters with similar names must not collide on one file.
    const slug = uniqueSlug(draft.name, draft.type, [...taken, ...slugBy.values()]);
    slugBy.set(candidate.id, slug);
    taken.push(slug);
  }
  return { canonIds, slugBy };
}

/** How many Canon ids this wrap-up must reserve before it can write anything. */
export function canonIdsNeeded(carried: readonly WorldChangeCandidate[]): number {
  return carried.filter(
    (c) => c.classification === "canon.create" || c.classification === "canon.thread",
  ).length;
}

function requireEntry(bundle: WorldBundle, entryId: string, candidateId: string) {
  const entry = bundle.canon.find((c) => c.id === entryId);
  if (!entry) throw new MaterialiseError(candidateId, `canon entry ${entryId} is not in this world`);
  return entry;
}

function requireSheet(bundle: WorldBundle, sheetId: string, candidateId: string): Sheet {
  const sheet = bundle.sheets.find((s) => s.id === sheetId);
  if (!sheet) throw new MaterialiseError(candidateId, `sheet ${sheetId} is not in this world`);
  return sheet;
}

/** Parse what was built through the schema the world reads it with, before it is written. */
function validateCanon(candidateId: string, content: string, id: string): void {
  try {
    const doc = MarkdownFile.parse(content);
    CanonEntrySchema.parse({ ...doc.data, body: doc.body.trim() });
  } catch (err) {
    throw new MaterialiseError(candidateId, `${id} would not read back: ${detailOf(err)}`);
  }
}

function detailOf(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
      .join("; ")
      .slice(0, 300);
  }
  return err instanceof Error ? err.message.slice(0, 300) : "unreadable";
}

export function materialiseCandidate(
  candidate: WorldChangeCandidate,
  identities: Identities,
  bundle: WorldBundle,
  /** The whole instant, not the day: the world-look record stamps a full timestamp. */
  at: string,
  nextCanonId: () => string,
): Materialised {
  const draft = candidate.draft as Record<string, unknown>;
  const date = at.slice(0, 10);

  switch (candidate.classification) {
    case "canon.create": {
      const id = nextCanonId();
      const content = entryContent({
        id,
        type: String(draft["type"]),
        title: String(draft["title"]),
        status: "settled",
        statement: String(draft["statement"]),
      });
      validateCanon(candidate.id, content, id);
      return {
        candidate,
        targets: [{ path: `canon/${id}.md`, content }],
        fields: ["title", "statement"],
        reservedCanonIds: [id],
      };
    }

    case "canon.thread": {
      const id = nextCanonId();
      // A thread asserts nothing, so it is created open rather than settled: retrieving one would
      // answer a question with the same question.
      const content = entryContent({
        id,
        type: "thread",
        title: String(draft["title"]),
        status: "open",
        statement: String(draft["question"]),
      });
      validateCanon(candidate.id, content, id);
      return {
        candidate,
        targets: [{ path: `canon/${id}.md`, content }],
        fields: ["question"],
        reservedCanonIds: [id],
      };
    }

    case "canon.amend": {
      const target = (candidate as unknown as { target: { entryId: string } }).target;
      const entry = requireEntry(bundle, target.entryId, candidate.id);
      const content = entryContent({
        id: entry.id,
        type: String(draft["type"] ?? entry.type),
        title: String(draft["title"] ?? entry.title),
        // Only a thread stays open; anything else an amendment produces asserts something, so it
        // is settled. A `proposed` entry being amended becomes the settled form of itself rather
        // than carrying a status the entry writer has no way to express.
        status: entry.status === "open" ? "open" : "settled",
        statement: String(draft["statement"] ?? entry.body),
      });
      validateCanon(candidate.id, content, entry.id);
      return {
        candidate,
        targets: [{ path: `canon/${entry.id}.md`, content }],
        fields: Object.keys(draft),
        reservedCanonIds: [],
      };
    }

    case "sheet.create": {
      const slug = identities.slugBy.get(candidate.id);
      if (!slug) throw new MaterialiseError(candidate.id, "no slug was planned for this new sheet");
      const sections: Record<string, string> = {};
      for (const section of (draft["sections"] as Array<{ heading: string; body: string }>) ?? []) {
        sections[section.heading] = section.body;
      }
      const content = buildSheetContent({
        id: slug,
        type: draft["type"] as Sheet["type"],
        name: String(draft["name"]),
        // New entities arrive as sketches, never locked: what a conversation produced is an
        // invitation to work on it, not a finished thing.
        status: "sketch",
        sections,
        date,
        ...(draft["role"] !== undefined ? { extra: { role: draft["role"] } } : {}),
      });
      assertSheetParses(candidate.id, content, draft["type"] as Sheet["type"]);
      return {
        candidate,
        targets: [{ path: `${folderFor(draft["type"] as Sheet["type"])}/${slug}.md`, content }],
        fields: ["name", ...Object.keys(sections)],
        reservedCanonIds: [],
      };
    }

    case "sheet.edit": {
      const target = (candidate as unknown as { target: { sheetId: string; sheetKind: Sheet["type"] } }).target;
      const sheet = requireSheet(bundle, target.sheetId, candidate.id);
      const sections: Record<string, string> = {};
      for (const section of sheet.sections) sections[section.heading] = section.body;
      for (const section of (draft["sections"] as Array<{ heading: string; body: string }>) ?? []) {
        sections[section.heading] = section.body;
      }
      const content = buildSheetContent({
        id: sheet.id,
        type: sheet.type,
        name: String(draft["name"] ?? sheet.name),
        status: sheet.status,
        sections,
        date,
      });
      assertSheetParses(candidate.id, content, sheet.type);
      return {
        candidate,
        targets: [{ path: `${folderFor(sheet.type)}/${sheet.id}.md`, content }],
        fields: Object.keys(draft),
        reservedCanonIds: [],
      };
    }

    case "relationship.change": {
      // The minimum necessary target: a one-sided link changes one sheet, and changing both
      // would put an edit in front of somebody for a file they did not agree to touch.
      const edits = (draft["proseEdits"] as Array<{ sheet: { sheetId?: string }; sectionHeading: string; body: string }>) ?? [];
      const targets: MaterialisedTarget[] = [];
      const fields: string[] = [];
      for (const edit of edits) {
        const sheetId = edit.sheet.sheetId;
        if (!sheetId) continue;
        const sheet = requireSheet(bundle, sheetId, candidate.id);
        const sections: Record<string, string> = {};
        for (const section of sheet.sections) sections[section.heading] = section.body;
        sections[edit.sectionHeading] = edit.body;
        const content = buildSheetContent({
          id: sheet.id,
          type: sheet.type,
          name: sheet.name,
          status: sheet.status,
          sections,
          date,
        });
        assertSheetParses(candidate.id, content, sheet.type);
        targets.push({ path: `${folderFor(sheet.type)}/${sheet.id}.md`, content });
        fields.push(edit.sectionHeading);
      }
      if (targets.length === 0) {
        throw new MaterialiseError(candidate.id, "this relationship change would edit no file");
      }
      return { candidate, targets, fields, reservedCanonIds: [] };
    }

    case "art-direction.change": {
      /*
       * The next world look, written whole.
       *
       * The same record `stageArtDirectionChange` builds from the form, because there is only one
       * world look and two ways of writing it would drift. The previous version is pushed onto
       * history rather than discarded — accepted takes stay pinned to the look they were made
       * under, and the history is how they still resolve.
       *
       * `masterLook` is dropped rather than carried: it is an image of the look being replaced,
       * and holding it against a new description would misdescribe every generation that read it.
       */
      const current = bundle.artDirection;
      const record = ArtDirectionRecordSchema.parse({
        version: current.version + 1,
        description: String(draft["description"]).trim(),
        acceptedAt: at,
        history: [
          ...current.history,
          {
            version: current.version,
            description: current.description,
            ...(current.masterLook ? { masterLook: current.masterLook } : {}),
            acceptedAt: current.acceptedAt ?? bundle.meta.created,
          },
        ],
      });
      return {
        candidate,
        targets: [{ path: ART_DIRECTION_PATH, content: `${JSON.stringify(record, null, 2)}\n` }],
        fields: ["description"],
        reservedCanonIds: [],
      };
    }

    default:
      // Media opportunities and undecided propositions never reach here — readiness holds them
      // back — and a new classification arriving without a case is a mistake worth failing on.
      throw new MaterialiseError(candidate.id, `${candidate.classification} cannot become a proposal`);
  }
}

function folderFor(kind: Sheet["type"]): string {
  return kind === "character" ? "characters" : kind === "location" ? "locations" : "factions";
}

/**
 * Prove the built sheet is one the world can read back.
 *
 * Building content and never parsing it is how a proposal comes to hold a file the scanner will
 * silently drop — the entity would simply be missing after accept, with nothing to point at.
 */
function assertSheetParses(candidateId: string, content: string, type: Sheet["type"]): void {
  try {
    const doc = MarkdownFile.parse(content);
    SheetSchema.parse({ ...doc.data, type, sections: doc.sections() });
  } catch (err) {
    throw new MaterialiseError(candidateId, `the built sheet would not read back: ${detailOf(err)}`);
  }
}

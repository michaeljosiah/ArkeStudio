import { CanonEntrySchema, SheetSchema, type Proposal } from "@arke-studio/contracts";
import { MarkdownFile } from "../world/text-files.js";

/**
 * What a proposal would actually change, field by field (#70 §11.5).
 *
 * Derived from the captured base and the proposed file, never from what anything said it was
 * changing. That is the whole point: a summary is a claim, and the reason to compute this is so
 * the screen shows what will happen rather than what somebody meant to happen. If the two ever
 * disagree, the files win, because the files are what the accept gate writes.
 *
 * A proposal that lists three targets and a one-line summary tells a reviewer almost nothing. A
 * reviewer needs the sentence that is there now beside the sentence that would replace it, which
 * is what design turn 41b shows and what this produces.
 */

export interface ReviewField {
  field: string;
  before: string | null;
  proposed: string | null;
}

export interface ReviewTarget {
  path: string;
  /** How the reviewer knows what they are looking at: "Maren Kest", "CANON-018". */
  label: string;
  /** "character sheet · v4", "canon entry", "new rule". */
  kind: string;
  action: "create" | "amend";
  fields: ReviewField[];
}

export interface ReviewProjection {
  targets: ReviewTarget[];
}

/** Parse a sheet or canon file into comparable fields, or null when it is neither. */
function fieldsOf(path: string, content: string): { label: string; kind: string; fields: Map<string, string> } | null {
  let doc;
  try {
    doc = MarkdownFile.parse(content);
  } catch {
    return null;
  }

  if (path.startsWith("canon/")) {
    const parsed = CanonEntrySchema.safeParse({ ...doc.data, body: doc.body.trim() });
    if (!parsed.success) return null;
    const entry = parsed.data;
    return {
      label: entry.title,
      kind: entry.status === "open" ? "open thread" : `canon · ${entry.type}`,
      fields: new Map([
        ["Title", entry.title],
        ["Statement", entry.body],
      ]),
    };
  }

  const type = path.startsWith("characters/")
    ? "character"
    : path.startsWith("locations/")
      ? "location"
      : path.startsWith("factions/")
        ? "faction"
        : null;
  if (!type) return null;

  const parsed = SheetSchema.safeParse({ ...doc.data, type, sections: doc.sections() });
  if (!parsed.success) return null;
  const sheet = parsed.data;
  const fields = new Map<string, string>([["Name", sheet.name]]);
  if (sheet.role !== undefined) fields.set("Role", sheet.role);
  if (sheet.region !== undefined) fields.set("Region", sheet.region);
  for (const section of sheet.sections) fields.set(section.heading, section.body);
  return { label: sheet.name, kind: `${type} sheet · v${sheet.version}`, fields };
}

export interface ReviewInput {
  proposal: Proposal;
  /** The proposed file for a path, as staged. */
  proposed: (path: string) => string | null;
  /** The base captured with the proposal, or null for a create. */
  base: (path: string) => string | null;
}

/**
 * Compare base with proposed and keep only what differs.
 *
 * Unchanged fields are dropped deliberately. A review that lists every field of a sheet buries
 * the one line that changed among fifteen that did not, and the reviewer's job is to judge the
 * change, not to find it.
 */
export function projectReview(input: ReviewInput): ReviewProjection {
  const targets: ReviewTarget[] = [];

  for (const target of input.proposal.targets) {
    const proposedRaw = input.proposed(target.path);
    if (proposedRaw === null) continue;
    const proposed = fieldsOf(target.path, proposedRaw);
    if (!proposed) continue;

    const baseRaw = input.base(target.path);
    const base = baseRaw === null ? null : fieldsOf(target.path, baseRaw);
    const action: ReviewTarget["action"] = base === null ? "create" : "amend";

    const fields: ReviewField[] = [];
    for (const [field, value] of proposed.fields) {
      const before = base?.fields.get(field) ?? null;
      if (before === value) continue;
      fields.push({ field, before, proposed: value });
    }
    // A field the proposal removes is a change too, and one a reviewer would want to see.
    if (base) {
      for (const [field, value] of base.fields) {
        if (!proposed.fields.has(field)) fields.push({ field, before: value, proposed: null });
      }
    }

    targets.push({
      path: target.path,
      label: proposed.label,
      kind: action === "create" ? newKindOf(proposed.kind) : proposed.kind,
      action,
      fields,
    });
  }

  return { targets };
}

/** A create has no version to show, and "new" is the thing the reviewer needs to notice. */
function newKindOf(kind: string): string {
  if (kind.startsWith("canon · ")) return `new ${kind.slice("canon · ".length)}`;
  if (kind === "open thread") return "new open thread";
  const sheet = /^(\w+) sheet/.exec(kind);
  return sheet ? `new ${sheet[1]} sheet` : `new ${kind}`;
}

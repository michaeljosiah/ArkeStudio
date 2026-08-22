import { createHash } from "node:crypto";
import type { CanonEntry, Sheet, WorldChatEntityRef } from "@arke-studio/contracts";

/**
 * How the app identifies "the content of this thing, as it was when we looked" (#70 §5.7, §5.8).
 *
 * One definition, used by both the receipt that records an observation and the evidence that
 * cites it. If those two computed the hash differently, every quotation would fail to verify
 * against the receipt that supposedly produced it — and the failure would look like tampering
 * rather than like the arithmetic mismatch it actually was.
 */

export function contentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export interface Observation {
  ref: WorldChatEntityRef;
  observedVersion: number;
  contentHash: string;
}

/**
 * A Canon entry is observed at the world's Canon revision rather than any per-entry number:
 * amendments move the world revision, and that is what "still current" means for Canon.
 */
export function canonObservation(entry: CanonEntry, canonRevision: number): Observation {
  return {
    ref: { kind: "canon", entryId: entry.id },
    observedVersion: canonRevision,
    contentHash: contentHash({
      id: entry.id,
      title: entry.title,
      body: entry.body,
      status: entry.status,
    }),
  };
}

export function sheetObservation(sheet: Sheet): Observation {
  return {
    ref: { kind: "sheet", sheetKind: sheet.type, sheetId: sheet.id },
    observedVersion: sheet.version,
    contentHash: contentHash({
      id: sheet.id,
      name: sheet.name,
      version: sheet.version,
      sections: sheet.sections,
    }),
  };
}

/** The text a world quotation may be checked against, by field or across the whole entity. */
export function quotableText(entity: CanonEntry | Sheet, field?: string): string {
  if ("body" in entity) {
    if (field === "title") return entity.title;
    if (field === "statement" || field === "body") return entity.body;
    // A blank line, not a bare newline (review 2026-08-22): the join is a seam between two
    // fields, and the quote matcher treats a paragraph break as a boundary — so a quotation
    // can no longer run from the title into the body as though the source wrote them as one.
    return `${entity.title}\n\n${entity.body}`;
  }
  if (field !== undefined) {
    const section = entity.sections.find((s) => s.heading === field);
    if (section) return section.body;
    if (field === "name") return entity.name;
    if (field === "role") return entity.role ?? "";
    if (field === "region") return entity.region ?? "";
    return "";
  }
  // The same seam rule as canon: these are separate fields, and a quotation must not read
  // across them as though the sheet wrote them as one sentence (review 2026-08-22).
  return [entity.name, entity.role ?? "", entity.region ?? "", ...entity.sections.map((s) => s.body)].join(
    "\n\n",
  );
}

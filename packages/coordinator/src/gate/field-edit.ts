import { MarkdownFile } from "../world/text-files.js";

/**
 * Writing back the field the review projection showed (#70 §11.4.1, §12.1).
 *
 * This is the exact inverse of `fieldsOf` in review.ts, and it has to stay that way: the person
 * is editing the labelled line they were shown — "Statement", "Role", "Ancestry" — so the label
 * is the address. Keeping the two in one vocabulary is what makes an edit land where the reviewer
 * pointed, rather than somewhere that merely sounds similar.
 *
 * A field the projection did not offer is refused rather than invented. An edit may only change a
 * value; it may not add a frontmatter key nobody displayed, because the reviewer could not have
 * seen what they were agreeing to.
 */

export type FieldEditProblem =
  { kind: "unparsable-target"; path: string } | { kind: "unknown-field"; path: string; field: string };

export type FieldEditResult = { ok: true; content: string } | { ok: false; problem: FieldEditProblem };

/** Frontmatter fields a sheet exposes for editing, by the label the projection prints. */
const SHEET_FRONTMATTER: Record<string, string> = { Name: "name", Role: "role", Region: "region" };

/**
 * Apply one labelled edit to a target file, returning its complete next contents.
 *
 * Everything is whole-file: the journal records complete contents rather than a patch, so a
 * half-applied edit is not a state the recovery path has to reason about.
 */
export function applyFieldEdit(path: string, content: string, field: string, value: string): FieldEditResult {
  let doc: MarkdownFile;
  try {
    doc = MarkdownFile.parse(content);
  } catch {
    return { ok: false, problem: { kind: "unparsable-target", path } };
  }

  if (path.startsWith("canon/")) {
    if (field === "Title") {
      doc.setData({ title: value.trim() });
      return { ok: true, content: doc.serialize() };
    }
    if (field === "Statement") {
      doc.setBody(value.trim());
      return { ok: true, content: doc.serialize() };
    }
    return { ok: false, problem: { kind: "unknown-field", path, field } };
  }

  const key = SHEET_FRONTMATTER[field];
  if (key) {
    const trimmed = value.trim();
    // Cleared means absent, not empty — the same rule stageSheetEdit follows for `role`, and for
    // the same reason: an empty string reads back as a value that is present but says nothing.
    // A name is the one field that cannot be cleared, because it is what the sheet is called.
    if (trimmed === "" && key !== "name") {
      const { [key]: _cleared, ...rest } = doc.data;
      doc.data = rest;
      doc.setBody(doc.body);
      return { ok: true, content: doc.serialize() };
    }
    if (trimmed === "") return { ok: false, problem: { kind: "unknown-field", path, field } };
    doc.setData({ [key]: trimmed });
    return { ok: true, content: doc.serialize() };
  }

  // Otherwise the label is a section heading. Only an existing one: adding a section is a change
  // to the shape of the sheet, not to a value, and nothing in the review projection offered it.
  const sections = doc.sections();
  if (!sections.some((s) => s.heading === field)) {
    return { ok: false, problem: { kind: "unknown-field", path, field } };
  }
  doc.setBody(
    sections.map((s) => `## ${s.heading}\n${(s.heading === field ? value : s.body).trim()}`).join("\n\n"),
  );
  return { ok: true, content: doc.serialize() };
}

/** What the person is told when an edit cannot be applied. Never echoes the value they typed. */
export function safeFieldEditMessage(problem: FieldEditProblem): string {
  switch (problem.kind) {
    case "unparsable-target":
      return "That file could not be read as a sheet or canon entry, so it cannot be edited here.";
    case "unknown-field":
      return "That field is not one this proposal offers for editing.";
  }
}

import YAML from "yaml";

/**
 * Markdown-with-YAML-frontmatter parsing (master spec §2.3.2–§2.3.3).
 *
 * SPEC-001 needs just enough to read the fixture world; SPEC-002 hardens this into the real
 * parser (CRLF, BOM, hand-edit tolerance) and owns serialisation for the write path.
 */

export interface FrontmatterFile {
  /** The parsed YAML frontmatter object. */
  data: Record<string, unknown>;
  /** Everything below the closing delimiter, trimmed of the leading blank line. */
  body: string;
}

export class FrontmatterError extends Error {}

/** Parse a `---` delimited frontmatter document. Tolerates CRLF and a UTF-8 BOM. */
export function parseFrontmatter(raw: string): FrontmatterFile {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    throw new FrontmatterError("expected the file to open with a --- frontmatter delimiter");
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    throw new FrontmatterError("unterminated frontmatter: no closing --- delimiter");
  }
  const yamlText = text.slice(4, end + 1);
  const afterDelimiter = text.indexOf("\n", end + 1);
  const body = afterDelimiter === -1 ? "" : text.slice(afterDelimiter + 1).replace(/^\n/, "");
  const data = YAML.parse(yamlText) as unknown;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new FrontmatterError("frontmatter must be a YAML mapping");
  }
  return { data: data as Record<string, unknown>, body };
}

export interface BodySection {
  heading: string;
  body: string;
}

/**
 * Split a sheet body into its `## ` sections, in authored order. Text before the first
 * heading is rejected — a sheet's prose lives under headings (§2.3.2).
 */
export function splitSections(body: string): BodySection[] {
  const sections: BodySection[] = [];
  let current: BodySection | null = null;
  const leading: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^## (.+)$/.exec(line);
    if (m) {
      if (current) sections.push({ ...current, body: current.body.trim() });
      current = { heading: m[1]!.trim(), body: "" };
    } else if (current) {
      current.body += (current.body ? "\n" : "") + line;
    } else if (line.trim() !== "") {
      leading.push(line);
    }
  }
  if (leading.length > 0) {
    throw new FrontmatterError(`sheet prose must live under a ## heading; found: "${leading[0]}"`);
  }
  if (current) sections.push({ ...current, body: current.body.trim() });
  return sections;
}

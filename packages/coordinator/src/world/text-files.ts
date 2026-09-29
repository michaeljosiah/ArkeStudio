import { createHash } from "node:crypto";
import YAML from "yaml";
import { FrontmatterError, parseFrontmatter, splitSections, type BodySection } from "../frontmatter.js";

/**
 * Round-trip-faithful documents (SPEC-002 R-4..R-6).
 *
 * A document holds its original raw text. Serialising an unmodified document returns that raw
 * text byte-for-byte (R-5); only a mutation re-serialises, and then every key parsed from the
 * file — including keys this build has never heard of — survives (R-6). Writes are UTF-8
 * without BOM with LF endings; reads tolerate CRLF and a BOM (R-4).
 */

export function sha256(text: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export interface MarkdownDoc {
  readonly raw: string;
  readonly data: Record<string, unknown>;
  readonly body: string;
  readonly modified: boolean;
}

export class MarkdownFile implements MarkdownDoc {
  readonly raw: string;
  data: Record<string, unknown>;
  body: string;
  private dirty = false;

  private constructor(raw: string, data: Record<string, unknown>, body: string) {
    this.raw = raw;
    this.data = data;
    this.body = body;
  }

  static parse(raw: string): MarkdownFile {
    const { data, body } = parseFrontmatter(raw);
    return new MarkdownFile(raw, data, body);
  }

  static create(data: Record<string, unknown>, body: string): MarkdownFile {
    const doc = new MarkdownFile("", data, body);
    doc.dirty = true;
    return doc;
  }

  get modified(): boolean {
    return this.dirty;
  }

  /** Merge frontmatter updates; unknown existing keys are preserved untouched (R-6). */
  setData(updates: Record<string, unknown>): void {
    this.data = { ...this.data, ...updates };
    this.dirty = true;
  }

  setBody(body: string): void {
    this.body = body;
    this.dirty = true;
  }

  /** Remove one frontmatter key, when it is there; the rest is preserved untouched (R-6). */
  dropData(key: string): void {
    if (!(key in this.data)) return;
    this.data = Object.fromEntries(Object.entries(this.data).filter(([name]) => name !== key));
    this.dirty = true;
  }

  sections(): BodySection[] {
    return splitSections(this.body);
  }

  /** Unmodified → the original bytes (R-5). Modified → stable re-serialisation, LF, no BOM. */
  serialize(): string {
    if (!this.dirty && this.raw !== "") return this.raw;
    const yaml = YAML.stringify(this.data, {
      lineWidth: 0,
      defaultKeyType: "PLAIN",
      defaultStringType: "PLAIN",
    }).trimEnd();
    const body = this.body.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
    return `---\n${yaml}\n---\n\n${body}\n`;
  }
}

export interface JsonDoc {
  readonly raw: string;
  readonly value: Record<string, unknown>;
  readonly modified: boolean;
}

export class JsonFile implements JsonDoc {
  readonly raw: string;
  value: Record<string, unknown>;
  private dirty = false;

  private constructor(raw: string, value: Record<string, unknown>) {
    this.raw = raw;
    this.value = value;
  }

  static parse(raw: string): JsonFile {
    const text = raw.replace(/^﻿/, "");
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new FrontmatterError("expected a JSON object at the top level");
    }
    return new JsonFile(raw, value as Record<string, unknown>);
  }

  static create(value: Record<string, unknown>): JsonFile {
    const doc = new JsonFile("", value);
    doc.dirty = true;
    return doc;
  }

  get modified(): boolean {
    return this.dirty;
  }

  /** Merge updates; unknown fields already present are preserved (R-6). */
  set(updates: Record<string, unknown>): void {
    this.value = { ...this.value, ...updates };
    this.dirty = true;
  }

  serialize(): string {
    if (!this.dirty && this.raw !== "") return this.raw;
    return `${JSON.stringify(this.value, null, 2)}\n`;
  }
}

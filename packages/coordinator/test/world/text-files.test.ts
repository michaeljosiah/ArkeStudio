import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURE_WORLD } from "./helpers.js";
import { JsonFile, MarkdownFile, sha256 } from "../../src/world/text-files.js";

describe("round-trip fidelity (R-4, R-5, R-6)", () => {
  it("serialises an unmodified markdown entity byte-identically (R-5)", async () => {
    const raw = await readFile(join(FIXTURE_WORLD, "characters", "maren-kest.md"), "utf8");
    const doc = MarkdownFile.parse(raw);
    assert.equal(doc.serialize(), raw);
    assert.equal(sha256(doc.serialize()), sha256(raw));
  });

  it("serialises an unmodified JSON entity byte-identically (R-5)", async () => {
    const raw = await readFile(join(FIXTURE_WORLD, "world.json"), "utf8");
    const doc = JsonFile.parse(raw);
    assert.equal(doc.serialize(), raw);
  });

  it("parses CRLF frontmatter correctly — the Arke regression (R-4, D2)", () => {
    const crlf = "---\r\nid: maren-kest\r\nversion: 4\r\n---\r\n\r\n## Essence\r\nText.\r\n";
    const doc = MarkdownFile.parse(crlf);
    assert.equal(doc.data["id"], "maren-kest", "keys must not silently fail on CRLF");
    assert.equal(doc.data["version"], 4);
    assert.notDeepEqual(doc.data, {}, "the document must not parse empty");
  });

  it("preserves unknown frontmatter keys across a read-modify-write cycle (R-6)", () => {
    const raw = "---\nid: maren-kest\nversion: 4\nfutureKey: kept\nnested:\n  a: 1\n---\n\n## Essence\nX.\n";
    const doc = MarkdownFile.parse(raw);
    doc.setData({ version: 5 });
    const out = doc.serialize();
    const reparsed = MarkdownFile.parse(out);
    assert.equal(reparsed.data["futureKey"], "kept");
    assert.deepEqual(reparsed.data["nested"], { a: 1 });
    assert.equal(reparsed.data["version"], 5);
  });

  it("preserves unknown JSON fields across a read-modify-write cycle (R-6)", () => {
    const raw = '{\n  "id": "sc_04",\n  "version": 1,\n  "futureField": {"deep": true}\n}\n';
    const doc = JsonFile.parse(raw);
    doc.set({ version: 2 });
    const reparsed = JsonFile.parse(doc.serialize());
    assert.deepEqual(reparsed.value["futureField"], { deep: true });
    assert.equal(reparsed.value["version"], 2);
  });

  it("writes LF, never CRLF, and strips a BOM on read (R-4)", () => {
    const doc = MarkdownFile.parse("﻿---\nid: a-b\n---\n\n## Look\r\nStone.\r\n");
    assert.equal(doc.data["id"], "a-b");
    doc.setBody("## Look\r\nNew stone.\r\n");
    const out = doc.serialize();
    assert.ok(!out.includes("\r"), "serialised output must be LF only");
    assert.ok(!out.startsWith("﻿"), "no BOM on write");
  });
});

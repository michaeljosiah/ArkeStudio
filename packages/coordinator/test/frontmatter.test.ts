import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FrontmatterError, parseFrontmatter, splitSections } from "../src/frontmatter.js";

describe("frontmatter", () => {
  it("parses YAML frontmatter and body", () => {
    const { data, body } = parseFrontmatter(
      "---\nid: maren-kest\nversion: 4\nlinks: [a-b, c-d]\n---\n\n## Essence\nText here.\n",
    );
    assert.equal(data["id"], "maren-kest");
    assert.equal(data["version"], 4);
    assert.deepEqual(data["links"], ["a-b", "c-d"]);
    assert.equal(body, "## Essence\nText here.\n");
  });

  it("tolerates CRLF line endings — worlds get hand-edited on Windows", () => {
    const { data, body } = parseFrontmatter("---\r\nid: x-y\r\n---\r\n\r\n## Look\r\nStone.\r\n");
    assert.equal(data["id"], "x-y");
    assert.deepEqual(splitSections(body), [{ heading: "Look", body: "Stone." }]);
  });

  it("keeps dates as strings, not YAML timestamps", () => {
    const { data } = parseFrontmatter('---\ncreated: "2026-05-02"\n---\nbody\n');
    assert.equal(typeof data["created"], "string");
  });

  it("splits sections in authored order", () => {
    const sections = splitSections("## Essence\nA.\nB.\n\n## Appearance\nC.\n");
    assert.deepEqual(sections, [
      { heading: "Essence", body: "A.\nB." },
      { heading: "Appearance", body: "C." },
    ]);
  });

  it("fails loudly at the boundary on malformed input", () => {
    assert.throws(() => parseFrontmatter("no frontmatter here"), FrontmatterError);
    assert.throws(() => parseFrontmatter("---\nid: x\n"), FrontmatterError);
    assert.throws(() => parseFrontmatter("---\n- just\n- a list\n---\nbody"), FrontmatterError);
    assert.throws(() => splitSections("prose before any heading\n## Essence\nA."), FrontmatterError);
  });
});

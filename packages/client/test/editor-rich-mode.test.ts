import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeRichModeRefusal,
  RICH_MODE_MAX_CHARACTERS,
} from "../src/components/editor/rich-mode.js";
import { serializeMarkdown } from "../src/components/editor/round-trip.js";

/**
 * The gate in front of the rich editor.
 *
 * Each refusal is paired with the round trip that justifies it, so the list cannot drift away from
 * what the editor actually does: if a future extension makes one of these survive, the assertion
 * about the round trip fails first and says so.
 */

describe("choosing an editor for a bible", () => {
  it("lets ordinary prose through", () => {
    const bible = `## The tides

The tide is the world's clock and its accountant.

* salt in the rigging
* verse under the hull

> She hears the verse under the harbour.

| Name  | Role        |
| ----- | ----------- |
| Maren | Tide-caller |

- [ ] name the third harbour
`;
    assert.equal(describeRichModeRefusal(bible), null);
  });

  it("refuses HTML, because the editor would escape it into visible text", () => {
    assert.equal(serializeMarkdown("text with <br> break"), "text with &lt;br&gt; break");
    assert.equal(describeRichModeRefusal("text with <br> break")?.reason, "html");
    assert.equal(describeRichModeRefusal("<!-- a note to self -->")?.reason, "html");
  });

  it("refuses footnotes, because the editor would escape them into visible brackets", () => {
    const bible = "The verse is older than the harbour[^1]\n\n[^1]: or so they say\n";
    assert.equal(
      serializeMarkdown(bible),
      "The verse is older than the harbour\\[^1\\]\n\n\\[^1\\]: or so they say",
      "the marker and the note both come back as literal text",
    );
    assert.equal(describeRichModeRefusal(bible)?.reason, "footnotes");
  });

  it("refuses reference-style links, because the editor would inline every one of them", () => {
    const bible = "see [the charter][c]\n\n[c]: https://example.com\n";
    assert.equal(serializeMarkdown(bible), "see [the charter](https://example.com)");
    assert.equal(describeRichModeRefusal(bible)?.reason, "reference-links");
  });

  it("reads code as quoted, not as markup", () => {
    const fenced = "## Notes\n\n```html\n<div>an example</div>\n```\n";
    assert.equal(describeRichModeRefusal(fenced), null, "a tag inside a fence is a string");
    assert.equal(describeRichModeRefusal("use `<br>` for a line break"), null, "and so is one in a span");
    assert.equal(
      describeRichModeRefusal("```\nnot html\n```\n\n<div>but this is</div>")?.reason,
      "html",
      "closing a fence ends the exemption",
    );
  });

  it("refuses a bible too long to parse inside a keystroke", () => {
    const long = "word ".repeat(RICH_MODE_MAX_CHARACTERS / 5 + 1);
    assert.ok(long.length > RICH_MODE_MAX_CHARACTERS);
    assert.equal(describeRichModeRefusal(long)?.reason, "too-long");
  });

  it("refuses anything the pipeline itself cannot read", () => {
    assert.equal(
      describeRichModeRefusal("ordinary prose", () => null)?.reason,
      "will-not-round-trip",
    );
  });

  it("says what is true rather than what to do about it", () => {
    for (const bible of ["<br>", "a[^1]\n\n[^1]: n\n", "x".repeat(RICH_MODE_MAX_CHARACTERS + 1)]) {
      const verdict = describeRichModeRefusal(bible);
      assert.ok(verdict, `${bible.slice(0, 12)} should be refused`);
      assert.match(verdict.message, /Editing as source\.$/);
    }
  });
});

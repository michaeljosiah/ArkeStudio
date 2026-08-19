import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeRichModeRefusal,
  RICH_MODE_MAX_CHARACTERS,
  updateRichModeGate,
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

  it("refuses a definition the author indented, which is still a definition", () => {
    /*
     * CommonMark allows up to three spaces before a link reference or footnote definition. Anchoring
     * these patterns flush to the line start let an indented one read as ordinary prose: the gate
     * allowed the document and the editor inlined every link in it, dropping the definition list.
     */
    for (const indent of ["", " ", "  ", "   "]) {
      const bible = `see [the charter][c]\n\n${indent}[c]: https://example.com\n`;
      assert.equal(
        describeRichModeRefusal(bible)?.reason,
        "reference-links",
        `${indent.length} spaces of indent is still a definition`,
      );
      assert.equal(
        serializeMarkdown(bible),
        "see [the charter](https://example.com)",
        "which the editor would otherwise inline",
      );
    }
    assert.equal(
      describeRichModeRefusal("a note[^1]\n\n  [^1]: indented\n")?.reason,
      "footnotes",
      "footnote definitions indent the same way",
    );
    // Four spaces is an indented code block, not a definition, so the gate must not read it as one.
    assert.equal(describeRichModeRefusal("prose\n\n    [c]: https://example.com\n"), null);
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

  it("waves through what the rich editor wrote, and re-reads everything else", () => {
    /*
     * The regression this exists for. Skipping our own save echo is what keeps the gate off the
     * typing path — but the source editor is a text area, and treating what somebody typed there as
     * "not a new document" meant HTML could be entered in source mode and then handed to the rich
     * editor by the toggle, which escapes it into visible `&lt;br&gt;`.
     */
    const clean = "## The tides\n\nProse.\n";
    const withHtml = `${clean}\nwritten <br> like this\n`;

    const opened = updateRichModeGate(null, clean, null);
    assert.equal(opened.verdict, null, "a clean bible opens rich");

    // The rich editor saved; its echo must not cost another parse.
    let evaluated = 0;
    const counting = (text: string) => {
      evaluated += 1;
      return describeRichModeRefusal(text);
    };
    const echoed = updateRichModeGate(opened, clean + "More.", clean + "More.", counting);
    assert.equal(evaluated, 0, "the rich editor's own output is not re-read");
    assert.equal(echoed.verdict, null);

    // The source editor saved. `richWrite` is null, so this is a new document as far as the gate
    // is concerned — which is the only reason the HTML is caught before the toggle can hand it over.
    const typed = updateRichModeGate(echoed, withHtml, null);
    assert.equal(typed.verdict?.reason, "html");
  });

  it("says what is true rather than what to do about it", () => {
    for (const bible of ["<br>", "a[^1]\n\n[^1]: n\n", "x".repeat(RICH_MODE_MAX_CHARACTERS + 1)]) {
      const verdict = describeRichModeRefusal(bible);
      assert.ok(verdict, `${bible.slice(0, 12)} should be refused`);
      assert.match(verdict.message, /Editing as source\.$/);
    }
  });
});

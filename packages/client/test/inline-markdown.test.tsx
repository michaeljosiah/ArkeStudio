import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { renderInlineMarkdown } from "../src/components/inline-markdown.js";

/**
 * Arke's replies carry inline markdown, and the founding conversation used to print it raw
 * (issue 911): eight `**` pairs and an italic name, zero <strong>/<em> elements, on the first
 * prose a new user reads.
 */
describe("inline markdown in a chat bubble (issue 911)", () => {
  it("renders bold, italic and code instead of printing the markers", () => {
    const html = renderToString(
      <div>{renderInlineMarkdown("**The name itself** — *Ozioma Nweke*, _the tide_, and `draft.json`.")}</div>,
    );
    assert.ok(html.includes("<strong>The name itself</strong>"), html);
    assert.ok(html.includes("<em>Ozioma Nweke</em>"), html);
    assert.ok(html.includes("<em>the tide</em>"), html);
    assert.ok(html.includes("<code>draft.json</code>"), html);
    assert.equal(html.includes("*"), false, "no marker survives");
    assert.equal(html.includes("`"), false, "no marker survives");
  });

  it("leaves arithmetic, snake_case and unpaired markers alone", () => {
    const text = "2 * 3 * 4 with tide_caller and a lone ** here";
    const html = renderToString(<div>{renderInlineMarkdown(text)}</div>);
    assert.equal(html.includes("<em>"), false, html);
    assert.equal(html.includes("<strong>"), false, html);
    assert.ok(html.includes("tide_caller"), html);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { renderInlineMarkdown } from "../src/components/inline-markdown.js";
import { chatReplyParts } from "../src/lib/chat-reply.js";

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

  it("retains inline formatting across bounded parts even when one span exceeds a part", () => {
    for (const [marker, tag] of [["**", "strong"], ["*", "em"], ["_", "em"], ["`", "code"]]) {
      const before = "Before the crossing. ".repeat(30), content = "the kept phrase ".repeat(1_200).trim(), after = " After the crossing.";
      const text = before + marker + content + marker + after;
      const parts = chatReplyParts(text);
      let start = 0, visible = "";
      assert.ok(parts.length >= 3);
      assert.equal(parts.join(""), text);
      for (const part of parts) {
        const html = renderToString(<div>{renderInlineMarkdown(text, { start, end: start + part.length })}</div>);
        assert.ok(html.includes(`<${tag}>`), "each part retains the span it intersects");
        assert.equal(html.includes(marker!), false, "no formatting marker becomes visible");
        visible += html.replace(/<[^>]*>/g, "").replace(/<!-- -->/g, "");
        start += part.length;
      }
      assert.equal(visible, before + content + after);
    }
  });
});

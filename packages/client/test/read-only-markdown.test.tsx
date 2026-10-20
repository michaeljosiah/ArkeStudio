import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ReadOnlyMarkdown } from "../src/components/editor/read-only-markdown.js";
import { RICH_MODE_MAX_CHARACTERS } from "../src/components/editor/rich-mode.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.document, { implementation: { createHTMLDocument: () => parseHTML("<!doctype html><html><body></body></html>").document } });
Object.assign(globalThis, { document: dom.document, window: dom.window });
const render = (value: string) => parseHTML(renderToStaticMarkup(<ReadOnlyMarkdown value={value} ariaLabel="Bell House · Customs" />)).document;

it("renders authored emphasis, quotes, lists and code through the existing Markdown schema", () => {
  const page = render("**Keeper of Works** and *neighbours*.\n\n> Keep the passage clear.\n\n- First bell\n- Second bell\n\n`literal`");
  assert.equal(page.querySelector("strong")?.textContent, "Keeper of Works");
  assert.equal(page.querySelector("em")?.textContent, "neighbours");
  assert.equal(page.querySelector("blockquote")?.textContent, "Keep the passage clear.");
  assert.equal(page.querySelectorAll("li").length, 2);
  assert.equal(page.querySelector("code")?.textContent, "literal");
  assert.ok(page.querySelector('[role="document"][aria-label="Bell House · Customs"]'));
  assert.equal(page.querySelector("[contenteditable]"), null);
});
it("keeps raw HTML inert and refuses executable link URLs", () => {
  const page = render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n[unsafe](javascript:alert(3))');
  assert.equal(page.querySelector("script,img,[onerror]"), null);
  assert.ok([...page.querySelectorAll("a")].every(link => !/javascript:/i.test(link.getAttribute("href") ?? "")));
  assert.match(page.querySelector('[role="document"]')?.textContent ?? "", /alert/);
  const links = render("[unsafe](javascript:alert(3)) and [safe](https://example.com)");
  assert.ok([...links.querySelectorAll("a")].every(link => !/javascript:/i.test(link.getAttribute("href") ?? "")));
  assert.equal(links.querySelector('a[href="https://example.com/"]')?.textContent, "safe");
});
it("preserves long source text without parsing or making it editable", () => {
  const value = "<literal>\n".repeat(Math.ceil(RICH_MODE_MAX_CHARACTERS / 10) + 1);
  const page = render(value), prose = page.querySelector('[role="document"]')!;
  assert.equal(prose.textContent, value);
  assert.equal(prose.querySelector("literal"), null);
  assert.match(prose.getAttribute("style") ?? "", /white-space:pre-wrap/);
});

it("renders reference links while keeping task inputs and non-web links inert", () => {
  const page = render("**Read** [charter][c].\n\n[c]: https://example.com/charter\n\n- [ ] pending\n- [x] complete\n\n[local](/tmp/file) [relative](../file) [protocol](ms-settings:display)");
  assert.equal(page.querySelector("strong")?.textContent, "Read");
  assert.equal(page.querySelector('a[href="https://example.com/charter"]')?.textContent, "charter");
  assert.equal(page.querySelectorAll("input").length, 2);
  assert.ok([...page.querySelectorAll("input")].every(input => input.hasAttribute("disabled")));
  for (const label of ["local", "relative", "protocol"]) {
    const link = [...page.querySelectorAll("a")].find(a => a.textContent === label);
    assert.ok(!link?.hasAttribute("href"), label);
  }
});

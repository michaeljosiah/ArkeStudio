import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { BibleScreen } from "../src/screens/bible.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * Which editor the bible screen puts up, and what it says when it will not put up the rich one.
 *
 * The rich editor itself renders nothing on the server — it mounts into an effect, deliberately, so
 * it never has to guess at a document before the browser exists. That makes the text area the thing
 * to assert on: present means the gate refused, absent means the rich editor has the document.
 */

function withBible(text: string): ClientState {
  const world = FIXTURE_STATE.world!;
  return {
    ...FIXTURE_STATE,
    world: { ...world, bible: { version: 3, updated: "2026-07-30", text, present: true } },
  };
}

function render(text: string): string {
  __setStateForTest(withBible(text));
  return renderToString(
    <MemoryRouter initialEntries={[`/worlds/${FIXTURE_WORLD_ID}/bible`]}>
      <Routes>
        <Route path="/worlds/:worldId/bible" element={<BibleScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

const PROSE = "## The tides\n\nThe tide is the world's clock and its accountant.\n\n* salt\n";

describe("the bible's editor", () => {
  it("hands ordinary prose to the rich editor", () => {
    const html = render(PROSE);
    assert.ok(!html.includes("fy-bible__editor"), "no text area, so the rich editor has it");
    assert.ok(html.includes("fy-rme"), "and the rich editor's shell is on the page");
  });

  it("offers the source editor as a choice while the rich one is available", () => {
    assert.match(render(PROSE), /Markdown source/);
  });

  it("falls back to the source editor, and says why, for a bible it would damage", () => {
    const html = render(`${PROSE}\nwritten <br> like this\n`);
    assert.ok(html.includes("fy-bible__editor"), "the text area is back");
    assert.match(html, /contains HTML/);
    assert.ok(!/Markdown source/.test(html), "and there is nothing to choose between");
  });

  it("keeps the word meter and the version reading the same document either way", () => {
    for (const bible of [PROSE, `${PROSE}\n<br>\n`]) {
      const html = render(bible);
      assert.match(html, /Saved · v3/, "the version is on screen");
      assert.match(html, /tokens a\s+turn/, "and so is what it costs to carry");
    }
  });
});

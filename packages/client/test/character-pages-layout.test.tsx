import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

describe("character pages below the desktop (turn 162)", () => {
  it("describes missing imagery as never depicted rather than outstanding work", () => {
    const state = structuredClone(FIXTURE_STATE);
    state.world!.sheets.find(sheet => sheet.id === "maren-kest")!.neverDepicted = true;
    state.world!.referenceKits = [];
    state.world!.referenceTakes = [];
    __setStateForTest(state);
    const { document } = parseHTML(renderToString(<MemoryRouter initialEntries={[
      `/w/${state.world!.meta.worldId}/cast/maren-kest/kit`,
    ]}><App /></MemoryRouter>));
    const content = document.querySelector('[data-screen="reference-kit"]')!.textContent!;
    assert.match(content, /NEVER DEPICTED/);
    assert.doesNotMatch(content, /OUTSTANDING|WAITING ON MAIN PHOTO|Use this portrait/);
  });

  for (const [route, active] of [["kit", "Reference"], ["looks", "More looks"], ["voice", "Voice"]]) {
    it(`${active} marks just its own character tab`, () => {
      __setStateForTest(FIXTURE_STATE);
      const { document } = parseHTML(renderToString(<MemoryRouter initialEntries={[
        `/w/${FIXTURE_STATE.world!.meta.worldId}/cast/maren-kest/${route}`,
      ]}><App /></MemoryRouter>));
      const tabs = document.querySelector('nav[aria-label="Character pages"]')!;
      assert.deepEqual([...tabs.querySelectorAll("button")].map(e => e.textContent), ["Overview", "Reference", "More looks", "Voice"]);
      assert.deepEqual([...tabs.querySelectorAll('[aria-current="page"]')].map(e => e.textContent), [active]);
    });
  }

  it("leaves candidate rows and the gallery's geometry to the responsive cascade", () => {
    const source = readFileSync("src/screens/character-reference.tsx", "utf8");
    assert.match(source, /className="fy-reference-candidate"/);
    assert.doesNotMatch(source, /className="fy-reference-candidate"[^>]*style=/);
    assert.doesNotMatch(source, /className="fy-looks-results__grid"[^>]*style=/);
  });

  it("anchors clone and voice dialogs to the viewport, even when their page scrolls", () => {
    const css = readFileSync("src/screens/fidelity.css", "utf8");
    for (const name of ["clone", "voices"]) {
      const block = css.match(new RegExp(`\\.fy-${name} \\{([^}]+)\\}`))?.[1];
      assert.ok(block);
      assert.match(block, /position: fixed/);
      assert.doesNotMatch(block, /position: absolute/);
    }
  });
});

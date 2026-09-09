import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ArtifactSidecar, ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { artifactsForProduction, productionShelf } from "../src/lib/artifact-view.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
// linkedom has no layout and no frame loop; the app-wide toaster asks for both before it draws.
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

/**
 * The production's own artifacts page (design 134, SPEC-020 R-13).
 *
 * The rail said `Artifacts` and the press left the production: it addressed `/w/<world>/artifacts`,
 * the world's shelf, which by R-13 is the one surface guaranteed *not* to hold what a production
 * owns — and the count beside the row was the world's number. These are the regressions for the
 * destination, the count, and the two rules that keep the page honest about scope: what it files
 * belongs to this production, and what it can change belongs to this production too.
 */

const W = `/w/${FIXTURE_WORLD_ID}`;
const P = `${W}/p/saltlight`;

function artifact(over: Partial<ArtifactSidecar> & Pick<ArtifactSidecar, "id" | "file">): ArtifactSidecar {
  return {
    kind: "document",
    hash: `sha256:${over.id}`,
    origin: { by: "user" },
    links: [],
    created: "2026-06-11T10:00:00Z",
    ...over,
  } as ArtifactSidecar;
}

/** The world's one fixture recording, plus two this production owns and one another's. */
const ARTIFACTS: ArtifactSidecar[] = [
  artifact({ id: "ar_world_bells", file: "harbour-bells.wav", kind: "audio", links: ["the-vigil"] }),
  artifact({ id: "ar_mine_notes", file: "verse-notes.md", production: "saltlight" }),
  artifact({ id: "ar_mine_tone", file: "watch-tone.wav", kind: "audio", production: "saltlight" }),
  artifact({ id: "ar_theirs", file: "ledger-scratch.wav", kind: "audio", production: "ledger-of-nights" }),
];

function withArtifacts(artifacts: ArtifactSidecar[] = ARTIFACTS): ClientState {
  const world = FIXTURE_STATE.world!;
  return { ...FIXTURE_STATE, world: { ...world, artifacts } };
}

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("what a production's artifacts page shows", () => {
  it("holds the world's shelf and this production's own, and never another production's", () => {
    __setStateForTest(withArtifacts());
    const html = renderAt(`${P}/artifacts`);

    assert.ok(html.includes('data-screen="production-artifacts"'), "the page mounts inside the production");
    assert.ok(html.includes("harbour-bells.wav") || html.includes("The Vigil"), "the world's shelf is here");
    assert.ok(html.includes("verse-notes.md"), "what this production owns is here");
    assert.ok(html.includes("watch-tone.wav"), "and so is its recording");
    assert.ok(
      !html.includes("ledger-scratch.wav"),
      "another production's scoped material is absent — this is the rule R-13 exists for",
    );
  });

  it("counts the two scopes apart in one grid, rather than banding them", () => {
    __setStateForTest(withArtifacts());
    const html = renderAt(`${P}/artifacts`);

    assert.ok(html.includes("All 3"), "three files are in scope");
    assert.ok(html.includes("Only here 2"));
    assert.ok(html.includes("From the world 1"));
    // One grid: the ownership word rides the card's own meta line, not a second section head.
    assert.ok(html.includes("fy-artifact-scope"), "owned cards say so on the card");
    assert.ok(!html.includes("FILED HERE"), "the banded list this page replaces is gone");
  });

  it("offers Remove and Lift facts on what it owns, and on nothing else", () => {
    __setStateForTest(withArtifacts());
    const html = renderAt(`${P}/artifacts`);

    // Two owned files, so two removal controls — and nothing offering to retire the world's.
    assert.equal((html.match(/Remove [^<"]*from Saltlight/g) ?? []).length, 2);
    assert.ok(!html.includes("harbour-bells.wav from Saltlight"));
    // R-12: a guest is lifted out of a production's document; the world's are lifted where
    // they live, so exactly one card — the owned document — carries the offer.
    assert.equal((html.match(/Lift facts/g) ?? []).length, 1);
  });

  it("says where a dropped file lands, at the entrance rather than after the fact", () => {
    __setStateForTest(withArtifacts());
    const html = renderAt(`${P}/artifacts`);
    assert.ok(html.includes("only in Saltlight"), "the cell states the scope it will apply");
    assert.ok(html.includes("Add files to Saltlight"));
    assert.ok(!html.includes("artifacts-generate"), "no Generate door: a production has its own");
  });

  it("stands up when the production owns nothing yet", () => {
    __setStateForTest(withArtifacts([ARTIFACTS[0]!]));
    const html = renderAt(`${P}/artifacts`);
    assert.ok(html.includes("Only here 0"));
    assert.ok(html.includes("From the world 1"));
    assert.ok(!html.includes("fy-artifact-scope"), "nothing claims ownership it does not have");
  });
});

describe("the rail row that used to leave the production", () => {
  it("addresses the production, on every format's rail", () => {
    __setStateForTest(withArtifacts());
    for (const path of [`${P}/artifacts`, `${P}/cast`, P]) {
      const html = renderAt(path);
      assert.ok(
        html.includes(`href="${P}/artifacts"`),
        `expected the rail at ${path} to reach the production's own artifacts`,
      );
      assert.ok(
        !html.includes(`href="${W}/artifacts"`),
        `the rail at ${path} must not address the world's shelf`,
      );
    }
  });

  it("counts what its own page shows, not the world's shelf", () => {
    // Three in scope for this production; a world-only count would say 1 and a page-blind
    // count would say 4. The row and the page's All chip are the same number by construction.
    __setStateForTest(withArtifacts());
    const html = renderAt(`${P}/artifacts`);
    const row = html.slice(html.indexOf(`href="${P}/artifacts"`));
    assert.ok(row.includes(">3</span>"), "the rail row says three");
    assert.ok(html.includes("All 3"), "and so does the chip it lands on");
  });
});

describe("the lenses, once the page is live", () => {
  it("drops the add-files cell under the world lens, because it cannot add there", async () => {
    __setStateForTest(withArtifacts());
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[`${P}/artifacts`]}>
          <App />
        </MemoryRouter>,
      );
    });
    const chip = (label: string) =>
      [...host.querySelectorAll("button.fy-filterchip")].find((b) => b.textContent?.startsWith(label));
    const addCell = () => host.querySelector('[aria-label="Add files to Saltlight"]');

    assert.ok(addCell(), "the cell is there under All");
    await act(async () => { (chip("From the world") as HTMLElement).click(); });
    assert.equal(addCell(), null, "and gone where this page files nothing");
    // The world's files are still readable through the lens — it hides the entrance, not the shelf.
    assert.ok(host.textContent?.includes("harbour-bells.wav") || host.textContent?.includes("The Vigil"));

    await act(async () => { (chip("Only here") as HTMLElement).click(); });
    assert.ok(addCell(), "and back where it does");
    assert.ok(!host.textContent?.includes("harbour-bells.wav"), "the world's are out of this lens");

    await act(async () => { root.unmount(); });
    host.remove();
  });
});

describe("the scope helpers the row and the page share", () => {
  it("admits the world's and this production's, and refuses another's", () => {
    const seen = artifactsForProduction(ARTIFACTS, "saltlight").map((a) => a.id);
    assert.deepEqual(seen, ["ar_world_bells", "ar_mine_notes", "ar_mine_tone"]);
  });

  it("drops retired and superseded files, so the count is what the grid draws", () => {
    const withHistory: ArtifactSidecar[] = [
      ...ARTIFACTS,
      artifact({ id: "ar_retired", file: "old-take.wav", kind: "audio", production: "saltlight", retiredAt: "2026-07-01T00:00:00Z" }),
      artifact({ id: "ar_newer", file: "watch-tone-v2.wav", kind: "audio", production: "saltlight", supersedes: "ar_mine_tone" }),
    ];
    const shelf = productionShelf(withHistory, "saltlight").map((a) => a.id);
    assert.deepEqual(shelf, ["ar_world_bells", "ar_mine_notes", "ar_newer"]);
  });
});

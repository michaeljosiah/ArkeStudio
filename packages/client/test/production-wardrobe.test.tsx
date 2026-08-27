import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { CharacterLook, ClientState, CompiledPass, CompiledReference } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { carriedSubjects, passRow } from "../src/screens/production.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The production's side of a character look (design 67).
 *
 * A look is attached on the character's own looks page, and the production it was attached *to*
 * had no idea: the production screens never mentioned looks, and the dispatch dialog counts
 * references without naming one. So the row is the return path — the production states who it is
 * sending, and offers the choice where the consequence lives.
 */

const WORLD_ID = FIXTURE_STATE.world!.meta.worldId;
const PRODUCTION = FIXTURE_STATE.world!.productions[0]!;

const COAT: CharacterLook = {
  id: "council-coat",
  file: "looks/council-coat.png",
  kind: "costume",
  prompt: "Formal Ebb Council coat",
  acceptedAt: "2026-08-01T10:05:30Z",
};
const OILSKIN: CharacterLook = {
  id: "storm-oilskin",
  file: "looks/storm-oilskin.png",
  kind: "costume",
  prompt: "Storm oilskin, hood up",
  acceptedAt: "2026-08-02T10:05:30Z",
};

function stateWithLooks(looks: CharacterLook[]): ClientState {
  const world = FIXTURE_STATE.world!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      referenceKits: world.referenceKits.map((kit) =>
        kit.sheetId === "maren-kest" ? { ...kit, looks } : kit,
      ),
    },
  };
}

function renderCast(): string {
  return renderToString(
    <MemoryRouter initialEntries={[`/w/${WORLD_ID}/p/${PRODUCTION.meta.id}/cast`]}>
      <App />
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

/** A control inside a control never survives hydration (issue 478), and the cards are buttons. */
function nestedControls(html: string): number {
  const opens = /<button\b/g;
  let depth = 0;
  let worst = 0;
  for (const token of html.match(/<button\b|<\/button>|<select\b/g) ?? []) {
    if (token === "</button>") depth -= 1;
    else if (token === "<select") worst = Math.max(worst, depth);
    else depth += 1;
  }
  void opens;
  return worst;
}

describe("the production's wardrobe row", () => {
  it("says nothing at all when no character in the production has a look", () => {
    __setStateForTest(FIXTURE_STATE);
    const html = renderCast();
    assert.ok(!html.includes("WARDROBE"), "a character with no alternatives has no choice to offer");
  });

  it("offers every accepted look, plus the identity package, and marks the one that rides", () => {
    __setStateForTest(stateWithLooks([{ ...COAT, attachedTo: { kind: "production", productionId: PRODUCTION.meta.id } }, OILSKIN]));
    try {
      const html = renderCast();
      assert.match(html, /WARDROBE · IN SALTLIGHT · 1/);
      assert.ok(html.includes("Formal Ebb Council coat"), "the look's own words name the option");
      assert.ok(html.includes("Storm oilskin, hood up"), "an unattached look is still choosable");
      assert.ok(html.includes("Identity package"), "there is a way back to the anchor");
      assert.match(html, /<option[^>]*selected[^>]*value="council-coat"|value="council-coat"[^>]*selected/);
      assert.equal(nestedControls(html), 0, "the picker is never inside a card button");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("shows the effective reference, which is the look once one is attached", () => {
    __setStateForTest(stateWithLooks([{ ...COAT, attachedTo: { kind: "production", productionId: PRODUCTION.meta.id } }]));
    try {
      assert.ok(
        renderCast().includes("references/maren-kest/looks/council-coat.png"),
        "the thumbnail is the file the dispatcher would attach, not a second opinion",
      );
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  /* The narrower scope wins at dispatch, so a row claiming to be the whole answer while a scene
     overrode it would be lying. Stated, not offered: a scene's choice belongs on the scene. */
  it("states a scene's own look beside the production's, by scene number", () => {
    const scene = PRODUCTION.scenes[0]!;
    __setStateForTest(
      stateWithLooks([
        { ...COAT, attachedTo: { kind: "production", productionId: PRODUCTION.meta.id } },
        { ...OILSKIN, attachedTo: { kind: "scene", productionId: PRODUCTION.meta.id, sceneId: scene.id } },
      ]),
    );
    try {
      assert.match(renderCast(), new RegExp(`Sc ${scene.number} · Storm oilskin, hood up`));
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("ignores an attachment belonging to another production", () => {
    __setStateForTest(stateWithLooks([{ ...COAT, attachedTo: { kind: "production", productionId: "elsewhere" } }]));
    try {
      const html = renderCast();
      assert.ok(html.includes("WARDROBE"), "the character still has a look to choose from");
      assert.ok(
        html.includes("references/maren-kest/main-photo.png") ||
          !html.includes("references/maren-kest/looks/council-coat.png"),
        "but nothing of another production's choice rides here",
      );
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });
});

/**
 * What the dispatch dialog says rides (design 67).
 *
 * The pass row said `refs ×3` and nothing else, so the one decision a production makes about a
 * character's appearance reached the model without appearing on the screen that authorises the
 * spend — the only way to find out a look had ridden was to read the take that came back.
 */
describe("the dispatch dialog's carried subjects", () => {
  const reference = (over: Partial<CompiledReference>): CompiledReference => ({
    index: 1,
    file: "references/maren-kest/main-photo.png",
    sheetId: "maren-kest",
    sheetVersion: 4,
    role: "subject reference — appearance identity, from the main photo",
    subject: "Maren Kest",
    mode: "main-photo",
    ...over,
  });

  it("names each subject, and marks the one riding its production's look", () => {
    assert.equal(
      carriedSubjects([
        reference({ mode: "scoped-look", file: "references/maren-kest/looks/council-coat.png" }),
        reference({ index: 2, sheetId: "the-vigil", subject: "The Vigil", mode: "designated" }),
      ]),
      "Maren Kest (look), The Vigil",
    );
  });

  it("says nothing of a look when the identity package is what rides", () => {
    assert.equal(carriedSubjects([reference({})]), "Maren Kest");
    assert.equal(carriedSubjects([reference({ mode: "designated" })]), "Maren Kest");
  });

  /* A subject can take two slots — its sheet and its main photo. That is one subject either way,
     and the count beside this line is where the number of images is stated. */
  it("names a subject once however many of its references travel, and marks it if either is a look", () => {
    assert.equal(
      carriedSubjects([
        reference({ mode: "scoped-look" }),
        reference({ index: 2, mode: "main-photo", role: "additional reference for the same subject" }),
      ]),
      "Maren Kest (look)",
    );
  });

  it("says nothing at all when nothing rides", () => {
    assert.equal(carriedSubjects([]), "");
  });
});

/** The whole line, so what the dialog prints is asserted rather than assembled twice. */
describe("the dispatch dialog's pass row", () => {
  const pass = (over: Partial<CompiledPass>): CompiledPass =>
    ({
      target: { kind: "shot", id: "sh_12", coversShots: ["sh_12"] },
      model: { id: "wan-like", provider: "fal", capability: "video", displayName: "Wan-like" },
      route: { kind: "reference", route: "acme/wan-like/reference-to-video" },
      params: {},
      references: [],
      askedSec: 5,
      estimatedMicroUsd: 100000,
      dropped: [],
      sources: { canonRevision: 1, artDirectionVersion: 1, sceneId: "sc_04", sceneVersion: 2, sheets: {} },
      landing: { dir: "takes/tk_1" },
      ...over,
    }) as CompiledPass;

  const reference = (over: Partial<CompiledReference>): CompiledReference => ({
    index: 1,
    file: "references/maren-kest/main-photo.png",
    sheetId: "maren-kest",
    sheetVersion: 4,
    role: "subject reference — appearance identity",
    subject: "Maren Kest",
    mode: "main-photo",
    ...over,
  });

  it("names the look on the line that prices the dispatch", () => {
    assert.equal(
      passRow(
        pass({
          references: [
            reference({ mode: "scoped-look", file: "references/maren-kest/looks/council-coat.png" }),
            reference({ index: 2, sheetId: "the-vigil", subject: "The Vigil", mode: "designated" }),
          ],
        }),
      ),
      "reference route · refs ×2 · Maren Kest (look), The Vigil · 5s · $0.10",
    );
  });

  it("leaves the routes that carry no reference exactly as they were", () => {
    assert.equal(passRow(pass({ route: { kind: "text" } as CompiledPass["route"] })), "text route · 5s · $0.10");
  });
});

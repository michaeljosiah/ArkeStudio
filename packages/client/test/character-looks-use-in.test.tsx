import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientState, ProductionBundle, SceneRecord } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { lookUseOptions, scenesWithCharacter } from "../src/screens/character-reference.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A look's Use in select against a world with a long production in it (issue 3170).
 *
 * The select listed every scene of every production in world order: in the owner's world, 136
 * scenes of one production stood before the production being worked on, and each production's
 * own choice read `Entire production`. Here the long production comes first in the world, the
 * production the author came from comes last, and the character is in one scene of each of the
 * other two.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const open: Root[] = [];
afterEach(async () => {
  for (const root of open.splice(0)) await act(async () => root.unmount());
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
});

const AT = "2026-08-01T10:05:30Z";
const SALTLIGHT = FIXTURE_STATE.world!.productions.find((production) => production.meta.id === "saltlight")!;
// The fixture's scene keeps its shots as a list, not a flow; every scene here is built from it.
const SC_04 = SALTLIGHT.scenes.find((scene) => scene.id === "sc_04") as Extract<SceneRecord, { shots: unknown }>;

function scene(id: string, number: number, title: string, description: string, cast?: SceneRecord["cast"]): SceneRecord {
  return {
    ...SC_04,
    id,
    number,
    slug: id,
    title,
    shots: [{ ...SC_04.shots[0]!, id: `sh_${id}`, description, audio: { kind: "sfx", line: "wind" } }],
    ...(cast !== undefined ? { cast } : {}),
  } as SceneRecord;
}

function production(id: string, title: string, scenes: SceneRecord[]): ProductionBundle {
  return { ...SALTLIGHT, meta: { ...SALTLIGHT.meta, id, title }, sceneFiles: {}, scenes } as ProductionBundle;
}

// Undertow is the long one Maren is never in; Harbour lights has her in its second scene only,
// added by hand rather than cited, which is still being in the scene (SPEC-044 R-6).
const UNDERTOW = production("undertow", "Undertow", [1, 2, 3, 4, 5].map((n) => scene(`sc_u${n}`, n, `Undertow ${n}`, "@the-vigil at low water.")));
const HARBOUR = production("harbour", "Harbour lights", [
  scene("sc_h1", 1, "The lamps", "@the-vigil, lamps lit."),
  scene("sc_h2", 2, "The quay", "Rain on the quay.", { "maren-kest": { added: AT } }),
]);
const PRODUCTIONS = [UNDERTOW, SALTLIGHT, HARBOUR];

function stateWithLook(attachedTo?: { kind: "production"; productionId: string } | { kind: "scene"; productionId: string; sceneId: string }): ClientState {
  const world = FIXTURE_STATE.world!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      productions: PRODUCTIONS,
      referenceKits: world.referenceKits.map((kit) =>
        kit.sheetId === "maren-kest"
          ? { ...kit, looks: [{ id: "council-coat", file: "looks/council-coat.png", kind: "costume" as const, prompt: "Formal Ebb Council coat", acceptedAt: AT, ...(attachedTo ? { attachedTo } : {}) }] }
          : kit,
      ),
    },
  };
}

async function openUseIn(path: string, state: ClientState) {
  __setStateForTest(state);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  open.push(root);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  ));
  const tile = container.querySelector<HTMLButtonElement>('.fy-looks-results__grid button[title="Formal Ebb Council coat"]');
  assert.ok(tile, "the accepted look is in the gallery");
  await act(async () => tile.click());
  const select = container.querySelector<HTMLSelectElement>("select.fy-looks-attach__select");
  assert.ok(select, "selecting a look offers Use in");
  const groups = [...select.querySelectorAll("optgroup")].map((group) => [
    group.getAttribute("label"),
    [...group.querySelectorAll("option")].map((option) => option.textContent),
  ]);
  return { container, groups };
}

describe("the Use in select (issue 3170)", () => {
  it("leads with the production the scene's door came from, and lists only the scenes she is in", async () => {
    const { container, groups } = await openUseIn(`/w/${FIXTURE_WORLD_ID}/cast/maren-kest/looks?attach=scene:harbour:sc_h2`, stateWithLook());
    assert.deepEqual(groups, [
      // Every production by its own name, above every scene: the one she came from, then the one
      // she is in, then the long one she is not in.
      ["Entire production", ["Harbour lights", "Saltlight", "Undertow"]],
      ["Harbour lights", ["Scene 2 · The quay"]],
      ["Saltlight", ["Scene 4 · The verse rises"]],
    ]);
    const preset = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Use in scene 2");
    assert.ok(preset, "the door's one-press attach is unchanged");
  });

  it("puts the productions she is in first when no door names one", async () => {
    const { groups } = await openUseIn(`/w/${FIXTURE_WORLD_ID}/cast/maren-kest/looks`, stateWithLook());
    assert.deepEqual(groups[0], ["Entire production", ["Saltlight", "Harbour lights", "Undertow"]]);
    assert.deepEqual(groups.slice(1).map(([label]) => label), ["Saltlight", "Harbour lights"]);
  });

  it("keeps a scene the look already holds, though she is no longer in it", async () => {
    const { container, groups } = await openUseIn(`/w/${FIXTURE_WORLD_ID}/cast/maren-kest/looks`, stateWithLook({ kind: "scene", productionId: "undertow", sceneId: "sc_u3" }));
    assert.deepEqual(groups.at(-1), ["Undertow", ["Scene 3 · Undertow 3"]]);
    const select = container.querySelector<HTMLSelectElement>("select.fy-looks-attach__select")!;
    assert.equal(select.value, "scene:undertow:sc_u3", "the select names the choice in force");
  });
});

describe("the Use in read model", () => {
  it("finds her by citation, by speech and by hand, and nowhere else", () => {
    const speaking = production("ferry", "Ferry", [
      { ...scene("sc_f1", 1, "Crossing", "The deck, empty."), shots: [{ ...SC_04.shots[0]!, id: "sh_f1", description: "The deck, empty.", audio: { kind: "vo", speaker: "maren-kest", line: "Hold." } }] } as SceneRecord,
    ]);
    const keys = scenesWithCharacter([...PRODUCTIONS, speaking], FIXTURE_STATE.world!.sheets, "maren-kest");
    assert.deepEqual([...keys].sort(), ["ferry:sc_f1", "harbour:sc_h2", "saltlight:sc_04"]);
  });

  it("orders by where the page came from, then where she is, then world order", () => {
    const castIn = new Set(["saltlight:sc_04", "harbour:sc_h2"]);
    assert.deepEqual(lookUseOptions(PRODUCTIONS, castIn, "undertow", undefined).productions.map((p) => p.id), ["undertow", "saltlight", "harbour"]);
    assert.deepEqual(lookUseOptions(PRODUCTIONS, castIn, null, undefined).productions.map((p) => p.id), ["saltlight", "harbour", "undertow"]);
    assert.deepEqual(lookUseOptions(PRODUCTIONS, castIn, "undertow", undefined).scenes.map((group) => group.productionId), ["saltlight", "harbour"],
      "a production she is in no scene of offers its whole-production choice alone");
  });
});

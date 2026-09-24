import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * An address that no longer names a screen still answers, and lands where its content went
 * (SPEC-034 R-5, R-14; SPEC-036 R-26, R-30). A redirect is a second render pass, which
 * `renderToString` never makes — so these mount the app for real and read the screen that ends
 * up on the page, rather than reading `App.tsx` for the `<Navigate>` elements.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
// linkedom has no layout and no frame loop; the app-wide toaster asks for both before it draws.
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), {
  pause() {},
  play: () => Promise.resolve(),
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const open: Root[] = [];
afterEach(async () => {
  for (const root of open.splice(0)) await act(async () => root.unmount());
  dom.document.body.replaceChildren();
});

async function landAt(path: string): Promise<HTMLElement> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  open.push(root);
  await act(async () => {
    __setStateForTest(FIXTURE_STATE);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  return container;
}

const screenOf = (container: HTMLElement): string | null =>
  [...container.querySelectorAll<HTMLElement>("[data-screen]")].at(-1)?.getAttribute("data-screen") ?? null;

describe("retired addresses land where their content went", () => {
  // Local runtime became two screens, and those two became one pane of Providers; Cloud AI became
  // General; Agents went to Harness and Who does what to General. Each lands on its own successor —
  // `agents` on the one screen that has the per-agent overrides, not the one defined by lacking them.
  for (const [from, to] of [
    ["/settings", "settings-providers"],
    ["/settings/local-runtime", "settings-providers"],
    ["/settings/local-ai", "settings-providers"],
    ["/settings/engines", "settings-providers"],
    ["/settings/cloud-ai", "settings-general"],
    ["/settings/who-does-what", "settings-general"],
    ["/settings/agents", "settings-harness"],
  ] as const) {
    it(`${from} shows ${to}`, async () => {
      assert.equal(screenOf(await landAt(from)), to);
    });
  }

  const production = `/w/${FIXTURE_WORLD_ID}/p/saltlight`;

  it("sends a scene-scoped dispatch link to the scene's workspace and a bare one to Generate (R-30)", async () => {
    const scoped = await landAt(`${production}/generate/dispatch?scene=sc_04`);
    assert.ok(scoped.querySelector('[data-testid="scene-workspace"]'), "the scene owns generation now");
    assert.equal(scoped.querySelector('[data-screen="generate-workspace"]'), null, "never the spending screen");
    const bare = await landAt(`${production}/generate/dispatch`);
    assert.equal(screenOf(bare), "generate-workspace");
  });

  it("returns an old Scene Chat link to the workspace with its shot still selected (R-26)", async () => {
    const landed = await landAt(`${production}/story/scenes/sc_04?shot=sh_12`);
    assert.ok(landed.querySelector('[data-testid="scene-workspace"]'));
    const selected = landed.querySelector<HTMLElement>('[data-selected="true"]');
    assert.match(selected?.textContent ?? "", /Shot 12/, "the shot the conversation was about is the one open");
  });

  it("sends the retired audio page into the Cut's library, filtered to audio", async () => {
    const landed = await landAt(`${production}/audio`);
    assert.equal(screenOf(landed), "cut");
    // The query rides the redirect: the library is open and its Audio filter is the one pressed,
    // or a person following the old link would land on the whole library.
    const pressed = [...landed.querySelectorAll<HTMLElement>('[aria-label="Library filters"] button')].find((b) => b.getAttribute("aria-pressed") === "true");
    assert.equal(pressed?.textContent, "Audio");
  });
});

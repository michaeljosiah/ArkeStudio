import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { ShotLightbox } from "../src/screens/scene-workspace/lightbox.js";

/**
 * The Preview tab's transport and its lightbox (SPEC-036 R-1, R-19, R-28, R-29).
 *
 * The harness backs requestAnimationFrame with setTimeout, so a transport left playing is a
 * timer loop the runner never exits: every case that presses Play stops it again before it ends.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
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
  // The transport cancels its frame when it stops; the sibling suite never plays, so never needed it.
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

const SCENE_PATH = `/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes/sc_04`;

interface Mounted {
  container: HTMLElement;
  root: Root;
}

const open: Mounted[] = [];

async function render(node: ReactNode): Promise<Mounted> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(FIXTURE_STATE);
    root.render(node);
  });
  const mounted = { container, root };
  open.push(mounted);
  return mounted;
}

async function mountPreview(): Promise<Mounted> {
  const mounted = await render(
    <MemoryRouter initialEntries={[SCENE_PATH]}>
      <App />
    </MemoryRouter>,
  );
  await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Preview")!);
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest(null);
});

const q = (m: Mounted, selector: string): HTMLElement | null =>
  m.container.querySelector(selector) as HTMLElement | null;
const all = (m: Mounted, selector: string): HTMLElement[] =>
  [...m.container.querySelectorAll(selector)] as unknown as HTMLElement[];
const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => element.click());
};
const transport = (m: Mounted): string => q(m, ".fy-swpreview__transport")?.textContent ?? "";

describe("Preview transport (SPEC-036 R-28, R-29)", () => {
  it("plays and pauses from one disc, and restart rewinds without playing", async () => {
    const mounted = await mountPreview();
    const toggle = () => q(mounted, ".fy-swpreview__toggle")!;
    assert.equal(toggle().getAttribute("aria-label"), "Play");
    assert.ok(q(mounted, ".fy-swpreview__stageplay .fy-swpreview__playdisc svg"), "the stage disc carries the solid play glyph");
    assert.equal(transport(mounted), "0.0s / 10.0s");

    await click(toggle());
    assert.equal(toggle().getAttribute("aria-label"), "Pause");
    assert.equal(q(mounted, ".fy-swpreview__stageplay"), null, "the stage disc leaves while the scene plays");

    await click(q(mounted, ".fy-swpreview__restart")!);
    assert.equal(toggle().getAttribute("aria-label"), "Play", "restart holds at the top rather than playing");
    assert.match(transport(mounted), /^0\.0s \/ 10\.0s$/);
    assert.ok(q(mounted, ".fy-swpreview__stageplay"), "and the stage disc is back");
  });

  it("plays again from the top once the end has held", async () => {
    const mounted = await mountPreview();
    const toggle = () => q(mounted, ".fy-swpreview__toggle")!;
    const realNow = Date.now;
    let skewMs = 0;
    Date.now = () => realNow() + skewMs;
    try {
      await click(toggle());
      skewMs = 11_000;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
      assert.equal(toggle().getAttribute("aria-label"), "Play", "the end holds (R-29)");
      assert.match(transport(mounted), /^10\.0s/);

      skewMs = 0;
      await click(toggle());
      assert.equal(toggle().getAttribute("aria-label"), "Pause");
      assert.match(transport(mounted), /^0\.0s/, "play at the end goes back to the top");
      await click(q(mounted, ".fy-swpreview__restart")!);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("Preview lightbox (SPEC-036 R-1, R-19)", () => {
  it("opens larger on the current shot and arrows through the scene with the selection, wrapping", async () => {
    const mounted = await mountPreview();
    assert.equal(q(mounted, ".fy-swlightbox"), null);
    await click(q(mounted, ".fy-swpreview__larger")!);
    assert.ok(q(mounted, ".fy-swlightbox")?.hasAttribute("open"));
    assert.equal(q(mounted, ".fy-swlightbox__label")?.textContent, "shot 12");
    assert.equal(q(mounted, ".fy-swlightbox__title")?.textContent, "Maren at the rail, listening");
    assert.equal(q(mounted, ".fy-swlightbox__chip")?.textContent, "16:9 · 4.0s");
    assert.ok(q(mounted, ".fy-swlightbox__frame img")?.getAttribute("src"), "the shot's frame is the picture");
    assert.match(q(mounted, ".fy-swlightbox__foot p")?.textContent ?? "", /grips the rail/, "the script sits beneath");

    await click(q(mounted, '.fy-swlightbox [aria-label="Next shot"]')!);
    assert.equal(q(mounted, ".fy-swlightbox__label")?.textContent, "shot 13");
    assert.match(q(mounted, ".fy-arke__name")?.textContent ?? "", /Shot 13/, "the arrows carry the selection with them");
    assert.equal(q(mounted, ".fy-swlightbox__frame img"), null);
    assert.match(q(mounted, ".fy-swlightbox__empty")?.textContent ?? "", /no frame yet/, "a frameless shot lands on its empty state");
    assert.ok(all(mounted, ".fy-swlightbox__empty button").some((button) => button.textContent === "Generate frame"));

    await click(q(mounted, '.fy-swlightbox [aria-label="Next shot"]')!);
    assert.equal(q(mounted, ".fy-swlightbox__label")?.textContent, "shot 12", "next wraps to the first shot");
    await click(q(mounted, '.fy-swlightbox [aria-label="Previous shot"]')!);
    assert.equal(q(mounted, ".fy-swlightbox__label")?.textContent, "shot 13", "previous wraps to the last");

    await click(q(mounted, '.fy-swlightbox [aria-label="Close"]')!);
    assert.equal(q(mounted, ".fy-swlightbox"), null);
  });

  it("hands Advanced and Generate frame back to its owner after closing, and asks it to step", async () => {
    const production = FIXTURE_STATE.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const calls: string[] = [];
    const box = (shotId: string) => (
      <ShotLightbox
        scene={scene}
        production={production}
        artifacts={FIXTURE_STATE.world!.artifacts}
        worldSlug={FIXTURE_STATE.world!.meta.slug}
        aspect="16:9"
        shotId={shotId}
        onClose={() => calls.push("close")}
        onSelectShot={(id) => calls.push(`select ${id}`)}
        onEditShot={(id) => calls.push(`edit ${id}`)}
        onOpenInGenerator={(id) => calls.push(`generate ${id}`)}
      />
    );
    const mounted = await render(box("sh_12"));
    await click(all(mounted, ".fy-swlightbox__foot button").find((button) => button.textContent === "Advanced")!);
    assert.deepEqual(calls.splice(0), ["close", "edit sh_12"]);

    await click(q(mounted, '[aria-label="Previous shot"]')!);
    assert.deepEqual(calls.splice(0), ["select sh_13"], "stepping asks the owner to move the shot; it does not move itself");

    await act(async () => mounted.root.render(box("sh_13")));
    await click(all(mounted, ".fy-swlightbox__empty button").find((button) => button.textContent === "Generate frame")!);
    assert.deepEqual(calls.splice(0), ["close", "generate sh_13"]);

    await act(async () => q(mounted, ".fy-swlightbox")!.dispatchEvent(new dom.window.Event("cancel")));
    assert.deepEqual(calls.splice(0), ["close"], "Escape closes it");
  });
});

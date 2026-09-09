import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { playlistSnapshot, setAudioFactoryForTest } from "../src/lib/audio.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import type { ClientMessage, ClientState } from "@arke-studio/contracts";
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

describe("Play lines (SPEC-044 R-33; T-14)", () => {
  const capture = (sent: ClientMessage[]): ArkeBridge =>
    ({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => { sent.push(JSON.parse(json) as ClientMessage); } }) as unknown as ArkeBridge;
  const fakeAudio = () => ({ src: "", currentTime: 0, duration: 0, playbackRate: 1, play: () => Promise.resolve(), pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} });
  const LINE_12 = "sc_04/sh_12/legacy", LINE_13 = "sc_04/sh_13/legacy";
  const plan = (missing: "cloud" | "local" | "cached") => ({
    productionId: "saltlight", sceneId: "sc_04", sceneVersion: 2, confirmationToken: `sha256:${"c".repeat(64)}`, totalEstimatedMicroUsd: missing === "cloud" ? 40_000 : 0,
    items: [
      { lineId: LINE_12, shotId: "sh_12", speakerSheetId: "maren-kest", route: "existing", file: `productions/saltlight/performances/pf_01J8E0000000000000000000P1/sha256-${"1".repeat(64)}.wav`, estimatedMicroUsd: 0 },
      { lineId: LINE_13, shotId: "sh_13", speakerSheetId: "maren-kest", route: missing, estimatedMicroUsd: missing === "cloud" ? 40_000 : 0,
        ...(missing === "cached" ? { file: `.cache/table-read/sha256-${"2".repeat(64)}.wav` } : {}) },
    ],
  });
  afterEach(() => { setAudioFactoryForTest(null); });

  it("plays the lines that have a read in shot order, says how many do, and offers to prepare the rest at the quoted price", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = state.world!.productions.find((production) => production.meta.id === "saltlight")!.scenes.find((candidate) => candidate.id === "sc_04")!;
    (scene as unknown as { shots: Array<{ audio?: unknown }> }).shots[1]!.audio = { kind: "dialogue", speaker: "maren-kest", line: "the bells answer" };
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    setAudioFactoryForTest(() => fakeAudio() as never);
    const mounted = await render(<MemoryRouter initialEntries={[SCENE_PATH]}><App /></MemoryRouter>);
    await act(async () => { __setStateForTest(state); });
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Preview")!);
    const asked = sent.find((message) => message.kind === "plan-table-read");
    assert.ok(asked && asked.kind === "plan-table-read", "the plan is asked for on arrival, so the count and the door are current");
    await act(async () => { __applyEventForTest({ at: "2026-09-09T10:00:00.000Z", type: "rehearsal.result", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, status: "planned", reason: "", plan: plan("cloud") } as never); });
    const lines = q(mounted, '[aria-label="Lines"]')!;
    assert.match(lines.textContent ?? "", /1 of 2 lines have a read/);
    const door = [...lines.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Prepare"))!;
    assert.equal(door.textContent, "Prepare 1 line · $0.04");
    assert.doesNotMatch(lines.textContent ?? "", /sha256|elevenlabs|kokoro|cloud|existing/, "no hash, route or provider on Preview");
    // linkedom's <select> has no value setter, so the change goes to React's own handler.
    const rate = lines.querySelectorAll("select")[1] as HTMLSelectElement;
    const propsKey = Object.keys(rate).find((key) => key.startsWith("__reactProps$"))!;
    await act(async () => { (rate as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[propsKey]!.onChange({ target: { value: "1.25" } }); });
    await click([...lines.querySelectorAll("button")].find((button) => button.textContent?.includes("Play lines"))!);
    await act(async () => {});
    assert.deepEqual(playlistSnapshot()?.items.map((item) => [item.lineId, item.title]), [[LINE_12, "Maren Kest: the verse, under the water"]], "only the line with a read");
    assert.equal(playlistSnapshot()?.rate, 1.25, "the rate chosen before the press applies to the read");
    assert.ok(q(mounted, '[aria-label="Skip line"]') && q(mounted, '[aria-label="Previous line"]') && q(mounted, '[aria-label="Restart line"]'), "the player carries the lines' transport");
    assert.equal(sent.some((message) => message.kind === "prepare-table-read"), false, "playing spends nothing");
    await click(door);
    const prepare = sent.find((message) => message.kind === "prepare-table-read");
    assert.ok(prepare && prepare.kind === "prepare-table-read");
    assert.equal(prepare.confirmationToken, `sha256:${"c".repeat(64)}`);
    assert.equal(prepare.confirmedMicroUsd, 40_000);
    // A refused preparation is said, and the plan is asked for again because its token is spent.
    const asks = () => sent.filter((message) => message.kind === "plan-table-read").length;
    const before = asks();
    await act(async () => { __applyEventForTest({ at: "2026-09-09T10:01:00.000Z", type: "rehearsal.result", requestId: prepare.requestId, worldId: FIXTURE_WORLD_ID, status: "refused", reason: "Preparation changed while local lines were being synthesized." } as never); });
    assert.match(q(mounted, '[aria-label="Lines"] [role="status"]')?.textContent ?? "", /Preparation changed/);
    assert.equal(asks(), before + 1);
  });

  it("plays a cached line beside a selected read, in shot order, and hides the door when nothing is missing (T-18)", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = state.world!.productions.find((production) => production.meta.id === "saltlight")!.scenes.find((candidate) => candidate.id === "sc_04")!;
    (scene as unknown as { shots: Array<{ audio?: unknown }> }).shots[1]!.audio = { kind: "dialogue", speaker: "maren-kest", line: "the bells answer" };
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    setAudioFactoryForTest(() => fakeAudio() as never);
    const mounted = await render(<MemoryRouter initialEntries={[SCENE_PATH]}><App /></MemoryRouter>);
    await act(async () => { __setStateForTest(state); });
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Preview")!);
    const asked = sent.find((message) => message.kind === "plan-table-read")!;
    await act(async () => { __applyEventForTest({ at: "2026-09-09T10:00:00.000Z", type: "rehearsal.result", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, status: "planned", reason: "", plan: plan("cached") } as never); });
    const lines = q(mounted, '[aria-label="Lines"]')!;
    assert.match(lines.textContent ?? "", /2 of 2 lines have a read/);
    assert.equal([...lines.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Prepare")), false);
    await click([...lines.querySelectorAll("button")].find((button) => button.textContent?.includes("Play lines"))!);
    await act(async () => {});
    assert.deepEqual(playlistSnapshot()?.items.map((item) => item.lineId), [LINE_12, LINE_13], "the selected read and the cached line, in shot order");
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Storyboard")!);
    assert.equal(playlistSnapshot()?.items.length, 2, "leaving Preview does not stop the read");
  });
});

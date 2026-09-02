import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import {
  FrameRunSchema,
  FrameRunStateSchema,
  foldFrameRun,
  orderedShots,
  type ClientMessage,
  type ClientState,
  type FrameRunJobFacts,
  type FrameRunQuote,
  type FrameRunState,
  type ManifestModel,
} from "@arke-studio/contracts";
import { App } from "../src/App.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/*
 * The toolbar row, the generate dialog and the board sheet against the scene-workspace design
 * (SPEC-036 R-4, R-15..R-17): the run bar owns the tab row, the coverage line and boards toggle
 * step aside for it, and the dialog reads as the design's stacked card.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});

const PATH = `/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes/sc_04`;
const RUN_ID = "fr_01J8E0000000000000000000T1";
const JOB_1 = "jb_01J8E0000000000000000000T1";
const JOB_2 = "jb_01J8E0000000000000000000T2";
const QUOTE_ID = "01J8E0000000000000000000Q7";
const SIGNATURE = `sha256:${"b".repeat(64)}`;

const IMAGE_MODEL: ManifestModel = {
  id: "frame-image",
  provider: "fal",
  capability: "image",
  displayName: "Frame image",
  accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { aspects: ["16:9"] },
  pricing: { kind: "perImage", microUsdPerImage: 37_000 },
};

interface Mounted {
  container: HTMLElement;
  root: Root;
}

const mounted: Mounted[] = [];

function step(index: number, shotId: string, jobId: string) {
  const request = {
    prompt: `Frozen prompt ${index}`,
    panels: [{ panel: 1, shotId, role: "update" as const }],
    references: [],
    droppedReferences: [],
    provenance: { canonRevision: 42, artDirectionVersion: 3 },
    aspect: "16:9",
    slotAtAuthorization: { [shotId]: null },
  };
  const output = { width: 1536, height: 864, aspect: "16:9" };
  return {
    label: `Shot ${12 + index}`,
    requestShotIds: [shotId],
    updateShotIds: [shotId],
    request,
    dispatch: {
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      provider: "fal",
      model: IMAGE_MODEL.id,
      capability: "image" as const,
      target: { kind: "shot" as const, id: shotId, coversShots: [shotId] },
      references: [],
      referenceCapacity: 4,
      output,
      routeOutput: output,
      cellOutput: output,
      estimatedMicroUsd: 37_000,
      cellEstimatedMicroUsd: 37_000,
      params: { prompt: request.prompt, references: [], output, request },
      landing: { dir: `incoming/${index}`, name: `frame-${index}.png` },
      idempotencyKey: `01J8E0000000000000000000M${index + 1}`,
    },
    sourceStepIndex: index,
    grain: "initial" as const,
    jobId,
    landingOutcomes: {},
  };
}

function frameState(options: {
  paused?: boolean;
  cancelled?: boolean;
  first?: Partial<FrameRunJobFacts>;
  second?: Partial<FrameRunJobFacts>;
  filed?: boolean;
} = {}): FrameRunState {
  const steps = [step(0, "sh_12", JOB_1), step(1, "sh_13", JOB_2)];
  if (options.filed) {
    steps[0]!.landingOutcomes = { sh_12: "filed" };
    steps[1]!.landingOutcomes = { sh_13: "filed" };
  }
  const run = FrameRunSchema.parse({
    id: RUN_ID,
    sceneId: "sc_04",
    sceneVersion: 2,
    mode: "per-shot",
    model: IMAGE_MODEL.id,
    steps,
    cursor: steps.length,
    paused: options.paused ?? false,
    cancelled: options.cancelled ?? false,
    createdAt: "2026-08-30T12:00:00Z",
  });
  return FrameRunStateSchema.parse(foldFrameRun(run, [
    { id: JOB_1, status: "running", etaSec: 9, ...options.first },
    { id: JOB_2, status: "queued", etaSec: null, ...options.second },
  ]));
}

function stateWith(options: { runs?: FrameRunState[]; allFramed?: boolean; singleShot?: boolean } = {}): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const video = state.app.manifest!.models.find((model) => model.capability === "video")!;
  video.limits.storyboardPanels = 6;
  state.app.manifest!.models.push(IMAGE_MODEL);
  state.frameRuns = options.runs ?? [];
  const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
  if (options.singleShot) (scene as unknown as { shots: unknown[] }).shots = [orderedShots(scene)[0]!];
  if (options.allFramed) {
    const frameTake = production.takes.find((take) => take.kind === "frame")!;
    for (const shot of orderedShots(scene)) production.selections[shot.id] = { acceptedTakeId: frameTake.id, trimInSec: 0 };
  }
  return state;
}

function quoteFor(message: Extract<ClientMessage, { kind: "frame-run-quote" }>): FrameRunQuote {
  return {
    requestId: message.requestId,
    quoteId: QUOTE_ID,
    signature: SIGNATURE,
    worldId: message.worldId,
    productionId: message.productionId,
    sceneId: message.sceneId,
    sceneVersion: 2,
    mode: message.mode,
    modelId: message.modelId,
    scope: message.scope,
    ...(message.shotId === undefined ? {} : { shotId: message.shotId }),
    includedCount: 2,
    steps: [],
    estimatedMicroUsd: 81_234,
    blockedReason: null,
    quotedAt: "2026-08-30T12:00:01Z",
  };
}

function capture(sent: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => {
      const message = JSON.parse(json) as ClientMessage;
      sent.push(message);
      if (message.kind === "frame-run-quote") {
        __applyEventForTest({ at: "2026-08-30T12:00:01Z", type: "production.frame-run-quote", quote: quoteFor(message) });
      }
    },
  } as unknown as ArkeBridge;
}

async function mount(state: ClientState, sent: ClientMessage[] = []): Promise<Mounted> {
  __setBridgeForTest(capture(sent));
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state);
    root.render(<MemoryRouter initialEntries={[PATH]}><App /></MemoryRouter>);
  });
  const result = { container, root };
  mounted.push(result);
  return result;
}

afterEach(async () => {
  for (const item of mounted.splice(0)) {
    await act(async () => item.root.unmount());
    item.container.remove();
  }
  dom.document.body.replaceChildren();
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});

const all = (item: Mounted, selector: string): HTMLElement[] => [...item.container.querySelectorAll(selector)] as unknown as HTMLElement[];
const one = (item: Mounted, selector: string): HTMLElement | null => item.container.querySelector(selector) as HTMLElement | null;
const named = (item: Mounted, text: string, within: HTMLElement | null = null): HTMLElement => {
  const scope = within === null ? all(item, "button") : ([...within.querySelectorAll("button")] as unknown as HTMLElement[]);
  const found = scope.find((button) => button.textContent?.trim() === text);
  assert.ok(found, `button ${text} exists`);
  return found;
};
const click = async (element: HTMLElement) => act(async () => element.click());

describe("the toolbar row (SPEC-036 R-4, R-17)", () => {
  it("reads the coverage line and a text-pill boards toggle while no run exists", async () => {
    const item = await mount(stateWith());
    assert.equal(one(item, ".fy-sw__coverage")?.textContent, "2 of 2 without a frame");
    const toggle = one(item, ".fy-sw__boards-toggle")!;
    assert.equal(toggle.textContent?.trim(), "Show boards");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(toggle.getAttribute("title"), "Group shots into boards that fit the clip limit");
    await click(toggle);
    assert.equal(toggle.textContent?.trim(), "Boards on");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.equal(one(item, ".fy-sw__context")?.getAttribute("title"), "Every shot inherits these unless it overrides them");
    assert.ok(named(item, "Review scene").classList.contains("ui-btn--sm"));
    assert.ok(named(item, "Generate frames").classList.contains("ui-btn--sm"));
    assert.equal(one(item, ".fy-sw__toolbar .fy-sw__spacer") !== null, true);

    const framed = await mount(stateWith({ allFramed: true }));
    assert.equal(one(framed, ".fy-sw__coverage")?.textContent, "every shot has a frame");
  });

  it("hands the row to the run bar while a run is active and keeps the header primary live", async () => {
    const item = await mount(stateWith({ runs: [frameState()] }));
    const bar = one(item, '.fy-sw__toolbar [data-testid="frame-run-bar"]');
    assert.ok(bar, "the bar stands in the toolbar row");
    assert.equal(one(item, ".fy-sw__runstrip"), null);
    assert.equal(one(item, ".fy-sw__coverage"), null, "the coverage line hides while a run owns the row");
    assert.equal(one(item, ".fy-sw__boards-toggle"), null, "the boards toggle hides while the run is unfinished");
    const progress = bar!.querySelector('[role="progressbar"]')!;
    assert.equal(progress.getAttribute("aria-valuenow"), "0");
    assert.equal(progress.getAttribute("aria-valuemax"), "2");
    assert.equal(progress.querySelector("span")?.getAttribute("style"), "width:0%");
    assert.equal(bar!.querySelector("progress"), null);
    assert.match(bar!.textContent ?? "", /Shot 12.*0 of 2 frames.*~9s left/);
    assert.equal((named(item, "Generate frames") as HTMLButtonElement).disabled, false);
    assert.equal(named(item, "Pause").getAttribute("data-primary"), null);

    await act(async () => __setStateForTest(stateWith({ runs: [frameState({ paused: true })] })));
    assert.equal(named(item, "Resume").getAttribute("data-primary"), "true");
    assert.equal(one(item, ".fy-sw__boards-toggle"), null);
  });

  it("keeps the finished bar and the boards toggle together and hides the coverage line", async () => {
    const complete = frameState({
      first: { status: "succeeded", finalization: "complete", etaSec: null },
      second: { status: "succeeded", finalization: "complete", etaSec: null },
      filed: true,
    });
    const item = await mount(stateWith({ runs: [complete] }));
    const bar = one(item, '.fy-sw__toolbar [data-testid="frame-run-bar"]')!;
    assert.ok(bar.classList.contains("fy-swrun--complete"));
    assert.match(bar.querySelector(".fy-swrun__done")?.textContent ?? "", /^2 frames added$/);
    assert.equal(named(item, "Review", bar).getAttribute("data-primary"), "true");
    assert.ok(bar.querySelector('[aria-label="Dismiss frame run"] svg'));
    assert.equal(bar.querySelector(".fy-swrun__rule"), null);
    assert.equal(one(item, ".fy-sw__coverage"), null);
    assert.equal(one(item, ".fy-sw__boards-toggle")?.textContent?.trim(), "Show boards");
  });

  it("returns the row to idle on cancel and dismisses the record once", async () => {
    const cancelled = frameState({
      cancelled: true,
      first: { status: "cancelled", etaSec: null },
      second: { status: "cancelled", etaSec: null },
    });
    assert.equal(cancelled.status, "cancelled");
    const sent: ClientMessage[] = [];
    const item = await mount(stateWith({ runs: [cancelled] }), sent);
    assert.equal(one(item, '[data-testid="frame-run-bar"]'), null);
    assert.equal(one(item, ".fy-sw__coverage")?.textContent, "2 of 2 without a frame");
    assert.ok(one(item, ".fy-sw__boards-toggle"));
    const dismissals = () => sent.filter((message) => message.kind === "frame-run-dismiss");
    assert.deepEqual(dismissals(), [{ kind: "frame-run-dismiss", worldId: FIXTURE_WORLD_ID, productionId: "saltlight", runId: RUN_ID }]);
    await act(async () => __setStateForTest(stateWith({ runs: [cancelled] })));
    assert.equal(dismissals().length, 1, "a re-render does not dismiss again");
  });
});

describe("the generate dialog (SPEC-036 R-15, R-16)", () => {
  it("reads as the design's stacked card", async () => {
    const item = await mount(stateWith());
    await click(named(item, "Generate frames"));
    const dialog = one(item, ".fy-swgen")!;
    assert.equal(dialog.querySelector('[aria-label="Close generate frames"]'), null, "dismissal is Cancel or the backdrop");
    assert.equal(dialog.querySelector(".fy-swgen__eyebrow"), null);
    assert.equal(dialog.querySelector(".fy-swgen__scene")?.textContent, "scene 4");
    assert.equal(dialog.querySelector("h2")?.textContent, "Generate 2 frames");
    const labels = [...dialog.querySelectorAll("h3")].map((label) => label.textContent);
    assert.deepEqual(labels, ["Method", "Packing", "Include", "Model"]);
    assert.match([...dialog.querySelectorAll('[aria-label="Frame generation method"] span')].map((note) => note.textContent).join("\n"), /grade together — a retry/);
    assert.equal(dialog.querySelectorAll('[aria-label="Frames to include"] button span').length, 0, "segments carry labels only");
    assert.match(dialog.querySelector(".fy-swgen__packing-head")?.textContent ?? "", /^Packing2 shots → 1 board15s clip limit$/);
    assert.match(dialog.querySelector(".fy-swgen__board-head")?.textContent ?? "", /^Board Ashots 12–1310\.0s \/ 15s$/);
    assert.match(dialog.querySelector(".fy-swgen__board-foot")?.textContent ?? "", /5\.0s spare/);
    assert.match(dialog.querySelector(".fy-swgen__packing .fy-swgen__hint")?.textContent ?? "", /^Boards break at the clip limit/);
    assert.match(dialog.querySelector('[aria-label="Image model"] [aria-checked="true"]')?.textContent ?? "", /^Frame image1536×864 · 4 refs$/);
    const context = dialog.querySelector(".fy-swgen__context")?.textContent ?? "";
    assert.match(context, /^applies the scene context · .*16:9$/);
    assert.doesNotMatch(context, /location ·|aspect ·/);
    const cancel = named(item, "Cancel", dialog);
    assert.ok(cancel.classList.contains("ui-btn--ghost") && cancel.classList.contains("ui-btn--sm"));
    assert.ok(named(item, "Generate frames", dialog).classList.contains("ui-btn--sm"));
    assert.match(dialog.querySelector(".fy-swgen__estimate")?.textContent ?? "", /2 frames · \$0\.08/);
  });

  it("swaps the primary for the sentence when the scope resolves to nothing", async () => {
    const item = await mount(stateWith({ allFramed: true }));
    await click(named(item, "Generate frames"));
    const dialog = one(item, ".fy-swgen")!;
    assert.ok(named(item, "Generate frames", dialog), "every-shot scope keeps the primary");
    await click(named(item, "Shots without a frame", dialog));
    const empty = dialog.querySelector(".fy-swgen__empty")!;
    assert.match(empty.textContent ?? "", /^Every shot already has a frame\. Switch to every shot in the scene to re-render\.$/);
    assert.equal([...dialog.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Generate frames"), false);
    assert.equal(dialog.querySelector(".fy-swgen__estimate"), null);
    await click(named(item, "every shot in the scene", dialog));
    assert.match(dialog.querySelector('[aria-label="Frames to include"] [aria-checked="true"]')?.textContent ?? "", /^Every shot in the scene$/);
    assert.ok(named(item, "Generate frames", dialog), "the switch brings the primary back");
    await click(named(item, "Shots without a frame", dialog));
    await click(named(item, "Close", dialog));
    assert.equal(one(item, ".fy-swgen"), null);
  });

  it("names a one-shot board as one shot in the packing card and on the board sheet", async () => {
    const item = await mount(stateWith({ singleShot: true }));
    await click(named(item, "Generate frames"));
    const dialog = one(item, ".fy-swgen")!;
    assert.match(dialog.querySelector(".fy-swgen__packing-head")?.textContent ?? "", /1 shot → 1 board/);
    assert.match(dialog.querySelector(".fy-swgen__board-head")?.textContent ?? "", /^Board Ashot 12/);
    await click(named(item, "Cancel", dialog));
    await click(one(item, ".fy-sw__boards-toggle")!);
    await click(one(item, '[aria-label="View board sheet A"]')!);
    const head = one(item, ".fy-swboard-sheet__head")!;
    assert.match(head.textContent ?? "", /shot 12 · 1 cell · one pass/);
    assert.match(head.textContent ?? "", /\d\.\ds \/ 15s/);
    assert.equal(head.querySelector('[aria-label="Close board sheet"] svg')?.getAttribute("width"), "13");
  });
});

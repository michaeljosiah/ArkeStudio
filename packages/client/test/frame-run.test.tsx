import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import {
  DEFAULT_SHOT_SEC,
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
  type WorldChatWorkspace,
} from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { ConversationTranscript } from "../src/components/conversation.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import {
  __applyEventForTest,
  __setBridgeForTest,
  __setStateForTest,
  __stateForTest,
  frameRunCommand,
  subscribeFrameRunQuote,
} from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
// An accepted start opens the editor (SPEC-039 R-44), whose playback engine pauses its <video>
// on mount. linkedom's media element has no pause or play, so the navigation would throw.
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), {
  pause() {},
  play: () => Promise.resolve(),
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});

const PATH = `/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes/sc_04`;
const RUN_ID = "fr_01J8E0000000000000000000R1";
const JOB_1 = "jb_01J8E0000000000000000000R1";
const JOB_2 = "jb_01J8E0000000000000000000R2";
const JOB_3 = "jb_01J8E0000000000000000000R3";
const QUOTE_ID = "01J8E0000000000000000000Q2";
const SIGNATURE = `sha256:${"a".repeat(64)}`;

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

function step(index: number, mode: "per-shot" | "board", shotIds: string[], jobId: string) {
  const panels = shotIds.map((shotId, panel) => ({ panel: panel + 1, shotId, role: "update" as const }));
  const layout = mode === "board" ? {
    columns: 2 as const,
    rows: 1,
    canvasWidth: 1536,
    canvasHeight: 432,
    regions: panels.map((panel, at) => ({ panel: panel.panel, x: at * 768, y: 0, width: 768, height: 432 })),
  } : undefined;
  const request = {
    prompt: `Frozen prompt ${index}`,
    panels,
    references: [],
    droppedReferences: [],
    provenance: { canonRevision: 42, artDirectionVersion: 3 },
    ...(layout === undefined ? {} : { layout }),
    aspect: "16:9",
    slotAtAuthorization: Object.fromEntries(shotIds.map((shotId) => [shotId, null])),
  };
  const output = mode === "board"
    ? { width: 1536, height: 432, aspect: "32:9" }
    : { width: 1536, height: 864, aspect: "16:9" };
  return {
    label: mode === "board" ? "Board A" : `Shot ${12 + index}`,
    requestShotIds: shotIds,
    updateShotIds: shotIds,
    request,
    dispatch: {
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      provider: "fal",
      model: IMAGE_MODEL.id,
      capability: "image" as const,
      target: mode === "board"
        ? { kind: "board-sheet" as const, coversShots: shotIds }
        : { kind: "shot" as const, id: shotIds[0]!, coversShots: shotIds },
      references: [],
      referenceCapacity: 4,
      output,
      routeOutput: { width: 1536, height: 864, aspect: "16:9" },
      cellOutput: { width: mode === "board" ? 768 : 1536, height: mode === "board" ? 432 : 864, aspect: "16:9" },
      estimatedMicroUsd: 37_000,
      cellEstimatedMicroUsd: 37_000,
      params: { prompt: request.prompt, references: [], output, request },
      landing: { dir: `incoming/${index}`, name: `frame-${index}.png` },
      idempotencyKey: `01J8E0000000000000000000K${index + 1}`,
    },
    sourceStepIndex: index,
    grain: "initial" as const,
    jobId,
    landingOutcomes: {},
  };
}

function frameState(options: {
  mode?: "per-shot" | "board";
  sceneVersion?: number;
  paused?: boolean;
  cancelled?: boolean;
  first?: Partial<FrameRunJobFacts>;
  second?: Partial<FrameRunJobFacts>;
  firstLanding?: "filed" | "superseded";
  secondLanding?: "filed" | "superseded";
} = {}): FrameRunState {
  const mode = options.mode ?? "per-shot";
  const steps = mode === "board"
    ? [step(0, mode, ["sh_12", "sh_13"], JOB_1)]
    : [step(0, mode, ["sh_12"], JOB_1), step(1, mode, ["sh_13"], JOB_2)];
  if (options.firstLanding !== undefined) steps[0]!.landingOutcomes = Object.fromEntries(steps[0]!.updateShotIds.map((id) => [id, options.firstLanding]));
  if (options.secondLanding !== undefined && steps[1] !== undefined) steps[1].landingOutcomes = { sh_13: options.secondLanding };
  const run = FrameRunSchema.parse({
    id: RUN_ID,
    sceneId: "sc_04",
    sceneVersion: options.sceneVersion ?? 2,
    mode,
    model: IMAGE_MODEL.id,
    steps,
    cursor: steps.length,
    paused: options.paused ?? false,
    cancelled: options.cancelled ?? false,
    createdAt: "2026-08-30T12:00:00Z",
  });
  const facts: FrameRunJobFacts[] = [
    { id: JOB_1, status: "running", etaSec: 9, ...options.first },
    ...(mode === "board" ? [] : [{ id: JOB_2, status: "queued" as const, etaSec: null, ...options.second }]),
  ];
  return FrameRunStateSchema.parse(foldFrameRun(run, facts));
}

function stateWith(options: { runs?: FrameRunState[]; allFramed?: boolean; noShots?: boolean; imageModels?: ManifestModel[] } = {}): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const video = state.app.manifest!.models.find((model) => model.capability === "video")!;
  video.limits.storyboardPanels = 6;
  state.app.manifest!.models.push(...(options.imageModels ?? [IMAGE_MODEL]));
  state.frameRuns = options.runs ?? [];
  const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
  if (options.noShots) (scene as unknown as { shots: unknown[] }).shots = [];
  if (options.allFramed) {
    const frameTake = production.takes.find((take) => take.kind === "frame")!;
    for (const shot of orderedShots(scene)) production.selections[shot.id] = { acceptedTakeId: frameTake.id, trimInSec: 0 };
  }
  return state;
}

function retriedFrameState(): FrameRunState {
  const failed = frameState({
    first: { status: "failed", failureClass: "transient", error: "provider timed out", etaSec: null },
    second: { status: "succeeded", finalization: "complete", etaSec: null },
    secondLanding: "filed",
  });
  const run = structuredClone(failed.run);
  run.steps.push({
    ...step(2, "per-shot", ["sh_12"], JOB_3),
    sourceStepIndex: 0,
    grain: "step-retry",
    retryOf: 0,
    landingOutcomes: { sh_12: "filed" },
  });
  run.cursor = run.steps.length;
  return FrameRunStateSchema.parse(foldFrameRun(run, [
    { id: JOB_1, status: "failed", failureClass: "transient", error: "provider timed out" },
    { id: JOB_2, status: "succeeded", finalization: "complete" },
    { id: JOB_3, status: "succeeded", finalization: "complete" },
  ]));
}

function reportWorkspace(runId = RUN_ID): WorldChatWorkspace {
  return {
    conversationId: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC",
    status: "open",
    initiative: "collaborate",
    hasMore: false,
    runStatus: null,
    runStartedAt: null,
    retrievalUnavailable: false,
    attachments: [],
    seq: 1,
    points: [],
    messages: [{
      id: "msg_01J8F3K2QW9VZX4N7M0RTYB6HC",
      role: "studio",
      text: "I finished the frame run.",
      receipts: [],
      refusals: [],
      frameRunOutcome: { runId, productionId: "saltlight", sceneId: "sc_04" },
      createdAt: "2026-08-30T12:02:00Z",
    }],
  };
}

function stateWithBoardSheet(dismissed = false, fixedSecond = false): ClientState {
  let complete = frameState({
    mode: "board",
    first: { status: "succeeded", finalization: "complete", etaSec: null },
    firstLanding: "filed",
  });
  if (fixedSecond) {
    const run = structuredClone(complete.run);
    const step = run.steps[0]!;
    step.updateShotIds = ["sh_12"];
    step.landingOutcomes = { sh_12: "filed" };
    step.request.panels[1] = {
      panel: 2,
      shotId: "sh_13",
      role: "fixed",
      fixedImage: { source: "artifact", id: "ar_01J8E0000000000000000000A2", path: "artifacts/shot-13-existing.png" },
    };
    step.request.slotAtAuthorization = { sh_12: null };
    step.dispatch.references = ["artifacts/shot-13-existing.png"];
    step.dispatch.params = { ...step.dispatch.params, references: step.dispatch.references, request: step.request };
    complete = FrameRunStateSchema.parse(foldFrameRun(run, [
      { id: JOB_1, status: "succeeded", finalization: "complete" },
    ]));
  }
  if (dismissed) complete.run.dismissed = true;
  const state = stateWith({ runs: [complete] });
  const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  const source = production.takes.find((take) => take.kind === "frame")!;
  production.takes.push({
    ...source,
    id: "tk_01J8E0000000000000000000P1",
    jobId: JOB_1,
    coversShots: ["sh_12", "sh_13"],
    boardSheetParent: true,
    dispatchedAt: "2026-08-30T12:00:00Z",
    completedAt: "2026-08-30T12:01:00Z",
    media: "board.png",
  });
  const firstArtifact = {
    id: "ar_01J8E0000000000000000000A1",
    kind: "image" as const,
    file: "shot-12-board.png",
    hash: "sha256:0123456789abcdef" as const,
    origin: { by: "system" as const, producedBy: `frame-run:${JOB_1}` },
    links: ["saltlight", "sh_12", "tk_01J8E0000000000000000000P1"],
    production: "saltlight",
    created: "2026-08-30T12:01:00Z",
  };
  state.world!.artifacts.push(firstArtifact);
  production.selections.sh_12 = { ...production.selections.sh_12, trimInSec: 0, startFrameArtifactId: firstArtifact.id };
  if (fixedSecond) {
    state.world!.artifacts.push({
      id: "ar_01J8E0000000000000000000A2",
      kind: "image",
      file: "shot-13-existing.png",
      hash: "sha256:fedcba9876543210",
      origin: { by: "user" },
      links: ["saltlight", "sh_13"],
      production: "saltlight",
      created: "2026-08-30T11:00:00Z",
    });
    production.selections.sh_13 = { trimInSec: 0, startFrameArtifactId: "ar_01J8E0000000000000000000A2" };
  }
  return state;
}

function quoteFor(message: Extract<ClientMessage, { kind: "frame-run-quote" }>, blockedReason: string | null = null): FrameRunQuote {
  const shotIds = message.shotId === undefined ? ["sh_12", "sh_13"] : [message.shotId];
  const estimatedMicroUsd = message.shotId === undefined ? 81_234 : 37_000;
  return {
    requestId: message.requestId,
    quoteId: QUOTE_ID,
    signature: blockedReason === null ? SIGNATURE : null,
    worldId: message.worldId,
    productionId: message.productionId,
    sceneId: message.sceneId,
    sceneVersion: blockedReason === null ? 2 : null,
    mode: message.mode,
    modelId: message.modelId,
    scope: message.scope,
    ...(message.shotId === undefined ? {} : { shotId: message.shotId }),
    includedCount: blockedReason === null ? shotIds.length : 0,
    steps: blockedReason === null ? [{
      label: message.shotId === undefined ? "Board A" : `Shot ${message.shotId.replace(/^sh_0*/, "")}`,
      requestShotIds: shotIds,
      updateShotIds: shotIds,
      estimatedMicroUsd,
    }] : [],
    estimatedMicroUsd: blockedReason === null ? estimatedMicroUsd : null,
    blockedReason,
    quotedAt: "2026-08-30T12:00:01Z",
  };
}

function emitQuote(quote: FrameRunQuote): void {
  __applyEventForTest({ at: quote.quotedAt, type: "production.frame-run-quote", quote });
}

function emitStartResult(input: {
  requestId: string;
  quoteId: string;
  disposition: "accepted" | "refused";
  reason?: string;
}): void {
  __applyEventForTest({
    at: "2026-08-30T12:00:02Z",
    type: "production.frame-run-start-result",
    requestId: input.requestId,
    quoteId: input.quoteId,
    worldId: FIXTURE_WORLD_ID,
    productionId: "saltlight",
    disposition: input.disposition,
    ...(input.disposition === "accepted" ? { runId: RUN_ID } : {}),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

function capture(sent: ClientMessage[], autoQuote = true, blockedReason: string | null = null): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => {
      const message = JSON.parse(json) as ClientMessage;
      sent.push(message);
      if (autoQuote && message.kind === "frame-run-quote") emitQuote(quoteFor(message, blockedReason));
    },
  } as unknown as ArkeBridge;
}

async function mount(state: ClientState, sent: ClientMessage[] = [], autoQuote = true, blockedReason: string | null = null): Promise<Mounted> {
  __setBridgeForTest(capture(sent, autoQuote, blockedReason));
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

async function mountReport(
  runs: FrameRunState[],
  sent: ClientMessage[] = [],
  selected: string[] = [],
  outcomeRunId = RUN_ID,
): Promise<Mounted> {
  __setBridgeForTest(capture(sent, false));
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(stateWith({ runs }));
    root.render(
      <MemoryRouter initialEntries={[PATH]}>
        <ConversationTranscript
          workspace={reportWorkspace(outcomeRunId)}
          running={false}
          progress={null}
          failure={null}
          canRetry
          frameRuns={runs}
          onSelectShot={(shotId) => selected.push(shotId)}
        />
      </MemoryRouter>,
    );
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
const named = (item: Mounted, text: string): HTMLElement => {
  const found = all(item, "button").find((button) => button.textContent?.trim() === text);
  assert.ok(found, `button ${text} exists`);
  return found;
};
const click = async (element: HTMLElement) => act(async () => element.click());

describe("frame-run quote authorization", () => {
  it("quotes current options, displays the backend amount, and echoes the authorization on start", async () => {
    const sent: ClientMessage[] = [];
    const item = await mount(stateWith(), sent);
    assert.deepEqual(
      sent.find((message) => message.kind === "frame-run-list"),
      { kind: "frame-run-list", worldId: FIXTURE_WORLD_ID, productionId: "saltlight" },
    );
    await click(named(item, "Generate frames"));
    const request = sent.find((message): message is Extract<ClientMessage, { kind: "frame-run-quote" }> => message.kind === "frame-run-quote")!;
    assert.deepEqual({ ...request, requestId: "request" }, {
      kind: "frame-run-quote",
      requestId: "request",
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      sceneId: "sc_04",
      mode: "board",
      modelId: IMAGE_MODEL.id,
      scope: "missing",
    });
    const dialog = one(item, ".fy-swgen")!;
    assert.match(dialog.textContent ?? "", /2 frames · \$0.08/);
    assert.doesNotMatch(dialog.textContent ?? "", /~\$/);
    assert.match(dialog.textContent ?? "", /Packing.*2 shots → 1 board.*15s clip limit/);
    assert.match(dialog.textContent ?? "", /1536×864 · 4 refs/);
    await click([...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Generate frames") as HTMLElement);
    assert.deepEqual(sent.at(-1), {
      kind: "frame-run-start",
      requestId: request.requestId,
      quoteId: QUOTE_ID,
      quoteSignature: SIGNATURE,
      quotedMicroUsd: 81_234,
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      sceneId: "sc_04",
      mode: "board",
      modelId: IMAGE_MODEL.id,
      scope: "missing",
    });
    assert.ok(one(item, ".fy-swgen"), "sending alone keeps the dialog open");
    assert.match(one(item, ".fy-swgen")?.textContent ?? "", /Starting frame run/);
    assert.equal([...one(item, ".fy-swgen")!.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "Starting...").length, 1);
    await act(async () => emitStartResult({ requestId: request.requestId, quoteId: QUOTE_ID, disposition: "accepted" }));
    assert.equal(one(item, ".fy-swgen"), null, "the matching acceptance closes it");
    assert.equal(__stateForTest().frameRunStartResults[`${request.requestId}:${QUOTE_ID}`], undefined, "accepted result is consumed");
  });

  it("quotes and starts only the row whose Generate frame control was clicked", async () => {
    const sent: ClientMessage[] = [];
    const item = await mount(stateWith(), sent);
    const targetShotId = "sh_13";
    const row = one(item, `[data-testid="workspace-row-${targetShotId}"]`)!;
    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Generate frame") as HTMLElement);

    const request = sent.find((message): message is Extract<ClientMessage, { kind: "frame-run-quote" }> => message.kind === "frame-run-quote")!;
    assert.deepEqual(
      { shotId: request.shotId, mode: request.mode, scope: request.scope },
      { shotId: targetShotId, mode: "per-shot", scope: "all" },
    );
    const quote = __stateForTest().frameRunQuotes[request.requestId]!;
    assert.equal(quote.shotId, targetShotId);
    assert.equal(quote.includedCount, 1);
    assert.deepEqual(quote.steps, [{
      label: "Shot 13",
      requestShotIds: [targetShotId],
      updateShotIds: [targetShotId],
      estimatedMicroUsd: 37_000,
    }]);

    await click([...one(item, ".fy-swgen")!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Generate frames") as HTMLElement);
    const start = sent.at(-1);
    assert.ok(start && start.kind === "frame-run-start");
    assert.deepEqual(
      { shotId: start.shotId, mode: start.mode, scope: start.scope },
      { shotId: targetShotId, mode: "per-shot", scope: "all" },
    );
    assert.deepEqual(quote.steps.flatMap((step) => step.requestShotIds), [targetShotId], "the quote contains no second shot");
  });

  it("ignores an unrelated start result", async () => {
    const sent: ClientMessage[] = [];
    const item = await mount(stateWith(), sent);
    await click(named(item, "Generate frames"));
    const request = sent.find((message): message is Extract<ClientMessage, { kind: "frame-run-quote" }> => message.kind === "frame-run-quote")!;
    await click([...one(item, ".fy-swgen")!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Generate frames") as HTMLElement);
    await act(async () => emitStartResult({ requestId: "01J8E0000000000000000000Q9", quoteId: QUOTE_ID, disposition: "accepted" }));
    await act(async () => emitStartResult({ requestId: request.requestId, quoteId: "01J8E0000000000000000000Q8", disposition: "accepted" }));
    assert.ok(one(item, ".fy-swgen"));
    assert.match(one(item, ".fy-swgen")?.textContent ?? "", /Starting frame run/);
    await act(async () => emitStartResult({ requestId: request.requestId, quoteId: QUOTE_ID, disposition: "accepted" }));
    assert.equal(one(item, ".fy-swgen"), null, "unrelated results do not consume the matching listener");
  });

  it("keeps a refusal open, says the exact reason, consumes the quote, and requotes", async () => {
    const sent: ClientMessage[] = [];
    const item = await mount(stateWith(), sent);
    await click(named(item, "Generate frames"));
    const first = sent.find((message): message is Extract<ClientMessage, { kind: "frame-run-quote" }> => message.kind === "frame-run-quote")!;
    const dialog = one(item, ".fy-swgen")!;
    const primary = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Generate frames") as HTMLElement;
    await click(primary);
    await click(primary);
    assert.equal(sent.filter((message) => message.kind === "frame-run-start").length, 1, "pending prevents a second press");
    await act(async () => emitStartResult({ requestId: first.requestId, quoteId: QUOTE_ID, disposition: "refused", reason: "the frame-run quote is stale; request a new quote" }));
    assert.ok(one(item, ".fy-swgen"));
    assert.match(dialog.textContent ?? "", /the frame-run quote is stale; request a new quote/);
    assert.equal(__stateForTest().frameRunQuotes[first.requestId], undefined);
    assert.equal(__stateForTest().frameRunStartResults[`${first.requestId}:${QUOTE_ID}`], undefined, "refused result is consumed");
    const quotes = sent.filter((message): message is Extract<ClientMessage, { kind: "frame-run-quote" }> => message.kind === "frame-run-quote");
    assert.equal(quotes.length, 2);
    assert.notEqual(quotes[1]!.requestId, first.requestId);
    assert.equal(quotes[1]!.mode, first.mode);
    assert.equal(quotes[1]!.modelId, first.modelId);
    assert.equal(quotes[1]!.scope, first.scope);
    assert.equal(([...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Generate frames") as HTMLButtonElement).disabled, false);
  });

  it("ignores stale quote replies after options change and supports roving radio keys", async () => {
    const sent: ClientMessage[] = [];
    const item = await mount(stateWith(), sent, false);
    await click(named(item, "Generate frames"));
    const first = sent.find((message): message is Extract<ClientMessage, { kind: "frame-run-quote" }> => message.kind === "frame-run-quote")!;
    const boardRadio = one(item, '[aria-label="Frame generation method"] [aria-checked="true"]')!;
    const key = new dom.window.Event("keydown", { bubbles: true }) as unknown as KeyboardEvent;
    Object.defineProperty(key, "key", { value: "ArrowLeft" });
    await act(async () => boardRadio.dispatchEvent(key));
    const requests = sent.filter((message): message is Extract<ClientMessage, { kind: "frame-run-quote" }> => message.kind === "frame-run-quote");
    const current = requests.at(-1)!;
    assert.notEqual(current.requestId, first.requestId);
    assert.equal(current.mode, "per-shot");

    await act(async () => emitQuote(quoteFor(first)));
    const dialogPrimary = () => [...one(item, ".fy-swgen")!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Generate frames") as HTMLButtonElement;
    assert.equal(dialogPrimary().disabled, true, "stale authorization stays disabled");
    await act(async () => emitQuote(quoteFor(current)));
    assert.equal(dialogPrimary().disabled, false);
  });

  it("shows backend blockedReason and preserves a stranded production image model", async () => {
    const state = stateWith({ imageModels: [IMAGE_MODEL, { ...IMAGE_MODEL, id: "other", displayName: "Other image" }] });
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    production.meta.models = { ...production.meta.models, image: IMAGE_MODEL.id };
    state.app.models.disabled.push(IMAGE_MODEL.id);
    const sent: ClientMessage[] = [];
    const item = await mount(state, sent, true, "Frame image is not currently eligible to run");
    await click(named(item, "Generate frames"));
    const dialog = one(item, ".fy-swgen")!;
    assert.match(dialog.textContent ?? "", /Frame image · unavailable/);
    assert.match(dialog.textContent ?? "", /has not been replaced by another model/);
    assert.match(dialog.textContent ?? "", /Frame image is not currently eligible to run/);
    const request = sent.find((message): message is Extract<ClientMessage, { kind: "frame-run-quote" }> => message.kind === "frame-run-quote")!;
    assert.equal(__stateForTest().frameRunQuotes[request.requestId]?.sceneVersion, null, "a blocked quote with no readable scene still matches its option identity");
    assert.equal(request.modelId, IMAGE_MODEL.id, "the stored unavailable choice is quoted, not a fallback");
    assert.equal([...dialog.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Generate frames"), false);
  });

  it("keeps all three zero guards behind backend quotes", async () => {
    const allFramed = await mount(stateWith({ allFramed: true }));
    await click(named(allFramed, "Generate frames"));
    const selectedScope = one(allFramed, '[aria-label="Frames to include"] [aria-checked="true"]')!;
    assert.match(selectedScope.textContent ?? "", /Every shot/);

    const noShots = await mount(stateWith({ noShots: true }), [], true, "nothing to generate - this scope contains zero shots");
    await click(named(noShots, "Generate frames"));
    assert.match(one(noShots, ".fy-swgen")?.textContent ?? "", /nothing to generate - this scope contains zero shots/);
    assert.equal(all(noShots, "button").filter((button) => button.textContent?.trim() === "Generate frames").length, 1, "only the header primary remains");
  });

  it("keeps the dialog open when start cannot be sent", async () => {
    const item = await mount(stateWith());
    await click(named(item, "Generate frames"));
    __setBridgeForTest(null);
    await click([...one(item, ".fy-swgen")!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Generate frames") as HTMLElement);
    assert.ok(one(item, ".fy-swgen"));
    assert.match(one(item, ".fy-swgen")?.textContent ?? "", /could not be sent/);
  });
});

describe("durable run projections", () => {
  it("joins recovery by world, production, and scene, then sends pause/resume/cancel", async () => {
    const wrongWorld = { ...frameState(), worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD" };
    const active = frameState();
    const sent: ClientMessage[] = [];
    const item = await mount(stateWith({ runs: [wrongWorld, active] }), sent);
    assert.match(one(item, '[data-testid="frame-run-bar"]')?.textContent ?? "", /Shot 12.*0 of 2 frames.*~9s left/);
    const editsBefore = sent.filter((message) => message.kind === "scene-command").length;
    const script = one(item, ".fy-swrow__script")!;
    const textarea = script.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      textarea.value = "Edited while frames run.";
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => script.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
    assert.equal(
      sent.filter((message) => message.kind === "scene-command").length,
      editsBefore + 1,
      "the script edit is sent among recovery polling",
    );
    await click(named(item, "Pause"));
    await click(named(item, "Cancel"));
    assert.equal(sent.at(-2)?.kind, "frame-run-pause");
    assert.equal(sent.at(-1)?.kind, "frame-run-cancel");

    await act(async () => __setStateForTest(stateWith({ runs: [frameState({ paused: true })] })));
    assert.match(one(item, '[data-testid="frame-run-bar"]')?.textContent ?? "", /paused · finishing 2/);
    await click(named(item, "Resume"));
    assert.equal(sent.at(-1)?.kind, "frame-run-resume");
  });

  it("uses authoritative shot counts without aggregate board overcount", async () => {
    const complete = frameState({
      mode: "board",
      first: { status: "succeeded", finalization: "complete", etaSec: null },
      firstLanding: "filed",
    });
    const item = await mount(stateWith({ runs: [complete] }));
    assert.equal(complete.filedShots, 2);
    assert.match(one(item, '[data-testid="frame-run-bar"]')?.textContent ?? "", /^2 frames added/);
  });

  it("completes and names a board whose local finalization failed", async () => {
    const failed = frameState({
      mode: "board",
      first: {
        status: "succeeded",
        finalization: "failed",
        finalizationError: "board panels could not be prepared",
        etaSec: null,
      },
    });
    const item = await mount(stateWith({ runs: [failed] }));
    assert.match(one(item, '[data-testid="frame-run-bar"]')?.textContent ?? "", /^0 frames added · 2 failed/);
    assert.match(one(item, ".fy-swrunboards")?.textContent ?? "", /Board A.*board panels could not be prepared/);
    assert.equal(all(item, "button").some((button) => ["Pause", "Cancel"].includes(button.textContent?.trim() ?? "")), false);
  });

  it("offers failed board retry only, then a cell retry only from backend per-shot facts", async () => {
    const sent: ClientMessage[] = [];
    const failed = frameState({ mode: "board", first: { status: "failed", failureClass: "transient", error: "provider timed out", etaSec: null } });
    const state = stateWith({ runs: [failed] });
    // Repack the live scene away from the frozen two-shot Board A.
    const scene = state.world!.productions[0]!.scenes[0]!;
    orderedShots(scene)[0]!.durationSec = 15;
    const item = await mount(state, sent);
    const row = one(item, '[data-testid="workspace-row-sh_12"]')!;
    assert.equal([...row.querySelectorAll("button")].some((button) => button.textContent === "Retry"), false);
    const durableFailure = one(item, ".fy-swrunboards")!;
    assert.match(durableFailure.textContent ?? "", /Board A.*provider timed out/);
    await click([...durableFailure.querySelectorAll("button")].find((button) => button.textContent === "Retry board") as HTMLElement);
    assert.deepEqual(sent.at(-1), { kind: "frame-run-retry-step", worldId: FIXTURE_WORLD_ID, productionId: "saltlight", runId: RUN_ID, stepIndex: 0 });

    const successful = frameState({ mode: "board", first: { status: "succeeded", finalization: "complete", etaSec: null }, firstLanding: "filed" });
    await act(async () => __setStateForTest(stateWith({ runs: [successful] })));
    const retry = [...row.querySelectorAll("button")].find((button) => button.textContent === "Retry") as HTMLElement;
    assert.ok(retry);
    await click(retry);
    assert.deepEqual(sent.at(-1), { kind: "frame-run-retry-cell", worldId: FIXTURE_WORLD_ID, productionId: "saltlight", runId: RUN_ID, stepIndex: 0, shotId: "sh_12" });
  });

  it("keeps view tabs available so a failed run can move from Flow to Storyboard", async () => {
    const sent: ClientMessage[] = [];
    const failed = frameState({ mode: "board", first: { status: "failed", failureClass: "transient", error: "provider timed out", etaSec: null } });
    const item = await mount(stateWith(), sent);
    await click(all(item, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    await act(async () => __setStateForTest(stateWith({ runs: [failed] })));
    assert.ok(one(item, '[data-testid="workspace-flow"]'));
    assert.ok(one(item, '[data-testid="frame-run-bar"]'));
    assert.ok(one(item, ".fy-swrunboards"), "durable board retry remains visible in Flow");
    await click(all(item, ".fy-sw__tab").find((tab) => tab.textContent === "Storyboard")!);
    assert.ok(one(item, '[data-testid="workspace-rows"]'));
    const retry = [...one(item, ".fy-swrunboards")!.querySelectorAll("button")].find((button) => button.textContent === "Retry board") as HTMLElement;
    await click(retry);
    assert.equal(sent.at(-1)?.kind, "frame-run-retry-step");
  });

  it("names held lanes, hides terminal retry, and marks edits newer than the frozen run", async () => {
    const held = frameState({ sceneVersion: 1, first: { status: "running", failureClass: "provider-fault", error: "quota probe failed", providerHeld: true } });
    const item = await mount(stateWith({ runs: [held] }));
    const firstRow = one(item, '[data-testid="workspace-row-sh_12"]')!;
    assert.match(firstRow.textContent ?? "", /quota probe failed · lane held/);
    assert.match(firstRow.textContent ?? "", /script changed/);

    const terminal = frameState({ first: { status: "failed", failureClass: "terminal", error: "content policy", etaSec: null } });
    await act(async () => __setStateForTest(stateWith({ runs: [terminal] })));
    assert.match(firstRow.textContent ?? "", /content policy/);
    assert.equal([...firstRow.querySelectorAll("button")].some((button) => button.textContent === "Retry"), false);
  });

  it("drops the lane-held suffix once an offline job has given up", async () => {
    // A queued offline job is genuinely held: the dispatcher paused the lane and resumes it with
    // connectivity. The exhausted job is terminal and nothing is paused, so its row must not
    // promise a resume (issue 697).
    const queued = frameState({ first: { status: "queued", failureClass: "offline", error: "fetch failed", etaSec: null } });
    const item = await mount(stateWith({ runs: [queued] }));
    const firstRow = one(item, '[data-testid="workspace-row-sh_12"]')!;
    assert.match(firstRow.textContent ?? "", /fetch failed · lane held/);

    const exhausted = { status: "failed" as const, failureClass: "offline" as const, error: "gave up after 4 attempts: fetch failed", etaSec: null };
    await act(async () => __setStateForTest(stateWith({ runs: [frameState({ first: exhausted })] })));
    assert.match(firstRow.textContent ?? "", /gave up after 4 attempts: fetch failed/);
    assert.doesNotMatch(firstRow.textContent ?? "", /lane held/);

    await act(async () => __setStateForTest(stateWith({ runs: [frameState({ mode: "board", first: exhausted })] })));
    const durableFailure = one(item, ".fy-swrunboards")!;
    assert.match(durableFailure.textContent ?? "", /Board A.*gave up after 4 attempts: fetch failed/);
    assert.doesNotMatch(durableFailure.textContent ?? "", /lane held/);
  });

  it("reviews this run's filed artifact with the shot in its accessible name and dismisses", async () => {
    const sent: ClientMessage[] = [];
    const complete = frameState({ first: { status: "succeeded", finalization: "complete", etaSec: null }, firstLanding: "filed", second: { status: "failed", failureClass: "terminal", error: "invalid parameters", etaSec: null } });
    const state = stateWith({ runs: [complete] });
    state.world!.artifacts.push({
      id: "ar_01J8E0000000000000000000R1",
      kind: "image",
      file: "run-frame.png",
      hash: "sha256:0123456789abcdef",
      origin: { by: "system", producedBy: `frame-run:${JOB_1}` },
      links: ["saltlight", "sh_12"],
      production: "saltlight",
      created: "2026-08-30T12:01:00Z",
    });
    const item = await mount(state, sent);
    assert.match(one(item, '[data-testid="frame-run-bar"]')?.textContent ?? "", /1 frame added · 1 failed/);
    // Review opens the first frame the run put down in the one lightbox, to arrow through (R-19).
    await click(named(item, "Review"));
    assert.equal(one(item, ".fy-swlightbox img")?.getAttribute("alt"), "Maren at the rail, listening");
    assert.match(one(item, ".fy-swlightbox")?.textContent ?? "", /shot 12/);
    await click(one(item, '.fy-swlightbox [aria-label="Close"]')!);
    await click(one(item, '[aria-label="Dismiss frame run"]')!);
    assert.equal(sent.at(-1)?.kind, "frame-run-dismiss");
  });
});

describe("durable frame-run reports in Arke", () => {
  it("joins only the exact causal run and exposes its steps, failure, selection, and retry", async () => {
    const failed = frameState({
      first: { status: "failed", failureClass: "transient", error: "provider timed out", etaSec: null },
      second: { status: "succeeded", finalization: "complete", etaSec: null },
      secondLanding: "filed",
    });
    const mismatched = { ...failed, productionId: "another-production" };
    const loading = await mountReport([mismatched]);
    assert.match(one(loading, ".fy-chat__runreport")?.textContent ?? "", /Loading run report/);

    const sent: ClientMessage[] = [];
    const selected: string[] = [];
    const item = await mountReport([failed], sent, selected);
    assert.equal(all(item, '.fy-chat__runreport-row[data-kind="step"]').length, 2);
    const failure = one(item, '.fy-chat__runreport-row[data-kind="failure"]')!;
    assert.match(failure.textContent ?? "", /provider timed out/);
    await click(failure.querySelector("button") as HTMLElement);
    assert.deepEqual(selected, ["sh_12"]);
    await click(failure.querySelector(".fy-chat__runreport-retry") as HTMLElement);
    assert.deepEqual(sent.at(-1), {
      kind: "frame-run-retry-step",
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      runId: RUN_ID,
      stepIndex: 0,
    });
  });

  it("keeps the original failure words after a successful retry without offering it again", async () => {
    const item = await mountReport([retriedFrameState()]);
    const failure = one(item, '.fy-chat__runreport-row[data-kind="failure"]')!;
    assert.equal(failure.getAttribute("data-state"), "complete");
    assert.match(failure.textContent ?? "", /provider timed out · retried/);
    assert.equal(failure.querySelector(".fy-chat__runreport-retry"), null);
  });

  it("does not offer retry for a terminal refusal", async () => {
    const terminal = frameState({
      first: { status: "failed", failureClass: "terminal", error: "content policy", etaSec: null },
      second: { status: "succeeded", finalization: "complete", etaSec: null },
      secondLanding: "filed",
    });
    const item = await mountReport([terminal]);
    const failure = one(item, '.fy-chat__runreport-row[data-kind="failure"]')!;
    assert.match(failure.textContent ?? "", /content policy/);
    assert.equal(failure.querySelector(".fy-chat__runreport-retry"), null);
  });

  it("names an exhausted offline failure without claiming the lane is held", async () => {
    const offline = frameState({
      first: { status: "failed", failureClass: "offline", error: "gave up after 4 attempts: fetch failed", etaSec: null },
      second: { status: "succeeded", finalization: "complete", etaSec: null },
      secondLanding: "filed",
    });
    const item = await mountReport([offline]);
    const failure = one(item, '.fy-chat__runreport-row[data-kind="failure"]')!;
    assert.match(failure.textContent ?? "", /gave up after 4 attempts: fetch failed/);
    assert.doesNotMatch(failure.textContent ?? "", /lane held/);
  });
});

describe("board sheet review", () => {
  it("matches the prototype grid and sends board and cell retry through the durable run", async () => {
    const sent: ClientMessage[] = [];
    const item = await mount(stateWithBoardSheet(), sent);
    const open = one(item, '[aria-label="View board sheet A"]')!;
    await click(open);

    const sheet = one(item, ".fy-swboard-sheet")!;
    assert.equal(sheet.parentElement?.classList.contains("fy-sw"), true, "the overlay mounts on the whole app frame");
    assert.match(sheet.textContent ?? "", /Board A.*shots 12–13 · 2 cells · one pass.*10\.0s \/ 15s/);
    assert.match(sheet.textContent ?? "", /One image, one pass .* cast, light and grade are shared/);
    assert.equal(one(item, ".fy-swboard-sheet__grid")?.getAttribute("data-columns"), "2");
    assert.equal(one(item, '[data-testid="board-sheet-cell-sh_12"]')?.getAttribute("style"), "aspect-ratio:16 / 9");
    assert.match(one(item, '[data-testid="board-sheet-cell-sh_12"] img')?.getAttribute("src") ?? "", /artifacts\/shot-12-board\.png$/);
    assert.match(one(item, '[data-testid="board-sheet-cell-sh_13"]')?.textContent ?? "", /no frame yet/);
    assert.match(one(item, '[data-testid="board-sheet-cell-sh_12"]')?.textContent ?? "", /shot 12.*4\.0s/);

    await click(one(item, '[aria-label="Retry shot 12 against board A"]')!);
    assert.deepEqual(sent.at(-1), {
      kind: "frame-run-retry-cell",
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      runId: RUN_ID,
      stepIndex: 0,
      shotId: "sh_12",
    });
    await click([...sheet.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry board") as HTMLElement);
    assert.deepEqual(sent.at(-1), {
      kind: "frame-run-retry-step",
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      runId: RUN_ID,
      stepIndex: 0,
    });
    await click(sheet);
    assert.equal(one(item, ".fy-swboard-sheet"), null);
  });

  it("keeps dismissed run lineage available without putting its bar back", async () => {
    const sent: ClientMessage[] = [];
    const item = await mount(stateWithBoardSheet(true), sent);
    assert.equal(one(item, '[data-testid="frame-run-bar"]'), null);
    await click(named(item, "Show boards"));
    await click(one(item, '[aria-label="View board sheet A"]')!);
    assert.equal((one(item, '[aria-label="Retry shot 12 against board A"]') as HTMLButtonElement).disabled, false);
    await click(one(item, '[aria-label="Retry shot 12 against board A"]')!);
    assert.equal(sent.at(-1)?.kind, "frame-run-retry-cell");
  });

  it("retries a failed first board pass before any parent sheet exists", async () => {
    const failed = frameState({
      mode: "board",
      first: { status: "failed", failureClass: "transient", error: "provider timed out", etaSec: null },
    });
    const sent: ClientMessage[] = [];
    const item = await mount(stateWith({ runs: [failed] }), sent);
    await click(one(item, '[aria-label="View board sheet A"]')!);
    const retry = [...one(item, ".fy-swboard-sheet")!.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Retry board") as HTMLButtonElement;
    assert.equal(retry.disabled, false);
    await click(retry);
    assert.deepEqual(sent.at(-1), {
      kind: "frame-run-retry-step",
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      runId: RUN_ID,
      stepIndex: 0,
    });
  });

  it("offers Retry for a fixed reference cell once the board parent exists", async () => {
    const sent: ClientMessage[] = [];
    const item = await mount(stateWithBoardSheet(false, true), sent);
    await click(one(item, '[aria-label="View board sheet A"]')!);
    const fixedRetry = one(item, '[aria-label="Retry shot 13 against board A"]') as HTMLButtonElement;
    assert.equal(fixedRetry.disabled, false);
    await click(fixedRetry);
    assert.deepEqual(sent.at(-1), {
      kind: "frame-run-retry-cell",
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      runId: RUN_ID,
      stepIndex: 0,
      shotId: "sh_13",
    });
  });

  it("uses three columns beyond four members and keeps portrait production cells", async () => {
    const state = stateWith();
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    production.meta.aspect = "9:16";
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shots = orderedShots(scene);
    shots[0]!.description = "@maren-kest watches.";
    shots[1]!.description = "@maren-kest waits.";
    for (let number = 14; number <= 16; number += 1) {
      shots.push({ id: `sh_${number}`, number, title: `Beat ${number}`, description: "@maren-kest waits.", durationSec: 1 });
    }
    (scene as unknown as { shots: typeof shots }).shots = shots;
    const item = await mount(state);
    await click(named(item, "Show boards"));
    await click(one(item, '[aria-label="View board sheet A"]')!);
    assert.equal(one(item, ".fy-swboard-sheet__grid")?.getAttribute("data-columns"), "3");
    assert.equal(all(item, ".fy-swboard-sheet__cell").length, 5);
    assert.equal(one(item, ".fy-swboard-sheet__cell")?.getAttribute("style"), "aspect-ratio:9 / 16");
  });

  it("keeps the normative two-column board geometry for one member", async () => {
    const state = stateWith();
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    (scene as unknown as { shots: unknown[] }).shots = [orderedShots(scene)[0]!];
    const item = await mount(state);
    await click(named(item, "Show boards"));
    await click(one(item, '[aria-label="View board sheet A"]')!);
    assert.equal(one(item, ".fy-swboard-sheet__grid")?.getAttribute("data-columns"), "2");
  });

  it("disables retained board retries while another run owns the scene", async () => {
    const state = stateWithBoardSheet(true);
    const active = frameState({ mode: "board" });
    active.run.id = "fr_01J8E0000000000000000000R2";
    active.run.createdAt = "2026-08-30T12:02:00Z";
    state.frameRuns.push(active);
    const item = await mount(state);
    await click(one(item, '[aria-label="View board sheet A"]')!);
    assert.equal((one(item, '[aria-label="Retry shot 12 against board A"]') as HTMLButtonElement).disabled, true);
    const retryBoard = [...one(item, ".fy-swboard-sheet")!.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Retry board") as HTMLButtonElement;
    assert.equal(retryBoard.disabled, true);
  });

  it("does not present an inherited boundary as a board frame and uses the effective duration", async () => {
    const state = stateWithBoardSheet();
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shot = orderedShots(scene)[0]!;
    delete shot.durationSec;
    delete production.selections.sh_12!.acceptedTakeId;
    const artifact = state.world!.artifacts.find((candidate) => candidate.id === production.selections.sh_12!.startFrameArtifactId)!;
    artifact.boundaryExtraction = {
      sourceTakeId: "tk_01J8E0000000000000000000T1",
      mediaTakeId: "tk_01J8E0000000000000000000T1",
      atSec: null,
      method: "ffmpeg-frame/1",
    };
    const item = await mount(state);
    await click(one(item, '[aria-label="View board sheet A"]')!);
    const cell = one(item, '[data-testid="board-sheet-cell-sh_12"]')!;
    assert.match(cell.textContent ?? "", /no frame yet/);
    assert.match(cell.textContent ?? "", new RegExp(`${DEFAULT_SHOT_SEC.toFixed(1)}s`));
  });
});

describe("frame-run store event flow", () => {
  it("folds run events and correlates quote events by requestId once", () => {
    const active = frameState();
    __setStateForTest(stateWith());
    __applyEventForTest({ at: "2026-08-30T12:00:00Z", type: "production.frame-run", worldId: FIXTURE_WORLD_ID, productionId: "saltlight", runId: RUN_ID, state: active });
    assert.deepEqual(__stateForTest().state?.frameRuns, [active]);
    const seen: string[] = [];
    const requestId = "01J8E0000000000000000000Q1";
    subscribeFrameRunQuote(requestId, (event) => seen.push(event.quote.quoteId));
    const command = { kind: "frame-run-quote", requestId, worldId: FIXTURE_WORLD_ID, productionId: "saltlight", sceneId: "sc_04", mode: "board", modelId: IMAGE_MODEL.id, scope: "missing" } as const;
    const quote = quoteFor(command);
    emitQuote(quote);
    assert.deepEqual(__stateForTest().frameRunQuotes[requestId], quote);
    const abandoned = { ...quote, requestId: "01J8E0000000000000000000Q9" };
    emitQuote(abandoned);
    assert.deepEqual(seen, [QUOTE_ID]);
    assert.equal(__stateForTest().frameRunQuotes[abandoned.requestId], undefined, "an abandoned response is not cached");
    assert.equal(frameRunCommand(command), false, "the send boundary still owns disconnected delivery");
  });
});

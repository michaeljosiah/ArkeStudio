import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type {
  BenchSession,
  ClientMessage,
  ClientState,
  DomainEvent,
  ManifestModel,
} from "@arke-studio/contracts";
import { App } from "../src/App.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { enqueueNote, queueNoteId } from "../src/components/queue-note.js";
import {
  __applyEventForTest,
  __connectionStatusForTest,
  __setBridgeForTest,
  __setStateForTest,
  type QueueEnqueueResult,
} from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A refusal does not outlive its cause (issue 507).
 *
 * The bench refuses a dispatch whose brief cites a reference that is no longer attached, names
 * the mention and says how to repair it. Both of those are right. What was wrong is that the
 * sentence then stayed: over a brief that had since been rewritten, over the reference put back,
 * and — as a notification — over screens in other worlds with no brief on them at all. A refusal
 * still stated after the repair has been made is how people learn to stop reading refusals.
 *
 * Driven rather than rendered, because the whole claim is about what happens AFTER the press.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
// linkedom has no layout and no frame loop. The toaster mounted app-wide asks the document which
// way it reads before it draws, and sonner withdraws a notification on the next frame.
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const SESSION_ID = "sess_01J8F3K2QW9VZX4N7M0RTYB6HD";
const LOST = "The brief cites @Image 1, which is not attached. Attach it again, or take the mention out.";

const IMAGE_MODEL: ManifestModel = {
  id: "test-image",
  provider: "fal",
  capability: "image",
  displayName: "Test Image",
  accepts: { referenceImages: 2, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 500 },
  pricing: { kind: "perImage", microUsdPerImage: 60000 },
};

const VIDEO_MODEL: ManifestModel = {
  id: "test-video",
  provider: "fal",
  capability: "video",
  displayName: "Test Video",
  accepts: { referenceImages: 2, referenceRoles: false, startFrame: false, endFrame: false },
  limits: {
    maxPromptChars: 500,
    maxDurationSec: 12,
    aspects: ["16:9"],
    soundChoice: true,
    durations: { "10": "10", "12": "12" },
  },
  pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
};

const DEFAULT_DURATION_VIDEO_MODEL: ManifestModel = {
  ...VIDEO_MODEL,
  id: "default-duration-video",
  displayName: "Default Duration Video",
  limits: { maxPromptChars: 500, maxDurationSec: 12, aspects: ["16:9"], soundChoice: true },
};

const SQUARE_IMAGE_MODEL: ManifestModel = {
  ...IMAGE_MODEL,
  id: "square-image",
  displayName: "Square Image",
  limits: { ...IMAGE_MODEL.limits, aspects: ["1:1"] },
};

/** The session as step 2 of the reproduction leaves it: the brief cites a reference nothing carries. */
function benchSession(brief: string, activeTokens: readonly string[]): BenchSession {
  return {
    schemaVersion: 1,
    id: SESSION_ID,
    title: "Harbour night studies",
    composer: {
      mode: "image",
      provider: "fal",
      model: "test-image",
      params: { kind: "image", count: 1 },
      brief,
      activeTokens: [...activeTokens],
      keyframeTokens: [],
    },
    tokenRegistry: [
      {
        token: "Image 1",
        kind: "image",
        source: {
          source: "artifact",
          artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6HF",
          hash: "sha256:deadbeef",
        },
      },
    ],
    subjectTokens: [],
    nextToken: { image: 2 },
    nextTake: 1,
    selectedTakeId: null,
    takes: [],
    createdAt: "2026-08-16T10:00:00.000Z",
    updatedAt: "2026-08-16T10:01:00.000Z",
  } as unknown as BenchSession;
}

function stateWith(session: BenchSession): ClientState {
  const base = FIXTURE_STATE;
  return {
    ...base,
    app: {
      ...base.app,
      manifest: {
        ...base.app.manifest!,
        models: [
          ...base.app.manifest!.models,
          IMAGE_MODEL,
          VIDEO_MODEL,
          DEFAULT_DURATION_VIDEO_MODEL,
          SQUARE_IMAGE_MODEL,
        ],
      },
    },
    bench: { worldId: FIXTURE_WORLD_ID, session },
  } as ClientState;
}

function subjectSession(kind: "shot" | "board", brief = "Maren listens at the rail."): BenchSession {
  const base = benchSession(brief, ["Image 1"]);
  const board = kind === "board";
  const productionTakeId = "tk_01J8F3K2QW9VZX4N7M0RTYB6HJ";
  const childOne = "tk_01J8F3K2QW9VZX4N7M0RTYB6HK";
  const childTwo = "tk_01J8F3K2QW9VZX4N7M0RTYB6HM";
  const takeId = "tk_01J8F3K2QW9VZX4N7M0RTYB6HN";
  return {
    ...base,
    title: board
      ? "Saltlight · Scene 4 · The verse rises · Board A · 2 shots · 10s · one pass"
      : "Saltlight · Scene 4 · The verse rises · Shot 12",
    subject: board
      ? {
          kind: "board",
          productionId: "saltlight",
          productionTitle: "Saltlight",
          sceneId: "sc_04",
          sceneNumber: 4,
          sceneTitle: "The verse rises",
          letter: "A",
          durationSec: 10,
          aspect: "16:9",
          packing: { maxDurationSec: 20 },
          members: [
            { shotId: "sh_12", number: 12, title: "Maren at the rail", durationSec: 4 },
            { shotId: "sh_13", number: 13, title: "The lamps answer", durationSec: 6 },
          ],
        }
      : {
          kind: "shot",
          productionId: "saltlight",
          productionTitle: "Saltlight",
          sceneId: "sc_04",
          sceneNumber: 4,
          sceneTitle: "The verse rises",
          shotId: "sh_12",
          shotNumber: 12,
          shotTitle: "Maren at the rail",
          durationSec: 4,
          aspect: "16:9",
        },
    composer: {
      mode: board ? "video" : "image",
      provider: "fal",
      model: board ? "test-video" : "test-image",
      params: board
        ? { kind: "video", aspect: "16:9", durationSec: 10, sound: true }
        : { kind: "image", aspect: "16:9", count: 1 },
      brief,
      activeTokens: ["Image 1"],
      keyframeTokens: [],
    },
    tokenRegistry: [
      {
        token: "Image 1",
        kind: "image",
        source: {
          source: "world-file",
          path: "references/maren-kest/model-sheet-v4.png",
          hash: "sha256:deadbeef",
        },
        label: "Maren Kest · v4",
        detail: "@maren-kest · character reference",
        sheetId: "maren-kest",
        sheetVersion: 4,
        ride: "when-supported",
      },
      {
        token: "Audio 1",
        kind: "audio",
        source: {
          source: "world-file",
          path: "references/maren-kest/voice-sample.wav",
          hash: "sha256:feedface",
        },
        label: "voice sample · @maren-kest",
        detail: "Maren Kest · 9.0s",
        sheetId: "maren-kest",
        sheetVersion: 4,
        durationSec: 9,
        ride: "when-supported",
      },
    ],
    subjectTokens: ["Image 1", "Audio 1"],
    nextToken: { image: 2, audio: 2 },
    nextTake: 2,
    selectedTakeId: takeId,
    takes: [
      {
        id: takeId,
        n: 1,
        requestId: "subject-dispatch",
        status: "succeeded",
        request: {
          mode: board ? "video" : "image",
          brief,
          references: [],
          keyframes: [],
          provider: "fal",
          model: board ? "test-video" : "test-image",
          params: board
            ? { kind: "video", aspect: "16:9", durationSec: 10, sound: true }
            : { kind: "image", aspect: "16:9", count: 1 },
          filing: board
            ? {
                kind: "board",
                productionId: "saltlight",
                sceneId: "sc_04",
                productionTakeId,
                members: [
                  { shotId: "sh_12", number: 12, startSec: 0, endSec: 4, takeId: childOne },
                  { shotId: "sh_13", number: 13, startSec: 4, endSec: 10, takeId: childTwo },
                ],
              }
            : {
                kind: "shot",
                productionId: "saltlight",
                sceneId: "sc_04",
                shotId: "sh_12",
                productionTakeId,
                frameArtifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6HP",
              },
        },
        media: {
          file: board ? "take.mp4" : "take.png",
          hash: "sha256:cafebabe",
          ...(board ? { info: { durationSec: 10 } } : {}),
        },
        disposition: "open",
        createdAt: "2026-08-16T10:00:00.000Z",
        completedAt: "2026-08-16T10:01:00.000Z",
      },
    ],
  } as unknown as BenchSession;
}

interface Bench {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}

function bridge(sent: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => {
      sent.push(JSON.parse(json) as ClientMessage);
    },
  } as unknown as ArkeBridge;
}

async function openBench(session: BenchSession): Promise<Bench> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(bridge(sent));
  __setStateForTest(stateWith(session));
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`]}>
        <App />
      </MemoryRouter>,
    );
  });
  return { container, root, sent };
}

async function close(bench: Bench): Promise<void> {
  await act(async () => bench.root.unmount());
  bench.container.remove();
  dom.document.body.replaceChildren();
  __setBridgeForTest(null);
}

afterEach(() => __setBridgeForTest(null));

async function press(bench: Bench, testId: string): Promise<void> {
  const button = bench.container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  assert.ok(button, `${testId} is on screen`);
  await act(async () => button.click());
}

/** A control the design gives a name rather than a test id — the words on it are the handle. */
async function pressLabelled(bench: Bench, label: string): Promise<void> {
  const button = [...bench.container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  assert.ok(button, `${label} is on screen`);
  await act(async () => button.click());
}

/** The last requestId sent under one command — how the coordinator's answer is correlated. */
function requestIdOf(bench: Bench, kind: string): string {
  const message = [...bench.sent].reverse().find((m) => (m as { kind?: string }).kind === kind);
  assert.ok(message, `a ${kind} went out`);
  return (message as unknown as { requestId: string }).requestId;
}

async function apply(event: DomainEvent): Promise<void> {
  await act(async () => __applyEventForTest(event));
  // sonner withdraws on the next frame, and the frame here is a timer.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** What the press was refused with, as the alert under Generate says it. */
function standing(bench: Bench): string | null {
  const alert = bench.container.querySelector('p.fy-bench__refusal[role="alert"]');
  return alert?.textContent ?? null;
}

/** The composer's own early warning, which was always right and is the behaviour being matched. */
function earlyWarning(bench: Bench): string | null {
  return bench.container.querySelector('[data-testid="bench-lost-mentions"]')?.textContent ?? null;
}

/**
 * The notifications still standing over every screen. One being withdrawn is marked before it is
 * unmounted, so a notification on its way out does not count as one being read.
 */
function notifications(): string[] {
  return [...dom.document.querySelectorAll("li")]
    .filter((node) => node.getAttribute("data-removed") !== "true")
    .map((node) => node.textContent ?? "");
}

/** Press Generate, and answer it with the coordinator's refusal. */
async function refusedPress(bench: Bench, reason = LOST): Promise<void> {
  await press(bench, "bench-generate");
  await apply({
    at: "2026-08-26T10:00:00.000Z",
    type: "queue.enqueue-result",
    requestId: requestIdOf(bench, "bench-dispatch"),
    command: "bench-dispatch",
    disposition: "rejected",
    requestedCount: 1,
    acceptedJobIds: [],
    failures: [{ index: 0, reason }],
  } as DomainEvent);
}

describe("a Bench dispatch refused for a lost mention", () => {
  it("names the mention and offers the repair, in one place under the press", async () => {
    const bench = await openBench(benchSession("a face lit by @Image 1", []));
    assert.equal(standing(bench), null, "nothing is refused before anything is pressed");
    await refusedPress(bench);
    assert.equal(standing(bench), LOST);
    assert.ok(
      notifications().some((text) => text.includes("which is not attached")),
      "and the notification says it too",
    );
    await close(bench);
  });

  it("clears when the reference is attached again, as the early warning already did", async () => {
    const bench = await openBench(benchSession("a face lit by @Image 1", []));
    await refusedPress(bench);
    assert.equal(earlyWarning(bench), "@Image 1 — not attached");

    // Step 5: the picture goes back on. Nothing about the words has changed.
    await act(async () => __setStateForTest(stateWith(benchSession("a face lit by @Image 1", ["Image 1"]))));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(earlyWarning(bench), null, "the early warning resolves");
    assert.equal(standing(bench), null, "and the refusal goes with it");
    await close(bench);
  });

  it("clears when the words change, without waiting for the next press", async () => {
    const bench = await openBench(benchSession("a face lit by @Image 1", []));
    await refusedPress(bench);
    assert.equal(standing(bench), LOST);

    // Step 4 of the reproduction: the whole brief is replaced by words citing nothing. The art
    // director's rewrite is the one path that moves the words without a keystroke, and it lands
    // in the composer the same way typing does — through `compose`.
    await press(bench, "bench-enhance");
    await apply({
      at: "2026-08-26T10:01:00.000Z",
      type: "bench.brief-enhanced",
      worldId: FIXTURE_WORLD_ID,
      sessionId: SESSION_ID,
      requestId: requestIdOf(bench, "bench-enhance-brief"),
      prompt: "a quiet harbour",
    } as DomainEvent);
    // A rewrite that drops a citation is offered rather than imposed, so the author applies it.
    await pressLabelled(bench, "Apply enhanced");

    assert.equal(standing(bench), null, "the refusal quotes words nobody is holding any more");
    assert.equal(earlyWarning(bench), null, "and there is nothing left to warn about");
    await close(bench);
  });

  it("takes its notification with it, rather than leaving one to ride to other screens", async () => {
    const bench = await openBench(benchSession("a face lit by @Image 1", []));
    await refusedPress(bench);
    assert.ok(notifications().some((text) => text.includes("which is not attached")));

    await act(async () => __setStateForTest(stateWith(benchSession("a face lit by @Image 1", ["Image 1"]))));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.deepEqual(
      notifications().filter((text) => text.includes("which is not attached")),
      [],
      "nothing left standing says it",
    );
    await close(bench);
  });

  it("stands through a store frame that changes nothing about the request", async () => {
    // Every frame hands the screen fresh objects. A refusal cleared on identity rather than on
    // content would never be readable at all: the next job tick would take it off the screen.
    const bench = await openBench(benchSession("a face lit by @Image 1", []));
    await refusedPress(bench);
    await act(async () => __setStateForTest(stateWith(benchSession("a face lit by @Image 1", []))));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(standing(bench), LOST, "the words and the pictures are where they were");
    await close(bench);
  });
});

describe("the notification raised for a request", () => {
  it("is raised under the request's own id, so the surface that asked can withdraw it", () => {
    const requestId = "01J8F3K2QW9VZX4N7M0RTYB6HC";
    const note = enqueueNote(
      {
        at: "2026-08-26T10:00:00.000Z",
        type: "queue.enqueue-result",
        requestId,
        command: "bench-dispatch",
        disposition: "rejected",
        requestedCount: 1,
        acceptedJobIds: [],
        failures: [{ index: 0, reason: LOST }],
      } as unknown as QueueEnqueueResult,
      [],
      null,
    );
    assert.equal(note?.id, queueNoteId(requestId));
  });
});

describe("a subject-bound Bench (SPEC-036 R-23..R-25)", () => {
  it("names and locks a shot while keeping unsupported production references visible", async () => {
    const bench = await openBench(subjectSession("shot"));
    // The chain, as the header now splits it: crumb, then the subject (design 2609-2610).
    assert.match(bench.container.textContent ?? "", /Saltlight · scene 4/);
    assert.match(bench.container.textContent ?? "", /Shot 12/);
    assert.match(bench.container.textContent ?? "", /aspect · 16:9/);
    assert.match(bench.container.textContent ?? "", /duration · 4s/);
    assert.match(bench.container.textContent ?? "", /seed · auto/);
    assert.match(bench.container.textContent ?? "", /Maren Kest · v4/);
    assert.match(bench.container.textContent ?? "", /voice sample · @maren-kest/);
    assert.match(bench.container.textContent ?? "", /Maren Kest · 9\.0s/);
    assert.match(bench.container.textContent ?? "", /not riding/);
    assert.ok(bench.container.querySelector(".fy-bench__wave"));
    const modes = [...bench.container.querySelectorAll<HTMLButtonElement>('[aria-label="What to make"] button')];
    assert.equal(modes.find((button) => button.textContent === "Image")?.disabled, false);
    // A shot offers the two modes the design offers and nothing that makes a sound; the other
    // tab is a live switch to the shot in that mode (design 2616-2621), not a disabled pill.
    assert.deepEqual(modes.map((button) => button.textContent), ["Image", "Video"]);
    const square = bench.container.querySelector<HTMLOptionElement>('option[value="fal/square-image"]');
    assert.equal(square?.hasAttribute("disabled"), true, "a locked 16:9 subject cannot spend on a square-only model");
    assert.equal(bench.container.querySelector('[data-testid="bench-keep"]'), null);
    assert.ok(bench.container.querySelector('[data-testid="bench-accept"]'));
    assert.match(bench.container.textContent ?? "", /accepting files the frame onto shot 12/);
    await close(bench);
  });

  it("rebuilds the same session draft and sends Accept rather than Keep", async () => {
    const bench = await openBench(subjectSession("shot"));
    await press(bench, "bench-accept");
    assert.equal(bench.sent.at(-1)?.kind, "bench-accept");
    assert.equal(bench.sent.some((message) => message.kind === "bench-keep"), false);
    const acceptRequestId = requestIdOf(bench, "bench-accept");
    await apply({
      at: "2026-08-16T10:01:30.000Z",
      type: "bench.subject-accepted",
      worldId: FIXTURE_WORLD_ID,
      sessionId: SESSION_ID,
      takeId: subjectSession("shot").selectedTakeId,
      requestId: acceptRequestId,
      accepted: false,
      reason: "The subject shot is no longer available.",
    } as DomainEvent);
    assert.match(bench.container.textContent ?? "", /subject shot is no longer available/i);
    await pressLabelled(bench, "Discard");
    assert.equal(bench.sent.at(-1)?.kind, "bench-discard");

    await press(bench, "bench-rebuild");
    const requestId = requestIdOf(bench, "bench-rebuild-subject");
    const rebuilt = subjectSession("shot", "The current script, assembled again.");
    await act(async () => __setStateForTest(stateWith(rebuilt)));
    await apply({
      at: "2026-08-16T10:02:00.000Z",
      type: "bench.subject-opened",
      worldId: FIXTURE_WORLD_ID,
      requestId,
      sessionId: SESSION_ID,
    } as DomainEvent);
    const brief = bench.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Brief"]');
    assert.equal(brief?.value, "The current script, assembled again.");
    await close(bench);
  });

  it("releases one-shot subject controls when their answer is lost with the connection", async () => {
    const bench = await openBench(subjectSession("shot"));
    await press(bench, "bench-rebuild");
    await act(async () => __connectionStatusForTest("closed"));
    assert.equal(bench.container.querySelector<HTMLButtonElement>('[data-testid="bench-rebuild"]')?.disabled, false);
    assert.match(bench.container.textContent ?? "", /Connection lost - try again/);

    await act(async () => __connectionStatusForTest("open"));
    await press(bench, "bench-accept");
    await act(async () => __connectionStatusForTest("closed"));
    assert.equal(bench.container.querySelector<HTMLButtonElement>('[data-testid="bench-accept"]')?.disabled, false);
    assert.match(bench.container.textContent ?? "", /Connection lost - check production before trying again/);
    await act(async () => __connectionStatusForTest("open"));
    await close(bench);
  });

  it("states one board pass and files its accepted clip onto every member", async () => {
    const bench = await openBench(subjectSession("board"));
    // The subject and its line are two spans in the header now (design 2610-2611).
    assert.match(bench.container.textContent ?? "", /Board A/);
    assert.match(bench.container.textContent ?? "", /2 shots · 10s · one pass/);
    assert.match(bench.container.textContent ?? "", /sound · on/);
    assert.match(bench.container.textContent ?? "", /accepting files the clip onto 2 shots/);
    const video = [...bench.container.querySelectorAll<HTMLButtonElement>('[aria-label="What to make"] button')]
      .find((button) => button.textContent === "Video");
    assert.equal(video?.getAttribute("aria-pressed"), "true");
    assert.equal(
      bench.container
        .querySelector<HTMLOptionElement>('option[value="fal/default-duration-video"]')
        ?.hasAttribute("disabled"),
      true,
      "a board cannot use a route that leaves its duration to the provider",
    );
    assert.match(bench.container.querySelector('[data-testid="bench-generate"]')?.textContent ?? "", /Generate · ~\$/);
    await close(bench);
  });
});

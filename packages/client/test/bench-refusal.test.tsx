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
      manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, IMAGE_MODEL] },
    },
    bench: { worldId: FIXTURE_WORLD_ID, session },
  } as ClientState;
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

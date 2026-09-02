import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ClientMessage, FrameRunState, WorldChatWorkspace } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { ConversationTranscript, ProductionConversation } from "../src/components/conversation.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The Arke dock's head, foot and report card (SPEC-036; design template.html:2483-2557).
 *
 * The head is where the dock says what it is about and where it can be put away; the foot is
 * where a quick ask is said; the card is how a run or a filed take is read back. Each is asserted
 * on the markup because that is what the workspace's tests and the design both hold — the pin,
 * the subject line and the failure key are the pieces that were computed and never drawn.
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
  KeyboardEvent: dom.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const SCENE_PATH = `/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes/sc_04`;
const RUN_ID = "fr_01J8E0000000000000000000R1";

interface Mounted {
  container: HTMLElement;
  root: Root;
}

const open: Mounted[] = [];

async function mountNode(node: React.ReactNode): Promise<Mounted> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(FIXTURE_STATE);
    root.render(<MemoryRouter initialEntries={[SCENE_PATH]}>{node}</MemoryRouter>);
  });
  const mounted = { container, root };
  open.push(mounted);
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

function capture(sent: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as ArkeBridge;
}

const q = (m: Mounted, selector: string): HTMLElement | null =>
  m.container.querySelector(selector) as HTMLElement | null;
const all = (m: Mounted, selector: string): HTMLElement[] =>
  Array.from(m.container.querySelectorAll(selector)) as HTMLElement[];

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => element.click());
};

type Dock = NonNullable<Parameters<typeof ProductionConversation>[0]["dock"]>;

function dockConversation(dock: Dock) {
  return (
    <ProductionConversation
      worldId={FIXTURE_WORLD_ID}
      productionId="saltlight"
      entry={{ kind: "scene", productionId: "saltlight", sceneId: "sc_04" }}
      dock={dock}
      emptyLine="Nothing written with Arke for scene 4 yet."
      placeholder="Ask about scene 4 · @ to reference"
    />
  );
}

function workspaceWith(message: Partial<WorldChatWorkspace["messages"][number]>): WorldChatWorkspace {
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
      text: "Done.",
      receipts: [],
      refusals: [],
      createdAt: "2026-08-30T12:02:00Z",
      ...message,
    }],
  };
}

/**
 * Only what the card reads. The real fold is exercised in frame-run.test.tsx; this is the shape
 * of a finished board run with one dark member, and the cast keeps the fixture to that.
 */
function boardRunWithOneFailure(): FrameRunState {
  const shot = (shotId: string, failed = false) => ({
    shotId,
    status: failed ? "failed" : "succeeded",
    failureClass: failed ? "transient" : null,
    error: failed ? "came back dark" : null,
    canRetryCell: failed,
  });
  const step = (label: string, shotIds: string[]) => ({
    label,
    updateShotIds: shotIds,
    grain: "initial",
    dispatch: { target: { kind: "board-sheet", coversShots: shotIds } },
  });
  return {
    worldId: FIXTURE_WORLD_ID,
    productionId: "saltlight",
    run: {
      id: RUN_ID,
      sceneId: "sc_04",
      mode: "board",
      cancelled: false,
      steps: [step("Board A", ["sh_12", "sh_13", "sh_14"]), step("Board B", ["sh_15", "sh_16"])],
    },
    steps: [
      { status: "succeeded", canRetry: false, shots: [shot("sh_12"), shot("sh_13", true), shot("sh_14")] },
      { status: "succeeded", canRetry: false, shots: [shot("sh_15"), shot("sh_16")] },
    ],
  } as unknown as FrameRunState;
}

describe("the dock head (design 2483-2489)", () => {
  it("draws the subject under the title, a slot for the frame, the pin and the toggle", async () => {
    let putAway = 0;
    let toggled = 0;
    const mounted = await mountNode(dockConversation({
      title: "Arke · Shot 13",
      subject: "Maren turns · no frame",
      conversationFirst: true,
      onPutAway: () => { putAway += 1; },
      onToggleSubject: () => { toggled += 1; },
    }));
    assert.equal(q(mounted, ".fy-arke__who .fy-mono")?.textContent, "Maren turns · no frame");
    const slot = q(mounted, ".fy-arke__thumb");
    assert.ok(slot, "the slot is there whether or not a frame is");
    assert.equal(slot.querySelector("img"), null);

    const who = q(mounted, ".fy-arke__who")!;
    assert.equal(who.tagName, "BUTTON");
    assert.equal(who.getAttribute("title"), "Switch between the shot and the whole scene");
    await click(who);
    assert.equal(toggled, 1);

    const pin = q(mounted, '.fy-arke__head [aria-label="Unpin the assistant"]')!;
    assert.ok(pin.classList.contains("fy-arke__pin"));
    assert.ok(pin.querySelector("svg"), "a pin, not a word");
    await click(pin);
    assert.equal(putAway, 1);
  });

  it("stays a plain span without the handlers, and shows the frame inside the slot", async () => {
    const mounted = await mountNode(dockConversation({
      title: "Arke · Shot 12",
      subject: "Maren at the rail · frame filed",
      conversationFirst: true,
      thumbnail: { src: "arke-media://frame.png", alt: "Frame for shot 12" },
    }));
    assert.equal(q(mounted, ".fy-arke__who")?.tagName, "SPAN");
    assert.equal(q(mounted, ".fy-arke__pin"), null);
    assert.equal(q(mounted, ".fy-arke__thumb img")?.getAttribute("src"), "arke-media://frame.png");
  });

  it("names the subject and keeps the slot and the line under the composer in the workspace", async () => {
    const mounted = await mountNode(<App />);
    assert.match(q(mounted, ".fy-arke__who .fy-mono")?.textContent ?? "", /v\d+$/, "the scene and its version");
    assert.ok(q(mounted, ".fy-arke__thumb"), "the scene has no frame, and the slot is still drawn");
    // The scene dock's line names the one thing talking does change here (SPEC-036 R-38).
    assert.match(q(mounted, ".fy-arke__foot > .fy-mono")?.textContent ?? "", /talking can name the scene · everything else waits for your yes/);
  });
});

describe("the dock foot (design 2536-2543)", () => {
  it("says a quick ask as it stands", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountNode(dockConversation({
      title: "Arke · Scene 4",
      subject: "The verse rises · v2",
      conversationFirst: true,
      prompts: ["Draft the missing prompts", "Tighten the coverage"],
    }));
    const chips = all(mounted, ".fy-arke__foot .fy-arke__prompt");
    assert.deepEqual(chips.map((chip) => chip.textContent), ["Draft the missing prompts", "Tighten the coverage"]);
    await click(chips[1]!);
    const last = sent.at(-1) as { kind: string; title?: string } | undefined;
    assert.equal(last?.kind, "world-chat-create", "no thread yet, so the ask opens one");
    assert.equal(last?.title, "Tighten the coverage");
    // While that thread opens a second ask would open a second one: the chips wait it out.
    assert.ok(chips.every((chip) => (chip as HTMLButtonElement).disabled), "chips wait for the thread");
    const before = sent.length;
    await click(chips[0]!);
    assert.equal(sent.length, before, "a second ask opens nothing");
  });

  it("draws no chip row without prompts", async () => {
    const mounted = await mountNode(dockConversation({ title: "Arke · Scene 4", subject: "The verse rises · v2", conversationFirst: true }));
    assert.equal(q(mounted, ".fy-arke__prompts"), null);
  });
});

describe("the report card (design 2509-2521, 3195-3201, 3906)", () => {
  it("lists every step before any failure, names the failed shot, and counts what came back", async () => {
    const run = boardRunWithOneFailure();
    const mounted = await mountNode(
      <ConversationTranscript
        workspace={workspaceWith({ frameRunOutcome: { runId: RUN_ID, productionId: "saltlight", sceneId: "sc_04" } })}
        running={false}
        progress={null}
        failure={null}
        canRetry
        frameRuns={[run]}
        onSelectShot={() => {}}
        shotLabel={(shotId) => `shot ${shotId.slice(3)}`}
      />,
    );
    const rows = all(mounted, ".fy-chat__runreport-row");
    assert.deepEqual(rows.map((row) => row.getAttribute("data-kind")), ["step", "step", "failure"]);
    const key = (row: HTMLElement) => row.querySelector(".fy-chat__runreport-key")?.textContent;
    const value = (row: HTMLElement) => row.querySelector(".fy-chat__runreport-key + span")?.textContent;
    assert.equal(key(rows[0]!), "board a");
    assert.equal(value(rows[0]!), "2 frames · one pass", "three asked for, two came back");
    assert.equal(key(rows[1]!), "board b");
    assert.equal(value(rows[1]!), "2 frames · one pass");
    assert.equal(key(rows[2]!), "shot 13");
    assert.equal(value(rows[2]!), "came back dark");
    assert.equal(rows[2]!.querySelector(".fy-chat__runreport-retry")?.textContent, "Retry");
  });

  it("falls back to the step's label for a failure when nothing names the shot", async () => {
    const mounted = await mountNode(
      <ConversationTranscript
        workspace={workspaceWith({ frameRunOutcome: { runId: RUN_ID, productionId: "saltlight", sceneId: "sc_04" } })}
        running={false}
        progress={null}
        failure={null}
        canRetry
        frameRuns={[boardRunWithOneFailure()]}
      />,
    );
    const failure = q(mounted, '.fy-chat__runreport-row[data-kind="failure"]')!;
    assert.equal(failure.querySelector(".fy-chat__runreport-key")?.textContent, "board a");
  });

  it("reads a filed take as a report row, frame or clip, and never the id", async () => {
    const mounted = await mountNode(
      <ConversationTranscript
        workspace={workspaceWith({
          benchOutcome: {
            productionId: "saltlight",
            sceneId: "sc_04",
            rows: [
              { shotId: "sh_12", shotNumber: 12, productionTakeId: "tk_01J8E0000000000000000000T1", artifactId: "ar_01J8E0000000000000000000A1" },
              { shotId: "sh_13", shotNumber: 13, productionTakeId: "tk_01J8E0000000000000000000T2" },
            ],
          },
        })}
        running={false}
        progress={null}
        failure={null}
        canRetry
      />,
    );
    assert.equal(q(mounted, ".fy-chat__benchreport"), null, "one card for everything that came back");
    const rows = all(mounted, '.fy-chat__runreport-row[data-kind="filed"]');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.getAttribute("data-state"), "complete", "the green dot");
    assert.equal(rows[0]!.querySelector(".fy-chat__runreport-key")?.textContent, "shot 12");
    assert.equal(rows[0]!.querySelector(".fy-chat__runreport-key + span")?.textContent, "frame filed");
    assert.equal(rows[1]!.querySelector(".fy-chat__runreport-key + span")?.textContent, "clip filed");
    assert.doesNotMatch(rows[0]!.textContent ?? "", /tk_|ar_/);
  });
});

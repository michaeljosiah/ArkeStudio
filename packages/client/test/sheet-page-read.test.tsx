import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { playbackSnapshot, setAudioFactoryForTest } from "../src/lib/audio.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Read aloud at page scale (issue 859).
 *
 * The speaker on a paragraph reads that paragraph; the sheet's own control reads the sheet
 * through, in the order the screen declares — not the order the layout happens to be in, and
 * not the DOM's, which between those two paragraphs holds a portrait, a voice card and a row
 * of buttons. Driven rather than rendered, because the order only exists once the press
 * happens, and because leaving the page is half the behaviour.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
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

const SHEET = "maren-kest";

function fakeAudio() {
  const element = {
    playbackRate: 1,
    src: "",
    currentTime: 0,
    duration: NaN,
    play: async () => {},
    pause: () => {},
    load: () => {},
    removeAttribute: () => {
      element.src = "";
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return element;
}

interface Screen {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}

async function openSheet(): Promise<Screen> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as ArkeBridge);
  __setStateForTest(FIXTURE_STATE);
  setAudioFactoryForTest(() => fakeAudio() as never);
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/cast/${SHEET}`]}>
        <App />
      </MemoryRouter>,
    );
  });
  return { container, root, sent };
}

async function close(screen: Screen): Promise<void> {
  await act(async () => screen.root.unmount());
  screen.container.remove();
  dom.document.body.replaceChildren();
  __setBridgeForTest(null);
  setAudioFactoryForTest(null);
}

afterEach(() => {
  __setBridgeForTest(null);
  setAudioFactoryForTest(null);
});

function labelled(screen: Screen, label: string): HTMLButtonElement | undefined {
  return [...screen.container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

async function press(screen: Screen, label: string): Promise<void> {
  const button = labelled(screen, label);
  assert.ok(button, `${label} is on screen`);
  await act(async () => button.click());
}

/** A block of a page read, as the coordinator reports it once that block is made. */
function block(requestId: string, part: number, heading: string): DomainEvent {
  return {
    at: "2026-09-05T12:00:00.000Z",
    type: "voice.audio",
    requestId,
    worldId: FIXTURE_WORLD_ID,
    sheetId: SHEET,
    sheetVersion: 4,
    purpose: "sheet-page",
    sectionHeading: heading,
    part,
    parts: 2,
    provider: "kokoro",
    model: "kokoro-82m",
    voiceId: "bm_george",
    format: "wav",
    status: "ready",
    file: `.cache/voice-previews/${heading}.wav`,
    cached: false,
    characterCount: 40,
    estimatedMicroUsd: 0,
  } as DomainEvent;
}

describe("a character sheet reads at two scales", () => {
  it("reads the declared blocks in order, states the position, and stops when the page is left", async () => {
    const screen = await openSheet();
    try {
      await press(screen, "Read the sheet");
      const asked = screen.sent.at(-1) as { kind: string; sheetId: string; sections: string[]; requestId: string };
      assert.equal(asked.kind, "read-sheet-page");
      assert.equal(asked.sheetId, SHEET);
      assert.deepEqual(asked.sections, ["Essence", "Appearance"]);

      await act(async () => __applyEventForTest(block(asked.requestId, 0, "Essence")));
      assert.equal(playbackSnapshot().clip?.title, "Maren Kest · Essence");
      assert.equal(screen.container.textContent?.includes("1 of 2"), true);
      // The block read is the other scale and is still on the paragraph itself.
      assert.ok(screen.container.querySelector('[aria-label="Read aloud"]'));

      // A page read is about the page: leaving it ends it, rather than narrating a sheet
      // nobody is looking at any more. Followed by the sheet's own link, so this is the
      // navigation somebody actually does.
      await press(screen, "The Vigil →");
      assert.equal(playbackSnapshot().clip, null);
    } finally {
      await close(screen);
    }
  });

  it("states the page's price once before any of it sounds, and takes one answer", async () => {
    const screen = await openSheet();
    try {
      await press(screen, "Read the sheet");
      const asked = screen.sent.at(-1) as { requestId: string };
      await act(async () =>
        __applyEventForTest({
          at: "2026-09-05T12:00:00.000Z",
          type: "voice.audio",
          requestId: asked.requestId,
          worldId: FIXTURE_WORLD_ID,
          sheetId: SHEET,
          sheetVersion: 4,
          purpose: "sheet-page",
          provider: "elevenlabs",
          model: "eleven_multilingual_v2",
          voiceId: "v_8Kq2",
          format: "mp3",
          status: "confirmation-required",
          file: null,
          cached: false,
          characterCount: 92,
          estimatedMicroUsd: 27_600,
          confirmationToken: "tok-page",
        } as DomainEvent),
      );
      // The whole page is priced, and none of it is sounding while the price is unanswered.
      const confirm = [...screen.container.querySelectorAll("button")].find((node) =>
        node.textContent?.startsWith("Confirm 92 characters"),
      );
      assert.ok(confirm, "the page states what it will cost");
      assert.equal(playbackSnapshot().clip, null);

      await act(async () => (confirm as HTMLButtonElement).click());
      const confirmed = screen.sent.at(-1) as { kind: string; requestId: string; confirmationToken?: string };
      assert.equal(confirmed.kind, "read-sheet-page");
      assert.equal(confirmed.requestId, asked.requestId);
      assert.equal(confirmed.confirmationToken, "tok-page");
      // The answer stands until the first block lands: a second press is a second charge.
      assert.equal(
        [...screen.container.querySelectorAll("button")].some((node) =>
          node.textContent?.startsWith("Confirm "),
        ),
        false,
      );
    } finally {
      await close(screen);
    }
  });
});

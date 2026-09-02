import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { applyTimelineCommands, seedStoryPictureTimeline, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The Library (SPEC-039 R-8, R-10..R-12; T-3): one searchable, filterable list of what can be
 * placed; a non-drag path that sends the same one command a drop would; and Locate, which
 * selects a use and moves the playhead without writing anything (A-5).
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: false, media: query }) });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: dom.window.KeyboardEvent ?? dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const BELLS = "ar_01J8G0000000000000000000R1";
const BOARD = "ar_01J8G0000000000000000000R3";
const PAPER = "ar_01J8G0000000000000000000R4";

interface Mounted {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}

function bridge(sent: ClientMessage[]) {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as NonNullable<Window["arke"]>;
}

async function mount(state: ClientState, search = ""): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(bridge(sent));
  __setStateForTest(state);
  const production = state.world!.productions[0]!;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${production.meta.id}/cut${search}`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root, sent };
}

async function close(screen: Mounted): Promise<void> {
  await act(async () => screen.root.unmount());
  screen.container.remove();
}

function rows(screen: Mounted): string[] {
  return [...screen.container.querySelectorAll<HTMLElement>("[data-library-item]")].map((row) => row.dataset["libraryItem"]!);
}

function rowButton(screen: Mounted, key: string): HTMLButtonElement {
  const row = screen.container.querySelector<HTMLElement>(`[data-library-item="${key}"]`);
  assert.ok(row, `${key} is listed`);
  return row.querySelector<HTMLButtonElement>(".fy-artrow__pick")!;
}

function action(screen: Mounted, label: string): HTMLButtonElement | null {
  return [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-artrow__actions button")].find((button) => button.textContent?.trim().startsWith(label)) ?? null;
}

/**
 * Type into a controlled input under linkedom. A dispatched `input` event never reaches React's
 * change plugin here (verified against the live app, where the same event narrows the list), so
 * the value is set through the prototype's setter and React's own handler is invoked as the
 * browser would invoke it. Test harness only; the screen is unchanged.
 */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = key === undefined ? undefined : (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void }>)[key];
    props?.onChange?.({ target: input, currentTarget: input });
  });
}

function commandsSent(screen: Mounted): Extract<ClientMessage, { kind: "timeline-command" }>[] {
  return screen.sent.filter((message): message is Extract<ClientMessage, { kind: "timeline-command" }> => message.kind === "timeline-command");
}

/**
 * The saved timeline with the bells placed twice on a Music track: two uses to locate between.
 * The Library lists only what the record's `library` holds (R-8, amended 2026-09-02), so the
 * shots and every filed artifact are added to it the way a person or Arke would — the document
 * included, because an unsupported file still belongs in the list (R-12) even though the picker
 * would not offer it.
 */
function stateWithBells(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  // A board to place and a document that cannot be: the fixture files only the bells.
  state.world!.artifacts.push(
    { id: BOARD, kind: "board", file: "board-v2.png", hash: "sha256:b7d24c90a13e58f6", origin: { by: "system" }, links: ["saltlight"], created: "2026-07-29T11:02:00Z" } as never,
    { id: PAPER, kind: "document", file: "undersong-treatment.pdf", hash: "sha256:c1d24c90a13e58f7", origin: { by: "user" }, links: ["saltlight"], created: "2026-07-29T11:02:00Z" } as never,
  );
  const seeded = seedStoryPictureTimeline(production);
  production.timeline = {
    status: "ready",
    timeline: applyTimelineCommands(seeded, [
      {
        kind: "add-to-library",
        items: [
          { kind: "shot", shotId: "sh_12" },
          { kind: "shot", shotId: "sh_13" },
          { kind: "artifact", artifactId: BELLS },
          { kind: "artifact", artifactId: BOARD },
          { kind: "artifact", artifactId: PAPER },
        ],
      },
      { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
      { kind: "place", trackId: "tr_music", clip: { id: "cl_bells-1", startFrame: 0, durationFrames: 48, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "harbour-bells.wav" } } },
      { kind: "place", trackId: "tr_music", clip: { id: "cl_bells-2", startFrame: 120, durationFrames: 48, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "harbour-bells.wav" } } },
    ]),
  };
  return state;
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("the Library (SPEC-039 T-3)", () => {
  it("lists takes, shots and artifacts with where they land, and searches and filters them", async () => {
    const screen = await mount(stateWithBells());
    try {
      const listed = rows(screen);
      assert.ok(listed.some((key) => key.startsWith("shot:")), "shots are listed");
      assert.ok(listed.includes(`artifact:${BELLS}`), "the bells are listed");
      const bells = screen.container.querySelector<HTMLElement>(`[data-library-item="artifact:${BELLS}"]`)!;
      assert.equal(bells.querySelector(".fy-artrow__lane")?.textContent, "Music", "an audio file lands on Music");
      assert.ok(bells.querySelector(".fy-artrow__dot"), "a used file carries the in-the-cut dot");
      const document_ = screen.container.querySelector<HTMLElement>('[data-library-item^="artifact:"] .fy-artrow__meta--destructive, [data-library-item] .fy-artrow__meta');
      assert.ok(document_, "rows carry a status line");
      const pdf = [...screen.container.querySelectorAll<HTMLElement>("[data-library-item]")].find((row) => row.textContent?.includes("undersong-treatment.pdf"));
      assert.ok(pdf, "an unsupported document stays in the list (R-12)");
      assert.match(pdf.textContent ?? "", /no picture or sound/);

      const search = screen.container.querySelector<HTMLInputElement>('input[type="search"]')!;
      await typeInto(search, "harbour-bells");
      assert.deepEqual(rows(screen), [`artifact:${BELLS}`], "search narrows to the bells");
      await typeInto(search, "");
      const audio = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-artpanel__filters button")].find((button) => button.textContent === "Audio")!;
      await act(async () => audio.click());
      // The audio filter is the Audio address's view (R-1): every spoken line, read or not, beside the sound files.
      assert.deepEqual(rows(screen), ["line:sh_12", `artifact:${BELLS}`], "the Audio filter keeps sound and lines");
    } finally {
      await close(screen);
    }
  });

  it("Locate selects the first use at or after the playhead, advances on repeat, wraps, and writes nothing (R-11, A-5)", async () => {
    const screen = await mount(stateWithBells());
    try {
      await act(async () => rowButton(screen, `artifact:${BELLS}`).click());
      const locate = action(screen, "Locate in timeline");
      assert.ok(locate, "a used file offers Locate");
      const selectedClip = () => screen.container.querySelector<HTMLElement>('[data-clip][aria-pressed="true"]')?.dataset["clip"] ?? null;
      await act(async () => locate.click());
      assert.equal(selectedClip(), "cl_bells-1", "the first use at the playhead");
      await act(async () => action(screen, "Locate in timeline")!.click());
      assert.equal(selectedClip(), "cl_bells-2", "the next use");
      await act(async () => action(screen, "Locate in timeline")!.click());
      assert.equal(selectedClip(), "cl_bells-1", "the last use wraps to the first");
      assert.equal(commandsSent(screen).length, 0, "Locate never writes");
      // A file already in the cut can still be placed again, as a drop could (R-10). DOM nodes
      // never go through assert.equal: node's diff inspects the whole document and runs out of memory.
      assert.ok(action(screen, "Add to timeline") !== null, "a used file is still offered Add to timeline");
    } finally {
      await close(screen);
    }
  });

  it("Add to timeline sends the one place command a drop would (R-10)", async () => {
    const state = stateWithBells();
    const screen = await mount(state);
    try {
      assert.ok(rows(screen).includes(`artifact:${BOARD}`), "the board is listed");
      await act(async () => rowButton(screen, `artifact:${BOARD}`).click());
      const add = action(screen, "Add to timeline");
      assert.ok(add, "an unplaced picture offers Add");
      await act(async () => add.click());
      const [sent] = commandsSent(screen);
      assert.ok(sent, "one batch was sent");
      const place = sent.commands.find((command) => command.kind === "place");
      assert.ok(place && place.kind === "place", "it places the artifact");
      assert.equal(place.clip.source.kind, "artifact");
    } finally {
      await close(screen);
    }
  });

  it("opens on the audio filter when the Audio route lands here (R-1)", async () => {
    const screen = await mount(stateWithBells(), "?library=audio");
    try {
      const audio = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-artpanel__filters button")].find((button) => button.textContent === "Audio")!;
      assert.equal(audio.getAttribute("aria-pressed"), "true");
      assert.deepEqual(rows(screen), ["line:sh_12", `artifact:${BELLS}`]);
    } finally {
      await close(screen);
    }
  });
});

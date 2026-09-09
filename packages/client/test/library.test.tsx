import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { applyTimelineCommands, seedStoryPictureTimeline, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
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
      assert.equal(bells.querySelector(".fy-artrow__lane")?.textContent, "Audio", "an audio file lands on Audio");
      assert.ok(bells.querySelector(".fy-artrow__dot"), "a used file carries the in-the-cut dot");
      const document_ = screen.container.querySelector<HTMLElement>('[data-library-item^="artifact:"] .fy-artrow__meta--destructive, [data-library-item] .fy-artrow__meta');
      assert.ok(document_, "rows carry a status line");
      // Named by its link (issue 1005) — the production's title, here — so the row is found by its key.
      const pdf = screen.container.querySelector<HTMLElement>(`[data-library-item="artifact:${PAPER}"]`);
      assert.ok(pdf, "an unsupported document stays in the list (R-12)");
      assert.match(pdf.textContent ?? "", /no picture or sound/);
      const search = screen.container.querySelector<HTMLInputElement>('input[type="search"]')!;
      await typeInto(search, "treatment");
      assert.deepEqual(rows(screen), [`artifact:${PAPER}`], "the file name still finds it");
      await typeInto(search, "");

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
      assert.ok(action(screen, "Append to timeline") !== null, "a used file is still offered Add to timeline");
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
      const add = action(screen, "Append to timeline");
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

  it("keeps a retired file the record still names, with its refusal and a way off the Library", async () => {
    const state = stateWithBells();
    const board = state.world!.artifacts.find((artifact) => artifact.id === BOARD)!;
    (board as { retiredAt?: string }).retiredAt = "2026-09-08T12:00:00Z";
    const screen = await mount(state);
    try {
      const row = screen.container.querySelector<HTMLElement>(`[data-library-item="artifact:${BOARD}"]`);
      assert.ok(row, "a retired file the Library names stays a row");
      assert.match(row.textContent ?? "", /retired from the shelf/);
      assert.equal(row.getAttribute("draggable"), "false");
      await act(async () => rowButton(screen, `artifact:${BOARD}`).click());
      assert.ok(action(screen, "Remove from library"), "its membership can come off from the row");
      assert.equal(action(screen, "Append to timeline"), null, "and nothing offers to place it");
    } finally {
      await close(screen);
    }
  });

  it("browses another world's shelf read-only and copies a file in with its provenance (issue 1033, #972)", async () => {
    const state = stateWithBells();
    // A second scene, so the Scene control is on the panel to begin with.
    const scenes = state.world!.productions[0]!.scenes;
    scenes.push({ ...scenes[0]!, id: "sc_05", number: 5, title: "The morning after", shots: [] });
    state.worlds.push({ worldId: "01J8F3K2QW9VZX4N7M0RTYB6ZZ", slug: "the-other-one", name: "The Other One", counts: { characters: 0, locations: 0, factions: 0, canonEntries: 0, productions: 0 }, updated: "2026-09-01T12:00:00Z" } as (typeof state.worlds)[number]);
    const screen = await mount(state);
    try {
      const browse = screen.container.querySelector<HTMLSelectElement>('select[aria-label="Browse world"]');
      assert.ok(browse, "another world can be browsed");
      // linkedom clears the selected option whenever any option's `selected` is set, even to
      // false, so only the chosen one is touched; its setter deselects the rest.
      const choose = async (value: string) => act(async () => {
        const select = screen.container.querySelector<HTMLSelectElement>('select[aria-label="Browse world"]')!;
        [...select.querySelectorAll("option")].find((option) => option.value === value)!.selected = true;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      // A scene chosen at home is this production's frame; the other world's shelf has none.
      const sceneSelect = () => screen.container.querySelector<HTMLSelectElement>('select[aria-label="Scene"]');
      const firstScene = sceneSelect()!.querySelectorAll("option")[1]!;
      await act(async () => {
        firstScene.selected = true;
        sceneSelect()!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      assert.equal(sceneSelect()!.querySelector<HTMLOptionElement>("option[selected]")?.value, firstScene.value, "a scene is chosen");
      await choose("the-other-one");
      assert.equal(sceneSelect(), null, "no scene control over another world's shelf");
      const asked = screen.sent.find((message) => message.kind === "browse-world-artifacts");
      assert.ok(asked && asked.kind === "browse-world-artifacts" && asked.slug === "the-other-one", "the coordinator is asked for that world's shelf");
      await act(async () => __applyEventForTest({
        type: "world.artifacts", at: "2026-09-09T12:00:00Z", requestId: asked.requestId, slug: "the-other-one",
        artifacts: [{ id: "ar_01J8G0000000000000000000B9", kind: "video", file: "clip.mp4", name: "Halima Sadiq", durationSec: 6, picture: ".index/posters/ar_01J8G0000000000000000000B9.png" }],
      }));
      const row = screen.container.querySelector<HTMLElement>('[data-library-item="borrow:ar_01J8G0000000000000000000B9"]');
      assert.ok(row, "the other world's file is a row");
      assert.match(row.querySelector(".fy-artrow__name")?.textContent ?? "", /Halima Sadiq/, "named as its own shelf names it");
      assert.match(row.querySelector(".fy-artrow__meta")?.textContent ?? "", /video · 6s · from The Other One/);
      assert.match(row.querySelector(".fy-artrow__swatch img")?.getAttribute("src") ?? "", /\/media\/the-other-one\/\.index\/posters\//, "its picture is served under its own world");
      assert.equal(row.getAttribute("draggable"), null, "read-only: nothing here drags onto a lane");
      // The pressed filter still means what it says on these rows: Audio keeps only sound.
      const chip = (label: string) => [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-artpanel__filters button")].find((button) => button.textContent === label)!;
      await act(async () => chip("Audio").click());
      assert.equal(screen.container.querySelector('[data-library-item="borrow:ar_01J8G0000000000000000000B9"]'), null, "a video is not sound");
      await act(async () => chip("All").click());
      const shownAgain = screen.container.querySelector<HTMLElement>('[data-library-item="borrow:ar_01J8G0000000000000000000B9"]')!;
      assert.ok(shownAgain, "back with the filter");
      await act(async () => shownAgain.querySelector<HTMLButtonElement>(".fy-artrow__pick")!.click());
      await act(async () => action(screen, "Copy into this world")!.click());
      const borrow = screen.sent.find((message) => message.kind === "borrow-artifacts");
      assert.ok(borrow && borrow.kind === "borrow-artifacts");
      assert.deepEqual([borrow.slug, borrow.files, borrow.editor.destination], ["the-other-one", ["clip.mp4"], "library"]);
      const pending = screen.container.querySelector("[data-testid='pending-import']")?.textContent ?? "";
      assert.match(pending, /clip\.mp4/, "listed here while it copies");
      assert.match(pending, /importing…/);
      assert.doesNotMatch(pending, /KB|MB/, "a borrow has no size to state");
      // Back home: the bells are this world's, and a borrowed file would say where it came from.
      // Browsing stays available while the copy runs; only copying waits.
      assert.equal(action(screen, "Copy into this world")?.disabled, true);
      await choose("here");
      assert.ok(rows(screen).includes(`artifact:${BELLS}`));
      assert.equal(sceneSelect()!.querySelector<HTMLOptionElement>("option[selected]")?.value ?? "all", "all", "home again with every scene, not the stale one");
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

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  applyTimelineCommands,
  orderedShots,
  seedStoryPictureTimeline,
  storyTimelineFingerprint,
  type ClientMessage,
  type ClientState,
  type TimelineCommand,
} from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { ARTIFACT_DRAG_TYPE, LANE_DRAG_SOUND } from "../src/screens/editor-audio.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The target's editor behaviour (SPEC-039 §1.9, R-10, R-13, R-24, T-5, T-10, A-3): Generate's
 * hand-off assembles once as the editor opens; lanes refuse the wrong kind while a drag hovers
 * and take a drop that adds the lane; every drag has a click path to the same one command; the
 * export sheet is the delivery surface; a read line lands on Dialogue.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, {
  matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ direction: "ltr", getPropertyValue: () => "" }),
});
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
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

function commandsSent(screen: Mounted): TimelineCommand[][] {
  return screen.sent.filter((message): message is Extract<ClientMessage, { kind: "timeline-command" }> => message.kind === "timeline-command").map((message) => [...message.commands]);
}

function button(screen: Mounted, label: string): HTMLButtonElement {
  const found = [...screen.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  assert.ok(found, `a button labelled ${label}`);
  return found;
}

/** React's own handler for an element, so a drag the DOM cannot stage can still reach the lane. */
function reactProps(element: Element): Record<string, (event: unknown) => void> {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"));
  assert.ok(key, "the element is React's");
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key]!;
}

function dragEvent(types: string[], artifactId: string, x = 50) {
  let dropEffect = "copy";
  const event = {
    preventDefault() {},
    clientX: x,
    dataTransfer: {
      types,
      getData: () => artifactId,
      get dropEffect() {
        return dropEffect;
      },
      set dropEffect(value: string) {
        dropEffect = value;
      },
    },
    currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 100 }) },
  };
  return event;
}

/** The story saved, the bells in the Library and once on a Music track, an empty Music 2 beside it. */
function savedState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  const shots = production.scenes.flatMap((scene) => orderedShots(scene).map((shot) => ({ kind: "shot" as const, shotId: shot.id })));
  production.timeline = {
    status: "ready",
    timeline: applyTimelineCommands(seedStoryPictureTimeline(production), [
      { kind: "add-to-library", items: [...shots, { kind: "artifact", artifactId: BELLS }] },
      { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
      { kind: "place", trackId: "tr_music", clip: { id: "cl_bells-1", startFrame: 0, durationFrames: 48, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "harbour-bells.wav" }, gainDb: 0 } },
      { kind: "add-track", trackId: "tr_music-2", trackKind: "music", name: "Music 2" },
    ]),
  };
  return state;
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("Generate hands off to the editor (R-44)", () => {
  it("sends one assembly for the scene as the editor opens, fenced by the story, and spends the query", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    const sceneId = production.scenes[0]!.id;
    const screen = await mount(state, `?assemble=${sceneId}`);
    try {
      const assemblies = screen.sent.filter((message) => message.kind === "timeline-assemble");
      assert.equal(assemblies.length, 1, "one assembly, however many renders");
      const [sent] = assemblies;
      assert.ok(sent && sent.kind === "timeline-assemble");
      assert.equal(sent.sceneId, sceneId);
      assert.equal(sent.baseRevision, null, "nothing is saved yet");
      assert.equal(sent.sourceFingerprint, storyTimelineFingerprint(production));
    } finally {
      await close(screen);
    }
  });
});

describe("lanes as the target draws them (R-13, R-10)", () => {
  it("refuses sound over a picture lane while the drag hovers, and takes it on a sound lane", async () => {
    const screen = await mount(savedState());
    try {
      const picture = screen.container.querySelector<HTMLElement>('[data-track="picture"] .fy-track__lane')!;
      const refused = dragEvent([ARTIFACT_DRAG_TYPE, LANE_DRAG_SOUND], BELLS);
      await act(async () => reactProps(picture)["onDragOver"]!(refused));
      assert.equal(refused.dataTransfer.dropEffect, "none", "sound cannot land on picture");
      assert.match(screen.container.querySelector('[data-track="picture"] .fy-track__lane')?.textContent ?? "", /picture lanes take picture/);

      const music = screen.container.querySelector<HTMLElement>('[data-track-id="tr_music-2"] .fy-track__lane')!;
      const accepted = dragEvent([ARTIFACT_DRAG_TYPE, LANE_DRAG_SOUND], BELLS);
      await act(async () => reactProps(music)["onDragOver"]!(accepted));
      assert.equal(accepted.dataTransfer.dropEffect, "copy");
      await act(async () => reactProps(music)["onDrop"]!(accepted));
      const [batch] = commandsSent(screen);
      assert.ok(batch, "one batch was sent");
      assert.ok(batch, "the drop placed");
      assert.deepEqual(batch.map((command) => command.kind), ["place"]);
      assert.equal(batch[0]!.kind === "place" && batch[0]!.trackId, "tr_music-2");
    } finally {
      await close(screen);
    }
  });

  it("a drop on an empty lane adds that lane and places in one batch; the new-lane strip makes another", async () => {
    const screen = await mount(savedState());
    try {
      const dialogue = screen.container.querySelector<HTMLElement>('[data-track="dialogue"] .fy-track__lane')!;
      assert.ok(dialogue, "the empty Dialogue lane is drawn");
      await act(async () => reactProps(dialogue)["onDrop"]!(dragEvent([ARTIFACT_DRAG_TYPE, LANE_DRAG_SOUND], BELLS)));
      const [first] = commandsSent(screen);
      assert.ok(first);
      assert.deepEqual(first.map((command) => command.kind), ["add-track", "place"]);
      assert.equal(first[0]!.kind === "add-track" && first[0]!.trackKind, "dialogue");

      const strip = screen.container.querySelector<HTMLElement>('[data-track="new"] .fy-track__lane')!;
      assert.ok(strip, "the new-lane strip sits under the lanes");
      // The gate holds while one batch is in flight; the snapshot answers before the next.
      const state = savedState();
      const saved = state.world!.productions[0]!.timeline;
      assert.ok(saved && saved.status === "ready");
      state.world!.productions[0]!.timeline = { status: "ready", timeline: { ...saved.timeline, revision: 9 } };
      await act(async () => __setStateForTest(state));
      await act(async () => reactProps(strip)["onDrop"]!(dragEvent([ARTIFACT_DRAG_TYPE, LANE_DRAG_SOUND], BELLS)));
      const batches = commandsSent(screen);
      const second = batches[batches.length - 1]!;
      assert.deepEqual(second.map((command) => command.kind), ["add-track", "place"]);
      assert.equal(second[0]!.kind === "add-track" && second[0]!.name, "Music 3", "a third Music lane, named in order");
    } finally {
      await close(screen);
    }
  });

  it("an empty extra lane can be removed; the base Picture track cannot", async () => {
    const screen = await mount(savedState());
    try {
      assert.equal([...screen.container.querySelectorAll('[aria-label="Remove Picture"]')].length, 0);
      assert.equal([...screen.container.querySelectorAll('[aria-label="Remove Music"]')].length, 0, "a lane holding a clip stays");
      await act(async () => button(screen, "Remove Music 2").click());
      const [batch] = commandsSent(screen);
      assert.ok(batch, "one batch was sent");
      assert.deepEqual(batch, [{ kind: "remove-track", trackId: "tr_music-2" }]);
    } finally {
      await close(screen);
    }
  });

  it("the Inspector's kind chips move a sound clip to another lane as one batch (A-3)", async () => {
    const screen = await mount(savedState());
    try {
      await act(async () => screen.container.querySelector<HTMLButtonElement>('[data-clip="cl_bells-1"]')!.click());
      const chips = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-movekind__chip")];
      assert.equal(chips.length, 3, "Dialogue, Ambience, Music");
      assert.equal(chips.find((chip) => chip.textContent === "Music")?.getAttribute("aria-pressed"), "true");
      await act(async () => chips.find((chip) => chip.textContent === "Ambience")!.click());
      const [batch] = commandsSent(screen);
      assert.ok(batch, "one batch was sent");
      assert.deepEqual(batch.map((command) => command.kind), ["delete", "add-track", "place"]);
      assert.equal(batch[1]!.kind === "add-track" && batch[1]!.trackKind, "ambience");
      assert.equal(batch[2]!.kind === "place" && batch[2]!.clip.source.kind === "artifact" && batch[2]!.clip.source.artifactId, BELLS);
    } finally {
      await close(screen);
    }
  });
});

describe("keys the toolbar promises (R-17)", () => {
  it("V, B and H switch the tool; nothing edits behind an open sheet", async () => {
    const screen = await mount(savedState());
    try {
      // linkedom's Event carries no key of its own; the property is defined the way the other suites do it.
      const press = (key: string) =>
        act(async () => {
          const event = new Event("keydown");
          Object.defineProperty(event, "key", { value: key });
          window.dispatchEvent(event);
          await Promise.resolve();
        });
      await press("b");
      assert.equal(button(screen, "Blade").getAttribute("aria-pressed"), "true");
      await press("v");
      assert.equal(button(screen, "Select").getAttribute("aria-pressed"), "true");
      await act(async () => screen.container.querySelector<HTMLButtonElement>('[data-clip="cl_bells-1"]')!.click());
      await press("?");
      assert.ok(screen.container.querySelector(".fy-editordialog"), "the keys sheet is up");
      await press("Delete");
      assert.equal(commandsSent(screen).length, 0, "Delete behind the sheet deletes nothing");
      await press("Escape");
      assert.equal(screen.container.querySelector(".fy-editordialog"), null);
    } finally {
      await close(screen);
    }
  });
});

describe("the export sheet (R-24, T-5)", () => {
  it("opens from the header, carries the chips, and sends the export it describes", async () => {
    const screen = await mount(savedState());
    try {
      await act(async () => button(screen, "Export film").click());
      const sheet = screen.container.querySelector<HTMLElement>('[data-testid="export-sheet"]');
      assert.ok(sheet, "the sheet is up");
      const chips = [...sheet.querySelectorAll<HTMLButtonElement>(".fy-exsheet__chip")].map((chip) => chip.textContent?.trim());
      assert.ok(chips.some((chip) => /review/.test(chip ?? "")), "resolution chips");
      assert.ok(chips.includes("Stereo · ducked") && chips.includes("Stereo · flat"), "the mix chips");
      await act(async () => [...sheet.querySelectorAll<HTMLButtonElement>(".fy-exsheet__chip")].find((chip) => /master/.test(chip.textContent ?? ""))!.click());
      await act(async () => [...sheet.querySelectorAll<HTMLButtonElement>(".fy-exsheet__chip")].find((chip) => chip.textContent === "Stereo · flat")!.click());
      const [mix] = commandsSent(screen);
      assert.deepEqual(mix, [{ kind: "set-mix", mix: { speechFirst: false } }], "the audio chip is a timeline command");
      // The mix command is in flight; the export waits for the snapshot that answers it (round three).
      const ctaPending = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-libpick__confirm")].find((candidate) => /Export/.test(candidate.textContent ?? ""))!;
      assert.equal(ctaPending.disabled, true, "no export while a command is pending");
      const answered = savedState();
      const saved = answered.world!.productions[0]!.timeline;
      assert.ok(saved && saved.status === "ready");
      answered.world!.productions[0]!.timeline = { status: "ready", timeline: { ...saved.timeline, revision: saved.timeline.revision + 1 } };
      await act(async () => __setStateForTest(answered));
      const cta = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-libpick__confirm")].find((candidate) => /Export/.test(candidate.textContent ?? ""))!;
      await act(async () => cta.click());
      const exported = screen.sent.find((message) => message.kind === "export-cut");
      assert.ok(exported && exported.kind === "export-cut", "the export was sent");
      assert.equal(exported.preset, "master");
      assert.equal(screen.container.querySelector('[data-testid="export-sheet"]'), null, "the sheet closes");
    } finally {
      await close(screen);
    }
  });

  it("says why nothing can be exported from an empty first state, and opens from the Exports address", async () => {
    const screen = await mount(structuredClone(FIXTURE_STATE) as ClientState, "?export=1");
    try {
      const sheet = screen.container.querySelector<HTMLElement>('[data-testid="export-sheet"]');
      assert.ok(sheet, "the sheet opens from the query");
      assert.match(sheet.textContent ?? "", /Nothing on the timeline yet/);
      const cta = [...sheet.parentElement!.querySelectorAll<HTMLButtonElement>(".fy-libpick__confirm")].find((candidate) => /Export/.test(candidate.textContent ?? ""))!;
      assert.equal(cta.disabled, true);
    } finally {
      await close(screen);
    }
  });
});

describe("spoken lines in the Library (R-1, R-8)", () => {
  it("lists every line under the audio filter, and places a read one on Dialogue", async () => {
    const state = savedState();
    const production = state.world!.productions[0]!;
    const spoken = production.scenes.flatMap((scene) => orderedShots(scene)).find((shot) => (shot.audio?.kind === "vo" || shot.audio?.kind === "dialogue") && shot.audio.line);
    assert.ok(spoken, "the fixture has a spoken line");
    production.takes.push({
      ...production.takes[0]!,
      id: "tk_voice_1" as never,
      coversShots: [spoken.id],
      kind: "voice",
      provider: "kokoro",
      model: "kokoro-82m",
      media: "speech.wav",
      completedAt: "2026-09-01T12:00:00Z",
    } as never);
    const screen = await mount(state, "?library=audio");
    try {
      const row = screen.container.querySelector<HTMLElement>(`[data-library-item="line:${spoken.id}"]`);
      assert.ok(row, "the line is a row");
      assert.equal(row.querySelector(".fy-artrow__status")?.textContent, "read");
      assert.equal(row.querySelector(".fy-artrow__voice")?.textContent, "Again");
      await act(async () => row.querySelector<HTMLButtonElement>(".fy-artrow__pick")!.click());
      const add = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-artrow__actions button")].find((candidate) => candidate.textContent?.includes("Add to timeline"));
      assert.ok(add, "a read line can be placed");
      await act(async () => add.click());
      const [batch] = commandsSent(screen);
      assert.ok(batch, "one batch was sent");
      assert.deepEqual(batch.map((command) => command.kind), ["add-track", "place"]);
      assert.equal(batch[0]!.kind === "add-track" && batch[0]!.trackKind, "dialogue");
      assert.equal(batch[1]!.kind === "place" && batch[1]!.clip.source.kind === "take" && batch[1]!.clip.source.takeId, "tk_voice_1");
    } finally {
      await close(screen);
    }
  });
});

describe("the picker and the keys sheet, round two", () => {
  it("unchecking an item in the Library removes it, and Cancel forgets a draft", async () => {
    const screen = await mount(savedState());
    try {
      await act(async () => button(screen, "Add").click());
      const box = (): HTMLInputElement => {
        const row = [...screen.container.querySelectorAll<HTMLLabelElement>(".fy-libpick__row")].find((candidate) => candidate.textContent?.includes("SH 12"));
        const input = row?.querySelector<HTMLInputElement>("input");
        assert.ok(input, "the SH 12 row is in the picker");
        return input;
      };
      assert.equal(box().checked, true, "a shot already in the Library shows checked");
      await act(async () => box().click());
      await act(async () => button(screen, "Cancel").click());
      await act(async () => button(screen, "Add").click());
      assert.equal(box().checked, true, "Cancel forgot the unchecking");
      await act(async () => box().click());
      await act(async () => button(screen, "Update the library").click());
      const [batch] = commandsSent(screen);
      assert.deepEqual(batch, [{ kind: "remove-from-library", items: [{ kind: "shot", shotId: "sh_12" }] }]);
    } finally {
      await close(screen);
    }
  });

  it("? closes the keys sheet it opened", async () => {
    const screen = await mount(savedState());
    try {
      const press = (key: string) =>
        act(async () => {
          const event = new Event("keydown");
          Object.defineProperty(event, "key", { value: key });
          window.dispatchEvent(event);
          await Promise.resolve();
        });
      await press("?");
      assert.ok(screen.container.querySelector(".fy-editordialog"));
      await press("?");
      assert.equal(screen.container.querySelector(".fy-editordialog"), null);
    } finally {
      await close(screen);
    }
  });

  it("a shot added from the Library lands after the clip under the playhead", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    const seeded = seedStoryPictureTimeline(production);
    const first = seeded.tracks[0]!.clips[0]!;
    production.timeline = {
      status: "ready",
      timeline: applyTimelineCommands(
        { ...seeded, tracks: [{ ...seeded.tracks[0]!, clips: [first] }] },
        [{ kind: "add-to-library", items: [{ kind: "shot", shotId: "sh_12" }, { kind: "shot", shotId: "sh_13" }] }],
      ),
    };
    const screen = await mount(state);
    try {
      await act(async () => screen.container.querySelector<HTMLButtonElement>('[data-library-item="shot:sh_13"] .fy-artrow__pick')!.click());
      const add = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-artrow__actions button")].find((candidate) => candidate.textContent?.includes("Add to timeline"));
      assert.ok(add, "the unplaced shot can be added");
      await act(async () => add.click());
      const [batch] = commandsSent(screen);
      assert.ok(batch && batch[0]!.kind === "place");
      assert.equal(batch[0]!.kind === "place" && batch[0]!.clip.startFrame, first.startFrame + first.durationFrames, "it slides past the clip at the playhead");
    } finally {
      await close(screen);
    }
  });
});

describe("the picker sees what the production sees", () => {
  it("leaves another production's scoped file out of the rows", async () => {
    const state = savedState();
    state.world!.artifacts.push({
      id: "ar_01J8G0000000000000000000R8",
      kind: "audio",
      file: "other-scratch.wav",
      hash: "sha256:d1d24c90a13e58f8",
      origin: { by: "user" },
      links: [],
      production: "someone-else",
      created: "2026-07-29T11:02:00Z",
    } as never);
    const screen = await mount(state);
    try {
      await act(async () => button(screen, "Add").click());
      const rows = [...screen.container.querySelectorAll<HTMLElement>(".fy-libpick__row")].map((row) => row.textContent ?? "");
      assert.ok(rows.some((row) => row.includes("harbour-bells.wav")), "the world's own file is offered");
      assert.ok(!rows.some((row) => row.includes("other-scratch.wav")), "another production's scratch is not");
    } finally {
      await close(screen);
    }
  });
});

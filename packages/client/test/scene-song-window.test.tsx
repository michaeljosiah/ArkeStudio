import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { newGraphScene, type ClientMessage, type ClientState, type ProductionSpine, type SceneRecord, type SpineMarker } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyEventForTest, __handleFrameForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { sceneSongLine, sectionsFromScenes, songWindowLabel } from "../src/lib/song.js";
import { CutScreen } from "../src/screens/cut.js";
import { ScenesScreen } from "../src/screens/production-story.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A scene's place in the song (issues 3100 and 3101). A music video's scene covered sixteen
 * seconds of the master track and its header read "0 shots · 0s", with the window only in its
 * title. A scene that has a window now shows it, with how much of it is pinned, and the Cut
 * offers the scenes' windows as the song's sections with one press.
 */
const dom = parseHTML("<!doctype html><html><body></body></html>");
// linkedom has no layout: the Cut reads its breakpoints, and the app's shell listens for them to change.
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768,
  matchMedia: (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }) });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) });

const SONG = "ar_01J8G0000000000000000000R1";
const VERSE: SpineMarker = { kind: "section", id: "mk_01J8G0000000000000000000S1", label: "Verse 1", atSec: 16, source: "manual" };

function spineOn(revision = 1, extra: Partial<ProductionSpine> = {}): ProductionSpine {
  return { schemaVersion: 1, revision, trackArtifactId: SONG, markers: [], anchors: {}, updatedAt: "2026-11-15T09:00:00.000Z", ...extra };
}

/** The fixture's scene 4, its two shots pinned to twelve seconds of a twenty-eight second window. */
function pinnedFilm(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.scenes[0]!.songWindow = { startSec: 16, endSec: 44 };
  production.spine = spineOn(3, { anchors: {
    sh_12: { startSec: 16, endSec: 22, clipAudio: { mode: "mute" } },
    sh_13: { startSec: 22, endSec: 28, clipAudio: { mode: "mute" } },
  } });
  return state;
}

const windowed = (id: string, number: number, title: string, songWindow?: SceneRecord["songWindow"]): SceneRecord => ({
  ...newGraphScene({ id: `sc_${id}`, number, order: number, slug: id, title, status: "draft", version: 1 }),
  ...(songWindow ? { songWindow } : {}),
});

/** A music video as setup leaves it: scenes with a place in the song, no shots, and the song measured at 3:47. */
function musicVideo(spine: ProductionSpine | null, scenes: SceneRecord[] = [
  windowed("intro", 1, "Intro", { startSec: 0, endSec: 16 }),
  windowed("verse-1", 2, "Verse 1: the phone", { startSec: 16, endSec: 44 }),
  windowed("bridge", 3, "Bridge"),
]): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.meta.kind = "music-video";
  production.scenes = scenes;
  production.sceneFiles = Object.fromEntries(scenes.map((scene) => [scene.id, scene.slug]));
  production.takes = []; production.reviews = []; production.selections = {};
  production.spine = spine;
  state.world!.artifacts = [{ ...state.world!.artifacts[0]!, mediaInfo: { durationSec: 227.6, hasAudio: true } }];
  return state;
}

afterEach(() => { __setStateForTest(FIXTURE_STATE); __setBridgeForTest(null); dom.document.body.replaceChildren(); });

describe("a scene's line in the song (issue 3101)", () => {
  it("reads as its window and how much of it is pinned", () => {
    const production = pinnedFilm().world!.productions[0]!;
    assert.equal(songWindowLabel({ startSec: 16, endSec: 44 }), "0:16–0:44");
    assert.equal(songWindowLabel({ startSec: 196.4, endSec: 227.6 }), "3:16–3:48");
    assert.equal(sceneSongLine(production, production.scenes[0]!), "0:16–0:44 · 12s of 28s pinned");
    assert.equal(sceneSongLine({ spine: spineOn() }, production.scenes[0]!), "0:16–0:44 · 0s of 28s pinned", "nothing pinned yet");
  });

  it("says nothing without a master track, or for a scene with no place in the song", () => {
    const production = pinnedFilm().world!.productions[0]!;
    assert.equal(sceneSongLine({ spine: null }, production.scenes[0]!), null);
    assert.equal(sceneSongLine(production, FIXTURE_STATE.world!.productions[0]!.scenes[0]!), null);
  });

  it("shows on the scene's header in place of its shots' own length, and only then", async () => {
    const mount = async (state: ClientState) => {
      const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
      await act(async () => {
        __setStateForTest(state);
        root.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/saltlight/scenes/sc_04`]}><App /></MemoryRouter>);
      });
      const text = container.querySelector("[data-testid='scene-length']")?.textContent;
      const metrics = container.querySelector("[aria-label='Scene metrics']")?.textContent;
      await act(async () => root.unmount()); container.remove();
      return { text, metrics };
    };
    const pinned = await mount(pinnedFilm());
    assert.equal(pinned.text, "0:16–0:44 · 12s of 28s pinned");
    assert.match(pinned.metrics ?? "", /2 shots/, "the shots are still counted beside it");
    assert.equal((await mount(structuredClone(FIXTURE_STATE) as ClientState)).text, "10s", "a scene with no window shows what it always has");
    const noSong = pinnedFilm();
    noSong.world!.productions[0]!.spine = null;
    assert.equal((await mount(noSong)).text, "10s", "and so does one whose production has no master track");
  });

  it("shows on the scene's row in Scenes", () => {
    const render = (state: ClientState) => {
      __setStateForTest(state);
      return renderToString(
        <MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/saltlight/scenes`]}>
          <Routes><Route path="/w/:worldId/p/:prodId/scenes" element={<ScenesScreen />} /></Routes>
        </MemoryRouter>,
      ).replace(/<!-- -->/g, "");
    };
    assert.match(render(pinnedFilm()), /2 shots · 0:16–0:44 · 12s of 28s pinned/);
    assert.match(render(structuredClone(FIXTURE_STATE) as ClientState), /2 shots · 10s/);
    assert.match(render(musicVideo(spineOn())), /0 shots · 0:00–0:16 · 0s of 16s pinned/, "a scene with no shots yet is its window, not 0s");
  });
});

describe("Mark N sections from the scenes (issue 3100)", () => {
  it("is offered for a song with no sections whose scenes have a place in it", () => {
    const production = (spine: ProductionSpine | null, scenes?: SceneRecord[]) => musicVideo(spine, scenes).world!.productions[0]!;
    assert.deepEqual(sectionsFromScenes(production(spineOn(4)), 227.6), { count: 2, baseRevision: 4, command: { kind: "mark-sections-from-scenes" } });
    assert.equal(sectionsFromScenes(production(null), 227.6), null, "no song yet");
    assert.equal(sectionsFromScenes(production(spineOn(4, { markers: [VERSE] })), 227.6), null, "the song has a section");
    assert.equal(sectionsFromScenes(production(spineOn(4), [windowed("bridge", 1, "Bridge")]), 227.6), null, "no scene has a place in it");
    assert.equal(sectionsFromScenes(production(spineOn(4), [windowed("outro", 1, "Outro", { startSec: 240, endSec: 250 })]), 227.6), null,
      "a scene past the end of the song would be refused, so it is not offered");
    // Lyrics are not sections: a song with only an imported lyric sheet is still offered them.
    const lyric: SpineMarker = { kind: "lyric", id: "mk_01J8G0000000000000000000Y1", text: "Why you do me", atSec: 20, source: "lrc" };
    assert.equal(sectionsFromScenes(production(spineOn(4, { markers: [lyric] })), 227.6)?.count, 2);
  });

  let seq = 5_000;
  const snapshot = (state: ClientState) => __handleFrameForTest({ kind: "snapshot", seq: ++seq, state });

  async function mountCut(state: ClientState) {
    const sent: ClientMessage[] = [];
    const bridge = { appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json)); } };
    Object.assign(window, { arke: bridge });
    __setBridgeForTest(bridge);
    __setStateForTest(state);
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${state.world!.productions[0]!.meta.id}/cut`]}>
      <Routes><Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} /></Routes>
    </MemoryRouter>));
    const notice = () => container.querySelector<HTMLElement>("[data-testid='sections-notice']");
    const press = () => notice()?.querySelector<HTMLButtonElement>("button:not(.fy-cutnotice__hide)") ?? null;
    return { container, sent, notice, press,
      spineCommands: () => sent.filter((message): message is Extract<ClientMessage, { kind: "spine-command" }> => message.kind === "spine-command"),
      async close() { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(window, "arke"); } };
  }

  it("marks them with one press at the revision shown, and goes once the song has sections", async () => {
    const screen = await mountCut(musicVideo(spineOn(1)));
    try {
      assert.match(screen.notice()?.textContent ?? "", /No sections yet\./);
      assert.equal(screen.press()?.textContent?.trim(), "Mark 2 sections from the scenes");
      await act(async () => screen.press()!.click());
      const [sent] = screen.spineCommands();
      assert.equal(screen.spineCommands().length, 1);
      assert.deepEqual({ baseRevision: sent!.baseRevision, command: sent!.command }, { baseRevision: 1, command: { kind: "mark-sections-from-scenes" } });
      assert.equal(screen.press()!.disabled, true, "held until the answer: a second press would be stale");

      // A refusal under that request gives the press back.
      await act(async () => __applyEventForTest({ type: "command.failed", at: "2026-11-15T09:00:01.000Z", command: "spine-command", requestId: sent!.requestId, reason: "the song already has sections" }));
      assert.equal(screen.press()!.disabled, false);

      // The snapshot that carries the sections ends the offer.
      await act(async () => screen.press()!.click());
      await act(async () => snapshot(musicVideo(spineOn(2, { markers: [{ ...VERSE, label: "Intro", atSec: 0 }, VERSE] }))));
      assert.equal(screen.notice(), null);
    } finally { await screen.close(); }
  });

  it("says one section as one, and can be put away", async () => {
    const screen = await mountCut(musicVideo(spineOn(1), [windowed("intro", 1, "Intro", { startSec: 0, endSec: 16 })]));
    try {
      assert.equal(screen.press()?.textContent?.trim(), "Mark 1 section from the scenes");
      await act(async () => screen.notice()!.querySelector<HTMLButtonElement>(".fy-cutnotice__hide")!.click());
      assert.equal(screen.notice(), null);
      assert.equal(screen.spineCommands().length, 0, "putting it away marks nothing");
    } finally { await screen.close(); }
  });

  it("is not offered before there is a song, once the song has a section, or when no scene has a place", async () => {
    for (const [why, state] of [
      ["no song: the Cut asks for the song first", musicVideo(null)],
      ["the song has a section", musicVideo(spineOn(2, { markers: [VERSE] }))],
      ["no scene has a place in the song", musicVideo(spineOn(1), [windowed("bridge", 1, "Bridge")])],
    ] as const) {
      const screen = await mountCut(state);
      try { assert.equal(screen.notice(), null, why); } finally { await screen.close(); }
    }
  });
});

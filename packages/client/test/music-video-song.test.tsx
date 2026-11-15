import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { ClientMessage, ClientState, ProductionSpine } from "@arke-studio/contracts";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { offersSong, songCommand, wantsSong } from "../src/lib/song.js";
import { CutScreen } from "../src/screens/cut.js";
import { ProductionDashboardScreen } from "../src/screens/production-dashboard.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A music video's song (issue 3088): nothing asked for it, and only Arke's card could make a song
 * the master track. The Dashboard and the Cut now say there is none, and a sound file in the Cut's
 * Library becomes the song with one press, through the spine command.
 */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { innerWidth: 1024, innerHeight: 768, matchMedia: (media: string) => ({ matches: false, media }) });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

const SONG = "ar_01J8G0000000000000000000R1";
const OTHER = "ar_01J8G0000000000000000000R9";

function spineOn(trackArtifactId: string, revision = 1): ProductionSpine {
  return { schemaVersion: 1, revision, trackArtifactId, markers: [], anchors: {}, updatedAt: "2026-11-15T09:00:00.000Z" };
}

function musicVideo(spine: ProductionSpine | null = null): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.meta.kind = "music-video";
  production.scenes = [];
  production.spine = spine;
  const song = { ...state.world!.artifacts[0]!, mediaInfo: { durationSec: 227.6, hasAudio: true } };
  state.world!.artifacts = [song, { ...song, id: OTHER, file: "second-take.wav", hash: "sha256:9999999999999999" }];
  return state;
}

describe("the song's logic (issue 3088)", () => {
  const meta = FIXTURE_STATE.world!.productions[0]!.meta;
  const video = { meta: { ...meta, kind: "music-video" }, spine: null };
  const film = { meta, spine: null };
  const measured = { kind: "audio" as const, mediaInfo: { durationSec: 30, hasAudio: true } };

  it("asks a music video for its song until it has one, and no other production", () => {
    assert.equal(wantsSong(video), true);
    assert.equal(wantsSong({ ...video, spine: spineOn(SONG) }), false);
    assert.equal(wantsSong(film), false);
  });

  it("offers a measured sound file to a production cut to a song", () => {
    assert.equal(offersSong(video, measured), true);
    assert.equal(offersSong(video, { kind: "audio" }), false, "an unmeasured master is refused, so it is not offered");
    assert.equal(offersSong(video, { kind: "video", mediaInfo: { durationSec: 5, hasAudio: true } }), false);
    assert.equal(offersSong(film, measured), false, "a film without a song clock is not asked");
    assert.equal(offersSong({ ...film, spine: spineOn(SONG) }, measured), true, "a film that has one may change it");
  });

  it("creates the spine, or moves its track at the revision shown", () => {
    assert.deepEqual(songCommand(null, SONG), { baseRevision: null, command: { kind: "create", trackArtifactId: SONG } });
    assert.deepEqual(songCommand(spineOn(SONG, 3), OTHER), { baseRevision: 3, command: { kind: "assign-track", trackArtifactId: OTHER } });
    assert.equal(songCommand(spineOn(SONG, 3), SONG), null, "the song already");
  });
});

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
  const buttons = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === text);
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-library-item="artifact:${id}"]`)!;
  const pick = async (id: string) => { await act(async () => row(id).querySelector<HTMLButtonElement>(".fy-artrow__pick")!.click()); };
  return { container, sent, buttons, row, pick,
    async close() { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(window, "arke"); __setBridgeForTest(null); } };
}

describe("the Cut asks for the song (issue 3088)", () => {
  it("says there is no song, shows the Library's audio, and makes a row the song with one press", async () => {
    const screen = await mountCut(musicVideo());
    try {
      assert.match(screen.container.querySelector("[data-testid='song-notice']")?.textContent ?? "", /No song yet/);
      await act(async () => screen.buttons("Choose the song")[0]!.click());
      const audio = [...screen.container.querySelectorAll<HTMLButtonElement>("[aria-label='Library filters'] button")].find((b) => b.textContent === "Audio")!;
      assert.equal(audio.getAttribute("aria-pressed"), "true", "the Library opens on Audio");

      await screen.pick(SONG);
      await act(async () => screen.buttons("Use as the song")[0]!.click());
      const sent = screen.sent.filter((message) => message.kind === "spine-command");
      assert.equal(sent.length, 1);
      assert.ok(sent[0]!.kind === "spine-command");
      assert.deepEqual({ baseRevision: sent[0]!.baseRevision, command: sent[0]!.command }, { baseRevision: null, command: { kind: "create", trackArtifactId: SONG } });
      assert.equal(screen.buttons("Use as the song").length, 0, "held until the answer: a second press would be stale");

      // A refusal under that request lets the person try again.
      await act(async () => __applyEventForTest({ type: "command.failed", at: "2026-11-15T09:00:01.000Z", command: "spine-command", requestId: sent[0]!.requestId, reason: "master track has not been measured" }));
      assert.equal(screen.buttons("Use as the song").length, 1);

      // The snapshot that carries the spine ends the ask: the row reads as the song, the notice goes.
      await act(async () => __setStateForTest(musicVideo(spineOn(SONG))));
      assert.equal(screen.container.querySelector("[data-testid='song-notice']"), null);
      assert.match(screen.row(SONG).textContent ?? "", /the song/);
      assert.equal(screen.buttons("Use as the song").length, 0, "the song is not offered as itself");

      // Another sound file moves the song at the revision shown.
      await screen.pick(OTHER);
      await act(async () => screen.buttons("Use as the song")[0]!.click());
      const moved = screen.sent.filter((message) => message.kind === "spine-command").at(-1)!;
      assert.ok(moved.kind === "spine-command");
      assert.deepEqual({ baseRevision: moved.baseRevision, command: moved.command }, { baseRevision: 1, command: { kind: "assign-track", trackArtifactId: OTHER } });
    } finally { await screen.close(); }
  });

  it("says nothing about a song to a film", async () => {
    const state = musicVideo();
    delete state.world!.productions[0]!.meta.kind;
    const screen = await mountCut(state);
    try {
      assert.equal(screen.container.querySelector("[data-testid='song-notice']"), null);
      await screen.pick(SONG);
      assert.equal(screen.buttons("Use as the song").length, 0);
    } finally { await screen.close(); }
  });
});

describe("the Dashboard asks for the song (issue 3088)", () => {
  const render = (state: ClientState) => {
    __setStateForTest(state);
    const production = state.world!.productions[0]!;
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${production.meta.id}`]}>
        <Routes><Route path="/w/:worldId/p/:prodId" element={<ProductionDashboardScreen />} /></Routes>
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  };

  it("shows the card only while a music video has no song", () => {
    try {
      assert.match(render(musicVideo()), /NO SONG YET.*Choose the song/);
      assert.doesNotMatch(render(musicVideo(spineOn(SONG))), /NO SONG YET/);
      const film = musicVideo();
      delete film.world!.productions[0]!.meta.kind;
      assert.doesNotMatch(render(film), /NO SONG YET/);
    } finally { __setStateForTest(FIXTURE_STATE); }
  });

  it("opens the Cut's Library on Audio", async () => {
    const state = musicVideo();
    __setStateForTest(state);
    const production = state.world!.productions[0]!;
    const Landed = () => { const location = useLocation(); return <p>{`landed ${location.pathname}${location.search}`}</p>; };
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${production.meta.id}`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId" element={<ProductionDashboardScreen />} />
          <Route path="/w/:worldId/p/:prodId/cut" element={<Landed />} />
        </Routes>
      </MemoryRouter>));
      const open = [...container.querySelectorAll<HTMLButtonElement>("[data-testid='song-card'] button")].find((b) => b.textContent === "Open the Library")!;
      await act(async () => open.click());
      assert.match(container.textContent ?? "", new RegExp(`landed /w/${state.world!.meta.worldId}/p/${production.meta.id}/cut\\?library=audio`));
    } finally {
      await act(async () => root.unmount()); container.remove(); __setStateForTest(FIXTURE_STATE);
    }
  });
});

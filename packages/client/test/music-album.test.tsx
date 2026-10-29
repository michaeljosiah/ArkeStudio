import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientMessage, ClientState, DomainEvent } from "@arke-studio/contracts";
import { DOOR_CHOICES, KINDS_BY_DOOR, KIND_PLATES, MUSIC_KIND_CHOICES, NewProductionScreen } from "../src/screens/world.js";
import { MusicAlbumScreen } from "../src/screens/music-album.js";
import { productionPages } from "../src/lib/production-navigation.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * Music productions in the Studio (design turn 238, SPEC-060 tasks 2 and 3): the Listen door, What
 * kind of music?, the album page, Add track, a track open, its composer and takes, the track
 * editor, the album's sequence, Make cover and Export → Arke Player.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1360, innerHeight: 900, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const AT = "2026-10-25T09:00:00.000Z";
const BELLS = "ar_01J8G0000000000000000000R1";
const SONG = "ar_01J9M000000000000000000501";
const TUNE = "ar_01J9M000000000000000000502";
const COVER = "ar_01J9M000000000000000000503";
const CUE = "ar_01J9M000000000000000000504";
const ALBUM = "songs-of-the-drowned-quarter";

const bench = (id: string, file: string, brief: string, lyrics: string) => ({
  id, kind: "audio", file, hash: "sha256:1111111111111111", origin: { by: "generated" }, links: [], created: "2026-10-23T10:00:00Z",
  mediaInfo: { durationSec: 112, hasAudio: true },
  generation: { source: "bench", sessionId: "bs_01J9M000000000000000000001", takeId: "bt_01J9M000000000000000000001", provider: "elevenlabs", model: "music_v1", brief, params: { kind: "music", lyrics, count: 1 }, costMicroUsd: 0, at: AT },
});

/** The fixture world with an album of one track, a song and a tune kept in Bench, and a picture. */
function withMusic(kind: "album" | "single" = "album"): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  const base = state.world!.productions[0]!;
  const album = {
    ...structuredClone(base),
    meta: { ...base.meta, id: ALBUM, title: "Songs of the Drowned Quarter", format: "video", medium: "music", kind },
    music: { version: 1, loudness: -14, tracks: [{ id: "harbour-bells", title: "Saltmouth Bells", source: { artifactId: BELLS }, takes: [], lyrics: "[verse]\nRing them low" }] },
    chapters: [], scenes: [], episodes: [], takes: [],
  };
  state.world!.productions = [...state.world!.productions, album] as never;
  state.world!.artifacts = [
    { ...state.world!.artifacts[0]!, mediaInfo: { durationSec: 222, hasAudio: true } },
    bench(SONG, "bell-rope-chant.mp3", "Bell rope chant, slow", "[verse]\nhaul on the ropes"),
    bench(TUNE, "harbour-reel.mp3", "Harbour reel", ""),
    { id: COVER, kind: "image", file: "cover.png", hash: "sha256:2222222222222222", origin: { by: "user" }, links: [], created: AT },
    // An audio drama's music cue, filed as its own production's: still the world's music.
    { id: CUE, kind: "audio", file: "bell-watch-cue.wav", hash: "sha256:3333333333333333", origin: { by: "system", producedBy: "sound" }, links: [], production: "saltlight", created: AT,
      generation: { source: "sound", productionId: "saltlight", name: "Bell watch cue", cue: "music", heard: "", prompt: "a bell watch cue", provider: "elevenlabs", model: "sound", outputFormat: "wav", estimatedMicroUsd: 0, costMicroUsd: null } },
  ] as never;
  return state;
}

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  dom.document.body.innerHTML = "";
});

async function mount(state: ClientState, entry: string) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root!.render(<MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:worldId/productions/new" element={<NewProductionScreen />} />
        <Route path="/w/:worldId/p/:prodId" element={<MusicAlbumScreen />} />
      </Routes>
    </MemoryRouter>);
  });
  const of = <K extends ClientMessage["kind"]>(kind: K) => sent.filter((m): m is Extract<ClientMessage, { kind: K }> => m.kind === kind);
  return { container, sent, of };
}
const buttons = (scope: ParentNode, label: string) => [...scope.querySelectorAll("button")].filter(b => b.textContent?.trim() === label);
async function press(element: Element | undefined, what: string) {
  assert.ok(element, `${what} is offered`);
  await act(async () => element.dispatchEvent(new dom.Event("click", { bubbles: true })));
}
const click = (scope: ParentNode, label: string) => press(buttons(scope, label)[0], label);
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    [...select.querySelectorAll("option")].find(option => option.value === value)!.selected = true;
    select.dispatchEvent(new dom.Event("change", { bubbles: true }));
  });
}
/** A field left, as React holds its handler. */
async function leave(el: HTMLInputElement) {
  await act(async () => {
    const key = Object.keys(el).find(candidate => candidate.startsWith("__reactProps$"))!;
    (el as unknown as Record<string, Record<string, (event: { target: typeof el; currentTarget: typeof el }) => void>>)[key]!["onBlur"]!({ target: el, currentTarget: el });
  });
}
/** A handler as React holds it: linkedom raises no input event React listens for. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    el.value = value;
    const key = Object.keys(el).find(candidate => candidate.startsWith("__reactProps$"))!;
    (el as unknown as Record<string, Record<string, (event: { target: typeof el; currentTarget: typeof el }) => void>>)[key]!["onChange"]!({ target: el, currentTarget: el });
  });
}

describe("the Listen door (238a, R-2)", () => {
  it("is the fourth card, Make music, for albums, singles and soundtracks, with its picture", () => {
    const listen = DOOR_CHOICES.find(d => d.id === "listen")!;
    assert.deepEqual([listen.eyebrow, listen.label, listen.body, listen.affordance, listen.medium], ["LISTEN", "Make music", "Album, single or soundtrack", "Begin with a song", "music"]);
    assert.equal(DOOR_CHOICES.indexOf(listen), 3);
    assert.ok(existsSync(fileURLToPath(new URL("../public/doors/listen.webp", import.meta.url))));
  });
});

describe("What kind of music? (238b, R-3)", () => {
  it("offers an Album, a Single and a Soundtrack, each with its plate", () => {
    assert.equal(KINDS_BY_DOOR.listen, MUSIC_KIND_CHOICES);
    assert.deepEqual(MUSIC_KIND_CHOICES.map(k => [k.label, k.body]), [["Album", "Tracks, in order."], ["Single", "One song."], ["Soundtrack", "For a production."]]);
    const plates = fileURLToPath(new URL("../public/video-kinds/", import.meta.url));
    for (const kind of MUSIC_KIND_CHOICES) {
      assert.ok(KIND_PLATES.has(kind.id) && existsSync(`${plates}${kind.id}.webp`), `${kind.id} has its plate`);
    }
  });

  it("makes an album by name, and a soundtrack only once it names the production it is for", async () => {
    const m = await mount(withMusic(), `/w/${FIXTURE_WORLD_ID}/productions/new`);
    await press([...m.container.querySelectorAll(".fy-door")].find(card => /Make music/.test(card.textContent ?? "")), "Make music");
    assert.match(m.container.textContent!, /What kind of music\?/);
    assert.match(m.container.querySelector(".fy-radio--on")!.textContent!, /Album/, "an album until another is chosen");
    await type(m.container.querySelector<HTMLInputElement>("#production-name")!, "Songs of the Drowned Quarter");
    await click(m.container, "Create production");
    assert.deepEqual(m.of("create-production").map(({ title, medium, productionKind }) => ({ title, medium, productionKind })), [{ title: "Songs of the Drowned Quarter", medium: "music", productionKind: "album" }]);

    const n = await mount(withMusic(), `/w/${FIXTURE_WORLD_ID}/productions/new`);
    await press([...n.container.querySelectorAll(".fy-door")].find(card => /Make music/.test(card.textContent ?? "")), "Make music");
    await press([...n.container.querySelectorAll(".fy-radio")].find(card => /Soundtrack/.test(card.textContent ?? "")), "Soundtrack");
    await type(n.container.querySelector<HTMLInputElement>("#production-name")!, "Saltlight — Soundtrack");
    const forSelect = n.container.querySelector<HTMLSelectElement>("select[aria-label='For']")!;
    assert.ok(forSelect, "a soundtrack asks For");
    assert.ok([...forSelect.options].some(option => option.textContent === "Saltlight · Video · 1 scene"), [...forSelect.options].map(o => o.textContent).join(" | "));
    assert.ok(![...forSelect.options].some(option => /Drowned Quarter/.test(option.textContent ?? "")), "music is never scored");
    assert.equal(buttons(n.container, "Create production")[0]!.disabled, true, "not until it names one");
    await choose(forSelect, "saltlight");
    await click(n.container, "Create production");
    assert.deepEqual(n.of("create-production").map(({ medium, productionKind, soundtrackFor }) => ({ medium, productionKind, soundtrackFor })), [{ medium: "music", productionKind: "soundtrack", soundtrackFor: "saltlight" }]);
  });
});

describe("an album's page (238c, R-5)", () => {
  const PAGE = `/w/${FIXTURE_WORLD_ID}/p/${ALBUM}`;

  it("shows its square cover's place, what it is, Play all and Export, and its tracks in order", async () => {
    const m = await mount(withMusic(), PAGE);
    const text = m.container.textContent!;
    assert.match(text, /Make cover/);
    assert.match(text, /1:1 · 1024 × 1024/);
    assert.match(text, /ALBUM · THE UNDERSONG/);
    assert.match(m.container.querySelector("[data-testid='music-total']")!.textContent!, /1 track · 3:42/);
    const rows = [...m.container.querySelectorAll("[data-testid='music-track']")];
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.textContent!, /1Saltmouth BellsFile · harbour-bells\.wav—3:42/);
    assert.ok(buttons(m.container, "Play all")[0] && buttons(m.container, "Export")[0]);
    assert.equal(buttons(m.container, "Sequence")[0]!.disabled, false);
    assert.deepEqual(m.of("read-music-heard-in").map(({ productionId }) => productionId), [ALBUM], "Heard in is asked for, never kept");
    assert.deepEqual(productionPages({ hasChapters: false, isEpisodic: false, isBranching: false, isMusic: true }), [["", "Tracks"], ["artifacts", "Artifacts"]]);
  });

  it("says where a track is heard once the coordinator has read it (R-14)", async () => {
    const m = await mount(withMusic(), PAGE);
    const ask = m.of("read-music-heard-in").at(-1)!;
    await act(async () => __applyEventForTest({ at: AT, type: "music.heard-in", worldId: FIXTURE_WORLD_ID, productionId: ALBUM, requestId: ask.requestId, tracks: { "harbour-bells": [{ production: "saltlight", productionTitle: "Saltlight", chapter: "cut", label: "Cut", at: 730_000, open: "/p/saltlight/cut" }] } } as DomainEvent));
    assert.match(m.container.querySelector("[data-testid='music-track'] .heard")!.textContent!, /Saltlight · Cut/);
  });

  it("asks where its tracks are heard again when a placement moves elsewhere (codex on PR 2189)", async () => {
    const state = withMusic();
    const m = await mount(state, PAGE);
    const before = m.of("read-music-heard-in").length;
    const moved = structuredClone(state);
    moved.world!.productions.find(p => p.meta.id === "saltlight")!.cut = { audio: [{ kind: "score", label: "Score", entries: [{ artifactId: BELLS, offsetSec: 12 }] }], overlays: [] } as never;
    await act(async () => __setStateForTest(moved, { connection: "open" }));
    assert.equal(m.of("read-music-heard-in").length, before + 1);
  });

  it("plays the album through the export's render (R-8)", async () => {
    const m = await mount(withMusic(), PAGE);
    await click(m.container, "Play all");
    assert.equal(m.of("render-music").length, 1);
    assert.equal(buttons(m.container, "Rendering…").length, 1);
  });
});

describe("whose theme a track is (238c, 238e, SPEC-059 R-35)", () => {
  const PAGE = `/w/${FIXTURE_WORLD_ID}/p/${ALBUM}`;
  const theme = { production: ALBUM, track: "harbour-bells" };

  it("says it on the track's row and in its panel, for the entries that are public", async () => {
    const state = withMusic();
    state.world!.guide = { schemaVersion: 1, characters: { "maren-kest": { public: true, theme } }, locations: { "the-vigil": { public: true, theme } }, factions: { "the-ebb-council": { public: false, theme } }, lore: {} };
    const m = await mount(state, PAGE);
    assert.equal(m.container.querySelector("[data-testid='music-track'] .fy-music__theme")?.textContent, "Maren Kest’s theme · +1");
    await press(m.container.querySelector("[data-testid='music-track'] .t") ?? undefined, "the track");
    assert.equal(m.container.querySelector("[data-testid='music-theme-of']")?.textContent, "Maren Kest · The Vigil");
  });

  it("says none where no public entry has it", async () => {
    const m = await mount(withMusic(), PAGE);
    assert.equal(m.container.querySelector("[data-testid='music-track'] .fy-music__theme"), null);
    await press(m.container.querySelector("[data-testid='music-track'] .t") ?? undefined, "the track");
    assert.equal(m.container.querySelector("[data-testid='music-theme-of']")?.textContent, "—");
  });
});

describe("Add track (238d, R-6)", () => {
  const PAGE = `/w/${FIXTURE_WORLD_ID}/p/${ALBUM}`;

  it("lists the world's kept music, says which is on the album, filters and adds the one chosen", async () => {
    const m = await mount(withMusic(), PAGE);
    await click(m.container, "Add track");
    const dialog = dom.document.body.querySelector(".fy-music-dlg")!;
    assert.ok(dialog, "Add track opens over the album");
    assert.match(dialog.textContent!, /Kept 3/);
    assert.match(dialog.textContent!, /Songs 1/);
    assert.match(dialog.textContent!, /Instrumental 2/);
    const tiles = () => [...dialog.querySelectorAll("[data-testid='music-take']")].map(tile => tile.textContent);
    // An audio drama's music cue is offered too, though another production filed it (codex on PR 2189).
    assert.deepEqual(tiles().map(t => t!.split(/Bench|Audio drama/)[0]), ["Bell rope chant", "Harbour reel", "Bell watch cue"]);
    await click(dialog, "Instrumental 2");
    assert.equal(tiles().length, 2);
    await click(dialog, "Kept 3");
    assert.match(dialog.textContent!, /Import a file/);
    assert.match(dialog.textContent!, /WAV · MP3 · M4A · FLAC/);
    await press(dialog.querySelector("[role='radio'][aria-label='Bell rope chant']") ?? undefined, "Bell rope chant");
    await click(dialog, "Add track");
    assert.deepEqual(m.of("music-track-add").map(({ artifactId, makeAlbum }) => [artifactId, makeAlbum]), [[SONG, undefined]]);
  });

  it("offers to make a Single an Album to add its second track (R-3)", async () => {
    const m = await mount(withMusic("single"), PAGE);
    await click(m.container, "Add track");
    await press(dom.document.body.querySelector("[role='radio'][aria-label='Harbour reel']") ?? undefined, "Harbour reel");
    await click(dom.document.body, "Make album · add track");
    assert.deepEqual(m.of("music-track-add").map(({ makeAlbum }) => makeAlbum), [true]);
  });
});

describe("a track open (238e, R-7)", () => {
  it("shows From, its lyrics with Draft with Arke, Heard in and Theme of, and removes it from the album", async () => {
    const m = await mount(withMusic(), `/w/${FIXTURE_WORLD_ID}/p/${ALBUM}`);
    await click(m.container, "Saltmouth Bells");
    const panel = m.container.querySelector("[data-testid='music-panel']")!;
    assert.ok(panel, "the track opens beside the album");
    const text = panel.textContent!;
    assert.match(text, /TRACK 1 · SONGS OF THE DROWNED QUARTER/);
    assert.match(text, /FromFile · harbour-bells\.wav/);
    const words = panel.querySelector<HTMLTextAreaElement>("textarea[aria-label='Lyrics']")!;
    // linkedom does not keep a controlled textarea's value: the value React holds is asserted.
    const held = (words as unknown as Record<string, { value: string }>)[Object.keys(words).find(key => key.startsWith("__reactProps$"))!]!.value;
    assert.equal(held, "[verse]\nRing them low");
    assert.match(text, /Heard in—/);
    assert.match(text, /Theme of—/);
    assert.equal(buttons(panel, "Edit")[0]!.disabled, false);
    await click(panel, "Draft with Arke");
    assert.equal(m.of("music-draft-lyrics")[0]!.trackId, "harbour-bells");
    await type(panel.querySelector<HTMLTextAreaElement>("textarea[aria-label='Lyrics']")!, "[chorus]\nHold the verse");
    await click(panel, "Save");
    assert.deepEqual(m.of("music-track-update").map(({ trackId, lyrics }) => [trackId, lyrics]), [["harbour-bells", "[chorus]\nHold the verse"]]);
    await click(panel, "Remove from album");
    assert.deepEqual(m.of("music-track-remove").map(({ trackId }) => trackId), ["harbour-bells"]);
  });
});

// Eleven Music as the manifest declares it: a length it keeps and an instrumental, $0.15 a minute.
const ELEVEN = {
  id: "music_v1", provider: "elevenlabs", capability: "music", displayName: "Eleven Music",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 300, audioFormat: "mp3", maxPromptChars: 2000, musicLength: "exact", musicInstrumental: true },
  pricing: { kind: "perSecond", microUsdPerSecond: 2500 },
};
// A route that treats its length as a ceiling and needs words, as MiniMax Music does.
const CEILING = { ...ELEVEN, id: "test-music", provider: "fal", displayName: "Test Music", limits: { maxDurationSec: 300 } };

function withRoute(state: ClientState, model: Record<string, unknown> = ELEVEN): ClientState {
  state.app.manifest = { ...state.app.manifest!, models: [...state.app.manifest!.models, model] } as never;
  state.app.providers = state.app.providers.map(provider => (provider.id === model["provider"]
    ? { ...provider, configured: true, validation: "valid", probes: [...provider.probes, { capability: "music", available: true }], lastValidated: AT }
    : provider)) as never;
  return state;
}

const SESSION = "sess_01J9M000000000000000000777";
const TAKE_ONE = "tk_01J9M000000000000000000701";
const TAKE_TWO = "tk_01J9M000000000000000000702";

describe("a track's composer and takes (238i, R-9, R-10)", () => {
  const PAGE = `/w/${FIXTURE_WORLD_ID}/p/${ALBUM}`;
  async function composer(state: ClientState) {
    const m = await mount(state, PAGE);
    await click(m.container, "Saltmouth Bells");
    const panel = m.container.querySelector("[data-testid='music-panel']")!;
    await click(panel, "Takes");
    return { ...m, panel };
  }

  it("asks the route's length, sends the style as the brief and prices Make at the Bench's quote", async () => {
    const m = await composer(withRoute(withMusic()));
    assert.ok(m.panel.classList.contains("fy-music-panel--wide"), "the composer is the wide panel");
    assert.ok(m.panel.querySelector("[data-testid='music-composer']"));
    assert.deepEqual(m.of("read-music-takes").map(({ productionId }) => productionId), [ALBUM]);
    assert.equal(m.panel.querySelector<HTMLSelectElement>("select[aria-label='Voice']")!.disabled, true, "no route declares a voice");
    assert.equal(m.panel.querySelector<HTMLSelectElement>("select[aria-label='Reference']")!.disabled, true);
    await type(m.panel.querySelector<HTMLInputElement>("input[aria-label='Style']")!, "Slow sea shanty, low strings, one voice");
    const length = m.panel.querySelector<HTMLInputElement>("input[aria-label='Length']")!;
    await type(length, "3:00");
    await leave(length);
    // Three takes at 3:00 on Eleven Music's $0.15 a minute.
    await click(m.panel, "Make 3 · $1.35");
    assert.deepEqual(m.of("music-track-make").map(({ trackId, composer: c }) => [trackId, c]), [["harbour-bells", {
      provider: "elevenlabs", model: "music_v1", brief: "Slow sea shanty, low strings, one voice",
      params: { kind: "music", count: 3, lyrics: "[verse]\nRing them low", lengthSec: 180 },
    }]]);
  });

  it("sends an instrumental with no words, and the route's flag", async () => {
    const m = await composer(withRoute(withMusic()));
    await type(m.panel.querySelector<HTMLInputElement>("input[aria-label='Style']")!, "Harbour reel");
    await click(m.panel, "Instrumental");
    await press(m.panel.querySelector("[data-testid='music-make']") ?? undefined, "Make");
    assert.deepEqual(m.of("music-track-make").map(({ composer: c }) => c.params), [{ kind: "music", count: 3, lyrics: "", lengthSec: 222, instrumental: true }]);
  });

  it("offers no length and no instrumental on a route that keeps neither", async () => {
    const m = await composer(withRoute(withMusic(), CEILING));
    assert.equal(m.panel.querySelector("input[aria-label='Length']"), null);
    assert.equal(buttons(m.panel, "Instrumental")[0]!.disabled, true);
    await type(m.panel.querySelector<HTMLInputElement>("input[aria-label='Style']")!, "Bell rope chant");
    await press(m.panel.querySelector("[data-testid='music-make']") ?? undefined, "Make");
    assert.deepEqual(m.of("music-track-make").map(({ composer: c }) => c.params), [{ kind: "music", count: 3, lyrics: "[verse]\nRing them low" }]);
  });

  it("shows the track's takes in a strip, and Choose makes one the track", async () => {
    const m = await composer(withRoute(withMusic()));
    const ask = m.of("read-music-takes").at(-1)!;
    await act(async () => __applyEventForTest({ at: AT, type: "music.takes", worldId: FIXTURE_WORLD_ID, productionId: ALBUM, requestId: ask.requestId, takes: [
      { trackId: "harbour-bells", sessionId: SESSION, takeId: TAKE_ONE, n: 1, status: "succeeded", file: `.sessions/${SESSION}/media/${TAKE_ONE}/take.mp3`, durationMs: 180_000, createdAt: AT },
      { trackId: "harbour-bells", sessionId: SESSION, takeId: TAKE_TWO, n: 2, status: "running", createdAt: AT },
      { trackId: null, sessionId: SESSION, takeId: "tk_01J9M000000000000000000703", n: 3, status: "succeeded", createdAt: AT },
    ] } as DomainEvent));
    const cards = [...m.panel.querySelectorAll("[data-testid='music-track-take']")];
    assert.deepEqual(cards.map(card => card.querySelector(".hd")!.textContent), ["Take 13:00", "Take 2"], "only this track's takes");
    assert.match(cards[1]!.textContent!, /Making…/);
    assert.equal(buttons(cards[1]!, "Choose").length, 0, "a take still being made is not chosen");
    await click(cards[0]!, "Choose");
    assert.deepEqual(m.of("music-track-choose").map(({ trackId, sessionId, takeId }) => [trackId, sessionId, takeId]), [["harbour-bells", SESSION, TAKE_ONE]]);
  });

  it("names the chosen take as From: Take n of m (238c)", async () => {
    const state = withMusic();
    const album = state.world!.productions.find(p => p.meta.id === ALBUM)!;
    album.music = { ...album.music!, tracks: [{ ...album.music!.tracks[0]!, source: { artifactId: SONG }, takes: [{ sessionId: SESSION, takeId: TAKE_ONE }, { sessionId: "bs_01J9M000000000000000000001", takeId: "bt_01J9M000000000000000000001" }] }] } as never;
    const m = await mount(state, PAGE);
    assert.match(m.container.querySelector("[data-testid='music-track'] .src")!.textContent!, /^Take 2 of 2$/);
  });
});

describe("the track editor (238j, R-11)", () => {
  it("trims, fades and marks sections over the take's waveform, and Save writes them with the track", async () => {
    const m = await mount(withMusic(), `/w/${FIXTURE_WORLD_ID}/p/${ALBUM}`);
    await click(m.container, "Saltmouth Bells");
    await click(m.container.querySelector("[data-testid='music-panel']")!, "Edit");
    const dialog = dom.document.body.querySelector("[data-testid='music-editor']")!.closest(".fy-music-dlg")!;
    assert.match(dialog.textContent!, /Track 1 · 3:42 · plays 3:42/);
    assert.match(dialog.querySelector("[data-testid='music-edit-loudness']")!.textContent!, /^−14 LUFS · album$/);
    assert.equal(buttons(dialog, "Extend")[0]!.disabled, true);
    assert.equal(buttons(dialog, "Remake section")[0]!.disabled, true);
    const wave = m.of("read-music-waveform").find(({ file }) => file === "artifacts/harbour-bells.wav")!;
    assert.ok(wave, "the waveform is read from the take");
    await act(async () => __applyEventForTest({ at: AT, type: "music.waveform", worldId: FIXTURE_WORLD_ID, requestId: wave.requestId, file: wave.file, waveform: { durationMs: 222_000, peaks: [0.1, 0.8, 0.4, 0.9] } } as DomainEvent));
    assert.equal(dialog.querySelector(".fy-music-ed__seed"), null, "the take's own peaks replace the drawn wave");

    const end = dialog.querySelector<HTMLInputElement>("input[aria-label='Trim end']")!;
    await type(end, "3:30");
    await leave(end);
    const fade = dialog.querySelector<HTMLInputElement>("input[aria-label='Fade in']")!;
    await type(fade, "2");
    await leave(fade);
    assert.match(dialog.textContent!, /plays 3:30/);
    // A section goes halfway through the longest stretch, named for the lyrics' first stanza.
    await click(dialog, "Section");
    const name = dialog.querySelector<HTMLInputElement>("input[aria-label='Section']")!;
    name.value = "Verse";
    await leave(name);
    assert.deepEqual([...dialog.querySelectorAll("[data-testid='music-section']")].map(section => section.textContent), ["Verse"]);
    assert.match(dialog.querySelector(".fy-music-ed__lines")!.textContent!, /Ring them low/, "the stanza sits under its section, its tag gone");
    await press(dialog.querySelector("[data-testid='music-edit-save']") ?? undefined, "Save");
    assert.deepEqual(m.of("music-track-edit").map(({ trackId, trim, fadeInMs, fadeOutMs, sections }) => ({ trackId, trim, fadeInMs, fadeOutMs, sections })), [{
      trackId: "harbour-bells", trim: { startMs: 0, endMs: 210_000 }, fadeInMs: 2000, fadeOutMs: 0, sections: [{ label: "Verse", atMs: 111_000 }],
    }]);
  });
});

describe("the album's sequence (238k, R-13)", () => {
  function twoTracks(): ClientState {
    const state = withMusic();
    const album = state.world!.productions.find(p => p.meta.id === ALBUM)!;
    album.music = { ...album.music!, tracks: [{ ...album.music!.tracks[0]!, next: { gapMs: 2000 } }, { id: "bell-rope", title: "Bell rope chant", source: { artifactId: SONG }, takes: [] }] } as never;
    return state;
  }

  it("shows the tracks in order with the join between them, and the total follows the gaps", async () => {
    const m = await mount(twoTracks(), `/w/${FIXTURE_WORLD_ID}/p/${ALBUM}`);
    assert.match(m.container.querySelector("[data-testid='music-total']")!.textContent!, /2 tracks · 5:36/, "3:42 and 1:52 with 2 s between");
    await click(m.container, "Sequence");
    assert.deepEqual([...m.container.querySelectorAll("[data-testid='music-seq-track']")].map(row => row.querySelector("b")!.textContent), ["Saltmouth Bells", "Bell rope chant"]);
    const joins = [...m.container.querySelectorAll("[data-testid='music-join']")];
    assert.equal(joins.length, 1, "a join between each pair, none after the last");
    assert.equal(joins[0]!.querySelector("[role='radio'][aria-checked='true']")!.textContent, "Gap");
    await click(joins[0]!, "Crossfade");
    assert.deepEqual(m.of("music-sequence-set").map(({ loudness, joins: sent }) => [loudness, sent]), [[-14, [{ trackId: "harbour-bells", next: { crossfadeMs: 2000 } }]]]);
    await choose(m.container.querySelector<HTMLSelectElement>("select[aria-label='Loudness']")!, "-16");
    assert.equal(m.of("music-sequence-set").at(-1)!.loudness, -16);
    await press(m.container.querySelector("[aria-label='Play through from Bell rope chant']") ?? undefined, "Play through");
    assert.equal(m.of("render-music").length, 1, "Play through is the album's render, played from that track");
  });

  it("is what the Export sheet's Sequence row says", async () => {
    const m = await mount(twoTracks(), `/w/${FIXTURE_WORLD_ID}/p/${ALBUM}`);
    await click(m.container, "Export");
    assert.match(dom.document.body.querySelector("[data-testid='music-export']")!.textContent!, /Sequence1 gap−14 LUFS/);
  });
});

describe("Make cover (238c, R-5)", () => {
  it("opens Bench at the cover's square, with the album's words", async () => {
    const m = await mount(withMusic(), `/w/${FIXTURE_WORLD_ID}/p/${ALBUM}`);
    await click(m.container, "Make cover");
    await press([...dom.document.body.querySelectorAll("a")].find(link => link.textContent === "Make in Bench"), "Make in Bench");
    const [opened] = m.of("bench-new-session");
    assert.equal(opened!.image!.aspect, "1:1");
    assert.match(opened!.image!.brief, /^Cover for Songs of the Drowned Quarter, album from The Undersong$/);
  });
});

describe("Export → Arke Player for music (238h, R-15)", () => {
  it("lists what the package holds and makes it as a package", async () => {
    const state = withMusic();
    const album = state.world!.productions.find(p => p.meta.id === ALBUM)!;
    album.music = { ...album.music!, cover: COVER };
    const m = await mount(state, `/w/${FIXTURE_WORLD_ID}/p/${ALBUM}`);
    await click(m.container, "Export");
    const sheet = dom.document.body.querySelector("[data-testid='music-export']")!;
    const text = sheet.textContent!;
    assert.match(text, /WorldThe Undersong/);
    assert.match(text, /Tracks1 · 3:42AAC · 256 kbps/);
    assert.match(text, /SequenceBack to back−14 LUFS/);
    assert.match(text, /Cover1:11024 × 1024/);
    assert.match(text, /Lyrics1 of 1 track/);
    await press(dom.document.body.querySelector("[data-testid='music-export-start']") ?? undefined, "Make package");
    assert.deepEqual(m.of("export-arke-player").map(({ productionId, options }) => [productionId, options]), [[ALBUM, { book: false, motion: false }]]);
  });
});

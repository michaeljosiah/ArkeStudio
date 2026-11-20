import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientMessage, ClientState, ProductionSpine, SongSectionsResult, SpineMarker } from "@arke-studio/contracts";
import { __applyEventForTest, __handleFrameForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { parseSongTime, sectionsCommand, songTimeText, wantsSections } from "../src/lib/song.js";
import { CutScreen } from "../src/screens/cut.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A song's sections, proposed (issue 3099). The author timed the song's verses in another program
 * because nothing in the Studio said where it changes. The Cut now asks the coordinator what it
 * measured of a song with no sections marked, offers it, lets a start be moved or dropped, and
 * marks them with one spine command. Nothing is marked before the press.
 */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { innerWidth: 1024, innerHeight: 768, matchMedia: (media: string) => ({ matches: false, media }) });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

const SONG = "ar_01J8G0000000000000000000R1";
const OTHER = "ar_01J8G0000000000000000000R9";
const LYRIC: SpineMarker = { kind: "lyric", id: "mk_01J8G0000000000000000000L1", text: "Why you do me like that", atSec: 44.75, source: "lrc" };
const SECTION: SpineMarker = { kind: "section", id: "mk_01J8G0000000000000000000S1", label: "Intro", atSec: 0, source: "manual" };

function spineOn(trackArtifactId: string, revision = 1, markers: SpineMarker[] = []): ProductionSpine {
  return { schemaVersion: 1, revision, trackArtifactId, markers, anchors: {}, updatedAt: "2026-11-15T09:00:00.000Z" };
}

function musicVideo(spine: ProductionSpine | null): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.meta.kind = "music-video";
  production.scenes = [];
  production.spine = spine;
  const song = { ...state.world!.artifacts[0]!, mediaInfo: { durationSec: 227.6, hasAudio: true } };
  state.world!.artifacts = [song, { ...song, id: OTHER, file: "second-take.wav", hash: "sha256:9999999999999999" }];
  return state;
}

const measured = (startsSec: number[], trackArtifactId = SONG): SongSectionsResult =>
  ({ status: "measured", song: { trackArtifactId, durationSec: 227.6, tempoBpm: 100, startsSec } });

describe("the sections' logic (issue 3099)", () => {
  it("offers sections only to a song with none marked", () => {
    assert.equal(wantsSections(null), false);
    assert.equal(wantsSections(spineOn(SONG)), true);
    assert.equal(wantsSections(spineOn(SONG, 2, [LYRIC])), true, "lyrics are not sections");
    assert.equal(wantsSections(spineOn(SONG, 2, [SECTION])), false, "nothing is proposed over a person's own marks");
  });

  it("marks them in the song's order by number, at the revision shown, and keeps the lyrics", () => {
    let minted = 0;
    const next = sectionsCommand(spineOn(SONG, 4, [LYRIC]), [42.7, 0, 22.9], () => `mk_01J8G00000000000000000000${++minted}`);
    assert.equal(next.baseRevision, 4);
    assert.ok(next.command.kind === "import-markers" && next.command.format === "json");
    assert.deepEqual(next.command.markers.filter((marker) => marker.kind === "section").map((marker) => [marker.label, marker.atSec, marker.source]),
      [["Section 1", 0, "json"], ["Section 2", 22.9, "json"], ["Section 3", 42.7, "json"]]);
    // An import replaces sections and lyrics both, so the lyric sheet rides with it: same id, words and time.
    assert.deepEqual(next.command.markers.filter((marker) => marker.kind === "lyric"), [{ ...LYRIC, source: "json" }]);
  });

  it("reads a time as it is shown", () => {
    assert.equal(parseSongTime("0:42"), 42);
    assert.equal(parseSongTime(" 1:01.5 "), 61.5);
    assert.equal(parseSongTime("12:00"), 720);
    for (const text of ["", "42", "0:60", "1:5", "a:10", "0:42.", "-0:10"]) assert.equal(parseSongTime(text), null, text);
  });

  it("shows a time on the song's clock, as a spine card reads it", () => {
    // The coordinator's songTime, case for case: one notation for a time in a song.
    assert.equal(songTimeText(0), "0:00");
    assert.equal(songTimeText(16.5), "0:16.5");
    assert.equal(songTimeText(62.25), "1:02.25");
    assert.equal(songTimeText(22.424), "0:22.424");
    assert.equal(songTimeText(227.639979), "3:47.64");
    assert.equal(songTimeText(3_600), "60:00");
  });

  // The field read 0:22 for a start at 22.9, so what was typed was not what was marked (codex on PR 3134).
  it("reads back the time it shows, to the millisecond, for every start a song can have", () => {
    for (const sec of [0, 22.9, 42.7, 61.9, 99.7, 124.3, 184.3, 201.7, 1.118, 22.424, 59.999, 61.905, 599.001]) {
      assert.equal(parseSongTime(songTimeText(sec)), sec, songTimeText(sec));
    }
    // Every millisecond of four minutes, as the finder gives a start: rounded to the millisecond.
    for (let ms = 0; ms < 240_000; ms++) {
      const sec = ms / 1000;
      if (parseSongTime(songTimeText(sec)) !== sec) assert.fail(`${songTimeText(sec)} read back as ${parseSongTime(songTimeText(sec))}`);
    }
  });
});

let seq = 2_000;
function snapshot(state: ClientState): void {
  __handleFrameForTest({ kind: "snapshot", seq: ++seq, state });
}

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
  const button = (text: string) => [...(notice()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent?.trim() === text);
  const labelled = <T extends Element>(label: string) => notice()?.querySelector<T>(`[aria-label='${label}']`) ?? null;
  const asks = () => sent.filter((message): message is Extract<ClientMessage, { kind: "song-sections" }> => message.kind === "song-sections");
  const commands = () => sent.filter((message): message is Extract<ClientMessage, { kind: "spine-command" }> => message.kind === "spine-command");
  /** The coordinator's answer to the latest ask. */
  const answer = async (result: SongSectionsResult) => {
    const ask = asks().at(-1)!;
    await act(async () => __applyEventForTest({ type: "song.sections", at: "2026-11-15T09:00:01.000Z", worldId: ask.worldId, productionId: ask.productionId, requestId: ask.requestId, result }));
  };
  /** A change as React hears it: linkedom raises no input event React listens for. */
  const type = async (field: HTMLInputElement, value: string) => {
    await act(async () => {
      const key = Object.keys(field).find((candidate) => candidate.startsWith("__reactProps$"));
      const props = key === undefined ? undefined : (field as unknown as Record<string, { onChange?: (event: { target: { value: string } }) => void }>)[key];
      props?.onChange?.({ target: { value } });
    });
  };
  return { container, sent, notice, button, labelled, asks, commands, answer, type,
    async close() { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(window, "arke"); __setBridgeForTest(null); } };
}

describe("the Cut proposes the song's sections (issue 3099)", () => {
  it("asks what was measured, offers it, and marks it with one spine command", async () => {
    const screen = await mountCut(musicVideo(spineOn(SONG)));
    try {
      assert.equal(screen.asks().length, 1, "asked once for a song with no sections");
      assert.equal(screen.notice(), null, "nothing is offered before the answer");
      await screen.answer(measured([0, 22.9, 42.7]));
      assert.match(screen.notice()!.textContent ?? "", /3 sections found\./);
      assert.match(screen.notice()!.textContent ?? "", /0:00 · 0:22 · 0:42/);
      assert.doesNotMatch(screen.notice()!.textContent ?? "", /verse|chorus/i);
      assert.equal(screen.commands().length, 0, "a proposal marks nothing");

      await act(async () => screen.button("Mark 3 sections")!.click());
      const sent = screen.commands();
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.baseRevision, 1);
      assert.ok(sent[0]!.command.kind === "import-markers" && sent[0]!.command.format === "json");
      assert.deepEqual(sent[0]!.command.markers.map((marker) => marker.kind === "section" ? [marker.label, marker.atSec] : null),
        [["Section 1", 0], ["Section 2", 22.9], ["Section 3", 42.7]]);
      assert.ok(sent[0]!.command.markers.every((marker) => /^mk_[0-9A-HJKMNP-TV-Z]{26}$/.test(marker.id)));
      assert.equal(screen.button("Mark 3 sections")!.disabled, true, "held until the spine answers");

      // The snapshot that carries the sections ends the offer.
      await act(async () => snapshot(musicVideo(spineOn(SONG, 2, sent[0]!.command.kind === "import-markers" ? sent[0]!.command.markers : []))));
      assert.equal(screen.notice(), null);
      assert.equal(screen.asks().length, 1, "a song with sections is not measured again");
    } finally { await screen.close(); }
  });

  it("lets a start be moved or dropped before it is marked", async () => {
    const screen = await mountCut(musicVideo(spineOn(SONG, 3, [LYRIC])));
    try {
      await screen.answer(measured([0, 22.9, 42.7, 61.9]));
      await act(async () => screen.button("Change")!.click());
      assert.equal(screen.labelled("Section 1 starts"), null, "a song starts with its first section");
      // To the tenth: the field reads what will be marked, so a second typed is a second moved.
      assert.equal(screen.labelled<HTMLInputElement>("Section 2 starts")!.getAttribute("value"), "0:22.9");
      assert.equal(screen.labelled<HTMLInputElement>("Section 4 starts")!.getAttribute("value"), "1:01.9");
      await screen.type(screen.labelled<HTMLInputElement>("Section 2 starts")!, "0:16");
      await act(async () => screen.labelled<HTMLButtonElement>("Remove Section 4")!.click());
      assert.match(screen.notice()!.textContent ?? "", /3 sections found\./);

      // A time that is not one, or is past the end of the song, cannot be marked.
      await screen.type(screen.labelled<HTMLInputElement>("Section 3 starts")!, "0:4");
      assert.equal(screen.labelled("Section 3 starts")!.getAttribute("aria-invalid"), "true");
      assert.equal(screen.button("Mark 3 sections")!.disabled, true);
      await screen.type(screen.labelled<HTMLInputElement>("Section 3 starts")!, "4:10");
      assert.equal(screen.button("Mark 3 sections")!.disabled, true, "4:10 is past a 3:47 song");
      await screen.type(screen.labelled<HTMLInputElement>("Section 3 starts")!, "0:16");
      assert.equal(screen.button("Mark 3 sections")!.disabled, true, "two sections cannot start at one time");
      await screen.type(screen.labelled<HTMLInputElement>("Section 3 starts")!, "0:44.5");
      assert.equal(screen.button("Mark 3 sections")!.disabled, false);

      await act(async () => screen.button("Mark 3 sections")!.click());
      const command = screen.commands()[0]!;
      assert.equal(command.baseRevision, 3);
      assert.ok(command.command.kind === "import-markers");
      assert.deepEqual(command.command.markers.filter((marker) => marker.kind === "section").map((marker) => marker.atSec), [0, 16, 44.5]);
      assert.deepEqual(command.command.markers.filter((marker) => marker.kind === "lyric"), [{ ...LYRIC, source: "json" }], "the lyrics stay");
    } finally { await screen.close(); }
  });

  // A start off the tenth is shown whole and kept whole: nothing a person did not type moves.
  it("shows a start to the millisecond and marks what the field reads", async () => {
    const screen = await mountCut(musicVideo(spineOn(SONG)));
    try {
      await screen.answer(measured([0, 22.424, 61.905, 99.7]));
      assert.match(screen.notice()!.textContent ?? "", /0:00 · 0:22 · 1:01 · 1:39/, "the line of times stays in whole seconds");
      await act(async () => screen.button("Change")!.click());
      const field = (name: string) => screen.labelled<HTMLInputElement>(name)!;
      assert.equal(field("Section 2 starts").getAttribute("value"), "0:22.424");
      assert.equal(field("Section 3 starts").getAttribute("value"), "1:01.905");
      assert.equal(field("Section 4 starts").getAttribute("value"), "1:39.7");
      // A second typed is a second moved: 0:23 is 23, not a tenth past where it stood.
      await screen.type(field("Section 2 starts"), "0:23");
      // Typed back as it was shown, a start is where it was.
      await screen.type(field("Section 3 starts"), "1:02");
      await screen.type(field("Section 3 starts"), "1:01.905");
      await act(async () => screen.button("Mark 4 sections")!.click());
      const command = screen.commands()[0]!;
      assert.ok(command.command.kind === "import-markers");
      assert.deepEqual(command.command.markers.map((marker) => marker.atSec), [0, 23, 61.905, 99.7]);
    } finally { await screen.close(); }
  });

  it("offers nothing it was not given: no song, sections already marked, or a song that could not be measured", async () => {
    const none = await mountCut(musicVideo(null));
    try { assert.equal(none.asks().length, 0); assert.equal(none.notice(), null); } finally { await none.close(); }

    const marked = await mountCut(musicVideo(spineOn(SONG, 2, [SECTION])));
    try { assert.equal(marked.asks().length, 0, "nothing is proposed over a person's own marks"); } finally { await marked.close(); }

    const unmeasured = await mountCut(musicVideo(spineOn(SONG)));
    try {
      await unmeasured.answer({ status: "unavailable", reason: "Audio analysis is unavailable on this host." });
      assert.equal(unmeasured.notice(), null);
    } finally { await unmeasured.close(); }

    // One section is the whole song: there is nothing to mark.
    const steady = await mountCut(musicVideo(spineOn(SONG)));
    try { await steady.answer(measured([0])); assert.equal(steady.notice(), null); } finally { await steady.close(); }
  });

  it("asks again for a new song and drops the old song's answer", async () => {
    const screen = await mountCut(musicVideo(spineOn(SONG)));
    try {
      await screen.answer(measured([0, 22.9]));
      assert.ok(screen.notice());
      await act(async () => snapshot(musicVideo(spineOn(OTHER, 2))));
      assert.equal(screen.notice(), null, "the first song's sections are not the second's");
      assert.equal(screen.asks().length, 2);
      await screen.answer(measured([0, 30, 60], OTHER));
      assert.match(screen.notice()!.textContent ?? "", /3 sections found\./);
    } finally { await screen.close(); }
  });

  it("hides when asked", async () => {
    const screen = await mountCut(musicVideo(spineOn(SONG)));
    try {
      await screen.answer(measured([0, 22.9]));
      await act(async () => screen.labelled<HTMLButtonElement>("Hide")!.click());
      assert.equal(screen.notice(), null);
      assert.equal(screen.commands().length, 0);
    } finally { await screen.close(); }
  });
});

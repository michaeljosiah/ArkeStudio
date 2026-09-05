import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  ClientStateSchema,
  applyTimelineCommands,
  deriveCut,
  seedEmptyPictureTimeline,
  seedStoryPictureTimeline,
  type ClientState,
} from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { CutScreen } from "../src/screens/production.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * The Cut on the song clock (80a). The fixture production is a short film with no spine — the
 * story-clock path #253 must leave alone — so the spine is added here rather than to the shared
 * fixture, which ~16 other files assert against.
 */

const TRACK = "ar_01J8G0000000000000000000T1";
const CLIP = "tk_01J8F0000000000000000000B2";
const BELLS = "ar_01J8G0000000000000000000R1";
const AT = "2026-07-30T18:22:00Z";
const HASH = `sha256:${"a".repeat(64)}`;

/*
 * Two renderers. The screen's structure and copy are read off a server render, as they always
 * were. Nothing opens selected any more (SPEC-039 R-25a), so a test that inspects a selected
 * clip mounts the screen under linkedom and clicks the clip first — the click is the only way a
 * person reaches a clip's details, and the only way the test can.
 */
const dom = parseHTML("<!doctype html><html><body></body></html>");
// With a window present, a dependency of the shell reads the writing direction on render, and
// linkedom computes no styles; the server render never asked.
Object.assign(dom.window, {
  matchMedia: (query: string) => ({ matches: false, media: query }),
  getComputedStyle: () => ({ direction: "ltr" }),
});
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

/** 60s of song, one 8s anchor on sh_12, and 12s of measured material behind it. */
function spineState(): ClientState {
  const base = structuredClone(FIXTURE_STATE) as ClientState;
  const world = base.world!;
  world.artifacts = [
    ...world.artifacts,
    {
      id: TRACK,
      kind: "audio",
      file: "forgive-me.mp3",
      hash: "sha256:6a1e02b9c44d7f32",
      origin: { by: "user" },
      links: [],
      created: "2026-06-11T10:00:00Z",
      mediaInfo: { durationSec: 60, hasAudio: true },
    } as (typeof world.artifacts)[number],
  ];
  const production = world.productions[0]!;
  production.spine = {
    schemaVersion: 1,
    revision: 1,
    trackArtifactId: TRACK,
    markers: [],
    anchors: { sh_12: { startSec: 10, endSec: 18, clipAudio: { mode: "mute" } } },
    updatedAt: AT,
  } as typeof production.spine;
  production.takeMediaInfo = {
    [CLIP]: { sourceHash: HASH, mediaInfo: { durationSec: 12, hasAudio: true }, probedAt: AT },
  } as typeof production.takeMediaInfo;
  return ClientStateSchema.parse(base);
}

/**
 * The story's shots on a saved timeline. The editor opens empty (SPEC-039 §1.9), so a story
 * clip only ever exists on a saved record; this is the state a story production is cut in.
 */
function storyTimelineState(base: ClientState = structuredClone(FIXTURE_STATE) as ClientState): ClientState {
  const production = base.world!.productions[0]!;
  production.timeline = { status: "ready", timeline: seedStoryPictureTimeline(production) };
  return base;
}

/** A one-frame trim exposes the runtime fraction; the duplicate must not invent another shot. */
function editedStoryTimelineState(): ClientState {
  const state = storyTimelineState();
  const production = state.world!.productions[0]!;
  const saved = production.timeline;
  assert.ok(saved && saved.status === "ready");
  production.timeline = {
    status: "ready",
    timeline: applyTimelineCommands(saved.timeline, [
      { kind: "trim", clipId: "cl_sh-13", edge: "end", deltaFrames: -1 },
      { kind: "duplicate", clipId: "cl_sh-12", newClipId: "cl_again" },
    ]),
  };
  return state;
}

/**
 * React's server renderer separates adjacent text expressions with an empty comment, so
 * `budget {n}s` arrives as `budget <!-- -->8.0<!-- -->s` and every copy assertion misses for a
 * reason that has nothing to do with the screen. They are stripped once, here.
 */
function renderCut(state: ClientState): string {
  __setStateForTest(state);
  const production = state.world!.productions[0]!;
  const html = renderToString(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/${production.meta.id}/cut`]}>
      <App />
    </MemoryRouter>,
  );
  return html.replaceAll("<!-- -->", "");
}

interface MountedCut {
  container: HTMLElement;
  root: Root;
}

async function mountCut(state: ClientState): Promise<MountedCut> {
  __setBridgeForTest({
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: () => {},
  } as unknown as NonNullable<Window["arke"]>);
  __setStateForTest(state);
  const production = state.world!.productions[0]!;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/${production.meta.id}/cut`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

async function close(screen: MountedCut): Promise<void> {
  await act(async () => screen.root.unmount());
  screen.container.remove();
}

/** Click a clip and hand back the Inspector, the way a person reaches a clip's details. */
async function select(screen: MountedCut, selector: string): Promise<HTMLElement> {
  const clip = screen.container.querySelector<HTMLElement>(selector);
  assert.ok(clip, `${selector} is on the timeline`);
  await act(async () => clip.click());
  const inspector = screen.container.querySelector<HTMLElement>("#cut-inspector-panel");
  assert.ok(inspector, "the Inspector is rendered");
  return inspector;
}

/** The figure an Inspector row states, by its label; null when the row is not there. */
function row(inspector: HTMLElement, label: string): string | null {
  const found = [...inspector.querySelectorAll<HTMLElement>(".fy-cutinspect__row")].find(
    (candidate) => candidate.querySelector("span")?.textContent === label,
  );
  return found?.querySelector("strong")?.textContent ?? null;
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("the Cut on the song clock (80a)", () => {
  it("lays the track out by position, with black for the time no anchor claims", () => {
    const html = renderCut(spineState());
    // 10s before the anchor and 42s after it: both are true statements about where the work is,
    // and a cut that quietly ran 52s short is the one nobody notices next to the song.
    assert.match(html, /fy-cutseg--black/, "uncovered time is drawn, not omitted");
    assert.match(html, /2 black · 52s uncovered/, "and counted in the footer");
    assert.match(html, /cut to the track/, "the header states which clock this is");
  });

  it("offers exactly one authored edit on a selected anchor", async () => {
    const screen = await mountCut(spineState());
    try {
      // Nothing opens selected (SPEC-039 R-25a): the strip appears once an anchor is clicked.
      assert.ok(screen.container.querySelector(".fy-cutsel") === null, "no strip before a selection");
      const inspector = await select(screen, ".fy-cutseg--pick");
      const html = screen.container.innerHTML;
      assert.ok(inspector.querySelector(".fy-cutsel"), "the selected-clip strip is present");
      assert.match(html, /TRIM IN/);
      assert.match(html, /budget 8\.0s/, "the anchor's window, not the take's length");
      assert.match(html, /0\.0s/, "the in-point starts at zero");
      /*
       * The derived picture still offers trim and nothing else: no reorder and no ripple, because
       * the cut follows the story rather than drag order (R-14). Lanes did not change that — what
       * a person may drag and split is a clip they placed, which is never a shot.
       */
      assert.doesNotMatch(html, /reorder|Ripple/i);
      assert.doesNotMatch(html, /fy-cutseg--pick[^>]*draggable/, "a shot is not draggable");
    } finally {
      await close(screen);
    }
  });

  it("shows the in-point a selection already carries", async () => {
    const state = spineState();
    state.world!.productions[0]!.selections["sh_12"]!.trimInSec = 2.5;
    const screen = await mountCut(state);
    try {
      const inspector = await select(screen, ".fy-cutseg--pick");
      assert.match(inspector.innerHTML, /2\.5s/, "the stored trim is what the control reads");
    } finally {
      await close(screen);
    }
  });

  it("puts a production with no spine on the story clock, and authors the clip's timing there (81a)", async () => {
    const screen = await mountCut(storyTimelineState());
    try {
      const html = screen.container.innerHTML;
      assert.match(html, /saved timeline/, "the header names the saved record (2026-09-02)");
      assert.doesNotMatch(html, /fy-cutseg--black/, "black belongs to the song clock");
      // The scene keeps its grouping in the band; the lane carries the unit of work.
      assert.doesNotMatch(html, /fy-scenes__band/, "scene labels start hidden");
      await act(async () => [...screen.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Scene labels")!.click());
      assert.ok(screen.container.querySelector(".fy-scenes__band"), "scene context remains available on request");
      assert.match(html, /fy-cutseg--pick/, "and shots, not scenes, are the cells");
      /*
       * The story clock's strip authored a trim on the unsaved assembly. The editor opens empty
       * now (SPEC-039 §1.9), so a story clip only ever sits on a saved record — and there the
       * Inspector authors the clip's own in and out points by the frame, on the same panel the
       * song clock's strip appears in. The same door; a finer unit.
       */
      const inspector = await select(screen, "[data-clip='cl_sh-12']");
      assert.equal(inspector.querySelector(".fy-cutinspect__eyebrow")?.textContent, "PICTURE CLIP");
      assert.ok(inspector.querySelector("[aria-label='In one frame later']"), "the in point steps by the frame");
      assert.ok(inspector.querySelector(".fy-cutsel") === null, "the unsaved strip has nothing to author on a saved record");
    } finally {
      await close(screen);
    }
  });

  it("states the slot on this clock, and says nothing about a take nobody measured", async () => {
    // The fixture carries no takeMediaInfo: absent is "not measured", never "measured zero", so
    // the Inspector simply omits the take's length rather than printing a figure it does not have.
    const screen = await mountCut(storyTimelineState());
    try {
      const inspector = await select(screen, "[data-clip='cl_sh-12']");
      assert.equal(row(inspector, "Shot length"), "4.0s", "the authored duration is the slot");
      assert.ok(row(inspector, "Take length") === null, "no length claimed for unmeasured material");
      assert.doesNotMatch(inspector.textContent ?? "", /budget|Window/, "budget is the song clock's word, not this one's");
    } finally {
      await close(screen);
    }
  });

  it("adds the take's length once something has measured it", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    state.world!.productions[0]!.takeMediaInfo = {
      [CLIP]: { sourceHash: HASH, mediaInfo: { durationSec: 6, hasAudio: true }, probedAt: AT },
    } as NonNullable<ClientState["world"]>["productions"][number]["takeMediaInfo"];
    const screen = await mountCut(storyTimelineState(ClientStateSchema.parse(state)));
    try {
      const inspector = await select(screen, "[data-clip='cl_sh-12']");
      assert.equal(row(inspector, "Shot length"), "4.0s", "the slot");
      assert.equal(row(inspector, "Take length"), "6.0s", "then the material that must fill it");
    } finally {
      await close(screen);
    }
  });
});
describe("the artifact panel and the overlay lane (82a)", () => {
  it("folds the production rail to marks, keeping every destination", () => {
    const html = renderCut(structuredClone(FIXTURE_STATE) as ClientState);
    assert.match(html, /fy-prodrail--folded/, "the rail folds on the cut");
    assert.match(html, /fy-prodrail__mark/, "and carries marks instead of words");
    for (const place of ["Dashboard", "Cast", "Scenes", "Exports"]) {
      assert.ok(html.includes(`title="${place}"`), `${place} is still reachable, by name on its tooltip`);
    }
  });

  it("opens the world's artifacts beside the cut", () => {
    // The Library lists what the record holds (SPEC-039 R-8, amended 2026-09-02), so the
    // fixture's one artifact is added to it first: the world's files are not the Library.
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.timeline = {
      status: "ready",
      timeline: applyTimelineCommands(seedEmptyPictureTimeline(production), [
        { kind: "add-to-library", items: [{ kind: "artifact", artifactId: BELLS }] },
      ]),
    };
    const html = renderCut(state);
    assert.match(html, /fy-artpanel/);
    assert.match(html, /harbour-bells\.wav/, "the fixture world's one artifact");
    assert.match(html, /draggable="true"/, "rows are drag sources");
    assert.match(html, /drag onto a lane to place/);
    // Upload is live now: the host opens the picker and the renderer never sees the bytes.
    assert.match(html, /Import to Library/);
    assert.doesNotMatch(html, /Filing arrives with/, "no longer a promise of a later screen");
  });

  it("draws no legacy lane until something legacy is placed; the typed tracks are the drop targets", () => {
    // The target timeline has no numbered overlay lanes (SPEC-039 R-19c). A lane that is not
    // there cannot be dropped on, so the typed tracks take the drop instead.
    const html = renderCut(structuredClone(FIXTURE_STATE) as ClientState);
    assert.doesNotMatch(html, /fy-ovlane/);
    assert.doesNotMatch(html, /data-track="(?:music|dialogue|ambience)"/, "empty role lanes are absent");
    assert.match(html, /Add audio track/);
  });

  it("draws a lane for the highest one a clip actually uses", () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.cut = {
      audio: [],
      overlays: [
        { id: "ov_01J8G0000000000000000000A1", artifactId: BELLS, startSec: 1, endSec: 3, lane: 4, audio: "keep" },
      ],
    } as typeof production.cut;
    const html = renderCut(ClientStateSchema.parse(state));
    assert.equal(
      (html.match(/fy-track__label">Overlay L\d/g) ?? []).length,
      5,
      "L4 down to L0, so nothing is hidden",
    );
  });

  it("counts what was placed, not what a split filed", () => {
    /*
     * Splitting on a lane files a second record over the same file. Counting both reports two
     * clips for one piece of media the person dropped once and still sees as one run. The
     * header counts the timeline record wherever one stands in for the lanes — which is every
     * story production, since the editor opens on an empty one — so the lanes are counted only
     * where they are still the editor: a song not yet opened on the timeline.
     */
    const state = spineState();
    const production = state.world!.productions[0]!;
    production.cut = {
      audio: [],
      overlays: [
        { id: "ov_01J8G0000000000000000000A1", artifactId: BELLS, startSec: 1, endSec: 3, lane: 1, audio: "mute" },
        { id: "ov_01J8G0000000000000000000A2", artifactId: BELLS, startSec: 1, endSec: 3, lane: 0, audio: "only" },
      ],
    } as typeof production.cut;
    const html = renderCut(ClientStateSchema.parse(state));
    assert.match(html, /1 clip/);
    assert.doesNotMatch(html, /2 clips/);
  });

  it("pluralises the count, because two clips are not 2 clip", () => {
    // Two shots on the saved timeline: the header counts what the record holds, on every track.
    assert.match(renderCut(storyTimelineState()), /2 clips/);
  });

  it("rounds the saved runtime and counts shots rather than clips (#707)", () => {
    const html = renderCut(editedStoryTimelineState());
    assert.match(html, /14s · 1 of 2 shots covered · saved timeline/);
    assert.match(html, /1 of 2 shots placed/);
    assert.match(html, /fy-prodrail__label">Cut<\/span><span class="fy-prodrail__count">14s/);
    assert.doesNotMatch(html, /13\.958333333333/);
    assert.doesNotMatch(html, /2 of 3 shots/);
  });

  it("marks the sound half of a split, and lays no picture for it", () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.cut = {
      audio: [],
      overlays: [
        { id: "ov_01J8G0000000000000000000A1", artifactId: BELLS, startSec: 1, endSec: 3, lane: 0, audio: "only" },
      ],
    } as typeof production.cut;
    const html = renderCut(ClientStateSchema.parse(state));
    assert.match(html, /fy-ovclip--sound/, "the sound half reads as sound");
    assert.match(html, /sound only/, "and says so where a person can read it");
  });

  it("places a filed artifact by its own window, and counts it apart from coverage", () => {
    // The bells at 2s→6s on a Music track under the story's two shots: the record's placement,
    // not a lane's (R-19c). One shot has an accepted take and the other has none.
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.timeline = {
      status: "ready",
      timeline: applyTimelineCommands(seedStoryPictureTimeline(production), [
        { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
        {
          kind: "place",
          trackId: "tr_music",
          clip: { id: "cl_bells", startFrame: 48, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "harbour-bells.wav" } },
        },
      ]),
    };
    const html = renderCut(state);
    assert.match(html, /fy-typedclip/, "the placement is drawn");
    assert.match(html, /harbour-bells\.wav, 00:00:02:00 to 00:00:06:00/, "by its own window");
    // A placed artifact is never coverage: it is counted as a clip, and the shot count is untouched.
    assert.match(html, /3 clips/, "two shots and the bells");
    assert.match(html, /1 of 2 shots covered/);
    assert.doesNotMatch(html, /2 of 2 shots/, "placing sound under the picture covers no shot");
  });
});

/**
 * The footer of a production with no story (issue 504).
 *
 * Issue 453 asked that the Cut present no coverage or gap language for a production that never had a
 * story. The header honoured it and the footer did not, so the two disagreed: "no story · what
 * you place is the film" above a line reading "0 of 0 shots placed · 0 gaps".
 */
const IMPORT = "ar_01J8G0000000000000000000V1";

/** No scenes, and two imported clips with eight seconds of black between them. */
function mediaOnlyState(): ClientState {
  const base = structuredClone(FIXTURE_STATE) as ClientState;
  const world = base.world!;
  world.artifacts = [
    ...world.artifacts,
    {
      id: IMPORT,
      kind: "video",
      file: "plate.mp4",
      hash: "sha256:6a1e02b9c44d7f33",
      origin: { by: "user" },
      links: [],
      created: "2026-06-11T10:00:00Z",
      mediaInfo: { durationSec: 4, hasAudio: false },
    } as (typeof world.artifacts)[number],
  ];
  const production = world.productions[0]!;
  production.scenes = [];
  production.takes = [];
  production.chapters = [];
  production.selections = {} as typeof production.selections;
  production.cut = {
    audio: [],
    overlays: [
      { id: "ov_01J8G0000000000000000000A1", artifactId: IMPORT, startSec: 0, endSec: 4, lane: 1, audio: "keep" },
      { id: "ov_01J8G0000000000000000000A2", artifactId: IMPORT, startSec: 12, endSec: 16, lane: 1, audio: "keep" },
    ],
  } as typeof production.cut;
  return ClientStateSchema.parse(base);
}

describe("the unified editor shell (#685)", () => {
  it("composes the real Library, centre and accessible right tabs around one timeline", () => {
    // The Library lists what the record holds (R-8, amended 2026-09-02), so the shot is added to it first.
    const state = storyTimelineState();
    const saved = state.world!.productions[0]!.timeline;
    assert.ok(saved && saved.status === "ready");
    state.world!.productions[0]!.timeline = {
      status: "ready",
      timeline: applyTimelineCommands(saved.timeline, [{ kind: "add-to-library", items: [{ kind: "shot", shotId: "sh_12" }] }]),
    };
    const html = renderCut(state);
    const document = parseHTML(`<main>${html}</main>`).document;
    const editor = document.querySelector<HTMLElement>("[data-screen='cut']");
    assert.ok(editor, "the Cut editor renders");
    assert.ok(editor.classList.contains("fy-cutcols"), "the editor owns the three panes beside the icon rail");
    assert.equal(editor.querySelector(".fy-artpanel__title")?.textContent, "Library");
    assert.equal(
      editor.querySelector<HTMLInputElement>("input[type='search']")?.placeholder,
      "Find a take, upload or line…",
    );
    assert.ok(editor.textContent?.includes("Maren at the rail, listening"), "an accepted real take is in the Library");
    assert.ok(editor.querySelector(".fy-cutviewer"), "the real preview stays in the centre");
    assert.equal(editor.querySelectorAll(".fy-timeline").length, 1, "the lanes share one timeline canvas");

    const named = [...editor.querySelectorAll(".fy-track__label")]
      .map((node) => node.textContent?.trim())
      .filter((label) => ["Subtitles", "Picture", "Dialogue", "Ambience", "Music"].includes(label ?? ""));
    assert.deepEqual(named, ["Subtitles", "Picture"]);

    // Design turn 122: Inspector and Arke stack rather than tabbing, so both are present at
    // once and neither can be reached by taking the other away.
    assert.equal(editor.querySelectorAll("[role='tab']").length, 0, "no tabs left on the edge");
    assert.ok(editor.querySelector("#cut-inspector-panel"), "the Inspector is on the edge");
    assert.ok(editor.querySelector("#cut-arke-panel"), "and Arke is under it, at the same time");
  });

  it("inspects a selected real Picture clip with the frame timing control", async () => {
    const screen = await mountCut(storyTimelineState());
    try {
      const inspector = await select(screen, "[data-clip='cl_sh-12']");
      assert.match(inspector.textContent ?? "", /PICTURE CLIP/);
      assert.match(inspector.textContent ?? "", /tk_01J8F0000000000000000000B2/);
      assert.ok(inspector.querySelector("[aria-label='In one frame later']"), "the clip's timing is authored in the reactive Inspector");
    } finally {
      await close(screen);
    }
  });

  it("inspects a real overlay once it is selected", async () => {
    const screen = await mountCut(mediaOnlyState());
    try {
      const inspector = await select(screen, ".fy-ovclip");
      assert.match(inspector.textContent ?? "", /OVERLAY CLIP/);
      assert.match(inspector.textContent ?? "", /plate\.mp4/);
      assert.match(inspector.textContent ?? "", /Overlay L1/);
    } finally {
      await close(screen);
    }
  });
});

describe("the cut footer of a production with no story (504)", () => {
  it("says nothing about shots or gaps, over uncovered time it has no claim on", () => {
    const html = renderCut(mediaOnlyState());
    assert.match(html, /no story · what you place is the film/, "the header states the mode");
    // The reported bug exactly: the same sentence as a story production, with zeros in it, and a
    // gap count of nought over eight seconds nobody covered.
    assert.doesNotMatch(html, /shots placed/, "there are no shots to place");
    assert.doesNotMatch(html, /\d gaps?\b/, "and no gap, because nothing is missing");
    assert.doesNotMatch(html, /covered/, "coverage describes a story that does not exist");
  });

  it("still counts what is on the timeline, in the header", () => {
    // The header counts the record. The two imports go on its Picture track, where a placement
    // lives once the timeline is the editor; the lanes are drawn for what only they still hold.
    const state = mediaOnlyState();
    const production = state.world!.productions[0]!;
    production.cut = { audio: [], overlays: [] } as unknown as typeof production.cut;
    production.timeline = {
      status: "ready",
      timeline: applyTimelineCommands(seedEmptyPictureTimeline(production), [
        {
          kind: "place",
          trackId: "tr_picture",
          clip: { id: "cl_plate-1", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: IMPORT, label: "plate.mp4" } },
        },
        {
          kind: "place",
          trackId: "tr_picture",
          clip: { id: "cl_plate-2", startFrame: 288, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: IMPORT, label: "plate.mp4" } },
        },
      ]),
    };
    assert.match(renderCut(state), /2 clips/, "the clips are the film, so they are stated");
  });

  it("leaves the story footer alone", () => {
    const html = renderCut(structuredClone(FIXTURE_STATE) as ClientState);
    assert.match(html, /shots placed/, "a production with a story still reports its coverage");
  });

  it("does not tell a media-only cut it recomputes from selections it has not got", () => {
    // The note under the timeline warns that a derived cut holds nothing of its own. Here the
    // placements are the record, so the warning is not merely irrelevant — it is false about the
    // one thing the note exists to say, and would send somebody after selections to keep.
    const html = renderCut(mediaOnlyState());
    assert.doesNotMatch(html, /recomputes from shot selections/, "there are no shot selections");
    assert.doesNotMatch(html, /a projection/, "nor a derivation to project from");
    assert.match(html, /the clips themselves are the record/, "what is true of this cut instead");
  });

  it("leaves the note on a story cut alone", () => {
    const html = renderCut(structuredClone(FIXTURE_STATE) as ClientState);
    assert.match(html, /the cut starts empty — the first placement saves it as the timeline/, "the story cut's note names the empty first state (2026-09-02)");
    assert.doesNotMatch(html, /the clips themselves are the record/);
  });
});

/**
 * The rail and the switcher, on the same clock as the screen beside them (issue 508).
 *
 * A production with no story keeps its length in its clips, and these two read the derived cut,
 * which has nothing in it. So the same film was `28s` in the Cut header, `28s` on the Exports
 * button, 28.000s in the rendered file — and a `0s` cut in the rail one panel to the left.
 */
describe("the rail and the switcher on a production with no story (508)", () => {
  it("uses saved audio and upper Picture clips as the media-only runtime", () => {
    for (const kind of ["audio", "picture"] as const) {
      const state = mediaOnlyState(), p = state.world!.productions[0]!;
      p.cut = { overlays: [], audio: [] };
      const artifact = { ...state.world!.artifacts[0]!, kind: kind === "audio" ? "audio" as const : "video" as const, mediaInfo: { durationSec: 4, hasAudio: true } };
      state.world!.artifacts = [artifact];
      p.timeline = { status: "ready", timeline: applyTimelineCommands(seedEmptyPictureTimeline(p), [
        { kind: "add-track", trackId: "tr_imported", trackKind: kind, name: "Imported" },
        { kind: "place", trackId: "tr_imported", clip: { id: "cl_media", startFrame: 0, durationFrames: 4 * (p.meta.frameRate ?? 24), sourceInFrames: 0,
          source: { kind: "artifact", artifactId: artifact.id, label: artifact.file } } },
      ]) };
      const html = renderCut(state);
      assert.match(html, /fy-prodrail__count">4s/);
      assert.match(html, /fy-prodrail__switchsub">video · 4s cut/);
    }
  });
  it("states the length of what was placed, the way the header does", () => {
    const html = renderCut(mediaOnlyState());
    // Clips at 0→4 and 12→16: the film ends where the furthest one ends, not where the canvas does.
    assert.match(html, /fy-prodrail__count">16s/, "the rail counts the film");
    assert.match(html, /fy-prodrail__switchsub">video · 16s cut/, "and so does the switcher");
    assert.doesNotMatch(html, /0s cut/, "an empty cut is not what this production is");
  });

  it("leaves a production with a story on the derived clock", () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const derived = deriveCut(state.world!.productions[0]!);
    const html = renderCut(state);
    // The rail states the cut and the switcher states how much of it is covered: two figures,
    // both derived, and neither of them measured off the timeline.
    assert.match(html, new RegExp(`fy-prodrail__count">${derived.totalSec}s`), "the rail states the cut");
    assert.match(
      html,
      new RegExp(`fy-prodrail__switchsub">video · ${derived.totalSec - derived.uncoveredSec}s cut`),
      "the switcher states what is covered",
    );
  });
});

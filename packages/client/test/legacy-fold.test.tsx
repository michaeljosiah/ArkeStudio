import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  ClientStateSchema,
  migrateLegacyCut,
  seedEmptyPictureTimeline,
  seedFirstPictureTimeline,
  storyTimelineFingerprint,
  type ClientMessage,
  type ClientState,
} from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { editorTimeline } from "../src/lib/editor-timeline.js";
import { CutScreen } from "../src/screens/cut.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Legacy placements are folded with the first timeline write, and shown folded before it
 * (issue 1159; SPEC-037 R-2, R-30, R-31, A-1).
 *
 * Opening a legacy world changes no bytes. What the editor draws for a `cut.json` placement is
 * the fold that first write will save — the same seed, the same catalog, the same ids — so the
 * placement is a typed clip from the start: at its own window, on a track named for its lane,
 * previewed by the plan, edited by commands the coordinator applies after folding identically.
 * The numbered lanes that used to draw and write these placements are gone with nothing to draw.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: false, media: query }) });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
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

const PLATE = "ar_01J8G0000000000000000000V1";
const BED = "ar_01J8G0000000000000000000V2";
const GONE = "ar_01J8G0000000000000000000ZZ";
const A1 = "ov_01J8G0000000000000000000A1";
const A2 = "ov_01J8G0000000000000000000A2";
const B1 = "ov_01J8G0000000000000000000B1";
const C1 = "ov_01J8G0000000000000000000C1";

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

/**
 * A production with no story, cut on the old lanes and never opened on the timeline: a plate at
 * 0→4 and again at 12→16 on lane 1, and — when asked for — a bed on lane 0 running to 30s, well
 * past the last picture, or a placement of a file the world no longer has. Nothing in
 * `timeline.json`.
 */
function legacyState(options: { bed?: boolean; saved?: boolean; gone?: boolean } = {}): ClientState {
  const base = structuredClone(FIXTURE_STATE) as ClientState;
  const world = base.world!;
  world.artifacts = [
    ...world.artifacts,
    { id: PLATE, kind: "video", file: "plate.mp4", hash: "sha256:6a1e02b9c44d7f33", origin: { by: "user" }, links: [], created: "2026-06-11T10:00:00Z", mediaInfo: { durationSec: 4, hasAudio: false } },
    { id: BED, kind: "audio", file: "bed.wav", hash: "sha256:6a1e02b9c44d7f34", origin: { by: "user" }, links: [], created: "2026-06-11T10:00:00Z", mediaInfo: { durationSec: 10, hasAudio: true } },
  ] as typeof world.artifacts;
  const production = world.productions[0]!;
  production.scenes = [];
  production.takes = [];
  production.chapters = [];
  production.selections = {} as typeof production.selections;
  production.cut = {
    audio: [],
    overlays: [
      { id: A1, artifactId: PLATE, startSec: 0, endSec: 4, lane: 1, audio: "keep" },
      { id: A2, artifactId: PLATE, startSec: 12, endSec: 16, lane: 1, audio: "keep" },
      ...(options.bed ? [{ id: B1, artifactId: BED, startSec: 0, endSec: 30, lane: 0, audio: "keep" as const }] : []),
      ...(options.gone ? [{ id: C1, artifactId: GONE, startSec: 4, endSec: 8, lane: 2, audio: "keep" as const }] : []),
    ],
  } as typeof production.cut;
  // A record saved before the fold shipped: nothing on it, and `migratedCut` unset.
  if (options.saved) production.timeline = { status: "ready", timeline: { ...seedEmptyPictureTimeline(production), revision: 3 } };
  return ClientStateSchema.parse(base);
}

async function mount(state: ClientState): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(bridge(sent));
  __setStateForTest(state);
  const production = state.world!.productions[0]!;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${production.meta.id}/cut`]}>
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

function commands(screen: Mounted): Extract<ClientMessage, { kind: "timeline-command" }>[] {
  return screen.sent.filter((message): message is Extract<ClientMessage, { kind: "timeline-command" }> => message.kind === "timeline-command");
}

function clip(screen: Mounted, id: string): HTMLElement {
  const found = screen.container.querySelector<HTMLElement>(`[data-clip='cl_${id.replace(/^ov_/, "ov-")}']`);
  assert.ok(found, `${id} is on the timeline as the clip the fold will save`);
  return found;
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("legacy placements before the first write (issue 1159)", () => {
  it("opens with the placements folded onto typed tracks, at their own windows, and no lanes", async () => {
    const screen = await mount(legacyState());
    try {
      assert.equal(screen.container.querySelector(".fy-clanes, .fy-ovlane, .fy-ovclip"), null, "the legacy lanes are gone");
      const lane = screen.container.querySelector<HTMLElement>("[data-track-id='tr_lane-1']");
      assert.ok(lane, "lane 1 is a picture track named for it");
      assert.equal(lane.querySelector(".fy-track__name")?.textContent, "Overlay L1");
      assert.match(clip(screen, A1).getAttribute("aria-label") ?? "", /00:00:00:00 to 00:00:04:00/, "the first window, to the frame (R-31)");
      assert.match(clip(screen, A2).getAttribute("aria-label") ?? "", /00:00:12:00 to 00:00:16:00/, "and the second");
      // The header states the film the plan finds on that record, and counts its clips.
      assert.match(screen.container.querySelector(".fy-cuthead__meta")?.textContent ?? "", /^16s · no story · what you place is the film · 2 clips$/);
    } finally {
      await close(screen);
    }
  });

  it("sends the first edit against the folded id, fenced for the write that materialises the record", async () => {
    const state = legacyState();
    const screen = await mount(state);
    try {
      await act(async () => clip(screen, A1).click());
      assert.equal(screen.container.querySelector(".fy-cutinspect__eyebrow")?.textContent, "PLACED PICTURE");
      const remove = [...screen.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Delete");
      assert.ok(remove && !remove.disabled, "a folded clip is editable");
      await act(async () => remove.click());
      const sent = commands(screen).at(-1);
      assert.ok(sent);
      assert.deepEqual(sent.commands, [{ kind: "delete", clipId: "cl_ov-01J8G0000000000000000000A1" }]);
      assert.equal(sent.baseRevision, null, "no record yet: this write makes it, and folds the placements into it first");
      assert.equal(sent.sourceFingerprint, storyTimelineFingerprint(state.world!.productions[0]!), "fenced by the story the seed was made against");
    } finally {
      await close(screen);
    }
  });

  it("shows a saved record that has not absorbed its placements with them folded in, and edits against its revision", async () => {
    const screen = await mount(legacyState({ saved: true }));
    try {
      clip(screen, A1);
      clip(screen, A2);
      const mute = [...screen.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Mute Overlay L1");
      assert.ok(mute, "the folded track has the typed row's controls");
      await act(async () => mute.click());
      const sent = commands(screen).at(-1);
      assert.ok(sent);
      assert.deepEqual(sent.commands, [{ kind: "set-track", trackId: "tr_lane-1", muted: true }]);
      assert.equal(sent.baseRevision, 3, "the saved revision fences the write; the coordinator folds before applying");
    } finally {
      await close(screen);
    }
  });

  it("previews the fold: a bed outlasting the picture no longer lengthens the film before the first write", async () => {
    // The record's rule (SPEC-037 R-32, SPEC-038 R-19): sound is conformed to the picture's end.
    // The lanes measured the legacy film to the furthest placement, so this cut read 30s before
    // its first write and 16s after it. It reads 16s throughout now, because what is previewed
    // is what the write will save; the bed is still drawn whole on its own track.
    const screen = await mount(legacyState({ bed: true }));
    try {
      const bed = clip(screen, B1);
      assert.match(bed.getAttribute("aria-label") ?? "", /00:00:00:00 to 00:00:30:00/);
      assert.ok(screen.container.querySelector("[data-track-id='tr_lane-0-sound'] [data-clip='cl_ov-01J8G0000000000000000000B1']"), "on lane 0's sound track");
      assert.match(screen.container.querySelector(".fy-cuthead__meta")?.textContent ?? "", /^16s · no story/);
    } finally {
      await close(screen);
    }
  });

  it("names a placement the fold cannot carry, and previews the film without it", async () => {
    // The lanes drew a placement of a lost file with a `missing artifact` label and the plan
    // refused the preview over it by name (SPEC-039 R-39). The fold drops it, as the write will,
    // so the preview plays; the footer says what was left behind, with the reason in its tip.
    const screen = await mount(legacyState({ gone: true }));
    try {
      assert.equal(screen.container.querySelector(`[data-clip='cl_ov-01J8G0000000000000000000C1']`), null, "not on any track");
      const chip = screen.container.querySelector<HTMLElement>("[data-testid='not-carried']");
      assert.ok(chip, "the footer says so");
      assert.equal(chip.textContent, "1 legacy placement not carried");
      assert.match(chip.getAttribute("title") ?? "", /ov_01J8G0000000000000000000C1 cites artifact ar_01J8G0000000000000000000ZZ, which this world does not have/);
      assert.equal(screen.container.querySelector(".fy-cuttimeline-error"), null, "the preview is not refused over it");
      assert.match(screen.container.querySelector(".fy-cuthead__meta")?.textContent ?? "", /^16s · no story/);
    } finally {
      await close(screen);
    }
  });

  it("projects exactly the fold the coordinator will save", () => {
    // The editor's record and the write's base are the same function over the same inputs: the
    // seed the coordinator materialises for a story-ordered production, folded against the whole
    // catalog. The ids are the ones every command above named.
    const state = legacyState({ bed: true });
    const production = state.world!.productions[0]!;
    const projected = editorTimeline(production, { status: "absent" }, state.world!.artifacts);
    const saved = migrateLegacyCut(seedFirstPictureTimeline(production), production, state.world!.artifacts);
    assert.deepEqual(projected, saved);
    assert.deepEqual(projected.dropped, [], "nothing this fold could not carry");
    assert.ok(projected.timeline?.migratedCut === true);
    assert.deepEqual(
      projected.timeline.tracks.map((track) => [track.id, track.kind, track.clips.map((entry) => entry.id)]),
      [
        ["tr_picture", "picture", []],
        ["tr_lane-0-sound", "ambience", ["cl_ov-01J8G0000000000000000000B1"]],
        ["tr_lane-1", "picture", ["cl_ov-01J8G0000000000000000000A1", "cl_ov-01J8G0000000000000000000A2"]],
      ],
    );
    // A record that has absorbed its placements is handed back untouched: the same object.
    const absorbed = { ...saved.timeline, revision: 7 };
    assert.equal(editorTimeline(production, { status: "ready", timeline: absorbed }, state.world!.artifacts).timeline, absorbed);
  });
});

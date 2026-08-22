import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ClientStateSchema, type ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * The Cut on the song clock (80a). The fixture production is a short film with no spine — the
 * story-clock path #253 must leave alone — so the spine is added here rather than to the shared
 * fixture, which ~16 other files assert against.
 */

const TRACK = "ar_01J8G0000000000000000000T1";
const CLIP = "tk_01J8F0000000000000000000B2";
const AT = "2026-07-30T18:22:00Z";
const HASH = `sha256:${"a".repeat(64)}`;

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

describe("the Cut on the song clock (80a)", () => {
  it("lays the track out by position, with black for the time no anchor claims", () => {
    const html = renderCut(spineState());
    // 10s before the anchor and 42s after it: both are true statements about where the work is,
    // and a cut that quietly ran 52s short is the one nobody notices next to the song.
    assert.match(html, /fy-cutseg--black/, "uncovered time is drawn, not omitted");
    assert.match(html, /2 black · 52s uncovered/, "and counted in the footer");
    assert.match(html, /cut to the track/, "the header states which clock this is");
  });

  it("opens with a clip selected and offers exactly one authored edit on the picture", () => {
    const html = renderCut(spineState());
    assert.match(html, /fy-cutsel/, "the selected-clip strip is present");
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
  });

  it("shows the in-point a selection already carries", () => {
    const state = spineState();
    state.world!.productions[0]!.selections["sh_12"]!.trimInSec = 2.5;
    const html = renderCut(state);
    assert.match(html, /2\.5s/, "the stored trim is what the control reads");
  });

  it("puts a production with no spine on the story clock, and trims there too (81a)", () => {
    const html = renderCut(structuredClone(FIXTURE_STATE) as ClientState);
    assert.match(html, /assembled from accepted takes only/, "24a's header copy, unchanged");
    assert.doesNotMatch(html, /fy-cutseg--black/, "black belongs to the song clock");
    // The scene keeps its grouping in the band; the lane carries the unit of work.
    assert.match(html, /fy-scenes__band/, "scenes band the ruler");
    assert.match(html, /fy-cutseg--pick/, "and shots, not scenes, are the cells");
    assert.match(html, /TRIM IN/, "the same authored edit as the song clock");
    // The ported gesture: the figure is a slider you drag, and the steppers remain for precision.
    assert.match(html, /fy-trim__value--drag/, "the value is a drag handle");
    assert.match(html, /role="slider"/, "and announces itself as one");
    assert.match(html, /aria-label="more trim"/, "the steppers stay");
  });

  it("states the slot on this clock, and says nothing about a take nobody measured", () => {
    // The fixture carries no takeMediaInfo: absent is "not measured", never "measured zero", so
    // the strip simply omits the take's length rather than printing a figure it does not have.
    const html = renderCut(structuredClone(FIXTURE_STATE) as ClientState);
    assert.match(html, /shot 4\.0s/, "the authored duration is the slot");
    assert.doesNotMatch(html, /take \d/, "no length claimed for unmeasured material");
    assert.doesNotMatch(html, /budget/, "budget is the song clock's word, not this one's");
  });

  it("adds the take's length once something has measured it", () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    state.world!.productions[0]!.takeMediaInfo = {
      [CLIP]: { sourceHash: HASH, mediaInfo: { durationSec: 6, hasAudio: true }, probedAt: AT },
    } as NonNullable<ClientState["world"]>["productions"][number]["takeMediaInfo"];
    const html = renderCut(ClientStateSchema.parse(state));
    assert.match(html, /shot 4\.0s · take 6\.0s/, "the slot, then the material that must fill it");
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
    const html = renderCut(structuredClone(FIXTURE_STATE) as ClientState);
    assert.match(html, /fy-artpanel/);
    assert.match(html, /harbour-bells\.wav/, "the fixture world's one artifact");
    assert.match(html, /draggable="true"/, "rows are drag sources");
    assert.match(html, /drag onto a lane to place/);
    // Upload is live now: the host opens the picker and the renderer never sees the bytes.
    assert.match(html, /Upload/);
    assert.doesNotMatch(html, /Filing arrives with/, "no longer a promise of a later screen");
  });

  it("draws empty lanes, because a lane that is not there cannot be dropped on", () => {
    const html = renderCut(structuredClone(FIXTURE_STATE) as ClientState);
    assert.match(html, /fy-ovlane/);
    assert.match(html, /drop an artifact to place it/);
  });

  it("rests at two lanes: one to place a picture on and one under it for the sound", () => {
    const html = renderCut(structuredClone(FIXTURE_STATE) as ClientState);
    assert.equal((html.match(/fy-track__label">L\d/g) ?? []).length, 2);
    assert.match(html, /L1[\s\S]*L0/, "the higher lane is drawn first, because it sits nearer the viewer");
    // React escapes the apostrophe on the way out, so the bottom lane is matched by its words.
    assert.match(html, /drop a bed here, or split a clip.{1,8}s sound down to it/, "and the bottom one says so");
  });

  it("draws a lane for the highest one a clip actually uses", () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.cut = {
      audio: [],
      overlays: [
        { id: "ov_01J8G0000000000000000000A1", artifactId: "ar_01J8G0000000000000000000R1", startSec: 1, endSec: 3, lane: 4, audio: "keep" },
      ],
    } as typeof production.cut;
    const html = renderCut(ClientStateSchema.parse(state));
    assert.equal((html.match(/fy-track__label">L\d/g) ?? []).length, 5, "L4 down to L0, so nothing is hidden");
  });

  it("counts what was placed, not what a split filed", () => {
    // Splitting files a second record over the same file. Counting both reports two clips for
    // one piece of media the person dropped once and still sees as one run on the timeline.
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.cut = {
      audio: [],
      overlays: [
        { id: "ov_01J8G0000000000000000000A1", artifactId: "ar_01J8G0000000000000000000R1", startSec: 1, endSec: 3, lane: 1, audio: "mute" },
        { id: "ov_01J8G0000000000000000000A2", artifactId: "ar_01J8G0000000000000000000R1", startSec: 1, endSec: 3, lane: 0, audio: "only" },
      ],
    } as typeof production.cut;
    const html = renderCut(ClientStateSchema.parse(state));
    assert.match(html, /1 clip/);
    assert.doesNotMatch(html, /2 clips/);
  });

  it("pluralises the count, because two clips are not 2 clip", () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.cut = {
      audio: [],
      overlays: [
        { id: "ov_01J8G0000000000000000000A1", artifactId: "ar_01J8G0000000000000000000R1", startSec: 1, endSec: 3, lane: 1, audio: "keep" },
        { id: "ov_01J8G0000000000000000000A2", artifactId: "ar_01J8G0000000000000000000R1", startSec: 5, endSec: 7, lane: 0, audio: "keep" },
      ],
    } as typeof production.cut;
    assert.match(renderCut(ClientStateSchema.parse(state)), /2 clips/);
  });

  it("marks the sound half of a split, and lays no picture for it", () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.cut = {
      audio: [],
      overlays: [
        { id: "ov_01J8G0000000000000000000A1", artifactId: "ar_01J8G0000000000000000000R1", startSec: 1, endSec: 3, lane: 0, audio: "only" },
      ],
    } as typeof production.cut;
    const html = renderCut(ClientStateSchema.parse(state));
    assert.match(html, /fy-ovclip--sound/, "the sound half reads as sound");
    assert.match(html, /sound only/, "and says so where a person can read it");
  });

  it("places a filed overlay by its own window, and counts it apart from coverage", () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.cut = {
      audio: [],
      overlays: [
        { id: "ov_01J8G0000000000000000000A1", artifactId: "ar_01J8G0000000000000000000R1", startSec: 2, endSec: 6, lane: 0, audio: "keep" },
      ],
    } as typeof production.cut;
    const html = renderCut(ClientStateSchema.parse(state));
    assert.match(html, /fy-ovclip/, "the placement is drawn");
    assert.match(html, /harbour-bells\.wav/);
    // An overlay is never coverage: the shot count is untouched and the overlay is its own clause.
    assert.match(html, /shots covered/);
    assert.match(html, /1 clip/);
    assert.doesNotMatch(html, /14 of 15/, "placing something over the picture covers no shot");
  });
});

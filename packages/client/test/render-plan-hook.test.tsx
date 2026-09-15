import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import {
  applyTimelineCommands,
  seedStoryPictureTimeline,
  type ArtifactSidecar,
  type ClientState,
  type ProductionBundle,
} from "@arke-studio/contracts";
import { ABSENT_TIMELINE, useRenderPlan, type EditorRenderPlan, type RenderPlanInputs } from "../src/screens/editor-plan.js";
import { editorTimeline } from "../src/lib/editor-timeline.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The render plan is rebuilt by an authored change and by nothing else (issue 1158).
 *
 * The transport re-renders the Cut four times a second while the film plays. The plan is what
 * the monitor mix, the preview's spans and the cue lookup are keyed on, so a plan rebuilt on the
 * clock restarted all three and the sound heard it as four pause/play cycles a second. The hook
 * owns the memo boundary; this pins what crosses it.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const results: EditorRenderPlan[] = [];

/** Renders the hook and records what it returned; `tick` stands for everything a render can change that the plan is not made of. */
function Probe({ tick: _tick, ...inputs }: RenderPlanInputs & { tick: number }) {
  results.push(useRenderPlan(inputs));
  return null;
}

interface Mounted {
  root: Root;
  container: HTMLElement;
  render: (props: RenderPlanInputs & { tick: number }) => Promise<void>;
}

async function mount(): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (props: RenderPlanInputs & { tick: number }) => {
    await act(async () => root.render(<Probe {...props} />));
  };
  return { root, container, render };
}

async function close(mounted: Mounted): Promise<void> {
  await act(async () => mounted.root.unmount());
  mounted.container.remove();
}

/** The fixture's story on a saved timeline, so the plan is one the projection accepts. */
function savedStory(): { production: ProductionBundle; artifacts: readonly ArtifactSidecar[] } {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.timeline = { status: "ready", timeline: seedStoryPictureTimeline(production) };
  return { production, artifacts: state.world!.artifacts };
}

/** The screen's own inputs: the record it edits is projected once per snapshot and catalog, as the screen memoises it. */
function inputsFor(production: ProductionBundle, artifacts: readonly ArtifactSidecar[], tick: number, more: Partial<RenderPlanInputs> = {}): RenderPlanInputs & { tick: number } {
  const timelineState = production.timeline ?? ABSENT_TIMELINE;
  return {
    production,
    artifacts,
    timelineState,
    timeline: editorTimeline(production, timelineState, artifacts).timeline,
    timelineError: null,
    subtitleView: null,
    subtitleHidden: false,
    tick,
    ...more,
  };
}

afterEach(() => {
  results.length = 0;
  document.body.replaceChildren();
});

describe("the editor's render plan (issue 1158)", () => {
  it("hands back the same plan while nothing it is made of has changed", async () => {
    const { production, artifacts } = savedStory();
    const mounted = await mount();
    try {
      const inputs = inputsFor(production, artifacts, 1);
      await mounted.render(inputs);
      const first = results.at(-1)!;
      assert.ok(first.renderPlan?.ok, "the saved story plans");
      // Four playhead reports, as the transport would make them: a render each, no plan each.
      for (const tick of [2, 3, 4, 5]) await mounted.render({ ...inputs, tick });
      assert.equal(results.length, 5);
      for (const later of results.slice(1)) {
        assert.equal(later.renderPlan, first.renderPlan, "the plan object is the one the mix and the spans are keyed on");
        assert.equal(later.previewState, first.previewState, "and so is the record it was built from");
      }
    } finally {
      await close(mounted);
    }
  });

  it("rebuilds for a timeline change, a media change and a subtitle choice, and refuses for a timeline error", async () => {
    const { production, artifacts } = savedStory();
    const mounted = await mount();
    try {
      const inputs = inputsFor(production, artifacts, 1);
      await mounted.render(inputs);
      const before = results.at(-1)!.renderPlan;
      assert.ok(before?.ok);

      // The record moved: a new production snapshot carrying the next revision.
      const saved = production.timeline;
      assert.ok(saved?.status === "ready");
      const edited: ProductionBundle = {
        ...production,
        timeline: { status: "ready", timeline: applyTimelineCommands(saved.timeline, [{ kind: "move-adjacent", clipId: "cl_sh-13", direction: "earlier" }]) },
      };
      const afterEditInputs = inputsFor(edited, artifacts, 2);
      await mounted.render(afterEditInputs);
      const afterEdit = results.at(-1)!.renderPlan;
      assert.ok(afterEdit?.ok);
      assert.notEqual(afterEdit, before, "an edit is a new plan");
      assert.equal(afterEdit.plan.revision, saved.timeline.revision + 1, "built from the record that moved");

      // The world's files changed under it: the store replaces the catalog, so the plan follows.
      await mounted.render({ ...afterEditInputs, artifacts: [...artifacts], tick: 3 });
      const afterMedia = results.at(-1)!.renderPlan;
      assert.notEqual(afterMedia, afterEdit, "a new catalog is a new plan");

      // Viewing a subtitle track asks the plan for it; the fixture has none, so the plan says so by name.
      await mounted.render({ ...afterEditInputs, subtitleView: "tr_sub-en", tick: 4 });
      const withSubtitles = results.at(-1)!.renderPlan;
      assert.notEqual(withSubtitles, afterMedia);
      assert.equal(withSubtitles?.ok, false);

      // A hidden track is not asked for, so the film comes back.
      await mounted.render({ ...afterEditInputs, subtitleView: "tr_sub-en", subtitleHidden: true, tick: 5 });
      assert.equal(results.at(-1)!.renderPlan?.ok, true);

      // An unresolvable record blocks the plan outright rather than planning something else.
      await mounted.render({ ...afterEditInputs, timelineError: "history cannot be replayed", tick: 6 });
      assert.equal(results.at(-1)!.renderPlan, null);
    } finally {
      await close(mounted);
    }
  });

  it("previews the record the editor edits: an unsaved story's empty first state, a legacy cut's projected fold", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    delete production.timeline;
    const mounted = await mount();
    try {
      const first = inputsFor(production, state.world!.artifacts, 1);
      await mounted.render(first);
      const story = results.at(-1)!;
      assert.equal(story.previewState.status, "ready", "the record the first write would save");
      assert.ok(story.renderPlan?.ok);
      assert.equal(story.renderPlan.plan.items.length, 0, "and it is empty (decided 2026-09-02)");
      await mounted.render({ ...first, tick: 2 });
      assert.equal(results.at(-1)!.previewState, story.previewState, "the same record is the same preview");

      // Legacy placements are previewed folded onto typed tracks, exactly as the first write
      // will save them (issue 1159): the bells at 1s→3s are an Ambience clip in the plan.
      const legacy: ProductionBundle = {
        ...production,
        cut: { audio: [], overlays: [{ id: "ov_01J8G0000000000000000000A1", artifactId: "ar_01J8G0000000000000000000R1", startSec: 1, endSec: 3, lane: 0, audio: "keep" }] },
      };
      await mounted.render(inputsFor(legacy, state.world!.artifacts, 3));
      const folded = results.at(-1)!;
      assert.equal(folded.previewState.status, "ready");
      assert.ok(folded.previewState.status === "ready" && folded.previewState.timeline.migratedCut === true, "the fold, not the seed");
      assert.ok(folded.renderPlan?.ok);
      assert.deepEqual(folded.renderPlan.plan.audio.map((clip) => [clip.path, clip.startSec, clip.endSec]), [["artifacts/harbour-bells.wav", 1, 3]]);

      // A legacy placement of a file the world does not have is dropped by the fold, but the saved
      // state still names it and the export refuses it by that name — so the preview does too.
      const lost: ProductionBundle = {
        ...legacy,
        cut: { audio: [], overlays: [...legacy.cut.overlays, { id: "ov_01J8G0000000000000000000A2", artifactId: "ar_01J8G0000000000000000000ZZ", startSec: 4, endSec: 6, lane: 0, audio: "keep" }] },
      };
      await mounted.render(inputsFor(lost, state.world!.artifacts, 4));
      const refused = results.at(-1)!.renderPlan;
      assert.equal(refused?.ok, false);
      assert.match(refused && !refused.ok ? refused.reason : "", /ov_01J8G0000000000000000000A2 cites artifact ar_01J8G0000000000000000000ZZ, which this world does not have/);

      // A song not yet opened on the timeline has no record to draw and no plan of its own.
      const song: ProductionBundle = {
        ...production,
        spine: {
          schemaVersion: 1,
          revision: 1,
          trackArtifactId: "ar_01J8G0000000000000000000R1",
          markers: [],
          anchors: { sh_12: { startSec: 10, endSec: 18, clipAudio: { mode: "mute" } } },
          updatedAt: "2026-06-11T10:00:00Z",
        } as ProductionBundle["spine"],
      };
      const inputs = inputsFor(song, state.world!.artifacts, 5);
      assert.equal(inputs.timeline, null);
      await mounted.render(inputs);
      assert.equal(results.at(-1)!.previewState.status, "absent");
      assert.equal(results.at(-1)!.renderPlan, null);
    } finally {
      await close(mounted);
    }
  });
});

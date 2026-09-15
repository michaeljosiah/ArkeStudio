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

function inputsFor(production: ProductionBundle, artifacts: RenderPlanInputs["artifacts"], tick: number, more: Partial<RenderPlanInputs> = {}): RenderPlanInputs & { tick: number } {
  return {
    production,
    artifacts,
    timelineState: production.timeline ?? ABSENT_TIMELINE,
    mediaOnly: false,
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
      await mounted.render(inputsFor(production, artifacts, 1));
      const first = results.at(-1)!;
      assert.ok(first.renderPlan?.ok, "the saved story plans");
      // Four playhead reports, as the transport would make them: a render each, no plan each.
      for (const tick of [2, 3, 4, 5]) await mounted.render(inputsFor(production, artifacts, tick));
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
      await mounted.render(inputsFor(production, artifacts, 1));
      const before = results.at(-1)!.renderPlan;
      assert.ok(before?.ok);

      // The record moved: a new production snapshot carrying the next revision.
      const saved = production.timeline;
      assert.ok(saved?.status === "ready");
      const edited: ProductionBundle = {
        ...production,
        timeline: { status: "ready", timeline: applyTimelineCommands(saved.timeline, [{ kind: "move-adjacent", clipId: "cl_sh-13", direction: "earlier" }]) },
      };
      await mounted.render(inputsFor(edited, artifacts, 2));
      const afterEdit = results.at(-1)!.renderPlan;
      assert.ok(afterEdit?.ok);
      assert.notEqual(afterEdit, before, "an edit is a new plan");
      assert.equal(afterEdit.plan.revision, saved.timeline.revision + 1, "built from the record that moved");

      // The world's files changed under it: the store replaces the catalog, so the plan follows.
      await mounted.render(inputsFor(edited, [...artifacts], 3));
      const afterMedia = results.at(-1)!.renderPlan;
      assert.notEqual(afterMedia, afterEdit, "a new catalog is a new plan");

      // Viewing a subtitle track asks the plan for it; the fixture has none, so the plan says so by name.
      await mounted.render(inputsFor(edited, artifacts, 4, { subtitleView: "tr_sub-en" }));
      const withSubtitles = results.at(-1)!.renderPlan;
      assert.notEqual(withSubtitles, afterMedia);
      assert.equal(withSubtitles?.ok, false);

      // A hidden track is not asked for, so the film comes back.
      await mounted.render(inputsFor(edited, artifacts, 5, { subtitleView: "tr_sub-en", subtitleHidden: true }));
      assert.equal(results.at(-1)!.renderPlan?.ok, true);

      // An unresolvable record blocks the plan outright rather than planning something else.
      await mounted.render(inputsFor(edited, artifacts, 6, { timelineError: "history cannot be replayed" }));
      assert.equal(results.at(-1)!.renderPlan, null);
    } finally {
      await close(mounted);
    }
  });

  it("previews the empty first state of an unsaved story production, and the legacy film of one with no story", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    delete production.timeline;
    const mounted = await mount();
    try {
      await mounted.render(inputsFor(production, state.world!.artifacts, 1));
      const story = results.at(-1)!;
      assert.equal(story.previewState.status, "ready", "the record the first write would save");
      assert.ok(story.renderPlan?.ok);
      assert.equal(story.renderPlan.plan.items.length, 0, "and it is empty (decided 2026-09-02)");
      await mounted.render(inputsFor(production, state.world!.artifacts, 2));
      assert.equal(results.at(-1)!.previewState, story.previewState, "the seeded record is not re-seeded on the clock");

      // No story: the placements are the film until the first write folds them (SPEC-037 R-2).
      await mounted.render(inputsFor(production, state.world!.artifacts, 3, { mediaOnly: true }));
      const media = results.at(-1)!;
      assert.equal(media.previewState.status, "absent");
      assert.ok(media.renderPlan?.ok);
      assert.equal(media.renderPlan.plan.revision, null, "planned from the legacy derivation, not a record");
    } finally {
      await close(mounted);
    }
  });
});

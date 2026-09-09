import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { activityJobLabels, computeRunning, orderedShots, type ClientState, type Job } from "@arke-studio/contracts";
import { parseHTML } from "linkedom";
import { ActivityScreen } from "../src/screens/shell.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * The one line under a failed job (issue 226).
 *
 * It read "failed — retry from its production's dispatch dialog" under every failure. Character
 * looks, sheets and main photos are dispatched from the character's own reference screens and
 * belong to no production, so the only recovery instruction on the row pointed at a dialog that
 * does not exist for that job — and the reference screen offered no retry either, leaving the
 * row a dead end.
 *
 * `jobOrigin` is unit-tested in the coordinator's activity suite; this is about the row that
 * shows it, and that Activity's history only appears for work finished today.
 */

// The row is drawn only for work that finished today, so the fixture has to be stamped today.
const TODAY = `${new Date().toISOString().slice(0, 10)}T09:14:00Z`;

function failed(overrides: Partial<Job>): Job {
  return {
    id: "jb_01J8E0000000000000000000L1",
    idempotencyKey: "01J8E1000000000000000000M1",
    worldId: FIXTURE_WORLD_ID,
    target: { kind: "character-look", id: "maren-kest/msm7pzlb/1" },
    capability: "image",
    provider: "openai",
    model: "gpt-image-2",
    params: {},
    estimatedMicroUsd: 150000,
    status: "failed",
    providerJobId: null,
    attempt: 1,
    error: "openai: image generation failed (HTTP 400)",
    createdAt: TODAY,
    updatedAt: TODAY,
    ...overrides,
  };
}

function render(jobs: Job[]): string {
  const state: ClientState = { ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, jobs } };
  __setStateForTest(state);
  const html = renderToString(
    <MemoryRouter>
      <ActivityScreen />
    </MemoryRouter>,
  );
  // Server rendering splits a sentence at every interpolation with a comment marker, and
  // escapes the apostrophe. Neither is on screen, and asserting around them would be asserting
  // about React rather than about the row.
  return html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
}

describe("a failed job's recovery route on the Activity row (issue 226)", () => {
  it("names queued prose reads by their authored subject and production", () => {
    const state = structuredClone(FIXTURE_STATE);
    const world = state.world!, production = world.productions[0]!, scene = production.scenes[0]!;
    const shot = orderedShots(scene)[0]!;
    const chapter = { id: "chapter-one", file: "chapters/01.md", order: 1, title: "The last bell", status: "draft", version: 1 };
    production.chapters.push(chapter);
    world.series.push({ id: "bell-watch", version: 1, title: "Bell Watch", engine: "The bells answer", seasons: [], created: TODAY, updated: TODAY });
    const cases = [
      { id: world.canon[0]!.id, heading: "Canon", name: world.canon[0]!.title },
      { id: shot.id, heading: "Shot script", name: shot.title, production: true },
      { id: `${production.meta.id}/treatment`, heading: "Treatment", name: "Treatment", production: true },
      { id: `${production.meta.id}/question`, heading: "The question it answers", name: "The question it answers", production: true },
      { id: "bell-watch", heading: "Series engine", name: "Bell Watch" },
      { id: `${production.meta.id}/chapters/${chapter.id}#0`, heading: "Older chapter title", name: chapter.title, production: true },
      { id: "bible", heading: "The drowned city", name: "Bible · The drowned city", purpose: "bible-section" },
    ];
    for (const item of cases) {
      const label = activityJobLabels(state, failed({ target: { kind: "voice-preview", id: `${item.id}/elevenlabs/model/voice` },
        params: { purpose: item.purpose ?? "prose", sectionHeading: item.heading } })).target;
      assert.ok(label.includes(item.name), label);
      if (item.production) assert.ok(label.includes(production.meta.title), label);
    }
  });
  it("names work and models consistently without borrowing another world's entities (#1005)", () => {
    const state = structuredClone(FIXTURE_STATE);
    const production = state.world!.productions[0]!;
    const model = state.app.manifest!.models[0]!;
    const sessionId = "sess_01J8F3K2QW9VZX4N7M0RTYB6HZ";
    state.world!.benchSessions.push({ id: sessionId, title: "A storm over the harbour", mode: "image", updatedAt: TODAY, takeCount: 1, runningCount: 1, failedCount: 0, waitingCount: 0 });
    const bench = failed({ target: { kind: "bench-take", id: `${sessionId}/tk_opaque` }, provider: model.provider, model: model.id, status: "running" });
    state.app.jobs = [bench];
    assert.match(computeRunning(state)[0]!.title, /A storm over the harbour/);
    assert.match(computeRunning(state)[0]!.detail, new RegExp(model.displayName));
    const runningTitle = parseHTML(render([bench])).document.querySelector(".fy-activityrow__title")!;
    assert.ok(runningTitle.getAttribute("title")!.includes(bench.target.id!));
    assert.ok(runningTitle.getAttribute("title")!.includes(`${model.provider}/${model.id}`));
    const master = failed({ target: { kind: "master-look", id: FIXTURE_WORLD_ID }, provider: model.provider, model: model.id });
    const text = parseHTML(render([master])).document.querySelector(".dom-jobrow")!.textContent!;
    assert.match(text, /Master look · The Undersong/);
    assert.ok(text.includes(model.displayName));
    assert.ok(!text.includes(FIXTURE_WORLD_ID));
    const shot = failed({ productionId: production.meta.id, target: { kind: "shot", id: orderedShots(production.scenes[0]!)[0]!.id } });
    assert.ok(activityJobLabels(state, shot).target.includes(production.meta.title));
    assert.ok(activityJobLabels(state, shot).target.includes(state.world!.meta.name));
    for (const kind of ["scene-pass", "storyboard"] as const) {
      const scene = production.scenes[0]!;
      const label = activityJobLabels(state, { ...shot, target: { kind, id: scene.id, coversShots: orderedShots(scene).map((candidate) => candidate.id) } }).target;
      assert.ok(label.startsWith(scene.title));
      assert.ok(!label.includes(orderedShots(scene)[0]!.title));
    }
    const scene = production.scenes[0]!;
    const speaker = state.world!.sheets.find((candidate) => candidate.type === "character")!;
    const performanceTarget = { productionId: production.meta.id, sceneId: scene.id, sceneVersion: scene.version,
      shotId: orderedShots(scene)[0]!.id, speakerSheetId: speaker.id, authoredTextHash: `sha256:${"a".repeat(64)}` };
    for (const kind of ["table-read-cache", "performance-generation", "performance-conversion"] as const) {
      const params = kind === "table-read-cache" ? { tableReadSceneId: scene.id, tableReadSpeakerSheetId: speaker.id }
        : { [kind === "performance-generation" ? "performanceGeneration" : "performanceConversion"]: { target: performanceTarget } };
      const label = activityJobLabels(state, { ...shot, target: { kind, id: "pf_opaque" }, params }).target;
      assert.ok(label.includes(speaker.name), label);
      assert.ok(label.includes(`Scene ${scene.number}`), label);
      assert.ok(label.includes(kind === "table-read-cache" ? scene.title : orderedShots(scene)[0]!.title), label);
    }
    const other = { ...shot, worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD" };
    assert.ok(!activityJobLabels(state, other).target.includes(production.meta.title));
  });
  it("sends a failed character look to the looks screen, not to a production it does not have", () => {
    const html = render([failed({})]);
    assert.ok(html.includes("run it again from the looks screen"), "the row names where this one came from");
    assert.equal(
      html.includes("production's dispatch dialog"),
      false,
      "the character's own page reads 0 productions; that dialog does not exist for this job",
    );
  });

  it("still sends production work to its production's dispatch dialog", () => {
    const html = render([
      failed({ productionId: "saltlight", target: { kind: "shot", id: "sh_12", coversShots: ["sh_12"] } }),
    ]);
    assert.ok(html.includes("run it again from its production's dispatch dialog"));
  });

  it("offers the destination as a control, so the row is not a dead end", () => {
    // The issue's own account: "the reference screen offers no retry either, so the row is a
    // dead end". A named place the user still has to go and find is only half an answer.
    for (const [job, label] of [
      [failed({}), "Looks"],
      [failed({ target: { kind: "main-photo-candidate", id: "maren-kest/g/2" } }), "Main photo"],
      [failed({ target: { kind: "character-sheet", id: "maren-kest/g" } }), "Character sheet"],
    ] as const) {
      const html = render([job]);
      assert.ok(html.includes(`>${label}</button>`), `${label} is a button on the row`);
    }
  });

  it("says nothing about where rather than naming somewhere wrong", () => {
    // No production and a kind Activity cannot place: the row states the failure and stops.
    const html = render([failed({ target: { kind: "extraction", id: "af_1" } })]);
    assert.ok(html.includes("run it again from wherever you started it"));
    assert.equal(html.includes("dispatch dialog"), false);
  });

  it("leaves succeeded work alone — a retry line belongs to a failure", () => {
    const html = render([failed({ status: "succeeded", error: null })]);
    assert.equal(html.includes("run it again"), false);
  });
});

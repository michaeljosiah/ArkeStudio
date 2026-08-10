import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, Job } from "@arke-studio/contracts";
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

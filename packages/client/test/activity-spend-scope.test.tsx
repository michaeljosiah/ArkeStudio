import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, LedgerEntry } from "@arke-studio/contracts";
import { ActivityScreen } from "../src/screens/shell.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * What the spend figure is counting (issue 305 §8).
 *
 * Activity opens on the active world, and every other collection on the screen — running work,
 * what needs you, today's history, the founding builds — is filtered to it. Spend was not: it
 * summarised the whole app ledger under a heading that says nothing about scope, so a world with
 * one cheap bench take read as whatever every other world had spent that week.
 *
 * Bench jobs already carry `worldId` and omit `productionId`, so their entries were world-owned
 * on disk the whole time. This is about the screen reading that.
 *
 * `spendSummary` itself is unit-tested in the contracts suite; this is about which entries reach
 * it. The threshold alert is deliberately not asserted here — it is one app-wide rolling total
 * from one app setting, and scoping it would make the alert disagree with what triggered it.
 */

// Inside the default 7-day window, wherever this runs.
const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const OTHER_WORLD_ID = "01J8E9000000000000000000W2";

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    ts: RECENT,
    worldId: FIXTURE_WORLD_ID,
    jobId: "jb_01J8E0000000000000000000K1",
    provider: "fal",
    model: "seedance-2.0",
    outcome: "succeeded",
    estimatedMicroUsd: 250_000,
    actualMicroUsd: 250_000,
    actualSource: "provider-reported",
    ...overrides,
  };
}

function render(ledger: LedgerEntry[]): string {
  const state: ClientState = { ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, ledger } };
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter>
      <ActivityScreen />
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

describe("Activity spend obeys the screen's world scope (issue 305 §8)", () => {
  it("counts the active world's entries and leaves another world's money out of the total", () => {
    const html = render([
      entry({ actualMicroUsd: 250_000 }),
      entry({
        jobId: "jb_01J8E0000000000000000000K2",
        worldId: OTHER_WORLD_ID,
        provider: "openai",
        model: "gpt-image-2",
        actualMicroUsd: 4_000_000,
      }),
    ]);
    assert.ok(html.includes("$0.25"), "the total is this world's $0.25");
    assert.equal(html.includes("$4.25"), false, "not this world's spend plus another world's");
    assert.equal(
      html.includes("openai"),
      false,
      "the other world's provider does not appear as a bar on this world's spend",
    );
  });

  it("counts a bench take, which is world-owned without belonging to a production", () => {
    const html = render([entry({ productionId: undefined, actualMicroUsd: 250_000 })]);
    assert.ok(html.includes("$0.25"), "a bench take's spend is the world's spend");
  });

  it("shows nothing spent when this world's work is all in another world's ledger", () => {
    const html = render([entry({ worldId: OTHER_WORLD_ID, actualMicroUsd: 4_000_000 })]);
    assert.ok(html.includes("$0.00"), "no entries in scope is $0.00, not another world's figure");
  });
});

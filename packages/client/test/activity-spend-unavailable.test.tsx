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
 * The spend surfaces state a failed ledger read (SPEC-032 R-13; SPEC-008 R-19).
 *
 * Settings · Diagnostics said the spend ledger could not be read while this panel rendered a
 * clean $0.00 over the same failure — the fact/screen disagreement R-13 forbids. Two caveats,
 * each keyed to its own read: the total's source note follows the published list (`app.
 * ledgerUnavailable`, latched to the seed), the alert row follows the status's own evaluation
 * (`app.spend.ledgerUnavailable`, re-read per append). A ledger that is merely empty renders
 * exactly as before — absence is not failure.
 */

// Inside the default 7-day window, wherever this runs.
const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

function entry(): LedgerEntry {
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
  };
}

function render(over: Partial<ClientState["app"]>): string {
  const state: ClientState = { ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, ...over } };
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter>
      <ActivityScreen />
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

const unavailableSpend = (ledgerUnavailable: boolean) => ({
  settings: { thresholdMicroUsd: 50_000_000, periodDays: 7 },
  rollingMicroUsd: 0,
  alerted: false,
  ledgerUnavailable,
});

describe("Activity spend states a failed ledger read (SPEC-032 R-13)", () => {
  it("an unreadable ledger caveats the total and the alert row — no clean $0.00, no quiet Alert at", () => {
    const html = render({ ledger: [], ledgerUnavailable: true, spend: unavailableSpend(true) });
    assert.ok(html.includes("ledger could not be read"), "the source note states the failed read");
    assert.equal(html.includes("provider-reported"), false, "no source split over a record that was not read");
    assert.ok(html.includes("not evaluated"), "the alert row does not render an all-clear off a rolling zero");
  });

  it("a merely empty ledger renders exactly as before — absence is not failure", () => {
    const html = render({ ledger: [], ledgerUnavailable: false, spend: unavailableSpend(false) });
    assert.ok(html.includes("$0.00"), "nothing recorded is a true zero");
    assert.equal(html.includes("ledger could not be read"), false);
    assert.equal(html.includes("not evaluated"), false);
    assert.ok(html.includes("Alert at"), "the threshold row keeps its quiet state");
  });

  it("entries appended after a failed seed keep their figure, under the caveat — a lower bound, never a clean total", () => {
    const html = render({ ledger: [entry()], ledgerUnavailable: true, spend: unavailableSpend(true) });
    assert.ok(html.includes("$0.25"), "money the session did record is not hidden");
    assert.ok(html.includes("ledger could not be read"), "and the note says the record behind it is short");
  });

  it("an off threshold stays off — a disabled alert asks nothing of the ledger", () => {
    const html = render({
      ledger: [],
      ledgerUnavailable: true,
      spend: { ...unavailableSpend(true), settings: { thresholdMicroUsd: 0, periodDays: 7 } },
    });
    assert.ok(html.includes("· off"), "off outranks not-evaluated");
    assert.equal(html.includes("not evaluated"), false);
  });
});

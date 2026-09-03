import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __setStateForTest, type CanonRefsState } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

const ENTRY = "CANON-002";

function render(canonRefs: Record<string, CanonRefsState>): string {
  __setStateForTest(FIXTURE_STATE, { canonRefs });
  return renderToString(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/canon/${ENTRY}`]}>
      <App />
    </MemoryRouter>,
  );
}

function detail(history: CanonRefsState["history"], historyTruncated: boolean): Record<string, CanonRefsState> {
  return {
    [ENTRY]: {
      citedBy: { sheets: [], entries: [], productions: [] },
      history,
      historyTruncated,
      canonRevision: 4,
      ripples: [],
    },
  };
}

const change = (source: string) => ({
  ts: "2026-08-26T11:00:00.000Z",
  entity: `canon/${ENTRY}`,
  source,
  canonRevisionAfter: 4,
});

describe("the entry's History panel", () => {
  it("says nothing about history until the answer arrives", () => {
    // It used to read a tail of the world's changes, which is present the moment the world is —
    // so "no recorded changes yet" was safe to render immediately. Now it is an answer to a
    // question still in flight, and claiming an empty history before it lands is the same
    // untruth this issue is about, just briefer.
    const html = render({});
    assert.ok(!html.includes("no recorded changes yet"), "no verdict before there is an answer");
  });

  it("says an entry has no history only once told so", () => {
    assert.ok(render(detail([], false)).includes("no recorded changes yet"));
  });

  it("says when it is showing a window of a longer history", () => {
    const html = render(detail([change("form")], true));
    assert.ok(html.includes("older changes not shown"), "a bounded list must not read as the whole");
  });

  it("says nothing extra when the history is complete", () => {
    assert.ok(!render(detail([change("form")], false)).includes("older changes not shown"));
  });
});

/*
 * The entry's own controls say what they do (issue 747, after the same fix on Art direction).
 * `Accept amendment` lands on the press — the coordinator runs it as a single act — so a door
 * called "Propose a change", and a note promising the change would be proposed first, both set
 * up a review step nothing here queues.
 */
describe("the entry's amendment vocabulary", () => {
  it("opens the amendment form with a label that matches what committing there does", () => {
    const html = render(detail([change("form")], false));
    assert.ok(html.includes("Amend this entry"), "the door says what pressing it does");
    assert.ok(!html.includes("Propose a change"), "and no longer promises a review that never comes");
  });

  it("describes the ripple check as the single act it is", () => {
    const html = render({
      [ENTRY]: {
        citedBy: { sheets: [], entries: [], productions: [] },
        history: [],
        historyTruncated: false,
        canonRevision: 4,
        ripples: [{ kind: "sheet", summary: "Maren Kest cites this", targets: ["sheets/maren-kest.md"] }],
      },
    });
    assert.ok(html.includes("ripple-checked, then versioned"), "the ripple note is still there");
    assert.ok(!html.includes("a change is proposed"), "but no longer names a step the press skips");
  });
});

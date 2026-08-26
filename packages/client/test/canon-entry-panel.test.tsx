import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

const ENTRY = "CANON-002";

function render(canonRefs: Record<string, unknown>): string {
  __setStateForTest(FIXTURE_STATE, { canonRefs });
  return renderToString(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/canon/${ENTRY}`]}>
      <App />
    </MemoryRouter>,
  );
}

function detail(history: unknown[], historyTruncated: boolean): Record<string, unknown> {
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

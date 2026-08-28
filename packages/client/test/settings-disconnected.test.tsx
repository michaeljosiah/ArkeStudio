import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Settings with no coordinator behind them (issue 599).
 *
 * Every pane in Settings draws from the coordinator's snapshot, and with no snapshot they draw
 * `—` in the capability rows and `not measured` in the machine header — the same screen a
 * provider with nothing to offer produces. A dev coordinator that died at import renders
 * exactly that, which reads as a data bug in whatever you last changed. One line at the top of
 * the pane is the difference between "nothing is configured" and "nothing is connected".
 */

const plain = (html: string): string => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");

function render(path: string, connection: "connecting" | "open" | "closed"): string {
  __setStateForTest(FIXTURE_STATE, { connection });
  return plain(
    renderToString(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    ),
  );
}

describe("Settings without a coordinator", () => {
  it("says the rows are blank because nothing is connected", () => {
    assert.match(render("/settings/local-ai", "closed"), /Waiting for the coordinator/);
  });

  it("says it while the connection is still being made, not only after it fails", () => {
    // "connecting" is the state a browser dev session sits in for as long as nothing is
    // listening on 8791 — a dead coordinator never produces a close event to wait for.
    assert.match(render("/settings/local-ai", "connecting"), /Waiting for the coordinator/);
  });

  it("carries the line on whichever pane you opened", () => {
    assert.match(render("/settings/cloud-ai", "closed"), /Waiting for the coordinator/);
    assert.match(render("/settings/providers", "closed"), /Waiting for the coordinator/);
  });

  it("stays out of the way once connected", () => {
    assert.doesNotMatch(render("/settings/local-ai", "open"), /Waiting for the coordinator/);
  });
});

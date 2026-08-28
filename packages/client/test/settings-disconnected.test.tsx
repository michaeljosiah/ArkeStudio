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
 * Most panes in Settings draw from the coordinator's snapshot, and with no snapshot they draw
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
  it("says so rather than leaving the rows to be read as empty data", () => {
    assert.match(render("/settings/local-ai", "closed"), /Waiting for the coordinator/);
  });

  it("carries the line on whichever pane you opened", () => {
    assert.match(render("/settings/cloud-ai", "closed"), /Waiting for the coordinator/);
    assert.match(render("/settings/providers", "closed"), /Waiting for the coordinator/);
  });

  it("says the same thing the startup screen says, in the same words", () => {
    // Three screens wait on this and there is one sentence between them. A second wording would
    // read as a second condition.
    assert.match(render("/settings/local-ai", "closed"), /dev browser session/);
  });

  it("stays quiet while the first connection is still being attempted", () => {
    // A refused socket reaches "closed" of its own accord — devBridge emits it from the socket's
    // own close event — so there is nothing to gain from announcing the gap before then, and a
    // banner that flashes on every launch is one nobody reads.
    assert.doesNotMatch(render("/settings/local-ai", "connecting"), /Waiting for the coordinator/);
  });

  it("stays out of the way once connected", () => {
    assert.doesNotMatch(render("/settings/local-ai", "open"), /Waiting for the coordinator/);
  });
});

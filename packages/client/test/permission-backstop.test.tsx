import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { PermissionBackstops } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

describe("permission backstops", () => {
  it("renders without an open world so genesis and setup asks are reachable", () => {
    __setStateForTest(FIXTURE_STATE, {
      permissions: {
        p1: {
          actionClass: "future-tool",
          description: "The agent wants to use a capability Studio does not recognise yet",
          rememberable: false,
        },
      },
    });
    const html = renderToString(<PermissionBackstops />);
    assert.match(html, /does not recognise yet/);
    assert.match(html, /Allow once/);
    assert.doesNotMatch(html, /Always allow/);
    assert.match(html, /aria-live="assertive"/);
  });
});

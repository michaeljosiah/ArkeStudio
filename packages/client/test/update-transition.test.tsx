import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateTransition } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

afterEach(() => __setStateForTest(FIXTURE_STATE));

for (const [flow, detail, copy] of [
  [null, null, "Arke Studio will close."],
  [null, "Arke Studio will restart.", "Arke Studio will restart."],
  ["on-close", null, "Arke Studio will install the update and remain closed."],
  ["restart", null, "Arke Studio will install the update and reopen."],
] as const) it(`shutdown says ${copy}`, () => {
  const state = structuredClone(FIXTURE_STATE);
  state.app.update = { ...state.app.update, status: "shutting-down", flow, detail };
  __setStateForTest(state);
  const markup = renderToStaticMarkup(<UpdateTransition />);
  assert(markup.includes(copy));
  if (flow === null) assert(!markup.includes("install the update"));
});

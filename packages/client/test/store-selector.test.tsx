import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useStoreSelector, shallowEqual, __setStateForTest, __handleFrameForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("does not rerender unchanged slices or inline object selectors, but delivers changed values", async () => {
  const dom = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("root")!); let renders = 0;
  function View() {
    const slice = useStoreSelector(store => ({ version: store.state?.app.version, world: store.state?.world }), shallowEqual);
    renders++; return <div>{slice.version}</div>;
  }
  __setStateForTest(FIXTURE_STATE, { connection: "open" });
  try {
    await act(async () => root.render(<View />)); const first = renders;
    for (let seq = 1; seq <= 5; seq++) await act(async () => __handleFrameForTest({ kind: "snapshot", seq, state: structuredClone(FIXTURE_STATE) }));
    assert.equal(renders, first);
    const changed = structuredClone(FIXTURE_STATE); changed.app.version = "new-version";
    await act(async () => __handleFrameForTest({ kind: "snapshot", seq: 6, state: changed }));
    assert.equal(renders, first + 1); assert.match(document.body.textContent!, /new-version/);
  } finally { await act(async () => root.unmount()); }
});

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientState } from "@arke-studio/contracts";
import { SettingsSampleWorldScreen } from "../src/screens/shell.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const download = { version: "test-release", bytes: 1600000000, summary: "Novel illustrated; audiobook and video unfinished.", requiredBytes: 5500000000, freeBytes: 9000000000, retainedBytes: 0 };
function render(patch: Partial<ClientState["app"]["sampleWorld"]> = {}) {
  __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, sampleWorld: { available: true, installing: false, note: null, download, ...patch } } });
  return parseHTML(renderToString(<MemoryRouter><SettingsSampleWorldScreen /></MemoryRouter>)).document;
}
const button = (d: Document, text: string) => [...d.querySelectorAll("button")].find(e => e.textContent === text);
const text = (d: Document) => d.querySelector("[data-screen=settings-sample-world]")!.textContent!;
afterEach(() => __setStateForTest(FIXTURE_STATE));

it("shows release, unfinished status and required/free space before download", () => {
  const d = render();
  assert.match(text(d), /test-release/); assert.match(text(d), /audiobook and video unfinished/);
  assert.match(text(d), /5.12 GiB free needed.*8.38 GiB available/);
  assert.ok(button(d, "Download and install")); assert.ok(button(d, "Check space"));
});
it("offers cancellation only before independent installation and removal only while idle", () => {
  const running = render({ installing: true, cancellable: true, download: { ...download, retainedBytes: 400000000 } });
  assert.ok(button(running, "Cancel download")); assert.equal(button(running, "Remove downloaded data"), undefined);
  const installing = render({ installing: true, cancellable: false });
  assert.equal(button(installing, "Cancel download"), undefined); assert.ok(button(installing, "Finishing…")?.hasAttribute("disabled"));
  const retained = render({ download: { ...download, retainedBytes: 400000000 } });
  assert.ok(button(retained, "Resume and install")); assert.ok(button(retained, "Remove downloaded data"));
});
it("explains insufficient space and keeps the refresh action available", () => {
  const d = render({ download: { ...download, freeBytes: 1000000000 } });
  assert.ok(button(d, "Download and install")?.hasAttribute("disabled"));
  assert.match(text(d), /Free up space before downloading/);
  assert.equal(button(d, "Check space")?.hasAttribute("disabled"), false);
});

it("keeps removal available when saved data cannot be resumed", () => {
  const d = render({ download: { ...download, hasRetainedData: true } });
  assert.match(text(d), /Saved data cannot be resumed/);
  assert.ok(button(d, "Remove downloaded data"));
  assert.equal(button(d, "Resume and install"), undefined);
});

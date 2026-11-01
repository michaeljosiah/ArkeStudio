import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { JobStorageWait } from "@arke-studio/contracts";
import { JobStorageWaitNotice } from "../src/components/job-storage-wait.js";

const wait: JobStorageWait = { phase: "submission", reason: "unavailable", observedAt: "2026-11-01T10:00:00Z", detail: { code: "capacity-stale", roles: ["working-files"], measuredAt: Date.parse("2026-11-01T09:59:00Z") } };
const view = (value: JobStorageWait) => renderToString(<MemoryRouter><JobStorageWaitNotice wait={value} now={Date.parse("2026-11-01T10:00:00Z")} /></MemoryRouter>).replaceAll("<!-- -->", "");
it("names the local hold, evidence age and safe destination without implying generation", () => {
  const html = view(wait);
  assert.match(html, /Not submitted/); assert.match(html, /Working files/); assert.match(html, /Measured 1 minute ago/);
  assert.match(html, /has not reached the provider/); assert.match(html, /href="\/settings\/diagnostics"/);
  assert.doesNotMatch(html, /Resubmit|Available at check|Additional space/);
  assert.match(view({ ...wait, checking: true }), /Checking destination/);
});
it("keeps completed-result storage recovery separate from provider retry and shows the measured deficit", () => {
  const html = view({ ...wait, phase: "result", reason: "space", detail: { code: "space", roles: ["generated-media"], availableBytes: 1024 ** 3, deficitBytes: 2 * 1024 ** 3 } });
  assert.match(html, /Result awaiting saving/); assert.match(html, /Available at check: 1 GiB/); assert.match(html, /Additional space needed: 2 GiB/);
  assert.match(html, /generation has not been repeated/); assert.doesNotMatch(html, /not reached the provider|Resubmit/);
});

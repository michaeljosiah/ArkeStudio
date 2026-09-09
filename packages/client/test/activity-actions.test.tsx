import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage, Job } from "@arke-studio/contracts";
import { ActivityScreen } from "../src/screens/shell.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

it("keeps inspection and the two-step deletion behind the compact job actions", async () => {
  const sent: ClientMessage[] = [];
  const now = new Date().toISOString();
  const job: Job = {
    id: "jb_01J8E0000000000000000000L1", idempotencyKey: "01J8E1000000000000000000M1",
    worldId: FIXTURE_STATE.world!.meta.worldId, target: { kind: "character-look", id: "maren-kest/look/1" },
    capability: "image", provider: "openai", model: "gpt-image-2", params: {},
    estimatedMicroUsd: 150000, status: "succeeded", providerJobId: null, attempt: 1, error: null,
    createdAt: now, updatedAt: now,
  };
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {},
    send(json: string) { sent.push(JSON.parse(json)); } });
  const running: Job = { ...job, id: "jb_01J8E0000000000000000000L2", status: "running" };
  __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, jobs: [running, job] } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><ActivityScreen /></MemoryRouter>));
    const button = (label: string) => {
      const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find(b => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
      assert.ok(found, label); return found;
    };
    const inspections = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Provider calls"]')];
    assert.equal(inspections.length, 2, "running and completed jobs offer the same action");
    await act(async () => inspections[0]!.click());
    assert.ok(sent.some(m => m.kind === "list-provider-calls" && m.jobId === running.id));
    const inspect = inspections[1]!;
    assert.equal(inspect.title, "Provider calls");
    assert.ok(inspect.closest(".fy-activityrow__summary"));
    await act(async () => inspect.click());
    assert.ok(sent.some(m => m.kind === "list-provider-calls" && m.jobId === job.id));
    await act(async () => button("Delete").click());
    assert.ok(!sent.some(m => m.kind === "delete-job"), "the icon only opens confirmation");
    assert.match(container.textContent!, /ledger entry and anything it produced stay/);
    await act(async () => button("Keep").click());
    assert.ok(!sent.some(m => m.kind === "delete-job"), "cancelling sends nothing");
    await act(async () => button("Delete").click());
    await act(async () => button("Delete").click());
    assert.equal(sent.filter(m => m.kind === "delete-job" && m.jobId === job.id).length, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove(); __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  }
});

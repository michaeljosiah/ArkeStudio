import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { storageByteLabel as bytes, type CleanupPlan, type CleanupStatus, type WorldCleanupAnswer, type WorldCleanupCommand, type WorldCleanupOp } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { WorldCleanupButton } from "../src/components/world-cleanup.js";
import { __handleFrameForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body><div id='test'></div></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

const PLAN_ID = "cp_01JD0000000000000000000000", HELD_ID = "cp_01JC0000000000000000000000";
const MiB = 1024 * 1024;
const plan: CleanupPlan = {
  id: PLAN_ID, madeAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  classes: [
    { class: "bench-copies", state: "offered", items: 2, bytes: 300 * MiB, holdDays: 0 },
    { class: "stale-mixes", state: "offered", items: 1, bytes: 300 * MiB, holdDays: 0 },
    { class: "old-exports", state: "offered", items: 2, bytes: 3000 * MiB, holdDays: 7 },
    { class: "unused-artifacts", state: "stopped", stoppedBy: "Publish draft unreadable", items: 0, bytes: 0, holdDays: 30 },
  ],
  items: [
    { id: "ci_1", class: "bench-copies", label: "Club booth, take 4", paths: ["bench/a.png"], bytes: 100 * MiB, ticked: true },
    { id: "ci_2", class: "bench-copies", label: "Car at night", paths: ["bench/b.png"], bytes: 200 * MiB, ticked: true },
    { id: "ci_3", class: "stale-mixes", label: "Chapter 1 mix", paths: ["mixes/1.wav"], bytes: 300 * MiB, ticked: true },
    { id: "ci_4", class: "old-exports", label: "Audiobook · chapter 1", paths: ["exports/a.zip"], bytes: 1000 * MiB, covers: "Book · 11 Oct", ticked: false },
    { id: "ci_5", class: "old-exports", label: "Audiobook · chapters 1–2", paths: ["exports/b.zip"], bytes: 2000 * MiB, ticked: false },
  ],
  problems: [{ kind: "last-copy", label: "Bench pictures", count: 137, bytes: 366 * MiB, putBack: true }],
  retiredWithoutMedia: 1178,
};
const idle: CleanupStatus = { run: null, running: false, held: [], refusal: null, autoMixes: false };

let root: Root | undefined, seq = 1000;
afterEach(async () => { if (root) { await act(async () => root!.unmount()); root = undefined; } __setBridgeForTest(null); });

/** A coordinator that answers each op from `reply` a microtask later, as a socket would. */
function mount(reply: (request: WorldCleanupOp) => WorldCleanupAnswer) {
  const sent: WorldCleanupOp[] = [];
  __setBridgeForTest({ platform: "test", appVersion: "test", connect() {}, subscribe() { return () => {}; }, send(message: string) {
    const command = JSON.parse(message) as WorldCleanupCommand;
    if (command.kind !== "world-cleanup") return;
    assert.equal(command.worldId, FIXTURE_STATE.world!.meta.worldId);
    sent.push(command.request);
    queueMicrotask(() => __handleFrameForTest({ kind: "world-cleanup", seq: ++seq, requestId: command.requestId, answer: reply(command.request) }));
  } } as ArkeBridge);
  __setStateForTest(structuredClone(FIXTURE_STATE), { connection: "open" });
  return sent;
}
const sheet = () => dom.document.querySelector("dialog")!;
const button = (text: string) => [...dom.document.querySelectorAll("button")].find(node => node.textContent?.trim() === text || node.getAttribute("aria-label") === text)!;
const tick = (name: string) => dom.document.querySelector(`input[aria-label="${name}"]`) as unknown as HTMLInputElement;
const totals = () => [...sheet().querySelectorAll(".fy-cleanup-totals b")].map(node => node.textContent);
async function click(node: Element) { await act(async () => { node.dispatchEvent(new dom.Event("click", { bubbles: true })); }); }
async function flip(input: HTMLInputElement) { input.checked = !input.checked; await click(input as unknown as Element); }

it("plans on opening, ticks by default, and totals what is ticked", async () => {
  const sent = mount(request => request.op === "plan" ? { ok: true, plan, status: idle } : { ok: true, status: idle });
  root = createRoot(dom.document.getElementById("test")!);
  await act(async () => root!.render(<WorldCleanupButton />));
  await click(button("Clean up world"));
  assert.deepEqual(sent, [{ op: "plan" }]);
  assert.match(sheet().textContent!, /The Undersong/);
  assert.equal(tick("Bench copies").checked, true);
  assert.equal(tick("Old chapter mixes").checked, true);
  assert.equal(tick("Old exports").checked, false);
  assert.equal(tick("Unused artifacts"), null, "a stopped class has no tick");
  assert.match(sheet().textContent!, /Publish draft unreadable/);
  assert.match(sheet().textContent!, /Put back on shelf/);
  assert.match(sheet().textContent!, /Retired, no file · 1,178/);
  assert.deepEqual(totals(), [bytes(600 * MiB), bytes(600 * MiB)]);
  assert.match(sheet().querySelector(".fy-page-sheet__foot")!.textContent!, /3 items/);

  // A hold counts in After hold only; unticking a link takes it out of both.
  await flip(tick("Old exports"));
  assert.deepEqual(totals(), [bytes(600 * MiB), bytes(3600 * MiB)]);
  await flip(tick("Bench copies"));
  assert.deepEqual(totals(), [bytes(300 * MiB), bytes(3300 * MiB)]);

  // One item of a class ticks it in part.
  await click(button("Show Old exports"));
  assert.match(sheet().textContent!, /Newer: Book · 11 Oct/);
  await flip(tick("Audiobook · chapters 1–2"));
  assert.equal(tick("Old exports").getAttribute("aria-checked"), "mixed");
  assert.match(sheet().textContent!, /1 of 2/);
  assert.deepEqual(totals(), [bytes(300 * MiB), bytes(1300 * MiB)]);
});

it("confirms by action and runs the ticked ids", async () => {
  const ended: CleanupStatus = { ...idle, run: { planId: PLAN_ID, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), done: 3, total: 3,
    cleared: 300 * MiB, held: 1000 * MiB, holdUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), availableBefore: 1000 * MiB, availableAfter: 1300 * MiB,
    classes: [{ class: "stale-mixes", done: 1, skipped: 0, failed: 0, bytes: 300 * MiB, reasons: [] }, { class: "old-exports", done: 1, skipped: 1, failed: 0, bytes: 1000 * MiB, reasons: ["In use"] }] } };
  const sent = mount(request => request.op === "plan" ? { ok: true, plan, status: idle } : request.op === "run" ? { ok: true, status: ended } : { ok: true, status: idle });
  root = createRoot(dom.document.getElementById("test")!);
  await act(async () => root!.render(<WorldCleanupButton />));
  await click(button("Clean up world"));
  await flip(tick("Bench copies"));
  await click(button("Show Old exports"));
  await flip(tick("Audiobook · chapter 1"));
  await click(button("Clean up…"));
  const lines = [...sheet().querySelectorAll(".fy-cleanup-line")].map(node => node.textContent);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^Clear1 · Old chapter mixes/);
  assert.match(lines[1]!, /^Hold1 · Old exports.*Until/);
  await click(button("Clean up"));
  assert.deepEqual(sent.at(-1), { op: "run", planId: PLAN_ID, items: ["ci_3", "ci_4"] });
  assert.match(sheet().textContent!, /Drive gained/);
  assert.match(sheet().textContent!, /1 held · 1 skipped/);
  assert.match(sheet().textContent!, /In use/);
  await click(button("Done"));
  assert.deepEqual(sent.slice(-2), [{ op: "dismiss" }, { op: "plan" }]);
});

it("restores a held item from the Held tab, and keeps a blocked one held", async () => {
  const status: CleanupStatus = { ...idle, held: [{ planId: HELD_ID, madeAt: new Date().toISOString(), holdUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    goesAfter: new Date(Date.now() + 8 * 86_400_000).toISOString(), state: "held", bytes: 3000 * MiB, items: [
      { id: "ci_7", class: "old-exports", label: "Music video", bytes: 1000 * MiB },
      { id: "ci_8", class: "old-exports", label: "Chapter film", bytes: 2000 * MiB, blocked: "Name taken" }] }] };
  const sent = mount(request => request.op === "plan" ? { ok: true, plan, status } : { ok: true, status });
  root = createRoot(dom.document.getElementById("test")!);
  await act(async () => root!.render(<WorldCleanupButton />));
  await click(button("Clean up world"));
  await click([...sheet().querySelectorAll("[role=tab]")].find(node => node.textContent?.startsWith("Held"))!);
  assert.deepEqual(totals(), [bytes(3000 * MiB)]);
  await click(sheet().querySelector(".fy-cleanup-held .fy-cleanup-open")!);
  const restores = [...sheet().querySelectorAll("button")].filter(node => node.textContent === "Restore");
  assert.equal(restores.length, 2);
  assert.equal(restores[1]!.hasAttribute("disabled"), true);
  assert.match(sheet().textContent!, /Name taken/);
  await click(restores[0]!);
  assert.deepEqual(sent.at(-1), { op: "restore", planId: HELD_ID, items: ["ci_7"] });
  await click(button("Empty now"));
  assert.match(sheet().textContent!, /Can’t be undone/);
  await click([...sheet().querySelectorAll(".fy-page-sheet__foot button")].find(node => node.textContent === "Empty now")!);
  assert.deepEqual(sent.at(-1), { op: "empty", planId: HELD_ID });
});

it("keeps the plan readable and Clean up… off when the world refuses a run", async () => {
  mount(() => ({ ok: true, plan, status: { ...idle, refusal: "outside-edits" } }));
  root = createRoot(dom.document.getElementById("test")!);
  await act(async () => root!.render(<WorldCleanupButton />));
  await click(button("Clean up world"));
  assert.match(sheet().textContent!, /Outside edits · Adopt first/);
  assert.equal(button("Clean up…").hasAttribute("disabled"), true);
});

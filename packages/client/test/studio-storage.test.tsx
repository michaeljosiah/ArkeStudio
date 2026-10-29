import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { JobSchema, SetupStatusSchema, STORAGE_CATEGORIES, StorageInventorySchema, type JobSummary } from "@arke-studio/contracts";
import type { StorageHealthSnapshot, StorageRootHealth, StorageSpaceCheck } from "@arke-studio/contracts";
import { StudioStorageReadingsView } from "../src/components/studio-storage.js";

const now = 120_000, gib = 1024 ** 3;
const root: StorageRootHealth = { rootId: "media", role: "generated-media", state: "measured", source: "host-provided", limitations: [], pressure: null, forecast: null,
  capacity: { volumeId: "volume-a", mappingRevision: "mount-a", measuredAt: now, availableBytes: 2 * gib, totalBytes: 500 * gib } };
const view = (roots: StorageRootHealth[], at = now, connected = true, limited = false) => {
  const health: StorageHealthSnapshot = { at: now, writing: false, roots, limited };
  return parseHTML(renderToString(<StudioStorageReadingsView health={health} connected={connected} now={at} />)).document;
};
const facts = (card: Element) => [...card.querySelectorAll("dt")].map(term => [term.textContent, term.nextElementSibling?.textContent]);

it("offers the existing model review only for a current installed removable model", () => {
  const component = { id: "model", displayName: "Narrator", purpose: "Reading", sizeMb: 100, installLocation: "fixture", state: "present", removable: true, provides: ["narrator"] };
  for (const [connected, rows, offered] of [[true, [component], true], [false, [component], false], [true, [{ ...component, removable: false }], false], [true, [{ ...component, state: "available" }], false]] as const) {
    const setup = SetupStatusSchema.parse({ components: rows, running: false, diskFreeMb: null });
    const document = parseHTML(renderToString(<MemoryRouter><StudioStorageReadingsView connected={connected} now={now} setup={setup} /></MemoryRouter>)).document;
    assert.equal(document.querySelector('a[href="/settings/models?half=local"]') !== null, offered);
  }
});

it("keeps partial inventory separate from drive capacity, shows unknown categories and labels old file estimates", () => {
  const inventory = StorageInventorySchema.parse({ scanning: false, allocatedBytes: null, reclaimableBytes: null,
    categories: STORAGE_CATEGORIES.map(category => ({ category, state: category === "artifacts" ? "partial" : "unmeasured",
      logicalBytes: category === "artifacts" ? 2 * gib : null, files: category === "artifacts" ? 2 : null, measuredAt: category === "artifacts" ? now : null })) });
  const document = parseHTML(renderToString(<StudioStorageReadingsView connected now={now} health={{ at: now, writing: false, roots: [root], inventory }} />)).document;
  const detail = document.querySelector("details")!;
  assert.equal(detail.hasAttribute("open"), false); assert.equal(facts(detail).length, 7);
  assert.deepEqual(facts(detail)[0], ["Artifacts", "2 GiB · partial"]);
  assert.deepEqual(facts(detail)[3], ["Models", "Unknown"]);
  assert.match(detail.textContent!, /closed worlds are not included.*Shared files may be counted more than once.*Recoverable space is unknown/);
  assert.deepEqual(facts(document.querySelector(".fy-studio-fact-card")!)[0], ["Available", "2 GiB"]);
  const stale = renderToString(<StudioStorageReadingsView connected={false} now={now} health={{ at: now, writing: false, roots: [], inventory }} />);
  assert.match(stale, /partial.*last measured/); assert.doesNotMatch(stale, /Free 2 GiB|Remove files/);
});

it("shows separate measured volumes and shares alias capacity without inventing an operation shortfall", () => {
  const document = view([root, { ...root, rootId: "working", role: "working-files", capacity: { ...root.capacity!, mappingRevision: "mount-b", availableBytes: 7 * gib } },
    { ...root, rootId: "exports", role: "exports", capacity: { ...root.capacity!, volumeId: "volume-b", availableBytes: 60 * gib } }]);
  const cards = document.querySelectorAll(".fy-studio-fact-card"); assert.equal(cards.length, 2);
  assert.match(cards[0]!.textContent!, /Storage needs attentionWorld media · Working files/);
  assert.deepEqual(facts(cards[0]!), [["Available", "2 GiB"], ["Drive capacity", "500 GiB"], ["Working reserve", "1 GiB"]]);
  assert.deepEqual(facts(cards[1]!), [["Available", "60 GiB"], ["Drive capacity", "500 GiB"]]);
  assert.doesNotMatch(document.toString(), /Export is waiting|Additional space needed|9 GiB|62 GiB|volume-a|mount-a/);
  assert.equal(document.querySelectorAll("button").length, 0, "readings grant no action authority");
});

it("keeps stale and disconnected measurements historical, and missing or future capacity unknown", () => {
  for (const document of [view([root], now + 60_001), view([root], now, false), view([{ ...root, state: "unavailable" }])]) {
    assert.deepEqual(facts(document.querySelector(".fy-studio-fact-card")!), [["Last measured available", "2 GiB"], ["Drive capacity", "500 GiB"]]);
    assert.match(document.toString(), /Current available space is unknown/);
    assert.doesNotMatch(document.toString(), /Storage needs attention|Working reserve/);
  }
  for (const capacity of [null, { ...root.capacity!, measuredAt: now + 1 }, { ...root.capacity!, availableBytes: null, totalBytes: null }]) {
    const document = view([{ ...root, capacity }]);
    assert.deepEqual(facts(document.querySelector(".fy-studio-fact-card")!), [["Last measured available", "Unknown"], ["Drive capacity", "Unknown"]]);
    assert.doesNotMatch(document.toString(), /Storage needs attention|0 bytes/);
  }
  assert.match(view([]).toString(), /Storage readings unavailable/);
});

it("discloses incomplete aliases, quotas and bounded scope while retaining a real zero reading", () => {
  const document = view([{ ...root, capacity: { ...root.capacity!, availableBytes: 0 } },
    { ...root, rootId: "other", state: "stale", limitations: ["quota-unavailable"] }], now, true, true);
  assert.equal(document.querySelectorAll(".fy-studio-fact-card").length, 1);
  assert.deepEqual(facts(document.querySelector(".fy-studio-fact-card")!)[0], ["Available", "0 bytes"]);
  assert.match(document.querySelector("section")!.textContent!, /1 destination has stale or unavailable readings/);
  assert.match(document.toString(), /separate storage quota is unknown/);
  assert.match(document.toString(), /Some destinations are outside this measurement summary/);
});

it("shows actual per-drive check arithmetic as historical evidence, never as a current waiting job or retry action", () => {
  const check: StorageSpaceCheck = { id: "private-check", checkedAt: now, purpose: "export", volumes: [
    { volumeId: "private-drive", measuredAt: now, roles: ["generated-media", "exports"], status: "held", availableBytes: 6 * gib, reservedBytes: gib, peakBytes: 8 * gib, reserveBytes: gib, deficitBytes: 4 * gib },
    { volumeId: "private-scratch", measuredAt: now, roles: ["working-files"], status: "fits", availableBytes: 60 * gib, reservedBytes: 0, peakBytes: 2 * gib, reserveBytes: gib, deficitBytes: 0 },
  ] };
  const render = (connected = true, at = now, purpose = check.purpose) => parseHTML(renderToString(<StudioStorageReadingsView connected={connected} now={at}
    health={{ at: now, writing: false, roots: [], spaceChecks: [{ ...check, purpose }] }} />)).document;
  for (const document of [render(), render(false), render(true, now + 60_001)]) {
    const card = document.querySelector(".fy-studio-fact-card")!;
    assert.deepEqual(facts(card), [["Available at check", "6 GiB"], ["Already committed", "1 GiB"], ["Estimated remaining writes", "8 GiB"], ["Working reserve", "1 GiB"], ["Additional space needed", "4 GiB"],
      ["Available at check", "60 GiB"], ["Already committed", "0 bytes"], ["Estimated remaining writes", "2 GiB"], ["Working reserve", "1 GiB"], ["Additional space needed", "0 bytes"]]);
    assert.match(card.textContent!, /Export space check.*World media · Exports.*Working files/);
    assert.match(card.textContent!, /Figures describe that check/);
    assert.doesNotMatch(document.toString(), /Export is waiting|private-|66 GiB/); assert.equal(document.querySelectorAll("button").length, 0);
  }
  assert.match(render(true, now, "submission").toString(), /Minimum preparation space.*Generated media may need more space/);
  for (const at of [now - 1, now + 15 * 60_000 + 1]) assert.doesNotMatch(render(true, at).toString(), /Export space check|Additional space needed/);
});

it("shows current queue/download holds separately from measured space and makes disconnected counts historical", () => {
  const at = new Date(now).toISOString();
  const job: JobSummary = { ...JobSchema.parse({ id: "jb_01J8F3K2QW9VZX4N7M0RTYB6HC", idempotencyKey: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", target: { kind: "shot" }, provider: "fixture", model: "fixture", capability: "image",
    estimatedMicroUsd: 0, status: "queued", createdAt: at, updatedAt: at }), storageWait: { phase: "submission", reason: "space", observedAt: at } };
  const result: JobSummary = { ...job, id: "jb_01J8F3K2QW9VZX4N7M0RTYB6HD", status: "running", storageWait: { phase: "result", reason: "unavailable", observedAt: at } };
  const setup = SetupStatusSchema.parse({ running: false, diskFreeMb: 0, components: [{ id: "model", displayName: "Fixture model", purpose: "Fixture", sizeMb: 1, installLocation: "PRIVATE_PATH", state: "blocked", blockedBy: "disk" }] });
  for (const connected of [true, false]) {
    const document = parseHTML(renderToString(<MemoryRouter><StudioStorageReadingsView connected={connected} now={now} jobs={[job, result]} setup={setup} /></MemoryRouter>)).document;
    const card = document.querySelector(".fy-studio-fact-card")!;
    assert.match(card.textContent!, connected ? /Work awaiting storage/ : /Last reported storage waits/);
    assert.deepEqual(facts(card), [["Waiting to submit", "1 job"], ["Completed results awaiting saving", "1"], ["Downloads awaiting space", "1"]]);
    assert.match(card.textContent!, /1 job needs storage verification/);
    assert.equal(card.querySelector("button")!.textContent, "Open Activity");
    assert.equal(card.querySelector("a")!.getAttribute("href"), "/settings/downloads");
    assert.doesNotMatch(card.textContent!, /PRIVATE_PATH|Export is waiting|Additional space needed/);
    if (!connected) assert.match(card.textContent!, /Current work status is unknown/);
  }
  const settled = parseHTML(renderToString(<StudioStorageReadingsView connected now={now} jobs={[{ ...job, status: "cancelled" }, { ...result, status: "succeeded" }]} />)).document;
  assert.doesNotMatch(settled.toString(), /Work awaiting storage|Completed results awaiting saving/);
});

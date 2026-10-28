import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
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

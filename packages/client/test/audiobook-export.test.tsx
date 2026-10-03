import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import type { AudiobookDoor, AudiobookListening, ChapterSummary, ClientMessage, ClientState } from "@arke-studio/contracts";
import { AudiobookScreen } from "../src/screens/audiobook.js";
import { packageCounts, WebPackages } from "../src/components/audiobook-export.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { AudiobookExportSheet } from "../src/components/audiobook-export.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Export audiobook (design turn 186e, SPEC-047 R-72): the book as the player, a web package of the
 * chapters read whole with their pictures — counted from the plan the player plays — and the
 * world's packages listed in Publications beside the interactive and the visual novel.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1280, innerHeight: 800 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {}, showModal() {}, close() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const AT = "2026-10-03T09:00:00.000Z";
const CHAPTERS: ChapterSummary[] = [
  { id: "slack-water", file: "01-slack-water", order: 1, title: "Slack water", status: "drafted", version: 4, words: 4490, bodyHash: `sha256:${"a".repeat(64)}`, audiobook: { chapterVersion: 4, hash: "h", updatedAt: AT, takes: 3, flagged: 0 } },
  { id: "neap", file: "02-neap", order: 2, title: "Neap", status: "drafted", version: 4, words: 1900, bodyHash: `sha256:${"b".repeat(64)}`, audiobook: { chapterVersion: 4, hash: "h", updatedAt: AT, takes: 1, flagged: 0 } },
];
function inkbound(): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return { ...FIXTURE_STATE, world: { ...world, productions: [...world.productions, { ...salt, meta: { ...salt.meta, id: "inkbound", format: "story" as const, title: "Inkbound" }, story: { ...(salt.story ?? { version: 1 }), version: 3 }, chapters: CHAPTERS }] } };
}
const DOOR: AudiobookDoor = {
  reading: "narrator",
  voices: [{ name: "George", voice: { label: "George", provider: "kokoro", local: true }, state: "narrator", blocks: 4 }],
  unattributed: 0,
  rows: [
    { chapterId: "slack-water", file: "01-slack-water", order: 1, title: "Slack water", version: 4, planned: false, total: 3, made: 3, stale: 0, flagged: 0, notMade: 0, seconds: 20 },
    { chapterId: "neap", file: "02-neap", order: 2, title: "Neap", version: 4, planned: false, total: 3, made: 1, stale: 0, flagged: 0, notMade: 2, seconds: 4 },
  ],
  price: { chapters: 1, blocks: 2, cloudBlocks: 0, characters: 0, estimatedMicroUsd: 0, voices: [] },
};
const block = (key: string, at: number) => ({ key, number: 1, file: `artifacts/${key}.wav`, at, seconds: 4, sentences: [{ at, text: key }] });
const PLAN: AudiobookListening = {
  productionId: "inkbound",
  title: "Inkbound",
  cover: "world-art.png",
  chapters: [
    { chapterId: "slack-water", order: 1, title: "Slack water", state: "read", seconds: 12, blocks: [block("t", 0), block("a", 4), block("b", 8)], gaps: [], pictures: [{ key: "a", number: 2, file: "artifacts/stair.png", at: 4, seconds: 8, short: true }], opening: "world-art.png" },
    { chapterId: "neap", order: 2, title: "Neap", state: "part", seconds: 4, blocks: [block("t2", 0)], gaps: [{ at: 4, from: 2, to: 3 }], pictures: [{ key: "x", number: 3, file: "artifacts/never.png", at: 4, seconds: 0, short: true }], opening: "world-art.png" },
  ],
};

type Mounted = { container: HTMLElement; root: Root; sent: ClientMessage[] };
const open: Mounted[] = [];
async function mount(element: React.ReactElement): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(inkbound(), { connection: "open" });
    root.render(element);
  });
  const mounted = { container, root, sent };
  open.push(mounted);
  return mounted;
}
afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});
const q = (m: Mounted, selector: string) => (m.container.querySelector(selector) ?? dom.document.querySelector(selector)) as HTMLElement | null;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const press = async (el: Element | null) => {
  assert.ok(el, "the thing to press exists");
  await act(async () => void el.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
};
const lastAsk = <K extends ClientMessage["kind"]>(m: Mounted, kind: K) => m.sent.filter((message): message is Extract<ClientMessage, { kind: K }> => message.kind === kind).at(-1);

describe("Export audiobook (turn 186e)", () => {
  it("counts only the chapters read whole, and each picture once with the cover", () => {
    assert.deepEqual(packageCounts(PLAN), { chapters: 1, of: 2, pictures: 2 });
  });

  it("exports the player package from the door, and shows it in its folder", async () => {
    const m = await mount(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/inkbound/story/audiobook`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/story/audiobook" element={<AudiobookScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    const doorAsk = lastAsk(m, "open-audiobook")!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.door", requestId: doorAsk.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", door: DOOR }));
    await press(q(m, '[data-testid="audiobook-export-open"]'));
    const planAsk = lastAsk(m, "open-audiobook-listening")!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.listening", requestId: planAsk.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening: PLAN }));
    assert.match(text(q(m, '[data-testid="audiobook-export"]')), /Audiobook player\s*player\.html · 1 chapter · 2 pictures · web package/);
    assert.match(text(q(m, '[data-testid="audiobook-export"]')), /Chapters\s*1 of 2 · read whole/);
    assert.doesNotMatch(text(q(m, '[data-testid="audiobook-export"]')), /Chapter files/, "only what it will make");
    await press(q(m, '[data-testid="audiobook-export-start"]'));
    const exportAsk = lastAsk(m, "export-audiobook-player")!;
    assert.equal(exportAsk.productionId, "inkbound");
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.exported", requestId: exportAsk.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", result: { ok: true, id: "ab_x", dir: "exports/audiobook-inkbound-ab_x", file: "exports/audiobook-inkbound-ab_x/player.html", chapters: 1, pictures: 2, bytes: 3 * 1024 * 1024, joined: true } }));
    assert.equal(text(q(m, '[data-testid="audiobook-export-done"]')), "exports/audiobook-inkbound-ab_x · 1 chapter · 3 MB");
    const show = [...dom.document.querySelectorAll("button")].find((button) => text(button) === "Show in folder") ?? null;
    await press(show);
    assert.deepEqual(lastAsk(m, "open-exports-folder"), { kind: "open-exports-folder", worldId: FIXTURE_WORLD_ID, dir: "audiobook-inkbound-ab_x" });
  });

  it("finds its package again when a reconnect lost the export's answer (codex on PR 1498)", async () => {
    const production = inkbound().world!.productions.find((p) => p.meta.id === "inkbound")!;
    const m = await mount(<AudiobookExportSheet worldId={FIXTURE_WORLD_ID} production={production} onClose={() => {}} />);
    const planAsk = lastAsk(m, "open-audiobook-listening")!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.listening", requestId: planAsk.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening: PLAN }));
    await press(q(m, '[data-testid="audiobook-export-start"]'));
    const exportAsk = lastAsk(m, "export-audiobook-player")!;
    assert.match(exportAsk.exportId ?? "", /^ab_/, "the window names the package");
    await act(async () => __setStateForTest(inkbound(), { connection: "closed" }));
    await act(async () => __setStateForTest(inkbound(), { connection: "open" }));
    const listAsk = lastAsk(m, "list-web-packages")!;
    await act(async () => __applyEventForTest({ at: AT, type: "web-packages.listed", requestId: listAsk.requestId, worldId: FIXTURE_WORLD_ID, packages: [{ kind: "audiobook", productionId: "inkbound", title: "Inkbound", dir: `exports/audiobook-inkbound-${exportAsk.exportId}`, exportedAt: AT }] }));
    assert.equal(text(q(m, '[data-testid="audiobook-export-done"]')), `exports/audiobook-inkbound-${exportAsk.exportId}`);
  });

  it("lists the world's packages, the audiobook beside the interactive and the visual novel", async () => {
    const m = await mount(<WebPackages worldId={FIXTURE_WORLD_ID} />);
    const ask = lastAsk(m, "list-web-packages")!;
    await act(async () =>
      __applyEventForTest({ at: AT, type: "web-packages.listed", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, packages: [
        { kind: "audiobook", productionId: "inkbound", title: "Inkbound", dir: "exports/audiobook-inkbound-ab_x", exportedAt: AT },
        { kind: "visual-novel", productionId: "saltlight", title: "Saltlight", dir: "exports/interactive-saltlight-iv_y", exportedAt: "2026-10-02T09:00:00.000Z" },
      ] }),
    );
    const rows = [...m.container.querySelectorAll('[data-testid="web-package"]')].map((row) => text(row));
    assert.deepEqual(rows, ["InkboundAudiobook · 2026-10-03Show in folder", "SaltlightVisual novel · 2026-10-02Show in folder"]);
  });
});

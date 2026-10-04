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
    // Drawn on the body (owner, 2026-10-03): inside the title row's fy-fade-up the fixed sheet
    // was clipped to the top of the page over the head.
    const sheet = q(m, '[data-testid="audiobook-export"]')!.closest(".fy-editordialog")!;
    assert.equal(sheet.parentElement, dom.document.body as unknown as HTMLElement);
    assert.equal(sheet.closest(".fy-h1row, .fy-prodmain"), null);
    const planAsk = lastAsk(m, "open-audiobook-listening")!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.listening", requestId: planAsk.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening: PLAN }));
    assert.match(text(q(m, '[data-testid="audiobook-export"]')), /Audiobook player\s*player\.html · web package/);
    assert.match(text(q(m, '[data-testid="audiobook-export"]')), /Chapters\s*1 of 2 · read whole/);
    assert.match(text(q(m, '[data-testid="audiobook-export"]')), /Pictures\s*2 · cover where a chapter has none/);
    // Drawn where 197a draws it, and not offered: SPEC-047's own export is issue 1336.
    const files = [...dom.document.querySelectorAll("button")].find((button) => text(button).startsWith("Chapter files"))!;
    assert.equal(files.hasAttribute("disabled"), true);
    assert.match(files.getAttribute("title") ?? "", /Not built yet/);
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

describe("Export audiobook · Video (turn 197)", () => {
  const production = () => inkbound().world!.productions.find((p) => p.meta.id === "inkbound")!;
  const button = (label: string) => [...dom.document.querySelectorAll("button")].find((candidate) => text(candidate) === label) ?? null;
  const radio = (group: string, label: string) => [...dom.document.querySelectorAll(`[aria-label="${group}"] button`)].find((candidate) => text(candidate) === label) ?? null;
  async function videoSheet() {
    const m = await mount(<AudiobookExportSheet worldId={FIXTURE_WORLD_ID} production={production()} onClose={() => {}} />);
    const planAsk = lastAsk(m, "open-audiobook-listening")!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.listening", requestId: planAsk.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening: PLAN }));
    await press(q(m, '[data-testid="audiobook-export-video"]'));
    return m;
  }
  const answerState = async (m: Mounted, chapters: Array<{ chapterId: string; seconds: number; rendered: boolean }>, rates = {}) => {
    const ask = lastAsk(m, "read-audiobook-video")!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.video-state", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", state: { chapters, rates, readBy: "Read by George’s voice", running: null } }));
    return ask;
  };

  it("offers Video beside the player as 197a draws it, priced in size and time before Render", async () => {
    const m = await videoSheet();
    const ask = await answerState(m, [{ chapterId: "slack-water", seconds: 1900, rendered: false }]);
    assert.deepEqual(ask.options, { files: "chapter", shape: "1920x1080", slowPush: true, subtitles: "sidecar", captionPosition: "bottom", captionSize: "m", titleCards: true }, "the owner's defaults");
    const sheet = text(q(m, '[data-testid="audiobook-export"]'));
    for (const row of [/Files\s*One a chapterOne for the book\s*1 file/, /Shape\s*1920 × 10801280 × 7201080 × 1920 · vertical/, /Pictures\s*Slow push\s*1 picture · cover before the first/, /Subtitles\s*SidecarBurned inBothNone\s*BottomMiddle\s*SML/, /Openings\s*Chapter title cards\s*chapter markers in the file/, /Chapters\s*1 of 2 · read whole\s*Slack water/, /Audio\s*The chapter mix, as Timing sets it\s*−18 LUFS · AAC 128 kbps · 48 kHz/]) assert.match(sheet, row);
    assert.match(text(q(m, '[data-testid="audiobook-video-estimate"]')), /^~\d+ MB · ~\d+ min on this machine31:40 of video · 1 to render$/);
    assert.equal(text(q(m, '[data-testid="audiobook-video-render"]')), "Render 1 chapter");
    assert.equal(radio("Position", "Bottom")?.hasAttribute("disabled"), true, "position and size wait for burned-in words");

    // Vertical: the subtitles move to Both until the author has chosen them.
    await press(radio("Shape", "1080 × 1920 · vertical"));
    assert.deepEqual([lastAsk(m, "read-audiobook-video")!.options.shape, lastAsk(m, "read-audiobook-video")!.options.subtitles], ["1080x1920", "burn-in+sidecar"]);
    await press(radio("Subtitles", "None"));
    await press(radio("Shape", "1280 × 720"));
    assert.equal(lastAsk(m, "read-audiobook-video")!.options.subtitles, "none", "a choice made stays");

    // One for the book: a book past twelve hours in parts, said on the row and on the press.
    await press(radio("Files", "One for the book"));
    await answerState(m, [{ chapterId: "a", seconds: 8 * 3600, rendered: true }, { chapterId: "b", seconds: 6 * 3600, rendered: false }], { "1280x720/push": { bytesPerSec: 1000, speed: 10 } });
    assert.match(text(q(m, '[data-testid="audiobook-export"]')), /2 parts · 8 h 00 m, 6 h 00 m/);
    assert.equal(text(q(m, '[data-testid="audiobook-video-render"]')), "Render 2 parts");
    assert.match(text(q(m, '[data-testid="audiobook-video-estimate"]')), /^2 files · 48 MB · 36 min on this machine14:00:10 of video · 1 rendered · 1 to render$/, "measured: no ~");
  });

  it("renders, follows the render, and lists the files with Open and Show in folder (197e)", async () => {
    Object.assign(dom.window, { arke: { openDataFolder() {} } });
    try {
      const m = await videoSheet();
      await answerState(m, [{ chapterId: "slack-water", seconds: 1900, rendered: false }]);
      await press(q(m, '[data-testid="audiobook-video-render"]'));
      const ask = lastAsk(m, "export-audiobook-video")!;
      assert.match(ask.exportId, /^vb_[0-9A-HJKMNP-TV-Z]{26}$/);
      const video = { title: "Inkbound", chapter: 1, of: 1, doneSec: 724, totalSec: 1900, leftSec: 180 };
      await act(async () => __applyEventForTest({ at: AT, type: "export.progress", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", exportId: ask.exportId, deliveryKind: "audiobook-video", status: "running", percent: 41, output: null, video, error: null }));
      assert.match(text(q(m, '[data-testid="audiobook-video-estimate"]')), /rendering · 41%$/);
      assert.equal(q(m, '[data-testid="audiobook-video-render"]')?.hasAttribute("disabled"), true, "one render at a time");
      const files = [{ name: "inkbound-01-slack-water.mp4", seconds: 1900, bytes: 338 * 1024 * 1024, shape: "1920x1080" as const, sidecars: [".srt" as const, ".vtt" as const], picture: "artifacts/stair.png" }];
      await act(async () => __applyEventForTest({ at: AT, type: "audiobook.video-exported", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", exportId: ask.exportId, result: { ok: true, dir: "exports/inkbound-video-20261003", files, made: 1, renderedAt: AT } }));
      const sheet = text(q(m, '[data-testid="audiobook-export"]'));
      assert.match(sheet, /^1 video · 338 MBexports\/inkbound-video-20261003\/Show in folderRender again/);
      assert.equal(text(q(m, '[data-testid="audiobook-video-file"]')), "inkbound-01-slack-water.mp431:40 · 1920×1080 · 338 MB · .srt .vttOpenShow in folder");
      await press(button("Open"));
      assert.deepEqual(lastAsk(m, "open-exports-folder"), { kind: "open-exports-folder", worldId: FIXTURE_WORLD_ID, dir: "inkbound-video-20261003", file: "inkbound-01-slack-water.mp4" });
      await press(q(m, '[data-testid="audiobook-video-again"]'));
      assert.notEqual(lastAsk(m, "export-audiobook-video")!.exportId, ask.exportId, "Render again is a new render, made only where something changed");
    } finally {
      Object.assign(dom.window, { arke: undefined });
    }
  });

  it("previews a frame filled as the file renders it, the crops around the focus, and puts the focus back to the centre (197b)", async () => {
    const m = await videoSheet();
    await answerState(m, [{ chapterId: "slack-water", seconds: 12, rendered: false }]);
    await press(q(m, '[data-testid="audiobook-video-preview-open"]'));
    const preview = q(m, '[data-testid="audiobook-video-preview"]')!;
    assert.match(text(preview), /^Preview · Slack water16:9 · 1920×1080 · sidecar captionsDoneFocusdrag to set · kept on the pictureCentre/);
    assert.match(text(preview), /0:00 · cover/);
    // A 3:2 picture, as Na love or Juju's are, once the browser knows its size: it covers both
    // frames (no bar) and the focus box draws the crops the file takes (turn 197's correction).
    const stair = [...preview.querySelectorAll("img")].filter((img) => img.getAttribute("src")?.includes("stair.png"));
    for (const img of stair) Object.defineProperties(img, { naturalWidth: { value: 1536 }, naturalHeight: { value: 1024 } });
    await act(async () => void stair[0]!.dispatchEvent(new dom.window.Event("load")));
    const frames = [...preview.querySelectorAll(".fy-abv-vid")].filter((frame) => frame.querySelector('img[src*="stair.png"]') !== null);
    const wideImg = frames[0]!.querySelector("img")! as unknown as HTMLElement;
    const tallImg = frames[1]!.querySelector("img")! as unknown as HTMLElement;
    assert.equal(wideImg.className, "", "no longer the contained (letterboxed) picture");
    assert.deepEqual([wideImg.style.left, wideImg.style.top, wideImg.style.width, wideImg.style.height], ["0", "-37.5px", "720px", "480px"], "720 wide, the 80 rows above the 16:9 band cut away");
    assert.ok(!wideImg.style.transform, "Slow push starts from the crop itself at the start of the hold");
    assert.deepEqual([tallImg.style.left, tallImg.style.width], [`${(-480 * 228) / 576}px`, `${(1536 * 228) / 576}px`], "9:16: the full-height column around the centre");
    const crop = q(m, '[data-testid="audiobook-video-crop"]')! as unknown as HTMLElement;
    const column = q(m, '[data-testid="audiobook-video-crop-other"]')! as unknown as HTMLElement;
    assert.deepEqual([crop.style.width, crop.style.height], ["253.5px", "142.59375px"], "the 16:9 crop, lit: the band of the picture the file shows");
    assert.equal(column.style.height, "169px", "the 9:16 column, outlined, the picture's full height");
    await press(button("Centre"));
    const ask = lastAsk(m, "set-audiobook-picture-focus")!;
    assert.deepEqual([ask.chapterFile, ask.block, ask.focus], ["slack-water", "a", null]);
  });
});

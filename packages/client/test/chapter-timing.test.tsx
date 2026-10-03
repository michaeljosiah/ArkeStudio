import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  audiobookTextHash,
  timeChapter,
  type ArtifactSidecar,
  type BlockTiming,
  type BlockTimingInput,
  type ChapterAudiobook,
  type ChapterSummary,
  type ChapterTiming,
  type ClientMessage,
  type ClientState,

} from "@arke-studio/contracts";
import { BlockTimingPanel, betweenClocks, TimingSide, TimingView, timingInputs, timingLanes, type TimingRowLike } from "../src/screens/chapter-timing.js";
import { ChapterScreen } from "../src/screens/chapter-workspace.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The Timing view and the block panel's timing (design turn 187a, 187c): a lane a voice in order
 * of first speaking, bars at the clock's places, an interruption hatched, a drag that writes a
 * start, a trim, a pause or plays a bar under another, the Performed lock said where a field
 * would be, and the third view in the chapter's address.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1600, innerHeight: 1000 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const AT = "2026-10-03T14:00:00.000Z";
const TEXT: Record<string, string> = {
  title: "Chapter 1 · The Goat",
  "p0.0": "Tunde was telling the goat story again.",
  "p1.0": "“Ade, I am telling you —”",
  "p2.0": "“Tunde —”",
  "p3.0": "“The goat was in the boot.”",
};
const SPEAKER: Record<string, { key: string | null; mark: string }> = {
  title: { key: null, mark: "title" },
  "p0.0": { key: null, mark: "narrator" },
  "p1.0": { key: "tunde", mark: "Tunde" },
  "p2.0": { key: "ade", mark: "Ade" },
  "p3.0": { key: "ade", mark: "Ade" },
};
const artifact = (key: string, seconds: number): ArtifactSidecar => ({
  id: `ar_01J8F3K2QW9VZX4N7M0RTYB6${String(Object.keys(TEXT).indexOf(key)).padStart(2, "0")}`,
  kind: "audio",
  file: `${key}.wav`,
  hash: `sha256:${"b".repeat(16)}`,
  origin: { by: "system", producedBy: "audiobook" },
  links: [],
  mediaInfo: { durationSec: seconds },
  created: AT,
} as unknown as ArtifactSidecar);
const SECONDS: Record<string, number> = { title: 2, "p0.0": 2.4, "p1.0": 3, "p2.0": 1.6, "p3.0": 2 };
const ARTIFACTS = Object.keys(TEXT).map((key) => artifact(key, SECONDS[key]!));
const ROWS: TimingRowLike[] = Object.keys(TEXT).map((key, index) => ({
  block: { key, text: TEXT[key]! },
  mark: SPEAKER[key]!.mark,
  speakerKey: SPEAKER[key]!.key,
  speaker: { voiceId: "bm_george", label: SPEAKER[key]!.key === null ? "Ife's voice" : `${SPEAKER[key]!.mark}'s voice` },
  artifact: ARTIFACTS[index]!,
}));
function record(timing: Record<string, Partial<BlockTiming>> = {}, grouped: string[] = []): ChapterAudiobook {
  let offset = 0;
  return {
    schemaVersion: 1,
    chapterVersion: 1,
    hash: "h",
    updatedAt: AT,
    flags: {},
    direction: {},
    takes: Object.fromEntries(Object.keys(TEXT).map((key, index) => {
      const g = grouped.includes(key) ? { grouped: { request: "rq", blocks: grouped, packing: "deltas" as const, offsetSec: offset, durationSec: SECONDS[key]! } } : {};
      if (grouped.includes(key)) offset += SECONDS[key]!;
      return [key, { artifactId: ARTIFACTS[index]!.id, textHash: audiobookTextHash(TEXT[key]!), reader: { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george" }, format: "wav" as const, characters: 10, parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0, madeAt: AT, ...g }];
    })),
    ...(Object.keys(timing).length > 0 ? { timing: Object.fromEntries(Object.entries(timing).map(([key, entry]) => [key, { textHash: audiobookTextHash(TEXT[key]!), by: "author" as const, at: AT, ...entry }])) } : {}),
  };
}
const timingOf = (held: ChapterAudiobook, reading: "narrator" | "performed" = "narrator", unmade: "skip" | "estimate" = "estimate"): ChapterTiming => {
  const { blocks, reactions } = timingInputs(ROWS, held, ARTIFACTS);
  return timeChapter({ blocks, reactions, record: held, reading, unmade });
};

type Mounted = { container: HTMLElement; root: Root };
const open: Mounted[] = [];
async function render(node: React.ReactNode): Promise<Mounted> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  const mounted = { container, root };
  open.push(mounted);
  return mounted;
}
afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});
const q = (m: Mounted, selector: string) => m.container.querySelector(selector) as HTMLElement | null;
const all = (m: Mounted, selector: string) => [...m.container.querySelectorAll(selector)] as HTMLElement[];

/** A pointer gesture: down on `target`, moved by dx/dy, up on the track. */
async function dragBy(m: Mounted, target: HTMLElement, dx: number, dy = 0): Promise<void> {
  const fire = (node: Element, type: string, x: number, y: number) => {
    const event = new dom.Event(type, { bubbles: true, cancelable: true }) as unknown as Record<string, unknown>;
    Object.assign(event, { clientX: x, clientY: y, button: 0, pointerId: 1 });
    node.dispatchEvent(event as unknown as Event);
  };
  const track = q(m, ".fy-tm__track")!;
  await act(async () => fire(target, "pointerdown", 100, 100));
  await act(async () => fire(track, "pointermove", 100 + dx, 100 + dy));
  await act(async () => fire(track, "pointerup", 100 + dx, 100 + dy));
}

function view(held: ChapterAudiobook, writes: Array<[string, BlockTimingInput]>, extra: { reading?: "narrator" | "performed"; selected?: string | null; onSelect?: (key: string) => void } = {}) {
  const timing = timingOf(held, extra.reading ?? "narrator");
  return (
    <TimingView
      timing={timing}
      lanes={timingLanes(ROWS)}
      rows={ROWS}
      selected={extra.selected ?? null}
      onSelect={extra.onSelect ?? (() => {})}
      onTiming={(key, input) => writes.push([key, input])}
      playhead={0}
      onPlayhead={() => {}}
      locked={false}
    />
  );
}

describe("the Timing view (turn 187a)", () => {
  it("draws a lane a voice — narration, then each speaker as they first speak — and beds last", async () => {
    const m = await render(view(record(), []));
    assert.deepEqual(all(m, ".fy-tm__name").map((name) => name.firstChild?.textContent), ["Narration", "Tunde", "Ade", "Beds & sounds"]);
    assert.equal(all(m, "[data-testid=timing-bar]").length, 5);
    const bar = (key: string) => q(m, `[data-testid=timing-bar][data-key="${key}"]`)!;
    assert.equal(bar("p1.0").style.left, `${4.4 * 40}px`, "at its place on the clock, 40 px a second");
    assert.match(bar("p1.0").textContent ?? "", /Ade, I am telling you/);
    assert.equal(all(m, "[data-testid=timing-overlap]").length, 0);
  });

  it("hatches an interruption and says its start on the bar", async () => {
    const m = await render(view(record({ "p2.0": { start: -0.4 } }), []));
    assert.equal(all(m, "[data-testid=timing-overlap]").length, 1);
    assert.match(q(m, `[data-key="p2.0"]`)!.textContent ?? "", /starts −0\.4 s/);
    assert.ok(q(m, `[data-key="p2.0"]`)!.className.includes("fy-tm__bar--overlap"));
  });

  it("writes a start when a bar is dragged along its lane", async () => {
    const writes: Array<[string, BlockTimingInput]> = [];
    const m = await render(view(record(), writes));
    await dragBy(m, q(m, `[data-key="p2.0"]`)!, -16);
    assert.deepEqual(writes, [["p2.0", { start: -0.4 }]]);
  });

  it("plays a bar under another when it is dropped over it in another lane", async () => {
    const writes: Array<[string, BlockTimingInput]> = [];
    const m = await render(view(record(), writes));
    // Ade's p2.0 (lane 2, at 7.4 s) dragged up a lane and back 2 s onto Tunde's p1.0 (4.4–7.4 s).
    await dragBy(m, q(m, `[data-key="p2.0"]`)!, -80, -64);
    assert.deepEqual(writes, [["p2.0", { under: { host: "p1.0", offset: 1 } }]]);
  });

  it("trims a take by its edges and sets the pause by the grip after it", async () => {
    const writes: Array<[string, BlockTimingInput]> = [];
    const m = await render(view(record(), writes));
    await dragBy(m, q(m, `[data-key="p1.0"] [data-testid=timing-head]`)!, 8);
    await dragBy(m, q(m, `[data-key="p1.0"] [data-testid=timing-tail]`)!, -4);
    await dragBy(m, q(m, `[data-testid=timing-gap][data-key="p1.0"]`)!, 20);
    assert.deepEqual(writes, [["p1.0", { trim: { head: 0.2, tail: 0 } }], ["p1.0", { trim: { head: 0, tail: 0.1 } }], ["p1.0", { pauseAfter: 0.5 }]]);
  });

  it("selects the block a bar is", async () => {
    const chosen: string[] = [];
    const m = await render(view(record(), [], { onSelect: (key) => chosen.push(key) }));
    await act(async () => q(m, `[data-key="p3.0"]`)!.click());
    assert.deepEqual(chosen, ["p3.0"]);
  });
});

describe("the side and the block panel (turn 187a, 187c)", () => {
  it("names a negative start against the block it cuts in on, and writes the field on Enter", async () => {
    const writes: Array<[string, BlockTimingInput]> = [];
    const held = record({ "p2.0": { start: -0.4 } });
    const timing = timingOf(held);
    const bar = timing.bars.find((candidate) => candidate.key === "p2.0")!;
    const m = await render(<TimingSide bar={bar} row={ROWS[3]!} timing={timing} rows={ROWS} onTiming={(key, input) => writes.push([key, input])} onPlayFrom={() => {}} refused={null} locked={false} />);
    assert.match(q(m, "[data-testid=timing-side]")!.textContent ?? "", /cuts in on Tunde/);
    assert.match(q(m, "[data-testid=timing-side]")!.textContent ?? "", /Set byyou/);
    const field = q(m, "[data-testid=timing-pause]") as HTMLInputElement;
    field.value = "0.3";
    // linkedom's blur raises no focusout of its own; the commit is the blur handler.
    await act(async () => field.dispatchEvent(new dom.Event("focusout", { bubbles: true }) as unknown as Event));
    assert.deepEqual(writes.at(-1), ["p2.0", { pauseAfter: 0.3 }]);
  });

  it("says a grouped request's inside is the reader's under Performed", async () => {
    const held = record({}, ["p1.0", "p2.0", "p3.0"]);
    const timing = timingOf(held, "performed");
    const bar = timing.bars.find((candidate) => candidate.key === "p2.0")!;
    const m = await render(<TimingSide bar={bar} row={ROWS[3]!} timing={timing} rows={ROWS} onTiming={() => {}} onPlayFrom={() => {}} refused={null} locked={false} />);
    assert.match(q(m, "[data-testid=timing-start-locked]")!.textContent ?? "", /the reader's/);
    assert.match(q(m, "[data-testid=timing-pause-locked]")!.textContent ?? "", /the reader's/);
    assert.equal(q(m, "[data-testid=timing-start]"), null);
  });

  it("offers the cut's nudge only between two cuts of one request, and plays a block with its neighbours", async () => {
    const windows: Array<[number, number]> = [];
    const plain = timingOf(record());
    const m = await render(<BlockTimingPanel bar={plain.bars.find((bar) => bar.key === "p1.0")!} timing={plain} slug="w" onTiming={() => {}} onPlayWindow={(from, to) => windows.push([from, to])} locked={false} grouped={null} />);
    assert.equal(q(m, "[data-testid=block-nudge]"), null);
    await act(async () => q(m, "[data-testid=block-play-neighbours]")!.click());
    assert.deepEqual(windows, [[2, 9]], "from the block before to the end of the block after");

    const grouped = timingOf(record({ "p1.0": { nudge: 0.06 } }, ["p1.0", "p2.0"]));
    const n = await render(<BlockTimingPanel bar={grouped.bars.find((bar) => bar.key === "p1.0")!} timing={grouped} slug="w" onTiming={() => {}} onPlayWindow={() => {}} locked={false} grouped="request 1" />);
    assert.ok(q(n, "[data-testid=block-nudge]"));
    assert.match(q(n, "[data-testid=block-timing]")!.textContent ?? "", /\+0\.06 s nudged · grouped split/);
    assert.match(q(n, "[data-testid=block-timing]")!.textContent ?? "", /grouped · request 1/);
  });

  it("carries the playhead between the view's clock and the mix's", () => {
    const partial = { ...record(), takes: Object.fromEntries(Object.entries(record().takes).filter(([key]) => key !== "p0.0")) };
    const shown = timingOf(partial, "narrator", "estimate");
    const mixed = timingOf(partial, "narrator", "skip");
    const p1 = shown.bars.find((bar) => bar.key === "p1.0")!;
    assert.equal(betweenClocks(shown, mixed, p1.at + 1), mixed.bars.find((bar) => bar.key === "p1.0")!.at + 1);
  });
});

describe("the third view (turn 187a)", () => {
  const HASH = `sha256:${"a".repeat(64)}`;
  // HTML in the body sends the Bible's gate to the source editor, the one that mounts under linkedom.
  const BODY = `${TEXT["p0.0"]}\n\nNothing <br> else.`;
  const CHAPTERS: ChapterSummary[] = [{ id: "neap", file: "01-neap", order: 1, title: "The Goat", status: "drafting", version: 4, words: 10, bodyHash: HASH }];
  function inkbound(): ClientState {
    const world = FIXTURE_STATE.world!;
    const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
    return { ...FIXTURE_STATE, world: { ...world, productions: [...world.productions, { ...salt, meta: { ...salt.meta, id: "inkbound", format: "story" as const, title: "Inkbound" }, story: { ...(salt.story ?? { version: 1 }), version: 3 }, chapters: CHAPTERS }] } };
  }

  it("opens from the address beside Manuscript and Audiobook, its bars from the chapter's blocks", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
    const m = await render(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/inkbound/story/chapters/neap?view=timing`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/story/chapters/:chapterId" element={<ChapterScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => __setStateForTest(inkbound(), { connection: "open" }));
    const ask = sent.findLast((message) => message.kind === "open-chapter") as Extract<ClientMessage, { kind: "open-chapter" }>;
    await act(async () => {
      __applyEventForTest({ at: AT, type: "chapter.open-result", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap", disposition: "opened", body: BODY, version: 4, hash: HASH, versions: [1, 2, 3] });
    });
    const tabs = all(m, "nav[aria-label='Chapter view'] button").map((button) => button.textContent);
    assert.deepEqual(tabs, ["Manuscript", "Audiobook", "Timing"]);
    assert.ok(q(m, "[data-testid=timing-view]"));
    assert.equal(all(m, "[data-testid=timing-bar]").length, 3, "the title and the two paragraphs, not read yet");
    assert.ok(all(m, "[data-testid=timing-bar]").every((bar) => bar.className.includes("fy-tm__bar--unread")));
    assert.ok(q(m, ".fy-ch__manuscript[hidden]"), "the editor stays mounted underneath, hidden");
  });
});


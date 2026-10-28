import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage, ClientState, ProductionBundle, StoryExportState, WebPackagesListed } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { clipClock, StoryExportSheet, storyReleases } from "../src/components/story-export.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Export on an interactive movie or a visual novel (design turn 245, SPEC-058 R-89): one sheet
 * with Web package and Arke Player, its rows as the coordinator counts them (245a, 245b), each
 * blocker with the press that clears it (245c), and the package made and read back beside the
 * world's releases (245d).
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

const AT = "2026-10-28T09:12:00.000Z";
const SHA = "4be1c07d93a2f58e16c0b7d42e9a3f61d85c2b04a7e19f3c60d8b25e1f4a97c3";

function withStory(kind: "movie" | "novel"): { state: ClientState; production: ProductionBundle } {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  const production: ProductionBundle = {
    ...salt,
    meta: { ...salt.meta, id: "low-water", title: "Low Water", ...(kind === "movie" ? { medium: "interactive-video" as const, kind: "interactive" } : { medium: "video" as const, kind: "visual-novel" }) },
    routing: { version: 3, start: "sc_harbour", choices: [{ id: "ch_on", from: "sc_harbour", to: "sc_pier", label: "Go on" }], endings: [{ sceneId: "sc_pier", title: "The pier" }], excluded: [], groups: [] },
    takes: [],
    selections: {},
  };
  return { state: { ...FIXTURE_STATE, world: { ...world, productions: [...world.productions, production] } }, production };
}

const MOVIE: StoryExportState = {
  kind: "movie",
  shape: "16:9",
  scenes: 14,
  choices: 22,
  facts: 3,
  endings: 2,
  closed: { count: 3, reasoned: 1 },
  clips: { count: 14, of: 14, ms: 2_832_000, width: 1920, height: 1080, reencoded: 0 },
  bytes: Math.round(1.1 * 1024 ** 3),
  seconds: 230,
  blockers: [],
};
const NOVEL: StoryExportState = {
  kind: "novel",
  shape: "9:16",
  scenes: 9,
  choices: 14,
  facts: 2,
  endings: 3,
  closed: { count: 1, reasoned: 1 },
  pictures: { beats: 86, wide: 86, tall: 0, files: 80 },
  voices: { lines: 86, voiced: 61 },
  bytes: 212 * 1024 ** 2,
  seconds: 50,
  blockers: [],
};

type Mounted = { container: HTMLElement; root: Root; sent: ClientMessage[] };
const open: Mounted[] = [];
async function mount(kind: "movie" | "novel", props: { onShow?: (route: string[]) => void; onGoTo?: (sceneId: string) => void; onClose?: () => void } = {}): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  const { state, production } = withStory(kind);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root.render(<StoryExportSheet worldId={FIXTURE_WORLD_ID} production={production} onClose={props.onClose ?? (() => {})} {...(props.onShow !== undefined ? { onShow: props.onShow } : {})} {...(props.onGoTo !== undefined ? { onGoTo: props.onGoTo } : {})} />);
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
const q = (selector: string) => dom.document.querySelector(selector) as HTMLElement | null;
const all = (selector: string) => [...dom.document.querySelectorAll(selector)] as HTMLElement[];
/** What an element says, each element's words apart from the next, as a reader sees the cells. */
const words = (node: Node): string => (node.nodeType === 3 ? (node.textContent ?? "").trim() : [...node.childNodes].map(words).filter((part) => part !== "").join(" "));
const text = (el: Element | null) => (el === null ? "" : words(el as unknown as Node).replace(/\s+/g, " ").trim());
const press = async (el: Element | null | undefined) => {
  assert.ok(el, "the thing to press exists");
  await act(async () => void el.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
};
const lastAsk = <K extends ClientMessage["kind"]>(m: Mounted, kind: K) => m.sent.filter((message): message is Extract<ClientMessage, { kind: K }> => message.kind === kind).at(-1);
const labels = () => all(".fy-abv-opt > b").map(text);
/** A row's cells, each its own words: `Story 14 scenes · 22 choices 3 facts · 2 endings`. */
const row = (label: string) => {
  const found = all(".fy-abv-opt").find((el) => text(el.querySelector("b")) === label);
  return found === undefined ? "" : [...found.children].map((cell) => text(cell)).filter((cell) => cell !== "").join(" ");
};
const button = (label: string) => all("button").find((el) => text(el) === label);
async function answer(m: Mounted, state: StoryExportState) {
  const ask = lastAsk(m, "read-story-export");
  assert.ok(ask, "the sheet asks what the package would hold");
  await act(async () => __applyEventForTest({ at: AT, type: "story.export-state", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "low-water", state }));
}

describe("Export on an interactive story (turn 245)", () => {
  it("245a: an interactive movie offers Web package and Arke Player, its rows in order, priced as a package", async () => {
    const m = await mount("movie");
    assert.deepEqual(all('[role="radio"].fy-abv-kind').map((el) => [text(el.querySelector("b")), el.getAttribute("aria-checked")]), [["Web package", "false"], ["Arke Player", "true"]]);
    await answer(m, MOVIE);
    assert.deepEqual(labels(), ["World", "Story", "Closed choices", "Clips", "Shape", "Format", "Edition"]);
    assert.match(row("World"), /The Undersong key art · logline/);
    assert.equal(row("Story"), "Story 14 scenes · 22 choices 3 facts · 2 endings");
    assert.equal(row("Closed choices"), "Closed choices 3 · 1 with a reason 2 hidden");
    assert.equal(row("Clips"), "Clips 14 · 47:12 1920 × 1080 · as made");
    assert.equal(row("Shape"), "Shape 16:9");
    assert.equal(row("Format"), "Format arke-story 1 from routing");
    assert.equal(text(q('[data-testid="story-export-estimate"]')), "~1.1 GB · ~4 min on this machine 14 clips · 1 story");
    assert.match(text(q(".fy-page-sheet")), /Interactive movie · 14 scenes · 16:9/);
    await press(q('[data-testid="story-export-start"]'));
    assert.deepEqual(lastAsk(m, "export-arke-player")!.options, { book: false, motion: false });
    assert.match(text(q('[data-testid="story-export-making"]')), /Making package/);
    // The kind stays put while the package is made, so its answer always lands where it was asked (codex on PR 2205).
    assert.ok(all('[role="radio"].fy-abv-kind').every((el) => (el as HTMLButtonElement).disabled));
  });

  it("245b: a visual novel counts its pictures wide and tall, with Size and its voiced lines", async () => {
    const m = await mount("novel");
    await answer(m, NOVEL);
    assert.deepEqual(labels(), ["World", "Story", "Closed choices", "Pictures", "Size", "Voices", "Format", "Edition"]);
    assert.equal(row("Closed choices"), "Closed choices 1 · 1 with a reason", "nothing hidden, so no tail");
    assert.match(row("Pictures"), /^Pictures 86 wide · 0 tall 86 wide only Make tall$/);
    assert.equal(row("Voices"), "Voices 61 of 86 lines 25 as text");
    assert.equal(text(q('[data-testid="story-export-estimate"]')), "~212 MB · ~1 min on this machine 86 beats · 80 pictures · 61 lines");
    await press([...q('[data-testid="story-export-size"]')!.querySelectorAll("button")].find((el) => text(el) === "960 px"));
    assert.equal(lastAsk(m, "read-story-export")!.size, "960", "the estimate is read again at the new Size");
    await answer(m, NOVEL);
    await press(q('[data-testid="story-export-start"]'));
    assert.deepEqual(lastAsk(m, "export-arke-player")!.options, { book: false, motion: false, size: "960" });
  });

  it("245c: not made — each blocker in one clause with Go to or Show, and Make package waits", async () => {
    const shown: string[][] = [];
    const went: string[] = [];
    const m = await mount("movie", { onShow: (route) => shown.push(route), onGoTo: (sceneId) => went.push(sceneId) });
    await answer(m, {
      ...MOVIE,
      clips: { ...MOVIE.clips!, count: 13 },
      blockers: [
        { detail: "Under the pier · no clip", row: "media", sceneId: "sc_pier" },
        { detail: "The weigh house · a dead end when Key is Left", row: "story", sceneId: "sc_weigh", route: ["ch_leave"] },
        { detail: "The drowned quarter · beat 3 keeps the picture of a shot shown only in some states", row: "story", sceneId: "sc_quarter" },
      ],
    });
    assert.deepEqual(labels(), ["Story", "Closed choices", "Clips"], "245c keeps the rows the blockers count against");
    assert.equal(row("Story"), "Story 14 scenes · 22 choices 2 to clear");
    assert.equal(row("Clips"), "Clips 13 of 14 1 to clear");
    assert.equal(q('[data-testid="story-export-estimate"]'), null);
    assert.deepEqual(all('[data-testid="story-export-blocker"]').map(text), [
      "Under the pier · no clip Go to",
      "The weigh house · a dead end when Key is Left Show",
      "The drowned quarter · beat 3 keeps the picture of a shot shown only in some states Go to",
    ]);
    assert.equal((q('[data-testid="story-export-start"]') as HTMLButtonElement).disabled, true);
    await press(all('[data-testid="story-export-blocker"]')[1]!.querySelector("button"));
    assert.deepEqual(shown, [["ch_leave"]]);
    await press(all('[data-testid="story-export-blocker"]')[0]!.querySelector("button"));
    assert.deepEqual(went, ["sc_pier"]);
  });

  it("245d: made — size, SHA-256 with Copy, the read-back line, and the world's releases in order", async () => {
    const m = await mount("movie");
    await answer(m, MOVIE);
    await press(q('[data-testid="story-export-start"]'));
    const exportId = lastAsk(m, "export-arke-player")!.exportId;
    await act(async () => __applyEventForTest({ at: AT, type: "arke-player.exported", requestId: "01J00000000000000000000001", worldId: FIXTURE_WORLD_ID, productionId: "low-water", exportId, result: { ok: true, file: "exports/low-water-story-2026-10-28.zip", bytes: Math.round(1.1 * 1024 ** 3), sha256: SHA, edition: "2026-10-28", chapters: 0, pictures: 1, book: false, guide: false, story: { kind: "movie", scenes: 14, routes: 37, complete: true, endings: 2 } } }));
    const done = text(q('[data-testid="story-export-done"]'));
    assert.match(done, /1 package · 1\.1 GB exports\/low-water-story-2026-10-28\.zip Show in folder/);
    assert.match(done, new RegExp(`SHA-256 ${SHA} Copy`));
    assert.equal(text(q('[data-testid="story-export-read-back"]')), "Read back 37 of 37 routes · 2 endings arke-story 1");
    assert.equal(all('[role="radio"].fy-abv-kind').length, 0, "made, the sheet is the package alone");
    assert.match(text(q(".fy-page-sheet")), /arke player · story · made \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.ok(button("Make again") && button("Done"));

    const listing = lastAsk(m, "list-web-packages");
    assert.ok(listing, "the world's releases are listed once the package is made");
    const packages: WebPackagesListed["packages"] = [
      { kind: "arke-player", productionId: "low-water", title: "The Undersong · Low Water", dir: "exports/low-water-story-2026-10-28.zip", file: "exports/low-water-story-2026-10-28.zip", exportedAt: "2026-10-28T09:12:00.000Z", bytes: Math.round(1.1 * 1024 ** 3), sha256: SHA, holds: "14 scenes · 37 routes · 2 endings", story: { kind: "movie", scenes: 14, routes: 37, complete: true, endings: 2 } },
      { kind: "arke-player", productionId: "songs", title: "The Undersong · Songs of the Drowned Quarter", dir: "exports/songs.zip", file: "exports/songs.zip", exportedAt: "2026-10-25T10:00:00.000Z", bytes: 66 * 1024 ** 2, holds: "9 tracks", tracks: 9 },
      { kind: "arke-player", productionId: "the-ledger-of-nights", title: "The Undersong", dir: "exports/edition.zip", file: "exports/edition.zip", exportedAt: "2026-10-26T10:00:00.000Z", bytes: 412 * 1024 ** 2, holds: "3 chapters · the book", chapters: 3 },
      { kind: "interactive", productionId: "low-water", title: "Low Water", dir: "exports/interactive-low-water", exportedAt: "2026-10-27T10:00:00.000Z" },
    ];
    await act(async () => __applyEventForTest({ at: AT, type: "web-packages.listed", requestId: listing.requestId, worldId: FIXTURE_WORLD_ID, packages }));
    assert.deepEqual(all('[data-testid="story-export-releases"] .fy-abv-rel').map(text), [
      "26 Oct 2026 Edition The Undersong · 3 chapters · the book 412 MB",
      "25 Oct 2026 Album Songs of the Drowned Quarter · 9 tracks 66 MB",
      "28 Oct 2026 Story Low Water · 14 scenes 1.1 GB",
    ]);
    assert.ok(q('[data-testid="story-export-releases"] .fy-abv-rel.now')?.textContent?.includes("Story"), "the story just made is marked");
  });

  it("a refusal after the press keeps each blocker's press", async () => {
    const m = await mount("movie");
    await answer(m, MOVIE);
    await press(q('[data-testid="story-export-start"]'));
    const exportId = lastAsk(m, "export-arke-player")!.exportId;
    await act(async () => __applyEventForTest({ at: AT, type: "arke-player.exported", requestId: "01J00000000000000000000001", worldId: FIXTURE_WORLD_ID, productionId: "low-water", exportId, result: { ok: false, blockers: ["the story changed while the package was made · make it again"], problems: [{ detail: "the story changed while the package was made · make it again", row: "story" }] } }));
    assert.deepEqual(all('[data-testid="story-export-blocker"]').map(text), ["the story changed while the package was made · make it again"]);
    assert.equal((q('[data-testid="story-export-start"]') as HTMLButtonElement).disabled, false, "it can be made again");
  });

  it("after a reconnect, an export that ended with no package says so rather than waiting for good (codex on PR 2205)", async () => {
    const m = await mount("movie");
    await answer(m, MOVIE);
    await press(q('[data-testid="story-export-start"]'));
    const exportId = lastAsk(m, "export-arke-player")!.exportId;
    const { state } = withStory("movie");
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await act(async () => __setStateForTest(state, { connection: "open" }));
    const listing = lastAsk(m, "list-web-packages");
    assert.ok(listing, "the packages are listed again on the way back");
    // Still being made: the sheet keeps waiting.
    await act(async () => __applyEventForTest({ at: AT, type: "web-packages.listed", requestId: listing.requestId, worldId: FIXTURE_WORLD_ID, packages: [], running: [exportId] }));
    assert.ok(q('[data-testid="story-export-making"]'));
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await act(async () => __setStateForTest(state, { connection: "open" }));
    const again = lastAsk(m, "list-web-packages")!;
    await act(async () => __applyEventForTest({ at: AT, type: "web-packages.listed", requestId: again.requestId, worldId: FIXTURE_WORLD_ID, packages: [], running: [] }));
    assert.equal(q('[data-testid="story-export-making"]'), null);
    assert.deepEqual(all('[data-testid="story-export-blocker"]').map(text), ["the export ended while this window was away · make it again"]);
    assert.equal((q('[data-testid="story-export-start"]') as HTMLButtonElement).disabled, false, "it can be made again");
  });

  it("Web package is the folder the Branch Map wrote, unchanged", async () => {
    const m = await mount("movie");
    await answer(m, MOVIE);
    await press(q('[data-testid="story-export-web"]'));
    assert.equal(q('[data-testid="story-export-web"]')?.getAttribute("aria-checked"), "true");
    await press(q('[data-testid="story-export-web-start"]'));
    assert.ok(lastAsk(m, "export-interactive"), "the web package's own export");
    await act(async () => __applyEventForTest({ at: AT, type: "production.interactive-export-result", worldId: FIXTURE_WORLD_ID, productionId: "low-water", disposition: "exported", dir: "exports/interactive-low-water-iv_1" }));
    assert.equal(text(q('[data-testid="story-export-web-done"]')), "exports/interactive-low-water-iv_1");
  });

  it("names a clip's length the way the sheet does", () => {
    assert.equal(clipClock(2_832_000), "47:12");
    assert.equal(clipClock(3_723_000), "1:02:03");
    assert.deepEqual(storyReleases([], "The Undersong"), []);
  });
});

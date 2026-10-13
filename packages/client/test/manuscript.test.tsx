import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ChapterSummary, ClientMessage, ClientState } from "@arke-studio/contracts";
import { ChapterTreeScreen } from "../src/screens/production-story.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { dialogRoot } from "./dialog-root.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A manuscript out and in on Chapters (design turn 131, issue 915): the two presses beside New
 * chapter, the export sheet's format, counts and deliveries, the import sheet's read shown
 * before anything is written, the chapters appended with their mark and the session's line.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
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

const ROUTE = `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/chapters`;
const CHAPTERS: ChapterSummary[] = [
  { id: "neap", file: "01-neap", order: 1, title: "Neap", status: "drafted", version: 4, words: 3120 },
  { id: "her-own-hand", file: "04-her-own-hand", order: 2, title: "Her own hand", status: "planned", version: 1 },
];

function inkbound(chapters: ChapterSummary[] = CHAPTERS): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      productions: [...world.productions, { ...salt, meta: { ...salt.meta, id: "inkbound", format: "story" as const, medium: "story" as const, title: "Inkbound" }, story: { version: 3 }, chapters }],
    },
  };
}

interface Mounted {
  /** Where the sheets are: the body. The screen itself is in `host`. */
  container: HTMLElement;
  host: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}
const open: Mounted[] = [];

function capture(sent: ClientMessage[]): ArkeBridge {
  return { appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge;
}

async function mount(state: ClientState): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(capture(sent));
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root.render(
      <MemoryRouter initialEntries={[ROUTE]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/story/chapters" element={<ChapterTreeScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const mounted = { container: dialogRoot(container), host: container, root, sent };
  open.push(mounted);
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.host.remove();
  }
});

const text = (m: Mounted) => m.container.textContent ?? "";
const press = async (m: Mounted, testId: string) => {
  const node = m.container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  assert.ok(node, `${testId} is on the page`);
  await act(async () => {
    node.click();
  });
};
const button = (m: Mounted, label: RegExp) => [...m.container.querySelectorAll("button")].find((node) => label.test(node.textContent ?? "")) as HTMLButtonElement | undefined;

describe("a manuscript out (turn 131)", () => {
  it("Export opens the sheet with the format, the counts and what is left out, and the press exports by format", async () => {
    const m = await mount(inkbound());
    await press(m, "export-manuscript");
    await act(async () => button(m, /^Other exports$/)!.click());
    assert.match(text(m), /Export manuscript/);
    assert.match(text(m), /Inkbound · 1 of 2 chapters · 3,120 words/);
    assert.match(text(m), /1 chapter with prose, in order · 1 planned left out/);
    const docx = button(m, /^Export \.docx$/);
    assert.ok(docx);
    await act(async () => {
      docx.click();
    });
    const sent = m.sent.find((message) => message.kind === "export-manuscript") as Extract<ClientMessage, { kind: "export-manuscript" }>;
    assert.ok(sent);
    assert.equal(sent.format, "docx");
    assert.equal(sent.productionId, "inkbound");
    assert.equal(sent.language, undefined, "a .docx carries no language");
    // EPUB asks for a language and refuses anything that is not a tag (codex on PR 916).
    await act(async () => {
      button(m, /^EPUB$/)!.click();
    });
    const language = m.container.querySelector('input[aria-label="Language"]') as HTMLInputElement;
    assert.equal(language.value, "en");
    await act(async () => {
      button(m, /^Export EPUB$/)!.click();
    });
    const epub = m.sent.filter((message) => message.kind === "export-manuscript").at(-1) as Extract<ClientMessage, { kind: "export-manuscript" }>;
    assert.equal(epub.format, "epub");
    assert.equal(epub.language, "en");
  });

  it("lists what was delivered as it progresses, with Cancel while running", async () => {
    const m = await mount(inkbound());
    await press(m, "export-manuscript");
    await act(async () => button(m, /^Other exports$/)!.click());
    await act(async () => {
      __applyEventForTest({ at: "2026-09-06T12:00:01Z", type: "export.progress", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", exportId: "ms_01J8F3K2QW9VZX4N7M0RTYB6H", status: "running", percent: 0, output: null, error: null });
    });
    assert.match(text(m), /Delivered/);
    assert.match(text(m), /running · 0%/);
    assert.ok(button(m, /^Cancel$/), "a running export can be cancelled");
    await act(async () => {
      __applyEventForTest({ at: "2026-09-06T12:00:02Z", type: "export.progress", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", exportId: "ms_01J8F3K2QW9VZX4N7M0RTYB6H", status: "done", percent: 100, output: "exports/inkbound-20260906120002-01j8f3.docx", error: null });
    });
    assert.match(text(m), /inkbound-20260906120002-01j8f3\.docx/);
    assert.match(text(m), /done/);
    assert.equal(button(m, /Show in folder/), undefined, "a browser session has no folder to open");
    assert.ok(button(m, /^Download$/), "a browser can download the completed manuscript");
  });

  it("with no prose the sheet says so and the press stays live (codex on PR 916)", async () => {
    const m = await mount(inkbound([CHAPTERS[1]!]));
    await press(m, "export-manuscript");
    await act(async () => button(m, /^Other exports$/)!.click());
    assert.match(text(m), /nothing to export · no chapter has prose yet/);
    assert.equal(button(m, /^Export \.docx$/)!.disabled, false);
  });
});

describe("a manuscript in (turn 131)", () => {
  it("Import asks the host, shows what was read before anything is written, and the press counts the chapters", async () => {
    const m = await mount(inkbound());
    await press(m, "import-manuscript");
    const asked = m.sent.find((message) => message.kind === "pick-manuscript") as Extract<ClientMessage, { kind: "pick-manuscript" }>;
    assert.ok(asked, "the host is asked for the file");
    assert.match(text(m), /Import manuscript/);
    assert.match(text(m), /reading…/);
    await act(async () => {
      __applyEventForTest({
        at: "2026-09-06T12:00:01Z",
        type: "manuscript.read-result",
        requestId: asked.requestId,
        worldId: FIXTURE_WORLD_ID,
        productionId: "inkbound",
        fileName: "Draft 3.docx",
        words: 4800,
        chapters: [{ title: "The keeping of the ledger", words: 2140 }, { title: "A called tide", words: 2660 }],
        headingLevel: "Heading 1",
        leftOut: 1,
        levels: [{ level: "title", label: "Title", count: 1, chosen: false }, { level: "heading1", label: "Heading 1", count: 2, chosen: true }, { level: "document", label: "Whole document", count: 1, chosen: false }],
        notes: 3,
        links: 1,
        after: 2,
      });
    });
    assert.match(text(m), /Draft 3\.docx · 4,800 words · read, nothing written yet/);
    assert.match(text(m), /2 chapters · Heading 1 as chapter titles · 1 heading above left out · 3 footnotes not carried · 1 link kept as words · after chapter 2 · nothing existing changes/);
    assert.ok(button(m, /^Whole document$/), "the whole document is always a choice (codex on PR 916)");
    const rows = [...m.container.querySelectorAll('[data-testid="manuscript-row"]')].map((row) => row.textContent);
    assert.deepEqual(rows, ["03The keeping of the ledger2,140 words", "04A called tide2,660 words"]);
    // Another level is one press away, and reads the held document again.
    const title = button(m, /^Title · 1$/);
    assert.ok(title);
    await act(async () => {
      title.click();
    });
    const reread = m.sent.find((message) => message.kind === "reread-manuscript") as Extract<ClientMessage, { kind: "reread-manuscript" }>;
    assert.equal(reread.headingLevel, "title");
    assert.equal(reread.requestId, asked.requestId);
    assert.equal(m.sent.filter((message) => message.kind === "import-manuscript").length, 0, "nothing written yet");
  });

  it("the import press imports by the request; done, the sheet closes and the door says what came from where", async () => {
    const m = await mount(inkbound());
    await press(m, "import-manuscript");
    const asked = m.sent.find((message) => message.kind === "pick-manuscript") as Extract<ClientMessage, { kind: "pick-manuscript" }>;
    await act(async () => {
      __applyEventForTest({
        at: "2026-09-06T12:00:01Z",
        type: "manuscript.read-result",
        requestId: asked.requestId,
        worldId: FIXTURE_WORLD_ID,
        productionId: "inkbound",
        fileName: "Draft 3.docx",
        words: 2140,
        chapters: [{ title: "The keeping of the ledger", words: 2140 }],
        headingLevel: "Heading 1",
        leftOut: 0,
        levels: [{ level: "heading1", label: "Heading 1", count: 1, chosen: true }],
        notes: 0,
        after: 2,
      });
    });
    const imp = button(m, /^Import 1 chapter$/);
    assert.ok(imp);
    await act(async () => {
      imp.click();
    });
    const sent = m.sent.find((message) => message.kind === "import-manuscript") as Extract<ClientMessage, { kind: "import-manuscript" }>;
    assert.equal(sent.requestId, asked.requestId);
    await act(async () => {
      __applyEventForTest({ at: "2026-09-06T12:00:02Z", type: "manuscript.import-result", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", created: 1, after: 2 });
    });
    assert.doesNotMatch(text(m), /Import manuscript/, "the sheet closes");
    assert.match(m.container.querySelector('[data-testid="imported-line"]')?.textContent ?? "", /imported · Draft 3\.docx · 1 chapter · after 2/);
  });

  it("a file that cannot be read is refused in the sheet, and Cancel writes nothing", async () => {
    const m = await mount(inkbound());
    await press(m, "import-manuscript");
    const asked = m.sent.find((message) => message.kind === "pick-manuscript") as Extract<ClientMessage, { kind: "pick-manuscript" }>;
    await act(async () => {
      __applyEventForTest({ at: "2026-09-06T12:00:01Z", type: "manuscript.read-result", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", fileName: "scan.docx", reason: "scan.docx has no text in it to read — it may be a scan." });
    });
    assert.match(text(m), /could not read · scan\.docx has no text in it to read/);
    assert.equal(button(m, /^Import /), undefined);
    await act(async () => {
      button(m, /^Cancel$/)!.click();
    });
    assert.ok(m.sent.some((message) => message.kind === "cancel-manuscript"));
    assert.ok(!m.sent.some((message) => message.kind === "import-manuscript"));
  });

  it("an imported chapter carries the mark beside its version", async () => {
    const m = await mount(inkbound([...CHAPTERS, { id: "the-keeping", file: "the-keeping-of-the-ledger", order: 3, title: "The keeping of the ledger", status: "draft", version: 1, words: 2140, source: "Draft 3.docx" }]));
    const row = [...m.container.querySelectorAll(".fy-row")].find((node) => node.textContent?.includes("The keeping of the ledger"));
    assert.ok(row);
    assert.match(row.textContent ?? "", /imported/);
    assert.doesNotMatch([...m.container.querySelectorAll(".fy-row")].find((node) => node.textContent?.includes("Neap"))?.textContent ?? "", /imported/);
  });
});

describe("Publish review (turn 224)", () => {
  it("opens private reading and listening with the optional dash rule off, then sends a read-only review", async () => {
    const m = await mount(inkbound());
    await press(m, "export-manuscript");
    assert.match(text(m), /Private reading & listening/);
    assert.match(text(m), /Read · EPUB/);
    assert.match(text(m), /Listen · M4B/);
    await act(async () => button(m, /^Review chapters$/)!.click());
    await act(async () => button(m, /^Formatting & style$/)!.click());
    const request = m.sent.find(message => message.kind === "publish-story" && message.input.action === "review");
    assert.ok(request && request.kind === "publish-story" && request.input.action === "review");
    assert.equal(request.input.settings.avoidEmDashes, false);
    assert.deepEqual(request.input.settings.chapterIds, ["neap", "her-own-hand"], "planned chapters are not silently omitted");
    assert.deepEqual(request.input.settings.outputs, ["epub"]);
    assert.equal(m.sent.some(message => message.kind === "save-chapter" || message.kind === "read-audiobook-chapter"), false);
  });
  it("shows exact text and narration impact before an explicit apply, and keeps a refused suggestion visible", async () => {
    const m = await mount(inkbound());
    await press(m, "export-manuscript");
    await act(async () => button(m, /^Review chapters$/)!.click());
    await act(async () => button(m, /^Formatting & style$/)!.click());
    const request = m.sent.find(message => message.kind === "publish-story" && message.input.action === "review");
    assert.ok(request && request.kind === "publish-story" && request.input.action === "review");
    const finding = { id: "a".repeat(64), chapterId: "neap", chapterTitle: "Neap", chapterFile: "01-neap", baseHash: "old-source",
      paragraph: 0, start: 0, end: 20, before: "Maren turned—she knew.", suggestion: "Maren turned. She knew.", reason: "Review the sentence break.", narration: ["p0.0"], kept: false };
    await act(async () => __applyEventForTest({ at: "2026-10-13T12:00:00Z", type: "story.published", worldId: FIXTURE_WORLD_ID,
      productionId: "inkbound", requestId: request.requestId, result: { review: { fingerprint: "b".repeat(64), settings: request.input.action === "review" ? request.input.settings : {} as never,
        chapters: [{ id: "neap", title: "Neap", words: 10, audioProblems: [] }], findings: [finding], warnings: [], blockers: [] } } }));
    await act(async () => button(m, /^Review change$/)!.click());
    assert.match(text(m), /Before/); assert.match(text(m), /recording in this paragraph/);
    assert.equal(m.sent.some(message => message.kind === "publish-story" && message.input.action === "decide"), false);
    await act(async () => button(m, /^Apply to manuscript$/)!.click());
    const decision = m.sent.findLast(message => message.kind === "publish-story" && message.input.action === "decide");
    assert.ok(decision && decision.kind === "publish-story" && decision.input.action === "decide");
    assert.equal(decision.input.decision, "apply"); assert.equal(decision.input.finding.baseHash, "old-source");
    assert.equal(decision.input.replacement, finding.suggestion);
    await act(async () => __applyEventForTest({ at: "2026-10-13T12:00:01Z", type: "story.published", worldId: FIXTURE_WORLD_ID,
      productionId: "inkbound", requestId: decision.requestId, result: { error: "The source changed. Recheck before applying." } }));
    assert.match(text(m), /The source changed/);
    assert.ok(button(m, /^Apply to manuscript$/), "a refused write leaves the proposal visible");
    assert.equal(m.sent.some(message => message.kind === "read-audiobook-chapter"), false, "applying text never generates narration");
  });
  it("reopens a running edition and follows its original operation through completion", async () => {
    const m = await mount(inkbound()); await press(m, "export-manuscript");
    const list = m.sent.find(message => message.kind === "list-story-publications");
    assert.ok(list && list.kind === "list-story-publications");
    const edition = { id: "00000000-0000-4000-8000-000000000001", worldId: FIXTURE_WORLD_ID, productionId: "inkbound",
      createdAt: "2026-10-13T12:00:00Z", fingerprint: "c".repeat(64), status: "creating" as const, phase: "Preparing EPUB", files: [],
      settings: { title: "Inkbound", author: "", language: "en", description: "", label: "Private edition", cover: null, chapterIds: ["neap"], outputs: ["epub"] as "epub"[], avoidEmDashes: false } };
    await act(async () => __applyEventForTest({ at: edition.createdAt, type: "story.editions", requestId: list.requestId, editions: [edition] }));
    await act(async () => button(m, /^View preparation$/)!.click());
    assert.ok(button(m, /^Cancel preparation$/), "reopened work retains cancellation");
    await act(async () => __applyEventForTest({ at: edition.createdAt, type: "story.published", worldId: FIXTURE_WORLD_ID, productionId: "inkbound",
      requestId: list.requestId, result: { edition: { ...edition, status: "preview", phase: "Preview ready", files: [{ format: "epub", name: "story.epub", bytes: 42, sha256: "d".repeat(64) }] } } }));
    assert.ok(button(m, /^Create edition$/), "completion from the original request updates the reopened view");
    assert.equal(button(m, /^Cancel preparation$/), undefined);
    assert.doesNotMatch(text(m), /Save EPUB/);
    await act(async () => __setStateForTest(inkbound(), { connection: "closed" }));
    await act(async () => __setStateForTest(inkbound(), { connection: "open" }));
    const refreshed = m.sent.findLast(message => message.kind === "publish-story" && message.input.action === "list");
    assert.ok(refreshed && refreshed.kind === "publish-story");
    await act(async () => __applyEventForTest({ at: edition.createdAt, type: "story.published", worldId: FIXTURE_WORLD_ID, productionId: "inkbound",
      requestId: refreshed.requestId, result: { editions: [{ ...edition, status: "ready", phase: "Files ready",
        files: [{ format: "epub", name: "story.epub", bytes: 42, sha256: "d".repeat(64) }] }] } }));
    assert.match(text(m), /Save EPUB/, "reconnect recovers completion even when the final event was missed");

  });

});

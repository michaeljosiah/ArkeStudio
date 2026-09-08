import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ChapterSummary, ClientMessage, ClientState } from "@arke-studio/contracts";
import { ChapterTreeScreen } from "../src/screens/production.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
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
  container: HTMLElement;
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
  });

  it("with no prose the sheet says so and the press stays live (codex on PR 916)", async () => {
    const m = await mount(inkbound([CHAPTERS[1]!]));
    await press(m, "export-manuscript");
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

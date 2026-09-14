import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  audiobookTextHash,
  type ArtifactSidecar,
  type ChapterAudiobook,
  type ChapterSummary,
  type ChapterVoices,
  type ClientMessage,
  type ClientState,
} from "@arke-studio/contracts";
import { ChapterScreen } from "../src/screens/chapter-workspace.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The chapter's Audiobook view (design turn 146, SPEC-047 R-30): the saved prose as blocks
 * with the title first and a state a block, the editor kept underneath and hidden, the head
 * holding `Read the chapter` with the count, a price asked once and answered by token, and a
 * run's record standing once it finishes. Mounted through the route so the view comes from
 * the address, as it does when a row on the door opens it.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), {
  pause() {},
  play: () => Promise.resolve(),
});
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

const ROUTE = `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/chapters/neap?view=audiobook`;
const HASH = `sha256:${"a".repeat(64)}`;
const LINE = "“You hear it too,” she said.";
// HTML in the body sends the Bible's gate to the source editor, the one that mounts under
// linkedom (as the workspace's own test does); the rich editor's choice is the Bible's.
const BODY = `Maren counted the bells.\n\n${LINE}\n\n***\n\nSix, and the tide <br> not yet called.`;
const AT = "2026-09-14T09:00:00.000Z";

const CHAPTERS: ChapterSummary[] = [
  { id: "slack-water", file: "01-slack-water", order: 1, title: "Slack water", status: "drafted", version: 4, words: 4490 },
  { id: "neap", file: "01-neap", order: 2, title: "The counting of bells", status: "drafting", version: 4, words: 1900, bodyHash: HASH },
];

/** A kept take on the shelf: what a record's `artifactId` must name for a block to be made. */
function takeArtifact(id: string, chapterId: string, block = "title"): ArtifactSidecar {
  return {
    id,
    kind: "audio",
    file: `${chapterId}-${block}.wav`,
    hash: `sha256:${"b".repeat(16)}`,
    origin: { by: "system", producedBy: "audiobook" },
    links: [chapterId],
    production: "inkbound",
    generation: {
      source: "audiobook",
      productionId: "inkbound",
      chapterId,
      chapterVersion: 4,
      block,
      paragraph: block === "title" ? -1 : 0,
      textHash: "text-v1:x",
      provider: "kokoro",
      model: "kokoro-82m",
      voiceId: "bm_george",
      voiceLabel: "George",
      parts: 1,
      characters: 10,
      estimatedMicroUsd: 0,
      costMicroUsd: 0,
    },
    created: AT,
  };
}
/** The one artifact every take in `record()` names, so a made block has its file on the shelf. */
const KEPT = "ar_01J8F3K2QW9VZX4N7M0RTYB6H1";

function inkbound(reading: "narrator" | "cast" = "narrator"): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      artifacts: [...world.artifacts, takeArtifact(KEPT, "neap", "p0.0")],
      productions: [
        ...world.productions,
        {
          ...salt,
          meta: { ...salt.meta, id: "inkbound", format: "story" as const, title: "Inkbound" },
          story: { ...(salt.story ?? { version: 1 }), version: 3 },
          chapters: CHAPTERS,
          ...(reading === "cast" ? { audiobook: { schemaVersion: 1 as const, reading } } : {}),
        },
      ],
    },
  };
}

type Mounted = { container: HTMLElement; root: Root; sent: ClientMessage[] };
const open: Mounted[] = [];

function capture(sent: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as ArkeBridge;
}

async function mount(state: ClientState, route = ROUTE): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(capture(sent));
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/story/chapters/:chapterId" element={<ChapterScreen />} />
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

const text = (m: Mounted): string => m.container.textContent ?? "";
const q = (m: Mounted, selector: string): HTMLElement | null => m.container.querySelector(selector) as HTMLElement | null;
const all = (m: Mounted, selector: string): HTMLElement[] => [...m.container.querySelectorAll(selector)] as HTMLElement[];

async function answerOpen(m: Mounted, extra: { audiobook?: ChapterAudiobook; audiobookMissing?: string[]; voices?: ChapterVoices } = {}): Promise<void> {
  const ask = m.sent.findLast((message) => message.kind === "open-chapter") as Extract<ClientMessage, { kind: "open-chapter" }>;
  assert.ok(ask, "opening asks for the body");
  await act(async () => {
    __applyEventForTest({
      at: AT,
      type: "chapter.open-result",
      requestId: ask.requestId,
      worldId: FIXTURE_WORLD_ID,
      productionId: "inkbound",
      chapterId: "neap",
      disposition: "opened",
      body: BODY,
      version: 4,
      hash: HASH,
      versions: [1, 2, 3],
      ...extra,
    });
  });
}

const CAST = { version: 4, hash: HASH, derivedAt: AT, passes: 1, dropped: 0, omitted: 0, lines: [{ speaker: "Maren Kest", sheet: "maren-kest", paragraph: 1, occurrence: 0, quote: "“You hear it too,”" }] };

const NARRATION_KEYS = ["title", "p0.0", "p1.0", "p3.0"];

function record(keys: readonly string[], texts: Record<string, string>): ChapterAudiobook {
  return {
    schemaVersion: 1,
    chapterVersion: 4,
    hash: HASH,
    updatedAt: AT,
    takes: Object.fromEntries(
      keys.map((key) => [
        key,
        {
          artifactId: KEPT,
          textHash: audiobookTextHash(texts[key]!),
          reader: { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", label: "George" },
          format: "wav" as const,
          characters: texts[key]!.length,
          parts: 1,
          estimatedMicroUsd: 0,
          costMicroUsd: 0,
          madeAt: AT,
        },
      ]),
    ),
    flags: {},
  };
}

describe("the Audiobook view (turn 146)", () => {
  it("shows the saved prose as blocks — the title first, a scene break left out — with the editor hidden underneath", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    assert.ok(q(m, '[data-testid="audiobook-column"]'), "the view is the address's");
    assert.ok(q(m, ".fy-ch__manuscript[hidden]"), "the editor stays mounted, hidden");
    const rows = all(m, ".fy-ab__block");
    assert.deepEqual(
      rows.map((row) => row.getAttribute("data-state")),
      ["not made", "not made", "not made", "not made"],
      "the title, two paragraphs and the last one; the stars are no block",
    );
    assert.equal(rows[0]!.querySelector(".fy-ab__mark")!.textContent, "title");
    assert.match(rows[0]!.textContent ?? "", /Chapter 2 · The counting of bells/);
    assert.equal(rows[1]!.querySelector(".fy-ab__mark")!.textContent, "narrator", "under the narrator's reading every block is the narrator's");
    assert.match(text(m), /4 blocks · 0 made · 4 not made/);
    const press = q(m, '[data-testid="read-audiobook"]');
    assert.ok(press);
    assert.equal(press.textContent, "Read the chapter · 4 blocks", "a local narrator costs nothing, so no price rides on the press");
    assert.ok(!/nothing is|never|until you/i.test(text(m)), "no caption explains the control");
  });

  it("the press reads the chapter, the run says how far it is, and a run's record stands once it finishes", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    await act(async () => q(m, '[data-testid="read-audiobook"]')!.click());
    const asked = m.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.ok(asked, "the press asks for the chapter by its file");
    assert.equal(asked.chapterFile, "01-neap");
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", toMake: 4, blocks: 4 }));
    assert.match(text(m), /reading… 0 of 4/);
    assert.ok(all(m, "button").some((button) => button.textContent === "Stop"), "a run can be stopped");
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.progress", ...ids, block: "title", outcome: "made", made: 1, toMake: 4 }));
    assert.match(text(m), /reading… 1 of 4/);
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.finished", ...ids, outcome: "read", made: 4, flagged: 0, record: record(NARRATION_KEYS, texts) }));
    assert.deepEqual(
      all(m, ".fy-ab__block").map((row) => row.getAttribute("data-state")),
      ["made", "made", "made", "made"],
      "the record the run finished with says every block is made",
    );
    assert.match(text(m), /4 blocks · 4 made/);
    assert.equal(q(m, '[data-testid="read-audiobook"]'), null, "nothing left to make, so no press");
  });

  it("a replayed start reaches every refresh and changes nothing a window already knows", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", toMake: 4, blocks: 4 }));
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.progress", ...ids, block: "title", outcome: "made", made: 1, toMake: 4 }));
    // The world snapshot refreshes after every take lands, and each refresh replays the start.
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", toMake: 0, blocks: 0, replayed: true }));
    assert.match(text(m), /reading… 1 of 4/, "the progress the window knows stands");
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.finished", ...ids, outcome: "read", made: 4, flagged: 0 }));
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", toMake: 0, blocks: 0, replayed: true }));
    assert.doesNotMatch(text(m), /reading…/, "a finished run is not flipped back to going by a late replay");
    assert.ok(!all(m, "button").some((button) => button.textContent === "Stop"));
  });

  it("a block whose words moved is stale, and a flagged block says why", async () => {
    const m = await mount(inkbound());
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells, twice.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    const held = record(NARRATION_KEYS, texts);
    held.flags["p3.0"] = { reason: "the voice job failed", at: "2026-09-14T10:00:00.000Z" };
    await answerOpen(m, { audiobook: held });
    assert.deepEqual(
      all(m, ".fy-ab__block").map((row) => row.getAttribute("data-state")),
      ["made", "stale", "made", "flagged"],
    );
    assert.match(text(m), /4 blocks · 2 made · 1 stale · 1 flagged/);
    assert.equal(q(m, '[data-testid="read-audiobook"]')!.textContent, "Read the chapter · 2 blocks", "stale and flagged blocks are what a press makes");
    await act(async () => all(m, ".fy-ab__block")[3]!.click());
    assert.match(text(m), /the voice job failed/, "the block panel says why it is flagged");
  });

  it("a price is asked once and answered by token, or dismissed", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", toMake: 4, blocks: 4 }));
    await act(async () =>
      __applyEventForTest({
        at: AT,
        type: "audiobook.priced",
        ...ids,
        characters: 120,
        estimatedMicroUsd: 36_000,
        confirmationToken: "tok",
        voices: [{ label: "Low tide", provider: "elevenlabs", characters: 120, estimatedMicroUsd: 36_000 }],
      }),
    );
    const confirm = all(m, "button").find((button) => button.textContent?.startsWith("Confirm 120 characters"));
    assert.ok(confirm, "the price is one press, naming the voice");
    assert.match(confirm.textContent ?? "", /Low tide · elevenlabs/);
    await act(async () => confirm.click());
    const answered = m.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.equal(answered.confirmationToken, "tok", "the answer carries the token");
    await act(async () =>
      __applyEventForTest({ at: AT, type: "audiobook.priced", ...ids, characters: 120, estimatedMicroUsd: 36_000, confirmationToken: "tok", voices: [] }),
    );
    const cancel = all(m, "button").find((button) => button.textContent === "Cancel");
    assert.ok(cancel);
    await act(async () => cancel.click());
    assert.ok(q(m, '[data-testid="read-audiobook"]'), "declined, the press is back");
  });

  it("a cloned voice's consent is kept for the price's answer, and declining the consent clears the run (codex on PR 1180)", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    const requestId = "01J8F3K2QW9VZX4N7M0RTYB6H1";
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId, toMake: 4, blocks: 4 }));
    await act(async () =>
      __applyEventForTest({ at: AT, type: "voice.upload-confirmation-required", requestId, worldId: FIXTURE_WORLD_ID, command: "read-audiobook-chapter", destinationLabel: "the studio's ComfyUI", confirmationToken: "engine-1" }),
    );
    const allow = all(m, "button").find((button) => /allow|send|confirm|yes/i.test(button.textContent ?? "") && !/cancel|not now/i.test(button.textContent ?? ""));
    assert.ok(allow, `the consent is one press: ${all(m, "button").map((b) => b.textContent).join(" | ")}`);
    await act(async () => allow.click());
    const consented = m.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.equal(consented.voiceUploadConfirmedFor, "engine-1");
    // The restarted run passes the gate and asks the price; its answer must carry the consent too.
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId, toMake: 4, blocks: 4 }));
    await act(async () =>
      __applyEventForTest({ at: AT, type: "audiobook.priced", ...ids, characters: 120, estimatedMicroUsd: 36_000, confirmationToken: "tok", voices: [{ label: "Low tide", provider: "elevenlabs", characters: 120, estimatedMicroUsd: 36_000 }] }),
    );
    const confirm = all(m, "button").find((button) => button.textContent?.startsWith("Confirm 120 characters"));
    assert.ok(confirm);
    await act(async () => confirm.click());
    const both = m.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.equal(both.confirmationToken, "tok");
    assert.equal(both.voiceUploadConfirmedFor, "engine-1", "the price's answer carries the consent, or the two prompts chase each other");

    // The run over, the consent is spent (codex on PR 1180): the next press is asked again, as
    // the engine's per-request rule says, rather than sending the recording on this window's word.
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.finished", ...ids, outcome: "read", made: 3, flagged: 1 }));
    await act(async () => q(m, '[data-testid="read-audiobook"]')!.click());
    const fresh = m.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.equal(fresh.voiceUploadConfirmedFor, undefined, "a finished run's consent does not ride on the next press");

    // Declining the consent: the coordinator's run returned without a finished event, so the window clears its own.
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId, toMake: 4, blocks: 4 }));
    await act(async () =>
      __applyEventForTest({ at: AT, type: "voice.upload-confirmation-required", requestId, worldId: FIXTURE_WORLD_ID, command: "read-audiobook-chapter", destinationLabel: "the studio's ComfyUI", confirmationToken: "engine-1" }),
    );
    const decline = all(m, "button").find((button) => /cancel|not now/i.test(button.textContent ?? ""));
    assert.ok(decline);
    await act(async () => decline.click());
    assert.doesNotMatch(text(m), /reading…/, "no ghost run");
    assert.ok(q(m, '[data-testid="read-audiobook"]'), "the press is back");
  });

  it("a block's takes are this chapter's, and the press waits out a pending save", async () => {
    const state = inkbound();
    const world = state.world!;
    const m = await mount({ ...state, world: { ...world, artifacts: [...world.artifacts, takeArtifact("ar_01J8F3K2QW9VZX4N7M0RTYB6A1", "neap"), takeArtifact("ar_01J8F3K2QW9VZX4N7M0RTYB6A2", "slack-water")] } });
    await answerOpen(m);
    await act(async () => all(m, ".fy-ab__block")[0]!.click());
    const takes = q(m, '[data-testid="audiobook-takes"]')!;
    assert.match(takes.textContent ?? "", /Takes1/, "one take of this chapter's title, not the other chapter's");

    // Typing, then the press: the read waits for the save, and goes out once it lands.
    await act(async () => q(m, ".fy-seg__item:not(.fy-seg__item--active)")!.click());
    const area = q(m, "textarea.fy-ch__source");
    assert.ok(area, "the manuscript view's source editor");
    const key = Object.keys(area).find((k) => k.startsWith("__reactProps$"))!;
    const props = (area as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!;
    await act(async () => props.onChange({ target: { value: `${BODY}\n\nA new line.` } }));
    await act(async () => q(m, ".fy-seg__item:not(.fy-seg__item--active)")!.click());
    const before = m.sent.filter((message) => message.kind === "read-audiobook-chapter").length;
    await act(async () => q(m, '[data-testid="read-audiobook"]')!.click());
    assert.equal(m.sent.filter((message) => message.kind === "read-audiobook-chapter").length, before, "not sent while the draft is unsaved");
    const save = m.sent.findLast((message) => message.kind === "save-chapter") as Extract<ClientMessage, { kind: "save-chapter" }>;
    assert.ok(save, "the press flushed the draft");
    const saveRequest = save.requestId;
    assert.ok(saveRequest);
    await act(async () =>
      __applyEventForTest({ at: AT, type: "chapter.save-result", requestId: saveRequest, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterFile: "01-neap", disposition: "saved", version: 4, hash: `sha256:${"c".repeat(64)}` }),
    );
    assert.equal(
      m.sent.filter((message) => message.kind === "read-audiobook-chapter").length,
      before + 1,
      `sent once the save landed: ${m.sent.map((message) => message.kind).join(" | ")} · ${text(m).slice(0, 200)}`,
    );
  });

  it("a take the shelf no longer holds is not made, and the press counts it (codex on PR 1180)", async () => {
    const m = await mount(inkbound());
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    const held = record(NARRATION_KEYS, texts);
    held.takes["p1.0"] = { ...held.takes["p1.0"]!, artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6H9" };
    await answerOpen(m, { audiobook: held });
    assert.deepEqual(all(m, ".fy-ab__block").map((row) => row.getAttribute("data-state")), ["made", "made", "not made", "made"], "the record is an index, not the shelf");
    assert.equal(q(m, '[data-testid="read-audiobook"]')!.textContent, "Read the chapter · 1 block");
  });

  it("a take whose media the coordinator found gone is not made until a run's record says otherwise (codex on PR 1183)", async () => {
    const m = await mount(inkbound());
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    const held = record(NARRATION_KEYS, texts);
    await answerOpen(m, { audiobook: held, audiobookMissing: [KEPT] });
    assert.deepEqual(all(m, ".fy-ab__block").map((row) => row.getAttribute("data-state")), ["not made", "not made", "not made", "not made"], "the sidecar is there; the coordinator says the media is not");
    assert.equal(q(m, '[data-testid="read-audiobook"]')!.textContent, "Read the chapter · 4 blocks", "the press is offered, so the run can make them again");
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", toMake: 4, blocks: 4 }));
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.finished", ...ids, outcome: "read", made: 4, flagged: 0, record: { ...held, updatedAt: "2026-09-14T10:00:00.000Z" } }));
    assert.deepEqual(all(m, ".fy-ab__block").map((row) => row.getAttribute("data-state")), ["made", "made", "made", "made"], "the run's record is newer, and what it found gone it has made again");
  });

  it("a retired character keeps its name in the margin and loses its voice, so the narrator's take for it is made, not stale (codex on PR 1180)", async () => {
    const state = inkbound("cast");
    const world = state.world!;
    const m = await mount({ ...state, world: { ...world, sheets: world.sheets.map((sheet) => (sheet.id === "maren-kest" ? { ...sheet, retired: true } : sheet)) } });
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": "“You hear it too,”", "p1.1": "she said.", "p3.0": "Six, and the tide <br> not yet called." };
    const held = record(Object.keys(texts), texts);
    held.takes["p1.0"] = { ...held.takes["p1.0"]!, assigned: held.takes["p1.0"]!.reader, substituted: "no voice", sheet: "maren-kest" };
    await answerOpen(m, { audiobook: held, voices: CAST });
    const rows = all(m, ".fy-ab__block");
    assert.equal(rows.length, 5);
    const mark = rows[2]!.querySelector(".fy-ab__mark")!;
    assert.equal(mark.textContent, FIXTURE_STATE.world!.sheets.find((s) => s.id === "maren-kest")!.name, "the speaker's name stays");
    assert.ok(mark.className.includes("fy-ab__mark--warn"), "and it is said to have no voice");
    assert.deepEqual(rows.map((row) => row.getAttribute("data-state")), ["made", "made", "made", "made", "made"], "the coordinator made the line in the narrator's stead, and this side agrees");
  });

  it("under the cast's reading a line carries its speaker in the margin", async () => {
    const m = await mount(inkbound("cast"));
    await answerOpen(m, { voices: CAST });
    const rows = all(m, ".fy-ab__block");
    assert.equal(rows.length, 5, "the line splits its paragraph: the quote, then the rest");
    const marks = rows.map((row) => row.querySelector(".fy-ab__mark")!.textContent);
    assert.equal(marks[0], "title");
    assert.ok(marks[2] === "Maren Kest" || marks[2] === FIXTURE_STATE.world!.sheets.find((s) => s.id === "maren-kest")?.name, `the speaker, not the narrator: ${marks[2]}`);
  });
});

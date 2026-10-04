import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  audiobookTextHash,
  type ArtifactSidecar,
  type AudiobookDirection,
  type CadencePlan,
  type ChapterAudiobook,
  type ManifestModel,
  type ChapterSummary,
  type ChapterVoices,
  type IllustrationProposal,
  type IllustrationRow,
  type ClientMessage,
  type ClientState,
} from "@arke-studio/contracts";
import { ChapterScreen } from "../src/screens/chapter-workspace.js";
import { cueLabel } from "../src/screens/chapter-audiobook.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { HEAR_ANSWER_MS, HEAR_NO_ANSWER, __applyEventForTest, __connectionStatusForTest, __handleFrameForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { dismissPlayback, playbackSnapshot, setAudioFactoryForTest } from "../src/lib/audio.js";
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

function inkbound(reading: "narrator" | "performed" | "cast" = "narrator"): ClientState {
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
          ...(reading !== "narrator" ? { audiobook: { schemaVersion: 1 as const, reading } } : {}),
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

async function mount(state: ClientState, route = ROUTE, keepStore = false): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(capture(sent));
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    if (!keepStore) __setStateForTest(state, { connection: "open" });
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

/** Arke's dock, put away in the Audiobook view until the toolbar's press opens it (design turn 194, rule 13). */
async function openArke(m: Mounted): Promise<void> {
  if (q(m, '[data-testid="chapter-workspace"]')?.getAttribute("data-dock") === "true") return;
  await act(async () => q(m, '[data-testid="audiobook-arke"]')!.click());
}
/** An item of the toolbar's Direct and illustrate menu (design turn 194, rule 3), the menu opened to reach it. */
async function menuItem(m: Mounted, testId: string): Promise<HTMLElement | null> {
  if (q(m, ".fy-ab__toolmenu") === null && q(m, '[data-testid="direct-illustrate"]') !== null) await act(async () => q(m, '[data-testid="direct-illustrate"]')!.click());
  return q(m, `[data-testid="${testId}"]`);
}

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

/** The rows a block's reader is judged by (SPEC-047 R-9): the shipped Kokoro and Eleven v3 cadence, as the manifest declares them. */
const VOICE_ROWS: ManifestModel[] = [
  {
    id: "kokoro-82m",
    provider: "kokoro",
    capability: "voice-tts",
    displayName: "Kokoro 82M",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { audioFormat: "wav" },
    pricing: { kind: "unmetered" },
    cadence: { deliveries: ["measured", "urgent"], speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none",
      deliveryMappings: { measured: { settings: { speed: 0.92 } }, urgent: { settings: { speed: 1.15 } } } },
  },
  {
    id: "eleven-v3",
    provider: "elevenlabs",
    capability: "voice-tts",
    displayName: "Eleven v3",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { audioFormat: "mp3", maxPromptChars: 5000 },
    pricing: { kind: "perCharacter", microUsdPerCharacter: 100 },
    cadence: { deliveries: ["measured", "whispered", "breaking", "cold", "warm", "urgent"], speed: { min: 0.7, max: 1.2 }, pause: "best-effort-audio-tag",
      emphasis: "best-effort-capitalization", breath: "best-effort-audio-tag", outputTimestamps: "none", phrase: "best-effort-tag",
      sounds: { sighs: "sighs", laughs: "laughs" },
      deliveryMappings: { measured: { settings: { stability: 0.5 } }, whispered: { settings: { stability: 0.5 }, tag: "whispers" }, cold: { settings: { stability: 1 }, tag: "coldly" } } },
  },
];
/** The fixture with the voice rows in its manifest, so the panel has a row to read. */
function voiced(state: ClientState): ClientState {
  return { ...state, app: { ...state.app, manifest: { ...state.app.manifest!, models: [...state.app.manifest!.models, ...VOICE_ROWS] } } };
}
const SOURCE = `sha256:${"a".repeat(64)}`;
function directed(text: string, delivery: "measured" | "whispered" | "breaking" | "cold" | "warm" | "urgent", extra: Partial<CadencePlan> = {}): AudiobookDirection {
  return { textHash: audiobookTextHash(text), plan: { schemaVersion: 1, sourceTextHash: SOURCE, delivery, speed: 1, cues: [], ...extra }, at: AT };
}

function record(keys: readonly string[], texts: Record<string, string>): ChapterAudiobook {
  return {
    schemaVersion: 1,
    chapterVersion: 4,
    hash: HASH,
    updatedAt: AT,
    direction: {},
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

describe("a picture Arke made lands on its block in the open window (turn 191a)", () => {
  it("shows the chip and the panel's picture from the picture's own word, without a reload", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    assert.equal(all(m, '[data-testid="audiobook-picture-chip"]').length, 0);
    const made: ChapterAudiobook = {
      ...record([], {}),
      pictures: { "p1.0": { file: "world-art.png", source: "generated", textHash: audiobookTextHash(LINE), at: AT } },
    };
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.picture-made", requestId: "01J8F3K2QW9VZX4N7M0RTYB6H9", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap", block: "p1.0", state: "made", record: made }));
    assert.equal(all(m, '[data-testid="audiobook-picture-chip"]').length, 1, "the margin's chip is there");
    await act(async () => all(m, ".fy-ab__block")[2]!.click());
    assert.ok(q(m, ".fy-ab__picture .fy-ab__picnow"), "and the panel shows the picture, with Remove");
  });

  it("and one made as part of Illustrate this chapter arrives as the record, one picture after another", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    const picture = (text: string) => ({ file: "world-art.png", source: "generated" as const, textHash: audiobookTextHash(text), at: AT });
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.record", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap", record: { ...record([], {}), pictures: { "p0.0": picture("Maren counted the bells.") } } }));
    assert.equal(all(m, '[data-testid="audiobook-picture-chip"]').length, 1);
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.record", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap", record: { ...record([], {}), updatedAt: "2026-09-14T09:00:05.000Z", pictures: { "p0.0": picture("Maren counted the bells."), "p1.0": picture(LINE) } } }));
    assert.equal(all(m, '[data-testid="audiobook-picture-chip"]').length, 2);
  });
});

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
    const replayed = { at: AT, type: "audiobook.started" as const, ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", toMake: 0, blocks: 0, replayed: true as const };
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", toMake: 4, blocks: 4 }));
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.progress", ...ids, block: "title", outcome: "made", made: 1, toMake: 4 }));
    // The world snapshot refreshes after every take lands, and each refresh replays the start
    // behind it: the snapshot must not take the counts with it (the door's live check on slice 3).
    await act(async () => __handleFrameForTest({ kind: "snapshot", seq: 3, state: inkbound() }));
    await act(async () => __applyEventForTest(replayed));
    assert.match(text(m), /reading… 1 of 4/, "the progress the window knows stands");
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.finished", ...ids, outcome: "read", made: 4, flagged: 0 }));
    await act(async () => __handleFrameForTest({ kind: "snapshot", seq: 5, state: inkbound() }));
    await act(async () => __applyEventForTest(replayed));
    assert.doesNotMatch(text(m), /reading…/, "a finished run is not flipped back to going by a late replay");
    assert.ok(!all(m, "button").some((button) => button.textContent === "Stop"));
    // A window that rejoins may have missed the run's end: it starts from the replay, which
    // says only that a run is going and can be stopped.
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H2", toMake: 4, blocks: 4 }));
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.progress", ...ids, block: "title", outcome: "made", made: 2, toMake: 4 }));
    await act(async () => __connectionStatusForTest("open"));
    await act(async () => __handleFrameForTest({ kind: "snapshot", seq: 1, state: inkbound() }));
    assert.doesNotMatch(text(m), /reading…/, "the run the window held is gone with the rejoin");
    await act(async () => __applyEventForTest({ ...replayed, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H2" }));
    assert.ok(all(m, "button").some((button) => button.textContent === "Stop"), "the replay says a run is going");
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
    assert.match(confirm.textContent ?? "", /Low tide · ElevenLabs · cloud/, "the provider by its name and place, never its id (turn 165)");
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

  it("a confirmed price says starting… until the run answers, and cannot be pressed twice (2026-10-03)", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    const requestId = "01J8F3K2QW9VZX4N7M0RTYB6H1";
    const priced = () => act(async () => __applyEventForTest({ at: AT, type: "audiobook.priced", ...ids, characters: 120, estimatedMicroUsd: 36_000, confirmationToken: "tok", voices: [{ label: "Low tide", provider: "elevenlabs", characters: 120, estimatedMicroUsd: 36_000 }] }));
    const confirm = () => q(m, '[data-testid="audiobook-confirm"]') as HTMLButtonElement | null;
    const reads = () => m.sent.filter((message) => message.kind === "read-audiobook-chapter").length;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId, toMake: 4, blocks: 4 }));
    await priced();
    assert.match(confirm()!.textContent ?? "", /^Confirm 120 characters/);
    const before = reads();
    await act(async () => confirm()!.click());
    assert.equal(reads(), before + 1);
    assert.equal(confirm()!.textContent, "starting…", "the press shows it was taken");
    assert.equal(confirm()!.disabled, true);
    await act(async () => confirm()!.click());
    assert.equal(reads(), before + 1, "a second press sends nothing");
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId, toMake: 4, blocks: 4 }));
    assert.equal(confirm(), null);
    assert.match(text(m), /reading… 0 of 4/, "the run's own line takes over");

    // Refused, or asked again: the confirm is never left on starting….
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.finished", ...ids, outcome: "stopped", made: 0, flagged: 0 }));
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId, toMake: 4, blocks: 4 }));
    await priced();
    await act(async () => confirm()!.click());
    await priced();
    assert.match(confirm()!.textContent ?? "", /^Confirm 120 characters/, "a price asked again is asked as a price");
    await act(async () => confirm()!.click());
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.finished", ...ids, outcome: "refused", made: 0, flagged: 0, reason: "the prose moved" }));
    assert.equal(confirm(), null);
    assert.match(text(m), /the prose moved/);
  });

  it("a cloned voice's consent is kept for the price's answer, and declining the consent clears the run (codex on PR 1180)", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    const requestId = "01J8F3K2QW9VZX4N7M0RTYB6H1";
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId, toMake: 4, blocks: 4 }));
    await act(async () =>
      __applyEventForTest({ at: AT, type: "voice.upload-confirmation-required", requestId, worldId: FIXTURE_WORLD_ID, command: "read-audiobook-chapter", destinationLabel: "the studio's ComfyUI", confirmationToken: "engine-1", destinationNotice: "The recording is saved as a voice on the account." }),
    );
    // With what the vendor does with the clip (SPEC-046 R-17), as every other read shows it.
    assert.equal(q(m, '[data-testid="remote-voice-upload-notice"]')?.textContent, "The recording is saved as a voice on the account.");
    const allow = all(m, "button").find((button) => /allow|send|confirm|yes/i.test(button.textContent ?? "") && !/cancel|not now/i.test(button.textContent ?? ""));
    assert.ok(allow, `the consent is one press: ${all(m, "button").map((b) => b.textContent).join(" | ")}`);
    await act(async () => allow.click());
    const consented = m.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.equal(consented.voiceUploadConfirmedFor, "engine-1");
    // The restarted run passes the gate and asks the price; its answer must carry the consent too.
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId, toMake: 4, blocks: 4 }));
    await act(async () =>
      __applyEventForTest({ at: AT, type: "audiobook.priced", ...ids, characters: 120, estimatedMicroUsd: 36_000, confirmationToken: "tok", voices: [{ label: "Low tide", provider: "elevenlabs", characters: 120, estimatedMicroUsd: 36_000 }], notices: ["Harbour glass · first read · clone charge, priced by BreezeBlue"] }),
    );
    const confirm = all(m, "button").find((button) => button.textContent?.startsWith("Confirm 120 characters"));
    assert.ok(confirm);
    // What a first read through a slot-keeping reader adds, beside the price it is not in (SPEC-046 R-40).
    assert.equal(q(m, '[data-testid="audiobook-notice"]')?.textContent, "Harbour glass · first read · clone charge, priced by BreezeBlue");
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

  it("the margin names who speaks in a colour of their own, and the filter dims the rest and plays only them (SPEC-047 R-33)", async () => {
    const m = await mount(inkbound("cast"));
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": "“You hear it too,”", "p1.1": "she said.", "p3.0": "Six, and the tide <br> not yet called." };
    await answerOpen(m, { audiobook: record(Object.keys(texts), texts), voices: CAST });
    const rows = all(m, ".fy-ab__block");
    assert.deepEqual(rows.map((row) => row.getAttribute("data-speaker")), ["narrator", "narrator", "maren-kest", "narrator", "narrator"]);
    assert.ok(rows[2]!.className.includes("fy-voice--1") && rows[2]!.className.includes("fy-ab__block--line"), "Maren's line takes the first colour and the line's tint");
    assert.ok(rows[1]!.className.includes("fy-voice--narrator") && !rows[1]!.className.includes("fy-ab__block--line"), "narration is grey and untinted");
    assert.ok(rows[2]!.querySelector(".fy-ab__source"), "a made take shows how it was made");
    // One filter press, its menu the speakers with their counts (design turn 194, rule 6).
    const mark = rows[2]!.querySelector(".fy-ab__mark")!.textContent;
    const press = () => q(m, '[data-testid="audiobook-filter"]')!;
    assert.equal(press().textContent, "Everyone 5", "everyone, counted, on the press");
    await act(async () => press().click());
    const options = all(m, '.fy-ab__filtermenu [role="menuitemradio"]');
    assert.deepEqual(options.map((option) => option.textContent), ["Everyone5", "Narrator4", `${mark}1`]);
    assert.equal(options[0]!.getAttribute("aria-checked"), "true");
    await act(async () => options[2]!.click());
    assert.deepEqual(
      all(m, ".fy-ab__block").map((row) => row.className.includes("fy-ab__block--dim")),
      [true, true, false, true, true],
      "one speaker chosen, everyone else is dimmed",
    );
    assert.equal(q(m, ".fy-ab__filtermenu"), null, "a choice closes the menu");
    assert.equal(press().textContent, `${mark} 1`, "and names the speaker on the press");
    await act(async () => press().click());
    await act(async () => all(m, '.fy-ab__filtermenu [role="menuitemradio"]')[0]!.click());
    assert.ok(all(m, ".fy-ab__block").every((row) => !row.className.includes("fy-ab__block--dim")), "Everyone clears it");
  });

  it("the speaker's chip opens a menu; a choice writes a pin, and the answer marks the block as set by hand (SPEC-012 R-62, R-63)", async () => {
    const m = await mount(inkbound("cast"));
    await answerOpen(m, { voices: CAST });
    const line = all(m, ".fy-ab__block").find((row) => row.getAttribute("data-speaker") === "maren-kest")!;
    const chip = line.querySelector("button.fy-ab__speaker") as HTMLElement;
    assert.ok(chip, "the speaker is a press while the cast is current");
    await act(async () => chip.click());
    const options = [...line.querySelectorAll(".fy-ab__menu-opt")].map((option) => option.textContent);
    assert.equal(options[0], "Narration");
    assert.ok(options.some((label) => label?.includes("✓")), "the current speaker is ticked");
    await act(async () => (line.querySelector(".fy-ab__menu-opt") as HTMLElement).click());
    const asked = m.sent.findLast((message) => message.kind === "set-voice-pin") as Extract<ClientMessage, { kind: "set-voice-pin" }>;
    assert.ok(asked, "the choice writes a pin");
    assert.deepEqual(
      { paragraph: asked.paragraph, occurrence: asked.occurrence, quote: asked.quote, narration: asked.narration },
      { paragraph: 1, occurrence: 0, quote: "“You hear it too,”", narration: true },
      "named by the paragraph, the words and the occurrence the saved prose holds",
    );
    const pinned = { ...CAST, lines: [], pins: [{ paragraph: 1, occurrence: 0, quote: "“You hear it too,”", speaker: "Tam Rusk" }] };
    await act(async () => __applyEventForTest({ at: AT, type: "voices.record", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap", record: pinned }));
    const again = all(m, ".fy-ab__block").find((row) => row.getAttribute("data-speaker") === "Tam Rusk");
    assert.ok(again, "the record as it now stands is read");
    assert.ok(again!.querySelector(".fy-ab__pin"), "and the block is marked as set by hand");
    await act(async () => __applyEventForTest({ at: AT, type: "voices.record", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap", refused: "cast moved · cast again" }));
    assert.match(text(m), /cast moved · cast again/, "a refusal is one clause");
  });

  it("Upload opens the host's picker for the block; the checks come back as a dialog, the rights are given once, and a kept recording is marked (SPEC-047 R-34..R-36)", async () => {
    const m = await mount(inkbound());
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    await answerOpen(m, { audiobook: record(NARRATION_KEYS, texts) });
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    await act(async () => q(m, '[data-testid="audiobook-upload"]')!.click());
    const asked = m.sent.findLast((message) => message.kind === "stage-audiobook-take") as Extract<ClientMessage, { kind: "stage-audiobook-take" }>;
    assert.ok(asked, "the press asks the coordinator to choose and check a file");
    assert.equal(asked.block, "p0.0");
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap", block: "p0.0", requestId: asked.requestId };
    await act(async () =>
      __applyEventForTest({
        at: AT,
        type: "audiobook.take-staged",
        ...ids,
        file: "07-011-1.wav",
        durationSec: 3.8,
        sampleRateHz: 48_000,
        channels: 2,
        words: "unchecked",
      }),
    );
    const dialog = dom.document.querySelector('[data-testid="recorded-take-dialog"]') as HTMLElement | null;
    assert.ok(dialog, "the checks come back as a dialog");
    assert.match(dialog.textContent ?? "", /07-011-1\.wav/);
    assert.match(dialog.textContent ?? "", /3\.8 s · 48 kHz · stereo/);
    assert.match(dialog.textContent ?? "", /Wordsunchecked/, "no transcriber: the words are unchecked, not refused");
    const keep = dialog.querySelector('[data-testid="recorded-take-keep"]') as HTMLButtonElement;
    assert.ok(keep.disabled, "the rights come first");
    await act(async () => ([...dialog.querySelectorAll('[aria-label="Rights"] button')] as HTMLElement[]).find((b) => b.textContent === "Authorized")!.click());
    assert.ok(!keep.disabled);
    await act(async () => keep.click());
    const kept = m.sent.findLast((message) => message.kind === "keep-audiobook-take") as Extract<ClientMessage, { kind: "keep-audiobook-take" }>;
    assert.deepEqual({ requestId: kept.requestId, basis: kept.basis }, { requestId: asked.requestId, basis: "authorized" });

    const recorded = record(NARRATION_KEYS, texts);
    recorded.takes["p0.0"] = { ...recorded.takes["p0.0"]!, source: "recorded", recording: { acknowledgementId: "ack_1", warnings: [], words: "unchecked" } };
    recorded.updatedAt = "2026-09-25T10:00:00.000Z";
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.record", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap", requestId: asked.requestId, record: recorded }));
    assert.equal(dom.document.querySelector('[data-testid="recorded-take-dialog"]'), null, "kept: the dialog goes");
    assert.ok(all(m, ".fy-ab__block")[1]!.querySelector(".fy-ab__source--recorded"), "the block says it was recorded");
  });

  it("a speaker a person records waits for a recording: the block says so, the press leaves it out, and the toggle writes the book (SPEC-047 R-37, R-38)", async () => {
    const state = inkbound();
    const world = state.world!;
    const m = await mount({
      ...state,
      world: {
        ...world,
        productions: world.productions.map((p) => (p.meta.id === "inkbound" ? { ...p, audiobook: { schemaVersion: 1 as const, reading: "narrator" as const, recorded: ["narrator"] } } : p)),
      },
    });
    await answerOpen(m);
    assert.deepEqual(all(m, ".fy-ab__block").map((row) => row.getAttribute("data-state")), ["awaiting", "awaiting", "awaiting", "awaiting"], "every block is the narrator's, and the narrator is recorded");
    assert.equal(q(m, '[data-testid="read-audiobook"]'), null, "nothing for a run to make");
    assert.match(text(m), /4 awaiting recording/);
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    const toggle = q(m, '[data-testid="audiobook-recorded"] input') as HTMLInputElement;
    assert.ok(toggle.checked);
    await act(async () => toggle.click());
    const sent = m.sent.findLast((message) => message.kind === "set-audiobook-recorded") as Extract<ClientMessage, { kind: "set-audiobook-recorded" }>;
    assert.deepEqual({ speaker: sent.speaker, recorded: sent.recorded }, { speaker: "narrator", recorded: false });
  });

  it("a recorded speaker's lines go out as a script and come back as files, matched, checked, and kept under one set of rights (SPEC-047 R-39)", async () => {
    const state = inkbound();
    const world = state.world!;
    const m = await mount({
      ...state,
      world: {
        ...world,
        productions: world.productions.map((p) => (p.meta.id === "inkbound" ? { ...p, audiobook: { schemaVersion: 1 as const, reading: "narrator" as const, recorded: ["narrator"] } } : p)),
      },
    });
    await answerOpen(m);
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    await act(async () => q(m, '[data-testid="audiobook-lines"]')!.click());
    const dialog = () => dom.document.querySelector('[data-testid="speaker-lines-dialog"]') as HTMLElement | null;
    assert.ok(dialog(), "Lines… opens the sheet");
    const firstSummary = m.sent.findLast(message => message.kind === "preview-audiobook-script") as Extract<ClientMessage, { kind: "preview-audiobook-script" }>;
    await act(async () => __connectionStatusForTest("closed"));
    await act(async () => __connectionStatusForTest("open"));
    const summary = m.sent.findLast(message => message.kind === "preview-audiobook-script") as Extract<ClientMessage, { kind: "preview-audiobook-script" }>;
    assert.notEqual(summary.requestId, firstSummary.requestId, "a lost summary request is renewed after reconnect");
    assert.equal(summary.speaker, "narrator");
    assert.ok(dialog()!.querySelector(".fy-ab__speaker-dot"));
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.script", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", requestId: summary.requestId, lines: 31, chapters: 9, recorded: 17, awaiting: 14, notCast: 0 }));
    assert.match(dialog()!.textContent ?? "", /31 lines · 9 chapters · 17 recorded · 14 awaiting/);
    assert.match(dialog()!.textContent ?? "", /Awaiting 14/);
    assert.match(dialog()!.textContent ?? "", /All 31/);


    await act(async () => (dialog()!.querySelector('[data-testid="speaker-lines-export"]') as HTMLElement).click());
    const exported = m.sent.findLast((message) => message.kind === "export-audiobook-script") as Extract<ClientMessage, { kind: "export-audiobook-script" }>;
    assert.deepEqual({ speaker: exported.speaker, scope: exported.scope, label: exported.label }, { speaker: "narrator", scope: "awaiting", label: "Narrator" });
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.script", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", requestId: exported.requestId, output: "exports/inkbound-narrator-lines-20260926-abcdef.pdf", lines: 4, chapters: 1, notCast: 0 }));
    assert.match(dialog()!.textContent ?? "", /inkbound-narrator-lines-20260926-abcdef\.pdf/);
    assert.match(dialog()!.textContent ?? "", /4 lines/);

    await act(async () => (dialog()!.querySelector('[data-testid="speaker-lines-add"]') as HTMLElement).click());
    const staged = m.sent.findLast((message) => message.kind === "stage-audiobook-lines") as Extract<ClientMessage, { kind: "stage-audiobook-lines" }>;
    assert.equal(staged.speaker, "narrator");
    await act(async () =>
      __applyEventForTest({
        at: AT,
        type: "audiobook.lines-staged",
        worldId: FIXTURE_WORLD_ID,
        productionId: "inkbound",
        requestId: staged.requestId,
        rows: [
          { file: "02-001-1.wav", id: "02-001-1", quote: "Maren counted the bells.", words: "match" },
          { file: "take-final.wav", refused: "no line id" },
        ],
      }),
    );
    const rows = [...dialog()!.querySelectorAll(".fy-rectake__tr")] as HTMLElement[];
    assert.equal(rows.length, 2);
    assert.ok((rows[1]!.querySelector("input") as HTMLInputElement).disabled, "a refused file cannot be ticked");
    assert.match(rows[1]!.textContent ?? "", /no line id/);
    const keep = dialog()!.querySelector('[data-testid="speaker-lines-keep"]') as HTMLButtonElement;
    assert.equal(keep.textContent, "Keep 1 take");
    assert.ok(keep.disabled, "the rights come first");
    await act(async () => ([...dialog()!.querySelectorAll('[aria-label="Rights"] button')] as HTMLElement[]).find((b) => b.textContent === "My voice")!.click());
    await act(async () => keep.click());
    const kept = m.sent.findLast((message) => message.kind === "keep-audiobook-lines") as Extract<ClientMessage, { kind: "keep-audiobook-lines" }>;
    assert.deepEqual({ basis: kept.basis, files: kept.files }, { basis: "self", files: ["02-001-1.wav"] });
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.lines-kept", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", requestId: staged.requestId, kept: 1 }));
    assert.match(dialog()!.querySelector('[data-testid="speaker-lines-kept"]')?.textContent ?? "", /kept 1/);
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

  it("the block panel says what the reader does with each control, a press writes the direction, and a refusal is one clause (SPEC-047 R-6, R-9)", async () => {
    const m = await mount(voiced(inkbound()));
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    await answerOpen(m, { audiobook: record(NARRATION_KEYS, texts) });
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    const panel = q(m, '[data-testid="audiobook-direction"]');
    assert.ok(panel, "the block's direction sits between the block and its takes");
    const deliveries = [...panel.querySelectorAll('[aria-label="Delivery"] button')] as HTMLButtonElement[];
    assert.deepEqual(deliveries.map((b) => b.textContent), ["measured", "whispered", "breaking", "cold", "warm", "urgent"]);
    // Pill chips in a radiogroup, not a seg that wrapped to two rows (turn 165, issue 1324 §3).
    assert.equal(panel.querySelector('[aria-label="Delivery"]')?.getAttribute("role"), "radiogroup");
    assert.ok(deliveries.every((b) => b.getAttribute("role") === "radio" && b.className.includes("fy-ab__chip")));
    const whispered = deliveries.find((b) => b.textContent === "whispered")!;
    assert.ok(whispered.disabled && whispered.className.includes("fy-ab__chip--off"), "Kokoro cannot whisper: struck");
    assert.equal(whispered.getAttribute("title"), "reads measured · urgent", "the reason, one clause, on the control");
    assert.ok(!deliveries.find((b) => b.textContent === "urgent")!.disabled);
    assert.equal(panel.querySelector(".fy-ab__off")?.textContent, "no note", "no note on this reader");
    const speeds = [...panel.querySelectorAll('[aria-label="Speed"] button')] as HTMLButtonElement[];
    assert.ok(speeds.find((b) => b.textContent === "0.9")!.disabled && !speeds.find((b) => b.textContent === "1.0")!.disabled, "no speed on Kokoro, but one is always one");
    assert.ok(!/\bis\b.*\bbecause\b/.test(panel.textContent ?? ""), "no sentence explains the controls");

    await act(async () => deliveries.find((b) => b.textContent === "urgent")!.click());
    const set = m.sent.findLast((message) => message.kind === "set-audiobook-block") as Extract<ClientMessage, { kind: "set-audiobook-block" }>;
    assert.ok(set, "a press writes the direction");
    assert.equal(set.block, "p0.0");
    assert.deepEqual(set.direction, { delivery: "urgent", speed: 1, cues: [] });

    // The coordinator answers with the record: the block is stale against its undirected take, and the report says how the reader carries it.
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    const held = record(NARRATION_KEYS, texts);
    held.direction["p0.0"] = directed(texts["p0.0"], "urgent");
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.record", ...ids, record: { ...held, updatedAt: "2026-09-14T10:00:00.000Z" } }));
    assert.equal(all(m, ".fy-ab__block")[1]!.getAttribute("data-state"), "stale", "a direction changed since the take");
    assert.equal(q(m, '[data-testid="audiobook-report"]')?.textContent, "urgent · mapped");
    const urgent = all(m, '[aria-label="Delivery"] button').find((b) => b.textContent === "urgent")!;
    assert.ok(urgent.className.includes("fy-ab__chip--on") && urgent.getAttribute("aria-checked") === "true", "the chosen chip is filled");

    // A refusal is said on the panel, in the coordinator's clause.
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.record", ...ids, refused: "whispered · Kokoro 82M reads measured · urgent" }));
    assert.equal(q(m, '[data-testid="audiobook-report"]')?.textContent, "whispered · Kokoro 82M reads measured · urgent");
  });

  it("markers sit in the words as plates, what the reader cannot express is struck, the side says what is sent, and a plate opens the menu (SPEC-047 R-41, R-42, R-47)", async () => {
    const m = await mount(voiced(inkbound()));
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    const held = record(NARRATION_KEYS, texts);
    // Urgent over the bells, which Kokoro makes in parts; a pause after Maren, which it cannot read.
    held.direction["p0.0"] = directed(texts["p0.0"], "measured", {
      cues: [
        { kind: "pause", at: 5, length: "short" },
        { kind: "delivery", span: { from: 14, to: 24, text: "the bells." }, delivery: "urgent" },
      ],
    });
    await answerOpen(m, { audiobook: held });
    const block = all(m, ".fy-ab__block")[1]!;
    const words = block.querySelector(".fy-ab__text") as HTMLElement;
    assert.equal(words.textContent, "Maren counted the bells.", "the plates are no text of the page, so a selection counts the words alone");
    const plates = [...words.querySelectorAll(".fy-ab__mk")] as HTMLElement[];
    assert.deepEqual(plates.map((plate) => plate.getAttribute("data-mk")), ["[pause]", "[urgent]"]);
    assert.ok(plates[0]!.className.includes("fy-ab__mk--held"), "Kokoro reads no pause: held, struck");
    assert.equal(words.querySelector(".fy-ab__mks")?.textContent, "the bells.", "the span a delivery marker covers is underlined");

    await act(async () => block.click());
    const side = q(m, '[data-testid="audiobook-direction"]')!;
    assert.match(side.querySelector('[data-testid="audiobook-held"]')?.textContent ?? "", /^1 held · Kokoro 82M$/);
    const sent = [...side.querySelectorAll('[data-testid="audiobook-sent-as"] > span')].map((part) => part.textContent);
    assert.deepEqual(sent, ["Maren counted", "the bells."], "a settings-only reader makes the marker a part of its own, and the held pause is not sent");

    await act(async () => plates[1]!.click());
    const menu = q(m, '[role="menu"][aria-label="Marker"]');
    assert.ok(menu, "a press on a plate opens the menu to change or remove it");
    const chips = [...menu.querySelectorAll(".fy-ab__mchip")] as HTMLButtonElement[];
    const whispered = chips.find((chip) => chip.textContent === "whispered")!;
    assert.ok(whispered.disabled, "what the reader cannot do is struck");
    assert.equal(whispered.getAttribute("title"), "Kokoro 82M reads measured · urgent", "with the reason as its hint");
    assert.ok(chips.find((chip) => chip.textContent === "urgent")!.className.includes("fy-ab__mchip--on"));
    await act(async () => chips.find((chip) => chip.textContent === "measured")!.click());
    const set = m.sent.findLast((message) => message.kind === "set-audiobook-block") as Extract<ClientMessage, { kind: "set-audiobook-block" }>;
    assert.equal(set.block, "p0.0");
    assert.deepEqual(set.direction?.cues, [
      { kind: "pause", at: 5, length: "short" },
      { kind: "delivery", span: { from: 14, to: 24, text: "the bells." }, delivery: "measured" },
    ], "the marker changed in place, the held pause carried along");

    await act(async () => (all(m, ".fy-ab__block")[1]!.querySelectorAll(".fy-ab__mk")[1] as HTMLElement).click());
    const remove = [...q(m, '[role="menu"][aria-label="Marker"]')!.querySelectorAll(".fy-ab__menu-opt")].find((option) => option.textContent === "Remove") as HTMLElement;
    await act(async () => remove.click());
    const removed = m.sent.findLast((message) => message.kind === "set-audiobook-block") as Extract<ClientMessage, { kind: "set-audiobook-block" }>;
    assert.deepEqual(removed.direction?.cues, [{ kind: "pause", at: 5, length: "short" }]);
  });

  it("under Performed a speaker's row in Voices holds the note, says a narrator that cannot play it, and the focused row hears the line (SPEC-047 R-44, R-45)", async () => {
    const state = voiced(inkbound());
    const world = state.world!;
    const m = await mount({
      ...state,
      world: {
        ...world,
        productions: world.productions.map((p) => (p.meta.id === "inkbound" ? { ...p, audiobook: { schemaVersion: 1 as const, reading: "performed" as const, notes: { "maren-kest": "low, clipped" } } } : p)),
      },
    });
    await answerOpen(m, { voices: CAST });
    const row = q(m, '[data-testid="performed-speaker"]');
    assert.ok(row, "the speaker the narrator performs");
    const input = row.querySelector("input") as HTMLInputElement;
    assert.equal(input.value, "low, clipped");
    assert.match(row.textContent ?? "", /12\/60/, "the note's count");
    assert.match(row.textContent ?? "", /note · not on this reader/, "Kokoro takes no phrase");
    // One reader, one block (design turn 190): Maren's line is read inside its paragraph.
    const line = all(m, ".fy-ab__block").find((block) => (block.textContent ?? "").includes("You hear it too"))!;
    assert.equal(line.getAttribute("data-state"), "not made");

    await act(async () => row.click());
    const hear = q(m, '[data-testid="performed-hear"]')!;
    assert.equal(hear.textContent, "Hear Maren Kest", "a local narrator is free, so no price");
    assert.equal(q(m, '[data-testid="performed-sent-as"]')?.textContent, "“You hear it too,” she said.", "held on Kokoro, so sent plain: the line with its tag, as one passage");
    await act(async () => hear.click());
    const heard = m.sent.findLast((message) => message.kind === "hear-audiobook-line") as Extract<ClientMessage, { kind: "hear-audiobook-line" }>;
    assert.equal(heard.block, line.getAttribute("data-block"));

    const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
    const props = (input as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void; onBlur: () => void }>)[key]!;
    await act(async () => props.onChange({ target: { value: "flat, far off" } }));
    await act(async () => (input as unknown as Record<string, { onBlur: () => void }>)[key]!.onBlur());
    const note = m.sent.findLast((message) => message.kind === "set-audiobook-note") as Extract<ClientMessage, { kind: "set-audiobook-note" }>;
    assert.deepEqual({ speaker: note.speaker, note: note.note }, { speaker: "maren-kest", note: "flat, far off" });
  });

  it("shows a prepared multipart token price and sends consent only on the second press", async () => {
    const state = voiced(inkbound("performed"));
    const reader = { provider: "elevenlabs", model: "eleven-v3", voiceId: "test", label: "Test" };
    state.world = { ...state.world!, productions: state.world!.productions.map(p => p.meta.id === "inkbound" ? { ...p, audiobook: { schemaVersion: 1, reading: "performed", narrator: reader } } : p) };
    state.app.manifest = { ...state.app.manifest!, models: state.app.manifest!.models.map(model => model.id !== reader.model ? model : {
      ...model, pricing: { kind: "perToken", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000,
        speech: { tier: "standard", maxInputTokens: 8192, maxOutputTokens: 16384, audioTokensPerSecond: 25, rates: [
          { version: "intro", effectiveFrom: "2026-09-01T00:00:00.000Z", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000 },
        ] } },
    }) };
    const m = await mount(state);
    await answerOpen(m, { voices: CAST });
    await act(async () => __applyEventForTest({ type: "voice.catalogue", at: AT, voices: [{ ...reader, attributes: [], local: false, canClone: false, usedBy: [] }] }));
    await act(async () => q(m, '[data-testid="performed-speaker"]')!.click());
    const hear = () => q(m, '[data-testid="performed-hear"]')!;
    assert.match(hear().textContent!, /get price/);
    await act(async () => hear().click());
    const first = m.sent.findLast(message => message.kind === "hear-audiobook-line") as Extract<ClientMessage, { kind: "hear-audiobook-line" }>;
    assert.equal(first.quoteToken, undefined);
    await act(async () => __applyEventForTest({ type: "audiobook.heard", at: AT, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", requestId: first.requestId,
      quote: { token: "prepared-three-parts", estimatedMicroUsd: 4500, parts: 3 } }));
    assert.match(hear().textContent!, /~\$0\.0045 · 3 parts/, "the estimate, never `up to` a ceiling");
    assert.equal(m.sent.filter(message => message.kind === "hear-audiobook-line").length, 1, "receiving a quote does not authorise a call");
    await act(async () => hear().click());
    const confirmed = m.sent.findLast(message => message.kind === "hear-audiobook-line") as Extract<ClientMessage, { kind: "hear-audiobook-line" }>;
    assert.equal(confirmed.quoteToken, "prepared-three-parts");
    assert.equal(confirmed.block, first.block);
  });

  it("the block panel shares the note, the Sound button and Sent as (design turn 181e)", async () => {
    const state = voiced(inkbound());
    const reader = { provider: "elevenlabs", model: "eleven-v3", voiceId: "test", label: "Test" };
    state.world = { ...state.world!, productions: state.world!.productions.map(p => p.meta.id === "inkbound" ? { ...p, audiobook: { schemaVersion: 1, reading: "narrator", narrator: reader } } : p) };
    const m = await mount(state);
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    const held = record(NARRATION_KEYS, texts);
    held.direction["p0.0"] = directed(texts["p0.0"], "cold", { note: "flat", cues: [{ kind: "sound", at: 24, sound: "sighs" }] });
    await answerOpen(m, { audiobook: held });
    await act(async () => __applyEventForTest({ type: "voice.catalogue", at: AT, voices: [{ ...reader, attributes: [], local: false, canClone: false, usedBy: [] }] }));
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    const panel = q(m, '[data-testid="audiobook-direction"]')!;
    const note = panel.querySelector('input[aria-label="Note"]') as HTMLInputElement;
    assert.equal(note.value, "flat");
    assert.equal(panel.querySelector('[data-testid="audiobook-note-count"]')?.textContent, "4 / 300");
    assert.deepEqual([...panel.querySelectorAll('[data-testid="audiobook-sent-as"] > span')].map((part) => part.textContent), ["[coldly] [flat] Maren counted the bells. [sighs]"]);
    assert.ok(panel.querySelector('[data-testid="audiobook-markers"] .fy-ab__mk--sound'), "a sound's plate is outlined");
    const sound = panel.querySelector('[aria-label="Add sound"]') as HTMLButtonElement;
    assert.ok(!sound.disabled, "Eleven v3 makes sounds");
    await act(async () => sound.click());
    const menu = q(m, '[role="menu"][aria-label="Marker"]')!;
    assert.deepEqual([...menu.querySelectorAll(".fy-ab__menu-eb")].map((eyebrow) => eyebrow.textContent), ["Sound"], "the Sound group alone");
    const chips = [...menu.querySelectorAll(".fy-ab__mchip")] as HTMLButtonElement[];
    assert.ok(chips.find((chip) => chip.textContent === "coughs")!.disabled, "a sound the reader does not make is struck");
    await act(async () => chips.find((chip) => chip.textContent === "laughs")!.click());
    const set = m.sent.findLast((message) => message.kind === "set-audiobook-block") as Extract<ClientMessage, { kind: "set-audiobook-block" }>;
    assert.deepEqual(set.direction?.cues, [{ kind: "sound", at: 24, sound: "sighs" }, { kind: "sound", at: 24, sound: "laughs" }]);

    // A note longer than a tag is held on a tag reader: kept, left out of what is sent, named.
    const long = "angry and hurt, quieter rather than louder, holding back her tears";
    const longer = record(NARRATION_KEYS, texts);
    longer.direction["p0.0"] = directed(texts["p0.0"], "cold", { note: long });
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.record", ...ids, record: { ...longer, updatedAt: "2026-09-14T10:00:00.000Z" } }));
    const side = q(m, '[data-testid="audiobook-direction"]')!;
    assert.deepEqual([...side.querySelectorAll('[data-testid="audiobook-sent-as"] > span')].map((part) => part.textContent), ["[coldly] Maren counted the bells."]);
    assert.equal(side.querySelector('[data-testid="audiobook-sent-held"]')?.textContent, "Held note — Eleven v3");
  });

  it("a direction written for earlier words shows carried to the words now, with what could not be carried counted (SPEC-047 R-43)", async () => {
    const m = await mount(voiced(inkbound()));
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    const held = record(NARRATION_KEYS, texts);
    const was = "Maren slowly counted all the bells.";
    held.direction["p0.0"] = {
      ...directed(was, "measured", {
        cues: [
          { kind: "emphasis", span: { from: 6, to: 12, text: "slowly" }, level: "strong" },
          { kind: "delivery", span: { from: 25, to: 35, text: "the bells." }, delivery: "urgent" },
        ],
      }),
      text: was,
    };
    await answerOpen(m, { audiobook: held });
    const words = all(m, ".fy-ab__block")[1]!.querySelector(".fy-ab__text") as HTMLElement;
    assert.deepEqual([...words.querySelectorAll(".fy-ab__mk")].map((plate) => plate.getAttribute("data-mk")), ["[urgent]"], "the marker found once is carried; the emphasis on a word gone is not");
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    assert.match(q(m, '[data-testid="audiobook-held"]')?.textContent ?? "", /1 marker dropped · words changed/);
  });

  it("Direct this chapter is the dock's prompt, its card is accepted whole, and the prompt becomes Direct again (SPEC-047 R-10, R-31)", async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m);
    // Arke is put away in this view until its toolbar press opens it (design turn 194, rule 13).
    assert.equal(q(m, '[data-testid="chapter-workspace"]')!.getAttribute("data-dock"), "false");
    await act(async () => q(m, '[data-testid="audiobook-arke"]')!.click());
    const prompt = all(m, ".fy-arke__prompt").find((b) => b.textContent === "Direct this chapter");
    assert.ok(prompt, `the dock offers the direction: ${all(m, ".fy-arke__prompt").map((b) => b.textContent).join(" | ")}`);
    assert.ok(all(m, ".fy-arke__prompt").some((b) => b.textContent === "Which blocks are stale?"));
    await act(async () => prompt.click());
    // The press opens the Direct sheet (design turn 184a): what the director reads, then Direct.
    assert.equal(m.sent.some((message) => message.kind === "direct-chapter"), false, "nothing runs before the sheet's Direct");
    const preview = m.sent.findLast((message) => message.kind === "preview-direction") as Extract<ClientMessage, { kind: "preview-direction" }>;
    assert.ok(preview, "the sheet asks what the director would read");
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    await act(async () => __applyEventForTest({ at: AT, type: "direction.reads", ...ids, requestId: preview.requestId, reads: { chapter: { order: 2, version: 4, synopsis: false }, speakers: [], narrator: { label: "George" }, notes: { book: false, chapter: false, speakers: 0 }, before: null } }));
    await act(async () => q(m, '[data-testid="direct-sheet-direct"]')!.click());
    assert.ok(m.sent.some((message) => message.kind === "direct-chapter"), "the sheet's press directs");
    await act(async () => __applyEventForTest({ at: AT, type: "direction.started", ...ids }));
    assert.match(q(m, '[data-testid="direction-card"]')?.textContent ?? "", /directing…/);
    const proposed = { title: { delivery: "measured" as const, speed: 1, cues: [] }, "p0.0": { delivery: "urgent" as const, speed: 1, cues: [] } };
    await act(async () =>
      __applyEventForTest({ at: AT, type: "direction.finished", ...ids, outcome: "directed", directed: 2, dropped: 1, hash: HASH, chapterVersion: 4, summary: "Two blocks measured but the title, said with urgency.", proposed, proposalId: "card-1" }),
    );
    const card = q(m, '[data-testid="direction-card"]')!;
    assert.match(card.textContent ?? "", /Two blocks measured but the title, said with urgency\./);
    assert.match(card.textContent ?? "", /proposed · chapter 02 · direction v4 · [0-9]+ blocks · 1 directed · 1 dropped · nothing spent/);
    await act(async () => q(m, '[data-testid="direction-accept"]')!.click());
    const accepted = m.sent.findLast((message) => message.kind === "accept-direction") as Extract<ClientMessage, { kind: "accept-direction" }>;
    assert.ok(accepted, "accepted whole");
    assert.equal(accepted.hash, HASH);
    assert.deepEqual(accepted.directions, proposed);
    assert.equal(accepted.proposalId, "card-1", "the card is named, so only its own extras are written");
    assert.ok(accepted.requestId, "the acceptance is named");
    assert.match(q(m, '[data-testid="direction-card"]')?.textContent ?? "", /accepting…/);
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells." };
    const written = record([], texts);
    written.direction = { title: directed(texts.title, "measured"), "p0.0": directed(texts["p0.0"], "urgent") };
    // Another window's block write answers first (codex on PR 1186): it is not this card's answer.
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.record", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H9", record: { ...written, updatedAt: "2026-09-14T09:30:00.000Z" } }));
    assert.match(q(m, '[data-testid="direction-card"]')?.textContent ?? "", /accepting…/, "still on its way");
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.record", ...ids, requestId: accepted.requestId, record: { ...written, updatedAt: "2026-09-14T10:00:00.000Z" } }));
    assert.match(q(m, '[data-testid="direction-card"]')?.textContent ?? "", /✓ directed · chapter 02 · direction v4 · [0-9]+ blocks · 1 directed · 1 dropped/);
    assert.ok(all(m, ".fy-arke__prompt").some((b) => b.textContent === "Direct again"), "a direction stands, so the prompt is Direct again");
    assert.equal(all(m, ".fy-arke__prompt").some((b) => b.textContent === "Direct this chapter"), false);
  });

  it("edits compose before the record answers, and the panel reads the reader that will speak (codex on PR 1186)", async () => {
    const m = await mount(voiced(inkbound("cast")));
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": "“You hear it too,”", "p1.1": "she said.", "p3.0": "Six, and the tide <br> not yet called." };
    await answerOpen(m, { audiobook: record(Object.keys(texts), texts), voices: CAST });
    // Two presses before the first answer: the second carries the first.
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    await act(async () => all(m, '[aria-label="Delivery"] button').find((b) => b.textContent === "urgent")!.click());
    await act(async () => all(m, '[aria-label="Speed"] button').find((b) => b.textContent === "1.0")!.click());
    const writes = m.sent.filter((message) => message.kind === "set-audiobook-block") as Extract<ClientMessage, { kind: "set-audiobook-block" }>[];
    assert.equal(writes.length, 2);
    assert.equal(writes[1]!.direction?.delivery, "urgent", "the speed press did not undo the delivery");
    // Maren's line: her ElevenLabs voice is assigned, but the catalogue says it cannot speak now,
    // so the panel reads Kokoro's row — whispered struck — and says who stands in.
    await act(async () => __applyEventForTest({ at: AT, type: "voice.catalogue", worldId: FIXTURE_WORLD_ID, voices: [{ provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", label: "George", attributes: [], local: true, canClone: false, usedBy: [] }] }));
    await act(async () => all(m, ".fy-ab__block")[2]!.click());
    const panel = q(m, '[data-testid="audiobook-direction"]')!;
    const whispered = panel.querySelector('[aria-label="Delivery"] button:nth-child(2)') as HTMLButtonElement;
    assert.equal(whispered.textContent, "whispered");
    assert.ok(whispered.disabled, "Kokoro will speak this line, and Kokoro cannot whisper");
    assert.match(q(m, '[data-testid="audiobook-block"]')?.textContent ?? "", /read by George · narrator · stands in/);
    assert.equal(all(m, ".fy-ab__block")[2]!.getAttribute("data-state"), "stale", "the state is judged against the voice the line is meant for, not the one that stands in");
  });

  it("Make again kept past a save still names its block, and so does the answer to its price (codex on PR 1186)", async () => {
    const state = voiced(inkbound());
    const world = state.world!;
    const m = await mount({ ...state, world: { ...world, artifacts: [...world.artifacts, takeArtifact("ar_01J8F3K2QW9VZX4N7M0RTYB6A1", "neap", "p0.0")] } });
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    await answerOpen(m, { audiobook: record(NARRATION_KEYS, texts) });
    // Typing in the manuscript, then back to the blocks: the press must wait for the save.
    await act(async () => q(m, ".fy-seg__item:not(.fy-seg__item--active)")!.click());
    const area = q(m, "textarea.fy-ch__source")!;
    const key = Object.keys(area).find((k) => k.startsWith("__reactProps$"))!;
    const props = (area as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!;
    await act(async () => props.onChange({ target: { value: `${BODY}\n\nA new line.` } }));
    await act(async () => q(m, ".fy-seg__item:not(.fy-seg__item--active)")!.click());
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    const before = m.sent.filter((message) => message.kind === "read-audiobook-chapter").length;
    await act(async () => q(m, '[data-testid="audiobook-make-again"]')!.click());
    assert.equal(m.sent.filter((message) => message.kind === "read-audiobook-chapter").length, before, "not sent while the draft is unsaved");
    const save = m.sent.findLast((message) => message.kind === "save-chapter") as Extract<ClientMessage, { kind: "save-chapter" }>;
    assert.ok(save?.requestId);
    await act(async () =>
      __applyEventForTest({ at: AT, type: "chapter.save-result", requestId: save.requestId!, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterFile: "01-neap", disposition: "saved", version: 5, hash: `sha256:${"c".repeat(64)}` }),
    );
    const sent = m.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.deepEqual(sent?.blocks, ["p0.0"], "the block rides on the read sent once the save landed");
    // The block's reader is paid: the price's answer names the block still.
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", toMake: 1, blocks: 4 }));
    await act(async () =>
      __applyEventForTest({ at: AT, type: "audiobook.priced", ...ids, characters: 24, estimatedMicroUsd: 2400, confirmationToken: "tok", voices: [{ label: "Low tide", provider: "elevenlabs", characters: 24, estimatedMicroUsd: 2400 }] }),
    );
    await act(async () => all(m, "button").find((button) => button.textContent?.startsWith("Confirm 24 characters"))!.click());
    const answered = m.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.equal(answered.confirmationToken, "tok");
    assert.deepEqual(answered.blocks, ["p0.0"], "the answer carries the block, or the run would make the chapter's missing blocks and not this one");
  });

  it("accepting a card waits out the autosave, and a direction keyed to older wording does not make it Direct again (codex on PR 1186)", async () => {
    const m = await mount(voiced(inkbound()));
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    const held = record(NARRATION_KEYS, texts);
    held.direction["p0.0"] = directed("Maren counted the bells, twice.", "urgent");
    await answerOpen(m, { audiobook: held });
    await act(async () => q(m, '[data-testid="audiobook-arke"]')!.click());
    assert.ok(all(m, ".fy-arke__prompt").some((b) => b.textContent === "Direct this chapter"), "a direction authored for other words is none to the prompt");
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
    const proposed = { title: { delivery: "measured" as const, speed: 1, cues: [] } };
    await act(async () => __applyEventForTest({ at: AT, type: "direction.started", ...ids }));
    await act(async () => __applyEventForTest({ at: AT, type: "direction.finished", ...ids, outcome: "directed", directed: 1, dropped: 0, hash: HASH, chapterVersion: 4, proposed }));
    await act(async () => q(m, ".fy-seg__item:not(.fy-seg__item--active)")!.click());
    const area = q(m, "textarea.fy-ch__source")!;
    const key = Object.keys(area).find((k) => k.startsWith("__reactProps$"))!;
    const props = (area as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!;
    await act(async () => props.onChange({ target: { value: `${BODY}\n\nA new line.` } }));
    await act(async () => q(m, ".fy-seg__item:not(.fy-seg__item--active)")!.click());
    await act(async () => q(m, '[data-testid="direction-accept"]')!.click());
    assert.equal(m.sent.some((message) => message.kind === "accept-direction"), false, "not accepted against words the save is about to replace");
    const save = m.sent.findLast((message) => message.kind === "save-chapter") as Extract<ClientMessage, { kind: "save-chapter" }>;
    assert.ok(save?.requestId);
    await act(async () =>
      __applyEventForTest({ at: AT, type: "chapter.save-result", requestId: save.requestId!, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterFile: "01-neap", disposition: "saved", version: 5, hash: `sha256:${"c".repeat(64)}` }),
    );
    const accepted = m.sent.findLast((message) => message.kind === "accept-direction") as Extract<ClientMessage, { kind: "accept-direction" }>;
    assert.ok(accepted, "sent once the save landed, with the hash the card was made for — which the coordinator now refuses");
    assert.equal(accepted.hash, HASH);
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

  it("under one reader a paragraph is one block, its turns rows: the margin names the first, a rule names the next, and the words stay the paragraph's (design turn 190)", async () => {
    const m = await mount(inkbound("narrator"));
    await answerOpen(m, { voices: CAST });
    const rows = all(m, ".fy-ab__block");
    assert.equal(rows.length, 4, "the line and its tag are one block, not two");
    const merged = rows.find((row) => row.getAttribute("data-block") === "p1.0")!;
    assert.ok(merged.className.includes("fy-ab__block--merged"), "bracketed as a block of several turns");
    assert.equal(merged.querySelector(".fy-ab__mark")!.textContent, FIXTURE_STATE.world!.sheets.find((s) => s.id === "maren-kest")!.name, "the first turn's speaker is the margin's");
    const breaks = [...merged.querySelectorAll(".fy-ab__turn")] as HTMLElement[];
    assert.deepEqual(breaks.map((turn) => turn.getAttribute("data-who")), ["narrator"], "each later turn begins at a rule that names its speaker");
    assert.equal(merged.querySelector(".fy-ab__text")!.textContent, "“You hear it too,” she said.", "a break holds no text, so offsets still count the paragraph's words");
    assert.equal(rows.filter((row) => row.className.includes("fy-ab__block--merged")).length, 1, "a paragraph of one turn is a block as it was");
  });

  it("the head names the reading and its narrator, and its menu writes the book's reading or opens the narrator (design turn 165a, issue 1324 §3)", async () => {
    const m = await mount(voiced(inkbound("performed")));
    await answerOpen(m, { audiobook: record(NARRATION_KEYS, { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." }) });
    const press = q(m, '[data-testid="audiobook-reading"]')!;
    assert.ok(press, "the reading is in the head, on the view row");
    assert.equal(press.closest(".fy-ch__viewline")?.querySelector('[aria-label="Chapter view"]') !== null, true, "beside the Manuscript · Audiobook seg");
    assert.match(press.textContent ?? "", /^Performed · George/);
    assert.equal(press.getAttribute("aria-haspopup"), "menu");
    assert.equal(press.getAttribute("aria-expanded"), "false");
    assert.ok(press.closest(".fy-ch__viewline")?.querySelector('[data-testid="direct-illustrate"]'), "Direct and illustrate sits on the same row");
    // The chapter's Play is the foot line's round press (design turn 194, rule 4).
    const play = q(m, '[data-testid="audiobook-play"]') as HTMLButtonElement | null;
    assert.ok(play?.closest('[data-testid="audiobook-foot"]'), "Play is in the foot line");
    assert.equal(play!.textContent, "Play");
    assert.equal(play!.disabled, false, "Play while a block has a made take");
    await act(async () => press.click());
    assert.equal(press.getAttribute("aria-expanded"), "true");
    const items = all(m, '[role="menu"][aria-label="Reading"] [role="menuitemradio"]');
    assert.deepEqual(items.map((item) => item.querySelector(".fy-ab__menu-label")?.textContent), ["Narrator", "Performed", "Cast"]);
    assert.deepEqual(items.map((item) => item.getAttribute("aria-checked")), ["false", "true", "false"]);
    await act(async () => items[2]!.click());
    const set = m.sent.findLast((message) => message.kind === "set-audiobook-reading") as Extract<ClientMessage, { kind: "set-audiobook-reading" }>;
    assert.equal(set.reading, "cast", "the book's reading, written as the door's seg writes it");
    assert.equal(q(m, '[role="menu"][aria-label="Reading"]'), null, "the menu closes on a choice");
    await act(async () => press.click());
    await act(async () => all(m, '[role="menu"][aria-label="Reading"] [role="menuitem"]').find((item) => /Narrator…/.test(item.textContent ?? ""))!.click());
    assert.ok(dom.document.querySelector('[data-testid="narrator-dialog"]'), "Narrator… opens the book's narrator");
  });

  it("the block panel names the block and its reader in words, and its add buttons are one word each (design turn 165a, issue 1324 §3)", async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m, { audiobook: record(NARRATION_KEYS, { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." }) });
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    const title = q(m, '[data-testid="audiobook-block-title"]')!;
    assert.equal(title.textContent, "Block 2 · Narration");
    assert.ok(!title.className.includes("fy-bible__paneltitle"), "not letter-spaced capitals");
    assert.equal(q(m, ".fy-ab__readby")?.textContent, "read by George · narrator");
    const adds = all(m, '[data-testid="audiobook-direction"] .fy-ab__add');
    assert.deepEqual(adds.map((b) => b.textContent), ["Marker", "Pause", "Breath", "Emphasis", "Sound"]);
    assert.deepEqual(adds.map((b) => b.getAttribute("aria-label")), ["Add marker", "Add pause", "Add breath", "Add emphasis", "Add sound"]);
    assert.ok((adds[4] as HTMLButtonElement).disabled, "Kokoro makes no sound: struck, with the reason");
    assert.equal(adds[4]!.getAttribute("title"), "no sounds");
    assert.ok(adds.every((b) => b.querySelector("svg") !== null), "the plus is an icon inside the button, never a line of its own");
  });

  it("a world's designed narrator is named on the head and the block panel, before the catalogue answers and after, as the door names it", async () => {
    const ife = { kind: "designed" as const, id: "dv_01M3WMVV9W7J85PPRYQJ0YB26G", revision: 1, name: "Ife's voice", description: "Low and warm.", language: "en-NG",
      provider: "google" as const, model: "gemini-3.8-flash-tts" as const, remoteId: "voice_ife", expiresAt: "2099-01-01T00:00:00.000Z", created: AT, origin: "imported" as const,
      sample: "voices/dv_01M3WMVV9W7J85PPRYQJ0YB26G.wav" };
    const target = "designed:dv_01M3WMVV9W7J85PPRYQJ0YB26G:1";
    const state = voiced(inkbound("performed"));
    state.world = { ...state.world!, designedVoices: [ife] };
    state.app = { ...state.app, narrator: { provider: "google", model: "gemini-3.8-flash-tts", voiceId: target, label: "Ife's voice" } };
    const m = await mount(state);
    await answerOpen(m, { audiobook: record(NARRATION_KEYS, { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." }) });
    const named = () => ({
      head: (q(m, '[data-testid="audiobook-reading"]')?.textContent ?? "").replace(/\s+$/, ""),
      readBy: q(m, ".fy-ab__readby")?.textContent,
    });
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    assert.match(named().head, /^Performed · Ife's voice/, "no catalogue yet: the stored choice, never the shipped George");
    assert.equal(named().readBy, "read by Ife's voice · narrator");
    await act(async () => __applyEventForTest({ type: "voice.catalogue", at: AT, voices: [
      { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", label: "George", attributes: [], local: true, canClone: false, usedBy: [] },
      { provider: "google", model: "gemini-3.8-flash-tts", voiceId: target, label: "Ife's voice", attributes: [], local: false, canClone: false, readsDesigned: ife.id, usedBy: [] },
    ] }));
    assert.match(named().head, /^Performed · Ife's voice/, "the catalogue holds the voice, so it still narrates");
    assert.equal(named().readBy, "read by Ife's voice · narrator");
  });
});

describe("the marker list's words (design turn 165, issue 1324 §3)", () => {
  it("names a marker's words verbatim, never quoted a second time", () => {
    const text = "“Whoever cut the tenth key,” she said.";
    const span = { from: 0, to: 28, text: "“Whoever cut the tenth key,”" };
    assert.equal(cueLabel(text, { kind: "delivery", span, delivery: "whispered" } as never), "“Whoever cut the tenth key,”");
    assert.equal(cueLabel(text, { kind: "emphasis", span, level: "moderate" }), "emphasis · moderate · “Whoever cut the tenth key,”");
    assert.equal(cueLabel(text, { kind: "pause", at: 28, length: "short" }), "pause · short · after tenth key,”");
    assert.equal(cueLabel(text, { kind: "breath", at: 29, action: "inhale" }), "inhale · before she");
  });
});

/** The book record on the production, as the bundle carries it. */
function withBook(state: ClientState, book: Record<string, unknown>): ClientState {
  return { ...state, world: { ...state.world!, productions: state.world!.productions.map((p) => (p.meta.id === "inkbound" ? { ...p, audiobook: { schemaVersion: 1 as const, reading: "narrator" as const, ...p.audiobook, ...book } } : p)) } };
}

describe("the director reads the book (design turn 184)", () => {
  const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
  const BOOK_NOTE = "Harbour English, unhurried and close. Old words said plainly, never quaintly, never rushed.";
  const props = (element: Element) => (element as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void; onBlur: () => void }>)[Object.keys(element).find((k) => k.startsWith("__reactProps$"))!]!;
  const RACHEL = { provider: "elevenlabs", model: "eleven-v3", voiceId: "rachel", label: "Rachel" };

  it("the Direct sheet lists what the director reads, offers casting first under Performed, and Direct asks for what is ticked (184a)", async () => {
    const m = await mount(voiced(inkbound("performed")));
    await answerOpen(m);
    const item = (await menuItem(m, "direct-audiobook"))!;
    await act(async () => item.click());
    const preview = m.sent.findLast((message) => message.kind === "preview-direction") as Extract<ClientMessage, { kind: "preview-direction" }>;
    assert.match(text(m), /reading…/, "the rows wait for the coordinator's answer");
    await act(async () =>
      __applyEventForTest({
        at: AT, type: "direction.reads", ...ids, requestId: preview.requestId,
        reads: { chapter: { order: 2, version: 4, synopsis: true, pov: "Maren Kest" }, tone: "quiet dread", speakers: ["Maren Kest"], narrator: { label: "George", description: "low, warm" }, notes: { book: true, chapter: false, speakers: 1 }, before: { order: 1, blocks: 0 }, cast: "not cast · cast the lines first" },
      }),
    );
    const rows = all(m, '[data-testid="direct-reads"] .fy-ab__read').map((row) => `${row.querySelector("b")!.textContent}|${row.querySelector("span")!.textContent}`);
    assert.deepEqual(rows, [
      "Chapter|synopsis · point of view Maren Kest · v4",
      "Tone|quiet dread",
      "Speakers|Maren Kest — their sheets",
      "Narrator|George — low, warm",
      "Notes|book note · 1 speaker note",
      "Before|nothing directed yet",
    ]);
    const sheet = q(m, '[data-testid="direct-sheet"]')!;
    assert.match(sheet.textContent ?? "", /Cast the lines first/);
    assert.match(sheet.textContent ?? "", /nothing spent/);
    await act(async () => q(m, '[data-testid="direct-sheet-direct"]')!.click());
    const direct = m.sent.findLast((message) => message.kind === "direct-chapter") as Extract<ClientMessage, { kind: "direct-chapter" }>;
    assert.equal(direct.cast, true, "the lines are cast in the same proposal");
    assert.equal(direct.chapterNote, true, "no chapter note stands, so drafting one is ticked");
    assert.equal(q(m, '[data-testid="direct-sheet"]'), null, "the sheet closes once it is sent");
    assert.equal(q(m, '[data-testid="chapter-workspace"]')!.getAttribute("data-dock"), "true", "Direct opens the dock, where its card comes back");
  });

  it("the book note and the chapter note are behind the toolbar's Notes press, with counts, written when left (R-53, design turn 194)", async () => {
    const m = await mount(voiced(withBook(inkbound(), { note: BOOK_NOTE, chapterNotes: { neap: "Night at the rail desk." } })));
    await answerOpen(m);
    assert.equal(q(m, '[data-testid="reading-notes"]'), null, "the notes are behind their press");
    const press = q(m, '[data-testid="reading-notes-press"]')!;
    assert.equal(press.textContent, "Notes 2", "the press counts the notes set");
    await act(async () => press.click());
    assert.equal(press.getAttribute("aria-expanded"), "true");
    const notes = q(m, '[data-testid="reading-notes"]')!;
    const inputs = [...notes.querySelectorAll("input, textarea")] as HTMLInputElement[];
    assert.deepEqual(inputs.map((input) => input.getAttribute("aria-label")), ["Book note", "Chapter note"]);
    // Both wrap now (194e): a textarea, whose value linkedom does not keep, so the count says it.
    assert.deepEqual([...notes.querySelectorAll(".fy-vd__note-count")].map((count) => count.textContent), [`${BOOK_NOTE.length} / 300`, "23 / 300"]);
    await act(async () => props(inputs[1]!).onChange({ target: { value: "Dawn, the empty quay." } }));
    await act(async () => props(inputs[1]!).onBlur());
    const set = m.sent.findLast((message) => message.kind === "set-audiobook-reading-note") as Extract<ClientMessage, { kind: "set-audiobook-reading-note" }>;
    assert.deepEqual({ note: set.note, chapterFile: set.chapterFile }, { note: "Dawn, the empty quay.", chapterFile: "01-neap" });
    await act(async () => void notes.dispatchEvent(Object.assign(new Event("keydown", { bubbles: true }), { key: "Escape" })));
    assert.equal(q(m, '[data-testid="reading-notes"]'), null, "Escape puts the notes away");
  });

  it("the Notes press says Notes alone when no note is set (design turn 194, rule 5)", async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m);
    assert.equal(q(m, '[data-testid="reading-notes-press"]')!.textContent, "Notes");
  });

  it("a proposal draws dashed on the blocks; its block shows the proposed direction, Sent as with the notes held, and Hear block asks for the proposal's read (184b, 184d)", async () => {
    const m = await mount(voiced(withBook(inkbound(), { note: BOOK_NOTE, narrator: RACHEL })));
    await answerOpen(m);
    await act(async () => __applyEventForTest({ type: "voice.catalogue", at: AT, voices: [{ ...RACHEL, attributes: [], local: false, canClone: false, usedBy: [] }] }));
    const proposed = { "p0.0": { delivery: "cold" as const, speed: 1, cues: [{ kind: "sound" as const, at: 24, sound: "sighs" as const }], note: "flat" } };
    await act(async () => __applyEventForTest({ at: AT, type: "direction.finished", ...ids, outcome: "directed", directed: 4, dropped: 0, hash: HASH, chapterVersion: 4, proposed, chapterNote: "Night at the rail desk." }));
    const block = all(m, ".fy-ab__block")[1]!;
    assert.equal(block.getAttribute("data-proposed"), "true");
    assert.ok(block.querySelector(".fy-ab__text--proposed .fy-ab__mk--sound"), "the proposed sound is drawn, dashed");
    assert.equal(all(m, ".fy-ab__block")[0]!.getAttribute("data-proposed"), null, "a block the proposal leaves undirected is drawn as it is");
    await openArke(m);
    assert.match(q(m, '[data-testid="direction-card"]')?.textContent ?? "", /chapter note/);
    await act(async () => block.click());
    const panel = q(m, '[data-testid="audiobook-proposed"]')!;
    assert.ok(panel, "the block's panel shows the proposal, not the record's controls");
    assert.match(q(m, '[data-testid="audiobook-block"]')?.textContent ?? "", /proposed/);
    assert.equal(panel.querySelector('[aria-checked="true"]')?.textContent, "cold");
    assert.equal(panel.querySelector('[data-testid="proposed-sent-as"]')?.textContent, "text [Night at the rail desk.] [coldly] [flat] Maren counted the bells. [sighs]", "the drafted chapter note leads as a tag, short enough to be one");
    assert.deepEqual([...panel.querySelectorAll('[data-testid="proposed-reading-held"]')].map((held) => held.textContent), [`book note · ${BOOK_NOTE.length} characters · Eleven v3 takes 60 as a tag`]);
    const hear = panel.querySelector('[data-testid="proposed-hear"]') as HTMLButtonElement;
    assert.match(hear.textContent ?? "", /^Hear block 2 · \$[0-9.]+ · 1 read$/);
    await act(async () => hear.click());
    const asked = m.sent.findLast((message) => message.kind === "hear-audiobook-line") as Extract<ClientMessage, { kind: "hear-audiobook-line" }>;
    assert.deepEqual({ block: asked.block, proposed: asked.proposed }, { block: "p0.0", proposed: true });

    // Discarded: the blocks are drawn as the record has them again.
    await act(async () => all(m, '[data-testid="direction-card"] button').find((b) => b.textContent === "Discard")!.click());
    assert.equal(all(m, ".fy-ab__block")[1]!.getAttribute("data-proposed"), null);
  });

  it("a block on a tag reader strikes a book note too long for a tag under Sent as, never in what is sent (184d)", async () => {
    const m = await mount(voiced(withBook(inkbound(), { note: BOOK_NOTE, narrator: RACHEL })));
    await answerOpen(m);
    await act(async () => __applyEventForTest({ type: "voice.catalogue", at: AT, voices: [{ ...RACHEL, attributes: [], local: false, canClone: false, usedBy: [] }] }));
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    const side = q(m, '[data-testid="audiobook-direction"]')!;
    assert.equal(side.querySelector('[data-testid="audiobook-sent-as"]')?.textContent, "Maren counted the bells.");
    assert.equal(side.querySelector('[data-testid="audiobook-reading-held"]')?.textContent, `book note · ${BOOK_NOTE.length} characters · Eleven v3 takes 60 as a tag`);
  });

  it("a proposal that cast the lines first is drawn on the blocks its cast makes (codex on PR 1479)", async () => {
    const m = await mount(voiced(inkbound("performed")));
    await answerOpen(m);
    assert.equal(q(m, '[data-block="p1.1"]'), null, "uncast, the line's paragraph is one block");
    assert.doesNotMatch(q(m, '[data-block="p1.0"]')?.textContent ?? "", /Maren Kest/);
    await act(async () => __applyEventForTest({ at: AT, type: "direction.finished", ...ids, outcome: "directed", directed: 5, dropped: 0, hash: HASH, chapterVersion: 4, proposalId: "card-2", cast: { lines: 1, speakers: 1 }, castRecord: CAST, proposed: { "p1.0": { delivery: "cold" as const, speed: 1, cues: [] } } }));
    // One reader, one block (design turn 190): the held cast's line sits inside its paragraph's block,
    // which names its speaker, and the proposal lands on that block.
    assert.match(q(m, '[data-block="p1.0"]')?.textContent ?? "", /Maren Kest/, "the held cast's line has its speaker");
    assert.equal(q(m, '[data-block="p1.0"]')?.getAttribute("data-proposed"), "true", "the proposal lands on the block its cast made");
    await openArke(m);
    await act(async () => all(m, '[data-testid="direction-card"] button').find((b) => b.textContent === "Discard")!.click());
    assert.doesNotMatch(q(m, '[data-block="p1.0"]')?.textContent ?? "", /Maren Kest/, "discarded, the blocks are the record's again");
  });

  it("the note fields hold while the book or another chapter is being read, and Direct puts a pressed block down (codex on PR 1479)", async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m);
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    assert.ok(q(m, '[data-testid="audiobook-block"]'));
    const item = (await menuItem(m, "direct-audiobook"))!;
    await act(async () => item.click());
    assert.ok(q(m, '[data-testid="direct-sheet"]'), "the sheet takes the panel");
    assert.equal(q(m, '[data-testid="audiobook-block"]'), null, "the block pressed before is put down");
    await act(async () => q(m, '[data-testid="reading-notes-press"]')!.click());
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "slack-water", requestId: "01J8F3K2QW9VZX4N7M0RTYB6H2", toMake: 3, blocks: 3 }));
    const inputs = [...q(m, '[data-testid="reading-notes"]')!.querySelectorAll("input, textarea")] as HTMLInputElement[];
    assert.deepEqual(inputs.map((input) => input.disabled), [true, true], "another chapter being read holds both notes");
    assert.equal((q(m, '[data-testid="reading-notes-press"]') as HTMLButtonElement).disabled, true, "and their press");
  });

  it("Hear block says the coordinator's count of reads once it has quoted (codex on PR 1479)", async () => {
    const reader = RACHEL;
    const state = voiced(withBook(inkbound(), { narrator: reader }));
    state.app.manifest = { ...state.app.manifest!, models: state.app.manifest!.models.map((model) => model.id !== reader.model ? model : {
      ...model, pricing: { kind: "perToken", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000,
        speech: { tier: "standard", maxInputTokens: 8192, maxOutputTokens: 16384, audioTokensPerSecond: 25, rates: [
          { version: "intro", effectiveFrom: "2026-09-01T00:00:00.000Z", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000 },
        ] } },
    }) };
    const m = await mount(state);
    await answerOpen(m);
    await act(async () => __applyEventForTest({ type: "voice.catalogue", at: AT, voices: [{ ...reader, attributes: [], local: false, canClone: false, usedBy: [] }] }));
    await act(async () => __applyEventForTest({ at: AT, type: "direction.finished", ...ids, outcome: "directed", directed: 4, dropped: 0, hash: HASH, chapterVersion: 4, proposalId: "card-3", proposed: { "p0.0": { delivery: "cold" as const, speed: 1, cues: [] } } }));
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    const hear = () => q(m, '[data-testid="proposed-hear"]')!;
    assert.match(hear().textContent ?? "", /get price · 1 read$/);
    await act(async () => hear().click());
    const asked = m.sent.findLast((message) => message.kind === "hear-audiobook-line") as Extract<ClientMessage, { kind: "hear-audiobook-line" }>;
    await act(async () => __applyEventForTest({ type: "audiobook.heard", at: AT, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", requestId: asked.requestId, quote: { token: "three", estimatedMicroUsd: 12000, parts: 3 } }));
    assert.match(hear().textContent ?? "", /· 3 reads$/);
    await act(async () => hear().click());
    const confirmed = m.sent.findLast((message) => message.kind === "hear-audiobook-line") as Extract<ClientMessage, { kind: "hear-audiobook-line" }>;
    assert.deepEqual({ token: confirmed.quoteToken, proposed: confirmed.proposed }, { token: "three", proposed: true });
  });

  /** A proposal on block 2, its panel open, the dock's player swapped for one that records what it was handed. */
  async function proposedPanel() {
    setAudioFactoryForTest(() => ({ playbackRate: 1, src: "", currentTime: 0, duration: NaN, play: async () => {}, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} }) as never);
    const m = await mount(voiced(withBook(inkbound(), { narrator: RACHEL })));
    await answerOpen(m);
    await act(async () => __applyEventForTest({ type: "voice.catalogue", at: AT, voices: [{ ...RACHEL, attributes: [], local: false, canClone: false, usedBy: [] }] }));
    await act(async () => __applyEventForTest({ at: AT, type: "direction.finished", ...ids, outcome: "directed", directed: 4, dropped: 0, hash: HASH, chapterVersion: 4, proposalId: "card-4", proposed: { "p0.0": { delivery: "cold" as const, speed: 1, cues: [] } } }));
    await act(async () => all(m, ".fy-ab__block")[1]!.click());
    const row = () => q(m, '[data-testid="proposed-hear-row"]')!;
    const press = async () => {
      await act(async () => (row().querySelector('[data-testid="proposed-hear"]') as HTMLButtonElement).click());
      return (m.sent.findLast((message) => message.kind === "hear-audiobook-line") as Extract<ClientMessage, { kind: "hear-audiobook-line" }>).requestId;
    };
    const answer = (requestId: string, outcome: { file: string } | { refused: string }) =>
      act(async () => __applyEventForTest({ type: "audiobook.heard", at: AT, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", requestId, ...outcome }));
    return { m, row, press, answer };
  }

  it("Hear block's reading… gives way to the player on the heard file, and to the refusal when refused (2026-10-03)", async () => {
    try {
      const { row, press, answer } = await proposedPanel();
      const first = await press();
      assert.match(row().textContent ?? "", /reading…/);
      await answer(first, { file: ".cache/speech/heard.mp3" });
      assert.doesNotMatch(row().textContent ?? "", /reading…/, "answered, the press is put down");
      assert.equal(playbackSnapshot().clip?.id, `hear-${first}`, "and the heard file plays");
      const second = await press();
      await answer(second, { refused: "the voice job failed · open Activity for details" });
      assert.doesNotMatch(row().textContent ?? "", /reading…/);
      assert.match(row().textContent ?? "", /the voice job failed/);
      assert.equal((row().querySelector('[data-testid="proposed-hear"]') as HTMLButtonElement).disabled, false, "and it can be pressed again");
    } finally {
      dismissPlayback();
      setAudioFactoryForTest(null);
    }
  });

  it("a Hear block the coordinator never answers stops reading… at the bound, and a late file still plays (2026-10-03)", async (t) => {
    try {
      const { row, press, answer } = await proposedPanel();
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const asked = await press();
      await act(async () => t.mock.timers.tick(HEAR_ANSWER_MS - 1));
      assert.match(row().textContent ?? "", /reading…/);
      await act(async () => t.mock.timers.tick(1));
      assert.doesNotMatch(row().textContent ?? "", /reading…/);
      assert.match(row().textContent ?? "", new RegExp(HEAR_NO_ANSWER));
      t.mock.timers.reset();
      await answer(asked, { file: ".cache/speech/late.mp3" });
      assert.equal(playbackSnapshot().clip?.id, `hear-${asked}`);
    } finally {
      t.mock.timers.reset();
      dismissPlayback();
      setAudioFactoryForTest(null);
    }
  });

  it("cast first, Draft speaker notes is offered and ticked, and Direct asks for all three (2026-10-03)", async () => {
    const m = await mount(voiced(inkbound("performed")));
    await answerOpen(m);
    const item = (await menuItem(m, "direct-audiobook"))!;
    await act(async () => item.click());
    const preview = m.sent.findLast((message) => message.kind === "preview-direction") as Extract<ClientMessage, { kind: "preview-direction" }>;
    await act(async () =>
      __applyEventForTest({
        at: AT, type: "direction.reads", ...ids, requestId: preview.requestId,
        reads: { chapter: { order: 2, version: 4, synopsis: true }, speakers: [], narrator: { label: "George" }, notes: { book: false, chapter: false, speakers: 0 }, before: null, cast: "not cast · cast the lines first" },
      }),
    );
    const box = (label: string) => all(m, '[data-testid="direct-sheet"] .fy-ab__also').find((also) => also.textContent?.startsWith(label))!.querySelector("input") as HTMLInputElement;
    assert.equal(box("Draft speaker notes").disabled, false, "the cast's speakers are drafted for");
    assert.equal(box("Draft speaker notes").checked, true);
    await act(async () => q(m, '[data-testid="direct-sheet-direct"]')!.click());
    const direct = m.sent.findLast((message) => message.kind === "direct-chapter") as Extract<ClientMessage, { kind: "direct-chapter" }>;
    assert.deepEqual({ cast: direct.cast, chapterNote: direct.chapterNote, speakerNotes: direct.speakerNotes }, { cast: true, chapterNote: true, speakerNotes: true });
  });

  it("Direct this chapter is the Direct and illustrate menu's first item, beside the read, and gives way to a held proposal (184a, 184b, 194d)", async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m);
    const press = q(m, '[data-testid="direct-illustrate"]')!;
    assert.equal(press.textContent, "Direct and illustrate");
    assert.equal(press.getAttribute("aria-haspopup"), "menu");
    assert.equal(press.classList.contains("fy-ab__pill--pri"), false, "never the filled press (turn 188)");
    assert.ok(q(m, '[data-testid="read-audiobook"]')?.classList.contains("fy-ab__pill--pri"), "the read is, until a block is made");
    assert.equal(press.closest(".fy-ab__control"), q(m, '[data-testid="read-audiobook"]')?.parentElement, "beside Read the chapter");
    const item = (await menuItem(m, "direct-audiobook"))!;
    assert.deepEqual(all(m, '.fy-ab__toolmenu [role="menuitem"] .fy-ab__menu-label').map((label) => label.textContent), ["Direct this chapter", "Illustrate this chapter", "Looks"], "one menu, three items");
    await act(async () => item.click());
    assert.equal(q(m, ".fy-ab__toolmenu"), null, "a choice closes the menu");
    assert.ok(q(m, '[data-testid="direct-sheet"]'), "the dock's sheet");
    await openArke(m);
    assert.ok(all(m, ".fy-arke__prompt").some((b) => b.textContent === "Direct this chapter"), "the dock keeps its prompt");
    await act(async () => __applyEventForTest({ at: AT, type: "direction.finished", ...ids, outcome: "directed", directed: 4, dropped: 0, hash: HASH, chapterVersion: 4, proposalId: "card-5", proposed: { "p0.0": { delivery: "cold" as const, speed: 1, cues: [] } } }));
    const held = (await menuItem(m, "direct-audiobook"))!;
    assert.equal(held.getAttribute("aria-disabled"), "true", "the card answers it until it is accepted or discarded");
    assert.equal(held.querySelector(".fy-ab__menu-meta")?.textContent, "proposed");
  });
});

/**
 * Illustrate this chapter (design turn 191b, 191d, SPEC-047 R-101, R-102): in the head beside Direct;
 * the proposal dashed on the blocks and listed in the dock's card; Skip per row; a character with no
 * picture holds her row; Accept is the price of what is left, confirmed once; the pictures are made one
 * at a time and counted; Stop keeps what is made.
 */
describe("Illustrate this chapter (turn 191)", () => {
  const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
  const row = (block: string, over: Partial<IllustrationRow> = {}): IllustrationRow => ({
    block,
    textHash: "t",
    at: 12,
    title: `Picture ${block}`,
    prompt: "Maren at the rail.",
    who: [{ key: "maren-kest", name: "Maren", sheet: "maren-kest", kind: "character", reference: "references/maren-kest/head-front.png", carried: true }],
    estimatedMicroUsd: 40_000,
    ...over,
  });
  const PROPOSAL: IllustrationProposal = {
    proposalId: "ill-1",
    hash: HASH,
    rows: [
      row("p0.0", { title: "The bell", at: 0 }),
      row("p1.0", { title: "The line", at: 70, who: [{ key: "maren-kest", name: "Maren", sheet: "maren-kest", kind: "character", reference: "references/maren-kest/head-front.png", carried: true }, { key: "sereth", name: "Sereth", sheet: "sereth", kind: "character", reference: null, carried: false }], needs: ["Sereth"] }),
      row("p3.0", { title: "The tide", at: 150 }),
    ],
    model: { provider: "fal", id: "stair-image", name: "Stair Image", references: 2 },
    aspect: "16:9",
    seconds: 270,
    estimated: true,
    standing: 0,
  };
  const proposedMount = async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m);
    // The run's status lives in the dock, put away in this view until it is opened (194, rule 13).
    await openArke(m);
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.finished", ...ids, outcome: "proposed", proposal: PROPOSAL }));
    return m;
  };
  const sentOf = <K extends ClientMessage["kind"]>(m: Mounted, kind: K) => m.sent.filter((message): message is Extract<ClientMessage, { kind: K }> => message.kind === kind);

  it("is the Direct and illustrate menu's second item, asks, and the toolbar says it is reading; Illustrate again while a proposal is held (194d)", async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m);
    const item = await menuItem(m, "illustrate-chapter");
    assert.equal(item?.querySelector(".fy-ab__menu-label")?.textContent, "Illustrate this chapter");
    assert.equal(item?.parentElement, q(m, '[data-testid="direct-audiobook"]')?.parentElement, "beside Direct this chapter, in one menu");
    await act(async () => item!.click());
    assert.deepEqual(sentOf(m, "illustrate-chapter").map((message) => [message.productionId, message.chapterFile]), [["inkbound", "01-neap"]]);
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.started", ...ids }));
    assert.equal(q(m, '[data-testid="audiobook-run-line"]')?.textContent, "illustrating…Stop", "the run's line and Stop stand in the menu's place");
    assert.equal(q(m, '[data-testid="direct-illustrate"]'), null, "one reading at a time");
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.finished", ...ids, outcome: "proposed", proposal: PROPOSAL }));
    const again = await menuItem(m, "illustrate-chapter");
    assert.equal(again?.querySelector(".fy-ab__menu-label")?.textContent, "Illustrate again");
    assert.equal(again?.querySelector(".fy-ab__menu-meta")?.textContent, "3 to make", "with what the proposal would make");
  });

  it("has Looks in the Direct and illustrate menu, opening the chapter's Looks sheet (design turn 193a, 194d)", async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m, { voices: CAST });
    const looks = await menuItem(m, "audiobook-looks-open");
    assert.equal(looks?.textContent, "Looks");
    assert.equal(looks?.parentElement, q(m, '[data-testid="illustrate-chapter"]')?.parentElement, "beside Illustrate this chapter");
    assert.equal(document.body.querySelector('[data-testid="look-sheet"]'), null, "closed until pressed");
    await act(async () => looks!.click());
    assert.ok(document.body.querySelector('[data-testid="look-sheet"]'), "the Looks sheet opens on the body");
    assert.equal(sentOf(m, "read-audiobook-looks").length, 1, "which chapters chose which look is asked when it opens");
    await act(async () => (document.body.querySelector('[data-testid="look-done"]') as HTMLButtonElement).click());
    assert.equal(document.body.querySelector('[data-testid="look-sheet"]'), null);
    // The rail's Voices reaches them too (rule 18), which is how Manuscript does.
    await act(async () => q(m, '[data-testid="voices-looks"]')!.click());
    assert.ok(document.body.querySelector('[data-testid="look-sheet"]'), "Looks from the Voices panel");
  });

  it("opens the proposal as a sheet over the main area, beside the dock: its pace, what needs a look, the dashed chips on the blocks, one Accept", async () => {
    const m = await proposedMount();
    assert.deepEqual(all(m, '[data-testid="illustration-chip"]').map((chip) => chip.textContent), ["The bell", "The line", "The tide"], "a dashed chip on each block it would go on");
    const sheet = q(m, '[data-testid="illustration-sheet"]')!;
    assert.ok(sheet, "the proposal arrives as a sheet");
    assert.equal(sheet.parentElement, q(m, '[data-testid="chapter-workspace"]'), "over the chapter's main area, a sibling of it and of the dock, not inside the dock");
    assert.equal(sheet.closest(".fy-arke"), null);
    assert.equal(q(m, ".fy-ills__head h3")!.textContent, "Illustrate · Chapter 2");
    assert.equal(q(m, '[data-testid="illustration-headline"]')!.textContent, "3 pictures · one a minute and a half · 2 to make · 1 needs a look");
    assert.deepEqual(all(m, '[data-testid="illustration-row"]').map((r) => [r.dataset.block, r.dataset.state]), [["p0.0", "ready"], ["p1.0", "held"], ["p3.0", "ready"]]);
    const first = all(m, '[data-testid="illustration-row"]')[0]!;
    assert.match(first.textContent!, /~0:00/, "times are estimated until the chapter is read");
    assert.match(q(m, '[data-block="p0.0"] .fy-ills__words')!.textContent!, /Maren counted the bells\./, "the block's own words, from the chapter");
    assert.equal(q(m, '[data-block="p0.0"] .fy-ills__hd b')!.textContent, "The bell");
    assert.equal(all(m, '[data-testid="illustration-accept"]').length, 1, "one Accept");
    assert.equal(q(m, '[data-testid="illustration-accept"]')!.textContent, "Accept · ~$0.08");
    assert.equal(sentOf(m, "accept-illustration").length, 0, "reading the proposal costs nothing and makes nothing");
  });

  it("leaves the dock one line of status, and Close keeps the proposal one press from the sheet", async () => {
    const m = await proposedMount();
    assert.equal(q(m, '[data-testid="illustration-card"]'), null, "the card is gone from the dock");
    const status = q(m, '[data-testid="illustration-status"]')!;
    assert.equal(status.dataset.state, "proposed");
    assert.equal(status.querySelectorAll("p").length, 1, "one line");
    assert.equal(q(m, '[data-testid="illustration-line"]')!.textContent, "Illustrate3 pictures · ~$0.08");
    assert.equal(status.querySelector('[data-testid="illustration-row"]'), null, "no rows in the dock");
    await act(async () => q(m, '[data-testid="illustration-close"]')!.click());
    assert.equal(q(m, '[data-testid="illustration-sheet"]'), null);
    assert.equal(all(m, '[data-testid="illustration-chip"]').length, 3, "the proposal is held: dashed on the blocks still");
    assert.equal(sentOf(m, "discard-illustration").length, 0, "Close discards nothing");
    await act(async () => q(m, '[data-testid="illustration-review"]')!.click());
    assert.ok(q(m, '[data-testid="illustration-sheet"]'), "Review brings it back");
    await act(async () => void dom.document.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" })));
    assert.equal(q(m, '[data-testid="illustration-sheet"]'), null, "Escape puts it away");
    assert.equal(q(m, '[data-testid="illustration-status"]')!.dataset.state, "proposed");
  });

  it("stays put away when the window opens on a proposal already held", async () => {
    const m = await mount(voiced(inkbound()));
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.finished", ...ids, outcome: "proposed", proposal: PROPOSAL }));
    assert.ok(q(m, '[data-testid="illustration-sheet"]'), "arriving while the window is open opens it");
    await act(async () => q(m, '[data-testid="illustration-close"]')!.click());
    const again = await mount(voiced(inkbound()), ROUTE, true);
    assert.equal(q(again, '[data-testid="illustration-sheet"]'), null, "a held proposal is not thrown over a window that has just opened");
    await openArke(again);
    assert.equal(q(again, '[data-testid="illustration-status"]')?.dataset.state, "proposed");
  });

  it("skips a row — its chip and its price go, and it can be put back — and Accept sends the rows left on the price it showed, then puts the sheet away", async () => {
    const m = await proposedMount();
    await act(async () => (all(m, '[data-testid="illustration-skip"]')[0] as HTMLButtonElement).click());
    assert.deepEqual(all(m, '[data-testid="illustration-chip"]').map((chip) => chip.textContent), ["The line", "The tide"]);
    assert.equal(q(m, '[data-testid="illustration-accept"]')!.textContent, "Accept · ~$0.04");
    assert.equal(q(m, '[data-testid="illustration-headline"]')!.textContent, "3 pictures · one a minute and a half · 1 to make · 1 skipped · 1 needs a look");
    assert.equal(all(m, '[data-testid="illustration-row"]')[0]!.dataset.state, "skipped");
    assert.equal(all(m, '[data-testid="illustration-skip"]')[0]!.textContent, "Put back");
    await act(async () => q(m, '[data-testid="illustration-accept"]')!.click());
    const sent = sentOf(m, "accept-illustration")[0]!;
    assert.deepEqual([sent.proposalId, sent.blocks, sent.confirmedMicroUsd, sent.chapterFile], ["ill-1", ["p3.0"], 40_000, "01-neap"], "the held row and the skipped row are not asked for");
    assert.equal(q(m, '[data-testid="illustration-sheet"]'), null, "accepted: the sheet goes and the dock counts");
    assert.equal(q(m, '[data-testid="illustration-status"]')!.dataset.state, "making");
  });

  it("names each card's frame in the slot's corner (design turn 193h, rule 11)", async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m);
    const shot = (frame: string) => ({ frame, inFrame: [], notInFrame: [], expressions: {}, details: [], checks: [] });
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.finished", ...ids, outcome: "proposed", proposal: { ...PROPOSAL, rows: [row("p0.0", { shot: shot("Medium two-shot across the table") }), row("p3.0", { at: 150, who: [], shot: shot("Detail, her hand on the rail") }), row("p1.0", { at: 70 })] } }));
    assert.deepEqual(all(m, '[data-testid="illustration-row"]').map((card) => card.querySelector('[data-testid="illustration-frame"]')?.textContent ?? null), ["Two-shot", "Detail", null]);
    assert.match(all(m, '[data-testid="illustration-row"]')[1]!.textContent ?? "", /no reference rides/, "a detail carries no one");
  });

  it("makes a look from a held row over the proposal for a character with a main photo, and sends one without to their page (design turn 193h)", async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m);
    const maren = { key: "maren-kest", name: "Maren", sheet: "maren-kest", kind: "character" as const, reference: null, carried: false };
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.finished", ...ids, outcome: "proposed", proposal: { ...PROPOSAL, rows: [row("p0.0", { who: [maren], needs: ["Maren"] }), PROPOSAL.rows[1]!] } }));
    const [held, sereth] = all(m, '[data-testid="illustration-row"]');
    await act(async () => (held!.querySelector('[data-testid="illustration-needs"]') as HTMLButtonElement).click());
    assert.ok(document.body.querySelector('[data-testid="new-look-sheet"]'), "the make-a-look sheet opens over the proposal");
    assert.match(document.body.querySelector(".fy-newlook")?.textContent ?? "", /New look · Maren/);
    assert.equal(sentOf(m, "generate-character-looks").length, 0, "nothing is made until Make");
    await act(async () => (document.body.querySelector('[data-testid="new-look-cancel"]') as HTMLButtonElement).click());
    assert.equal(document.body.querySelector('[data-testid="new-look-sheet"]'), null);
    assert.ok(q(m, '[data-testid="illustration-sheet"]'), "the proposal is still there");
    await act(async () => (sereth!.querySelector('[data-testid="illustration-needs"]') as HTMLButtonElement).click());
    assert.equal(document.body.querySelector('[data-testid="new-look-sheet"]'), null, "Sereth has no main photo to make a look from: his page instead");
  });

  it("holds a row for a character with no picture: Make a look stands where Skip would, and it goes only if the author says without", async () => {
    const m = await proposedMount();
    const held = all(m, '[data-testid="illustration-row"]')[1]!;
    assert.equal(held.querySelector('[data-testid="illustration-skip"]'), null, "Make a look stands where Skip would");
    assert.equal(held.querySelector('[data-testid="illustration-needs"]')!.textContent, "Make a look");
    assert.match(held.querySelector(".fy-ills__wh")!.textContent!, /Sereth\s*no look/);
    assert.ok(held.className.includes("fy-ills__card--held"), "amber");
    await act(async () => (held.querySelector('[data-testid="illustration-without"]') as HTMLButtonElement).click());
    assert.equal(all(m, '[data-testid="illustration-row"]')[1]!.dataset.state, "ready");
    assert.equal(q(m, '[data-testid="illustration-headline"]')!.textContent!.includes("need"), false);
    assert.equal(q(m, '[data-testid="illustration-accept"]')!.textContent, "Accept · ~$0.12");
    await act(async () => q(m, '[data-testid="illustration-accept"]')!.click());
    const sent = sentOf(m, "accept-illustration")[0]!;
    assert.deepEqual([sent.blocks, sent.without, sent.confirmedMicroUsd], [["p0.0", "p1.0", "p3.0"], ["p1.0"], 120_000]);
  });

  it("counts the pictures as they are made in the dock's one line and Stop keeps what is made", async () => {
    const m = await proposedMount();
    await act(async () => q(m, '[data-testid="illustration-accept"]')!.click());
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.progress", ...ids, progress: { proposalId: "ill-1", state: "making", total: 2, made: ["p0.0"], failed: [], current: "p3.0", spentMicroUsd: 40_000, confirmedMicroUsd: 80_000 } }));
    assert.equal(q(m, '[data-testid="illustration-progress"]')!.textContent, "Illustratemaking pictures · 1 of 2 · $0.04 of ~$0.08");
    assert.equal(q(m, '[role="progressbar"]')!.getAttribute("aria-valuenow"), "1");
    assert.equal(q(m, '[data-testid="illustration-made"]'), null, "one line: no Made and Next lines");
    assert.equal(q(m, '[data-testid="illustration-next"]'), null);
    assert.equal(q(m, '[data-testid="illustration-sheet"]'), null);
    assert.deepEqual(all(m, '[data-testid="illustration-chip"]').map((chip) => chip.textContent), ["The tide"], "a made picture is no longer dashed");
    assert.equal(q(m, '[data-testid="audiobook-run-line"]')?.textContent, "making pictures · 1 of 2Stop", "the toolbar counts them in the menu's place (194, rule 3)");
    await act(async () => q(m, '[data-testid="illustration-stop"]')!.click());
    assert.deepEqual(sentOf(m, "stop-illustration").map((message) => message.chapterFile), ["01-neap"]);
    await act(async () => q(m, '[data-testid="audiobook-run-stop"]')!.click());
    assert.equal(sentOf(m, "stop-illustration").length, 2, "and the toolbar's Stop is the same stop");
  });

  it("keeps a picture that failed as the proposal, with its reason, offered again in the sheet", async () => {
    const m = await proposedMount();
    await act(async () => q(m, '[data-testid="illustration-accept"]')!.click());
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.progress", ...ids, progress: { proposalId: "ill-1", state: "done", total: 2, made: ["p0.0"], failed: [{ block: "p3.0", reason: "the provider refused the prompt" }], spentMicroUsd: 40_000, confirmedMicroUsd: 80_000 } }));
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.finished", ...ids, outcome: "proposed", proposal: { ...PROPOSAL, rows: PROPOSAL.rows.filter((r) => r.block !== "p0.0") } }));
    assert.equal(q(m, '[data-testid="illustration-status"]')!.dataset.state, "proposed");
    assert.ok(q(m, '[data-testid="illustration-sheet"]'), "what is left comes back as the sheet");
    assert.equal(q(m, '[data-testid="illustration-ended"]')?.textContent, "made · 1 of 2 · 1 held");
    assert.equal(q(m, '[data-block="p3.0"] [data-testid="illustration-row-reason"]')?.textContent, "the provider refused the prompt");
    assert.equal(q(m, '[data-testid="illustration-row"][data-block="p0.0"]'), null, "what was made is not offered again");
    await act(async () => q(m, '[data-testid="illustration-accept"]')!.click());
    assert.equal(sentOf(m, "accept-illustration").length, 2, "asked again, on a new confirm");
  });

  it("holds a picture the provider refused in a reopened sheet, with its reason, until Try again or Skip (2026-10-04)", async () => {
    // What a window that opens later is replayed: the proposal left after the run, the refused row carrying why.
    const m = await mount(voiced(inkbound()));
    await answerOpen(m);
    const refused = { ...PROPOSAL, rows: [PROPOSAL.rows[0]!, PROPOSAL.rows[1]!, row("p3.0", { title: "The tide", at: 150, refused: "refused by the image safety check" })] };
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.finished", ...ids, outcome: "proposed", proposal: refused }));
    const tide = q(m, '[data-testid="illustration-row"][data-block="p3.0"]')!;
    assert.equal(tide.dataset.state, "refused", "not an ordinary proposed picture");
    assert.ok(tide.className.includes("fy-ills__card--held"));
    assert.equal(tide.querySelector('[data-testid="illustration-row-reason"]')?.textContent, "refused by the image safety check");
    assert.equal(q(m, '[data-testid="illustration-headline"]')!.textContent, "3 pictures · one a minute and a half · 1 to make · 1 needs a look · 1 refused");
    assert.equal(q(m, '[data-testid="illustration-accept"]')!.textContent, "Accept · ~$0.04", "the total is what will be made");
    await act(async () => (tide.querySelector('[data-testid="illustration-retry"]') as HTMLButtonElement).click());
    assert.equal(q(m, '[data-testid="illustration-row"][data-block="p3.0"]')!.dataset.state, "ready", "Try again puts it back in the run");
    assert.equal(q(m, '[data-testid="illustration-headline"]')!.textContent, "3 pictures · one a minute and a half · 2 to make · 1 needs a look");
    assert.equal(q(m, '[data-testid="illustration-accept"]')!.textContent, "Accept · ~$0.08");
    await act(async () => q(m, '[data-testid="illustration-accept"]')!.click());
    const sent = sentOf(m, "accept-illustration")[0]!;
    assert.deepEqual([sent.blocks, sent.without, sent.confirmedMicroUsd], [["p0.0", "p3.0"], ["p3.0"], 80_000], "named, so the coordinator makes it");
  });

  it("holds a row refused again after Try again: the consent was for the run that ended", async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m);
    const refused = (reason: string) => ({ ...PROPOSAL, rows: [PROPOSAL.rows[0]!, row("p3.0", { at: 150, refused: reason })] });
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.finished", ...ids, outcome: "proposed", proposal: refused("refused by the image safety check") }));
    await act(async () => (q(m, '[data-block="p3.0"] [data-testid="illustration-retry"]') as HTMLButtonElement).click());
    assert.equal(q(m, '[data-testid="illustration-row"][data-block="p3.0"]')!.dataset.state, "ready");
    await act(async () => q(m, '[data-testid="illustration-accept"]')!.click());
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.progress", ...ids, progress: { proposalId: "ill-1", state: "done", total: 2, made: ["p0.0"], failed: [{ block: "p3.0", reason: "refused by the image safety check" }], spentMicroUsd: 40_000, confirmedMicroUsd: 80_000 } }));
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.finished", ...ids, outcome: "proposed", proposal: { ...refused("refused by the image safety check"), rows: [row("p3.0", { at: 150, refused: "refused by the image safety check" })] } }));
    assert.equal(q(m, '[data-testid="illustration-row"][data-block="p3.0"]')!.dataset.state, "refused", "held again, not sent on the next Accept");
    assert.equal((q(m, '[data-testid="illustration-accept"]') as HTMLButtonElement).disabled, true, "nothing to make until Try again");
  });

  it("does not send a refused row the author left held", async () => {
    const m = await mount(voiced(inkbound()));
    await answerOpen(m);
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.finished", ...ids, outcome: "proposed", proposal: { ...PROPOSAL, rows: [PROPOSAL.rows[0]!, row("p3.0", { at: 150, refused: "refused by the image safety check" })] } }));
    await act(async () => q(m, '[data-testid="illustration-accept"]')!.click());
    assert.deepEqual(sentOf(m, "accept-illustration")[0]!.blocks, ["p0.0"]);
  });

  it("discards at no cost, and says in one clause why an accept was refused", async () => {
    const m = await proposedMount();
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.progress", ...ids, progress: { proposalId: "ill-1", state: "done", total: 0, made: [], failed: [], spentMicroUsd: 0, confirmedMicroUsd: 0 }, refused: "the prose moved · illustrate again" }));
    assert.equal(q(m, '[data-testid="illustration-refused"]')?.textContent, "the prose moved · illustrate again");
    assert.ok(q(m, '[data-testid="illustration-sheet"]'), "the proposal stands");
    await act(async () => q(m, '[data-testid="illustration-discard"]')!.click());
    assert.deepEqual(sentOf(m, "discard-illustration").map((message) => message.chapterFile), ["01-neap"]);
    assert.equal(q(m, '[data-testid="illustration-sheet"]'), null);
    assert.deepEqual(all(m, '[data-testid="illustration-chip"]'), []);
    assert.equal(sentOf(m, "accept-illustration").length, 0, "nothing was spent");
  });

  it("asks again from the sheet, says why nothing was proposed, and opens the look from the sheet", async () => {
    const m = await proposedMount();
    await act(async () => q(m, '[data-testid="illustration-again"]')!.click());
    assert.equal(sentOf(m, "illustrate-chapter").length, 1, "Illustrate again in the sheet is the head's press");
    await act(async () => q(m, '[data-testid="illustration-look"]')!.click());
    assert.ok(dom.document.body.querySelector('[data-testid="look-sheet"]'), "the look sheet opens from the proposal");
    await act(async () => __applyEventForTest({ at: AT, type: "illustration.finished", ...ids, outcome: "failed", reason: "the chapter has its pictures" }));
    assert.equal(q(m, '[data-testid="illustration-status"]')!.dataset.state, "failed");
    assert.equal(q(m, '[data-testid="illustration-sheet"]'), null);
    assert.equal(q(m, ".fy-illst__line")?.textContent, "Illustratethe chapter has its pictures");
  });
});

describe("grouped reads (design turn 185)", () => {
  const GEMINI: ManifestModel = {
    id: "gemini-3.8-flash-tts",
    provider: "google",
    capability: "voice-tts",
    displayName: "Gemini 3.8 Flash TTS",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { audioFormat: "wav", maxSpeechUtf8Bytes: 7000 },
    pricing: { kind: "perToken", microUsdPerMillionInput: 500_000, microUsdPerMillionOutput: 9_000_000,
      speech: { tier: "standard", maxInputTokens: 8192, maxOutputTokens: 16384, audioTokensPerSecond: 25, rates: [
        { version: "intro", effectiveFrom: "2026-09-01T00:00:00.000Z", microUsdPerMillionInput: 500_000, microUsdPerMillionOutput: 9_000_000 },
      ] } },
    cadence: { deliveries: ["measured"], speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none", phrase: "best-effort-instruction",
      deliveryMappings: { measured: { settings: {}, instruction: "Read calmly." } }, groupable: true },
  };
  const READER = { provider: "google", model: GEMINI.id, voiceId: "Kore", label: "Kore" };
  const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" };
  /** A groupable Gemini narrator for the book, and a local transcriber on this machine. */
  function grouped(requests?: "per-paragraph", transcriber = true): ClientState {
    const state = inkbound();
    state.world = { ...state.world!, productions: state.world!.productions.map((p) => (p.meta.id === "inkbound" ? { ...p, audiobook: { schemaVersion: 1, reading: "narrator", narrator: READER, ...(requests !== undefined ? { requests } : {}) } } : p)) };
    state.app = {
      ...state.app,
      manifest: { ...state.app.manifest!, models: [...state.app.manifest!.models, GEMINI] },
      providers: [...state.app.providers, { id: "whispercpp", configured: true, validation: "valid", probes: [{ capability: "voice-stt", available: transcriber }], fault: null }],
    };
    return state;
  }
  async function mountGrouped(state: ClientState): Promise<Mounted> {
    const m = await mount(state);
    await answerOpen(m);
    await act(async () => __applyEventForTest({ type: "voice.catalogue", at: AT, voices: [{ ...READER, attributes: [], local: false, canClone: false, usedBy: [] }] }));
    return m;
  }

  it("Read the chapter counts requests beside blocks, and each request's blocks are bracketed under a label (185a)", async () => {
    const m = await mountGrouped(grouped());
    const press = q(m, '[data-testid="read-audiobook"]')!.textContent!;
    assert.match(press, /^Read the chapter · 4 blocks · 1 request · ~\$/, press);
    assert.deepEqual(all(m, '[data-testid="audiobook-request"]').map((label) => label.textContent), ["request 1 · 4 blocks · ~1 min"]);
    assert.equal(all(m, ".fy-ab__request .fy-ab__block").length, 4, "the request's blocks sit inside its bracket");
  });

  it("reads per paragraph where the book says so or this machine cannot split", async () => {
    for (const state of [grouped("per-paragraph"), grouped(undefined, false)]) {
      const m = await mountGrouped(state);
      assert.doesNotMatch(q(m, '[data-testid="read-audiobook"]')!.textContent!, /request/);
      assert.equal(all(m, '[data-testid="audiobook-request"]').length, 0);
      await act(async () => m.root.unmount());
      open.splice(open.indexOf(m), 1);
      m.container.remove();
    }
  });

  it("the confirm sheet names requests, a block a request and the estimate, and Confirm answers the token (185a)", async () => {
    const m = await mountGrouped(grouped());
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", toMake: 4, blocks: 4 }));
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.priced", ...ids, characters: 120, estimatedMicroUsd: 4_600, confirmationToken: "tok", voices: [{ label: "Kore", provider: "google", characters: 120, estimatedMicroUsd: 4_600 }], requests: 1, perParagraph: 4 }));
    const sheet = q(m, '[data-testid="read-sheet"]')!;
    assert.ok(sheet, "a grouped read is confirmed in its sheet");
    assert.match(sheet.textContent!, /Requests1 · grouped/);
    assert.match(sheet.textContent!, /Per paragraph4 requests/);
    assert.match(sheet.textContent!, /Estimate~\$0\.0046/);
    const confirm = q(m, '[data-testid="read-sheet"] [data-testid="audiobook-confirm"]')!;
    assert.equal(confirm.textContent, "Confirm · 1 request · ~$0.0046");
    await act(async () => confirm.click());
    const answered = m.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.equal(answered.confirmationToken, "tok");
  });

  it("progress counts requests and blocks, and the request being read is dark (185b)", async () => {
    const m = await mountGrouped(grouped());
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", toMake: 4, blocks: 4, requests: 1, groups: [NARRATION_KEYS] }));
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.request", ...ids, index: 1, of: 1, keys: NARRATION_KEYS }));
    assert.equal(q(m, '[data-testid="audiobook-progress"]')!.textContent, "reading… request 1 of 1 · 0 of 4");
    assert.ok(q(m, ".fy-ab__request--now"), "the bracket is dark while its request is read");
    assert.equal(q(m, '[data-testid="audiobook-request"]')!.textContent, "request 1 · reading");
  });

  it("a split that did not match says what was heard; Keep keeps it and Re-read reads it again (185c)", async () => {
    const m = await mountGrouped(grouped());
    const texts = { title: "Chapter 2 · The counting of bells", "p0.0": "Maren counted the bells.", "p1.0": LINE, "p3.0": "Six, and the tide <br> not yet called." };
    const held = record(["title", "p0.0", "p1.0"], texts);
    held.flags["p3.0"] = { reason: "split did not match · “six and the tide not called”", at: "2026-09-14T10:00:00.000Z",
      split: { artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6H9", heard: "six and the tide not called", request: "jb_01J8F3K2QW9VZX4N7M0RTYB6H9", offsetSec: 72, durationSec: 19 } };
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.finished", ...ids, outcome: "read", made: 3, flagged: 1, record: held }));
    const line = q(m, '[data-testid="audiobook-split"]')!;
    assert.match(line.textContent!, /split did not match · “six and the tide not called”/);
    await act(async () => all(m, ".fy-ab__block")[3]!.click());
    const panel = q(m, '[data-testid="audiobook-split-panel"]')!;
    assert.match(panel.textContent!, /grouped · 1:12–1:31/);
    assert.match(panel.textContent!, /Heardsix and the tide not called/);
    await act(async () => q(m, '[data-testid="audiobook-keep-split"]')!.click());
    const kept = m.sent.findLast((message) => message.kind === "keep-audiobook-split") as Extract<ClientMessage, { kind: "keep-audiobook-split" }>;
    assert.equal(kept.block, "p3.0");
    assert.match(q(m, '[data-testid="audiobook-reread"]')!.textContent!, /^Re-read · 1 request · ~\$/);
    await act(async () => q(m, '[data-testid="audiobook-reread"]')!.click());
    const reread = m.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.deepEqual(reread.blocks, ["p3.0"], "one block, which the coordinator reads with its neighbours");
  });
});

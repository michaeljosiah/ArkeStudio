import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { estimateCharacterImageMicroUsd, type ChapterAudiobook, type ClientMessage, type ClientState, type DomainEvent, type ManifestModel, type Take } from "@arke-studio/contracts";
import { LookSheet } from "../src/components/audiobook-look.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The chapter's Looks (design turn 193a, SPEC-047 R-112..R-116): a picker over each character's
 * kit looks with the chosen one ringed, its full-body image, its line and where it came from, a
 * conflict row where the chapter and the look disagree, the close view, and Make a look.
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
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const AT = "2026-10-04T09:00:00.000Z";
const KEYS = ["title", "p0.0", "p1.0", "p2.0"];
const GPT: ManifestModel = { id: "gpt-image-2", provider: "openai", capability: "image", displayName: "GPT Image 2", accepts: { referenceImages: 16, referenceRoles: false, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perImage", microUsdPerImage: 40_000 } };
const STORM = { id: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G1", file: "takes/tk_storm/storm.png", kind: "costume" as const, prompt: "Storm coat, hood up; two braids.", acceptedAt: "2026-10-03T09:00:00.000Z", framing: "full-body" as const, mainFile: "head-front.png", closeFile: "takes/tk_close/close.png" };
const HARBOUR = { id: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G2", file: "takes/tk_harbour/harbour.png", kind: "costume" as const, prompt: "Harbour coat, bare head.", acceptedAt: "2026-10-02T09:00:00.000Z", mainFile: "an-older-photo.png" };

function state(looks: unknown[] = [STORM, HARBOUR], takes: Take[] = []): ClientState {
  const world = FIXTURE_STATE.world!;
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      manifest: { ...FIXTURE_STATE.app.manifest!, models: [...FIXTURE_STATE.app.manifest!.models, GPT] },
      routing: { ...FIXTURE_STATE.app.routing, defaults: { ...FIXTURE_STATE.app.routing.defaults, image: GPT.id } },
      providers: [...FIXTURE_STATE.app.providers.filter((p) => p.id !== "openai"), { id: "openai", configured: true, validation: "valid", probes: [{ capability: "image", available: true }], fault: null }],
    },
    world: {
      ...world,
      referenceTakes: takes,
      referenceKits: world.referenceKits.map((kit) => (kit.sheetId === "maren-kest" ? ({ ...kit, looks } as never) : kit)),
      productions: world.productions.map((p) => (p.meta.id === "saltlight" ? { ...p, chapters: p.chapters.map((chapter) => (chapter.file === "03-the-stair" ? chapter : chapter)) } : p)),
    },
  };
}
const record = (look: ChapterAudiobook["look"]): ChapterAudiobook => ({ schemaVersion: 1, chapterVersion: 4, hash: "h", updatedAt: AT, flags: {}, direction: {}, takes: {}, ...(look !== undefined ? { look } : {}) });
const LOOK = (maren: Record<string, unknown> = {}): NonNullable<ChapterAudiobook["look"]> => ({
  chapterHash: "h",
  at: AT,
  place: { text: "The flooded quarter, dusk.", blocks: ["p0.0"] },
  mood: { text: "Teal water, amber lamplight; fine grain." },
  characters: { "maren-kest": { name: "Maren Kest", sheet: "maren-kest", text: "Oilskin coat, dark and stiff with salt.", blocks: ["p1.0", "p2.0"], ...maren } as never },
});

type Mounted = { root: Root; sent: ClientMessage[]; closed: () => boolean };
const open: Mounted[] = [];
const bodyAll = (selector: string) => [...dom.document.body.querySelectorAll(selector)] as HTMLElement[];
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
async function mount(look: ChapterAudiobook["look"], world: ClientState = state(), connection: "open" | "closed" = "open"): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  let closed = false;
  await act(async () => {
    __setStateForTest(world, { connection });
    root.render(<LookSheet open onClose={() => (closed = true)} worldId={FIXTURE_WORLD_ID} productionId="saltlight" chapterFile="07-the-tenth-key" chapterOrder={7} record={record(look)} blockKeys={KEYS} />);
  });
  const mounted = { root, sent, closed: () => closed };
  open.push(mounted);
  return mounted;
}
afterEach(async () => {
  for (const mounted of open.splice(0)) await act(async () => mounted.root.unmount());
  dom.document.body.innerHTML = "";
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});
const press = async (el: Element | null | undefined) => {
  assert.ok(el, "the thing to press exists");
  await act(async () => void el.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
};
const sentOf = <K extends ClientMessage["kind"]>(m: Mounted, kind: K) => m.sent.filter((message): message is Extract<ClientMessage, { kind: K }> => message.kind === kind);
const tiles = () => bodyAll('[data-key="maren-kest"] [data-testid="look-tile"]');

describe("a character with looks (193a)", () => {
  it("offers the main photo, each look the kit holds and New look, with none ringed when none is chosen", async () => {
    await mount(LOOK());
    assert.deepEqual(tiles().map((tile) => tile.getAttribute("data-look")), ["main", STORM.id, HARBOUR.id], "newest look first, the main photo leads");
    assert.equal(tiles()[0]!.getAttribute("aria-selected"), "true", "no look chosen: the main photo rides");
    assert.equal(tiles()[1]!.getAttribute("aria-selected"), "false");
    assert.equal(text(bodyAll('[data-key="maren-kest"] [data-testid="look-new"]')[0]), "New look");
    assert.equal(bodyAll('[data-key="maren-kest"] [data-testid="look-image"]')[0]!.getAttribute("data-view"), "main");
    assert.match(text(bodyAll('[data-key="maren-kest"] [data-testid="look-state"]')[0]), /no look · the main photo rides/);
  });

  it("rings the chosen look, shows its full-body image, its words and that it has a close view", async () => {
    await mount(LOOK({ text: STORM.prompt, lookId: STORM.id, reading: "Oilskin coat." }));
    assert.equal(tiles()[1]!.getAttribute("aria-selected"), "true");
    const image = bodyAll('[data-key="maren-kest"] [data-testid="look-image"]')[0]!;
    assert.equal(image.getAttribute("data-view"), "full");
    assert.match(image.getAttribute("src") ?? "", /references\/maren-kest\/takes\/tk_storm\/storm\.png/);
    assert.equal((bodyAll('[data-key="maren-kest"] textarea')[0] as HTMLTextAreaElement).value, STORM.prompt);
    assert.match(text(bodyAll('[data-key="maren-kest"] [data-testid="look-state"]')[0]), /full body, close/);
    assert.equal(bodyAll('[data-key="maren-kest"] [data-testid="look-make-close"]').length, 0, "it has a close view");
    assert.match(text(bodyAll('[data-testid="look-summary"]')[0]), /1 look chosen/);
  });

  it("chooses a look on a press, and the main photo takes the choice away", async () => {
    const m = await mount(LOOK());
    await press(tiles()[1]);
    const chose = sentOf(m, "choose-audiobook-look")[0]!;
    assert.deepEqual([chose.productionId, chose.chapterFile, chose.key, chose.sheet, chose.lookId], ["saltlight", "07-the-tenth-key", "maren-kest", "maren-kest", STORM.id]);
    await press(tiles()[0]);
    assert.equal(sentOf(m, "choose-audiobook-look")[1]!.lookId, null);
  });

  it("names the chapters that chose each look, asked of the coordinator when the sheet opens", async () => {
    const m = await mount(LOOK());
    const asked = sentOf(m, "read-audiobook-looks")[0];
    assert.ok(asked, "the usage is asked for");
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.looks", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, productionId: "saltlight", usage: { [STORM.id]: [5, 3] } } as DomainEvent));
    assert.equal(text(bodyAll('[data-key="maren-kest"] [data-testid="look-usage"]')[0]), "chapters 3, 5");
    assert.equal(bodyAll('[data-key="maren-kest"] [data-testid="look-usage"]').length, 1, "a look no chapter chose says nothing");
  });

  it("says where a carried choice came from, by the chapter's number", async () => {
    const carried = { ...state(), world: { ...state().world!, productions: state().world!.productions.map((p) => (p.meta.id === "saltlight" ? { ...p, chapters: [...p.chapters, { ...p.chapters[0]!, id: "03-the-stair", file: "03-the-stair", order: 3 }] } : p)) } } as ClientState;
    await mount(LOOK({ text: STORM.prompt, lookId: STORM.id, from: "03-the-stair" }), carried);
    assert.equal(text(bodyAll('[data-key="maren-kest"] [data-testid="look-from"]')[0]), "from chapter 3");
  });

  it("marks a look made from a face the character no longer has", async () => {
    await mount(LOOK({ text: HARBOUR.prompt, lookId: HARBOUR.id }));
    assert.equal(text(bodyAll('[data-key="maren-kest"] [data-testid="look-older"]')[0]), "older face");
  });

  it("draws a conflict between the chapter and the look as a row with Make again, and never as words in the line", async () => {
    const m = await mount(LOOK({ text: STORM.prompt, lookId: STORM.id, conflicts: [{ kind: "chapter", part: "Hood", a: "down", b: "up" }] }));
    const row = bodyAll('[data-key="maren-kest"] [data-testid="look-conflict"]')[0]!;
    assert.equal(text(row), "Hoodchapter down · look upMake again");
    assert.equal((bodyAll('[data-key="maren-kest"] textarea')[0] as HTMLTextAreaElement).value, STORM.prompt, "the line is the look's, not the chapter's");
    await press(bodyAll('[data-testid="look-conflict-make"]')[0]);
    assert.ok(bodyAll('[data-testid="new-look-sheet"]')[0], "Make again opens the sheet to make the look again");
    assert.equal((bodyAll('[data-testid="new-look-clothing"]')[0] as HTMLTextAreaElement).value, STORM.prompt);
    assert.equal(sentOf(m, "generate-character-looks").length, 0, "nothing is made until Make");
  });
});

describe("making a look from the sheet", () => {
  it("shows Make a look for a character with none, and opens the sheet with the chapter's line", async () => {
    await mount(LOOK(), state([]));
    assert.equal(text(bodyAll('[data-key="maren-kest"] [data-testid="look-new"]')[0]), "Make a look");
    assert.match(text(bodyAll('[data-key="maren-kest"] [data-testid="look-state"]')[0]), /head and shoulders · no look/);
    await press(bodyAll('[data-key="maren-kest"] [data-testid="look-new"]')[0]);
    assert.equal(bodyAll('[data-testid="look-sheet"]').length, 0, "the Looks gives way while a look is made");
    assert.equal((bodyAll('[data-testid="new-look-clothing"]')[0] as HTMLTextAreaElement).value, "Oilskin coat, dark and stiff with salt.");
    await press(bodyAll('[data-testid="new-look-cancel"]')[0]);
    assert.ok(bodyAll('[data-testid="look-sheet"]')[0], "Cancel returns to the Looks");
  });

  it("keeps the Codex allowance on the close-view authorization button", async () => {
    const current = state();
    const codex: ManifestModel = { ...GPT, id: "codex-image", provider: "codex", displayName: "Codex Image", pricing: { kind: "included-plan" } };
    current.app.manifest = { ...current.app.manifest!, models: [...current.app.manifest!.models, codex] };
    current.app.routing = { ...current.app.routing, defaults: { ...current.app.routing.defaults, image: codex.id } };
    current.app.providers = [...current.app.providers.filter(p => p.id !== "codex"), { id: "codex", configured: true, validation: "valid", probes: [{ capability: "image", available: true }], fault: null }];
    await mount(LOOK({ text: HARBOUR.prompt, lookId: HARBOUR.id }), current);
    const label = text(bodyAll('[data-testid="look-make-close"]')[0]);
    assert.match(label, /Make close view · ChatGPT plan · uses Codex allowance/);
    assert.doesNotMatch(label, /free|\$0/);
  });

  it("offers Make close view on a look that has none, asks once, and files the close view it gets on that look", async () => {
    const m = await mount(LOOK({ text: HARBOUR.prompt, lookId: HARBOUR.id }));
    const make = bodyAll('[data-testid="look-make-close"]')[0]!;
    assert.match(text(make), /^Make close view · ~\$0\.04$/);
    await press(make);
    const asked = sentOf(m, "generate-character-looks")[0]!;
    assert.deepEqual([asked.framing, asked.count, asked.closeOf, asked.sheetId], ["close", 1, { lookId: HARBOUR.id }, "maren-kest"]);
    assert.equal(text(bodyAll('[data-testid="look-make-close"]')[0]), "Making close view…");
    assert.equal((bodyAll('[data-testid="look-make-close"]')[0] as HTMLButtonElement).disabled, true);
    // The picture arrives as a pending look take of the close view for this look.
    const arrived = { id: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2H1", coversShots: [], kind: "look", reference: { sheetId: "maren-kest" }, provider: "openai", model: "gpt-image-2", provenance: { canonRevision: 1, sheets: {} }, references: [], params: { lookFraming: "close", lookOfLook: HARBOUR.id }, cost: { estimatedMicroUsd: 0, actualMicroUsd: null }, dispatchedAt: AT, media: "close.png" } as unknown as Take;
    const root = open[0]!.root;
    await act(async () => {
      __setStateForTest(state([STORM, HARBOUR], [arrived]), { connection: "open" });
      root.render(<LookSheet open onClose={() => {}} worldId={FIXTURE_WORLD_ID} productionId="saltlight" chapterFile="07-the-tenth-key" chapterOrder={7} record={record(LOOK({ text: HARBOUR.prompt, lookId: HARBOUR.id }))} blockKeys={KEYS} />);
    });
    await press(bodyAll('[data-testid="look-accept-close"]')[0]);
    const accept = sentOf(m, "accept-character-look")[0]!;
    assert.deepEqual([accept.sheetId, accept.takeId, accept.closeFor], ["maren-kest", arrived.id, HARBOUR.id]);
  });

  it("is read-only while the coordinator is away", async () => {
    await mount(LOOK(), state(), "closed");
    assert.ok(tiles().every((tile) => (tile as HTMLButtonElement).disabled));
    assert.equal((bodyAll('[data-testid="look-derive"]')[0] as HTMLButtonElement).disabled, true);
  });
});

/** A look job as the queue holds it. */
const job = (id: string, params: Record<string, unknown>, status: "queued" | "running" | "succeeded" | "failed", error: string | null = null) =>
  ({ id: `jb_${id}`, target: { kind: "character-look", id: "maren-kest/x/1" }, params, status, error, createdAt: AT, updatedAt: AT }) as never;
const withJobs = (world: ClientState, jobs: unknown[]): ClientState => ({ ...world, app: { ...world.app, jobs: jobs as ClientState["app"]["jobs"] } });
const SAFETY = "openai: the safety system refused the prompt (moderation blocked) — recompose the prompt away from what it flagged and try again";
async function rerender(m: Mounted, world: ClientState, look: ChapterAudiobook["look"], updatedAt = AT) {
  await act(async () => {
    __setStateForTest(world, { connection: "open" });
    m.root.render(<LookSheet open onClose={() => {}} worldId={FIXTURE_WORLD_ID} productionId="saltlight" chapterFile="07-the-tenth-key" chapterOrder={7} record={{ ...record(look), updatedAt }} blockKeys={KEYS} />);
  });
}

describe("a choice shows at once (2026-10-04, 0.5.60-local.14)", () => {
  it("rings the look pressed, counts it and says saving before the record comes back, then saved", async () => {
    const m = await mount(LOOK());
    await press(tiles()[1]);
    assert.equal(tiles()[1]!.getAttribute("aria-selected"), "true", "the look pressed is ringed at once");
    assert.match(text(bodyAll('[data-key="maren-kest"] [data-testid="look-state"]')[0]), /full body, close/);
    assert.equal((bodyAll('[data-key="maren-kest"] textarea')[0] as HTMLTextAreaElement).value, "Storm coat, hood up; two braids.", "the look's own line");
    assert.match(text(bodyAll('[data-testid="look-summary"]')[0]), /1 look chosen · derived · saving…/);
    const chose = sentOf(m, "choose-audiobook-look")[0]!;
    const written = LOOK({ text: STORM.prompt, lookId: STORM.id, reading: "Oilskin coat, dark and stiff with salt." });
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.record", worldId: FIXTURE_WORLD_ID, productionId: "saltlight", chapterId: "07-the-tenth-key", requestId: chose.requestId, record: { ...record(written), updatedAt: "2026-10-04T09:00:05.000Z" } }));
    assert.match(text(bodyAll('[data-testid="look-summary"]')[0]), /1 look chosen · derived · saved/, "its own answer settles it, before the chapter view hands the record down");
    assert.equal(tiles()[1]!.getAttribute("aria-selected"), "true");
    await rerender(m, state(), written, "2026-10-04T09:00:05.000Z");
    assert.match(text(bodyAll('[data-testid="look-summary"]')[0]), /1 look chosen · derived · saved/);
  });

  it("settles a press the record shows even when its own answer was replaced by a later one", async () => {
    const m = await mount(LOOK());
    await press(tiles()[1]);
    assert.match(text(bodyAll('[data-testid="look-summary"]')[0]), /saving…/);
    await rerender(m, state(), LOOK({ text: STORM.prompt, lookId: STORM.id }), "2026-10-04T09:00:05.000Z");
    assert.match(text(bodyAll('[data-testid="look-summary"]')[0]), /1 look chosen · derived · saved/);
  });

  it("puts a refused choice back, with the reason", async () => {
    const m = await mount(LOOK());
    await press(tiles()[1]);
    const chose = sentOf(m, "choose-audiobook-look")[0]!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.record", worldId: FIXTURE_WORLD_ID, productionId: "saltlight", chapterId: "07-the-tenth-key", requestId: chose.requestId, refused: "that look is gone" }));
    assert.equal(tiles()[0]!.getAttribute("aria-selected"), "true", "the main photo rides again");
    assert.equal(text(bodyAll('[data-testid="look-refused"]')[0]), "that look is gone");
    assert.match(text(bodyAll('[data-testid="look-summary"]')[0]), /0 looks chosen · derived · saved/);
  });
});

describe("the close view, once asked for (2026-10-04)", () => {
  const chosenHarbour = () => LOOK({ text: HARBOUR.prompt, lookId: HARBOUR.id });

  it("says the provider refused it, in plain words, and offers Try again at the price, never a spinner", async () => {
    const m = await mount(chosenHarbour());
    await press(bodyAll('[data-testid="look-make-close"]')[0]);
    const asked = sentOf(m, "generate-character-looks")[0]!;
    assert.equal(asked.prompt, "Harbour coat, bare head.", "the look's clothing line");
    await rerender(m, withJobs(state(), [job("01J8Z3X4Y5Z6A7B8C9D0E1F2J1", { lookFraming: "close", lookOfLook: HARBOUR.id, lookBatch: asked.requestId }, "running")]), chosenHarbour());
    assert.equal(text(bodyAll('[data-testid="look-make-close"]')[0]), "Making close view…");
    await rerender(m, withJobs(state(), [job("01J8Z3X4Y5Z6A7B8C9D0E1F2J1", { lookFraming: "close", lookOfLook: HARBOUR.id, lookBatch: asked.requestId }, "failed", SAFETY)]), chosenHarbour());
    assert.equal(bodyAll('[data-testid="look-make-close"]').length, 0, "no spinner on a job that ended");
    assert.equal(text(bodyAll('[data-testid="look-close-reason"]')[0]), "Close view refused by the image safety check");
    assert.equal(text(bodyAll('[data-testid="look-close-retry"]')[0]), "Try again · ~$0.04");
    await press(bodyAll('[data-testid="look-close-retry"]')[0]);
    assert.equal(sentOf(m, "generate-character-looks").length, 2, "asked again");
    assert.equal(text(bodyAll('[data-testid="look-make-close"]')[0]), "Making close view…", "the new request is being made");
  });

  it("offers no paid Try again for a close view made and paid for whose filing failed", async () => {
    await mount(chosenHarbour(), withJobs(state(), [{ ...(job("01J8Z3X4Y5Z6A7B8C9D0E1F2J1", { lookFraming: "close", lookOfLook: HARBOUR.id }, "succeeded") as object), finalization: { status: "failed", error: "disk full", updatedAt: AT } }]));
    assert.equal(text(bodyAll('[data-testid="look-close-reason"]')[0]), "Close view made, not filed · see Activity");
    assert.equal(bodyAll('[data-testid="look-close-retry"]').length, 0, "Activity retries it at no charge");
  });

  it("shows a refusal from an earlier opening of the sheet too", async () => {
    await mount(chosenHarbour(), withJobs(state(), [job("01J8Z3X4Y5Z6A7B8C9D0E1F2J1", { lookFraming: "close", lookOfLook: HARBOUR.id, lookBatch: "an-earlier-request" }, "failed", SAFETY)]));
    assert.equal(text(bodyAll('[data-testid="look-close-reason"]')[0]), "Close view refused by the image safety check");
  });

  const arrived = { id: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2H1", coversShots: [], kind: "look", reference: { sheetId: "maren-kest" }, provider: "openai", model: "gpt-image-2", provenance: { canonRevision: 1, sheets: {} }, references: [], params: { lookFraming: "close", lookOfLook: HARBOUR.id }, cost: { estimatedMicroUsd: 0, actualMicroUsd: null }, dispatchedAt: AT, media: "close.png" } as unknown as Take;

  it("offers Discard and Make again on a close view not yet accepted", async () => {
    const m = await mount(chosenHarbour(), state([STORM, HARBOUR], [arrived]));
    assert.ok(bodyAll('[data-testid="look-accept-close"]')[0]);
    await press(bodyAll('[data-testid="look-close-discard"]')[0]);
    const rejected = sentOf(m, "reject-reference-take")[0]!;
    assert.equal(rejected.takeId, arrived.id);
    assert.equal(bodyAll('[data-testid="look-close-made"]').length, 0, "gone at once");
    assert.match(text(bodyAll('[data-testid="look-make-close"]')[0]), /^Make close view/);
    assert.equal(sentOf(m, "generate-character-looks").length, 0, "Discard makes nothing");
  });

  it("makes the close view again, the one shown discarded first", async () => {
    const m = await mount(chosenHarbour(), state([STORM, HARBOUR], [arrived]));
    assert.equal(text(bodyAll('[data-testid="look-close-again"]')[0]), "Make again · ~$0.04");
    await press(bodyAll('[data-testid="look-close-again"]')[0]);
    assert.equal(sentOf(m, "reject-reference-take")[0]!.takeId, arrived.id);
    const asked = sentOf(m, "generate-character-looks")[0]!;
    assert.deepEqual([asked.framing, asked.closeOf], ["close", { lookId: HARBOUR.id }]);
    assert.equal(text(bodyAll('[data-testid="look-make-close"]')[0]), "Making close view…");
  });

  it("shows a close view accepted at once, before the kit says so", async () => {
    const m = await mount(chosenHarbour(), state([STORM, HARBOUR], [arrived]));
    await press(bodyAll('[data-testid="look-accept-close"]')[0]);
    assert.equal(sentOf(m, "accept-character-look")[0]!.closeFor, HARBOUR.id);
    assert.match(text(bodyAll('[data-key="maren-kest"] [data-testid="look-state"]')[0]), /full body, close/);
    assert.ok(bodyAll('[data-testid="look-close-accepted"]')[0]);
    assert.equal(bodyAll('[data-testid="look-accept-close"]').length, 0);
  });

  it("offers the close view again when the snapshot after Accept has no close view on the look", async () => {
    const m = await mount(chosenHarbour(), state([STORM, HARBOUR], [arrived]));
    await press(bodyAll('[data-testid="look-accept-close"]')[0]);
    assert.ok(bodyAll('[data-testid="look-close-accepted"]')[0]);
    await rerender(m, state([STORM, HARBOUR], [arrived]), chosenHarbour());
    assert.equal(bodyAll('[data-testid="look-close-accepted"]').length, 0, "not saving for good");
    assert.ok(bodyAll('[data-testid="look-accept-close"]')[0], "Accept is there again");
  });

  it("clears an earlier refusal when a line is written again", async () => {
    const m = await mount(LOOK());
    const mood = bodyAll('[data-key="mood"] textarea')[0] as HTMLTextAreaElement;
    const type = async (words: string) => {
      const key = Object.keys(mood).find((candidate) => candidate.startsWith("__reactProps$"))!;
      const props = (mood as unknown as Record<string, { onChange: (e: unknown) => void; onBlur: () => void }>)[key]!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(mood), "value")?.set?.call(mood, words);
        props.onChange({ target: mood, currentTarget: mood });
      });
      await act(async () => (mood as unknown as Record<string, { onBlur: () => void }>)[key]!.onBlur());
    };
    await type("Grey dawn light.");
    const first = sentOf(m, "set-audiobook-look")[0]!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.record", worldId: FIXTURE_WORLD_ID, productionId: "saltlight", chapterId: "07-the-tenth-key", requestId: first.requestId, refused: "that is not a line the look can hold" }));
    assert.ok(bodyAll('[data-testid="look-refused"]')[0]);
    await type("Grey dawn light, fine grain.");
    assert.equal(bodyAll('[data-testid="look-refused"]').length, 0);
  });

  it("prices Make close view as the job is priced: one picture from two references", async () => {
    const REAL: ManifestModel = { ...GPT, pricing: { kind: "perImage", microUsdPerImage: 53_000, microUsdPerReferenceImage: 100_000 } };
    const world = state();
    await mount(chosenHarbour(), { ...world, app: { ...world.app, manifest: { ...world.app.manifest!, models: [...world.app.manifest!.models.filter((model) => model.id !== GPT.id), REAL] } } });
    assert.equal(estimateCharacterImageMicroUsd(REAL, "character-look", 1, 2), 253_000);
    assert.equal(text(bodyAll('[data-testid="look-make-close"]')[0]), "Make close view · ~$0.26");
  });
});

describe("the mood line", () => {
  it("is a row of its own, editable, written as the author's", async () => {
    const m = await mount(LOOK());
    const mood = bodyAll('[data-key="mood"] textarea')[0] as HTMLTextAreaElement;
    assert.equal(mood.value, "Teal water, amber lamplight; fine grain.");
    assert.match(text(bodyAll('[data-key="mood"]')[0]), /Mood.*from the art direction/);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(mood), "value")?.set;
      setter?.call(mood, "Grey dawn light.");
      const key = Object.keys(mood).find((candidate) => candidate.startsWith("__reactProps$"))!;
      (mood as unknown as Record<string, { onChange: (e: unknown) => void; onBlur: () => void }>)[key]!.onChange({ target: mood, currentTarget: mood });
    });
    await act(async () => {
      const key = Object.keys(mood).find((candidate) => candidate.startsWith("__reactProps$"))!;
      (mood as unknown as Record<string, { onBlur: () => void }>)[key]!.onBlur();
    });
    const set = sentOf(m, "set-audiobook-look")[0]!;
    assert.deepEqual([set.target, set.text], [{ kind: "mood" }, "Grey dawn light."]);
  });
});

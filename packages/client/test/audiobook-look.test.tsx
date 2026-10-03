import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ChapterAudiobook, ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { LookSheet, blocksLabel, lookCount, lookRows } from "../src/components/audiobook-look.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The look sheet (design turn 191c, SPEC-047 R-98): the place and each character's line, from the
 * prose, every line editable and the author's from then on; derived again on a press; saved.
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

const AT = "2026-10-03T09:00:00.000Z";
const KEYS = ["title", "p0.0", "p1.0", "p2.0"];
const record = (look: ChapterAudiobook["look"]): ChapterAudiobook => ({
  schemaVersion: 1, chapterVersion: 4, hash: "h", updatedAt: AT, flags: {}, direction: {}, takes: {},
  ...(look !== undefined ? { look } : {}),
});
const LOOK: NonNullable<ChapterAudiobook["look"]> = {
  chapterHash: "h",
  at: AT,
  place: { text: "The flooded quarter, dusk, a low salt haze.", blocks: ["p0.0"] },
  characters: {
    "maren-kest": { name: "Maren Kest", sheet: "maren-kest", text: "Oilskin coat, dark and stiff with salt.", blocks: ["p1.0", "p2.0"] },
    sereth: { name: "Sereth", text: "Harbour-master's blue greatcoat.", blocks: ["p2.0"], by: "author" },
  },
};

type Mounted = { root: Root; sent: ClientMessage[]; closed: () => boolean };
const open: Mounted[] = [];
const bodyAll = (selector: string) => [...dom.document.body.querySelectorAll(selector)] as HTMLElement[];
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const BRAY = { id: "bray-half-hitch", type: "character", name: "Bray Half-Hitch", billing: "support", version: 6, status: "locked", canonRules: [], links: [], created: "2026-05-04", updated: "2026-08-07", sections: [] };
async function mount(look: ChapterAudiobook["look"], connection: "open" | "closed" = "open"): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  let closed = false;
  await act(async () => {
    __setStateForTest({ ...FIXTURE_STATE, world: { ...FIXTURE_STATE.world!, sheets: [...FIXTURE_STATE.world!.sheets, BRAY as never] } }, { connection });
    root.render(<LookSheet open onClose={() => (closed = true)} worldId={FIXTURE_WORLD_ID} productionId="saltlight" chapterFile="07-the-tenth-key" chapterOrder={7} record={record(look)} blockKeys={KEYS} />);
  });
  const mounted = { root, sent, closed: () => closed };
  open.push(mounted);
  return mounted;
}
afterEach(async () => {
  for (const mounted of open.splice(0)) await act(async () => mounted.root.unmount());
  dom.document.body.innerHTML = "";
});
const press = async (el: Element | null | undefined) => {
  assert.ok(el, "the thing to press exists");
  await act(async () => void el.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
};
/** The props React holds for an element: linkedom raises no input or blur event React listens for. */
type Handlers = { onChange?: (event: { target: unknown; currentTarget: unknown }) => void; onBlur?: () => void };
const handlers = (el: Element): Handlers => {
  const key = Object.keys(el).find((candidate) => candidate.startsWith("__reactProps$"));
  return key === undefined ? {} : (el as unknown as Record<string, Handlers>)[key]!;
};
const type = async (el: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    handlers(el).onChange?.({ target: el, currentTarget: el });
  });
};
const leave = async (el: Element) => act(async () => void handlers(el).onBlur?.());
const sentOf = <K extends ClientMessage["kind"]>(m: Mounted, kind: K) => m.sent.filter((message): message is Extract<ClientMessage, { kind: K }> => message.kind === kind);

describe("the rows the sheet draws (R-98)", () => {
  it("says which blocks a line comes from by the numbers the margin shows, and who wrote it", () => {
    const rows = lookRows(LOOK, (key) => (KEYS.indexOf(key) < 0 ? null : KEYS.indexOf(key) + 1));
    assert.deepEqual(rows.map((row) => [row.label, row.source]), [[null, "from the prose"], ["Maren Kest", "blocks 3, 4"], ["Sereth", "block 4 · yours"]]);
    assert.equal(blocksLabel(["nowhere"], () => null), null);
    assert.equal(lookCount(LOOK), "2 characters");
    assert.equal(lookCount(null), "not read");
  });
});

describe("the look sheet", () => {
  it("is drawn on the body with the place, each character and what the look is", async () => {
    await mount(LOOK);
    const sheet = bodyAll('[data-testid="look-sheet"]')[0];
    assert.ok(sheet, "the sheet is on the body");
    assert.equal(bodyAll(".ui-textarea").length, 3);
    assert.match(text(sheet), /Place/);
    assert.match(text(sheet), /Maren Kest/);
    assert.match(text(sheet), /2 characters · edited · saved\s*used by every picture in this chapter/);
    assert.equal(text(bodyAll('[data-testid="look-derive"]')[0]), "Derive again");
  });

  it("writes a line as the author's when its words changed on leaving the field, and writes nothing when they did not", async () => {
    const m = await mount(LOOK);
    const line = bodyAll('[data-key="maren-kest"] textarea')[0] as HTMLTextAreaElement;
    await leave(line);
    assert.equal(sentOf(m, "set-audiobook-look").length, 0, "unchanged words are not a write");
    await type(line, "Her father's reefer jacket.");
    await leave(line);
    const set = sentOf(m, "set-audiobook-look")[0];
    assert.deepEqual([set?.target, set?.text], [{ kind: "character", key: "maren-kest" }, "Her father's reefer jacket."]);
    const place = bodyAll('[data-key="place"] textarea')[0] as HTMLTextAreaElement;
    await type(place, "   ");
    await leave(place);
    assert.deepEqual([sentOf(m, "set-audiobook-look")[1]?.target, sentOf(m, "set-audiobook-look")[1]?.text], [{ kind: "place" }, null], "an emptied field takes the line away");
  });

  it("derives on a press and says it is reading, then takes the answer", async () => {
    const m = await mount(undefined);
    assert.equal(text(bodyAll('[data-testid="look-none"]')[0]), "not read");
    assert.equal(text(bodyAll('[data-testid="look-derive"]')[0]), "Derive");
    await press(bodyAll('[data-testid="look-derive"]')[0]);
    const asked = sentOf(m, "derive-audiobook-look")[0];
    assert.ok(asked, "the coordinator is asked");
    assert.equal(text(bodyAll('[data-testid="look-derive"]')[0]), "Reading…");
    assert.equal((bodyAll('[data-testid="look-derive"]')[0] as HTMLButtonElement).disabled, true);
    // The coordinator answers under the request's own id with why not.
    const answer: DomainEvent = { at: AT, type: "audiobook.record", worldId: FIXTURE_WORLD_ID, productionId: "saltlight", chapterId: "07-the-tenth-key", requestId: asked.requestId, refused: "the writing service is not running" } as DomainEvent;
    await act(async () => __applyEventForTest(answer));
    assert.equal(text(bodyAll('[data-testid="look-refused"]')[0]), "the writing service is not running");
    assert.equal(text(bodyAll('[data-testid="look-derive"]')[0]), "Derive");
  });

  it("offers a character the look missed, by name, and writes it under their sheet", async () => {
    const m = await mount(LOOK);
    const add = bodyAll('[data-testid="look-add"]')[0] as HTMLSelectElement | undefined;
    assert.ok(add, "the add control is there while a sheet has no line");
    assert.ok(![...add.querySelectorAll("option")].some((option) => option.value === "maren-kest"), "a character with a line is not offered again");
    const options = [...add.querySelectorAll("option")].map((option) => option.value).filter((value) => value !== "");
    assert.deepEqual(options, ["bray-half-hitch"]);
    await act(async () => void handlers(add).onChange?.({ target: { value: options[0]! }, currentTarget: add }));
    const added = bodyAll(`[data-key="${options[0]}"] textarea`)[0] as HTMLTextAreaElement;
    assert.ok(added, "a row opens for them");
    await type(added, "A wet cap.");
    await leave(added);
    const set = sentOf(m, "set-audiobook-look")[0];
    assert.equal(set?.target.kind, "character");
    assert.equal(set?.text, "A wet cap.");
    if (set?.target.kind === "character") assert.equal(set.target.sheet, options[0]);
  });

  it("is read-only while the coordinator is away and closes on Done", async () => {
    const m = await mount(LOOK, "closed");
    assert.equal((bodyAll('[data-key="maren-kest"] textarea')[0] as HTMLTextAreaElement).disabled, true);
    assert.equal((bodyAll('[data-testid="look-derive"]')[0] as HTMLButtonElement).disabled, true);
    await press(bodyAll('[data-testid="look-done"]')[0]);
    assert.equal(m.closed(), true);
  });
});

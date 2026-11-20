import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { ONE_IMAGE_ONLY, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { __applyEventForTest, __characterSheetAcceptanceForTest, __mainPhotoAcceptanceForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CharacterReferenceScreen, ReplaceMainPhotoScreen } from "../src/screens/character-reference.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A sheet's main photo and character sheet from a picture already in hand (issue 3146): a file
 * dropped on either slot or in the main photo dialog goes out as the Upload button's own import,
 * and a picture already in this world or another can be the photo itself — through a picker kept
 * apart from the one that stages a reference for a generated portrait.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }), innerWidth: 1400, innerHeight: 900 });
Object.assign(dom.HTMLElement.prototype, { showModal() {}, close() {}, focus() {}, scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

type Sent = ClientMessage & { sourcePath?: string };
const WORLD = FIXTURE_STATE.world!.meta.worldId;
const OTHER = { ...FIXTURE_STATE.worlds[0]!, worldId: "01J8F3K2QW9VZX4N7M0RTYB61A", slug: "lagos-nights", name: "Lagos Nights" };

/**
 * The desktop bridge as the preload is: the renderer hands over File objects, and the host sends
 * the import with the path it resolved for each one. The path here is a stand-in for that.
 */
function host(sent: Sent[]) {
  return {
    appVersion: "test", platform: "test", connect() {}, subscribe() {},
    send: (json: string) => sent.push(JSON.parse(json) as Sent),
    attachDropped: (target: object, files: readonly File[]) => {
      for (const file of files) sent.push({ ...target, sourcePath: `C:/dropped/${file.name}` } as Sent);
      return { filed: files.length, unresolved: [] };
    },
    attachBytes: async () => ({ ok: true as const }),
  } as unknown as NonNullable<Window["arke"]>;
}

let root: Root | undefined;
let container: HTMLElement;

async function mount(path: string, state: ClientState = FIXTURE_STATE): Promise<Sent[]> {
  const sent: Sent[] = [];
  const bridge = host(sent);
  Object.assign(window, { arke: bridge });
  __setBridgeForTest(bridge);
  __setStateForTest({ ...state, worlds: [state.worlds[0]!, OTHER] }, { connection: "open" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/w/:worldId/cast/:sheetId/kit" element={<CharacterReferenceScreen />} />
        <Route path="/w/:worldId/cast/:sheetId/main-photo" element={<ReplaceMainPhotoScreen />} />
      </Routes>
    </MemoryRouter>,
  ));
  return sent;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  Reflect.deleteProperty(window, "arke");
  __setBridgeForTest(null);
  document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
});

function reactProps(element: Element): Record<string, (event: unknown) => void> {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"));
  assert.ok(key, "the element is React's");
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key]!;
}

/** A drag carrying files, as the browser stages it. */
function drag(files: File[]) {
  return {
    preventDefault() {}, stopPropagation() {},
    dataTransfer: { types: ["Files"], files, dropEffect: "none" },
  };
}

const portrait = () => new File(["bytes"], "timi-main.png", { type: "image/png" });

async function drop(element: Element, files: File[]): Promise<void> {
  await act(async () => reactProps(element)["onDragEnter"]!(drag(files)));
  await act(async () => reactProps(element)["onDrop"]!(drag(files)));
}

/** Anywhere on the page: a sheet is drawn on the body, outside the screen's own container. */
function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find((node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label);
  assert.ok(found, `a button named ${label}`);
  return found;
}

const cards = () => [...container.querySelectorAll("section.fy-reference-card")];

/** The picker's browse request, answered with one picture from wherever it asked. */
async function answerBrowse(sent: Sent[], file: string, name: string): Promise<void> {
  const ask = sent.filter((message) => message.kind === "browse-reference-images").at(-1);
  assert.ok(ask && ask.kind === "browse-reference-images", "the picker asked for the pictures");
  await act(async () => __applyEventForTest({ type: "reference.images", at: "2026-11-15T12:00:00Z", requestId: ask.requestId,
    slug: ask.slug, images: [{ file, name, role: "identity", group: "Cast" }] }));
}

async function browseOtherWorld(): Promise<void> {
  const select = document.body.querySelector<HTMLSelectElement>('select[aria-label="Browse images"]')!;
  assert.ok(select);
  await act(async () => {
    Object.defineProperty(select, "value", { configurable: true, value: OTHER.slug });
    select.dispatchEvent(new dom.Event("change", { bubbles: true }));
  });
}

describe("a file dropped on the Reference tab (issue 3146)", () => {
  it("sends a file dropped on the Main photo slot as the Upload button's import, and holds the button", async () => {
    const sent = await mount(`/w/${WORLD}/cast/maren-kest/kit`);
    const [photo] = cards();
    await act(async () => reactProps(photo!)["onDragEnter"]!(drag([portrait()])));
    assert.match(photo!.querySelector('[data-testid="file-dropzone"]')?.textContent ?? "", /Drop to upload/);
    await act(async () => reactProps(photo!)["onDrop"]!(drag([portrait()])));
    assert.equal(photo!.querySelector('[data-testid="file-dropzone"]'), null, "the target clears on drop");
    const imported = sent.filter((message) => message.kind === "import-main-photo");
    assert.deepEqual(imported, [{ kind: "import-main-photo", worldId: WORLD, sheetId: "maren-kest", sourcePath: "C:/dropped/timi-main.png" }]);
    assert.equal(__mainPhotoAcceptanceForTest()["maren-kest"]?.status, null, "in flight until the coordinator answers");
    assert.equal(button("Uploading…").disabled, true);
  });

  it("sends a file dropped on the Character sheet slot as the sheet's upload", async () => {
    const sent = await mount(`/w/${WORLD}/cast/maren-kest/kit`);
    await drop(cards()[1]!, [portrait()]);
    assert.deepEqual(sent.filter((message) => message.kind === "import-character-sheet"),
      [{ kind: "import-character-sheet", worldId: WORLD, sheetId: "maren-kest", sourcePath: "C:/dropped/timi-main.png" }]);
    assert.equal(__characterSheetAcceptanceForTest()["maren-kest"]?.status, null);
  });

  it("refuses two pictures dropped on one slot, in the Upload button's words, and sends nothing", async () => {
    const sent = await mount(`/w/${WORLD}/cast/maren-kest/kit`);
    await drop(cards()[1]!, [portrait(), new File(["more"], "second.png", { type: "image/png" })]);
    assert.equal(sent.some((message) => message.kind === "import-character-sheet"), false);
    assert.equal(__characterSheetAcceptanceForTest()["maren-kest"]?.reason, ONE_IMAGE_ONLY);
    assert.ok(container.textContent?.includes(ONE_IMAGE_ONLY), "said under the card");
  });

  it("does not take a drop where there is no host to say where the file is", async () => {
    await mount(`/w/${WORLD}/cast/maren-kest/kit`);
    __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send() {} });
    await act(async () => __setStateForTest({ ...FIXTURE_STATE, worlds: [FIXTURE_STATE.worlds[0]!, OTHER] }, { connection: "open" }));
    assert.equal(reactProps(cards()[0]!)["onDrop"], undefined, "not a drop target");
  });
});

describe("the main photo dialog (issue 3146)", () => {
  it("is titled for what it is, and names the world look for what it is", async () => {
    const empty = structuredClone(FIXTURE_STATE);
    empty.world!.referenceKits = [];
    await mount(`/w/${WORLD}/cast/maren-kest/main-photo`, empty);
    assert.equal(container.querySelector("h2")?.textContent, "Main photo", "nothing to replace yet");
    assert.ok(button("World look"));
    assert.equal(container.textContent?.includes("From world"), false);
    assert.equal(container.querySelector('[data-tip="Replacing the main photo makes the current character sheet stale."]'), null,
      "no replacement to warn about");
  });

  it("says Replace once there is a main photo", async () => {
    await mount(`/w/${WORLD}/cast/maren-kest/main-photo`);
    assert.equal(container.querySelector("h2")?.textContent, "Replace main photo");
  });

  it("adds a file dropped on the dialog to the previews, as its Upload does", async () => {
    const sent = await mount(`/w/${WORLD}/cast/maren-kest/main-photo`);
    await drop(container.querySelector("dialog")!, [portrait()]);
    assert.deepEqual(sent.filter((message) => message.kind === "import-main-photo-candidate"),
      [{ kind: "import-main-photo-candidate", worldId: WORLD, sheetId: "maren-kest", sourcePath: "C:/dropped/timi-main.png" }]);
  });

  it("uses another world's picture as the photo itself, not as a reference", async () => {
    const sent = await mount(`/w/${WORLD}/cast/maren-kest/main-photo`);
    await act(async () => button("Choose a picture").click());
    assert.match(container.querySelector('[data-testid="reference-picker"] h2')?.textContent ?? "", /Use a picture as the main photo/);
    await browseOtherWorld();
    await answerBrowse(sent, "references/timi-j/main-photo.png", "Timi J · Main photo");
    const tile = container.querySelector<HTMLButtonElement>('[data-testid="picker-tile"]')!;
    assert.match(tile.textContent ?? "", /from Lagos Nights/);
    await act(async () => tile.click());
    await act(async () => button("Add to previews").click());
    assert.deepEqual(sent.filter((message) => message.kind === "import-main-photo-candidate"), [{
      kind: "import-main-photo-candidate", worldId: WORLD, sheetId: "maren-kest",
      image: { slug: OTHER.slug, path: "references/timi-j/main-photo.png" },
    }]);
    assert.equal(sent.some((message) => message.kind === "pick-staged-reference"), false, "nothing was staged as a reference");
    assert.equal(container.querySelector('[data-testid="reference-picker"]'), null, "back to the dialog, where it lands among the previews");
  });
});

describe("the character sheet from a picture already in the studio (issue 3146)", () => {
  it("designates a picture from this world as the sheet itself", async () => {
    const sent = await mount(`/w/${WORLD}/cast/maren-kest/kit`);
    await act(async () => button("Choose a picture").click());
    const sheet = document.body.querySelector(".fy-picture-sheet");
    assert.ok(sheet, "in a sheet of its own, the card having no dialog to lend it");
    assert.match(sheet.querySelector('[data-testid="reference-picker"] h2')?.textContent ?? "", /Use a picture as the character sheet/);
    assert.equal(sheet.querySelector(".fy-refpicker__capacity"), null, "budgeted against no model: it is not a reference");
    await answerBrowse(sent, "references/maren-kest/model-sheet-v4.png", "Maren Kest · Character sheet");
    await act(async () => sheet.querySelector<HTMLButtonElement>('[data-testid="picker-tile"]')!.click());
    await act(async () => button("Use as character sheet").click());
    assert.deepEqual(sent.filter((message) => message.kind === "import-character-sheet"), [{
      kind: "import-character-sheet", worldId: WORLD, sheetId: "maren-kest",
      image: { slug: FIXTURE_STATE.worlds[0]!.slug, path: "references/maren-kest/model-sheet-v4.png" },
    }]);
    assert.equal(__characterSheetAcceptanceForTest()["maren-kest"]?.status, null, "in flight, like an upload");
    assert.equal(document.body.querySelector(".fy-picture-sheet"), null, "and the sheet is put away");
  });
});

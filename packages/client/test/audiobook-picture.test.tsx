import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { audiobookTextHash, kitLookLibrary, lookDigest, pictureBench, pictureLookFor, type ArtifactSidecar, type ChapterAudiobook, type ClientMessage, type ClientState, type ManifestModel, type PictureShot, type PictureSuggestion, type ProductionBundle } from "@arke-studio/contracts";
import { BlockPicturePanel, pictureBrief, picturesByTab, useChapterPictures } from "../src/components/audiobook-picture.js";
import { frameViewWord, ridesLabel } from "../src/components/audiobook-picture-card.js";
import { AudiobookBlocks, type BlockRow } from "../src/screens/chapter-audiobook.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest, useStore } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Pictures on blocks (design turn 186c, SPEC-047 R-69): a block's panel gains Picture — chosen
 * from what the world holds by tab, or generated through the Bench — and the margin shows the
 * picture and when it starts, how long it holds, and a hold under twenty seconds flagged.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1600, innerHeight: 1000 });
// Chromium 150 (Electron 43) answers scrollIntoView with a Promise: an effect that returned it
// handed React a cleanup that is not a function, and putting the look menu away blanked the screen.
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView: () => Promise.resolve() });
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
const artifact = (id: string, file: string, extra: Partial<ArtifactSidecar> = {}): ArtifactSidecar =>
  ({ id, kind: "image", file, hash: "sha256:0", origin: { by: "user" }, links: [], created: AT, ...extra }) as ArtifactSidecar;
const take = (id: string, seconds: number) =>
  ({ id, kind: "audio", file: `${id}.wav`, hash: "sha256:0", origin: { by: "system" }, links: [], created: AT, mediaInfo: { durationSec: seconds } }) as unknown as ArtifactSidecar;

const TEXTS = ["Chapter 7 · The Tenth Key", "The bell under the harbour rang twice.", "Odile did not answer.", "Below them the quarter opened."];
const SECONDS = [4, 30, 10, 40];
const rows: BlockRow[] = TEXTS.map((text, index) => ({
  block: { key: index === 0 ? "title" : `p${index - 1}.0`, paragraph: index - 1, text },
  state: "made",
  mark: index === 0 ? "title" : "narrator",
  markWarn: false,
  assigned: { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george" },
  speaker: { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george" },
  artifact: take(`ar_take${index}`, SECONDS[index]!),
  speakerKey: null,
  colour: null,
  recorded: false,
  byPerson: false,
  direction: null,
  held: [],
  sentAs: null,
  byNarrator: true,
  readingHeld: [],
  proposed: null,
  turns: { parts: [{ text }] },
  split: null,
}) as unknown as BlockRow);
const record = (pictures: ChapterAudiobook["pictures"], look?: ChapterAudiobook["look"], ownLooks?: ChapterAudiobook["ownLooks"]): ChapterAudiobook => ({
  schemaVersion: 1, chapterVersion: 4, hash: "h", updatedAt: AT, flags: {}, direction: {},
  takes: Object.fromEntries(rows.map((row, index) => [row.block.key, { artifactId: `ar_take${index}`, textHash: audiobookTextHash(row.block.text), reader: { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george" }, format: "wav", characters: 1, parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0, madeAt: AT }])),
  ...(pictures !== undefined ? { pictures } : {}),
  ...(look !== undefined ? { look } : {}),
  ...(ownLooks !== undefined ? { ownLooks } : {}),
});

/** GPT Image 2 as the manifest prices it here: $0.045 a picture and $0.005 a reference. */
const GPT_IMAGE: ManifestModel = {
  id: "gpt-image-2", provider: "openai", capability: "image", displayName: "GPT Image 2",
  accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { aspects: ["16:9", "1:1"] },
  pricing: { kind: "perImage", microUsdPerImage: 45_000, microUsdPerReferenceImage: 5_000 },
} as unknown as ManifestModel;
/** Pictures a test adds to the world's artifacts: a made one with its Bench sidecar. */
let extraArtifacts: ArtifactSidecar[] = [];

function state(): ClientState {
  const world = FIXTURE_STATE.world!;
  return {
    ...FIXTURE_STATE,
    app: { ...FIXTURE_STATE.app, manifest: { ...FIXTURE_STATE.app.manifest!, models: [...FIXTURE_STATE.app.manifest!.models, GPT_IMAGE] } },
    world: {
      ...world,
      artifacts: [
        ...world.artifacts,
        artifact("ar_01J8G0000000000000000PICUP", "harbour-upload.png"),
        artifact("ar_01J8G0000000000000000PICGN", "bench-stair.png", { generation: { source: "bench" } } as unknown as Partial<ArtifactSidecar>),
        ...extraArtifacts,
        ...rows.map((row) => row.artifact!),
      ],
      // Maren's storm coat, with its close view (design turn 193c).
      referenceKits: world.referenceKits.map((kit) => (kit.sheetId === "maren-kest" ? ({ ...kit, looks: [STORM_LOOK, HARBOUR_LOOK] } as never) : kit)),
    },
  };
}
const STORM_LOOK = { name: "Storm coat", id: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2S1", file: "takes/tk_storm/storm.png", kind: "costume", prompt: "Storm coat, hood up; two braids.", acceptedAt: "2026-10-03T09:00:00.000Z", framing: "full-body", closeFile: "takes/tk_close/close.png" };
/** Her harbour coat (193d), made before the storm coat and with no close view. */
const HARBOUR_LOOK = { name: "Harbour coat", id: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2H1", file: "takes/tk_harbour/harbour.png", kind: "costume", prompt: "Harbour coat, brass buttons.", acceptedAt: "2026-10-02T09:00:00.000Z", framing: "full-body" };

type Mounted = { container: HTMLElement; root: Root; sent: ClientMessage[]; where: () => string };
const open: Mounted[] = [];
let location = "";
function Where() {
  location = useLocation().pathname;
  return null;
}
function Panel({ selected, pictures, look, own }: { selected: number; pictures?: ChapterAudiobook["pictures"]; look?: ChapterAudiobook["look"]; own?: ChapterAudiobook["ownLooks"] }) {
  const world = useStore().state?.world ?? null;
  const production = world?.productions.find((p) => p.meta.id === "saltlight") as ProductionBundle;
  const placed = useChapterPictures(world, rows, record(pictures, look, own));
  return (
    <>
      <AudiobookBlocks rows={rows} sounding={null} selected={rows[selected]!.block.key} onSelect={() => {}} onPlayOne={() => {}} slug="the-undersong" pictures={placed} />
      <BlockPicturePanel worldId={FIXTURE_WORLD_ID} production={production} chapterFile="07-the-tenth-key" chapterOrder={7} row={rows[selected]!} rows={rows} pictures={placed} record={record(pictures, look, own)} />
    </>
  );
}
/** The record as it comes back with the looks held on its blocks (design turn 193d, R-146): the panel is drawn again from it. */
let rerender: ((own: ChapterAudiobook["ownLooks"]) => Promise<void>) | null = null;
async function mount(selected: number, pictures?: ChapterAudiobook["pictures"], look?: ChapterAudiobook["look"], own?: ChapterAudiobook["ownLooks"]): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  const draw = (held: ChapterAudiobook["ownLooks"]) =>
    root.render(
      <MemoryRouter initialEntries={["/chapter"]}>
        <Where />
        <Routes>
          <Route path="/chapter" element={<Panel selected={selected} {...(pictures !== undefined ? { pictures } : {})} {...(look !== undefined ? { look } : {})} {...(held !== undefined ? { own: held } : {})} />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>,
    );
  await act(async () => {
    __setStateForTest(state(), { connection: "open" });
    draw(own);
  });
  rerender = async (held) => act(async () => draw(held));
  const mounted = { container, root, sent, where: () => location };
  open.push(mounted);
  return mounted;
}
afterEach(async () => {
  extraArtifacts = [];
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});
const q = (m: Mounted, selector: string) => m.container.querySelector(selector) as HTMLElement | null;
const all = (m: Mounted, selector: string) => [...m.container.querySelectorAll(selector)] as HTMLElement[];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const press = async (el: Element | null | undefined) => {
  assert.ok(el, "the thing to press exists");
  await act(async () => void el.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
};
const button = (m: Mounted, label: string) => all(m, "button").find((el) => text(el) === label);
/** A box ticked or cleared, as React hears it (linkedom's click does not change a checkbox). */
const tick = async (el: Element | null, checked: boolean) => {
  assert.ok(el, "the box exists");
  const props = (el as unknown as Record<string, { onChange: (event: { target: { checked: boolean } }) => void }>)[Object.keys(el).find((key) => key.startsWith("__reactProps$"))!]!;
  await act(async () => props.onChange({ target: { checked } }));
};
const chapterBox = (m: Mounted) => tick(q(m, '[data-testid="picture-card-look-chapter"]'), true);
const picture = (index: number, file: string) => ({ file, source: "world" as const, textHash: audiobookTextHash(TEXTS[index]!), at: AT });

describe("what a picture can be (turn 186c)", () => {
  it("offers the world's art and uploads, the cast and places, scenes' takes, and the Bench's pictures under Generate", () => {
    const tabs = picturesByTab(state().world!);
    assert.ok(tabs.world.some((reference) => reference.file === "world-art.png"), "the key art is the world's");
    assert.ok(tabs.world.some((reference) => reference.file === "artifacts/harbour-upload.png"), "an upload is the world's");
    assert.deepEqual(tabs.generated.map((reference) => reference.file), ["artifacts/bench-stair.png"]);
    assert.ok(tabs.cast.every((reference) => reference.group === "Cast" || reference.group === "Places"));
    assert.ok(tabs.scenes.every((reference) => reference.group === "Takes and stills"));
  });

  it("writes a generated picture's brief from the block's words and the book's look", () => {
    const brief = pictureBrief("Odile did not answer.", null, { artDirection: { description: "Wet ink on salt paper." } } as never);
    assert.match(brief, /Odile did not answer\./);
    assert.match(brief, /Light and mood: Wet ink on salt paper\./);
  });
});

describe("Picture on a block (turn 186c)", () => {
  it("chooses a picture by tab and sets it on the block, from the world", async () => {
    const m = await mount(2);
    assert.equal(q(m, ".fy-ab__picture")?.getAttribute("aria-label"), "Picture · block 3");
    await press(q(m, '[data-testid="audiobook-picture-open"]'));
    assert.deepEqual(all(m, '[aria-label="Picture from"] button').map(text), ["World", "Cast", "Scenes", "Generate"]);
    await press(q(m, '.fy-ab__pickitem[aria-label="Key art"]'));
    const set = m.sent.find((message): message is Extract<ClientMessage, { kind: "set-audiobook-picture" }> => message.kind === "set-audiobook-picture");
    assert.deepEqual([set?.block, set?.picture], ["p1.0", { file: "world-art.png", source: "world" }]);
    await press(button(m, "Cast"));
    await press(q(m, ".fy-ab__pickitem"));
    assert.equal((m.sent.at(-1) as Extract<ClientMessage, { kind: "set-audiobook-picture" }>).picture?.source, "cast", "the tab it was chosen on");
  });

  it("shows the picture in the margin with its start; the tab shows the picture, and the chooser how long it holds", async () => {
    const m = await mount(2, { "p1.0": picture(2, "world-art.png"), "p2.0": picture(3, "world-art.png") });
    const chips = all(m, '[data-testid="audiobook-picture-chip"]').map(text);
    assert.deepEqual(chips, ["0:34", "0:44"], "each chip at its block's start");
    assert.equal(q(m, '[data-testid="audiobook-picture-chip"]')?.getAttribute("title"), "under 20 s", "a short hold is flagged on the chip, not refused");
    // 194g draws no Shows or Holds on the Picture tab, and no Choose: the picture is the press.
    assert.doesNotMatch(text(q(m, '[data-testid="audiobook-picture"]')), /Shows|Holds|Make again/);
    assert.equal(button(m, "Choose"), undefined);
    assert.equal(text(q(m, '[data-testid="picture-card-rides"]')), "chosen", "a picture from the world's art: where it came from, no prompt, no checks");
    assert.equal(q(m, '[data-testid="picture-card-checks"]'), null);
    assert.ok(button(m, "Suggest picture"), "Arke can make one for it");
    await press(q(m, '[data-testid="audiobook-picture-open"]'));
    assert.match(text(q(m, ".fy-ab__reads")), /Chapter 07\s*2 pictures · cover at the start/);
    assert.match(text(q(m, ".fy-ab__reads")), /Holds\s*until block 4/);
    await press(button(m, "Remove"));
    const removed = m.sent.at(-1) as Extract<ClientMessage, { kind: "set-audiobook-picture" }>;
    assert.equal(removed.picture, null);
    await press(button(m, "Done"));
    assert.equal(q(m, '[aria-label="Picture from"]'), null);
  });

  it("generates through the Bench: a new session with the brief written in, then the Bench to price and keep it", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="audiobook-picture-open"]'));
    await press(button(m, "Generate"));
    const brief = q(m, 'textarea[aria-label="Brief"]') as HTMLTextAreaElement | null;
    assert.ok(brief, "the brief is shown to edit");
    await press(q(m, '[data-testid="audiobook-picture-generate"]'));
    assert.ok(m.sent.some((message) => message.kind === "bench-new-session"));
    // The coordinator answers with the new session in the snapshot.
    const next = state();
    await act(async () => __setStateForTest({ ...next, bench: { worldId: FIXTURE_WORLD_ID, session: { id: "se_01J8G00000000000000000NEW1", composer: { mode: "image", provider: "", model: "", params: { kind: "image", count: 1 }, brief: "", activeTokens: [] } } } as never }, { connection: "open" }));
    const compose = m.sent.find((message): message is Extract<ClientMessage, { kind: "bench-compose" }> => message.kind === "bench-compose");
    assert.equal(compose?.sessionId, "se_01J8G00000000000000000NEW1");
    assert.equal(compose?.mode, "image");
    assert.match(compose?.brief ?? "", /Odile did not answer\./);
    assert.equal(m.where(), `/w/${FIXTURE_WORLD_ID}/artifacts/bench/se_01J8G00000000000000000NEW1`);
  });
});

/**
 * Suggest picture (design turn 191a, SPEC-047 R-99, R-100): one editable prompt drafted from the block,
 * who is in it as chips over their references — dashed with `Make a reference` where they have none —
 * the look lines it used, the model, the ratio and the price; nothing made until Generate.
 */
const SUGGESTION: PictureSuggestion = {
  block: "p1.0",
  prompt: "Odile on the flooded stair, holding the lamp low; the water takes its light.",
  who: [
    { key: "maren-kest", name: "Maren", sheet: "maren-kest", kind: "character", reference: "references/maren-kest/head-front.png", carried: true },
    { key: "sereth", name: "Sereth", sheet: "sereth", kind: "character", reference: null, carried: false },
    { key: "the-vigil", name: "The Vigil", sheet: "the-vigil", kind: "place", reference: "references/the-vigil/head-front.png", carried: false },
  ],
  lines: [{ label: "Place", text: "The flooded quarter, dusk." }, { label: "Maren", text: "Oilskin coat." }],
  model: { provider: "openai", id: "gpt-image-2", name: "GPT Image 2", references: 1 },
  aspect: "16:9",
  estimatedMicroUsd: 40_000,
};
const asked = <K extends ClientMessage["kind"]>(m: Mounted, kind: K) => m.sent.filter((message): message is Extract<ClientMessage, { kind: K }> => message.kind === kind);
const answerSuggestion = async (m: Mounted, over: Record<string, unknown> = { suggestion: SUGGESTION }) => {
  const request = asked(m, "suggest-audiobook-picture").at(-1)!;
  await act(async () => __applyEventForTest({ at: AT, type: "audiobook.picture-suggestion", requestId: request.requestId, worldId: FIXTURE_WORLD_ID, productionId: "saltlight", chapterId: "07-the-tenth-key", ...over } as never));
};
const typeInto = async (el: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    const key = Object.keys(el).find((candidate) => candidate.startsWith("__reactProps$"));
    (el as unknown as Record<string, { onChange?: (event: { target: unknown; currentTarget: unknown }) => void }>)[key!]!.onChange?.({ target: el, currentTarget: el });
  });
};

describe("Suggest picture (turn 191a)", () => {
  it("authorizes an included-plan picture with an allowance label", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="suggest-picture"]'));
    await answerSuggestion(m, { suggestion: { ...SUGGESTION, estimatedMicroUsd: 0,
      model: { provider: "codex", id: "codex-image", name: "Codex Image", references: 1, plan: "included-plan" } } });
    const button = text(q(m, '[data-testid="suggest-generate"]'));
    assert.match(button, /ChatGPT plan.*Codex allowance/);
    assert.doesNotMatch(button, /free|\$0/);
    assert.equal(asked(m, "make-audiobook-picture").length, 0);
  });
  it("asks for the block's picture, says it is reading, then draws the prompt with who is in it, their look, the model and the price", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="suggest-picture"]'));
    const request = asked(m, "suggest-audiobook-picture")[0]!;
    assert.deepEqual([request.block, request.chapterFile, request.productionId], ["p1.0", "07-the-tenth-key", "saltlight"]);
    assert.equal(text(q(m, '[data-testid="suggest-reading"]')), "reading…");
    await answerSuggestion(m);
    // The prompt is folded to three lines until it is pressed (194g), then it is the field.
    assert.equal(text(q(m, '[data-testid="picture-card-prompt"]')), SUGGESTION.prompt);
    await press(q(m, '[data-testid="picture-card-prompt"]'));
    const field = q(m, '[data-testid="suggest-card"] textarea')!;
    const held = (field as unknown as Record<string, { value?: string }>)[Object.keys(field).find((key) => key.startsWith("__reactProps$"))!];
    assert.equal(held?.value, SUGGESTION.prompt);
    assert.deepEqual(all(m, '[data-testid="suggest-who"]').map((el) => [el.dataset.key, el.dataset.state]), [["maren-kest", "carried"], ["sereth", "none"], ["the-vigil", "over"]]);
    assert.ok(q(m, '[data-key="maren-kest"] img'), "Maren rides by her picture");
    assert.equal(text(q(m, '[data-key="sereth"]')), "SerethMake a look", "no picture: dashed, named, held");
    assert.equal(q(m, '[data-key="sereth"] img'), null);
    assert.equal(text(q(m, '[data-testid="picture-card-rides"]')), "Main photo", "no look chosen: her main photo rides");
    assert.equal(q(m, '[data-key="maren-kest"] [data-testid="picture-card-view"]'), null, "no frame drafted, no frame's word at the row's end");
    assert.ok(q(m, '[data-key="maren-kest"] [data-testid="picture-card-look"]'), "but the look menu is there");
    assert.equal(q(m, '[data-key="the-vigil"] [data-testid="picture-card-look"]'), null, "a place has no look to choose");
    assert.equal(text(q(m, '[data-testid="picture-card-model"]')), "GPT Image 2 · ~$0.04");
    assert.equal(text(q(m, '[data-testid="suggest-generate"]')), "Generate · ~$0.04");
    assert.equal(asked(m, "make-audiobook-picture").length, 0, "nothing is made until Generate");
  });

  it("shows the shot as 193c draws it: the frame, what rides, both look images with the riding one ringed, the expression, who is not in frame, and the seven checks", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="suggest-picture"]'));
    const shot: PictureSuggestion = {
      ...SUGGESTION,
      who: [{ key: "maren-kest", name: "Maren", sheet: "maren-kest", kind: "character", reference: "references/maren-kest/takes/tk_close/close.png", carried: true, look: { lookId: STORM_LOOK.id, view: "close" } }],
      shot: {
        frame: "Close-up, Maren's face",
        inFrame: ["maren-kest"],
        notInFrame: ["odile"],
        expressions: { "maren-kest": "tired, unsmiling, eyes on the key" },
        details: [],
        checks: [
          { id: "reference", ok: true, label: "1 of 1 in frame has a reference" },
          { id: "not-in-frame", ok: true, label: "Nobody else named", note: "Odile" },
          { id: "frame", ok: true, label: "Frame named first", note: "Close-up" },
          { id: "garments", ok: false, label: "Look lines", note: "invented: scarf" },
          { id: "mood", ok: true, label: "Mood", note: "light and colour only" },
          { id: "closing", ok: true, label: "Closing lines", note: "added by the app" },
          { id: "expression", ok: true, label: "Expression named", note: "tired, unsmiling, eyes on the key" },
        ],
      },
    };
    await answerSuggestion(m, { suggestion: shot });
    assert.equal(text(q(m, '[data-testid="picture-card-frame"]')), "Close-up, Maren's face");
    assert.equal(text(q(m, '[data-testid="picture-card-rides"]')), "Close view");
    const thumbs = all(m, '[data-key="maren-kest"] [data-testid="picture-card-thumb"]').map((img) => [img.dataset.view, img.dataset.on]);
    assert.deepEqual(thumbs, [["close", "true"]], "the image that rides, ringed (194g)");
    assert.equal(text(q(m, '[data-key="maren-kest"] [data-testid="picture-card-look"]')), "close-up", "the frame's word, then the menu's chevron (194g)");
    assert.match(text(q(m, '[data-key="maren-kest"]')), /Storm coat · close view/);
    assert.equal(text(q(m, '[data-check="expression"]')), "Expression namedtired, unsmiling, eyes on the key", "the expression is the check's, not a line of its own");
    assert.match(text(q(m, '[data-testid="picture-card-not-in-frame"]')), /Not in frame/);
    assert.equal(all(m, '[data-testid="picture-card-check"]').length, 7);
    assert.deepEqual(all(m, '[data-testid="picture-card-check"][data-ok="false"]').map((li) => li.dataset.check), ["garments"], "a mark is shown");
    assert.equal((q(m, '[data-testid="suggest-generate"]') as HTMLButtonElement).disabled, false, "and never blocks Generate");
    await press(q(m, '[data-testid="suggest-generate"]'));
    assert.equal(asked(m, "make-audiobook-picture")[0]!.frame, "Close-up, Maren's face", "the frame goes with it, so the close view rides at the Bench");
  });
  it("opens the sheet of a person with no reference", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="suggest-picture"]'));
    await answerSuggestion(m);
    await press(q(m, '[data-key="sereth"] [data-testid="suggest-make-reference"]'));
    assert.equal(m.where(), `/w/${FIXTURE_WORLD_ID}/cast/sereth`);
  });

  it("generates the prompt as the author left it, on the price shown, and puts the card away once it is on the block", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="suggest-picture"]'));
    await answerSuggestion(m);
    await press(q(m, '[data-testid="picture-card-prompt"]'));
    await typeInto(q(m, '[data-testid="suggest-card"] textarea') as HTMLTextAreaElement, "Odile alone on the stair, dusk.");
    await press(q(m, '[data-testid="suggest-generate"]'));
    const make = asked(m, "make-audiobook-picture")[0]!;
    assert.deepEqual([make.block, make.prompt, make.who, make.confirmedMicroUsd], ["p1.0", "Odile alone on the stair, dusk.", ["maren-kest", "sereth", "the-vigil"], 40_000]);
    assert.equal(text(q(m, '[data-testid="suggest-generate"]')), "Generating…");
    assert.equal((q(m, '[data-testid="suggest-generate"]') as HTMLButtonElement).disabled, true);
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.picture-made", requestId: make.requestId, worldId: FIXTURE_WORLD_ID, productionId: "saltlight", chapterId: "07-the-tenth-key", block: "p1.0", state: "made", sessionId: "se_01J8G00000000000000000AAA1" } as never));
    assert.equal(q(m, '[data-testid="suggest-card"]'), null);
    assert.ok(q(m, '[data-testid="suggest-picture"]'), "Suggest picture is offered again");
  });

  it("holds a picture that failed with its reason and offers Generate again", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="suggest-picture"]'));
    await answerSuggestion(m);
    await press(q(m, '[data-testid="suggest-generate"]'));
    const make = asked(m, "make-audiobook-picture")[0]!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.picture-made", requestId: make.requestId, worldId: FIXTURE_WORLD_ID, productionId: "saltlight", chapterId: "07-the-tenth-key", block: "p1.0", state: "failed", reason: "the provider refused the prompt" } as never));
    assert.equal(text(q(m, '[data-testid="suggest-failed"]')), "the provider refused the prompt");
    assert.equal((q(m, '[data-testid="suggest-generate"]') as HTMLButtonElement).disabled, false);
    await press(q(m, '[data-testid="suggest-generate"]'));
    assert.equal(asked(m, "make-audiobook-picture").length, 2, "asked again, and only because the author pressed");
  });

  it("takes the same prompt to the Bench with each carried picture attached and cited", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="suggest-picture"]'));
    await answerSuggestion(m);
    await press(q(m, '[data-testid="suggest-edit"]'));
    assert.ok(m.sent.some((message) => message.kind === "bench-new-session"));
    const next = state();
    await act(async () => __setStateForTest({ ...next, bench: { worldId: FIXTURE_WORLD_ID, session: { id: "se_01J8G00000000000000000NEW2", composer: { mode: "image", provider: "", model: "", params: { kind: "image", count: 1 }, brief: "", activeTokens: [] } } } as never }, { connection: "open" }));
    const compose = asked(m, "bench-compose")[0]!;
    assert.deepEqual([compose.provider, compose.model, compose.params], ["openai", "gpt-image-2", { kind: "image", count: 1, aspect: "16:9" }]);
    assert.match(compose.brief, /^Odile on the flooded stair, holding the lamp low/);
    assert.match(compose.brief, /Maren is shown in @Image 1\./);
    assert.ok(!/Sereth/.test(compose.brief.split("\n\n")[1] ?? ""), "a person with no picture is not cited");
    const refs = asked(m, "bench-add-reference")[0]!;
    assert.deepEqual(refs.picks.map((pick) => pick.source), [{ source: "world-file", path: "references/maren-kest/head-front.png" }]);
    assert.equal(m.where(), `/w/${FIXTURE_WORLD_ID}/artifacts/bench/se_01J8G00000000000000000NEW2`);
  });

  it("keeps a plan-backed picture's model when editing, even if it has become unavailable", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="suggest-picture"]'));
    await answerSuggestion(m, { suggestion: { ...SUGGESTION, aspect: undefined, estimatedMicroUsd: 0,
      model: { provider: "codex", id: "codex-image", name: "Codex Image", references: 4, plan: "included-plan" } } });
    await press(q(m, '[data-testid="suggest-edit"]'));
    const next = state();
    assert.ok(!next.app.manifest!.models.some((model) => model.provider === "codex" && model.id === "codex-image"));
    await act(async () => __setStateForTest({ ...next, bench: { worldId: FIXTURE_WORLD_ID, session: { id: "se_01J8G00000000000000000NEW2", composer: { mode: "image", provider: "", model: "", params: { kind: "image", count: 1 }, brief: "", activeTokens: [] } } } as never }, { connection: "open" }));
    const compose = asked(m, "bench-compose")[0]!;
    assert.deepEqual([compose.provider, compose.model, compose.params], ["codex", "codex-image", { kind: "image", count: 1 }], "an unavailable plan model is not replaced with a paid default");
    assert.equal(asked(m, "bench-dispatch").length, 0, "editing never authorizes a generation");
  });

  it("says in one clause why nothing was suggested and offers Suggest picture again", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="suggest-picture"]'));
    await answerSuggestion(m, { refused: "the writing service is not running" });
    assert.equal(text(q(m, '[data-testid="suggest-refused"] p')), "the writing service is not running");
    await press(button(m, "Suggest picture"));
    assert.equal(asked(m, "suggest-audiobook-picture").length, 2);
  });

  it("marks a picture made under a look that has since changed, and not one whose people kept theirs", async () => {
    const look = { chapterHash: "h", at: AT, characters: { "maren-kest": { name: "Maren", text: "Oilskin coat." } } };
    const made = (words: string) => ({ file: "world-art.png", source: "generated" as const, textHash: audiobookTextHash(TEXTS[2]!), at: AT, look: { hash: lookDigest([{ key: "maren-kest", text: words }]), who: ["maren-kest"] } });
    const same = await mount(2, { "p1.0": made("Oilskin coat.") }, look);
    assert.equal(q(same, '[data-testid="picture-look-changed"]'), null);
    const changed = await mount(2, { "p1.0": made("A red coat.") }, look);
    assert.equal(text(q(changed, '[data-testid="picture-look-changed"]')), "look changed");
  });
});

/**
 * The Rides line (design turn 193, rules 8 and 16; 194g draws `Full body · no close view`): one
 * line, `·` between its parts, naming what rode — and who rode which where they differ.
 */
describe("what the Rides line says (turn 194g)", () => {
  const person = (key: string, name: string, view?: "full" | "close") => ({ key, name, sheet: key, kind: "character" as const, reference: `references/${key}/x.png`, carried: true, ...(view !== undefined ? { look: { lookId: `tk_${key}`, view } } : {}) });
  const TWO_SHOT = { frame: "Medium two-shot across the table" };
  const short = { labelOf: (who: { name: string }) => who.name.split(" ")[0]! };

  it("says the one image everyone rode, and why a face frame got the full body", () => {
    const both = [person("ife", "Ife", "full"), person("ade", "Adeyemi Akinola", "full")];
    assert.equal(ridesLabel(both, TWO_SHOT, { hasClose: () => false }), "Full body · no close view", "194g's words");
    assert.equal(ridesLabel(both, { frame: "Wide, the booth" }, { hasClose: () => false }), "Full body", "a wide frame asks for the full body anyway");
    assert.equal(ridesLabel(both, TWO_SHOT), "Full body", "where nothing says the look lacks one, the line does not claim it");
    assert.equal(ridesLabel([person("ife", "Ife", "close"), person("ade", "Ade", "close")], TWO_SHOT), "Close view");
    assert.equal(ridesLabel([person("ife", "Ife")], undefined), "Main photo");
  });

  it("names who rode which where the views differ, never one view for a mixed picture", () => {
    const mixed = [person("tunde", "Tunde", "full"), person("ade", "Adeyemi Akinola", "close")];
    assert.equal(ridesLabel(mixed, undefined, short), "Adeyemi close view · Tunde full body");
    assert.equal(ridesLabel(mixed, TWO_SHOT, { ...short, hasClose: (who) => who.key !== "tunde" }), "Adeyemi close view · Tunde full body · no close view");
    assert.equal(ridesLabel([...mixed, person("ife", "Ife")], undefined, short), "Adeyemi close view · Tunde full body · Ife main photo");
    assert.equal(ridesLabel([person("a", "A", "full"), person("b", "B", "full"), person("c", "C", "close")], undefined), "C close view · A, B full body");
  });

  it("says a detail carries no faces and a frame with nobody carries the place", () => {
    assert.equal(ridesLabel([person("ife", "Ife", "full")], { frame: "Detail, her hand on his wrist" }), "Full body · no faces");
    assert.equal(ridesLabel([], { frame: "Detail, her hand on his wrist" }), "no reference · no faces");
    assert.equal(ridesLabel([{ key: "club", name: "The club", sheet: "club", kind: "place", reference: "references/club/e.png", carried: true }], { frame: "Establishing, the club" }), "Place view");
    assert.equal(ridesLabel([], undefined), "no reference");
  });

  it("reads the row's frame word from the frame, lower-cased, and none where no frame was kept", () => {
    assert.equal(frameViewWord(TWO_SHOT), "two-shot");
    assert.equal(frameViewWord({ frame: "Extreme close-up, Ife's eyes" }), "extreme close-up");
    assert.equal(frameViewWord({ frame: "" }), null);
    assert.equal(frameViewWord(undefined), null);
  });
});

/**
 * A picture Arke made reads back as 193's card (design turn 194, rule 12; 194a, 194g): the picture
 * beside Frame, Rides and the model with its price, In frame with the image that rode ringed, Not in
 * frame, the prompt, the checks, and Remove · Edit prompt · Make again at its price — fed from the
 * Bench's sidecar, the picture's stamp and the shot it keeps. No Shows, no Holds, no Choose.
 */
describe("a made picture on its block (turn 194g)", () => {
  const PROMPT = "Close on Maren at the Vigil's rail, the storm coat's hood up, rain in the lamp's light.";
  const SHOT: PictureShot = {
    frame: "Close-up, Maren's face",
    inFrame: ["maren-kest"],
    notInFrame: ["the-ebb-council"],
    expressions: { "maren-kest": "tired, unsmiling" },
    details: [],
    checks: [
      { id: "reference", ok: true, label: "1 of 1 references" },
      { id: "not-in-frame", ok: true, label: "Nobody else named" },
      { id: "frame", ok: true, label: "Frame" },
    ],
  };
  const CLOSE = "references/maren-kest/takes/tk_close/close.png";
  const VIGIL = "references/the-vigil/establishing.png";
  const madeArtifact = () =>
    artifact("ar_01J8G0000000000000000PICMD", "made-maren.png", {
      origin: { by: "system" },
      generation: {
        source: "bench", sessionId: "se_01J8G00000000000000000MADE", takeId: "tk_01J8G00000000000000000MADE", takeNumber: 1,
        // The brief as the block's card sent it: the prompt, then the app's own closing lines.
        brief: pictureBench(PROMPT, [{ name: "Maren Kest", kind: "character", token: "Image 1" }, { name: "The Vigil", kind: "place", token: "Image 2" }], "Grey dusk."),
        references: [
          { token: "Image 1", kind: "image", source: { source: "world-file", path: CLOSE, hash: "sha256:0" } },
          { token: "Image 2", kind: "image", source: { source: "world-file", path: VIGIL, hash: "sha256:0" } },
        ],
        keyframes: [], provider: "openai", model: "gpt-image-2", params: { kind: "image", count: 1, aspect: "16:9" }, costMicroUsd: 55_000,
      },
    } as unknown as Partial<ArtifactSidecar>);
  const made = (shot?: PictureShot) => ({
    file: "artifacts/made-maren.png", source: "generated" as const, textHash: audiobookTextHash(TEXTS[2]!), at: AT,
    look: { hash: "h", who: ["maren-kest"], looks: { "maren-kest": { lookId: STORM_LOOK.id, view: "close" as const } } },
    ...(shot !== undefined ? { shot } : {}),
  });

  it("draws the card it was made from, priced for Make again, with no Shows, Holds or Choose", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": made(SHOT) });
    assert.ok(q(m, '[data-testid="suggest-card"] [data-testid="picture-card-picture"]'), "the picture in the card's slot");
    assert.equal(text(q(m, '[data-testid="picture-card-frame"]')), "Close-up, Maren's face");
    assert.equal(text(q(m, '[data-testid="picture-card-rides"]')), "Close view");
    assert.equal(text(q(m, '[data-testid="picture-card-model"]')), "GPT Image 2 · ~$0.06", "a picture and two references");
    assert.deepEqual(all(m, '[data-testid="suggest-who"]').map((el) => [el.dataset.key, el.dataset.state]), [["maren-kest", "carried"], ["the-vigil", "carried"]]);
    assert.deepEqual(all(m, '[data-key="maren-kest"] [data-testid="picture-card-thumb"]').map((img) => [img.dataset.view, img.dataset.on]), [["close", "true"]], "the image that rode, ringed");
    assert.match(text(q(m, '[data-key="maren-kest"]')), /Storm coat · close view/);
    assert.match(text(q(m, '[data-testid="picture-card-not-in-frame"]')), /Not in frame\s*The Ebb Council/);
    assert.equal(text(q(m, '[data-testid="picture-card-prompt"]')), PROMPT, "the prompt, not the app's closing lines");
    assert.equal(all(m, '[data-testid="picture-card-check"]').length, 3);
    assert.deepEqual(all(m, ".fy-abp__foot button").map(text), ["Remove", "Edit prompt", "Make again · ~$0.06"]);
    assert.doesNotMatch(text(q(m, '[data-testid="audiobook-picture"]')), /Shows|Holds|Choose\b/);
    assert.equal(asked(m, "suggest-audiobook-picture").length, 0, "nothing is drafted to show it");
  });

  it("makes it again from the card: the same prompt, people, frame and shot, on the price it shows", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": made(SHOT) });
    await press(q(m, '[data-testid="suggest-generate"]'));
    const make = asked(m, "make-audiobook-picture")[0]!;
    assert.deepEqual([make.block, make.prompt, make.who, make.frame, make.confirmedMicroUsd], ["p1.0", PROMPT, ["maren-kest", "the-vigil"], "Close-up, Maren's face", 55_000]);
    assert.deepEqual(make.shot, SHOT, "the shot rides on to the new picture");
    assert.equal(text(q(m, '[data-testid="suggest-generate"]')), "Generating…");
  });

  it("keeps the shot a suggestion was made from on the picture it makes", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="suggest-picture"]'));
    await answerSuggestion(m, { suggestion: { ...SUGGESTION, shot: SHOT } });
    await press(q(m, '[data-testid="suggest-generate"]'));
    assert.deepEqual(asked(m, "make-audiobook-picture")[0]!.shot, SHOT);
  });

  it("shows what a picture made before the shot was kept still knows, and invents no frame or checks", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": made() });
    assert.equal(q(m, '[data-testid="picture-card-frame"]'), null);
    assert.equal(q(m, '[data-testid="picture-card-checks"]'), null);
    assert.equal(q(m, '[data-testid="picture-card-not-in-frame"]'), null);
    assert.equal(text(q(m, '[data-testid="picture-card-rides"]')), "Close view", "the stamp says which image rode");
    assert.equal(q(m, '[data-key="maren-kest"] [data-testid="picture-card-view"]'), null, "but not the frame it rode for");
    assert.equal(text(q(m, '[data-testid="suggest-generate"]')), "Make again · ~$0.06");
  });

  it("says an uploaded picture was uploaded, offers Suggest picture, and picks another by pressing the picture", async () => {
    const m = await mount(2, { "p1.0": { ...picture(2, "artifacts/harbour-upload.png") } });
    assert.equal(text(q(m, '[data-testid="picture-card-rides"]')), "uploaded");
    assert.deepEqual(all(m, ".fy-abp__foot button").map(text), ["Remove", "Suggest picture"]);
    await press(q(m, '[data-testid="audiobook-picture-open"]'));
    assert.deepEqual(all(m, '[aria-label="Picture from"] button').map(text), ["World", "Cast", "Scenes", "Generate"], "the chooser, from the picture");
  });

  it("names each person in frame by their short name, the full name its tooltip, as the rows do (turn 194, rule 13)", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": made({ ...SHOT, notInFrame: ["maren-kest"] }) });
    const name = q(m, '[data-key="maren-kest"] [data-testid="picture-card-name"]');
    assert.equal(text(name), "Maren", "not Maren Kest");
    assert.equal(name?.getAttribute("title"), "Maren Kest");
    assert.equal(q(m, '[data-key="the-vigil"] [data-testid="picture-card-name"]')?.getAttribute("title"), null, "a place has one name");
    assert.match(text(q(m, '[data-testid="picture-card-not-in-frame"]')), /Not in frame\s*Maren$/);
  });

  it("ends a person's row with the frame's word and the look menu: their looks, Main photo, New look, Only this picture on (rule 8)", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": made(SHOT) });
    const toggle = q(m, '[data-key="maren-kest"] [data-testid="picture-card-look"]');
    assert.equal(text(toggle), "close-up");
    assert.equal(toggle?.getAttribute("aria-expanded"), "false");
    assert.ok(toggle?.querySelector("svg"), "the chevron");
    assert.equal(q(m, '[data-key="the-vigil"] [data-testid="picture-card-look"]'), null);
    await press(toggle);
    assert.equal(toggle?.getAttribute("aria-expanded"), "true");
    const menu = q(m, '[data-key="maren-kest"] [data-testid="picture-card-look-menu"]');
    assert.equal(menu?.getAttribute("aria-label"), "Maren · look");
    assert.deepEqual(all(m, '[data-testid="picture-card-look-tile"]').map((tile) => [tile.dataset.look, text(tile), tile.getAttribute("aria-pressed")]), [[STORM_LOOK.id, "Storm coat", "false"], [HARBOUR_LOOK.id, "Harbour coat", "false"], ["main", "Main photo", "true"]], "the chapter chose none: the main photo is on");
    assert.equal(text(q(m, '[data-testid="picture-card-look-new"]')), "New look");
    // 193d: two boxes, Only this picture on as the menu opens, and both pressable.
    const only = q(m, '[data-testid="picture-card-look-only"]') as HTMLInputElement;
    const chapter = q(m, '[data-testid="picture-card-look-chapter"]') as HTMLInputElement;
    assert.deepEqual([only.checked, only.disabled], [true, false]);
    assert.deepEqual([chapter.checked, chapter.disabled], [false, false]);
    assert.match(text(menu), /Only this picture\s*Set for Chapter 7/);
    await tick(chapter, true);
    assert.deepEqual([only.checked, chapter.checked], [false, true], "one box or the other");
    await tick(only, true);
    assert.deepEqual([only.checked, chapter.checked], [true, false]);
  });

  it("with Set for Chapter N on, files a look pressed in the menu as the chapter's choice, rings it at once, and asks once", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": made(SHOT) });
    await press(q(m, '[data-key="maren-kest"] [data-testid="picture-card-look"]'));
    await chapterBox(m);
    await press(q(m, `[data-testid="picture-card-look-tile"][data-look="${STORM_LOOK.id}"]`));
    const chose = asked(m, "choose-audiobook-look");
    assert.equal(chose.length, 1);
    assert.deepEqual([chose[0]!.productionId, chose[0]!.chapterFile, chose[0]!.key, chose[0]!.sheet, chose[0]!.lookId, chose[0]!.block, chose[0]!.only], ["saltlight", "07-the-tenth-key", "maren-kest", "maren-kest", STORM_LOOK.id, "p1.0", undefined], "the chapter's, and this picture follows it");
    assert.equal(q(m, `[data-testid="picture-card-look-tile"][data-look="${STORM_LOOK.id}"]`)?.getAttribute("aria-pressed"), "true", "ringed before the record comes back");
    assert.equal(q(m, '[data-testid="picture-card-look-tile"][data-look="main"]')?.getAttribute("aria-pressed"), "false");
    await press(q(m, `[data-testid="picture-card-look-tile"][data-look="${STORM_LOOK.id}"]`));
    assert.equal(asked(m, "choose-audiobook-look").length, 1, "the look already chosen is not asked for again");
  });

  it("rings the look the chapter chose, and with Set for Chapter N on, Main photo takes the choice away", async () => {
    extraArtifacts = [madeArtifact()];
    const look = { chapterHash: "h", at: AT, characters: { "maren-kest": { name: "Maren", sheet: "maren-kest", text: "Storm coat, hood up; two braids.", lookId: STORM_LOOK.id } } };
    const m = await mount(2, { "p1.0": made(SHOT) }, look);
    await press(q(m, '[data-key="maren-kest"] [data-testid="picture-card-look"]'));
    assert.equal(q(m, `[data-testid="picture-card-look-tile"][data-look="${STORM_LOOK.id}"]`)?.getAttribute("aria-pressed"), "true");
    await chapterBox(m);
    await press(q(m, '[data-testid="picture-card-look-tile"][data-look="main"]'));
    assert.deepEqual([asked(m, "choose-audiobook-look").at(-1)!.lookId, asked(m, "choose-audiobook-look").at(-1)!.only], [null, undefined]);
  });

  /**
   * Only this picture (design turn 193d, rule 8; SPEC-047 R-146): a look pressed with the box on is
   * held on the block for this picture alone, the row says so, the prompt is marked until Update
   * prompt rewrites that person's clothing words, and Make again sends it.
   */
  const STORM_CHAPTER = { chapterHash: "h", at: AT, characters: { "maren-kest": { name: "Maren", sheet: "maren-kest", text: "Storm coat, hood up; two braids.", lookId: STORM_LOOK.id } } };
  const madeInStorm = () => ({ ...made(SHOT), look: { hash: "h", who: ["maren-kest"], looks: { "maren-kest": { lookId: STORM_LOOK.id, view: "close" as const } } } });

  it("holds a look pressed with Only this picture on for this picture alone, says `this picture only`, and marks the prompt", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": madeInStorm() }, STORM_CHAPTER);
    assert.equal(q(m, '[data-testid="picture-card-only"]'), null, "the chapter's look: nothing said");
    assert.equal(q(m, '[data-testid="picture-card-update-prompt"]'), null);
    await press(q(m, '[data-key="maren-kest"] [data-testid="picture-card-look"]'));
    await press(q(m, `[data-testid="picture-card-look-tile"][data-look="${HARBOUR_LOOK.id}"]`));
    const chose = asked(m, "choose-audiobook-look").at(-1)!;
    assert.deepEqual([chose.lookId, chose.block, chose.only], [HARBOUR_LOOK.id, "p1.0", true], "for this block's picture alone");
    assert.equal(q(m, `[data-testid="picture-card-look-tile"][data-look="${HARBOUR_LOOK.id}"]`)?.getAttribute("aria-pressed"), "true", "ringed at once");
    // The record comes back holding it on the block: the row, the Rides line and the marks follow from it.
    await rerender!({ "p1.0": { "maren-kest": HARBOUR_LOOK.id } });
    assert.equal(text(q(m, '[data-key="maren-kest"] [data-testid="picture-card-only"]')), "this picture only");
    assert.match(text(q(m, '[data-key="maren-kest"]')), /Harbour coat · full body/, "no close view: the full body rides");
    assert.deepEqual(all(m, '[data-key="maren-kest"] [data-testid="picture-card-thumb"]').map((img) => img.getAttribute("src")?.includes("tk_harbour/harbour.png")), [true]);
    assert.equal(text(q(m, '[data-testid="picture-card-rides"]')), "Full body · no close view", "a close-up, and the harbour coat has no close view");
    assert.match(text(q(m, '[data-testid="picture-card-look-changed"]')), /^!\s*Look changed\s*prompt still says Storm coat$/);
    assert.equal(text(q(m, '[data-testid="picture-card-update-prompt"]')), "Update prompt");
    assert.equal(asked(m, "rewrite-audiobook-picture-prompt").length, 0, "nothing is rewritten unasked");
  });

  it("Update prompt asks for that person's clothing words rewritten, puts the answer in the prompt, and the mark goes", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": madeInStorm() }, STORM_CHAPTER, { "p1.0": { "maren-kest": HARBOUR_LOOK.id } });
    await press(q(m, '[data-testid="picture-card-update-prompt"]'));
    const rewrite = asked(m, "rewrite-audiobook-picture-prompt").at(-1)!;
    assert.deepEqual([rewrite.block, rewrite.prompt, rewrite.changes], ["p1.0", PROMPT, [{ key: "maren-kest", from: STORM_LOOK.id, to: HARBOUR_LOOK.id }]]);
    assert.equal(text(q(m, '[data-testid="picture-card-update-prompt"]')), "Updating…");
    assert.equal((q(m, '[data-testid="suggest-generate"]') as HTMLButtonElement).disabled, true, "not made while its words are being rewritten");
    const rewritten = "Close on Maren at the Vigil's rail in her harbour coat, rain in the lamp's light.";
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.picture-prompt", requestId: rewrite.requestId, worldId: FIXTURE_WORLD_ID, productionId: "saltlight", chapterId: "07-the-tenth-key", block: "p1.0", prompt: rewritten } as never));
    assert.equal(text(q(m, '[data-testid="picture-card-prompt"]')), rewritten);
    assert.equal(q(m, '[data-testid="picture-card-look-changed"]'), null);
    assert.equal(q(m, '[data-testid="picture-card-update-prompt"]'), null);
    // Make again sends the rewritten prompt and the look of its own.
    await press(q(m, '[data-testid="suggest-generate"]'));
    const make = asked(m, "make-audiobook-picture").at(-1)!;
    assert.deepEqual([make.prompt, make.looks], [rewritten, { "maren-kest": HARBOUR_LOOK.id }]);
  });

  it("says why an Update prompt was refused on the mark, and the prompt stays as it was", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": madeInStorm() }, STORM_CHAPTER, { "p1.0": { "maren-kest": HARBOUR_LOOK.id } });
    await press(q(m, '[data-testid="picture-card-update-prompt"]'));
    const rewrite = asked(m, "rewrite-audiobook-picture-prompt").at(-1)!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.picture-prompt", requestId: rewrite.requestId, worldId: FIXTURE_WORLD_ID, productionId: "saltlight", chapterId: "07-the-tenth-key", block: "p1.0", refused: "the writing service is not running" } as never));
    assert.match(text(q(m, '[data-testid="picture-card-look-changed"]')), /^!\s*Look changed\s*the writing service is not running$/);
    assert.equal(text(q(m, '[data-testid="picture-card-prompt"]')), PROMPT);
    assert.equal(text(q(m, '[data-testid="picture-card-update-prompt"]')), "Update prompt", "to try again");
  });

  it("keeps a look held on the block through a reload, and a picture made with one alone says so and makes again with it", async () => {
    extraArtifacts = [madeArtifact()];
    // Held on the block: drawn from the record alone, as after a reload.
    const held = await mount(2, { "p1.0": madeInStorm() }, STORM_CHAPTER, { "p1.0": { "maren-kest": "main-photo" } });
    assert.equal(text(q(held, '[data-key="maren-kest"] [data-testid="picture-card-only"]')), "this picture only");
    assert.match(text(q(held, '[data-key="maren-kest"]')), /main photo/);
    assert.equal(text(q(held, '[data-testid="picture-card-rides"]')), "Main photo");
    assert.match(text(q(held, '[data-testid="picture-card-look-changed"]')), /prompt still says Storm coat/);
    await press(q(held, '[data-key="maren-kest"] [data-testid="picture-card-look"]'));
    assert.equal(q(held, '[data-testid="picture-card-look-tile"][data-look="main"]')?.getAttribute("aria-pressed"), "true", "the held main photo is ringed");
    await press(q(held, '[data-testid="suggest-generate"]'));
    assert.deepEqual(asked(held, "make-audiobook-picture").at(-1)!.looks, { "maren-kest": "main-photo" });
    // Made with the harbour coat alone: its stamp says so, and Make again keeps it without its being chosen again.
    const own = { ...made(SHOT), look: { hash: "h", who: ["maren-kest"], looks: { "maren-kest": { lookId: HARBOUR_LOOK.id, view: "full" as const, only: true as const } } } };
    const m = await mount(2, { "p1.0": own }, STORM_CHAPTER);
    assert.equal(text(q(m, '[data-key="maren-kest"] [data-testid="picture-card-only"]')), "this picture only");
    assert.equal(q(m, '[data-testid="picture-card-look-changed"]'), null, "the prompt was written for the look it rode");
    await press(q(m, '[data-testid="suggest-generate"]'));
    assert.deepEqual(asked(m, "make-audiobook-picture").at(-1)!.looks, { "maren-kest": HARBOUR_LOOK.id });
  });

  it("never marks a picture made with a look of its own `look changed` for the chapter's choice, and does for that look's own words", async () => {
    extraArtifacts = [madeArtifact()];
    const kits = state().world!.referenceKits;
    const stamp = pictureLookFor(STORM_CHAPTER, ["maren-kest"], { "maren-kest": { lookId: HARBOUR_LOOK.id, view: "full", only: true } }, kitLookLibrary(kits, STORM_CHAPTER))!;
    const own = { ...made(SHOT), look: stamp };
    for (const chapter of [STORM_CHAPTER, { ...STORM_CHAPTER, characters: { "maren-kest": { name: "Maren", sheet: "maren-kest", text: "A red coat." } } }]) {
      const m = await mount(2, { "p1.0": own }, chapter);
      assert.equal(q(m, '[data-testid="picture-look-changed"]'), null);
    }
    const following = { ...made(SHOT), look: pictureLookFor(STORM_CHAPTER, ["maren-kest"], { "maren-kest": { lookId: STORM_LOOK.id, view: "close" } }, kitLookLibrary(kits, STORM_CHAPTER))! };
    const m = await mount(2, { "p1.0": following }, { ...STORM_CHAPTER, characters: { "maren-kest": { name: "Maren", sheet: "maren-kest", text: "Harbour coat, brass buttons.", lookId: HARBOUR_LOOK.id } } });
    assert.ok(q(m, '[data-testid="picture-look-changed"]'), "a picture that followed the chapter is marked");
  });

  it("sends no looks of its own where none are held, and lets one go with Set for Chapter N", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": madeInStorm() }, STORM_CHAPTER, { "p1.0": { "maren-kest": HARBOUR_LOOK.id } });
    await press(q(m, '[data-key="maren-kest"] [data-testid="picture-card-look"]'));
    await chapterBox(m);
    assert.equal(q(m, `[data-testid="picture-card-look-tile"][data-look="${STORM_LOOK.id}"]`)?.getAttribute("aria-pressed"), "true", "the chapter's choice, with its box on");
    await press(q(m, `[data-testid="picture-card-look-tile"][data-look="${STORM_LOOK.id}"]`));
    const chose = asked(m, "choose-audiobook-look").at(-1)!;
    assert.deepEqual([chose.lookId, chose.block, chose.only], [STORM_LOOK.id, "p1.0", undefined], "the chapter's choice already, and the picture's own let go");
    assert.equal(q(m, '[data-testid="picture-card-only"]'), null, "the row follows the chapter at once");
    assert.equal(q(m, '[data-testid="picture-card-look-changed"]'), null);
    await rerender!({ "p1.0": {} });
    await press(q(m, '[data-testid="suggest-generate"]'));
    assert.deepEqual(asked(m, "make-audiobook-picture").at(-1)!.looks, {});
  });

  it("opens New look over the panel from the menu, and puts the menu away", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": made(SHOT) });
    await press(q(m, '[data-key="maren-kest"] [data-testid="picture-card-look"]'));
    await press(q(m, '[data-testid="picture-card-look-new"]'));
    assert.equal(q(m, '[data-testid="picture-card-look-menu"]'), null);
    const sheet = dom.document.querySelector("dialog.fy-newlook");
    assert.ok(sheet, "193b's sheet, drawn on the body");
    assert.match(text(sheet), /New look · Maren Kest/);
    assert.match(text(sheet), /for Chapter 7/);
    assert.equal(m.where(), "/chapter", "made here, not on the cast page");
  });

  it("puts the menu away on Escape, and only the menu: the raised sheet it sits in stays", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": made(SHOT) });
    await press(q(m, '[data-key="maren-kest"] [data-testid="picture-card-look"]'));
    assert.ok(q(m, '[data-testid="picture-card-look-menu"]'));
    const escape = Object.assign(new dom.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
    await act(async () => void dom.document.dispatchEvent(escape as unknown as Event));
    assert.equal(q(m, '[data-testid="picture-card-look-menu"]'), null);
    assert.equal(escape.defaultPrevented, true, "a modal sheet's cancel is Escape's default: the menu takes it");
  });

  it("says the frame a picture's stamp kept even where its card cannot be drawn (its model gone)", async () => {
    const gone = madeArtifact();
    extraArtifacts = [{ ...gone, generation: { ...gone.generation!, model: "an-old-model" } } as ArtifactSidecar];
    const m = await mount(2, { "p1.0": made(SHOT) });
    assert.equal(q(m, '[data-testid="suggest-card"]'), null, "no card: nothing can price Make again");
    assert.equal(text(q(m, '[data-testid="picture-card-frame"]')), "Close-up, Maren's face");
  });

  it("opens the chooser from a made picture too", async () => {
    extraArtifacts = [madeArtifact()];
    const m = await mount(2, { "p1.0": made(SHOT) });
    const pick = q(m, '[data-testid="suggest-card"] [data-testid="audiobook-picture-open"]');
    assert.equal(pick?.getAttribute("aria-label"), "Choose another picture");
    await press(pick);
    assert.ok(q(m, '[aria-label="Picture from"]'));
  });
});

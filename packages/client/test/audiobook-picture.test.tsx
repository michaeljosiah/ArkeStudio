import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { audiobookTextHash, lookDigest, type ArtifactSidecar, type ChapterAudiobook, type ClientMessage, type ClientState, type PictureSuggestion, type ProductionBundle } from "@arke-studio/contracts";
import { BlockPicturePanel, pictureBrief, picturesByTab, useChapterPictures } from "../src/components/audiobook-picture.js";
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
const record = (pictures: ChapterAudiobook["pictures"], look?: ChapterAudiobook["look"]): ChapterAudiobook => ({
  schemaVersion: 1, chapterVersion: 4, hash: "h", updatedAt: AT, flags: {}, direction: {},
  takes: Object.fromEntries(rows.map((row, index) => [row.block.key, { artifactId: `ar_take${index}`, textHash: audiobookTextHash(row.block.text), reader: { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george" }, format: "wav", characters: 1, parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0, madeAt: AT }])),
  ...(pictures !== undefined ? { pictures } : {}),
  ...(look !== undefined ? { look } : {}),
});

function state(): ClientState {
  const world = FIXTURE_STATE.world!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      artifacts: [
        ...world.artifacts,
        artifact("ar_01J8G0000000000000000PICUP", "harbour-upload.png"),
        artifact("ar_01J8G0000000000000000PICGN", "bench-stair.png", { generation: { source: "bench" } } as unknown as Partial<ArtifactSidecar>),
        ...rows.map((row) => row.artifact!),
      ],
    },
  };
}

type Mounted = { container: HTMLElement; root: Root; sent: ClientMessage[]; where: () => string };
const open: Mounted[] = [];
let location = "";
function Where() {
  location = useLocation().pathname;
  return null;
}
function Panel({ selected, pictures, look }: { selected: number; pictures?: ChapterAudiobook["pictures"]; look?: ChapterAudiobook["look"] }) {
  const world = useStore().state?.world ?? null;
  const production = world?.productions.find((p) => p.meta.id === "saltlight") as ProductionBundle;
  const placed = useChapterPictures(world, rows, record(pictures, look));
  return (
    <>
      <AudiobookBlocks rows={rows} sounding={null} selected={rows[selected]!.block.key} onSelect={() => {}} onPlayOne={() => {}} slug="the-undersong" pictures={placed} />
      <BlockPicturePanel worldId={FIXTURE_WORLD_ID} production={production} chapterFile="07-the-tenth-key" chapterOrder={7} row={rows[selected]!} rows={rows} pictures={placed} record={record(pictures, look)} />
    </>
  );
}
async function mount(selected: number, pictures?: ChapterAudiobook["pictures"], look?: ChapterAudiobook["look"]): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state(), { connection: "open" });
    root.render(
      <MemoryRouter initialEntries={["/chapter"]}>
        <Where />
        <Routes>
          <Route path="/chapter" element={<Panel selected={selected} {...(pictures !== undefined ? { pictures } : {})} {...(look !== undefined ? { look } : {})} />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const mounted = { container, root, sent, where: () => location };
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
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const press = async (el: Element | null | undefined) => {
  assert.ok(el, "the thing to press exists");
  await act(async () => void el.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
};
const button = (m: Mounted, label: string) => all(m, "button").find((el) => text(el) === label);
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
    assert.equal(text(q(m, ".fy-ab__picture h2")), "Picture · block 3");
    await press(q(m, '[data-testid="audiobook-picture-open"]'));
    assert.deepEqual(all(m, '[aria-label="Picture from"] button').map(text), ["World", "Cast", "Scenes", "Generate"]);
    await press(q(m, '.fy-ab__pickitem[aria-label="Key art"]'));
    const set = m.sent.find((message): message is Extract<ClientMessage, { kind: "set-audiobook-picture" }> => message.kind === "set-audiobook-picture");
    assert.deepEqual([set?.block, set?.picture], ["p1.0", { file: "world-art.png", source: "world" }]);
    await press(button(m, "Cast"));
    await press(q(m, ".fy-ab__pickitem"));
    assert.equal((m.sent.at(-1) as Extract<ClientMessage, { kind: "set-audiobook-picture" }>).picture?.source, "cast", "the tab it was chosen on");
  });

  it("shows the picture in the margin with its start, how long it holds, and until which block", async () => {
    const m = await mount(2, { "p1.0": picture(2, "world-art.png"), "p2.0": picture(3, "world-art.png") });
    const chips = all(m, '[data-testid="audiobook-picture-chip"]').map(text);
    assert.deepEqual(chips, ["0:34", "0:44"], "each chip at its block's start");
    assert.equal(text(q(m, ".fy-ab__picture .fy-mono")), "shows 0:34–0:44 · 10 s · under 20 s", "a short hold is flagged, not refused");
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
  it("asks for the block's picture, says it is reading, then draws the prompt with who is in it, their look, the model and the price", async () => {
    const m = await mount(2);
    await press(q(m, '[data-testid="suggest-picture"]'));
    const request = asked(m, "suggest-audiobook-picture")[0]!;
    assert.deepEqual([request.block, request.chapterFile, request.productionId], ["p1.0", "07-the-tenth-key", "saltlight"]);
    assert.equal(text(q(m, '[data-testid="suggest-reading"]')), "reading…");
    await answerSuggestion(m);
    const field = q(m, '[data-testid="suggest-card"] textarea')!;
    const held = (field as unknown as Record<string, { value?: string }>)[Object.keys(field).find((key) => key.startsWith("__reactProps$"))!];
    assert.equal(held?.value, SUGGESTION.prompt);
    assert.deepEqual(all(m, '[data-testid="suggest-who"]').map((el) => [el.dataset.key, el.dataset.state]), [["maren-kest", "carried"], ["sereth", "none"], ["the-vigil", "over"]]);
    assert.ok(q(m, '[data-key="maren-kest"] img'), "Maren rides by her picture");
    assert.equal(text(q(m, '[data-key="sereth"]')), "SerethMake a reference", "no picture: dashed, named, held");
    assert.equal(q(m, '[data-key="sereth"] img'), null);
    assert.deepEqual(all(m, '[data-testid="suggest-look"] div').map(text), ["PlaceThe flooded quarter, dusk.", "MarenOilskin coat."]);
    assert.equal(text(q(m, ".fy-sugg__meta")), "GPT Image 2 · 16:9~$0.04");
    assert.equal(text(q(m, '[data-testid="suggest-generate"]')), "Generate · ~$0.04");
    assert.equal(asked(m, "make-audiobook-picture").length, 0, "nothing is made until Generate");
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
    assert.match(compose.brief, /^Odile on the flooded stair, holding the lamp low/);
    assert.match(compose.brief, /Maren is shown in @Image 1\./);
    assert.ok(!/Sereth/.test(compose.brief.split("\n\n")[1] ?? ""), "a person with no picture is not cited");
    const refs = asked(m, "bench-add-reference")[0]!;
    assert.deepEqual(refs.picks.map((pick) => pick.source), [{ source: "world-file", path: "references/maren-kest/head-front.png" }]);
    assert.equal(m.where(), `/w/${FIXTURE_WORLD_ID}/artifacts/bench/se_01J8G00000000000000000NEW2`);
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

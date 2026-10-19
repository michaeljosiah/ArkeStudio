import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { ulid, type ArtifactSidecar, type ClientMessage, type ClientState, type EpisodeScriptBlock } from "@arke-studio/contracts";
import { EpisodeScriptScreen } from "../src/screens/episode-script.js";
import { defaultPrompt, soundSources } from "../src/components/audio-drama-sound.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/** Add a sound (design turn 230w–y, SPEC-057 R-39..R-43). */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1360, innerHeight: 900 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {}, setSelectionRange() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});
const AT = "2026-10-18T12:00:00.000Z";
const sound = (id: string, name: string, heard: string, production: string | undefined, cue: "sound" | "ambience" | "music" = "sound"): ArtifactSidecar => ({
  id, kind: "audio", file: `${id}.mp3`, hash: "sha256:x", origin: { by: "system", producedBy: "sound" }, links: [], created: AT,
  ...(production ? { production } : {}), mediaInfo: { durationSec: 4, hasAudio: true },
  generation: { source: "sound", productionId: "low-water-drama", name, cue, heard, prompt: heard, provider: "elevenlabs", model: "eleven_text_to_sound_v2",
    outputFormat: "mp3_44100_128", estimatedMicroUsd: 8000, costMicroUsd: null },
}) as ArtifactSidecar;

const cue: EpisodeScriptBlock = { id: ulid(), kind: "sound", heard: "Far off, one deep stroke of the harbour bell.", required: true };
function state(extraArtifacts: ArtifactSidecar[] = []): ClientState {
  const s = structuredClone(FIXTURE_STATE);
  const base = s.world!.productions[0]!;
  const drama = { ...structuredClone(base), meta: { ...base.meta, id: "low-water-drama", title: "Low Water", format: "story", medium: "story", kind: "audio-drama" },
    chapters: [], scenes: [], episodes: [], takes: [],
    audioDrama: { version: 1, plan: { episodes: 6, minutes: 25, keptFromListener: [] } },
    episodeScripts: [{ file: "episode-001.json", hash: "sha256:base", script: { version: 1, episode: 1, title: "", blocks: [cue] } }] };
  s.world!.productions = [...s.world!.productions, drama] as never;
  s.world!.artifacts = [...s.world!.artifacts, ...extraArtifacts];
  return s;
}

describe("the sounds a cue is offered (230w)", () => {
  it("ranks sounds by the cue's words, counts their uses, and keeps another production's out", () => {
    const production = state().world!.productions.at(-1)!;
    const used = { ...production, episodeScripts: [{ file: "episode-001.json", hash: "h", script: { version: 1, episode: 1, title: "", blocks: [
      { ...cue, soundArtifact: "ar_bell" }, { id: ulid(), kind: "sound" as const, heard: "Bell again", soundArtifact: "ar_bell" }] } }] };
    const { all, mine } = soundSources([
      sound("ar_door", "Door", "A door slams.", "low-water-drama"),
      sound("ar_bell", "Harbour bell", "One deep stroke of the harbour bell, far off.", "low-water-drama"),
      sound("ar_rain", "Rain", "Rain on glass.", undefined, "ambience"),
      sound("ar_other", "Other's", "harbour bell", "another-production"),
    ], used as never, cue.kind === "sound" ? cue.heard : "");
    assert.deepEqual(all.map((row) => row.name), ["Harbour bell", "Door", "Rain"], "the bell first; another production's sound is not offered");
    assert.match(all[0]!.meta, /2 uses/);
    assert.equal(all[2]!.group, "Ambience");
    assert.deepEqual(mine.map((row) => row.name), ["Harbour bell", "Door"]);
    assert.match(defaultPrompt({ kind: "sound", heard: "A door slams." }), /Close and dry/, "asked dry: distance is the mix's");
  });
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  dom.document.body.innerHTML = "";
});

describe("Add a sound in the score (230f, 230x)", () => {
  it("opens the picker filtered to audio; Generate prices the edited prompt, makes it against the token and places it", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
    const container = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      __setStateForTest(state(), { connection: "open" });
      root!.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/low-water-drama/script/1`]}>
        <Routes><Route path="/w/:worldId/p/:prodId/script/:episode" element={<EpisodeScriptScreen />} /></Routes></MemoryRouter>);
    });
    assert.match(container.textContent!, /No sound yet/);
    assert.match(container.textContent!, /1 required sound missing/);
    const click = (el: Element) => act(async () => { el.dispatchEvent(new dom.Event("click", { bubbles: true })); });
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Add a sound")!);
    const dialog = dom.document.body.querySelector(".fy-ad-sound")!;
    assert.ok(dialog, "the existing picker, in its dialog");
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Generate")!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    const quote = sent.filter((m): m is Extract<ClientMessage, { kind: "generate-drama-sound" }> => m.kind === "generate-drama-sound").at(-1)!;
    assert.deepEqual([quote.cue, quote.quoteOnly, quote.heard], ["sound", true, cue.kind === "sound" ? cue.heard : ""]);
    assert.match(quote.prompt, /Close and dry/);
    await act(async () => __applyEventForTest({ type: "drama.sound", at: AT, requestId: quote.requestId, worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama",
      disposition: "quoted", quote: { token: "tok", estimatedMicroUsd: 20_000, requests: [{ engine: "ElevenLabs Sound Effects v2", prompt: quote.prompt, estimatedMicroUsd: 20_000 }] } }));
    const generate = [...dialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith("Generate · "))!;
    assert.ok(generate, "the price is on the button");
    await click(generate);
    const make = sent.filter((m): m is Extract<ClientMessage, { kind: "generate-drama-sound" }> => m.kind === "generate-drama-sound").at(-1)!;
    assert.deepEqual([make.quoteToken, make.quoteOnly], ["tok", undefined]);
    await act(async () => __setStateForTest(state([sound("ar_new", "Harbour bell", "bell", "low-water-drama")]), { connection: "open" }));
    await act(async () => __applyEventForTest({ type: "drama.sound", at: AT, requestId: make.requestId, worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama",
      disposition: "made", artifactIds: ["ar_new"] }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    const save = sent.filter((m): m is Extract<ClientMessage, { kind: "save-episode-script" }> => m.kind === "save-episode-script").at(-1)!;
    assert.equal(save.blocks[0]!.kind === "sound" && save.blocks[0]!.soundArtifact, "ar_new", "the cue places the artifact made");
  });
});

describe("issue 1883: the Add a sound picker", () => {
  it("offers sounds and never a line's take, and says a sound's uses when it has none", () => {
    const take = { ...sound("ar_take", "x", "x", "low-water-drama"), file: "episode-001-01ABC-take.mp3",
      generation: { source: "audiobook", productionId: "low-water-drama", block: "01ABC" } } as unknown as ArtifactSidecar;
    const { all } = soundSources([sound("ar_door", "Door", "A door slams.", "low-water-drama"), take], state().world!.productions.at(-1)!, "door");
    assert.deepEqual(all.map((row) => row.name), ["Door"], "a dialogue take is not a sound");
    assert.match(all[0]!.meta, /0:04 · not used yet|not used yet/);
  });

  it("is a dialog, and a tile is chosen and heard before Use sound places it", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
    const container = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      __setStateForTest(state([sound("ar_bell", "Harbour bell", "One deep stroke of the harbour bell.", "low-water-drama")]), { connection: "open" });
      root!.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/low-water-drama/script/1`]}>
        <Routes><Route path="/w/:worldId/p/:prodId/script/:episode" element={<EpisodeScriptScreen />} /></Routes></MemoryRouter>);
    });
    const click = (el: Element) => act(async () => { el.dispatchEvent(new dom.Event("click", { bubbles: true })); });
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Add a sound")!);
    const dialog = dom.document.body.querySelector(".fy-ad-sound")!;
    assert.equal(dialog.getAttribute("role"), "dialog");
    const use = () => [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Use sound")!;
    assert.ok(use().disabled, "nothing is placed before a sound is chosen");
    await click(dialog.querySelector("[data-testid='picker-tile']")!);
    assert.ok([...dialog.querySelectorAll("button")].some((b) => b.textContent === "Play"), "the chosen sound can be heard first");
    assert.ok(!use().disabled);
    await click(use());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    const save = sent.filter((m): m is Extract<ClientMessage, { kind: "save-episode-script" }> => m.kind === "save-episode-script").at(-1)!;
    assert.equal(save.blocks[0]!.kind === "sound" && save.blocks[0]!.soundArtifact, "ar_bell");
  });
});

describe("issue 1883: a made sound's name", () => {
  it("keeps the phrase whole where it fits, and never ends on a small word", async () => {
    const { soundName } = await import("../src/components/audio-drama-sound.js");
    assert.equal(soundName("Far off, one deep stroke of the harbour bell."), "Far off, one deep stroke of the harbour bell");
    assert.equal(soundName("A long low groan of timber as the hull settles against the quay wall at the turn of the tide."), "A long low groan of timber as the hull settles against");
  });
});

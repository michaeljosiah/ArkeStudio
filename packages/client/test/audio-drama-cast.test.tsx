import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { ulid, type ClientMessage, type ClientState, type EpisodeScriptBlock } from "@arke-studio/contracts";
import { ProductionCastScreen } from "../src/screens/production-cast.js";
import { EpisodeScriptScreen } from "../src/screens/episode-script.js";
import { takeParked } from "../src/lib/episode-script-drafts.js";
import { changedFields, draftRows } from "../src/lib/episode-script.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/** An audio drama's Cast and Review (design turn 230j/k, SPEC-057 R-49..R-60). */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1360, innerHeight: 900 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {}, setSelectionRange() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const line = (speaker: string, words: string, extra: object = {}): EpisodeScriptBlock => ({ id: ulid(), kind: "dialogue", speaker, words, ...extra });
const narration = (words: string): EpisodeScriptBlock => ({ id: ulid(), kind: "narration", words });

function drama(blocks: EpisodeScriptBlock[], extra: object = {}): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  const base = state.world!.productions[0]!;
  const maren = state.world!.sheets.find((sheet) => sheet.id === "maren-kest")!;
  // Bray has no voice yet, a written Voice and a narration note; the narrator quotes him once.
  const bray = { ...structuredClone(maren), id: "bray", name: "Bray", voice: undefined, narration: "A slower warmth.",
    sections: [{ heading: "Voice · written", body: "Warm, steady. Counts when frightened." }] };
  state.world!.sheets = [...state.world!.sheets, bray] as never;
  const production = { ...structuredClone(base), meta: { ...base.meta, id: "low-water-drama", title: "Low Water", format: "story", medium: "story", kind: "audio-drama" },
    chapters: [], scenes: [], episodes: [], takes: [],
    audioDrama: { version: 1, plan: { episodes: 6, minutes: 25, keptFromListener: [{ fact: "Ilo is alive", revealEpisode: 5 }] }, ...extra },
    episodeScripts: [{ file: "episode-001.json", hash: "sha256:base", script: { version: 3, episode: 1, title: "The tide turns", blocks } }] };
  state.world!.productions = [...state.world!.productions, production] as never;
  return state;
}

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  takeParked(FIXTURE_WORLD_ID, "low-water-drama", 1);
  root = null; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  dom.document.body.innerHTML = "";
});

async function mount(state: ClientState, path: string) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root!.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/low-water-drama/${path}`]}>
      <Routes>
        <Route path="/w/:worldId/p/:prodId/cast" element={<ProductionCastScreen />} />
        <Route path="/w/:worldId/p/:prodId/script/:episode" element={<EpisodeScriptScreen />} />
      </Routes>
    </MemoryRouter>);
  });
  return { container, sent };
}
const props = (element: Element) => (element as unknown as Record<string, { onClick?: (e: unknown) => void; onBlur?: (e: unknown) => void }>)[Object.keys(element).find((key) => key.startsWith("__reactProps"))!]!;
const rowText = (container: HTMLElement, key: string) => container.querySelector(`[data-role="${key}"] [role="row"]`)?.textContent ?? "";

describe("the drama's Cast (230k)", () => {
  it("lists every speaking role with Voice, How they sound and Lines, the narrator's version only where quoted", async () => {
    const { container } = await mount(drama([
      line("maren-kest", "The log said two hours."), line("bray", "The log's wrong."), line("bray", "Climb."),
      line("harbour-clerk", "Turn of tide."),
      narration("“Two,” Bray counted."),
    ]), "cast");
    const headers = [...container.querySelectorAll('[role="columnheader"]')].map((cell) => cell.textContent);
    assert.deepEqual(headers, ["Role", "Voice", "How they sound", "Lines"]);
    assert.match(container.textContent!, /This production · 4 roles · 2 without a voice/);
    assert.match(rowText(container, "@narrator"), /Narrator.*optional role.*App narrator/);
    assert.match(rowText(container, "maren-kest"), /Maren Kest.*from character.*1$/);
    assert.match(rowText(container, "bray"), /BrayNo voice.*Warm, steady\. Counts when frightened\.When the narrator quotes them: A slower warmth\.2$/);
    assert.doesNotMatch(rowText(container, "maren-kest"), /When the narrator quotes/, "Maren is never quoted by the narrator");
    assert.match(rowText(container, "harbour-clerk"), /harbour-clerk.*no character sheet/);
  });

  it("opens a role to its notes and keeps a hidden identity in the production, both or neither", async () => {
    const { container, sent } = await mount(drama([line("bray", "Climb."), narration("“Two,” Bray counted.")]), "cast");
    await act(async () => props(container.querySelector('[data-role="bray"] [role="row"]')!).onClick!({}));
    assert.ok(container.querySelector('textarea[placeholder="A slower warmth."]'), "the narrator's version opens beside How they sound");
    assert.match(container.textContent!, /Starts from Bray's sheet: Warm, steady\./);
    const sound = container.querySelector("textarea")!;
    await act(async () => props(sound).onBlur!({ target: { value: "Warm, steadier." } }));
    assert.deepEqual(sent.at(-1), { kind: "set-drama-role", worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama", role: "bray", value: { sound: "Warm, steadier." } });
    const label = container.querySelector('input[aria-label="Public label"]')!;
    await act(async () => (props(label) as { onChange: (e: unknown) => void }).onChange({ target: { value: "The counter" } }));
    await act(async () => props(label).onBlur!({}));
    assert.equal(sent.length, 1, "a label waits for the episode that reveals it");
    const reveal = container.querySelector('input[aria-label="Revealed in episode"]')!;
    await act(async () => (props(reveal) as { onChange: (e: unknown) => void }).onChange({ target: { value: "4" } }));
    await act(async () => props(reveal).onBlur!({}));
    assert.deepEqual(sent.at(-1), { kind: "set-drama-role", worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama", role: "bray", value: { sound: "Warm, steadier.", publicLabel: "The counter", revealEpisode: 4 } }, "built on the edit before it");
  });

  it("shows a hidden role by its public label, locked until its episode", async () => {
    const { container } = await mount(drama([line("bray", "Climb.")], { cast: { bray: { publicLabel: "The counter", revealEpisode: 4 } } }), "cast");
    assert.match(rowText(container, "bray"), /The counter\s*Bray until episode 4/);
  });
});

describe("Review in the score (230j)", () => {
  it("says what it rests on and how much was heard, and lists passed checks closed", async () => {
    const { container } = await mount(drama([
      { id: ulid(), kind: "heading", place: "The bell tower" },
      line("bray", "Ilo's alive. I heard him."),
    ]), "script/1");
    const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review")!;
    await act(async () => props(toggle).onClick!({}));
    assert.equal(container.querySelector('[data-testid="review-coverage"]')?.textContent, "Script v3 · no audio heard yet");
    const notes = [...container.querySelectorAll(".fy-ad-review__note:not(.fy-ad-review__note--closed)")].map((note) => note.querySelector(".fy-ad-review__kind")!.textContent);
    assert.deepEqual(notes, ["1 Clarity · script v3", "2 Mystery · script v3"]);
    assert.match(container.textContent!, /This may tell the listener “Ilo is alive” before episode 5\./);
    const closed = [...container.querySelectorAll(".fy-ad-review__note--closed .fy-ad-review__kind")].map((kind) => kind.textContent);
    assert.ok(closed.includes("Intelligibility · audio · not heard"));
    assert.ok(closed.includes("Pacing · script v3 · checked"));
  });

  it("decides a note Intentional, kept in the production, and leaves it closed", async () => {
    const state = drama([{ id: ulid(), kind: "heading", place: "The quay" }, line("bray", "Climb.")]);
    const { container, sent } = await mount(state, "script/1");
    const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review")!;
    await act(async () => props(toggle).onClick!({}));
    const intentional = [...container.querySelectorAll("button")].find((button) => button.textContent === "Intentional")!;
    await act(async () => props(intentional).onClick!({}));
    const decided = sent.at(-1) as { kind: string; key: string; decision: string };
    assert.equal(decided.kind, "decide-drama-note");
    assert.equal(decided.decision, "intentional");
    assert.match(decided.key, /^e1:clarity:/, "scoped to its episode");
  });
});

describe("codex round 1 on PR 1873", () => {
  it("builds a second quick edit on the first, never on the stale role", async () => {
    const { container, sent } = await mount(drama([line("bray", "Climb."), narration("\u201CTwo,\u201D Bray counted.")]), "cast");
    await act(async () => props(container.querySelector('[data-role="bray"] [role="row"]')!).onClick!({}));
    const [sound, narrator] = [...container.querySelectorAll("textarea")];
    await act(async () => props(sound!).onBlur!({ target: { value: "Warm, steadier." } }));
    await act(async () => props(narrator!).onBlur!({ target: { value: "Slower." } }));
    assert.deepEqual((sent.at(-1) as { value: unknown }).value, { sound: "Warm, steadier.", narration: "Slower." });
  });

  it("lists a decided note with how it was decided, and reopens it", async () => {
    const state = drama([{ id: ulid(), kind: "heading", place: "The quay" }, line("bray", "Climb.")]);
    // The score with its one note decided Intentional in the production.
    const notes = (await import("@arke-studio/contracts")).reviewDramaScript({ episode: 1, version: 3, names: { bray: "Bray" },
      blocks: state.world!.productions.at(-1)!.episodeScripts![0]!.script.blocks });
    const decided = structuredClone(state);
    (decided.world!.productions.at(-1) as { audioDrama: Record<string, unknown> }).audioDrama.review = { [notes.notes[0]!.key]: "intentional" };
    const { container, sent } = await mount(decided, "script/1");
    await act(async () => props([...container.querySelectorAll("button")].find((button) => button.textContent === "Review")!).onClick!({}));
    const closed = container.querySelector('[data-decided="intentional"]')!;
    assert.match(closed.textContent!, /Clarity · script v3 · intentional/);
    await act(async () => props([...closed.querySelectorAll("button")].find((button) => button.textContent === "Reopen")!).onClick!({}));
    assert.deepEqual(sent.at(-1), { kind: "decide-drama-note", worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama", key: notes.notes[0]!.key, decision: null });
  });
});

describe("Arke's draft in the score (R-9, R-54)", () => {
  it("reads a draft against the script by block id: added, changed, removed, kept", () => {
    const a = line("maren-kest", "One."), b = line("bray", "Two."), c = line("maren-kest", "Three.");
    const rows = draftRows([a, b, c], [a, { ...b, words: "Two, climb." } as EpisodeScriptBlock, line("bray", "Four.")]);
    assert.deepEqual(rows.map((row) => row.state), ["same", "changed", "removed", "added"]);
  });

  it("shows Arke's draft as tracked edits, with Keep and Discard whole", async () => {
    const a = line("maren-kest", "The log said two hours."), b = line("bray", "The log's wrong.");
    const state = drama([a, b]);
    const proposed = { version: 3, episode: 1, title: "The tide turns", blocks: [a, { ...b, words: "The log's wrong. Climb." }, line("bray", "Now.")] };
    state.world!.proposals = [{ proposal: { id: "pr_01J8F3K2QW9VZX4N7M0RTYB6HA", kind: "episode-script", summary: "Episode 1 script", targets: [], draftRevision: 2 },
      ripple: null, episodeScripts: { "productions/low-water-drama/scripts/episode-001.json": proposed } }] as never;
    const { container, sent } = await mount(state, "script/1");
    assert.match(container.querySelector('[aria-label="Arke\'s draft"]')!.textContent!, /1 added · 1 changed/);
    const added = [...container.querySelectorAll('[data-draft="added"]')].map((row) => row.textContent);
    const removed = [...container.querySelectorAll('[data-draft="removed"]')].map((row) => row.textContent);
    assert.deepEqual(removed, ["BrayThe log's wrong."], "the rewritten line's old words are struck");
    assert.deepEqual(added, ["BrayThe log's wrong. Climb.", "BrayNow."]);
    assert.equal(container.querySelector("textarea[data-words]"), null, "the draft is read, not edited, until decided");
    const keep = [...container.querySelectorAll("button")].find((button) => button.textContent === "Keep")!;
    await act(async () => props(keep).onClick!({}));
    assert.deepEqual(sent.at(-1), { kind: "proposal-accept", worldId: FIXTURE_WORLD_ID, proposalId: "pr_01J8F3K2QW9VZX4N7M0RTYB6HA", expectedDraftRevision: 2 });
    const discard = [...container.querySelectorAll("button")].find((button) => button.textContent === "Discard")!;
    await act(async () => props(discard).onClick!({}));
    assert.deepEqual(sent.at(-1), { kind: "proposal-discard", worldId: FIXTURE_WORLD_ID, proposalId: "pr_01J8F3K2QW9VZX4N7M0RTYB6HA" });
  });
});

describe("codex round 1 on PR 1874", () => {
  it("names what a rewrite changes beyond its words", () => {
    const was = line("bray", "Two.");
    assert.deepEqual(changedFields(was, { ...was, channel: "radio" } as EpisodeScriptBlock), ["channel"]);
    assert.deepEqual(changedFields(was, { ...was, words: "Three." } as EpisodeScriptBlock), [], "the words are shown in the line itself");
  });
});

describe("codex round 2 on PR 1874", () => {
  it("shows a block put elsewhere as moved", () => {
    const a = line("maren-kest", "One."), b = line("bray", "Two."), c = line("maren-kest", "Three.");
    const rows = draftRows([a, b, c], [a, c, b]);
    assert.ok(rows.some((row) => row.state === "moved"), "Keep writes the new order, so the draft says so");
  });
});

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { initialAudioArrangement, newAudioClip, ulid, type ClientMessage, type ClientState, type EpisodeScriptBlock } from "@arke-studio/contracts";
import { emitForTest, setAudioFactoryForTest } from "../src/lib/audio.js";
import { ProductionCastScreen } from "../src/screens/production-cast.js";
import { EpisodeScriptScreen } from "../src/screens/episode-script.js";
import { DramaEpisodesScreen } from "../src/screens/drama-episodes.js";
import { dramaLineHash } from "@arke-studio/contracts";
import { takeParked } from "../src/lib/episode-script-drafts.js";
import { changedFields, crowdSpeaker, draftRows, keepDraftRows } from "../src/lib/episode-script.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
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
        <Route path="/w/:worldId/p/:prodId/home" element={<DramaEpisodesScreen />} />
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
    assert.match(rowText(container, "harbour-clerk"), /Harbour clerk.*no character sheet/);
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

  it("gives a role with no voice and no takes the voice it picks at once (issue 1888)", async () => {
    const { container, sent } = await mount(drama([line("harbour-clerk", "Turn of tide.")]), "cast");
    await act(async () => props(container.querySelector('[data-role="harbour-clerk"] [role="row"]')!).onClick!({}));
    const choose = [...container.querySelectorAll("button")].find((button) => button.textContent === "Choose a voice…");
    assert.ok(choose, "a role with no voice is offered a choice, not a change");
    await act(async () => props(choose!).onClick!({}));
    await act(async () => __applyEventForTest({ at: new Date().toISOString(), type: "voice.catalogue", voices: [{ provider: "kokoro", model: "kokoro-82m",
      voiceId: "am_michael", label: "Michael", attributes: ["deep"], facets: { gender: "male" }, local: true, canClone: false, usedBy: [], preview: { kind: "sample", microUsd: 0 } }] } as never));
    const pick = dom.document.body.querySelector<HTMLButtonElement>('[aria-label="Select Michael"]');
    assert.ok(pick, "the local voice is listed");
    await act(async () => pick!.click());
    const use = [...dom.document.body.querySelectorAll("button")].find((button) => button.textContent === "Read with this voice")!;
    await act(async () => use.click());
    assert.deepEqual(sent.at(-1), { kind: "set-drama-role", worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama", role: "harbour-clerk",
      value: { voice: { provider: "kokoro", model: "kokoro-82m", voiceId: "am_michael", label: "Michael" } } }, "no kept take goes out of date, so nothing waits to be confirmed");
    assert.equal(container.querySelector('section[aria-label="Change voice"]'), null);
  });

  it("shows a hidden role by its public label, locked until its episode", async () => {
    const { container } = await mount(drama([line("bray", "Climb.")], { cast: { bray: { publicLabel: "The counter", revealEpisode: 4 } } }), "cast");
    assert.match(rowText(container, "bray"), /The counter\s*Bray until episode 4/);
  });
});

describe("issue 1882: a crowd in Cast (230k)", () => {
  it("is one row of its voices, each line named, opening to each voice as a role", async () => {
    const { container } = await mount(drama([line("bray", "Climb."), line("crowd", "Rope!"), line("crowd-2", "Haul!"), line("crowd-3", "Now!"), line("crowd", "Again!")]), "cast");
    assert.match(container.textContent!, /This production · 2 roles/, "the crowd counts as one");
    const crowd = container.querySelector('[data-role="crowd-group"] > [role="row"]')!;
    assert.match(crowd.textContent!, /Crowd3 speakers · each line named/);
    assert.match(crowd.querySelector(".fy-ad-cast__lines")!.textContent!, /^4$/);
    assert.equal(container.querySelector('[data-role="crowd-2"]'), null, "its voices wait under it");
    await act(async () => props(crowd).onClick!({}));
    assert.deepEqual([...container.querySelectorAll('[data-role="crowd-group"] .fy-ad-cast__members > [data-role] .fy-ad-cast__role b')].map((name) => name.textContent), ["Crowd", "Crowd 2", "Crowd 3"]);
  });

  it("offers another voice in the crowd in the score, a speaker of its own", () => {
    assert.equal(crowdSpeaker(["bray"]), "crowd");
    assert.equal(crowdSpeaker(["crowd", "crowd-2"]), "crowd-3");
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

  it("says what of the mix was heard, with the heard audio's notes beside the script's (issue 1882)", async () => {
    const bray = line("bray", "Climb.");
    const { container, sent } = await mount(drama([{ id: ulid(), kind: "heading", place: "The quay" }, bray]), "script/1");
    const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review")!;
    await act(async () => props(toggle).onClick!({}));
    const asked = sent.findLast((message) => message.kind === "read-audio-heard") as { requestId: string; chapterFile: string };
    assert.equal(asked.chapterFile, "episode-001");
    await act(async () => __applyEventForTest({ type: "audio-studio.heard", at: new Date().toISOString(), requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama",
      chapterId: "episode-001", heard: { base: "a".repeat(64), seconds: 150, spans: [[0, 88]], notes: [{ key: "d".repeat(32), check: "intelligibility", block: bray.id, quote: "Bray: Climb.",
        from: 57.8, to: 59.4, observed: "Bray 4 dB under Ambience" }] } }));
    assert.equal(container.querySelector('[data-testid="review-coverage"]')?.textContent, "heard 0:00–1:28 of 2:30");
    const kinds = [...container.querySelectorAll(".fy-ad-review__note:not(.fy-ad-review__note--closed) .fy-ad-review__kind")].map((kind) => kind.textContent);
    assert.ok(kinds.includes("2 Intelligibility · heard 0:57.8–0:59.4"), JSON.stringify(kinds));
    const closed = [...container.querySelectorAll(".fy-ad-review__note--closed .fy-ad-review__kind")].map((kind) => kind.textContent);
    assert.ok(closed.includes("Intelligibility · audio · heard"));
    assert.ok([...container.querySelectorAll("button")].some((button) => button.textContent === "Review audio in Audio Studio"), "230j's way to the audio");
    // Asked again and not sent (codex on PR 1945): the last answer is no longer said.
    __setBridgeForTest(null);
    await act(async () => __applyEventForTest({ at: new Date().toISOString(), type: "audiobook.record", worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama", chapterId: "episode-001" }));
    assert.equal(container.querySelector('[data-testid="review-coverage"]')?.textContent, "Script v3 · no audio heard yet");
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

describe("issue 1882: one change of a draft and not another", () => {
  it("writes each row as drafted or as it was, and lets a bed whose stop is left out run on", () => {
    const a = line("maren-kest", "One."), b = line("bray", "Two."), c = line("maren-kest", "Three.");
    const added = line("bray", "Four.");
    const bed = { id: ulid(), kind: "ambience" as const, heard: "Gulls.", until: added.id };
    const rows = draftRows([a, b, c], [bed, a, { ...b, words: "Two, climb." } as EpisodeScriptBlock, added]);
    const key = (state: string, id: string) => `${state}:${id}`;
    assert.deepEqual(keepDraftRows([a, b, c], rows, new Set()).map((block) => block.id), [bed.id, a.id, b.id, added.id], "nothing left out is the draft");
    const some = keepDraftRows([a, b, c], rows, new Set([key("changed", b.id), key("removed", c.id), key("added", added.id)]));
    assert.deepEqual(some.map((block) => block.id), [bed.id, a.id, b.id, c.id]);
    assert.equal((some[2] as { words: string }).words, "Two.", "a rewrite left out keeps its old words");
    assert.equal((some[0] as { until?: string }).until, undefined, "the bed's stop was left out, so it runs to the scene's end");
  });

  it("Keep N of M saves the script with the changes taken, and lets the draft go", async () => {
    const a = line("maren-kest", "The log said two hours."), b = line("bray", "The log's wrong.");
    const state = drama([a, b]);
    const proposed = { version: 3, episode: 1, title: "", blocks: [a, { ...b, words: "The log's wrong. Climb." }, line("bray", "Now.")] };
    state.world!.proposals = [{ proposal: { id: "pr_01J8F3K2QW9VZX4N7M0RTYB6HA", kind: "episode-script", summary: "Episode 1 script", targets: [], draftRevision: 2 },
      ripple: null, episodeScripts: { "productions/low-water-drama/scripts/episode-001.json": proposed } }] as never;
    const { container, sent } = await mount(state, "script/1");
    const leave = [...container.querySelectorAll("button[aria-label='Leave this change out']")];
    assert.equal(leave.length, 2, "each change has its own choice");
    await act(async () => props(leave[1]!).onClick!({}));
    const keep = [...container.querySelectorAll("button")].find((button) => button.textContent === "Keep 1 of 2")!;
    assert.ok(keep, "Keep names what it writes");
    await act(async () => props(keep).onClick!({}));
    assert.ok(sent.some((message) => message.kind === "proposal-discard"), "the draft is let go, so nothing left out can be kept later");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    const save = sent.filter((message): message is Extract<ClientMessage, { kind: "save-episode-script" }> => message.kind === "save-episode-script").at(-1)!;
    assert.deepEqual(save.blocks.map((block) => (block as { words: string }).words), ["The log said two hours.", "The log's wrong. Climb."]);
  });

  it("puts a removal left out back where it stood, among lines the draft moves (codex on PR 1884)", () => {
    const a = line("maren-kest", "One."), b = line("bray", "Two."), c = line("maren-kest", "Three.");
    const rows = draftRows([a, b, c], [c, b]);
    assert.deepEqual(keepDraftRows([a, b, c], rows, new Set([`removed:${a.id}`])).map((block) => block.id), [a.id, c.id, b.id]);
    const d = line("bray", "Four.");
    assert.deepEqual(keepDraftRows([a, b, c, d], draftRows([a, b, c, d], [d, a, c]), new Set([`removed:${b.id}`])).map((block) => block.id),
      [d.id, a.id, b.id, c.id], "after the line it followed");
  });

  it("keeps a drafted title with every line change left out (codex on PR 1884)", async () => {
    const a = line("maren-kest", "The log said two hours."), b = line("bray", "The log's wrong.");
    const state = drama([a, b]);
    const proposed = { version: 3, episode: 1, title: "The log", blocks: [a, { ...b, words: "The log's wrong. Climb." }] };
    state.world!.proposals = [{ proposal: { id: "pr_01J8F3K2QW9VZX4N7M0RTYB6HA", kind: "episode-script", summary: "Episode 1 script", targets: [], draftRevision: 2 },
      ripple: null, episodeScripts: { "productions/low-water-drama/scripts/episode-001.json": proposed } }] as never;
    const { container, sent } = await mount(state, "script/1");
    await act(async () => props(container.querySelector("button[aria-label='Leave this change out']")!).onClick!({}));
    const keep = [...container.querySelectorAll("button")].find((button) => button.textContent === "Keep title") as HTMLButtonElement | undefined;
    assert.equal(keep?.disabled, false, "the title is still taken");
    await act(async () => props(keep!).onClick!({}));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    const save = sent.filter((message): message is Extract<ClientMessage, { kind: "save-episode-script" }> => message.kind === "save-episode-script").at(-1)!;
    assert.deepEqual([save.title, save.blocks.map((block) => (block as { words: string }).words)], ["The log", ["The log said two hours.", "The log's wrong."]]);
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

describe("an episode in Audio Studio (SPEC-057 R-67)", () => {
  it("opens the chapter's studio named by the episode's script", async () => {
    const { container, sent } = await mount(drama([line("bray", "Climb.")]), "script/1?view=audio-studio");
    const read = sent.find((message) => message.kind === "read-audio-studio") as { chapterFile: string } | undefined;
    assert.equal(read?.chapterFile, "episode-001", "one arrangement an episode, on the same studio");
    assert.equal(container.querySelector("textarea[data-words]"), null, "the score is not drawn under it");
    // Its own words (issue 1883): back to the script, the episode's bar and views above it (230o), an episode's mix.
    assert.match(container.querySelector(".fy-cuthead")!.textContent!, /^Script/, "Back names the script, not Audiobook");
    assert.ok(container.querySelector(".fy-ad-ep__bar nav[aria-label='Episode views'] [aria-current='page']")?.textContent === "Audio Studio");
    assert.ok(container.querySelector("section[aria-label='Episode script']"));
  });

  it("has Arke beside the arrangement, and reads again when Arke's suggestion lands (issue 1882)", async () => {
    const { container, sent } = await mount(drama([line("bray", "Climb.")]), "script/1?view=audio-studio");
    assert.match(container.querySelector("#cut-arke-panel")!.textContent!, /Discuss the arrangement with Arke/);
    const reads = () => sent.filter((message) => message.kind === "read-audio-studio").length;
    const before = reads();
    // The coordinator's signal for an episode carries no chapter record, only that its studio changed.
    await act(async () => __applyEventForTest({ at: new Date().toISOString(), type: "audiobook.record", worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama", chapterId: "episode-001" }));
    assert.equal(reads(), before + 1, "the studio reads again, so Current/Suggested has the suggestion");
  });
});

describe("issue 1882: the episode's review strip and what was heard (230o)", () => {
  const studioOf = (line: EpisodeScriptBlock, heard?: object) => {
    const source = { file: "artifacts/take.wav", label: "Take", hash: `sha256:${"b".repeat(64)}`, samples: 96_000, rate: 48_000, channels: 2 as const };
    const clip = { ...newAudioClip("voice", "voice:bray", source, 96_000), role: "speech" as const, passageId: "p1", placement: { kind: "sequence" as const, offset: 0 } };
    const arrangement = initialAudioArrangement({ manuscriptHash: "script", passages: [{ id: "p1", key: line.id, textHash: dramaLineHash(line as never) }],
      tracks: [{ id: "voice:bray", name: "Bray", gainDb: 0, muted: false }], clips: [clip], omissions: [], master: { targetLufs: -18, ceilingDb: -1.5 } }, "{}");
    return { base: "a".repeat(64), revision: 1, undo: null, redo: null, state: arrangement.current, script: { hash: "script", passages: [{ key: line.id, textHash: dramaLineHash(line as never) }] },
      passages: [{ key: line.id, text: "Bray: Climb." }], library: [], ...(heard ? { heard } : {}) };
  };
  const open = async (line: EpisodeScriptBlock, heard?: object) => {
    const m = await mount(drama([{ id: ulid(), kind: "heading", place: "The quay" } as EpisodeScriptBlock, line]), "script/1?view=audio-studio");
    const read = m.sent.find((message) => message.kind === "read-audio-studio") as { requestId: string };
    await act(async () => __applyEventForTest({ type: "audio-studio.state", at: new Date().toISOString(), worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama", chapterId: "episode-001",
      requestId: read.requestId, source: null, studio: studioOf(line, heard) as never }));
    return m;
  };

  it("draws the whole episode: its scene, what was heard, the note pinned where it was heard, and Hear the rest", async () => {
    const line = { id: ulid(), kind: "dialogue", speaker: "bray", words: "Climb." } as EpisodeScriptBlock;
    const note = { key: "c".repeat(32), check: "intelligibility", block: line.id, quote: "Bray: Climb.", from: 0, to: 1, observed: "Bray 4 dB under Ambience",
      fix: { label: "Duck Ambience 10 dB more under Bray", commands: [{ kind: "set-clip", id: "voice", changes: { duckDb: 10 } }] } };
    const { container, sent } = await open(line, { base: "a".repeat(64), seconds: 2, spans: [[0, 1]], notes: [note] });
    const strip = container.querySelector("[role='region'][aria-label='Review']")!;
    assert.equal(strip.querySelector("[data-testid='strip-coverage']")?.textContent, "heard 0:00–0:01 of 0:02");
    assert.equal(strip.querySelector(".fy-review-strip__scene")?.getAttribute("title"), "1 · The quay");
    assert.equal(strip.querySelectorAll(".fy-review-strip__heard i").length, 1, "what was heard is solid over the hatching");
    assert.ok([...strip.querySelectorAll("button")].some((button) => button.textContent === "Hear the rest"));
    assert.ok(container.querySelector(".fy-audio-timeline__region"), "the scene is a region on the ruler too");
    await act(async () => props(strip.querySelector("button[aria-label^='Note 1']")!).onClick!({}));
    const section = container.querySelector("[aria-label='Review note']")!;
    assert.match(section.textContent!, /Review · note 1 · heard.*“Climb\.”.*Heard0:00\.0–0:01\.0.*ObservedBray 4 dB under Ambience.*KindIntelligibility/);
    await act(async () => props([...section.querySelectorAll("button")].find((button) => button.textContent === "Fix")!).onClick!({}));
    assert.match(container.querySelector("[aria-label='Review audio changes']")?.textContent ?? "", /Duck Ambience 10 dB more under Bray/, "Fix is Current and Suggested");
    await act(async () => props([...section.querySelectorAll("button")].find((button) => button.textContent === "Dismiss")!).onClick!({}));
    assert.deepEqual(sent.filter((message) => message.kind === "decide-drama-note").map((message) => (message as { key: string; decision: string }).decision), ["dismissed"]);
  });

  it("records what of the saved mix played whole, on the base it was heard on", async () => {
    const element = { src: "", currentTime: 0, duration: 2, loop: false, playbackRate: 1, play: async () => {}, pause: () => {}, load: () => {}, removeAttribute: () => {},
      addEventListener: () => {}, removeEventListener: () => {} };
    setAudioFactoryForTest(() => element as never);
    try {
      const line = { id: ulid(), kind: "dialogue", speaker: "bray", words: "Climb." } as EpisodeScriptBlock;
      const { container, sent } = await open(line);
      assert.equal(container.querySelector("[data-testid='strip-coverage']")?.textContent, "Script v3 · no audio heard yet");
      await act(async () => props(container.querySelector("[aria-label='Play']")!).onClick!({}));
      const preview = sent.find((message) => message.kind === "preview-audio-studio") as { requestId: string };
      await act(async () => __applyEventForTest({ type: "audiobook.mix", at: new Date().toISOString(), worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama", chapterId: "episode-001",
        requestId: preview.requestId, mix: { file: ".cache/audio-studio/mix/x.wav", seconds: 2, from: 0 } }));
      await act(async () => { emitForTest("play"); });
      for (const at of [0.25, 0.75, 1.25, 1.75]) await act(async () => { element.currentTime = at; emitForTest("timeupdate"); });
      await act(async () => { emitForTest("pause"); });
      const heard = sent.filter((message) => message.kind === "record-audio-heard") as Array<{ base: string; spans: Array<[number, number]>; chapterFile: string }>;
      assert.equal(heard.length, 1);
      assert.deepEqual([heard[0]!.base, heard[0]!.chapterFile, heard[0]!.spans], ["a".repeat(64), "episode-001", [[0, 2]]], "played to its end, it is heard to its end");
    } finally { setAudioFactoryForTest(null); }
  });
});

describe("the show page and Publish (230p, 230q)", () => {
  const withTakes = (blocks: EpisodeScriptBlock[], kept: string[]) => {
    const state = drama(blocks);
    const production = state.world!.productions.find((p) => p.meta.id === "low-water-drama")!;
    production.episodeTakes = [{ version: 1, episode: 1, lines: Object.fromEntries(blocks.filter((block) => kept.includes(block.id)).map((block) => [block.id, { kept: {
      artifactId: "ar_01ARZ3NDEKTSV4RRFFQ69G5FAV", file: "artifacts/a.wav", textHash: dramaLineHash(block as never),
      // Made in the role's voice now, so it is current (R-60).
      voice: state.world!.sheets.find((sheet) => sheet.id === (block as { speaker?: string }).speaker)?.voice ?? { provider: "elevenlabs", model: "m", voiceId: "v" },
      estimatedMicroUsd: 0, madeAt: "2026-10-18T12:00:00.000Z" } }])) }] as never;
    return state;
  };

  it("shows each episode's state, and the episodes not planned as one row", async () => {
    const a = line("maren-kest", "One."), b = line("bray", "Two.");
    const { container } = await mount(withTakes([{ id: ulid(), kind: "heading", place: "Quay" }, a, b], [a.id]), "home");
    const row = container.querySelector('[data-episode="1"]')!;
    assert.match(row.textContent!, /✓ Script.*● Cast 1 missing.*● Performed 1 of 2.*○ Mixed/);
    assert.match(container.textContent!, /Episodes 2–6 · not planned/);
  });

  it("publishes only ready episodes, and says why one is held back", async () => {
    const a = line("maren-kest", "One.");
    const ready = await mount(withTakes([{ id: ulid(), kind: "heading", place: "Quay" }, a], [a.id]), "home");
    await act(async () => props([...ready.container.querySelectorAll("button")].find((button) => button.textContent === "Publish…")!).onClick!({}));
    await act(async () => props([...dom.document.body.querySelectorAll("button")].find((button) => button.textContent === "Publish edition")!).onClick!({}));
    const sent = ready.sent.find((message) => message.kind === "publish-drama-edition") as { episodes: number[]; delivery: string; name: string } | undefined;
    assert.deepEqual([sent?.episodes, sent?.delivery, sent?.name], [[1], "podcast", "Pilot"]);
    await act(async () => root?.unmount()); root = null; dom.document.body.innerHTML = "";
    const held = await mount(withTakes([{ id: ulid(), kind: "heading", place: "Quay" }, a], []), "home");
    await act(async () => props([...held.container.querySelectorAll("button")].find((button) => button.textContent === "Publish…")!).onClick!({}));
    assert.match(dom.document.body.textContent!, /Episode 1.*not performed/);
    assert.equal(([...dom.document.body.querySelectorAll("button")].find((button) => button.textContent === "Publish edition") as HTMLButtonElement | undefined)?.disabled, true);
  });

  it("shows a press performing in the background on its row, as Activity reports it (230p, issue 1882)", async () => {
    const a = line("maren-kest", "One."), b = line("bray", "Two."), c = line("maren-kest", "Three.");
    const state = withTakes([{ id: ulid(), kind: "heading", place: "Quay" }, a, b, { id: ulid(), kind: "heading", place: "Tower" }, c], []);
    const job = (block: string, status: string, createdAt: string, updatedAt: string) => ({ ...structuredClone(state.app.jobs[0]!), id: `jb_${ulid()}`, productionId: "low-water-drama",
      target: { kind: "voice-preview", id: "drama/elevenlabs/eleven_v3/breeze-a" }, capability: "voice-tts", params: { block },
      landing: { dir: ".staging/drama/low-water-drama/episode-001" }, status, createdAt, updatedAt });
    // An old take made long ago is another press; this one has made Maren's line and is making Bray's.
    state.app.jobs = [job(c.id, "succeeded", "2026-10-19T08:00:00.000Z", "2026-10-19T08:00:05.000Z"),
      job(a.id, "succeeded", "2026-10-19T09:00:00.000Z", "2026-10-19T09:00:05.000Z"), job(b.id, "running", "2026-10-19T09:00:06.000Z", "2026-10-19T09:00:06.000Z")] as never;
    const { container } = await mount(state, "home");
    const row = container.querySelector('[data-episode="1"]')!;
    assert.match(row.querySelector("[role='status']")?.textContent ?? "", /Performing 1 of 3 lines/);
    assert.equal(row.querySelector(".fy-ad-show__ends"), null, "in place of Ends on");
    assert.match(row.textContent!, /● Performed 1 of 3/);
    const scenes = [...row.querySelectorAll(".fy-ad-show__scenes i")].map((scene) => scene.className);
    assert.deepEqual(scenes, ["fy-ad-show__scene--work", ""], "the scene with the line being made is at work");
    state.app.jobs = (state.app.jobs as Array<{ status: string }>).map((entry) => ({ ...entry, status: "succeeded" })) as never;
    await act(async () => __setStateForTest(state, { connection: "open" }));
    assert.equal(container.querySelector('[data-episode="1"] [role="status"]'), null, "nothing going, nothing shown");
    // Parked for a person, or another world's (codex on PR 1945): neither is this episode performing.
    state.app.jobs = [job(b.id, "needs-reconciliation", "2026-10-19T10:00:00.000Z", "2026-10-19T10:00:00.000Z"),
      { ...job(b.id, "running", "2026-10-19T10:00:00.000Z", "2026-10-19T10:00:00.000Z"), worldId: "01J8F3K2QW9VZX4N7M0RTYB6ZZ" }] as never;
    await act(async () => __setStateForTest(state, { connection: "open" }));
    assert.equal(container.querySelector('[data-episode="1"] [role="status"]'), null, "a parked job, or another world's, is not a press going");
  });

  it("names what an edition delivers, and asks for stems only when there are lanes to separate (issue 1882)", async () => {
    const a = line("maren-kest", "One."), b = line("bray", "Two.");
    const { container, sent } = await mount(withTakes([{ id: ulid(), kind: "heading", place: "Quay" }, a, b], [a.id, b.id]), "home");
    await act(async () => props([...container.querySelectorAll("button")].find((button) => button.textContent === "Publish…")!).onClick!({}));
    const outputs = dom.document.body.querySelector(".fy-ad-pub__outputs")!;
    assert.match(outputs.textContent!, /✓ Episode audio · MP3.*✓ Production script · PDF.*Stems · 2/);
    const archive = [...dom.document.body.querySelectorAll("[role='radio']")].find((button) => button.textContent === "Archive · WAV")!;
    await act(async () => props(archive).onClick!({}));
    assert.match(outputs.textContent!, /Episode audio · WAV/);
    assert.match(dom.document.body.querySelector(".fy-ad-pub__frozen")!.textContent!, /Voices.*·/, "the kept takes' voices, by engine (codex on PR 1945)");
    const stems = dom.document.body.querySelector(".fy-ad-pub__stems")!;
    assert.equal(stems.getAttribute("aria-pressed"), "false", "off unless asked for");
    await act(async () => props(stems).onClick!({}));
    await act(async () => props([...dom.document.body.querySelectorAll("button")].find((button) => button.textContent === "Publish edition")!).onClick!({}));
    const asked = sent.find((message) => message.kind === "publish-drama-edition") as { delivery: string; stems?: boolean } | undefined;
    assert.deepEqual([asked?.delivery, asked?.stems], ["archive", true]);
  });

  it("reads a saved mix's problems: not Mixed, not played, held back from Publish (issue 1882)", async () => {
    const a = line("maren-kest", "One.");
    const { container, sent } = await mount(withTakes([{ id: ulid(), kind: "heading", place: "Quay" }, a], [a.id]), "home");
    assert.equal(container.querySelector('[data-episode="1"] button[aria-label="Play episode 1"]') !== null, true, "ready until the mix is checked");
    // The coordinator checks the saved arrangement as Publish would, sources read live (codex on PR 1884).
    const listing = sent.findLast((message) => message.kind === "list-drama-editions") as { requestId: string } | undefined;
    await act(async () => __applyEventForTest({ at: new Date().toISOString(), type: "drama.editions", requestId: listing!.requestId, editions: [],
      mixes: [{ episode: 1, issues: ["Passage “One.” changed; bind it again"] }] }));
    const row = container.querySelector('[data-episode="1"]')!;
    assert.match(row.textContent!, /● Mix 1 to fix/);
    assert.equal(row.querySelector("button[aria-label='Play episode 1']"), null, "an episode whose mix cannot resolve is not offered to play");
    await act(async () => props([...container.querySelectorAll("button")].find((button) => button.textContent === "Publish…")!).onClick!({}));
    assert.match(dom.document.body.textContent!, /the saved mix has 1 problem to fix in Audio Studio/);
  });

  it("keeps gaps in the episodes not planned, and Cancel waits for a publish in flight (codex on PR 1880)", async () => {
    const a = line("maren-kest", "One.");
    const state = withTakes([{ id: ulid(), kind: "heading", place: "Quay" }, a], [a.id]);
    const production = state.world!.productions.find((p) => p.meta.id === "low-water-drama")!;
    production.episodeScripts = [...production.episodeScripts!, { file: "episode-003.json", hash: "sha256:three", script: { version: 1, episode: 3, title: "", blocks: [line("bray", "Three.")] } }] as never;
    const { container } = await mount(state, "home");
    assert.match(container.textContent!, /Episodes 2, 4–6 · not planned/);
    await act(async () => props([...container.querySelectorAll("button")].find((button) => button.textContent === "Publish…")!).onClick!({}));
    await act(async () => props([...dom.document.body.querySelectorAll("button")].find((button) => button.textContent === "Publish edition")!).onClick!({}));
    assert.equal(([...dom.document.body.querySelectorAll("button")].find((button) => button.textContent === "Cancel") as HTMLButtonElement).disabled, true);
  });
});

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { ulid, type ClientMessage, type ClientState, type EpisodeScriptBlock } from "@arke-studio/contracts";
import { ProductionCastScreen } from "../src/screens/production-cast.js";
import { EpisodeScriptScreen } from "../src/screens/episode-script.js";
import { DramaEpisodesScreen } from "../src/screens/drama-episodes.js";
import { dramaLineHash } from "@arke-studio/contracts";
import { takeParked } from "../src/lib/episode-script-drafts.js";
import { changedFields, draftRows, keepDraftRows } from "../src/lib/episode-script.js";
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

describe("issue 1882: one change of a draft and not another", () => {
  it("writes each row as drafted or as it was, and lets a bed whose stop is left out run on", () => {
    const a = line("maren-kest", "One."), b = line("bray", "Two."), c = line("maren-kest", "Three.");
    const added = line("bray", "Four.");
    const bed = { id: ulid(), kind: "ambience" as const, heard: "Gulls.", until: added.id };
    const rows = draftRows([a, b, c], [bed, a, { ...b, words: "Two, climb." } as EpisodeScriptBlock, added]);
    const key = (state: string, id: string) => `${state}:${id}`;
    assert.deepEqual(keepDraftRows(rows, new Set()).map((block) => block.id), [bed.id, a.id, b.id, added.id], "nothing left out is the draft");
    const some = keepDraftRows(rows, new Set([key("changed", b.id), key("removed", c.id), key("added", added.id)]));
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

  it("reads a saved mix's problems: not Mixed, not played, held back from Publish (issue 1882)", async () => {
    const a = line("maren-kest", "One.");
    const state = withTakes([{ id: ulid(), kind: "heading", place: "Quay" }, a], [a.id]);
    state.world!.productions.find((p) => p.meta.id === "low-water-drama")!.dramaMixes = [{ episode: 1, issues: ["Passage “One.” changed; bind it again"] }];
    const { container } = await mount(state, "home");
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

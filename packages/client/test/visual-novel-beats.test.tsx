import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { insertShot, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyEventForTest, __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A visual novel's scene page (design turn 174, 174b–174c): the storyboard reads as beats — each
 * row's lines under their speaker, whether each is voiced, how the beat moves on, a beat that keeps
 * the picture before — and the shot page gains a Beat card that writes `shot.beat`. A film's page
 * is untouched. Same harness as shot-page.test.tsx.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const SCENE_PATH = `/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes/sc_04`;
const LINE_WASH = "sc_04/sh_12/blk_wash";
const LINE_VERSE = "sc_04/sh_12/blk_verse";

interface Mounted { container: HTMLElement; root: Root }
const open: Mounted[] = [];

async function mountState(state: ClientState, path: string): Promise<Mounted> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state);
    root.render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
  });
  const mounted = { container, root };
  open.push(mounted);
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest(null);
  __connectionStatusForTest("closed");
});

function capture(sent: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as ArkeBridge;
}

const q = (m: Mounted, selector: string): HTMLElement | null => m.container.querySelector(selector) as HTMLElement | null;
const all = (m: Mounted, selector: string): HTMLElement[] => [...m.container.querySelectorAll(selector)] as unknown as HTMLElement[];
const click = async (element: HTMLElement): Promise<void> => { await act(async () => element.click()); };
const commands = (sent: ClientMessage[]) =>
  sent.filter((message): message is Extract<ClientMessage, { kind: "scene-command" }> => message.kind === "scene-command").map((message) => message.command);

/** The fixture's film, made a visual novel: sh_12 covers narration and Maren's line, sh_13 keeps its picture. */
function visualNovel(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  production.meta = { ...production.meta, medium: "video", kind: "visual-novel" };
  const scene = production.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as {
    script?: unknown;
    shots: Array<{ id: string; covers?: unknown; beat?: unknown }>;
  };
  scene.script = {
    blocks: [
      { id: "blk_wash", kind: "action", text: "They hung the washing out the morning the water came." },
      { id: "blk_verse", kind: "dialogue", speaker: "maren-kest", text: "The verse, under the water." },
    ],
  };
  scene.shots[0]!.covers = [{ blockId: "blk_wash", textDigest: "sha256:12345678" }, { blockId: "blk_verse", textDigest: "sha256:12345678" }];
  scene.shots[1]!.beat = { samePicture: true, advance: "hold", holdSec: 5 };
  return state;
}

const plan = {
  productionId: "saltlight", sceneId: "sc_04", sceneVersion: 2, confirmationToken: `sha256:${"c".repeat(64)}`, totalEstimatedMicroUsd: 40_000,
  items: [
    { lineId: LINE_WASH, shotId: "sh_12", blockId: "blk_wash", narration: true, route: "cached", file: `.cache/voice-previews/${"a".repeat(24)}.mp3`, estimatedMicroUsd: 0 },
    { lineId: LINE_VERSE, shotId: "sh_12", blockId: "blk_verse", speakerSheetId: "maren-kest", route: "cloud", estimatedMicroUsd: 40_000 },
  ],
};

describe("a visual novel's scene reads as beats (turn 174)", () => {
  it("names the view Beats, drops Flow and boards, and shows each row's lines under their speaker", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(visualNovel(), SCENE_PATH);
    const tabs = all(mounted, ".fy-sw__tab").map((tab) => tab.textContent);
    assert.deepEqual(tabs, ["Beats", "Preview"], "a visual novel has no motion to lay out in Flow");
    assert.equal(q(mounted, ".fy-sw__boards-toggle"), null, "boards pack clips, and there are none");
    assert.match(q(mounted, ".fy-sw__coverage")?.textContent ?? "", /pictures ready/);

    const first = q(mounted, '[data-testid="workspace-row-sh_12"]')!;
    const lines = all(mounted, '[data-testid="workspace-row-sh_12"] .fy-swbeat__line');
    assert.deepEqual(lines.map((line) => [line.dataset.kind, line.querySelector(".fy-swbeat__who")?.textContent, line.querySelector(".fy-swbeat__text")?.textContent]), [
      ["narration", "Narrator", "They hung the washing out the morning the water came."],
      ["dialogue", "Maren Kest", "The verse, under the water."],
    ]);
    assert.match(first.textContent ?? "", /on tap/, "a beat nobody has set moves on with a tap");

    const second = q(mounted, '[data-testid="workspace-row-sh_13"]')!;
    assert.match(second.querySelector(".fy-swrow__same")?.textContent ?? "", /Same picture/);
    assert.match(second.textContent ?? "", /hold 5s/);
    assert.match(second.querySelector(".fy-swbeat__none")?.textContent ?? "", /picture alone/);
  });

  it("asks the table read for narration and dialogue, says what is voiced, and voices the rest at the quoted price", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(visualNovel(), SCENE_PATH);
    const asked = sent.find((message) => message.kind === "plan-table-read");
    assert.ok(asked && asked.kind === "plan-table-read", "the plan is asked on arrival");
    await act(async () => {
      __applyEventForTest({ at: "2026-09-27T10:00:00.000Z", type: "rehearsal.result", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, status: "planned", reason: "", plan } as never);
    });
    const voices = all(mounted, '[data-testid="workspace-row-sh_12"] .fy-swbeat__voice').map((voice) => voice.dataset.voice);
    assert.deepEqual(voices, ["voiced", "unvoiced"]);
    assert.match(q(mounted, ".fy-swvoice__count")?.textContent ?? "", /1 of 2 voiced/);
    const go = q(mounted, ".fy-swvoice__go") as HTMLButtonElement;
    assert.equal(go.textContent, "Voice 1 line · $0.04");
    await click(go);
    const prepare = sent.find((message) => message.kind === "prepare-table-read");
    assert.ok(prepare && prepare.kind === "prepare-table-read");
    assert.equal(prepare.confirmationToken, plan.confirmationToken);
    assert.equal(prepare.confirmedMicroUsd, 40_000, "the press confirms the price it showed");
  });

  it("asks the plan again when the narrator changes, since narration is read in the narrator's voice", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    await mountState(visualNovel(), SCENE_PATH);
    const before = sent.filter((message) => message.kind === "plan-table-read").length;
    await act(async () => {
      __applyEventForTest({ at: "2026-09-27T10:00:00.000Z", type: "narrator.changed", voice: { provider: "kokoro", model: "kokoro-82m", voiceId: "bf_emma", label: "Emma" } } as never);
    });
    assert.equal(sent.filter((message) => message.kind === "plan-table-read").length, before + 1);
  });

  it("asks the plan again when a speaker's voice changes, since their lines are read in it (codex round 8)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = visualNovel();
    await mountState(state, SCENE_PATH);
    const before = sent.filter((message) => message.kind === "plan-table-read").length;
    const next = structuredClone(state) as ClientState;
    const maren = next.world!.sheets.find((sheet) => sheet.id === "maren-kest")!;
    maren.voice = { ...maren.voice!, voiceId: "v_9Lr3", label: "High water" };
    await act(async () => { __setStateForTest(next); });
    assert.equal(sent.filter((message) => message.kind === "plan-table-read").length, before + 1);
  });

  it("the plan goes with the last line: nothing is offered for lines no longer there (codex round 10)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = visualNovel();
    const mounted = await mountState(state, SCENE_PATH);
    const asked = sent.find((message) => message.kind === "plan-table-read")!;
    await act(async () => {
      __applyEventForTest({ at: "2026-09-27T10:00:00.000Z", type: "rehearsal.result", requestId: (asked as { requestId: string }).requestId, worldId: FIXTURE_WORLD_ID, status: "planned", reason: "", plan } as never);
    });
    assert.ok(q(mounted, ".fy-swvoice__go"), "the plan offers its line");
    const next = structuredClone(state) as ClientState;
    const scene = next.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as { shots: Array<{ covers?: unknown; audio?: unknown }> };
    // No shot reads a line any more: nothing covered, nothing of its own to say.
    for (const shot of scene.shots) { delete shot.covers; delete shot.audio; }
    await act(async () => { __setStateForTest(next); });
    assert.equal(q(mounted, ".fy-swvoice") === null, true, "no count, no offer, no stale token");
  });

  it("a same-picture beat's Generate asks for the picture it shows, never a frame of its own (codex round 10)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = visualNovel();
    state.app.manifest!.models.push({
      id: "frame-image", provider: "fal", capability: "image", displayName: "Frame image",
      accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
      limits: { aspects: ["16:9"] }, pricing: { kind: "perImage", microUsdPerImage: 37_000 },
    } as never);
    const mounted = await mountState(state, SCENE_PATH);
    await click(q(mounted, '[data-testid="workspace-row-sh_13"] .fy-swrow__generate')!);
    const quote = sent.find((message) => message.kind === "frame-run-quote") as { shotId?: string } | undefined;
    assert.ok(quote, "the dialog asks its quote");
    assert.equal(quote.shotId, "sh_12");
  });

  it("asks the plan again when a voice provider is made ready, since a line it could not voice may be voiceable now (codex round 12)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = visualNovel();
    state.app.providers = [{ id: "elevenlabs", configured: true, validation: "unvalidated", probes: [], fault: null }] as never;
    await mountState(state, SCENE_PATH);
    const before = sent.filter((message) => message.kind === "plan-table-read").length;
    const next = structuredClone(state) as ClientState;
    next.app.providers = [{ id: "elevenlabs", configured: true, validation: "valid", probes: [{ capability: "voice-tts", available: true }], fault: null }] as never;
    await act(async () => { __setStateForTest(next); });
    assert.equal(sent.filter((message) => message.kind === "plan-table-read").length, before + 1);
  });

  it("a shot's accepted clip is no picture: the beat still needs one (codex round 13)", async () => {
    // The fixture's sh_12 has an accepted clip and no frame of its own.
    const mounted = await mountState(visualNovel(), SCENE_PATH);
    const band = q(mounted, '[data-testid="workspace-row-sh_12"] .fy-swrow__band')!;
    assert.notEqual(band.dataset.state, "rendered", "the clip is read by nothing");
    assert.match(band.textContent ?? "", /Needs frame/);
  });

  it("asks the plan again when a speaking character is retired, since their lines can no longer be read (codex round 13)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = visualNovel();
    await mountState(state, SCENE_PATH);
    const before = sent.filter((message) => message.kind === "plan-table-read").length;
    const next = structuredClone(state) as ClientState;
    (next.world!.sheets.find((sheet) => sheet.id === "maren-kest")! as { retired?: boolean }).retired = true;
    await act(async () => { __setStateForTest(next); });
    assert.equal(sent.filter((message) => message.kind === "plan-table-read").length, before + 1);
  });

  it("a staged rewrite of a line shows it unvoiced, and nothing is prepared over the proposal (codex round 13)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = visualNovel();
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const accepted = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const path = "productions/saltlight/scenes/04-the-verse-rises.json";
    const proposed = structuredClone(accepted) as unknown as { script: { blocks: Array<{ id: string; text: string }> } };
    proposed.script.blocks.find((block) => block.id === "blk_wash")!.text = "They took the washing in before the water came.";
    state.world!.proposals = [{
      proposal: {
        id: "pr_01J8H0000000000000000000Q2", kind: "scene-edit", summary: "A change to scene 4",
        targets: [{ path, baseVersion: accepted.version, baseHash: `sha256:${"a".repeat(64)}` }],
        baseCanonRevision: 42, reservedCanonIds: [], source: "chat:scene",
        decision: { mode: "attended", owner: { kind: "proposal-conversation", surface: "scene-workspace", targetPath: path } },
        created: "2026-08-30T12:00:00Z", draftRevision: 1,
      },
      ripple: null,
      scenes: { [path]: proposed },
    }] as never;
    const mounted = await mountState(state, SCENE_PATH);
    const asked = sent.find((message) => message.kind === "plan-table-read")!;
    await act(async () => {
      __applyEventForTest({ at: "2026-09-27T10:00:00.000Z", type: "rehearsal.result", requestId: (asked as { requestId: string }).requestId, worldId: FIXTURE_WORLD_ID, status: "planned", reason: "", plan } as never);
    });
    const lines = all(mounted, '[data-testid="workspace-row-sh_12"] .fy-swbeat__line');
    assert.equal(lines[0]!.querySelector(".fy-swbeat__text")?.textContent, "They took the washing in before the water came.");
    assert.equal((lines[0]!.querySelector(".fy-swbeat__voice") as HTMLElement).dataset.voice, "unvoiced", "the old words' audio is not the new words'");
    assert.equal(q(mounted, ".fy-swvoice") === null, true, "no preparation over staged lines");
  });

  it("Preview reads the scene in the beat player over the window, once its voices are in, and closes back to the beats", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(visualNovel(), SCENE_PATH);
    const asked = sent.length;
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Preview")!);
    assert.equal(q(mounted, ".swp, .fy-swpreview"), null, "never the film's timeline");
    assert.match(q(mounted, '[role="status"]')?.textContent ?? "", /Gathering the voices/);
    const plans = sent.slice(asked).filter((message): message is Extract<ClientMessage, { kind: "plan-table-read" }> => message.kind === "plan-table-read");
    assert.ok(plans.length > 0, "every scene's voices are asked for");
    await act(async () => {
      for (const request of plans) {
        __applyEventForTest({ at: "2026-09-27T10:00:00.000Z", type: "rehearsal.result", requestId: request.requestId, worldId: FIXTURE_WORLD_ID, status: "planned", reason: "",
          plan: request.sceneId === "sc_04" ? plan : { ...plan, sceneId: request.sceneId, items: [] } } as never);
      }
    });
    const player = q(mounted, ".bm-player")!;
    assert.ok(player, "the player takes the window");
    assert.equal(player.getAttribute("data-kind"), "beats");
    assert.equal(player.querySelector(".aip-line")?.textContent, "They hung the washing out the morning the water came.", "from this scene's first beat");
    assert.match(player.querySelector("audio")?.getAttribute("src") ?? "", /voice-previews/, "with the voice the plan has");
    const escape = new dom.window.Event("keydown", { bubbles: true }) as unknown as KeyboardEvent;
    Object.assign(escape, { key: "Escape" });
    await act(async () => { player.dispatchEvent(escape); });
    assert.equal(q(mounted, ".bm-player"), null);
    assert.equal(all(mounted, ".fy-sw__tab").find((tab) => tab.getAttribute("aria-checked") === "true")?.textContent, "Beats");
  });

  it("Play from here opens the preview on that shot's first beat (codex round 7)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(visualNovel(), `${SCENE_PATH}?shot=sh_13&view=preview`);
    await act(async () => { __connectionStatusForTest("closed"); });
    const player = q(mounted, ".bm-player")!;
    assert.ok(player, "the player opens");
    assert.equal(player.querySelectorAll(".aip-ticks > i.done").length, 3, "sh_12's two beats behind it, on sh_13's");
    assert.equal((player.querySelector(".aip-box") as HTMLElement | null)?.hidden, true, "sh_13 is the picture alone");
  });

  it("the lightbox's arrows onto a beat that keeps the picture before show that picture (codex round 7)", async () => {
    const state = visualNovel();
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    production.selections.sh_12 = { ...production.selections.sh_12!, acceptedTakeId: "tk_01J8A0000000000000000000A1" };
    const mounted = await mountState(state, SCENE_PATH);
    await click(q(mounted, '[data-testid="workspace-row-sh_12"] [aria-label="Expand image for shot 12"]')!);
    const kept = q(mounted, ".fy-swlightbox img")?.getAttribute("src");
    assert.ok(kept, "sh_12's picture");
    await click(q(mounted, '.fy-swlightbox [aria-label="Next shot"]')!);
    assert.match(q(mounted, ".fy-swlightbox")?.textContent ?? "", /shot 13/);
    assert.equal(q(mounted, ".fy-swlightbox img")?.getAttribute("src"), kept, "sh_13 keeps sh_12's picture");
  });

  it("a voice planned for another version of the scene is not the preview's: the line reads as text (codex round 9)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(visualNovel(), SCENE_PATH);
    const asked = sent.length;
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Preview")!);
    const plans = sent.slice(asked).filter((message): message is Extract<ClientMessage, { kind: "plan-table-read" }> => message.kind === "plan-table-read");
    await act(async () => {
      for (const request of plans) {
        __applyEventForTest({ at: "2026-09-27T10:00:00.000Z", type: "rehearsal.result", requestId: request.requestId, worldId: FIXTURE_WORLD_ID, status: "planned", reason: "",
          plan: request.sceneId === "sc_04" ? { ...plan, sceneVersion: 3 } : { ...plan, sceneId: request.sceneId, items: [] } } as never);
      }
    });
    const player = q(mounted, ".bm-player")!;
    assert.ok(player, "the preview still opens");
    assert.equal(player.querySelector("audio")?.hasAttribute("src"), false, "sc_04 is at version 2; a plan for 3 names another text");
  });

  it("a voice recast while the preview gathers its voices asks every scene again (codex round 11)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = visualNovel();
    // A second scene only the preview asks about: the scene page plans its own scene alone.
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    production.scenes.push({ ...structuredClone(production.scenes[0]!), id: "sc_05", number: 5, slug: "the-pier" } as never);
    const mounted = await mountState(state, SCENE_PATH);
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Preview")!);
    const askedOf = (sceneId: string) => sent.filter((message) => message.kind === "plan-table-read" && message.sceneId === sceneId).length;
    assert.equal(askedOf("sc_05"), 1, "the preview asks the other scene once");
    const next = structuredClone(state) as ClientState;
    const maren = next.world!.sheets.find((sheet) => sheet.id === "maren-kest")!;
    maren.voice = { ...maren.voice!, voiceId: "v_9Lr3", label: "High water" };
    await act(async () => { __setStateForTest(next); });
    assert.equal(askedOf("sc_05"), 2, "and again once Maren is recast, before any answer came");
  });

  it("a studio lost while the voices are asked for opens the preview as text, rather than waiting forever", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(visualNovel(), SCENE_PATH);
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Preview")!);
    assert.match(q(mounted, '[role="status"]')?.textContent ?? "", /Gathering the voices/);
    await act(async () => { __connectionStatusForTest("closed"); });
    const player = q(mounted, ".bm-player")!;
    assert.ok(player, "the player opens");
    assert.equal(player.querySelector("audio")?.hasAttribute("src"), false, "reading as text");
  });

  it("says why lines can't be voiced when nothing can prepare them", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(visualNovel(), SCENE_PATH);
    const asked = sent.find((message) => message.kind === "plan-table-read")!;
    const blocked = {
      ...plan,
      totalEstimatedMicroUsd: 0,
      items: plan.items.map((item) => ({ ...item, route: "unavailable" as const, file: undefined, estimatedMicroUsd: 0,
        reason: item.narration ? "Choose a supported narrator voice in Settings." : "Validate this voice provider in Settings before preparation." })),
    };
    await act(async () => {
      __applyEventForTest({ at: "2026-09-27T10:00:00.000Z", type: "rehearsal.result", requestId: (asked as { requestId: string }).requestId, worldId: FIXTURE_WORLD_ID, status: "planned", reason: "", plan: JSON.parse(JSON.stringify(blocked)) } as never);
    });
    assert.equal(q(mounted, ".fy-swvoice__go"), null, "nothing to press");
    assert.match(q(mounted, '[data-testid="voice-lines-blocked"]')?.textContent ?? "", /2 can’t be voiced: Choose a supported narrator voice in Settings\. Validate this voice provider/);
  });

  it("asks the plan even when no line can be voiced, so Voice lines can say what to repair (codex round 5)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = visualNovel();
    const scene = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as { script: { blocks: unknown[] }; shots: Array<{ covers?: unknown }> };
    scene.script.blocks = [{ id: "blk_gone", kind: "dialogue", speaker: "retired-sheet", text: "Nobody reads this now." }];
    scene.shots[0]!.covers = [{ blockId: "blk_gone", textDigest: "sha256:12345678" }];
    await mountState(state, SCENE_PATH);
    assert.ok(sent.some((message) => message.kind === "plan-table-read"), "the plan carries the reason the page shows");
  });

  it("a staged new beat keeping an accepted shot's picture shows that picture (codex round 5)", async () => {
    const state = visualNovel();
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const accepted = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    // A visual novel's shot is its picture: sh_12's accepted take is its frame.
    production.selections.sh_12 = { ...production.selections.sh_12!, acceptedTakeId: "tk_01J8A0000000000000000000A1" };
    const path = "productions/saltlight/scenes/04-the-verse-rises.json";
    const proposed = insertShot(accepted, { at: { after: "sh_12" }, shot: { id: "sh_999", title: "Still the quarter", description: "", beat: { samePicture: true } } });
    state.world!.proposals = [{
      proposal: {
        id: "pr_01J8H0000000000000000000Q2", kind: "scene-edit", summary: "A change to scene 4",
        targets: [{ path, baseVersion: accepted.version, baseHash: `sha256:${"a".repeat(64)}` }],
        baseCanonRevision: 42, reservedCanonIds: [], source: "chat:scene",
        decision: { mode: "attended", owner: { kind: "proposal-conversation", surface: "scene-workspace", targetPath: path } },
        created: "2026-08-30T12:00:00Z", draftRevision: 1,
      },
      ripple: null,
      scenes: { [path]: proposed },
    }] as never;
    const mounted = await mountState(state, SCENE_PATH);
    const row = q(mounted, '[data-testid="workspace-row-sh_999"]')!;
    assert.match(row.querySelector(".fy-swrow__same")?.textContent ?? "", /Same picture/);
    const kept = q(mounted, '[data-testid="workspace-row-sh_12"] .fy-swrow__img')?.getAttribute("src");
    assert.ok(kept, "sh_12 has its accepted frame");
    assert.equal(row.querySelector(".fy-swrow__img")?.getAttribute("src"), kept, "the new beat shows the picture it keeps");
  });

  it("a film's scene page is as it was", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(FIXTURE_STATE, SCENE_PATH);
    assert.deepEqual(all(mounted, ".fy-sw__tab").map((tab) => tab.textContent), ["Storyboard", "Flow", "Preview"]);
    assert.equal(q(mounted, '[data-testid="beat-lines"]'), null);
    assert.equal(q(mounted, ".fy-swvoice"), null);
    assert.equal(sent.some((message) => message.kind === "plan-table-read"), false, "nothing asks a film's table read on the storyboard");
  });
});

describe("a visual novel's production dashboard (codex round 11)", () => {
  it("counts pictures, as the beats read them, and sends a gap to the beats rather than to clips", async () => {
    const state = visualNovel();
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const shots = production.scenes.flatMap((scene) => (scene as unknown as { shots: unknown[] }).shots).length;
    production.selections.sh_12 = { ...production.selections.sh_12!, acceptedTakeId: "tk_01J8A0000000000000000000A1" };
    const mounted = await mountState(state, `/w/${FIXTURE_WORLD_ID}/p/saltlight`);
    const text = q(mounted, '[data-screen="production-dashboard"]')?.textContent ?? "";
    // sh_12's still, and sh_13 keeping it: two pictures, though neither has an accepted clip.
    assert.match(text, new RegExp(`2 of ${shots} pictures ready`));
    assert.doesNotMatch(text, /no clip yet|Latest clips/);
    if (shots > 2) assert.ok(all(mounted, "button").some((button) => button.textContent === "Open the beats"), "a gap opens its scene's beats");
  });
});

describe("the Beat card on a visual novel's shot page (turn 174, 174c)", () => {
  it("shows the shot's lines and writes how the beat moves on and how its picture moves", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    __connectionStatusForTest("open");
    const mounted = await mountState(visualNovel(), `${SCENE_PATH}/shots/sh_12`);
    const card = q(mounted, 'section[aria-label="Beat"]')!;
    assert.ok(card, "the Beat card leads the page");
    assert.equal(all(mounted, ".fy-shot__section")[0], card, "before the Script");
    assert.equal(card.querySelectorAll(".fy-swbeat__line").length, 2);

    const advance = [...card.querySelectorAll('[aria-label="Advance"] button')] as unknown as HTMLButtonElement[];
    assert.deepEqual(advance.map((button) => [button.textContent, button.getAttribute("aria-pressed")]), [["After the voice", "false"], ["On tap", "true"], ["Hold", "false"]]);
    await click(advance[0]!);
    assert.deepEqual(commands(sent), [{ kind: "edit-shot", shotId: "sh_12", change: { beat: { advance: "voice" } } }]);
  });

  it("writes how the picture moves, keeping the beat's other fields", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = visualNovel();
    const scene = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as { shots: Array<{ beat?: unknown }> };
    scene.shots[0]!.beat = { advance: "voice" };
    const mounted = await mountState(state, `${SCENE_PATH}/shots/sh_12`);
    const movement = [...q(mounted, 'section[aria-label="Beat"]')!.querySelectorAll('[aria-label="Movement"] button')] as unknown as HTMLButtonElement[];
    assert.equal(movement.find((button) => button.getAttribute("aria-pressed") === "true")?.textContent, "Slow push", "a slow push until told otherwise");
    await click(movement.find((button) => button.textContent === "None")!);
    assert.deepEqual(commands(sent), [{ kind: "edit-shot", shotId: "sh_12", change: { beat: { advance: "voice", motion: "none" } } }]);
  });

  it("unticking the last beat field clears the beat rather than writing an empty one", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = visualNovel();
    const scene = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as { shots: Array<{ beat?: unknown }> };
    scene.shots[1]!.beat = { samePicture: true };
    const mounted = await mountState(state, `${SCENE_PATH}/shots/sh_13`);
    const card = q(mounted, 'section[aria-label="Beat"]')!;
    const box = card.querySelector('input[type="checkbox"]') as HTMLInputElement;
    assert.equal(box.checked, true);
    // linkedom does not toggle a checkbox on click, so the change goes to React's own handler.
    const key = Object.keys(box).find((candidate) => candidate.startsWith("__reactProps$"))!;
    await act(async () => { (box as unknown as Record<string, { onChange: (event: { target: { checked: boolean } }) => void }>)[key]!.onChange({ target: { checked: false } }); });
    assert.deepEqual(commands(sent), [{ kind: "edit-shot", shotId: "sh_13", change: {}, clear: ["beat"] }]);
  });

  it("a same-picture flag left on the scene's first shot can still be cleared", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = visualNovel();
    const scene = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as { shots: Array<{ beat?: unknown }> };
    scene.shots[0]!.beat = { samePicture: true };
    const mounted = await mountState(state, `${SCENE_PATH}/shots/sh_12`);
    const box = q(mounted, 'section[aria-label="Beat"] input[type="checkbox"]') as HTMLInputElement;
    assert.equal(box.checked, true);
    assert.equal(box.disabled, false, "clearable, though nothing comes before it");
  });

  it("a beat that keeps the picture before shows that picture on its page and in the filmstrip (codex round 6)", async () => {
    const state = visualNovel();
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    production.selections.sh_12 = { ...production.selections.sh_12!, acceptedTakeId: "tk_01J8A0000000000000000000A1" };
    const mounted = await mountState(state, `${SCENE_PATH}/shots/sh_13`);
    const kept = "productions/saltlight/takes/tk_01J8A0000000000000000000A1/frame.png";
    assert.match(q(mounted, ".fy-shot__img")?.getAttribute("src") ?? "", new RegExp(kept.replaceAll("/", "(/|%2F)")), "sh_12's picture, not sh_13's own");
    assert.match(q(mounted, ".fy-shot__same")?.textContent ?? "", /Same picture/);
    const thumbs = all(mounted, ".fy-shot__thumb img").map((img) => img.getAttribute("src"));
    assert.equal(thumbs.length, 2, "both thumbs show the one picture");
    assert.equal(thumbs[0], thumbs[1]);
  });

  it("a film's shot page has no Beat card", async () => {
    const mounted = await mountState(FIXTURE_STATE, `${SCENE_PATH}/shots/sh_12`);
    assert.equal(q(mounted, 'section[aria-label="Beat"]'), null);
  });
});

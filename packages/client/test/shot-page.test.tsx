import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, useLocation } from "react-router";
import { deleteShot, insertShot, orderedShots, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyEventForTest, __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The shot as a page (design turn 145, 145b–145e): the route 97's Advanced sheet used, now the
 * shot's home — the filmstrip, Shot · Stage, the frame whole beside the eight sections, and the
 * dock about the shot. Same harness as scene-workspace.test.tsx.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), {
  pause() {},
  play: () => Promise.resolve(),
});
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
const SHOT_PATH = `${SCENE_PATH}/shots/sh_12`;

interface Mounted {
  container: HTMLElement;
  root: Root;
}

const open: Mounted[] = [];

/** Where the router is, for the tests that care what the address says. */
let where = "";
function Where() {
  const location = useLocation();
  where = `${location.pathname}${location.search}`;
  return null;
}

async function mountState(state: ClientState = FIXTURE_STATE, path = SHOT_PATH): Promise<Mounted> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <App />
      </MemoryRouter>,
    );
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
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as ArkeBridge;
}

const q = (m: Mounted, selector: string): HTMLElement | null =>
  m.container.querySelector(selector) as HTMLElement | null;
const all = (m: Mounted, selector: string): HTMLElement[] =>
  [...m.container.querySelectorAll(selector)] as unknown as HTMLElement[];
const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => element.click());
};
const buttons = (scope: Element): HTMLButtonElement[] =>
  [...scope.querySelectorAll("button")] as unknown as HTMLButtonElement[];
const byText = (scope: Element, text: string): HTMLButtonElement =>
  buttons(scope).find((button) => button.textContent?.trim() === text)!;
const props = <T,>(element: Element): T => {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, T>)[key]!;
};
const chooseOption = async (element: HTMLElement, value: string): Promise<void> => {
  await act(async () => props<{ onChange: (event: { target: { value: string } }) => void }>(element).onChange({ target: { value } }));
};
const blurInput = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    input.value = value;
    props<{ onBlur?: (event: { currentTarget: HTMLInputElement }) => void }>(input).onBlur?.({ currentTarget: input });
  });
};
const commands = (sent: ClientMessage[]) =>
  sent.filter((message): message is Extract<ClientMessage, { kind: "scene-command" }> => message.kind === "scene-command").map((message) => message.command);

type SceneShape = {
  version: number;
  defaults?: Record<string, string>;
  shots: Array<{ id: string; number: number; title: string; description: string; durationSec: number; framing?: Record<string, string>; promptOverride?: { text: string; sheetVersions: Record<string, never> }; notes?: string; staging?: unknown }>;
};

/** The fixture with one attended scene-edit proposal staged over sc_04, drafted by `mutate`. */
function withProposal(mutate: (accepted: Parameters<typeof insertShot>[0]) => ReturnType<typeof insertShot>): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  const accepted = production.scenes.find((candidate) => candidate.id === "sc_04")!;
  const path = "productions/saltlight/scenes/04-the-verse-rises.json";
  state.world!.proposals = [{
    proposal: {
      id: "pr_01J8H0000000000000000000Q2",
      kind: "scene-edit",
      summary: "A change to scene 4",
      targets: [{ path, baseVersion: accepted.version, baseHash: `sha256:${"a".repeat(64)}` }],
      baseCanonRevision: 42,
      reservedCanonIds: [],
      source: "chat:scene",
      decision: { mode: "attended", owner: { kind: "proposal-conversation", surface: "scene-workspace", targetPath: path } },
      created: "2026-08-30T12:00:00Z",
      draftRevision: 1,
    },
    ripple: null,
    scenes: { [path]: mutate(accepted) },
  }] as never;
  return state;
}

function sceneOf(state: ClientState): SceneShape {
  const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  return production.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as SceneShape;
}

describe("the shot page (design turn 145)", () => {
  it("holds the shot: the breadcrumb to the scene, the title, the filmstrip, Shot · Stage, the eight sections in order, and the dock about the shot", async () => {
    const mounted = await mountState();
    const page = q(mounted, '[data-testid="shot-page"]')!;
    assert.ok(page, "the route lands on the page, not the old sheet");
    assert.equal(page.querySelector(".fy-shot__crumb")?.textContent, "Scene 4 · The verse rises", "the breadcrumb ends on the scene");
    assert.match(page.querySelector("h1")?.textContent ?? "", /^Shot 12 · Maren at the rail, listening/);
    const thumbs = all(mounted, ".fy-shot__thumb");
    assert.deepEqual(thumbs.map((thumb) => thumb.getAttribute("aria-label")), ["Shot 12 · Maren at the rail, listening", "Shot 13 · The lamps answer"]);
    assert.equal(thumbs[0]!.getAttribute("aria-current"), "true", "the open shot is ringed");
    assert.equal(q(mounted, ".fy-shot__count")?.textContent, "Shot 1 of 2");
    assert.deepEqual(all(mounted, ".fy-sw__tab").map((tab) => tab.textContent), ["Shot", "Stage"]);
    assert.equal(q(mounted, '.fy-sw__tab[data-on="true"]')?.textContent, "Shot");
    assert.deepEqual(
      all(mounted, ".fy-shot__fields > section").map((section) => section.querySelector(".fy-shot__sectionname")?.textContent),
      ["Script", "Frame prompt", "Notes", "Camera", "Timing", "Continuity", "Sound", "Props"],
    );
    assert.equal(q(mounted, ".fy-shot__state")?.textContent, "Clip accepted", "shot 12 is rendered: an accepted clip, so no frame is asked for");
    assert.equal(q(mounted, ".fy-sw__actions .ui-btn")?.textContent, "Generate frame", "and the primary still offers a frame of its own");
    assert.match(q(mounted, ".fy-arke")?.textContent ?? "", /Arke · Shot 12/);
    assert.equal(q(mounted, ".fy-sw__back")?.textContent?.trim(), "Back to scene →");
    assert.equal(q(mounted, ".fy-swstage__head"), null, "no stepper line: the filmstrip steps");
  });

  it("a shot with no frame says so, offers Generate frame, and reads the scene's camera until set", async () => {
    const mounted = await mountState(FIXTURE_STATE, `${SCENE_PATH}/shots/sh_13`);
    assert.equal(q(mounted, ".fy-shot__state")?.textContent, "Needs frame");
    assert.equal(q(mounted, ".fy-sw__actions .ui-btn")?.textContent, "Generate frame");
    assert.equal(q(mounted, '.fy-shot__frame[data-empty="true"]') !== null, true, "the dashed slot at the frame's size");
    const size = q(mounted, 'select[aria-label="Shot size"]') as HTMLSelectElement | null;
    assert.equal(size?.value, "", "nothing set on the shot");
    assert.equal(size?.querySelector("option")?.textContent, "from scene");
    assert.equal(q(mounted, '.fy-shot__field[data-own]'), null, "no field carries the override dot");
  });

  it("the filmstrip and the arrow keys step between shots and keep the view", async () => {
    const mounted = await mountState(FIXTURE_STATE, `${SHOT_PATH}?view=stage`);
    assert.equal(q(mounted, '.fy-sw__tab[data-on="true"]')?.textContent, "Stage");
    assert.ok(q(mounted, '[data-testid="workspace-stage"]'), "the Stage is the page's second view");
    await click(q(mounted, '.fy-shot__step[aria-label="Next shot"]')!);
    assert.match(q(mounted, "h1")?.textContent ?? "", /^Shot 13/);
    assert.equal(q(mounted, '.fy-sw__tab[data-on="true"]')?.textContent, "Stage", "stepping keeps the view");
    assert.equal((q(mounted, '.fy-shot__step[aria-label="Next shot"]') as HTMLButtonElement).disabled, true, "the last shot has no next");
    const strip = q(mounted, ".fy-shot__strip")!;
    const left = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(left, "key", { value: "ArrowLeft" });
    await act(async () => strip.dispatchEvent(left));
    assert.match(q(mounted, "h1")?.textContent ?? "", /^Shot 12/);
    await click(q(mounted, ".fy-shot__thumbs li:last-child .fy-shot__thumb")!);
    assert.match(q(mounted, "h1")?.textContent ?? "", /^Shot 13/);
  });

  it("camera fields say where their value comes from: a scene default reads as from scene, a shot's own carries the dot", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    sceneOf(state).defaults = { size: "Wide" };
    sceneOf(state).shots[0]!.framing = { lens: "50mm" };
    const mounted = await mountState(state);
    const size = q(mounted, 'select[aria-label="Shot size"]') as HTMLSelectElement;
    assert.equal(size.querySelector("option")?.textContent, "Wide · from scene");
    assert.equal(size.value, "");
    const lens = q(mounted, 'select[aria-label="Shot lens"]') as HTMLSelectElement;
    assert.equal(lens.value, "50mm");
    assert.equal(lens.closest(".fy-shot__field")?.getAttribute("data-own"), "true");
    assert.equal(lens.closest(".fy-shot__field")?.querySelector(".fy-shot__dot")?.getAttribute("title"), "overrides the scene");
  });

  it("the first shot's continuity switches are inert; the second's name the shot before", async () => {
    const first = await mountState();
    const switches = all(first, ".fy-shot__check");
    assert.deepEqual(switches.map((label) => label.textContent), ["Opens on the previous shot’s last frame", "Continues the previous shot"]);
    assert.ok(switches.every((label) => (label.querySelector("input") as HTMLInputElement).disabled));
    await act(async () => first.root.unmount());
    first.container.remove();
    open.splice(open.indexOf(first), 1);
    const second = await mountState(FIXTURE_STATE, `${SCENE_PATH}/shots/sh_13`);
    const later = all(second, ".fy-shot__check");
    assert.deepEqual(later.map((label) => label.textContent), ["Opens on shot 12’s last frame", "Continues shot 12"]);
    assert.ok(later.every((label) => !(label.querySelector("input") as HTMLInputElement).disabled));
  });

  it("Rebuild is offered only once there is something behind it, and an authored prompt says so", async () => {
    const plain = await mountState();
    const rebuild = byText(plain.container, "Rebuild");
    assert.equal(rebuild.getAttribute("title"), "Rebuild from the script, references and camera");
    assert.equal(rebuild.disabled, true, "nothing to rebuild while the prompt is the assembled one");
    assert.equal(q(plain, ".fy-shot__tag"), null);
    await act(async () => plain.root.unmount());
    plain.container.remove();
    open.splice(open.indexOf(plain), 1);
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    sceneOf(state).shots[0]!.promptOverride = { text: "A hand-written prompt", sheetVersions: {} };
    const authored = await mountState(state);
    assert.equal(byText(authored.container, "Rebuild").disabled, false, "a stored override is something to rebuild from");
    assert.equal(q(authored, ".fy-shot__tag")?.textContent, "Authored");
    assert.equal((q(authored, 'textarea[aria-label="Frame prompt for shot 12"]') as HTMLTextAreaElement).value, "A hand-written prompt");
    assert.equal(byText(authored.container, "View full prompt").getAttribute("aria-pressed"), "false");
    await click(byText(authored.container, "View full prompt"));
    assert.equal(q(authored, ".fy-shot__prompt")?.getAttribute("data-whole"), "true");
  });

  it("rebuilds a dirty prompt without saving the draft first, and a blur out of the card writes it", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    sceneOf(state).shots[0]!.promptOverride = { text: "A hand-written prompt", sheetVersions: {} };
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(state);
    const card = q(mounted, '.fy-shot__section[aria-label="Frame prompt"]')!;
    const textarea = card.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      textarea.value = "A dirty draft that must not land";
      props<{ onChange: (event: { target: HTMLTextAreaElement }) => void }>(textarea).onChange({ target: textarea });
    });
    const rebuild = byText(card, "Rebuild");
    const movingInside = new dom.window.Event("focusout", { bubbles: true });
    Object.defineProperty(movingInside, "relatedTarget", { value: rebuild });
    await act(async () => card.dispatchEvent(movingInside));
    assert.equal(commands(sent).length, 0, "moving from the prompt to Rebuild does not commit the draft");
    await click(rebuild);
    assert.deepEqual(commands(sent), [{ kind: "set-prompt-override", shotId: "sh_12", text: null }]);
    assert.notEqual(textarea.value, "A dirty draft that must not land");
    assert.notEqual(textarea.value, "A hand-written prompt", "the assembled prompt is visible while the clear is pending");
  });

  it("a blur out of the prompt's card writes the draft as the override, and the same words as the assembled prompt write none", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState();
    const card = q(mounted, '.fy-shot__section[aria-label="Frame prompt"]')!;
    const textarea = card.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      textarea.value = "Maren at the rail, the lamp behind her.";
      props<{ onChange: (event: { target: HTMLTextAreaElement }) => void }>(textarea).onChange({ target: textarea });
    });
    await act(async () => card.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
    assert.deepEqual(commands(sent), [{ kind: "set-prompt-override", shotId: "sh_12", text: "Maren at the rail, the lamp behind her.", capability: "video" }]);
    assert.equal(textarea.value, "Maren at the rail, the lamp behind her.", "the draft stays on screen while the write is in flight");
  });

  it("the reference chips say what a character brings: voice · look where she speaks, look where only cited, nothing for the place; the door opens the dialog (SPEC-044 R-22)", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    state.world!.sheets.push({ id: "bray-half-hitch", type: "character", name: "Bray Half-Hitch", version: 2, status: "draft", canonRules: [], links: [], created: "2026-05-02", updated: "2026-05-02", sections: [] } as never);
    sceneOf(state).shots[1]!.description += " @bray-half-hitch on the stair";
    const words = (m: Mounted) => all(m, ".fy-shot__ref").map((chip) => chip.querySelector(".fy-shot__refwords")?.textContent ?? null);
    const later = await mountState(state, `${SCENE_PATH}/shots/sh_13`);
    assert.deepEqual(words(later), ["look"], "cited in shot 13, silent there");
    await act(async () => later.root.unmount());
    later.container.remove();
    open.splice(open.indexOf(later), 1);
    const first = await mountState(state);
    assert.match(q(first, ".fy-shot__refs")?.textContent ?? "", /Maren Kest.*The Vigil/);
    assert.deepEqual(words(first), ["voice · look", null], "she speaks in shot 12 and is cited; the place brings no words");
    assert.equal(q(first, ".fy-shot__ref--door")?.getAttribute("aria-haspopup"), "dialog");
    await click(q(first, ".fy-shot__ref--door")!);
    assert.equal(q(first, ".fy-chardialog")?.getAttribute("aria-label"), "Maren Kest in scene 4");
  });

  it("every editor writes one named scene command where it stands", async () => {
    const cases: Array<[string, (m: Mounted) => Promise<void>, unknown]> = [
      ["the script on blur", async (m) => {
        const editor = q(m, 'textarea[aria-label="Script for shot 12"]') as HTMLTextAreaElement;
        await act(async () => {
          editor.value = "@maren-kest lets go of the rail.";
          props<{ onChange: (event: { target: HTMLTextAreaElement }) => void }>(editor).onChange({ target: editor });
        });
        await act(async () => q(m, ".fy-shot__script")!.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
      }, { kind: "edit-shot", shotId: "sh_12", change: { description: "@maren-kest lets go of the rail." } }],
      ["a camera select", async (m) => { await chooseOption(q(m, 'select[aria-label="Shot angle"]')!, "Low angle"); },
        { kind: "edit-shot", shotId: "sh_12", change: { framing: { angle: "Low angle" } } }],
      ["the duration stepper", async (m) => { await click(q(m, 'button[aria-label="Longer"]')!); },
        { kind: "edit-shot", shotId: "sh_12", change: { durationSec: 4.5 } }],
      ["a note on blur", async (m) => { await blurInput(q(m, 'textarea[aria-label="Notes for shot 12"]') as unknown as HTMLInputElement, "Hold on her hands."); },
        { kind: "edit-shot", shotId: "sh_12", change: { notes: "Hold on her hands." } }],
      ["keep out of frame", async (m) => { await blurInput(q(m, 'input[aria-label="Keep out of frame"]') as HTMLInputElement, "Modern boats"); },
        { kind: "edit-shot", shotId: "sh_12", change: { continuity: { keepOut: "Modern boats" } } }],
      ["a sound field, keeping the kind", async (m) => { await blurInput(q(m, 'input[aria-label="Sound · ambience"]') as HTMLInputElement, "Water under the boards"); },
        { kind: "edit-shot", shotId: "sh_12", change: { audio: { kind: "vo", speaker: "maren-kest", line: "the verse, under the water", ambience: "Water under the boards" } } }],
      ["the intent", async (m) => { await blurInput(q(m, 'input[placeholder="How it should feel"]') as HTMLInputElement, "Small figure, large silence."); },
        { kind: "edit-shot", shotId: "sh_12", change: { intent: "Small figure, large silence." } }],
      ["the title behind its pencil", async (m) => {
        await click(q(m, 'button[aria-label="Edit title for shot 12"]')!);
        await blurInput(q(m, 'input[aria-label="Title for shot 12"]') as HTMLInputElement, "Maren lets go");
      }, { kind: "edit-shot", shotId: "sh_12", change: { title: "Maren lets go" } }],
    ];
    for (const [name, drive, expected] of cases) {
      const sent: ClientMessage[] = [];
      __setBridgeForTest(capture(sent));
      const mounted = await mountState();
      await drive(mounted);
      assert.deepEqual(commands(sent), [expected], name);
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
      open.splice(open.indexOf(mounted), 1);
    }
  });

  it("the Stage view carries the staging's words on the view row, and Back to scene lands on the scene with the shot selected", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    sceneOf(state).shots[0]!.staging = { version: 3, cast: [], sets: [], keys: [{ t: 0, p: [0, 1.5, 4], l: [0, 1, 0] }, { t: 4, p: [0, 1.5, 2], l: [0, 1, 0] }] };
    const mounted = await mountState(state);
    await click(byText(q(mounted, ".fy-sw__tabs")!, "Stage"));
    assert.match(q(mounted, ".fy-shot__staging")?.textContent ?? "", /^v3 · 2 keys · /);
    assert.ok(q(mounted, '.fy-sw__full[aria-label="Full screen"]'), "full screen from the glyph on the view row");
    await click(byText(q(mounted, ".fy-sw__tabs")!, "Shot"));
    await click(q(mounted, ".fy-sw__back")!);
    const band = q(mounted, '.fy-swrow__band[data-shot-id="sh_12"]');
    assert.ok(q(mounted, '[data-testid="workspace-rows"]'), "back on the scene");
    assert.equal(band?.dataset.selected, "true", "with the shot selected");
  });

  it("Play from here opens the scene's Preview on the shot it names (codex round 1)", async () => {
    const mounted = await mountState(FIXTURE_STATE, `${SCENE_PATH}/shots/sh_13`);
    await act(async () => { q(mounted, ".fy-shot__menu")!.setAttribute("open", ""); });
    await click(byText(q(mounted, ".fy-shot__menupanel")!, "Play from here"));
    assert.equal(q(mounted, '.fy-sw__tab[data-on="true"]')?.textContent, "Preview");
    assert.equal(q(mounted, '.fy-swpreview__filmstrip [data-current="true"]')?.getAttribute("aria-label"), "Seek to shot 13", "the clock opens at the named shot, not at the scene's start");
  });

  it("Escape restores the title without writing, and Enter writes it once (codex round 1)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState();
    await click(q(mounted, 'button[aria-label="Edit title for shot 12"]')!);
    const input = q(mounted, 'input[aria-label="Title for shot 12"]') as HTMLInputElement;
    await act(async () => {
      input.value = "A title nobody wanted";
      props<{ onChange: (event: { target: HTMLInputElement }) => void }>(input).onChange({ target: input });
    });
    // The unmount blurs the input with its edited value still on the node; the handler is taken
    // before the key, as the browser holds it, since React drops the props on unmount.
    const blur = props<{ onBlur: (event: { currentTarget: HTMLInputElement }) => void }>(input).onBlur;
    const escape = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    await act(async () => input.dispatchEvent(escape));
    await act(async () => blur({ currentTarget: input }));
    assert.deepEqual(commands(sent), [], "Escape commits nothing, not even through the blur that follows it");
    assert.equal(q(mounted, 'input[aria-label="Title for shot 12"]'), null);
    await click(q(mounted, 'button[aria-label="Edit title for shot 12"]')!);
    const again = q(mounted, 'input[aria-label="Title for shot 12"]') as HTMLInputElement;
    await act(async () => {
      again.value = "Maren lets go";
      props<{ onChange: (event: { target: HTMLInputElement }) => void }>(again).onChange({ target: again });
    });
    const blurAgain = props<{ onBlur: (event: { currentTarget: HTMLInputElement }) => void }>(again).onBlur;
    const enter = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(enter, "key", { value: "Enter" });
    await act(async () => again.dispatchEvent(enter));
    await act(async () => blurAgain({ currentTarget: again }));
    assert.deepEqual(commands(sent), [{ kind: "edit-shot", shotId: "sh_12", change: { title: "Maren lets go" } }], "Enter writes once; the blur after it writes nothing");
  });

  it("a generator handoff answered after stepping the filmstrip still opens the session (codex round 1)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    __connectionStatusForTest("open");
    const mounted = await mountState();
    await act(async () => { q(mounted, ".fy-shot__menu")!.setAttribute("open", ""); });
    await click(byText(q(mounted, ".fy-shot__menupanel")!, "Open in generator"));
    const request = sent.find((message): message is Extract<ClientMessage, { kind: "bench-open-subject" }> => message.kind === "bench-open-subject");
    assert.ok(request, "the request went out");
    await click(q(mounted, '.fy-shot__step[aria-label="Next shot"]')!);
    assert.match(q(mounted, "h1")?.textContent ?? "", /^Shot 13/);
    await act(async () => __applyEventForTest({ type: "bench.subject-opened", at: "2026-09-12T10:00:00.000Z", worldId: FIXTURE_WORLD_ID, requestId: request.requestId, sessionId: "sess_01J8F3K2QW9VZX4N7M0RTYB6HE" }));
    assert.ok(q(mounted, '[data-screen="bench"]'), "the answer opened the session it made");
  });

  it("Play from here is read once and taken out of the address (codex round 2)", async () => {
    const mounted = await mountState(FIXTURE_STATE, `${SCENE_PATH}?shot=sh_13&view=preview`);
    assert.equal(q(mounted, '.fy-sw__tab[data-on="true"]')?.textContent, "Preview");
    assert.doesNotMatch(where, /view=preview/, "the one-shot door is not a bookmark");
    assert.match(where, /shot=sh_13/, "the selection stays in the address");
  });

  it("the lightbox stays open while its arrows walk the scene (codex round 2)", async () => {
    // The fixture's shot 12 has a clip accepted, not a frame; Expand wants a frame, so the frame
    // take stands in as the accepted one here.
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    production.selections["sh_12"] = { acceptedTakeId: "tk_01J8A0000000000000000000A1" } as never;
    const mounted = await mountState(state);
    await click(q(mounted, 'button[aria-label="Expand image for shot 12"]')!);
    assert.ok(q(mounted, ".fy-swlightbox"), "the lightbox opened on shot 12");
    await click(q(mounted, '.fy-swlightbox [aria-label="Next shot"]')!);
    assert.match(q(mounted, "h1")?.textContent ?? "", /^Shot 13/, "the arrow opened the neighbour's page");
    assert.ok(q(mounted, ".fy-swlightbox"), "and the lightbox is still open on it");
  });

  it("a blur after an Escape-cancelled edit still writes the next rename (codex round 2)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState();
    await click(q(mounted, 'button[aria-label="Edit title for shot 12"]')!);
    const first = q(mounted, 'input[aria-label="Title for shot 12"]') as HTMLInputElement;
    const escape = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    // A browser that fires no blur for an input removed in its own key handler leaves the guard
    // set; the next session must start clear.
    await act(async () => first.dispatchEvent(escape));
    await click(q(mounted, 'button[aria-label="Edit title for shot 12"]')!);
    await blurInput(q(mounted, 'input[aria-label="Title for shot 12"]') as HTMLInputElement, "Maren, listening");
    assert.deepEqual(commands(sent), [{ kind: "edit-shot", shotId: "sh_12", change: { title: "Maren, listening" } }]);
  });

  it("a staged proposal reaches the page's dock as the decision it is, and a proposal that removes the routed shot leaves the page on the accepted record (codex round 2)", async () => {
    const added = await mountState(withProposal((accepted) => insertShot(accepted, { at: { after: orderedShots(accepted).at(-1)!.id }, shot: { id: "sh_999", title: "Maren hears it land", description: "She does not move." } })));
    assert.ok(all(added, "button").some((button) => button.textContent === "Accept"), "Accept stands in the dock, as on the scene page");
    assert.match(q(added, '[aria-label="Changes to scene 4"]')?.textContent ?? "", /Maren hears it land/);
    assert.equal(all(added, ".fy-shot__thumb").length, 3, "the filmstrip shows the staged scene");
    assert.equal(q(added, ".fy-sw__save")?.textContent, "Changes awaiting review");
    await act(async () => added.root.unmount());
    added.container.remove();
    open.splice(open.indexOf(added), 1);

    const removed = await mountState(withProposal((accepted) => deleteShot(accepted, { shotId: "sh_12" })));
    assert.match(q(removed, "h1")?.textContent ?? "", /^Shot 12 · Maren at the rail, listening/, "the page reads the accepted record while the proposal removes its shot");
    assert.match(q(removed, ".fy-arke")?.textContent ?? "", /Arke · Shot 12/, "and the dock is about the same shot");
    assert.match(q(removed, '[aria-label="Changes to scene 4"]')?.textContent ?? "", /Maren at the rail, listening/);
    await click(byText(q(removed, ".fy-sw__tabs")!, "Stage"));
    assert.ok(q(removed, '[data-testid="workspace-stage"]'), "the Stage opens");
    assert.match(q(removed, "h1")?.textContent ?? "", /^Shot 12/, "on the same shot (codex round 3)");
    assert.equal(q(removed, ".fy-shot__staging")?.textContent, "Not staged", "reading shot 12's staging, not the first remaining shot's");
  });

  it("a write sent before a step of the filmstrip is still the one in flight on the next shot (codex round 3)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState();
    await chooseOption(q(mounted, 'select[aria-label="Shot angle"]')!, "Low angle");
    assert.equal(commands(sent).length, 1, "the first edit went out");
    assert.equal(q(mounted, ".fy-sw__save")?.textContent, "Saving…");
    await click(q(mounted, '.fy-shot__step[aria-label="Next shot"]')!);
    assert.match(q(mounted, "h1")?.textContent ?? "", /^Shot 13/);
    assert.equal(q(mounted, ".fy-sw__save")?.textContent, "Saving…", "the step does not forget the write in flight");
    await chooseOption(q(mounted, 'select[aria-label="Shot angle"]')!, "High angle");
    assert.equal(commands(sent).length, 1, "a second command against the same base is refused until the first lands");
    const landed = structuredClone(FIXTURE_STATE) as ClientState;
    sceneOf(landed).version += 1;
    await act(async () => __setStateForTest(landed));
    assert.equal(q(mounted, ".fy-sw__save")?.textContent, `Connected · v${sceneOf(landed).version}`, "the version moving releases the next write");
    await chooseOption(q(mounted, 'select[aria-label="Shot angle"]')!, "High angle");
    assert.equal(commands(sent).length, 2);
  });

  it("a shot that is not in the scene lands on the scene", async () => {
    const mounted = await mountState(FIXTURE_STATE, `${SCENE_PATH}/shots/sh_99`);
    assert.ok(q(mounted, '[data-testid="workspace-rows"]'));
    assert.equal(q(mounted, '[data-testid="shot-page"]'), null);
  });
});

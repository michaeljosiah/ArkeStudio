import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { BenchSession, ClientMessage, ClientState, DomainEvent, ManifestModel } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The generation session (SPEC-036 R-23..R-25) is the bench in the scene workspace's dress.
 *
 * Everything asserted here is keyed on `session.subject`: the header that names where you are
 * instead of offering a switcher, the two text tabs whose off tab opens the shot in the other
 * mode, the references with an eyebrow and a name beneath each tile, the prompt's own eyebrow
 * and hint, the priced model rows, the wall's track of filters and mono states, and the rail of
 * thumbnails with `take N · ready` beneath. R-23 binds the world bench to change by nothing,
 * which is why every one of these is a subject-only branch rather than a new default.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const SESSION_ID = "sess_01J8F3K2QW9VZX4N7M0RTYB6HD";
const VIDEO_SESSION_ID = "sess_01J8F3K2QW9VZX4N7M0RTYB6HE";
const TAKE_ID = "tk_01J8F3K2QW9VZX4N7M0RTYB6HN";

const IMAGE_MODEL: ManifestModel = {
  id: "test-image",
  provider: "fal",
  capability: "image",
  displayName: "Test Image",
  accepts: { referenceImages: 2, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 500 },
  pricing: { kind: "perImage", microUsdPerImage: 60000 },
};

const VIDEO_MODEL: ManifestModel = {
  id: "test-video",
  provider: "fal",
  capability: "video",
  displayName: "Test Video",
  accepts: { referenceImages: 2, referenceRoles: false, startFrame: false, endFrame: false },
  limits: {
    maxPromptChars: 500,
    maxDurationSec: 12,
    aspects: ["16:9"],
    soundChoice: true,
    durations: { "10": "10", "12": "12" },
  },
  pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
};

const CONTEXT = {
  productionId: "saltlight",
  productionTitle: "Saltlight",
  episode: { id: "ep_02", order: 2, title: "The tide-clock" },
  sceneId: "sc_04",
  sceneNumber: 4,
  sceneTitle: "The verse rises",
};

/** The production's references as the prefill names them, with one the route cannot carry and the Stage's playblast. */
const REGISTRY = [
  {
    token: "Image 1",
    kind: "image",
    source: { source: "world-file", path: "references/maren-kest/model-sheet-v4.png", hash: "sha256:deadbeef" },
    label: "Maren Kest · v4",
    detail: "@maren-kest · character reference",
    sheetId: "maren-kest",
    sheetVersion: 4,
    ride: "when-supported",
    subjectRole: "reference",
  },
  {
    token: "Audio 1",
    kind: "audio",
    source: { source: "world-file", path: "references/maren-kest/voice-sample.wav", hash: "sha256:feedface" },
    label: "voice sample · @maren-kest",
    detail: "Maren Kest · 9.0s",
    sheetId: "maren-kest",
    sheetVersion: 4,
    durationSec: 9,
    ride: "when-supported",
    subjectRole: "audio",
  },
  {
    token: "Video 1",
    kind: "video",
    source: { source: "artifact", artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6HQ", hash: "sha256:cafef00d" },
    label: "Staging · Playblast v2",
    detail: "3 keys · push in",
    durationSec: 4,
    ride: "when-supported",
    subjectRole: "reference",
  },
];

function take(mode: "image" | "video", status = "succeeded", withMedia = true) {
  return {
    id: TAKE_ID,
    n: 1,
    requestId: "subject-dispatch",
    status,
    request: {
      mode,
      brief: "Maren listens at the rail.",
      references: [],
      keyframes: [],
      provider: "fal",
      model: mode === "video" ? "test-video" : "test-image",
      params:
        mode === "video"
          ? { kind: "video", aspect: "16:9", durationSec: 10, sound: true }
          : { kind: "image", aspect: "16:9", count: 1 },
      filing:
        mode === "video"
          ? {
              kind: "board",
              productionId: "saltlight",
              sceneId: "sc_04",
              productionTakeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HJ",
              members: [
                { shotId: "sh_12", number: 12, startSec: 0, endSec: 4, takeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HK" },
                { shotId: "sh_13", number: 13, startSec: 4, endSec: 10, takeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HM" },
              ],
            }
          : {
              kind: "shot",
              productionId: "saltlight",
              sceneId: "sc_04",
              shotId: "sh_12",
              productionTakeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HJ",
              frameArtifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6HP",
            },
    },
    ...(withMedia
      ? {
          media: {
            file: mode === "video" ? "take.mp4" : "take.png",
            hash: "sha256:cafebabe",
            ...(mode === "video" ? { info: { durationSec: 10 } } : {}),
          },
        }
      : {}),
    disposition: "open",
    createdAt: "2026-08-16T10:00:00.000Z",
    completedAt: "2026-08-16T10:01:00.000Z",
  };
}

function shotSession(mode: "image" | "video" = "image", id = SESSION_ID): BenchSession {
  return {
    schemaVersion: 1,
    id,
    title: "Saltlight · Episode 2 · The tide-clock · Scene 4 · The verse rises · Shot 12",
    subject: {
      kind: "shot",
      ...CONTEXT,
      shotId: "sh_12",
      shotNumber: 12,
      shotTitle: "Maren at the rail",
      durationSec: 4,
      aspect: "16:9",
    },
    composer: {
      mode,
      provider: "fal",
      model: mode === "video" ? "test-video" : "test-image",
      params:
        mode === "video"
          ? { kind: "video", aspect: "16:9", durationSec: 4, sound: true }
          : { kind: "image", aspect: "16:9", count: 1 },
      brief: "Maren listens at the rail.",
      activeTokens: ["Image 1"],
      keyframeTokens: [],
    },
    tokenRegistry: REGISTRY,
    subjectTokens: ["Image 1", "Audio 1", "Video 1"],
    nextToken: { image: 2, audio: 2, video: 2 },
    nextTake: 2,
    selectedTakeId: TAKE_ID,
    takes: [take(mode)],
    createdAt: "2026-08-16T10:00:00.000Z",
    updatedAt: "2026-08-16T10:01:00.000Z",
  } as unknown as BenchSession;
}

function boardSession(): BenchSession {
  const base = shotSession("video");
  return {
    ...base,
    title: "Saltlight · Scene 4 · The verse rises · Board A · 2 shots · 10s · one pass",
    subject: {
      kind: "board",
      ...CONTEXT,
      letter: "A",
      durationSec: 10,
      aspect: "16:9",
      packing: { maxDurationSec: 20 },
      members: [
        { shotId: "sh_12", number: 12, title: "Maren at the rail", durationSec: 4 },
        { shotId: "sh_13", number: 13, title: "The lamps answer", durationSec: 6 },
      ],
    },
    composer: { ...base.composer, params: { kind: "video", aspect: "16:9", durationSec: 10, sound: true } },
  } as unknown as BenchSession;
}

function stateWith(session: BenchSession): ClientState {
  const base = FIXTURE_STATE;
  return {
    ...base,
    app: {
      ...base.app,
      manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, IMAGE_MODEL, VIDEO_MODEL] },
    },
    bench: { worldId: FIXTURE_WORLD_ID, session },
  } as ClientState;
}

interface Bench {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}

function bridge(sent: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => {
      sent.push(JSON.parse(json) as ClientMessage);
    },
  } as unknown as ArkeBridge;
}

const open: Bench[] = [];

async function openBench(session: BenchSession, id = SESSION_ID): Promise<Bench> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(bridge(sent));
  __setStateForTest(stateWith(session));
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${id}`]}>
        <App />
      </MemoryRouter>,
    );
  });
  const bench = { container, root, sent };
  open.push(bench);
  return bench;
}

afterEach(async () => {
  for (const bench of open.splice(0)) {
    await act(async () => bench.root.unmount());
    bench.container.remove();
  }
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest(null);
});

const q = (bench: Bench, selector: string): HTMLElement => {
  const node = bench.container.querySelector(selector) as HTMLElement | null;
  assert.ok(node, `${selector} is on screen`);
  return node;
};
const all = (bench: Bench, selector: string): HTMLElement[] =>
  [...bench.container.querySelectorAll(selector)] as unknown as HTMLElement[];
const text = (bench: Bench): string => bench.container.textContent ?? "";

async function pressLabelled(bench: Bench, label: string): Promise<void> {
  const button = [...bench.container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
  assert.ok(button, `${label} is on screen`);
  await act(async () => button.click());
}

async function apply(event: DomainEvent): Promise<void> {
  await act(async () => __applyEventForTest(event));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("the generation session's header and frame (R-24; design 2607-2615)", () => {
  it("names where you are in four parts and drops the world bench's rail and switcher", async () => {
    const bench = await openBench(shotSession());
    const header = q(bench, '[data-testid="bench-provenance"]');
    assert.equal(header.querySelector(".fy-bench__provenance")?.textContent, "Saltlight · episode 2 · scene 4");
    assert.equal(header.querySelector(".fy-bench__subjectname")?.textContent, "Shot 12");
    assert.equal(header.querySelector(".fy-bench__subjectsub")?.textContent, "Maren at the rail");
    assert.equal(header.querySelector(".fy-bench__sessionkind")?.textContent, "generation session");
    assert.equal(bench.container.querySelector(".fy-bench__session"), null, "nothing to switch between");
    assert.equal(bench.container.querySelector(".fy-bench__rail"), null, "the chrome's back is the way out");
    assert.ok(bench.container.querySelector(".fy-bench--subject"), "the subject dress is one class on the frame");
  });

  it("a board's line is its members, and it offers video alone", async () => {
    const bench = await openBench(boardSession());
    assert.equal(q(bench, ".fy-bench__subjectname").textContent, "Board A");
    assert.equal(q(bench, ".fy-bench__subjectsub").textContent, "2 shots · 10s · one pass");
    const modes = all(bench, '[aria-label="What to make"] button');
    assert.deepEqual(modes.map((button) => button.textContent), ["Video"]);
  });
});

describe("Image / Video (R-23; design 2616-2621)", () => {
  it("are two text tabs, and the off one opens the shot in that mode and moves there on the answer", async () => {
    const bench = await openBench(shotSession());
    const modes = all(bench, '[aria-label="What to make"] button');
    assert.deepEqual(modes.map((button) => button.textContent), ["Image", "Video"]);
    assert.equal(bench.container.querySelector('[aria-label="What to make"] svg'), null, "no icons");

    await pressLabelled(bench, "Video");
    const sent = bench.sent.at(-1) as unknown as Record<string, unknown>;
    assert.equal(sent.kind, "bench-open-subject");
    assert.equal(sent.productionId, "saltlight");
    assert.equal(sent.sceneId, "sc_04");
    assert.deepEqual(sent.subject, { kind: "shot", shotId: "sh_12" });
    assert.equal(sent.mode, "video");
    assert.equal(bench.sent.some((message) => message.kind === "bench-compose"), false, "no mode change on this session");

    // The coordinator broadcasts the prepared session, then answers with its id; the screen
    // is still on the old address until it does.
    await act(async () => __setStateForTest(stateWith(shotSession("video", VIDEO_SESSION_ID))));
    assert.match(text(bench), /Opening the bench/);
    await apply({
      at: "2026-08-16T10:02:00.000Z",
      type: "bench.subject-opened",
      worldId: FIXTURE_WORLD_ID,
      requestId: sent.requestId as string,
      sessionId: VIDEO_SESSION_ID,
    } as DomainEvent);
    const video = all(bench, '[aria-label="What to make"] button').find((button) => button.textContent === "Video");
    assert.equal(video?.getAttribute("aria-pressed"), "true");
    assert.match(text(bench), /sound · on/, "the chips follow the mode");
  });

  it("says why when the shot cannot be opened in the other mode", async () => {
    const bench = await openBench(shotSession());
    await pressLabelled(bench, "Video");
    const sent = bench.sent.at(-1) as unknown as { requestId: string };
    await apply({
      at: "2026-08-16T10:02:00.000Z",
      type: "bench.subject-opened",
      worldId: FIXTURE_WORLD_ID,
      requestId: sent.requestId,
      sessionId: null,
      reason: "That shot is no longer in this scene.",
    } as DomainEvent);
    assert.match(text(bench), /That shot is no longer in this scene/);
    const video = all(bench, '[aria-label="What to make"] button').find((button) => button.textContent === "Video");
    assert.equal((video as HTMLButtonElement | undefined)?.disabled, false, "and the tab is free to try again");
  });
});

describe("references (R-23; design 2623-2661)", () => {
  it("carry an eyebrow with the count, a corner index, the name beneath, and the playblast's stand-in", async () => {
    const bench = await openBench(shotSession());
    assert.equal(q(bench, '[data-testid="bench-references-eyebrow"]').textContent, "References3 referenced");
    const refs = all(bench, ".fy-bench__ref");
    assert.equal(refs.length, 3);
    assert.equal(bench.container.querySelector(".fy-bench__refcaption"), null, "no overlay of three lines");

    const [image, audio, block] = refs as [HTMLElement, HTMLElement, HTMLElement];
    assert.equal(image.querySelector(".fy-bench__tokenchip")?.textContent, "Image 1");
    assert.equal(image.querySelector(".fy-bench__reflabel")?.textContent, "Maren Kest · v4");
    assert.equal(image.querySelector(".fy-bench__refmeta")?.textContent, "@maren-kest · character reference");

    // The route cannot carry the sample: dimmed AND named as not riding, as R-23 asks.
    assert.equal(audio.getAttribute("data-riding"), "false");
    assert.equal(audio.querySelector(".fy-bench__reflabel")?.textContent, "voice sample · @maren-kest · v4");
    assert.equal(audio.querySelector(".fy-bench__refmeta")?.textContent, "Maren Kest · 9.0s · not riding");

    assert.ok(block.querySelector(".fy-bench__blockstand"), "a clip with no poster is the greybox figures");
    assert.equal(block.querySelector(".fy-bench__reflabel")?.textContent, "Staging · Playblast v2");

    const add = q(bench, '[data-testid="bench-add-reference"]');
    assert.equal(add.textContent, "reference");
    assert.ok(add.querySelector("svg path[d='M5 12h14']"), "a plus, not a picture");
  });
});

describe("the prompt and what follows it (design 2665-2686)", () => {
  it("has its eyebrow with Rebuild, the @ hint beneath, and the context chips after — with no second add", async () => {
    const bench = await openBench(shotSession());
    const prompt = all(bench, ".fy-bench__eyebrow--refs").find((node) => node.textContent?.startsWith("Prompt"));
    assert.ok(prompt, "a Prompt eyebrow");
    assert.ok(prompt.querySelector('[data-testid="bench-rebuild"]'), "with Rebuild at its right");
    assert.equal(bench.container.querySelector(".fy-bench__rebuild"), null, "and not in the mode bar");
    assert.equal(q(bench, ".fy-bench__athint").textContent, "type @ to bring in anything from the world");

    const order = all(bench, '.fy-bench__brief, [data-testid="bench-subject-context"]');
    assert.equal(order.length, 2);
    assert.ok(order[0]?.classList.contains("fy-bench__brief"), "the chips come after the words");
    assert.equal(bench.container.querySelector(".fy-bench__chip--refs"), null, "the dashed tile is the add");
  });

  it("prices every model it offers, says what the figure is for, and keeps the price on Generate (R-25)", async () => {
    const bench = await openBench(shotSession());
    assert.equal(q(bench, 'option[value="fal/test-image"]').textContent, "Test Image · ~$0.06");
    assert.equal(q(bench, '[data-testid="bench-estimate"]').textContent, "~$0.06 a take");
    const generate = q(bench, '[data-testid="bench-generate"]');
    assert.ok(generate.classList.contains("ui-btn--sm"));
    assert.equal(generate.textContent, "Generate · ~$0.06");
  });
});

describe("the wall and the rail (R-24; design 2689-2773)", () => {
  it("filters on a track without 4K, states the outcome in mono, and keeps Discard quiet", async () => {
    const bench = await openBench(boardSession());
    const filters = q(bench, ".fy-bench__filters");
    assert.deepEqual([...filters.querySelectorAll("button")].map((button) => button.textContent), ["All", "Filed", "Discarded"]);
    assert.equal(q(bench, ".fy-bench__acceptoutcome").textContent, "accepting files the clip onto 2 shots");
    const discard = [...bench.container.querySelectorAll("button")].find((button) => button.textContent === "Discard");
    assert.ok(discard?.classList.contains("ui-btn--ghost") && discard.classList.contains("ui-btn--sm"));
    assert.ok(q(bench, '[data-testid="bench-accept"]').classList.contains("ui-btn--sm"));
  });

  it("the rail stacks a thumbnail over `take N · ready`, with a play badge on a clip", async () => {
    const bench = await openBench(boardSession());
    const rail = q(bench, '[data-testid="strip-take"]');
    assert.equal(rail.querySelector(".fy-bench__takeline")?.textContent, "take 1ready");
    assert.ok(rail.querySelector(".fy-bench__takeplay"), "a clip says it plays");
    assert.equal(rail.querySelector(".fy-bench__takeframe")?.getAttribute("data-inflight"), null);
  });

  it("while a take is out: a hatched, spinning placeholder on the rail and the mono lines in the plate", async () => {
    const session = shotSession();
    const bench = await openBench({ ...session, takes: [take("image", "running", false)] } as BenchSession);
    assert.equal(q(bench, '[data-testid="bench-rendering"]').textContent, "rendering…Test Image · take 1");
    assert.equal(bench.container.querySelector("strong"), null, "no bold sans sentence");
    const frame = q(bench, ".fy-bench__takeframe");
    assert.equal(frame.getAttribute("data-inflight"), "true");
    assert.ok(frame.querySelector(".fy-bench__takespin"));
    assert.equal(q(bench, ".fy-bench__takeline").textContent, "take 1rendering");
  });

  it("with nothing made yet, the plate says so in the design's words", async () => {
    const session = shotSession();
    const bench = await openBench({ ...session, takes: [], selectedTakeId: null, nextTake: 1 } as unknown as BenchSession);
    assert.match(q(bench, ".fy-bench__empty").textContent ?? "", /no takes yet · generate to see one here/);
    assert.doesNotMatch(text(bench), /The bench is empty/);
  });
});

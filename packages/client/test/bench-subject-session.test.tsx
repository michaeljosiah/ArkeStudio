import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { orderedShots, type BenchSession, type ClientMessage, type ClientState, type DomainEvent, type ManifestModel } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The generation session (SPEC-036 R-23..R-25) is the Bench that design 142a draws, with the
 * shot named on the chrome: the subject and the session's spend as pills at the right, "Bench"
 * as the crumb, the production's rail, the same icon tabs and lanes as the world bench, one
 * dispatch row with the price as one mono figure, the wall's pills and a numbered strip. What is
 * still a subject-only branch is what a subject changes about the WORK — the other tab opens
 * the shot in that mode, Accept files onto the shot, the voice-references chip exists only where
 * the shot's cast has a voice — which is why R-23's world bench changes by nothing here.
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

async function openBench(session: BenchSession, id = SESSION_ID, configure?: (state: ClientState) => void): Promise<Bench> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(bridge(sent));
  const state = structuredClone(stateWith(session));
  configure?.(state);
  __setStateForTest(state);
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

describe("voice references (design 142: an option chip, not a disclosure)", () => {
  it("is a chip that reads the state, and a blocker is one refusal line beside a disabled Generate", async () => {
    const bench = await openBench(shotSession("video"), SESSION_ID, state => {
      state.world!.referenceKits[0]!.designatedVoiceSample = { file: "legacy.wav" } as never;
      const scene = state.world!.productions.find(p => p.meta.id === "saltlight")!.scenes.find(s => s.id === "sc_04")!;
      const shot = orderedShots(scene).find(s => s.id === "sh_12")!;
      shot.covers = undefined;
      shot.audio = { kind: "dialogue", speaker: "maren-kest", line: "Hello" };
    });
    const chip = q(bench, '[data-testid="bench-voice-refs"]');
    assert.equal(chip.textContent, "voice refs · on");
    assert.equal(chip.getAttribute("aria-pressed"), "true");
    assert.ok(chip.classList.contains("fy-bench__chip"), "among the option chips");
    assert.equal(bench.container.querySelector("details"), null, "no disclosure");
    assert.equal(bench.container.querySelector('input[type="checkbox"]'), null, "no native checkbox");
    const problem = q(bench, '[data-testid="bench-voice-problem"]');
    assert.equal(problem.getAttribute("role"), "alert");
    assert.match(problem.textContent ?? "", /assigned voice reference/);
    assert.doesNotMatch(text(bench), /guidance, not guaranteed reproduction/, "no explainer under the chip");
    const generate = q(bench, '[data-testid="bench-generate"]') as HTMLButtonElement;
    assert.equal(generate.disabled, true);
  });

  it("is absent when no cast in the shot has a voice", async () => {
    const bench = await openBench(shotSession("video"));
    assert.equal(bench.container.querySelector('[data-testid="bench-voice-refs"]'), null);
    assert.equal(bench.container.querySelector('[data-testid="bench-voice-problem"]'), null);
  });

  it("stays on the row once switched off, reading the off state, so it can be switched back on", async () => {
    const session = shotSession("video");
    const off = {
      ...session,
      composer: { ...session.composer, params: { ...session.composer.params, audioReferencesDisabled: true } },
    } as unknown as BenchSession;
    const bench = await openBench(off, SESSION_ID, state => {
      state.world!.referenceKits[0]!.designatedVoiceSample = { file: "legacy.wav" } as never;
      const scene = state.world!.productions.find(p => p.meta.id === "saltlight")!.scenes.find(s => s.id === "sc_04")!;
      const shot = orderedShots(scene).find(s => s.id === "sh_12")!;
      shot.covers = undefined;
      shot.audio = { kind: "dialogue", speaker: "maren-kest", line: "Hello" };
    });
    const chip = q(bench, '[data-testid="bench-voice-refs"]');
    assert.equal(chip.textContent, "voice refs · off");
    assert.equal(chip.getAttribute("aria-pressed"), "false");
    await act(async () => chip.click());
    const sent = bench.sent.findLast((message) => message.kind === "bench-compose") as unknown as { params: { audioReferencesDisabled?: boolean } } | undefined;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const composed = bench.sent.findLast((message) => message.kind === "bench-compose") as unknown as { params: { audioReferencesDisabled?: boolean } } | undefined;
    assert.equal((composed ?? sent)?.params.audioReferencesDisabled, false, "the press switches it back on");
  });
});

describe("the generation session's chrome and frame (design 142a)", () => {
  it("names the subject on a pill at the right, says Bench on the left, and keeps the world bench's switcher off", async () => {
    const bench = await openBench(shotSession());
    assert.equal(q(bench, '[data-testid="bench-subject-pill"]').textContent, "Shot 12 · Maren at the rail");
    assert.equal(q(bench, '[data-testid="bench-provenance"]').textContent, "/Bench");
    assert.equal(bench.container.querySelector(".fy-bench__session"), null, "nothing to switch between");
    assert.equal(bench.container.querySelector(".fy-bench__sessionkind"), null, "no fifth part on the crumb");
    // A class selector with a double dash that matches nothing spins linkedom's matcher, so the
    // markup is read as text here.
    assert.doesNotMatch(bench.container.innerHTML, /fy-bench--subject/, "one dress for the Bench");
  });

  it("wears the production's rail with the generator lit, and the production's initial on top", async () => {
    const bench = await openBench(shotSession());
    const rail = q(bench, '[aria-label="Production destinations"]');
    assert.equal(rail.querySelector(".fy-bench__railmark")?.textContent, "S");
    const marks = [...rail.querySelectorAll(".fy-bench__raildest")].map((node) => node.getAttribute("title"));
    assert.deepEqual(marks, ["Home", "Scenes", "Takes", "Files", "Arke", "Cut"]);
    const lit = [...rail.querySelectorAll('.fy-bench__raildest[aria-current="true"]')].map((node) => node.getAttribute("title"));
    assert.deepEqual(lit, ["Arke"]);
  });

  it("states the session's spend on a second pill once something was spent", async () => {
    const session = shotSession();
    const spent = { ...session, takes: [{ ...take("image"), cost: { estimatedMicroUsd: 60000, actualMicroUsd: 50000 } }] } as unknown as BenchSession;
    const bench = await openBench(spent);
    assert.equal(q(bench, '[data-testid="bench-session-spend"]').textContent, "$0.05 this session");
  });

  it("has no spend pill while nothing has been spent", async () => {
    const bench = await openBench(shotSession());
    assert.equal(bench.container.querySelector('[data-testid="bench-session-spend"]'), null);
  });

  it("a board's pill is its letter and its members, and it offers video alone", async () => {
    const bench = await openBench(boardSession());
    assert.equal(q(bench, '[data-testid="bench-subject-pill"]').textContent, "Board A · 2 shots · 10s · one pass");
    const modes = all(bench, '[aria-label="What to make"] button');
    assert.deepEqual(modes.map((button) => button.textContent), ["Video"]);
  });
});

describe("Image / Video (R-23; design 142a)", () => {
  it("are the world bench's icon tabs, and the off one opens the shot in that mode and moves there on the answer", async () => {
    const bench = await openBench(shotSession());
    const modes = all(bench, '[aria-label="What to make"] button');
    assert.deepEqual(modes.map((button) => button.textContent), ["Image", "Video"]);
    assert.equal(all(bench, '[aria-label="What to make"] button svg').length, 2, "an icon on each");
    assert.doesNotMatch(bench.container.innerHTML, /fy-bench__mode--subject/, "the same pill as the world bench");

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

  it("the bin at the bar's end rebuilds the prompt and references from the shot", async () => {
    const bench = await openBench(shotSession());
    const bin = q(bench, '.fy-bench__composerbar [data-testid="bench-rebuild"]');
    assert.match(bin.getAttribute("title") ?? "", /Clear the bench/);
    await act(async () => bin.click());
    assert.equal(bench.sent.at(-1)?.kind, "bench-rebuild-subject");
    assert.doesNotMatch(bench.container.innerHTML, /fy-bench__eyebrow--refs/, "no PROMPT eyebrow to hold a link");
  });
});

describe("references (R-23; design 142a)", () => {
  it("are tiles with the name pill, one mono line beneath, and the playblast's stand-in — no eyebrow", async () => {
    const bench = await openBench(shotSession());
    assert.equal(bench.container.querySelector('[data-testid="bench-references-eyebrow"]'), null);
    const refs = all(bench, ".fy-bench__ref");
    assert.equal(refs.length, 3);

    const [image, audio, block] = refs as [HTMLElement, HTMLElement, HTMLElement];
    assert.equal(image.querySelector(".fy-bench__tokenchip")?.textContent, "Image 1");
    assert.equal(image.querySelector(".fy-bench__refname")?.textContent, "Maren Kest · v4 · @maren-kest · character reference");

    // The route cannot carry the sample: dimmed AND named as not riding, as R-23 asks.
    assert.equal(audio.getAttribute("data-riding"), "false");
    assert.equal(audio.querySelector(".fy-bench__refname")?.textContent, "voice sample · @maren-kest · v4 · Maren Kest · 9.0s · not riding");

    assert.ok(block.querySelector(".fy-bench__blockstand"), "a clip with no poster is the greybox figures");
    assert.match(block.querySelector(".fy-bench__refname")?.textContent ?? "", /^Staging · Playblast v2/);

    const add = q(bench, '[data-testid="bench-add-reference"]');
    assert.equal(add.textContent, "Reference");
    assert.ok(add.querySelector("svg"), "with the picture mark");
  });
});

describe("the prompt, the chips and the dispatch row (design 142)", () => {
  it("has no eyebrow and no line beneath; the shot's facts lead the chips as bare values", async () => {
    const bench = await openBench(shotSession("video"));
    assert.doesNotMatch(bench.container.innerHTML, /fy-bench__eyebrow--refs/);
    assert.equal(bench.container.querySelector(".fy-bench__athint"), null);
    const order = all(bench, '.fy-bench__brief, [data-testid="bench-subject-context"]');
    assert.equal(order.length, 2);
    assert.ok(order[0]?.classList.contains("fy-bench__brief"), "the chips come after the words");
    const facts = all(bench, '[data-testid="bench-subject-context"] .fy-bench__chip')
      .filter((chip) => chip.className.includes("fy-bench__chip--fact"))
      .map((chip) => chip.textContent);
    assert.deepEqual(facts, ["4s", "16:9", "sound · on"]);
    assert.doesNotMatch(bench.container.innerHTML, /fy-bench__chip--refs/, "the dashed tile is the add");
  });

  it("names the model alone, prices it once as a mono figure, and keeps Generate at its full size", async () => {
    const bench = await openBench(shotSession());
    assert.equal(q(bench, 'option[value="fal/test-image"]').textContent, "Test Image");
    const estimate = q(bench, '[data-testid="bench-estimate"]');
    assert.equal(estimate.textContent, "~$0.06");
    assert.equal(estimate.getAttribute("title"), "a take");
    const generate = q(bench, '[data-testid="bench-generate"]');
    assert.equal(generate.classList.contains("ui-btn--sm"), false);
    assert.equal(generate.textContent, "Generate");
  });
});

describe("the wall and the strip (R-24; design 142a)", () => {
  it("filters as pills without 4K, says where Accept files on the button, and draws Discard as the outline", async () => {
    const bench = await openBench(boardSession());
    assert.equal(bench.container.querySelector(".fy-bench__filters"), null, "no track");
    assert.deepEqual(all(bench, ".fy-bench__wallbar .fy-bench__tab").map((button) => button.textContent), ["All", "Filed", "Discarded"]);
    assert.equal(bench.container.querySelector(".fy-bench__acceptoutcome"), null, "no line under the buttons");
    const discard = [...bench.container.querySelectorAll("button")].find((button) => button.textContent === "Discard");
    assert.ok(discard?.classList.contains("ui-btn--outline"));
    assert.equal(q(bench, '[data-testid="bench-accept"]').textContent, "Accept · file onto 2 shots");
  });

  it("the session line carries its four marks for the selected take", async () => {
    const bench = await openBench(boardSession());
    const marks = all(bench, ".fy-bench__briefrow .fy-bench__rowicon").map((node) => node.getAttribute("aria-label"));
    assert.deepEqual(marks, ["Run it again", "What was sent", "Not this", "Clear the wall"]);
    assert.ok(q(bench, '.fy-bench__wallbar [aria-label^="Download"]'), "a download in the bar");
  });

  it("offers no Not this while the take is still out", async () => {
    const session = shotSession();
    const bench = await openBench({ ...session, takes: [take("image", "running", false)] } as BenchSession);
    const marks = all(bench, ".fy-bench__briefrow .fy-bench__rowicon").map((node) => node.getAttribute("aria-label"));
    assert.deepEqual(marks, ["Run it again", "What was sent", "Clear the wall"]);
  });

  it("a clip on the wall wears the design's transport, not the browser's", async () => {
    const bench = await openBench(boardSession());
    assert.equal(bench.container.querySelector("video[controls]"), null);
    assert.ok(q(bench, '[data-testid="bench-transport"]'));
    assert.ok(q(bench, ".fy-bench__playdisc"));
  });

  it("the strip is a number beside a small thumbnail, with a play badge on a clip", async () => {
    const bench = await openBench(boardSession());
    const row = q(bench, '[data-testid="strip-take"]');
    assert.equal(row.querySelector(".fy-bench__taken")?.textContent, "1");
    assert.ok(row.querySelector(".fy-bench__takeplay"), "a clip says it plays");
    assert.equal(row.querySelector(".fy-bench__takeline"), null, "no words under the thumbnail");
    assert.equal(row.querySelector(".fy-bench__takeframe")?.getAttribute("data-inflight"), null);
  });

  it("while a take is out: a hatched, spinning thumbnail and the mono lines in the plate", async () => {
    const session = shotSession();
    const bench = await openBench({ ...session, takes: [take("image", "running", false)] } as BenchSession);
    assert.equal(q(bench, '[data-testid="bench-rendering"]').textContent, "rendering…Test Image · take 1");
    const frame = q(bench, ".fy-bench__takeframe");
    assert.equal(frame.getAttribute("data-inflight"), "true");
    assert.ok(frame.querySelector(".fy-bench__takespin"));
  });

  it("with nothing made yet, the plate states the fact and no more", async () => {
    const session = shotSession();
    const bench = await openBench({ ...session, takes: [], selectedTakeId: null, nextTake: 1 } as unknown as BenchSession);
    assert.equal(q(bench, ".fy-bench__empty").textContent, "No takes yet");
    assert.doesNotMatch(text(bench), /takes land here/);
    assert.doesNotMatch(text(bench), /generate to see one here/);
  });
});

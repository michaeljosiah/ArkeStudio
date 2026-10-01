import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { BenchSession, BenchTake, ClientMessage, ClientState, ManifestModel, RecipeReadiness } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { SettingsModelsScreen } from "../src/screens/settings-models.js";
import { upscaleHeld, upscaleRows } from "../src/components/bench-upscale.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/*
 * Upscale to 1080p (design turn 178, as turn 180 drew its tools): a glyph on a finished video take
 * below the size, a popover that states the frame, crop, model and measured time before the press,
 * a new take that names its source, and its own kind in Settings with this machine's rate.
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

const SESSION_ID = "sess_01J8F3K2QW9VZX4N7M0RTYB6UP";
const SOURCE_ID = "tk_01J8F3K2QW9VZX4N7M0RTYB6S1";
const UPSCALED_ID = "tk_01J8F3K2QW9VZX4N7M0RTYB6S2";

const UPSCALER: ManifestModel = {
  id: "comfyui-seedvr2-upscale",
  provider: "comfyui",
  capability: "video",
  displayName: "Local · SeedVR2",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { resolutions: ["1080p"], aspects: ["16:9", "9:16"] },
  upscale: { size: "1080p", minEngineVersion: "0.38.0" },
  pricing: { kind: "unmetered" },
};

function videoTake(id: string, n: number, width: number, height: number, extra: Partial<BenchTake> = {}): BenchTake {
  return {
    id,
    n,
    requestId: `r${n}`,
    status: "succeeded",
    request: {
      mode: "video",
      brief: "A slow camera move.",
      references: [],
      keyframes: [],
      provider: "comfyui",
      model: "comfyui-h3-video-768",
      params: { kind: "video", aspect: "16:9", durationSec: 7 },
    },
    media: { file: "output-1.mp4", hash: "sha256:00000000000000aa", info: { durationSec: 7.3, hasAudio: true, width, height } },
    disposition: "open",
    createdAt: "2026-10-01T10:00:00.000Z",
    completedAt: "2026-10-01T10:15:00.000Z",
    ...extra,
  } as BenchTake;
}

function session(takes: BenchTake[], selected = takes.at(-1)!.id): BenchSession {
  return {
    schemaVersion: 1,
    id: SESSION_ID,
    title: "Upscale",
    composer: {
      mode: "video",
      provider: "comfyui",
      model: "comfyui-h3-video-768",
      params: { kind: "video", aspect: "16:9", durationSec: 7 },
      brief: "A slow camera move.",
      activeTokens: [],
      keyframeTokens: [],
    },
    tokenRegistry: [],
    subjectTokens: [],
    nextToken: {},
    nextTake: takes.length + 1,
    selectedTakeId: selected,
    takes,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:15:00.000Z",
  } as unknown as BenchSession;
}

const upscaled = videoTake(UPSCALED_ID, 2, 1920, 1080, {
  request: {
    mode: "video", brief: "", references: [], keyframes: [], provider: "comfyui", model: UPSCALER.id,
    params: { kind: "video", aspect: "16:9", resolution: "1080p" },
    upscale: {
      sourceTakeId: SOURCE_ID as never, sourceN: 1, sourceHash: "sha256:00000000000000aa" as never, size: "1080p", aspect: "16:9",
      from: { width: 1344, height: 768 }, to: { width: 1920, height: 1080 }, crop: { edge: "top and bottom", percent: 2 },
    },
  },
});

function readiness(state: RecipeReadiness["state"], reasonKind?: RecipeReadiness["reasonKind"]): RecipeReadiness {
  return { recipeId: UPSCALER.id, recipeVersion: 1, displayName: UPSCALER.displayName, capability: "video", state,
    ...(state === "disabled" ? { reason: "Local · SeedVR2 needs ComfyUI 0.38.0 or later — this engine reports 0.33.1", reasonKind } : {}) } as RecipeReadiness;
}

function stateWith(bench: BenchSession, configure?: (state: ClientState) => void): ClientState {
  const state = structuredClone({
    ...FIXTURE_STATE,
    app: { ...FIXTURE_STATE.app, manifest: { ...FIXTURE_STATE.app.manifest!, models: [...FIXTURE_STATE.app.manifest!.models, UPSCALER] } },
    bench: { worldId: FIXTURE_WORLD_ID, session: bench },
  }) as ClientState;
  configure?.(state);
  return state;
}

interface Bench { container: HTMLElement; root: Root; sent: ClientMessage[] }
const open: Bench[] = [];

async function openBench(bench: BenchSession, configure?: (state: ClientState) => void): Promise<Bench> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {},
    send: (json: string) => { sent.push(JSON.parse(json) as ClientMessage); } } as unknown as ArkeBridge);
  __setStateForTest(stateWith(bench, configure));
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`]}><App /></MemoryRouter>);
  });
  const opened = { container, root, sent };
  open.push(opened);
  return opened;
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

const marks = (bench: Bench) =>
  [...bench.container.querySelectorAll(".fy-bench__briefrow .fy-bench__rowicon")].map((node) => {
    const label = node.getAttribute("aria-label") ?? "";
    return label.startsWith("Download") ? "Download" : label;
  });

describe("Upscale on a take (design 178a, 180a)", () => {
  it("sits second among the tools on a finished video below 1080p", async () => {
    const bench = await openBench(session([videoTake(SOURCE_ID, 1, 1344, 768)]));
    assert.deepEqual(marks(bench), ["Run it again", "Upscale to 1080p", "Download", "What was sent", "Not this", "Delete"]);
  });

  it("is absent on a take already at the size, and on a production session's take", async () => {
    const big = await openBench(session([videoTake(SOURCE_ID, 1, 1920, 1080)]));
    assert.ok(!marks(big).includes("Upscale to 1080p"));
    const subject = session([videoTake(SOURCE_ID, 1, 1344, 768)]);
    const bound = await openBench({ ...subject, subject: { kind: "shot" } } as unknown as BenchSession);
    assert.ok(!marks(bound).includes("Upscale to 1080p"));
  });

  it("states the frame, crop, model and time before the press, then sends one upscale", async () => {
    const bench = await openBench(session([videoTake(SOURCE_ID, 1, 1344, 768)]));
    await act(async () => (bench.container.querySelector('[aria-label="Upscale to 1080p"]') as HTMLElement).click());
    const pop = bench.container.querySelector('[data-testid="upscale-popover"]')!;
    const text = pop.textContent ?? "";
    for (const words of ["Upscale Take 1", "Size1080p", "Frame1344×768 → 1920×1080", "Crop2% top and bottom", "ModelLocal · SeedVR2", "Time—"]) {
      assert.ok(text.includes(words), `${words} in ${text}`);
    }
    await act(async () => (bench.container.querySelector('[data-testid="upscale-confirm"]') as HTMLElement).click());
    const sent = bench.sent.at(-1) as unknown as { kind: string; takeId: string; sessionId: string };
    assert.equal(sent.kind, "bench-upscale");
    assert.equal(sent.takeId, SOURCE_ID);
  });

  it("holds the press on an engine below 0.38 with the tile's own clause", async () => {
    const bench = await openBench(session([videoTake(SOURCE_ID, 1, 864, 480)]), (state) => {
      state.app.comfyui = { ...(state.app.comfyui ?? { engine: {} as never, checkedAt: "2026-10-01T10:00:00.000Z" }), recipes: [readiness("disabled", "engine")] } as never;
    });
    await act(async () => (bench.container.querySelector('[aria-label="Upscale to 1080p"]') as HTMLElement).click());
    assert.equal(bench.container.querySelector('[data-testid="upscale-refusal"]')?.textContent, "Needs ComfyUI 0.38");
    assert.equal((bench.container.querySelector('[data-testid="upscale-confirm"]') as HTMLButtonElement).disabled, true);
    assert.ok((bench.container.querySelector('[data-testid="upscale-popover"]')?.textContent ?? "").includes("1% each side"));
  });

  it("an upscale's line names its source, and says so once the source is deleted", async () => {
    const both = await openBench(session([videoTake(SOURCE_ID, 1, 1344, 768), upscaled]));
    const line = () => both.container.querySelector(".fy-bench__briefline")?.textContent ?? "";
    assert.equal(line(), "Local · SeedVR2 · 1080p · from Take 1 · 1344×768 → 1920×1080");
    assert.deepEqual(marks(both), ["Run it again", "Download", "Not this", "Delete"], "no Upscale on 1080p, no What was sent");
    const orphan = await openBench(session([upscaled]));
    assert.equal(orphan.container.querySelectorAll(".fy-bench__briefline")[0]?.textContent, "Local · SeedVR2 · 1080p · from Take 1 · deleted · 1344×768 → 1920×1080");
    assert.ok(!marks(orphan).includes("Run it again"), "nothing to make it again from");
  });
});

describe("the measured time and the engine floor, as words", () => {
  it("is a dash until a run, then this machine's rate times the source's length", () => {
    const take = videoTake(SOURCE_ID, 1, 1344, 768);
    assert.deepEqual(upscaleRows(take, UPSCALER, undefined)?.at(-1), ["Time", "—"]);
    assert.deepEqual(upscaleRows(take, UPSCALER, { [UPSCALER.id]: [{ secPerOutputSec: 117.5, at: "2026-10-01T10:00:00.000Z" }] })?.at(-1), ["Time", "~14 min · GPU time"]);
    assert.equal(upscaleHeld(UPSCALER, readiness("disabled", "engine")), "Needs ComfyUI 0.38");
    assert.equal(upscaleHeld(UPSCALER, readiness("ready")), null);
    assert.equal(upscaleHeld(UPSCALER, undefined), null);
    assert.equal(upscaleHeld(UPSCALER, readiness("ready"), true), "Turned off in AI models");
  });
});

describe("Upscale in Settings (design 178c, 178d)", () => {
  const render = (configure: (state: ClientState) => void) => {
    __setStateForTest(stateWith(session([videoTake(SOURCE_ID, 1, 1344, 768)]), configure));
    return renderToString(
      <MemoryRouter initialEntries={["/settings/models?half=local&kind=upscale"]}>
        <SettingsModelsScreen />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");
  };

  it("is its own kind under On this machine, with its rate measured here or a dash", () => {
    const fresh = render((state) => {
      state.app.comfyui = { ...(state.app.comfyui ?? { engine: {} as never, checkedAt: "2026-10-01T10:00:00.000Z" }), recipes: [readiness("ready")] } as never;
    });
    assert.match(fresh, /fy-kind__name">Upscale</);
    assert.match(fresh, /Video to 1080p/);
    assert.match(fresh, /data-testid="upscale-rate"[^]*?—/);
    const measured = render((state) => {
      state.app.comfyui = { ...(state.app.comfyui ?? { engine: {} as never, checkedAt: "2026-10-01T10:00:00.000Z" }), recipes: [readiness("ready")] } as never;
      state.app.localSampling = { choices: {}, timings: {}, rates: { [UPSCALER.id]: [{ secPerOutputSec: 117, at: "2026-10-01T10:00:00.000Z" }] } };
    });
    assert.match(measured, /~2 min \/ s/);
  });

  it("says Needs ComfyUI 0.38 on an older engine, and nothing longer", () => {
    const old = render((state) => {
      state.app.comfyui = { ...(state.app.comfyui ?? { engine: {} as never, checkedAt: "2026-10-01T10:00:00.000Z" }), recipes: [readiness("disabled", "engine")] } as never;
    });
    assert.match(old, /Needs ComfyUI 0\.38/);
    assert.doesNotMatch(old, /this engine reports/);
  });
});

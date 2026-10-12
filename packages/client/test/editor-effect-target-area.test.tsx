import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { DEFAULT_MIX, defaultEffectClip, type EffectRenderProjection, type ProductionTimeline, type RenderPlan } from "@arke-studio/contracts";
import { EffectTargetArea, effectTargetAreaAtFrame } from "../src/screens/editor-effect-target-area.js";
import { EffectCutPreview } from "../src/screens/editor-effect-preview.js";
import type { EffectAuthoringProps } from "../src/lib/editor-effect-authoring.js";
import type { Transport } from "../src/screens/editor-transport.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
Object.assign(document, { oninput: null });
const { createRoot } = await import("react-dom/client");
const roots: Root[] = [];
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); });

function fixture() {
  const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 240, seed: 8 });
  const timeline: ProductionTimeline = { schemaVersion: 1, revision: 0, frameRate: 24, mix: DEFAULT_MIX, library: [], history: { undo: [], redo: [] }, tracks: [
    { id: "tr_picture", kind: "picture", name: "Portraits", order: 0, muted: false, clips: [{ id: "cl_portrait", startFrame: 0, durationFrames: 100, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_portrait", label: "Ade portrait" } }] },
    { id: "tr_effect", kind: "effect", name: "Effects", order: 1, muted: false, clips: [], effects: [effect] },
  ] };
  const projection: EffectRenderProjection = { rendererVersion: "software-rgba-v2", width: 320, height: 180, frameRate: 24, startFrame: 0, endFrame: 240,
    effectLayers: [{ trackId: "tr_effect", trackOrder: 1, effect }], issues: [], pictureLayers: [{ clipId: "cl_portrait", trackId: "tr_picture", kind: "media", order: 0,
      label: "Ade portrait", path: "artifacts/portrait.png", still: true, startFrame: 0, endFrame: 100, sourceInSec: 0, fit: "contain", matte: "source-alpha", sourceSize: { width: 100, height: 200 } }] };
  return { effect, timeline, projection };
}
function controls(value: ReturnType<typeof fixture>): EffectAuthoringProps {
  return { effect: value.effect, timeline: value.timeline, frameRate: 24, playheadFrame: 24, disabled: false, onCommands() {}, onPreview() {}, onScrub() {} };
}

describe("preview emitting area target placement", () => {
  it("uses the full composition or the exact renderer contain rectangle for a scoped picture", () => {
    const { effect, timeline, projection } = fixture();
    const composition = effectTargetAreaAtFrame(effect, timeline, projection, 24); assert.ok(composition.ok);
    assert.deepEqual(composition.rect, { x: 0, y: 0, width: 1, height: 1 });
    effect.target = { kind: "visual-clip", clipId: "cl_portrait" };
    const scoped = effectTargetAreaAtFrame(effect, timeline, projection, 24); assert.ok(scoped.ok);
    assert.deepEqual(scoped.rect, { x: 115 / 320, y: 0, width: 90 / 320, height: 1 }); assert.equal(scoped.clipId, "cl_portrait");
    effect.target = { kind: "picture-track", trackId: "tr_picture" };
    assert.deepEqual(effectTargetAreaAtFrame(effect, timeline, projection, 24), scoped);
  });

  it("does not substitute full-frame handles for missing, hidden, gap, slate or unknown-sized scopes", () => {
    const value = fixture(), { effect, timeline, projection } = value;
    effect.target = { kind: "visual-clip", clipId: "cl_lost" };
    let result = effectTargetAreaAtFrame(effect, timeline, projection, 24); assert.ok(!result.ok); assert.match(result.reason, /Missing visual clip.*cl_lost/);
    effect.target = { kind: "visual-clip", clipId: "cl_portrait" }; timeline.tracks[0]!.muted = true;
    result = effectTargetAreaAtFrame(effect, timeline, projection, 24); assert.ok(!result.ok); assert.match(result.reason, /Ade portrait.*hidden/);
    timeline.tracks[0]!.muted = false;
    result = effectTargetAreaAtFrame(effect, timeline, projection, 100); assert.ok(!result.ok); assert.match(result.reason, /Ade portrait.*no visible picture/);
    projection.pictureLayers[0]!.kind = "slate";
    assert.equal(effectTargetAreaAtFrame(effect, timeline, projection, 24).ok, false); projection.pictureLayers[0]!.kind = "media";
    delete projection.pictureLayers[0]!.sourceSize;
    result = effectTargetAreaAtFrame(effect, timeline, projection, 24); assert.ok(!result.ok); assert.match(result.reason, /Ade portrait.*dimensions are unavailable/);
    const html = renderToStaticMarkup(<EffectTargetArea {...controls(value)} projection={projection} absoluteFrame={24} />);
    assert.match(html, /role="status"/); assert.doesNotMatch(html, /fx-area-overlay__handle/);
  });

  it("places scoped controls inside the contained stage and exposes keyboard/touch handles", () => {
    const value = fixture(); value.effect.target = { kind: "visual-clip", clipId: "cl_portrait" };
    const html = renderToStaticMarkup(<EffectTargetArea {...controls(value)} projection={value.projection} absoluteFrame={24} />);
    assert.match(html, /left:35.9375%;top:0%;width:28.125%;height:100%/);
    assert.match(html, /Move emitting area/); assert.match(html, /Resize emitting area top left/);
    assert.equal((html.match(/<button/g) ?? []).length, 5);
  });

  it("requires the explicit toggle, closes on effect selection, and never changes transport", async () => {
    const value = fixture(); let seeks = 0, playbackChanges = 0;
    const transport = { time: 1, timeRef: { current: 1 }, playing: false, seek() { seeks++; }, setPlaying() { playbackChanges++; } } as unknown as Transport;
    const plan: RenderPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: 10, mix: DEFAULT_MIX, speech: [], subtitles: null,
      revision: 0, range: { startSec: 0, endSec: 10 }, scope: { kind: "production" }, effectRender: value.projection };
    const canvasPrototype = Object.getPrototypeOf(document.createElement("canvas")); canvasPrototype.getContext = () => null;
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
    const render = () => root.render(<EffectCutPreview slug={undefined} plan={plan} projection={value.projection} transport={transport} totalSec={10} effectControls={controls(value)} />);
    await act(async () => render()); assert.equal(container.querySelector(".fx-target-area"), null);
    const toggle = container.querySelector(".fx-target-area__toggle") as HTMLButtonElement;
    await act(async () => toggle.click()); assert.ok(container.querySelector(".fx-target-area")); assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(container.querySelector('[aria-label="Play"]'), null, "the centre play control must not cover the move handle while editing");
    value.effect = { ...value.effect, id: "cl_second", lineageId: "ef_second" };
    await act(async () => render()); assert.equal(container.querySelector(".fx-target-area"), null);
    assert.equal(toggle.getAttribute("aria-expanded"), "false"); assert.equal(seeks, 0); assert.equal(playbackChanges, 0); assert.equal(transport.timeRef.current, 1);
  });
});

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { StageUnderlay, stagePlateSources } from "../src/screens/scene-workspace/stage-underlay.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(dom.HTMLElement.prototype, { showModal() {}, close() {}, readyState: 0, duration: 20, currentTime: 0, paused: true,
  play(this: HTMLVideoElement) { Object.assign(this, { paused: false }); return Promise.resolve(); },
  pause(this: HTMLVideoElement) { Object.assign(this, { paused: true }); },
});
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; dom.document.body.replaceChildren(); });

function fixture() {
  const world = structuredClone(FIXTURE_STATE.world!);
  const production = world.productions[0]!;
  const artifact = { ...world.artifacts[0]!, kind: "image" as const, id: "image", file: "match.png" };
  world.artifacts = [artifact, { ...artifact, id: "other", file: "other.png", production: "another" },
    { ...artifact, id: "retired", file: "retired.png", retiredAt: "2026-09-01T00:00:00Z" }];
  const pass = { ...production.takes[0]!, id: "pass", coversShots: ["another-shot"] };
  production.takes = [pass, { ...pass, id: "segment", coversShots: ["sh_12"], segment: { passTakeId: pass.id, inSec: 4, outSec: 9 } }];
  return { world, production };
}

it("offers scoped reference images and shot clips through their existing media authority (#1049)", () => {
  const { world, production } = fixture();
  const sources = stagePlateSources(world, production, "sh_12");
  assert.deepEqual(sources.world.map(source => source.path), ["artifacts/match.png"]);
  assert.equal(sources.takes.length, 1);
  assert.equal(sources.takes[0]!.path, "productions/saltlight/takes/pass/clip.mp4");
  assert.equal(sources.takes[0]!.inSec, 4);
  assert.equal(sources.takes[0]!.outSec, 9);
});

it("fits an editor-only plate, syncs clipped video to scrubs and offsets, and uses production import (#1049)", async t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const { world, production } = fixture();
  const sent: ClientMessage[] = [];
  __setStateForTest({ ...FIXTURE_STATE, world }, { connection: "open" });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => sent.push(JSON.parse(json)) } as unknown as ArkeBridge);
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  const viewport = dom.document.createElement("div") as unknown as HTMLElement;
  Object.assign(viewport, { clientWidth: 800, clientHeight: 600 });
  viewport.append(dom.document.createElement("canvas"));
  dom.document.body.append(host, viewport);
  root = createRoot(host);
  let at = 0, playing = false, visible = true, choices = 0;
  const render = async () => { await act(async () => root!.render(<StageUnderlay world={world} production={production} shotId="sh_12" viewport={viewport} aspect="16:9" at={at} playing={playing} visible={visible} disabled={false} onChoose={() => { choices++; }} />)); };
  const button = (text: string) => { const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.includes(text)); assert.ok(found, text); return found; };
  const click = async (text: string) => { await act(async () => button(text).click()); };
  const change = async (label: string, value: string) => {
    const input = host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    const key = Object.keys(input).find(key => key.startsWith("__reactProps$"))!;
    const props = (input as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!;
    await act(async () => props.onChange({ target: { value } }));
  };
  await render();
  await click("Choose reference");
  await click("match.png");
  assert.equal(choices, 1);
  const plate = viewport.querySelector<HTMLElement>(".fy-swstage__plate")!;
  assert.equal(plate.style.width, "800px");
  assert.equal(plate.style.height, "450px");
  assert.equal(plate.parentElement, viewport);
  assert.equal(viewport.querySelector("canvas")!.childNodes.length, 0, "capture canvas has no reference pixels");
  await change("Reference display", "corner");
  await change("Reference opacity", ".25");
  assert.equal(plate.dataset.layout, "corner");
  assert.equal(plate.querySelector("img")!.style.opacity, "0.25");
  await click("Change reference");
  await click("Shot takes");
  await click("segment");
  const video = viewport.querySelector<HTMLVideoElement>("video")!;
  assert.match(video.getAttribute("src")!, /takes\/pass\/clip.mp4/);
  at = 1;
  await render();
  await act(async () => { Object.assign(video, { readyState: 2 }); video.dispatchEvent(new dom.window.Event("loadeddata")); });
  assert.equal(video.currentTime, 5, "loading uses the latest playhead, including the source trim");
  at = 1.05;
  await render();
  assert.equal(video.currentTime, 5.05, "small paused scrubs seek exactly");
  await change("Reference time offset", "-3");
  assert.equal(video.currentTime, 4, "negative offsets hold at the source's in point");
  at = 4; playing = true;
  await render();
  assert.equal(video.paused, false);
  await change("Reference time offset", "20");
  assert.equal(video.paused, true);
  assert.ok(video.currentTime < 9 && video.currentTime > 8.9, "never runs into the following shot in a backing pass");
  now += 600;
  await change("Reference time offset", "0");
  at = 1; await render();
  assert.equal(video.paused, false);
  visible = false; await render();
  assert.equal(viewport.querySelector(".fy-swstage__plate"), null);
  assert.equal(video.paused, true, "hidden media stops");
  visible = true; await render();
  assert.ok(viewport.querySelector(".fy-swstage__plate"), "the choice survives Look mode and capture");
  await click("Remove reference");
  assert.equal(viewport.querySelector(".fy-swstage__plate"), null);
  assert.equal(sent.length, 0, "reference choices are local editor state");
  await click("Choose reference");
  await click("Upload");
  assert.equal(sent.at(-1)?.kind, "upload-artifacts");
  assert.equal((sent.at(-1) as { production?: string }).production, production.meta.id);
});

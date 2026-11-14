import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DEFAULT_MIX, DEFAULT_SUBTITLE_STYLE, defaultEffectClip, type RenderPlan, type TimelineCommand, type TimelinePictureLook } from "@arke-studio/contracts";
import { LookPanel } from "../src/screens/editor-look.js";
import { CutPreview } from "../src/screens/editor-preview.js";
import type { PlaybackSpan } from "../src/lib/cut-playback.js";
import type { Transport } from "../src/screens/editor-transport.js";

/**
 * The Cut's look on the screen (SPEC-038 R-45..R-50): two rows of chips that send the whole look, and a
 * Viewer that wears it on its picture elements only, whichever of the two previews draws the film.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
Object.assign(Object.getPrototypeOf(document.createElement("video")), { pause() {}, play: () => Promise.resolve(), load() {} });
// The frames themselves have their own coverage; here the canvas is only the element that shows them.
Object.getPrototypeOf(document.createElement("canvas")).getContext = () => null;
const { createRoot } = await import("react-dom/client");
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); });
const mount = async (element: React.ReactNode) => { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root!.render(element)); return host; };
const chip = (label: string) => { const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); assert.ok(found, label); return found; };
const pressed = () => [...document.querySelectorAll("button")].filter(button => button.getAttribute("aria-pressed") === "true").map(button => button.getAttribute("aria-label"));

test("the Look panel is two rows of chips that send the whole look, and none when both are off", async () => {
  const sent: Array<[TimelineCommand[], string | undefined]> = [];
  const view = (look: TimelinePictureLook | undefined, disabled = false) => <LookPanel look={look} disabled={disabled} onCommands={(commands, label) => sent.push([commands, label])} />;
  const host = await mount(view(undefined));
  const panel = host.querySelector('[aria-label="Look"]')!;
  // Labels and chips, and nothing under them.
  assert.equal(panel.textContent, "LOOKGradeOffFilmGrainOffLightMedium");
  assert.deepEqual([...panel.querySelectorAll('[role="group"]')].map(row => [row.getAttribute("aria-label"), [...row.querySelectorAll("button")].map(button => button.textContent)]),
    [["Grade", ["Off", "Film"]], ["Grain", ["Off", "Light", "Medium"]]]);
  assert.ok([...panel.querySelectorAll("button")].every(button => button.className === "fy-takepick__use"), "the mix panel's own chips");
  assert.deepEqual(pressed(), ["Grade off", "Grain off"]);

  await act(async () => chip("Grade film").click());
  assert.deepEqual(sent.pop(), [[{ kind: "set-picture-look", look: { grade: "film" } }], "Change the look"]);
  await act(async () => chip("Grain off").click());
  assert.equal(sent.length, 0, "the chip already pressed sends nothing");

  // What the coordinator would send back, each time: the part not touched travels with the one that was.
  await act(async () => root!.render(view({ grade: "film" })));
  assert.deepEqual(pressed(), ["Grade film", "Grain off"]);
  await act(async () => chip("Grain medium").click());
  assert.deepEqual(sent.pop(), [[{ kind: "set-picture-look", look: { grade: "film", grain: "medium" } }], "Change the look"]);
  await act(async () => chip("Grade off").click());
  assert.deepEqual(sent.pop(), [[{ kind: "set-picture-look", look: null }], "Clear the look"], "the last part off clears it");

  await act(async () => root!.render(view({ grade: "film", grain: "medium" })));
  assert.deepEqual(pressed(), ["Grade film", "Grain medium"]);
  await act(async () => chip("Grain light").click());
  assert.deepEqual(sent.pop(), [[{ kind: "set-picture-look", look: { grade: "film", grain: "light" } }], "Change the look"]);
  await act(async () => chip("Grade off").click());
  assert.deepEqual(sent.pop(), [[{ kind: "set-picture-look", look: { grain: "medium" } }], "Change the look"], "one part off leaves the other");
  await act(async () => chip("Grade film").click());
  assert.equal(sent.length, 0);

  await act(async () => root!.render(view({ grain: "light" }, true)));
  assert.ok([...document.querySelectorAll("button")].every(button => button.disabled));
});

const plan = (look?: TimelinePictureLook, composited = false): RenderPlan => ({ preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: 4, revision: 3,
  range: { startSec: 0, endSec: 4 }, scope: { kind: "production" }, mix: DEFAULT_MIX, speech: [], subtitles: null,
  ...(look ? { pictureLook: look } : {}),
  ...(composited ? { effectRender: { rendererVersion: "software-rgba-v2" as const, width: 32, height: 18, frameRate: 24, startFrame: 0, endFrame: 96, pictureLayers: [], issues: [],
    effectLayers: [{ trackId: "tr_effect", trackOrder: 1, effect: defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", seed: 8, startFrame: 0, durationFrames: 96 }) }] } } : {}) });
const transport = (time: number): Transport => ({ playing: false, time, timeRef: { current: time }, setPlaying() {}, seek() {} });
const spans: PlaybackSpan[] = [
  { startSec: 0, endSec: 2, path: "artifacts/video.mp4", mediaInSec: 0, label: "video" },
  { startSec: 2, endSec: 4, path: "artifacts/still.png", mediaInSec: 0, label: "still", still: true },
];
const cue = { id: "cu_1", text: "The bells again.", startSec: 0, endSec: 4 };
/** The classes on everything inside the viewer, in document order: who is graded, and what lies over what. */
const worn = (host: HTMLElement) => [...host.querySelectorAll(".fy-cutviewer video, .fy-cutviewer img, .fy-cutviewer canvas, .fy-cutlook-grain, .fy-cutviewer__cue")].map(element => element.className);

test("a plain cut's Viewer grades its videos and its still and lays the grain over them and under the cue, only when the plan has a look", async () => {
  const view = (look: TimelinePictureLook | undefined, time: number) =>
    <CutPreview slug="test-world" spans={spans} totalSec={4} restartToken={0} transport={transport(time)} plan={plan(look)} cueAt={() => cue} />;
  const host = await mount(view(undefined, 0));
  assert.deepEqual(worn(host), ["fy-cutviewer__video", "fy-cutviewer__video", "fy-cutviewer__cue"], "a film with no look is drawn as it was");

  await act(async () => root!.render(view({ grade: "film", grain: "light" }, 0)));
  assert.deepEqual(worn(host), ["fy-cutviewer__video fy-cutlook-film", "fy-cutviewer__video fy-cutlook-film", "fy-cutlook-grain fy-cutlook-grain--light", "fy-cutviewer__cue"]);
  assert.equal(host.querySelector(".fy-cutviewer")!.className, "fy-cutviewer", "the stage itself is not graded");
  assert.equal(host.querySelector(".fy-cutlook-grain")!.getAttribute("aria-hidden"), "true");

  // On a still, the image the frame loop made is a picture too.
  await act(async () => root!.render(view({ grade: "film", grain: "light" }, 2.5)));
  assert.deepEqual(worn(host), ["fy-cutviewer__video fy-cutlook-film", "fy-cutviewer__video fy-cutlook-film", "fy-cutviewer__video fy-cutlook-film", "fy-cutlook-grain fy-cutlook-grain--light", "fy-cutviewer__cue"]);
  // The grade taken away while that still is on screen leaves it at once; the grain stays, stronger.
  await act(async () => root!.render(view({ grain: "medium" }, 2.5)));
  assert.deepEqual(worn(host), ["fy-cutviewer__video", "fy-cutviewer__video", "fy-cutviewer__video", "fy-cutlook-grain fy-cutlook-grain--medium", "fy-cutviewer__cue"]);
  await act(async () => root!.render(view(undefined, 2.5)));
  assert.deepEqual(worn(host), ["fy-cutviewer__video", "fy-cutviewer__video", "fy-cutviewer__video", "fy-cutviewer__cue"]);
});

test("the compositor's Viewer grades its canvas and lays the grain inside the stage, under what is drawn on the picture", async () => {
  const cued = (look?: TimelinePictureLook): RenderPlan => ({ ...plan(look, true),
    subtitles: { trackId: "tr_subs", language: "en", mode: "none", sidecar: "srt", cues: [cue], style: DEFAULT_SUBTITLE_STYLE } });
  const view = (look?: TimelinePictureLook) => <CutPreview slug={undefined} spans={[]} totalSec={4} restartToken={0} transport={transport(1)} plan={cued(look)} />;
  const host = await mount(view());
  assert.deepEqual(worn(host), ["fy-effectpreview__picture", "fy-cutviewer__cue"], "a film with no look is drawn as it was");

  await act(async () => root!.render(view({ grade: "film", grain: "medium" })));
  assert.deepEqual(worn(host), ["fy-effectpreview__picture fy-cutlook-film", "fy-cutlook-grain fy-cutlook-grain--medium", "fy-cutviewer__cue"]);
  const stage = host.querySelector(".fy-effectpreview__stage")!;
  assert.equal(stage.className, "fy-effectpreview__stage", "the stage is not graded");
  assert.equal(host.querySelector(".fy-cutlook-grain")!.parentElement === stage, true, "the grain is as large as the picture, not the viewer around it");

  await act(async () => root!.render(view({ grain: "light" })));
  assert.deepEqual(worn(host), ["fy-effectpreview__picture", "fy-cutlook-grain fy-cutlook-grain--light", "fy-cutviewer__cue"]);
});

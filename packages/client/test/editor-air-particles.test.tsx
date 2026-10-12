import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { defaultEffectClip, DEFAULT_MIX, type ProductionTimeline, type TimelineCommand } from "@arke-studio/contracts";
import { EffectInspector } from "../src/screens/editor-effect-inspector.js";
import { PictureAppearanceInspector } from "../src/screens/editor-picture-appearance.js";
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
const { createRoot } = await import("react-dom/client");
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });
const timeline: ProductionTimeline = { schemaVersion: 1, revision: 0, frameRate: 24, tracks: [], mix: DEFAULT_MIX, library: [], history: { undo: [], redo: [] } };
const mount = async (element: React.ReactNode) => { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root!.render(element)); };
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent === name)!;
test("Air Particles adds appearance and collapsed physics in the existing Inspector; New pattern is one typed command", async () => {
  const effect = defaultEffectClip({ id: "cl_air", lineageId: "ef_air", seed: 42, startFrame: 0, durationFrames: 240, preset: "air-particles" });
  const sent: TimelineCommand[][] = [];
  await mount(<EffectInspector effect={effect} timeline={timeline} frameRate={24} playheadFrame={0} disabled={false} onPreview={() => {}} onScrub={() => {}} onCommands={commands => sent.push(commands)} />);
  assert.ok(document.querySelector('[aria-label="Air Particles effect Inspector"]'));
  for (const label of ["Texture", "Softness", "Depth variation", "Airflow variation"]) assert.ok([...document.querySelectorAll("label")].some(row => row.textContent?.startsWith(label)), label);
  const physics = [...document.querySelectorAll("details")].find(row => row.querySelector("summary")?.textContent === "Particle physics")!;
  assert.ok(physics); assert.equal(physics.hasAttribute("open"), false);
  assert.equal(document.querySelector('[aria-label="Effect blend mode"]')?.getAttribute("disabled"), null);
  await act(async () => button("New pattern").click());
  assert.equal(sent.length, 1); assert.equal(sent[0]!.length, 1);
  const command = sent[0]![0]!; assert.equal(command.kind, "effect-patch");
  if (command.kind === "effect-patch") { assert.ok(Number.isInteger(command.patch.seed)); assert.notEqual(command.patch.seed, 42); }
  assert.equal(effect.seed, 42, "the Inspector sends intent without mutating Current");
});
test("picture protection uses a named rule and explicit Release; read-only comparison disables authorship", async () => {
  const clip = { id: "cl_a" as const, startFrame: 0, durationFrames: 240, sourceInFrames: 0, source: { kind: "artifact" as const, artifactId: "ar_example", label: "Overlay" },
    visual: { blendMode: "screen" as const, opacity: .7, protection: [{ id: "vp_blend", property: "blendMode" as const, scope: { kind: "whole" as const } }] } };
  const sent: TimelineCommand[][] = [];
  await mount(<PictureAppearanceInspector clip={clip} frameRate={24} disabled={false} onCommands={commands => sent.push(commands)} />);
  await act(async () => button("Release Blend mode").click()); assert.deepEqual(sent, [[{ kind: "picture-release", ruleId: "vp_blend" }]]);
  assert.equal(clip.visual.protection.length, 1);
  await act(async () => root!.render(<PictureAppearanceInspector clip={clip} frameRate={24} disabled onCommands={commands => sent.push(commands)} />));
  assert.equal(button("Release Blend mode").disabled, true);
  assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="Picture blend mode"]')!.disabled, true);
});

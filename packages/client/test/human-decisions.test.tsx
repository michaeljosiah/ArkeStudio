import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { newId, orderedShots, StageReviewSchema, VoiceSampleReviewSchema, WorldChatWorkspaceSchema, type ClientMessage, type HumanDecisionCard, type HumanDecisionControl } from "@arke-studio/contracts";
import { HumanDecisionCardView } from "../src/components/human-decision-card.js";
import { ConversationTranscript } from "../src/components/conversation.js";
import { SceneStage } from "../src/screens/scene-workspace/stage.js";
import { SelectionProvider } from "../src/screens/scene-workspace/selection.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); dom.document.body.replaceChildren(); __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE); });
function card(control: HumanDecisionControl): HumanDecisionCard {
  return { id: "decision", worldId: FIXTURE_STATE.world!.meta.worldId, conversationId: newId("cv"), title: "Your decision", status: "pending",
    body: { family: "human-decision", reason: "Only you can decide this", control } };
}
async function mount(element: React.ReactNode) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } } as unknown as ArkeBridge);
  __setStateForTest(FIXTURE_STATE);
  const host = dom.document.createElement("div") as unknown as HTMLElement; dom.document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter>{element}</MemoryRouter>));
  return { host, sent };
}
const press = async (button: HTMLElement) => { await act(async () => button.click()); };

it("keeps outstanding human decisions reachable beyond the bounded message window and sends the exact plan command", async () => {
  const decision = card({ kind: "plan", productionId: "saltlight", planId: newId("pl"), passIndex: 2, gate: "reconfirm", capMicroUsd: 1_000_000, estimatedMicroUsd: 400_000 });
  decision.turnId = newId("turn");
  const workspace = WorldChatWorkspaceSchema.parse({ conversationId: decision.conversationId, status: "open", messages: [], points: [], actions: [], attachments: [], humanDecisions: [decision] });
  const { host, sent } = await mount(<ConversationTranscript workspace={workspace} running={false} progress={null} failure={null} canRetry={false} empty={<p>No messages</p>} />);
  assert.equal(host.querySelectorAll('[data-family="human-decision"]').length, 1);
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("Reconfirm"))!;
  await press(button);
  assert.deepEqual(sent[0], { kind: "plan-reconfirm", worldId: decision.worldId, productionId: "saltlight", planId: decision.body.control.kind === "plan" ? decision.body.control.planId : "", passIndex: 2 });
  assert.equal(host.textContent?.includes("Approve"), false, "human decisions are never model permission grants");
  await act(async () => root!.render(<MemoryRouter><ConversationTranscript workspace={{ ...workspace, humanDecisions: [] }} running={false} progress={null} failure={null} canRetry={false} /></MemoryRouter>));
  assert.equal(host.querySelector('[data-family="human-decision"]'), null, "authority settlement retires the matching card");
});

it("renders the screen's voice attestations inline, requires each tick, and settles another surface's acceptance", async () => {
  const hash = `sha256:${"1".repeat(64)}`, at = "2026-10-04T12:00:00Z";
  const technical = { container: "wav", codec: "pcm_s16le", sampleFormat: "s16", sampleRateHz: 48000, channels: 1, bitDepth: 16, durationSec: 2, sizeBytes: 100 };
  const codes = ["decode", "duration", "technicalFormat", "clipping", "silence", "dcOffset", "truePeak", "lufs", "noiseFloor", "snr", "speechPresence", "musicLikelihood", "multipleSpeakers", "transcriptMatch"];
  const review = VoiceSampleReviewSchema.parse({ operationId: "7c05871e-53ac-4c9d-8a12-1207d541a532", sheetId: "maren-kest", sourceFile: "artifacts/sample.wav", preparedFile: ".staging/audio/sample.wav",
    provenance: { schemaVersion: 1, source: { kind: "artifact", artifactId: newId("ar"), recordedArtifactHash: hash, sourceMediaHash: hash },
      sourceTechnical: technical, outputTechnical: technical, outputHash: hash, preparation: [], createdAt: at,
      qualityReport: { schemaVersion: 1, sourceHash: hash, analyzer: { id: "arke-pcm-qc", version: 1, policyVersion: 1 }, analyzedAt: at, technical,
        measurements: { samplePeakDbfs: null, rmsDbfs: null, fullScaleSampleCount: null, leadingSilenceSec: null, trailingSilenceSec: null, longestInternalSilenceSec: null, dcOffset: null },
        checks: Object.fromEntries(codes.map(code => [code, { code, outcome: code === "silence" ? "warning" : "pass" }])) } } });
  const { host, sent } = await mount(<HumanDecisionCardView card={card({ kind: "voice-sample", review })} />);
  for (const event of [{ status: "assigned" as const, operationId: "05734c91-c438-4543-acec-a619c95d2e3e" }, { status: "cleared" as const }]) {
    await act(async () => __applyEventForTest({ type: "voice.sample-result", at, worldId: FIXTURE_STATE.world!.meta.worldId,
      sheetId: review.sheetId, requestId: newId("ar").slice(3), ...event }));
    assert.ok(host.querySelector('[data-testid="voice-review"]'), "another candidate's assignment or clearing the assigned clip cannot decide this pending review");
  }
  const use = host.querySelector<HTMLButtonElement>('[data-testid="sample-use"]')!;
  assert.equal(use.disabled, true); assert.equal(dom.document.querySelector('[role="dialog"]'), null, "the review remains inside the thread");
  const tick = async (id: string) => {
    const input = host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
    const props = (input as unknown as Record<string, { onChange: (event: { target: { checked: boolean } }) => void }>)[Object.keys(input).find(key => key.startsWith("__reactProps$"))!]!;
    await act(async () => props.onChange({ target: { checked: true } }));
  };
  await tick("sample-one-speaker"); await tick("sample-no-music"); assert.equal(use.disabled, true);
  await tick("sample-warnings");
  await press([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Authorised")!);
  await press(use);
  const message = sent.find((message): message is Extract<ClientMessage, { kind: "accept-character-voice-sample" }> => message.kind === "accept-character-voice-sample")!;
  assert.equal(message.operationId, review.operationId); assert.equal(message.rightsBasis, "authorized");
  assert.deepEqual(message.warningCodes, ["silence"]); assert.equal(message.singleSpeaker, true); assert.equal(message.noMusic, true);
  await act(async () => __applyEventForTest({ type: "voice.sample-result", at, worldId: FIXTURE_STATE.world!.meta.worldId,
    sheetId: review.sheetId, requestId: newId("ar").slice(3), status: "assigned", operationId: review.operationId }));
  assert.equal(host.querySelector('[data-testid="voice-review"]'), null);
});

function stageFixture() {
  const world = structuredClone(FIXTURE_STATE.world!), production = world.productions.find(p => p.meta.id === "saltlight")!;
  const scene = production.scenes.find(s => s.id === "sc_04")!, shot = orderedShots(scene).find(s => s.id === "sh_12")!;
  const review = StageReviewSchema.parse({ id: "de6ad993-50f6-4f86-88f8-03ed93c5b824", worldId: world.meta.worldId, productionId: production.meta.id,
    sceneId: scene.id, shotId: shot.id, baseVersion: scene.version, actionId: newId("act"), conversationId: newId("cv"), createdAt: "2026-10-04T12:00:00Z", status: "pending",
    draft: { staging: { keys: [{ t: 0, p: [0, 2, 5], l: [0, 1, 0] }, { t: shot.durationSec ?? 4, p: [1, 2, 5], l: [0, 1, 0] }] },
      cast: [], sets: [], assumptions: [], assessment: "Reviewed in chat", inspected: ["camera"] } });
  return { world, production, scene, shot, review };
}

it("hydrates the same retained draft on the Stage screen, binds Keep to its review, and observes settlement elsewhere", async () => {
  const { world, production, scene, shot, review } = stageFixture();
  let keptId: string | undefined;
  const { host } = await mount(<SelectionProvider value={{ subject: { kind: "shot", shotId: shot.id }, select: () => {} }}>
    <SceneStage world={world} production={production} scene={scene} aspect="16:9" sceneFile="04-the-verse-rises" locked={false}
      generatorPending={false} refusalVersion={0} onCommand={(_, id) => { keptId = id; return true; }} onRenderShot={() => {}} />
  </SelectionProvider>);
  await act(async () => __setStateForTest({ ...FIXTURE_STATE, world, stageReviews: [review] }));
  const keep = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Keep");
  assert.ok(keep(), "the ordinary Stage screen hydrates the chat's reviewed draft");
  await press(keep()!); assert.equal(keptId, review.id, "Keep carries the retained authority without inventing a second edit command");
  await act(async () => __setStateForTest({ ...FIXTURE_STATE, world, stageReviews: [] }));
  assert.equal(keep(), undefined, "a decision on another surface clears the bound screen draft");
});

it("preserves unsaved Stage edits until the person decides them before hydrating a newly arrived review", async () => {
  const { world, production, scene, shot, review } = stageFixture();
  shot.staging = { version: 1, keys: review.draft.staging.keys, rigIntensity: 1 };
  let keptId: string | undefined;
  const { host, sent } = await mount(<SelectionProvider value={{ subject: { kind: "shot", shotId: shot.id }, select: () => {} }}>
    <SceneStage world={world} production={production} scene={scene} aspect="16:9" sceneFile="04-the-verse-rises" locked={false}
      generatorPending={false} refusalVersion={0} onCommand={(_, id) => { keptId = id; return true; }} />
  </SelectionProvider>);
  const input = host.querySelector<HTMLInputElement>('[aria-label="Rig intensity"]')!;
  const props = (input as unknown as Record<string, { onFocus: () => void; onChange: (event: { target: { value: string } }) => void }>)[Object.keys(input).find(key => key.startsWith("__reactProps$"))!]!;
  await act(async () => props.onFocus());
  await act(async () => props.onChange({ target: { value: "1.75" } }));
  await act(async () => __setStateForTest({ ...FIXTURE_STATE, world, stageReviews: [review] }));
  assert.equal(input.value, "1.75", "the incoming constructed draft cannot overwrite an unsaved camera edit");
  assert.match(host.textContent!, /Keep or discard your current Stage edits/);
  await press(host.querySelector<HTMLElement>('[aria-label="Discard"]')!);
  assert.equal(sent.some(message => message.kind === "stage-review-discard"), false, "discarding manual edits does not discard the new retained authority");
  assert.match(host.textContent!, /Reviewed in chat/);
  await press([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Keep")!);
  assert.equal(keptId, review.id);
});

it("shows a fixed-shot Stage review without a dead shot stepper or render command", async () => {
  const { review } = stageFixture();
  const { host } = await mount(<HumanDecisionCardView card={card({ kind: "stage-review", review })} />);
  assert.ok(host.querySelector('[data-testid="workspace-stage"]'));
  assert.equal(host.textContent!.includes("Render with this"), false);
  assert.equal(host.querySelector('.fy-swstage__head'), null);
});

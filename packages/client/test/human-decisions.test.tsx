import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { EffectApplyReceiptSchema, effectProposalFamilyView, newId, orderedShots, ScratchPerformanceSchema, StageReviewSchema, VoiceSampleReviewSchema, WorldChatWorkspaceSchema, type ClientMessage, type HumanDecisionCard, type HumanDecisionControl } from "@arke-studio/contracts";
import { HumanDecisionCardView } from "../src/components/human-decision-card.js";
import { ConversationTranscript } from "../src/components/conversation.js";
import { SceneStage } from "../src/screens/scene-workspace/stage.js";
import { SelectionProvider } from "../src/screens/scene-workspace/selection.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { setAudioFactoryForTest } from "../src/lib/audio.js";
import { ProductionStudioContext, type StudioControls } from "../src/components/production-studio-context.js";
import { appendEffectProposalTestModel, effectProposalFixture } from "./effect-proposal-fixture.js";
import { effectCardRef, effectCompositeReplacesAction } from "../src/lib/editor-effect-proposal-presentation.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); dom.document.body.replaceChildren(); __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE); setAudioFactoryForTest(null); });
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

it("shows a native effect composite without accepting or reviewing on arrival or Show", async () => {
  const fixture = effectProposalFixture(), world = structuredClone(FIXTURE_STATE.world!);
  const production = world.productions.find(value => value.meta.id === "saltlight")!;
  production.timeline = { status: "ready", timeline: fixture.timeline }; production.effectFamilies = [fixture.view];
  const decision = card({ kind: "effect-proposal", productionId: production.meta.id, familyId: fixture.family.id, versionId: fixture.version.id });
  decision.id = `effects:${fixture.family.id}:${fixture.version.id}`; decision.conversationId = fixture.family.conversationId;
  let shown = 0;
  const studio: StudioControls = { active: false, canvasHost: null, fullCardId: null, restingSide: null,
    toggle() {}, widen() {}, show() {}, showDecision() { shown++; }, back() {}, sideHost() {} };
  const { host, sent } = await mount(<ProductionStudioContext.Provider value={studio}><HumanDecisionCardView card={decision} /></ProductionStudioContext.Provider>);
  await act(async () => __setStateForTest({ ...FIXTURE_STATE, world }));
  assert.ok(host.querySelector('[data-effect-version]'));
  assert.equal(sent.length, 0, "card arrival cannot activate Suggested");
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
  await press(buttons().find(button => button.textContent === "Show")!);
  assert.equal(shown, 1); assert.equal(sent.length, 0, "Show is presentation only");
  await press(buttons().find(button => button.textContent === "Review in timeline")!);
  const command = sent.find((message): message is Extract<ClientMessage, { kind: "editor-effect-proposal" }> => message.kind === "editor-effect-proposal")!;
  assert.ok(command); assert.deepEqual(command.operation, { kind: "review", ref: effectCardRef(fixture.view, fixture.version) });
  assert.equal(sent.some(message => message.kind === "conversation-action-decide" || message.kind === "editor-request-decide"), false);
  await press(buttons().find(button => button.textContent === "Check response")!);
  assert.deepEqual(sent.at(-1), command, "checking a lost response reuses the exact request and operation");
  await act(async () => __applyEventForTest({ type: "editor-effect.proposal-result", at: "2026-10-11T20:00:00.000Z", worldId: world.meta.worldId,
    productionId: production.meta.id, requestId: "unrelated", outcome: "refused", reason: "Unrelated refusal" }));
  assert.doesNotMatch(host.textContent!, /Unrelated refusal/);
  await act(async () => __applyEventForTest({ type: "editor-effect.proposal-result", at: "2026-10-11T20:00:00.000Z", worldId: world.meta.worldId,
    productionId: production.meta.id, requestId: command.requestId, outcome: "refused", reason: "World opened read-only" }));
  assert.match(host.textContent!, /World opened read-only/);
});

it("only the linked native effects card replaces a generic permission card", () => {
  const fixture = effectProposalFixture(), actionId = newId("act");
  const action = { actionKind: "world-chat-effect-proposal", actionId, worldId: FIXTURE_STATE.world!.meta.worldId, conversationId: fixture.family.conversationId };
  const decision = { ...card({ kind: "effect-proposal", productionId: "saltlight", familyId: fixture.family.id, versionId: fixture.version.id }),
    actionId, conversationId: fixture.family.conversationId };
  assert.equal(effectCompositeReplacesAction(action, []), false, "preparation/failure remains visible until concrete card arrival");
  assert.equal(effectCompositeReplacesAction(action, [decision]), true);
  assert.equal(effectCompositeReplacesAction({ ...action, actionKind: "world-chat-editor-request" }, [decision]), false);
  assert.equal(effectCompositeReplacesAction({ ...action, actionId: newId("act") }, [decision]), false);
  assert.equal(effectCompositeReplacesAction(action, [{ ...decision, conversationId: newId("cv") }]), false);
});

it("settled effect cards retain their receipt status after Apply, Undo and Redo without pending stale notices", async () => {
  const fixture = effectProposalFixture(), world = structuredClone(FIXTURE_STATE.world!);
  world.meta.worldId = newId("cv").slice(3);
  const production = world.productions.find(value => value.meta.id === "saltlight")!;
  production.timeline = { status: "ready", timeline: { ...fixture.timeline, revision: 76 } }; production.effectFamilies = [fixture.view];
  const decision = card({ kind: "effect-proposal", productionId: production.meta.id, familyId: fixture.family.id, versionId: fixture.version.id });
  decision.worldId = world.meta.worldId;
  const receipt = EffectApplyReceiptSchema.parse({ familyId: fixture.family.id, versionId: fixture.version.id, candidateHash: fixture.version.candidateHash,
    branchId: fixture.version.branchId, decisionRevision: fixture.version.decisionRevision, applyActionIds: ["apply_exact"], resultRevision: 77,
    historyEntryDigest: "a".repeat(64), adjustmentIds: [], releaseDecisionIds: [], bindings: [], preservedRuleIds: [], releasedRuleIds: [], appliedAt: "2026-10-11T22:00:00.000Z" });
  const { host, sent } = await mount(<HumanDecisionCardView card={decision} />);
  await act(async () => __setStateForTest({ ...FIXTURE_STATE, world }));
  assert.match(host.textContent!, /Current changed · Update proposal and review the new version/);
  const details = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.endsWith("Show details"));
  await press(details()!);
  assert.ok([...host.querySelectorAll("button")].some(button => button.textContent === "Update proposal"));
  for (const [revision, undoneAt, expected] of [[77, undefined, "Applied"], [78, "2026-10-11T22:01:00.000Z", "Applied · undone in Current"], [79, undefined, "Applied"]] as const) {
    production.timeline.timeline.revision = revision;
    production.effectFamilies = [{ ...fixture.view, status: "applied", receipt: { ...receipt, ...(undoneAt ? { undoneAt } : {}) } }];
    await act(async () => __setStateForTest(structuredClone({ ...FIXTURE_STATE, world })));
    assert.equal(host.querySelector(".fy-effect-proposal__heading strong")?.textContent, expected);
    assert.doesNotMatch(host.textContent!, /Current changed|Update proposal|Review this version in Suggested|Current stays unchanged until Apply/);
    assert.ok([...host.querySelectorAll(".fy-effect-proposal button")].every(button => /Hide details$|^Previous$|^Next$/.test(button.textContent ?? "")));
    assert.match(host.textContent!, /30%/); assert.match(host.textContent!, /15%/);
  }
  const revised = appendEffectProposalTestModel(fixture.family, fixture.timeline, { summary: "Revised amount", identities: [],
    commands: [{ kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: .2 } } }] });
  const applied = revised.versions.at(-1)!;
  production.effectFamilies = [{ ...effectProposalFamilyView(revised), status: "applied", receipt: { ...receipt,
    versionId: applied.id, candidateHash: applied.candidateHash, branchId: applied.branchId, decisionRevision: applied.decisionRevision } }];
  await act(async () => __setStateForTest(structuredClone({ ...FIXTURE_STATE, world })));
  assert.equal(host.querySelector(".fy-effect-proposal__heading strong")?.textContent, "Earlier version · arrangement applied");
  assert.doesNotMatch(host.textContent!, /Current changed|Update proposal|Review this version in Suggested/);
  production.effectFamilies = [{ ...fixture.view, status: "discarded" }];
  await act(async () => __setStateForTest(structuredClone({ ...FIXTURE_STATE, world })));
  assert.equal(host.querySelector(".fy-effect-proposal__heading strong")?.textContent, "Discarded");
  assert.doesNotMatch(host.textContent!, /Current changed|Update proposal|Review this version in Suggested/);
  assert.match(host.textContent!, /30%/); assert.match(host.textContent!, /15%/);
  assert.equal(sent.length, 0, "opening history and receiving settled snapshots never sends an effects action");
});

it("only the originating version offers to check a pending response", async () => {
  const fixture = effectProposalFixture(), world = structuredClone(FIXTURE_STATE.world!);
  const family = appendEffectProposalTestModel(fixture.family, fixture.timeline, { summary: "A second arrangement", identities: [],
    commands: [{ kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: .2 } } }] });
  const production = world.productions.find(value => value.meta.id === "saltlight")!;
  production.timeline = { status: "ready", timeline: fixture.timeline }; production.effectFamilies = [effectProposalFamilyView(family)];
  const decisions = family.versions.map(version => ({ ...card({ kind: "effect-proposal", productionId: production.meta.id, familyId: family.id, versionId: version.id }),
    id: `effects:${family.id}:${version.id}`, conversationId: family.conversationId }));
  const { host, sent } = await mount(<>{decisions.map(decision => <HumanDecisionCardView key={decision.id} card={decision} />)}</>);
  await act(async () => __setStateForTest({ ...FIXTURE_STATE, world }));
  const first = host.querySelector(`[data-decision="${decisions[0]!.id}"]`)!, second = host.querySelector(`[data-decision="${decisions[1]!.id}"]`)!;
  await press([...first.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Review in timeline")!);
  assert.equal([...first.querySelectorAll("button")].filter(button => button.textContent === "Check response").length, 1);
  assert.equal([...second.querySelectorAll("button")].some(button => button.textContent === "Check response"), false);
  assert.equal([...second.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Review version 2")?.disabled, true);
  const command = sent.find((message): message is Extract<ClientMessage, { kind: "editor-effect-proposal" }> => message.kind === "editor-effect-proposal")!;
  await act(async () => __applyEventForTest({ type: "editor-effect.proposal-result", at: "2026-10-11T20:00:00.000Z", worldId: world.meta.worldId,
    productionId: production.meta.id, requestId: command.requestId, outcome: "refused", reason: "Review interrupted" }));
});

it("auditions a performance in the thread, sends native review fences, ignores unrelated replies and confirms purge", async () => {
  const world = structuredClone(FIXTURE_STATE.world!), production = world.productions.find(p => p.meta.id === "saltlight")!, scene = production.scenes[0]!;
  const id = newId("pf"), at = "2026-10-04T12:00:00Z", hash = `sha256:${"2".repeat(64)}`;
  const technical = { container: "wav", codec: "pcm_s16le", sampleFormat: "s16", sampleRateHz: 48000, channels: 1, bitDepth: 16, durationSec: 1, sizeBytes: 100 };
  const codes = ["decode", "duration", "technicalFormat", "clipping", "silence", "dcOffset", "truePeak", "lufs", "noiseFloor", "snr", "speechPresence", "musicLikelihood", "multipleSpeakers", "transcriptMatch"];
  const performance = ScratchPerformanceSchema.parse({ id, kind: "scratch", target: { productionId: production.meta.id, sceneId: scene.id, sceneVersion: scene.version,
    shotId: orderedShots(scene)[0]!.id, speakerSheetId: "maren-kest", authoredTextHash: hash }, file: `sha256-${"2".repeat(64)}.wav`, createdAt: at, recordedAt: at,
    captureAcknowledgement: { basis: "self", statementVersion: 1, at }, provenance: { schemaVersion: 1,
      source: { kind: "performance-recording", productionId: production.meta.id, performanceId: id, sourceFile: "capture.wav", sourceMediaHash: hash },
      sourceTechnical: technical, outputTechnical: technical, outputHash: hash, preparation: [], createdAt: at,
      qualityReport: { schemaVersion: 1, sourceHash: hash, analyzer: { id: "arke-pcm-qc", version: 1, policyVersion: 1 }, analyzedAt: at, technical,
        measurements: { samplePeakDbfs: null, rmsDbfs: null, fullScaleSampleCount: null, leadingSilenceSec: null, trailingSilenceSec: null, longestInternalSilenceSec: null, dcOffset: null },
        checks: Object.fromEntries(codes.map(code => [code, { code, outcome: code === "silence" ? "warning" : "pass" }])) } } });
  production.performances = [performance];
  const { host, sent } = await mount(<HumanDecisionCardView card={card({ kind: "performance-review", productionId: production.meta.id, performanceId: id })} />);
  await act(async () => __setStateForTest({ ...FIXTURE_STATE, world }));
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent === label)!;
  assert.equal(button("Accept and choose").disabled, true); assert.match(host.textContent!, /silence: warning/);
  let blocked = true;
  setAudioFactoryForTest(() => ({ src: "", currentTime: 0, duration: 1, async play() { if (blocked) throw new Error("Decode failed"); }, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} }));
  await press(button("Hear performance")); assert.equal(button("Accept and choose").disabled, true);
  blocked = false; await press(button("Hear performance")); await press(button("Accept and choose"));
  const review = sent.find((message): message is Extract<ClientMessage, { kind: "review-performance" }> => message.kind === "review-performance")!;
  assert.equal(review.performanceId, id); assert.equal(review.decision, "accept"); assert.equal(review.select, true);
  assert.equal(review.expectedReviewHash, production.performanceReview.reviewHash); assert.equal(review.expectedSelectionHash, production.performanceReview.selectionHash); assert.equal(review.expectedSceneVersion, scene.version);
  await act(async () => __applyEventForTest({ type: "performance.result", at, requestId: newId("pf").slice(3), worldId: world.meta.worldId, productionId: production.meta.id, status: "reviewed" }));
  assert.equal(button("Reject").disabled, true, "another request cannot settle this review");
  await act(async () => __applyEventForTest({ type: "performance.result", at, requestId: review.requestId, worldId: world.meta.worldId, productionId: production.meta.id, status: "refused", reason: "Selection changed" }));
  assert.match(host.textContent!, /Selection changed/);
  await press(button("Purge local media")); assert.equal(sent.some(message => message.kind === "purge-performance"), false);
  await press(button("Confirm purge")); assert.equal(sent.at(-1)!.kind, "purge-performance");
  assert.equal(sent.some(message => message.kind === "conversation-action-decide"), false);
});

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
      generatorPending={false} onCommand={(_, id) => { keptId = id; return true; }} onRenderShot={() => {}} />
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
      generatorPending={false} onCommand={(_, id) => { keptId = id; return true; }} />
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
  // The review's account is Arke's notes, behind the draft bar's disclosure (231c), never the bar's own words.
  assert.doesNotMatch(host.querySelector('[data-testid="stage-draft"]')!.textContent!, /Reviewed in chat/);
  await press(host.querySelector<HTMLElement>(".fy-swstage__notesbtn")!);
  assert.match(host.querySelector('[data-testid="stage-notes"]')!.textContent!, /Reviewed in chat/);
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

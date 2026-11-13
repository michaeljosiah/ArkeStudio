import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MIX, ProductionTimelineSchema, applyTimelineCommands, compileTrustedTimelineSteps,
  finishTrustedTimelineSteps, undoTimelineHistory, redoTimelineHistory,
  type ProductionTimeline, type TimelineChangeHistoryEntry, type TimelineClipCommand,
  type TrustedTimelineReduction, type TrustedTimelineStep,
} from "../src/timeline.js";
import { defaultEffectClip } from "../src/editor-effects.js";
import { effectTimelineCapabilityProblem } from "../src/editor-effect-catalogue.js";

const empty = (): ProductionTimeline => ({ schemaVersion: 1, revision: 0, frameRate: 25, tracks: [
  { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [] },
], history: { undo: [], redo: [] }, mix: DEFAULT_MIX, library: [] });
const human = (base: ProductionTimeline, commands: TimelineClipCommand[]) => applyTimelineCommands(base, commands, { effectAuthority: "human" });
const placed = () => human(empty(), [
  { kind: "add-track", trackId: "tr_fx", trackKind: "effect", name: "Atmosphere" },
  { kind: "effect-create", trackId: "tr_fx", effect: defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 200, seed: 42 }) },
]);
const effect = (timeline: ProductionTimeline) => timeline.tracks.find(track => track.id === "tr_fx")!.effects![0]!;
const protectedBase = () => human(placed(), [{ kind: "effect-protect", rule: { id: "pr_amount", lineageId: "ef_dust", kind: "property", property: "appearance.amount", scope: { kind: "whole" } } }]);
const patch = (value: number): TimelineClipCommand => ({ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { amount: value } } });

test("trusted segments keep human baseline authority local and finalize one ordinary Undo entry", () => {
  const base = protectedBase(), original = structuredClone(base);
  const steps: TrustedTimelineStep[] = [
    { id: "model-colour", authority: "suggestion", commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { colour: "#123456" } } }] },
    { id: "human-amount", authority: "human", commands: [patch(0.71)] },
    { id: "model-motion", authority: "suggestion", commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { motion: { speed: 0.8 } } }] },
  ];
  const reduction = compileTrustedTimelineSteps(base, steps);
  assert.equal(reduction.timeline.revision, base.revision);
  assert.deepEqual(reduction.timeline.history, { undo: [], redo: [] });
  assert.equal(reduction.timeline.effectProtection![0]!.baselineRevision, base.revision + 1);
  assert.equal(effect(reduction.timeline).appearance.amount, 0.71);
  assert.deepEqual(base, original, "compilation neither edits nor freezes the input");
  assert.equal(Object.isFrozen(base.tracks), false);
  const result = finishTrustedTimelineSteps(base, reduction, { label: "Reviewed atmosphere", requestId: "er_family", notes: ["Retained your amount"] });
  assert.equal(result.kind, "changed");
  if (result.kind !== "changed") return;
  ProductionTimelineSchema.parse(result.timeline);
  assert.equal(result.timeline.revision, base.revision + 1);
  assert.equal(result.timeline.history.undo.length, base.history.undo.length + 1);
  assert.equal(result.entry.requestId, "er_family");
  assert.equal(result.entry.effectClips!.length, 1);
  assert.equal(result.entry.effectProtection!.before[0]!.baselineRevision, base.revision);
  assert.equal(result.entry.effectProtection!.after[0]!.baselineRevision, base.revision + 1);
  const undone = undoTimelineHistory(result.timeline);
  assert.deepEqual(undone.tracks, base.tracks);
  assert.deepEqual(undone.effectProtection, base.effectProtection);
  assert.deepEqual(redoTimelineHistory(undone).tracks, result.timeline.tracks);
  assert.throws(() => compileTrustedTimelineSteps(base, [...steps, { id: "late-model", authority: "suggestion", commands: [patch(0.2)] }]), /protect/i);
  assert.throws(() => compileTrustedTimelineSteps(base, [...steps, { id: "model-hide", authority: "suggestion", commands: [{ kind: "set-track", trackId: "tr_fx", muted: true }] }]), /visibility|protect/i);
});

test("protection is checked on a coherent suggestion segment, never leaked from adjacent human steps", () => {
  const base = protectedBase(), amount = effect(base).appearance.amount;
  const coherent: TrustedTimelineStep = { id: "model", authority: "suggestion", commands: [patch(0.1), patch(amount), { kind: "effect-move", clipId: "cl_dust", startFrame: 20 }] };
  const reduction = compileTrustedTimelineSteps(base, [coherent]);
  assert.equal(effect(reduction.timeline).startFrame, 20);
  assert.deepEqual(reduction.timeline.effectProtection, base.effectProtection, "equivalent protected value keeps its baseline revision and fingerprint");
  assert.throws(() => compileTrustedTimelineSteps(base, [
    { id: "model", authority: "suggestion", commands: [patch(0.1)] },
    { id: "human", authority: "human", commands: [patch(amount)] },
  ]), /protect/i, "a later human segment cannot authorize a preceding model violation");
  assert.throws(() => compileTrustedTimelineSteps(base, [{ id: "forged", authority: "suggestion", commands: [{ kind: "effect-release", ruleId: "pr_amount" }] }]), /human/i);
  const released = compileTrustedTimelineSteps(base, [
    { id: "named-release", authority: "human", commands: [{ kind: "effect-release", ruleId: "pr_amount" }] },
    { id: "model", authority: "suggestion", commands: [patch(0.1)] },
  ]);
  assert.equal(effect(released.timeline).appearance.amount, 0.1);
  assert.deepEqual(released.timeline.effectProtection, []);
});

test("empty and net-zero traces preserve Current history while the ordinary wrapper still refuses no change", () => {
  const edited = human(placed(), [patch(0.71)]), base = undoTimelineHistory(edited);
  for (const steps of [[], [{ id: "empty", authority: "suggestion", commands: [] }], [
    { id: "first", authority: "human", commands: [patch(0.1)] },
    { id: "restore", authority: "human", commands: [patch(effect(base).appearance.amount)] },
  ]] satisfies TrustedTimelineStep[][]) {
    const result = finishTrustedTimelineSteps(base, compileTrustedTimelineSteps(base, steps));
    assert.equal(result.kind, "unchanged");
    assert.equal(result.timeline, base);
    assert.equal(result.timeline.history.redo.length, 1);
  }
  assert.throws(() => applyTimelineCommands(base, []), /changes nothing/);
  assert.throws(() => applyTimelineCommands(base, [patch(effect(base).appearance.amount)]), /changes nothing/);
  const protectedTimeline = protectedBase();
  const restored = compileTrustedTimelineSteps(protectedTimeline, [
    { id: "adjust", authority: "human", commands: [patch(0.71)] },
    { id: "restore", authority: "human", commands: [patch(effect(protectedTimeline).appearance.amount)] },
  ]);
  assert.deepEqual(restored.timeline.effectProtection, protectedTimeline.effectProtection);
  assert.equal(finishTrustedTimelineSteps(protectedTimeline, restored).kind, "unchanged", "a synthetic baseline revision cannot turn a net-zero arrangement into an edit");
});

test("opaque reductions bind the authored base, permit live history, and resist mutation and forgery", () => {
  const base = placed(), scratch = { ...base, history: { undo: [], redo: [] } };
  const reduction = compileTrustedTimelineSteps(scratch, [{ id: "human", authority: "human", commands: [patch(0.71)] }]);
  const result = finishTrustedTimelineSteps(base, reduction);
  assert.equal(result.kind, "changed");
  assert.equal(result.timeline.history.undo.length, base.history.undo.length + 1);
  assert.throws(() => { effect(reduction.timeline).appearance.amount = 0.2; }, /read only|readonly|frozen|assign/i);
  assert.throws(() => finishTrustedTimelineSteps(base, { timeline: reduction.timeline } as TrustedTimelineReduction), /trusted steps/);
  assert.throws(() => finishTrustedTimelineSteps({ ...base, revision: base.revision + 1 }, reduction), /different authored base/);
  const changed = structuredClone(base); changed.tracks[0]!.name = "Changed Current";
  assert.throws(() => finishTrustedTimelineSteps(changed, reduction), /different authored base/);
  assert.equal(Object.isFrozen(effect(result.timeline)), false, "ordinary authored results remain mutable copies");
});

test("long pending traces keep one prospective baseline revision and a net history entry", () => {
  const base = protectedBase();
  const steps: TrustedTimelineStep[] = Array.from({ length: 200 }, (_, index) => ({ id: `gesture-${index}`, authority: "human", commands: [patch(index % 2 ? 0.71 : 0.2)] }));
  const reduction = compileTrustedTimelineSteps(base, steps);
  assert.equal(reduction.timeline.effectProtection![0]!.baselineRevision, base.revision + 1);
  assert.deepEqual(reduction.timeline.history, { undo: [], redo: [] });
  const result = finishTrustedTimelineSteps(base, reduction);
  assert.equal(result.kind, "changed");
  if (result.kind !== "changed") return;
  assert.equal(result.entry.effectClips!.length, 1);
  assert.equal(result.timeline.history.undo.length, base.history.undo.length + 1);
  assert.deepEqual(undoTimelineHistory(result.timeline).effectProtection, base.effectProtection);
});

test("the finalizer charges the actual retained live history instead of intermediate pending entries", () => {
  const base = placed();
  const big = effect(base);
  big.cueOverrides = Array.from({ length: 2000 }, (_, index) => ({ id: `ec_${index}`, frame: index, durationFrames: 1, strength: 0.7, kind: "accent" as const }));
  const retained: TimelineChangeHistoryEntry = { kind: "change", label: "Earlier effect edit", clips: [], tracks: [], cues: [], selections: [], effectClips: [{ trackId: "tr_fx", before: big, after: big }] };
  base.history = { undo: [], redo: [] };
  while (effectTimelineCapabilityProblem({ ...base, history: { undo: [...base.history.undo, retained], redo: [] } }) === null) base.history.undo.push(retained);
  assert.equal(effectTimelineCapabilityProblem(base), null);
  const reduction = compileTrustedTimelineSteps({ ...base, history: { undo: [], redo: [] } }, [{ id: "human", authority: "human", commands: [patch(0.71)] }]);
  assert.equal(finishTrustedTimelineSteps({ ...base, history: { undo: [], redo: [] } }, reduction).kind, "changed");
  assert.throws(() => finishTrustedTimelineSteps(base, reduction), /4 MiB authored-data budget/);
});

test("ordinary single-step application equals the trusted reducer and keeps selection-only actions", () => {
  const base = placed();
  const commands: TimelineClipCommand[] = [{ kind: "effect-split", clipId: "cl_dust", atFrame: 80, newClipId: "cl_right" }, { kind: "effect-trim", clipId: "cl_right", edge: "tail", deltaFrames: -20 }];
  const options = { label: "Shorten second passage", requestId: "er_family", notes: ["Keep the original phase"] };
  const direct = applyTimelineCommands(base, commands, { ...options, effectAuthority: "human" });
  const result = finishTrustedTimelineSteps(base, compileTrustedTimelineSteps(base, [{ id: "human", authority: "human", commands }]), options);
  assert.equal(result.kind, "changed");
  assert.deepEqual(result.timeline, direct);
  assert.deepEqual(undoTimelineHistory(result.timeline).tracks, base.tracks);
  const selection = { shotId: "sh_pick", before: null, after: { acceptedTakeId: null, trimInSec: 2 } };
  const selected = finishTrustedTimelineSteps(base, compileTrustedTimelineSteps(base, []), { label: "Choose source trim", selections: [selection] });
  assert.equal(selected.kind, "changed");
  if (selected.kind === "changed") assert.deepEqual(selected.entry.selections, [selection]);
  ProductionTimelineSchema.parse(selected.timeline);
});

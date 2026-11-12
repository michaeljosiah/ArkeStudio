import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MIX,
  EditorRequestSchema,
  ModelEditorRequestSchema,
  TIMELINE_EDITOR_COMMAND_GUIDE,
  TIMELINE_EDITOR_COMMAND_NAMES,
  TimelineCommandSchema,
  ProductionTimelineSchema,
  WorldChatTurnResultSchema,
  applyTimelineCommands,
  describeEditorRequestDigest,
  defaultEffectClip,
  genericEditorRequestRefusal,
  editorRequestStaleness,
  editorRequestUndone,
  previewEditorRequest,
  undoTimelineHistory,
  type ProductionTimeline,
  type TimelineClip,
} from "../src/index.js";

/**
 * Arke's editor requests as pure contracts (SPEC-039 R-27, R-28, R-32..R-34, R-36; issue 684):
 * the typed field is the only way a turn carries one, a preview is the digest a card states and
 * the ghost a timeline draws, and staleness is judged the way the coordinator judges it.
 */

it("keeps live-source detachment in direct commands and out of model editor requests", () => {
  const command = { kind: "detach-audio", clipId: "cl_picture", newClipId: "cl_sound" };
  assert.equal(TimelineCommandSchema.safeParse(command).success, true);
  assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Detach audio", commands: [command] }).success, false);
  assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Move sound", commands: [{ kind: "move-to-frame", clipId: "cl_sound", startFrame: 24 }] }).success, true);
});

it("does not grant generic requests effect or protection authority (SPEC-053 R-26, R-36)", () => {
  const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 120, seed: 7 });
  const timeline: ProductionTimeline = { ...base, tracks: [...base.tracks,
    { id: "tr_effects", kind: "effect", name: "Effects", order: 1, muted: false, clips: [], effects: [effect] },
  ] };
  for (const command of [
    { kind: "effect-create", trackId: "tr_effects", effect },
    { kind: "effect-release", ruleId: "pr_colour" },
  ]) assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Effects", commands: [command] }).success, false);
  for (const command of [
    { kind: "add-track" as const, trackId: "tr_new", trackKind: "effect" as const, name: "Effects" },
    { kind: "set-track" as const, trackId: "tr_effects", muted: true },
    { kind: "remove-track" as const, trackId: "tr_effects" },
  ] as const) {
    assert.match(genericEditorRequestRefusal(timeline, [command])!, /effects arrangement review/i);
    assert.equal(previewEditorRequest(timeline, [command]).ok, false);
  }
  assert.equal(genericEditorRequestRefusal(timeline, [{ kind: "set-track", trackId: "tr_picture", name: "Film" }]), null);
});

it("lets a request move a still and fade a picture at an open edge, as it can set a gain", () => {
  const still: TimelineClip = { id: "cl_still", startFrame: 120, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_still", label: "Still" } };
  const timeline: ProductionTimeline = { ...base, tracks: base.tracks.map(track => ({ ...track, clips: [...track.clips, still] })) };
  const commands = [
    { kind: "picture-motion" as const, clipId: "cl_still" as const, motion: { kind: "drift-left" as const, amount: .12 } },
    { kind: "picture-fade" as const, clipId: "cl_still" as const, outFrames: 24 },
  ];
  assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Drift and fade out", commands }).success, true);
  assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Too far", commands: [{ ...commands[0], motion: { kind: "drift-left", amount: .6 } }] }).success, false);
  assert.equal(genericEditorRequestRefusal(timeline, commands), null);
  const preview = previewEditorRequest(timeline, commands);
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.deepEqual(preview.digest.changed, ["Still"]);
  assert.deepEqual(preview.digest.effects, [{ label: "Change Still (cl_still)",
    detail: "tr_picture, frames 120-216, source 0-96 -> tr_picture, frames 120-216, source 0-96, drift-left 0.12, fade in 0 out 24" }], "the card states the move and the fade");
  assert.equal(previewEditorRequest(timeline, [{ kind: "picture-motion", clipId: "cl_missing", motion: null }]).ok, false);
  for (const said of ["picture-motion (clipId, motion)", "picture-fade (clipId, inFrames, outFrames)", "push-in | pull-out | drift-left | drift-right | drift-up | drift-down", "only a still image moves"]) {
    assert.ok(TIMELINE_EDITOR_COMMAND_GUIDE.includes(said), said);
  }
});

const REQUEST = "req_01J8G0000000000000000000R1";
const FINGERPRINT = `story-picture-v1:${"a".repeat(16)}`;

function clip(id: `cl_${string}`, startFrame: number, durationFrames: number, shotId: string, shotNumber: number): TimelineClip {
  return {
    id,
    startFrame,
    durationFrames,
    sourceInFrames: 0,
    source: { kind: "shot", shotId, sceneNumber: 1, shotNumber, label: shotId },
  };
}

const base: ProductionTimeline = ProductionTimelineSchema.parse({
  schemaVersion: 1,
  revision: 3,
  frameRate: 24,
  tracks: [
    {
      id: "tr_picture",
      kind: "picture",
      name: "Picture",
      order: 0,
      muted: false,
      clips: [clip("cl_sh-1", 0, 48, "sh_1", 1), clip("cl_sh-2", 48, 24, "sh_2", 2), clip("cl_sh-3", 72, 48, "sh_3", 3)],
    },
  ],
  history: { undo: [], redo: [] },
  mix: DEFAULT_MIX,
});

describe("editor requests (issue 684)", () => {
  it("a reply's prose carries no request; only the typed field does (A-7)", () => {
    const prose = WorldChatTurnResultSchema.parse({
      reply: "I moved the bell close-up to the front for you.",
      candidateOperations: [],
      groupOperations: [],
    });
    assert.deepEqual(prose.editorRequests, []);
    const typed = WorldChatTurnResultSchema.parse({
      reply: "Ready for you to accept.",
      candidateOperations: [],
      groupOperations: [],
      editorRequests: [{ summary: "Bring the bell close-up to the front", commands: [{ kind: "move-to-order", clipId: "cl_sh-3", index: 0 }] }],
    });
    assert.equal(typed.editorRequests.length, 1);
    assert.throws(() => WorldChatTurnResultSchema.parse({ ...typed, editorRequests: [{ summary: "", commands: [] }] }));
  });

  it("a scene edit is a typed rename, bounded to one a turn and never blank (SPEC-036 R-38)", () => {
    const prose = WorldChatTurnResultSchema.parse({ reply: "I named it for you.", candidateOperations: [], groupOperations: [] });
    assert.deepEqual(prose.sceneEdits, [], "prose alone renames nothing");
    const typed = WorldChatTurnResultSchema.parse({
      reply: "Called it The tide answers.",
      candidateOperations: [],
      groupOperations: [],
      sceneEdits: [{ kind: "rename", title: "  The tide answers  " }],
    });
    assert.deepEqual(typed.sceneEdits, [{ kind: "rename", title: "The tide answers" }], "trimmed on the way in");
    assert.throws(() => WorldChatTurnResultSchema.parse({ ...typed, sceneEdits: [{ kind: "rename", title: "   " }] }), "whitespace is not a name");
    assert.throws(
      () => WorldChatTurnResultSchema.parse({ ...typed, sceneEdits: [{ kind: "rename", title: "One" }, { kind: "rename", title: "Two" }] }),
      "one rename a turn",
    );
  });

  it("previews a request as a digest and a ghost, without touching the base", () => {
    const before = JSON.stringify(base);
    const preview = previewEditorRequest(base, [{ kind: "move-to-order", clipId: "cl_sh-3", index: 0 }]);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.ok(preview.digest.moved.includes("sh_3"), "the moved clip is named");
    assert.equal(preview.digest.storyOrderChanges, true);
    assert.deepEqual(preview.digest.range, { startFrame: 0, endFrame: 120 });
    assert.equal(preview.timeline.revision, 4, "the ghost is the base plus one revision, in memory");
    assert.equal(JSON.stringify(base), before, "the base is untouched");
    const lines = describeEditorRequestDigest(preview.digest, 24);
    assert.ok(lines.some((line) => line.startsWith("Moves ")), lines.join(" | "));
    assert.ok(lines.includes("Range 0.0s – 5.0s"));
    assert.ok(lines.includes("Story order changes"));

    const removed = previewEditorRequest(base, [{ kind: "delete", clipId: "cl_sh-2" }]);
    assert.equal(removed.ok, true);
    if (removed.ok) assert.deepEqual(removed.digest.removed, ["sh_2"]);

    const trimmed = previewEditorRequest(base, [{ kind: "trim", clipId: "cl_sh-1", edge: "end", deltaFrames: -12 }]);
    assert.equal(trimmed.ok, true);
    if (trimmed.ok) {
      assert.ok(trimmed.digest.changed.includes("sh_1"));
      assert.equal(trimmed.digest.storyOrderChanges, false);
      assert.ok(describeEditorRequestDigest(trimmed.digest, 24).includes("Story order unchanged"));
    }
  });

  it("refuses a request that cannot apply, with the reason", () => {
    const preview = previewEditorRequest(base, [{ kind: "delete", clipId: "cl_nowhere" }]);
    assert.equal(preview.ok, false);
    if (!preview.ok) assert.match(preview.reason, /cl_nowhere/);
  });

  it("is stale when the base moved, and never rebased", () => {
    const pending = { status: "pending" as const, baseRevision: 3, sourceFingerprint: FINGERPRINT };
    assert.equal(editorRequestStaleness(pending, { status: "ready", timeline: base }, FINGERPRINT), null);
    assert.match(editorRequestStaleness(pending, { status: "ready", timeline: { ...base, revision: 4 } }, FINGERPRINT) ?? "", /revision 4/);
    const first = { ...pending, baseRevision: null };
    assert.equal(editorRequestStaleness(first, { status: "absent" }, FINGERPRINT), null);
    assert.match(editorRequestStaleness(first, { status: "absent" }, `story-picture-v1:${"b".repeat(16)}`) ?? "", /changed/);
    assert.match(editorRequestStaleness(first, { status: "ready", timeline: base }, FINGERPRINT) ?? "", /revision 3/);
    assert.match(editorRequestStaleness(pending, { status: "absent" }, FINGERPRINT) ?? "", /gone/);
    assert.equal(editorRequestStaleness({ ...pending, status: "accepted" }, { status: "ready", timeline: { ...base, revision: 9 } }, FINGERPRINT), null);
  });

  it("keeps an accepted status through Undo and says the action was undone (R-36)", () => {
    const accepted = applyTimelineCommands(base, [{ kind: "move-to-order", clipId: "cl_sh-3", index: 0 }], { requestId: REQUEST, label: "Bring it forward" });
    const record = EditorRequestSchema.parse({
      id: REQUEST,
      productionId: "bell-watch",
      conversationId: "cv_01J8G0000000000000000000C1",
      baseRevision: 3,
      sourceFingerprint: FINGERPRINT,
      commands: [{ kind: "move-to-order", clipId: "cl_sh-3", index: 0 }],
      summary: "Bring it forward",
      createdAt: "2026-09-02T10:00:00Z",
      status: "accepted",
      decidedAt: "2026-09-02T10:01:00Z",
      resultRevision: 4,
    });
    assert.equal(editorRequestUndone(record, { status: "ready", timeline: accepted }), false);
    const undone = undoTimelineHistory(accepted);
    // The mark is on the record, written by the coordinator with the undo; the redo stack is
    // transient and says nothing durable.
    assert.equal(editorRequestUndone(record, { status: "ready", timeline: undone }), false);
    assert.equal(editorRequestUndone({ ...record, undoneAt: "2026-09-02T10:02:00Z" }, { status: "ready", timeline: undone }), true);
    assert.equal(editorRequestUndone({ ...record, status: "rejected", undoneAt: "2026-09-02T10:02:00Z" }), false);
    assert.equal(record.status, "accepted", "the status is not rewritten");
  });
});

describe("text in a request (SPEC-065 slice 2)", () => {
  const look = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false, align: "center",
    x: 0.5, y: 0.5, room: 0.8, fill: { kind: "solid", color: "#ffffff" } } as const;
  const name = (text: string, source: Record<string, unknown> = {}, lookPatch: Record<string, unknown> = {}) => ({ kind: "place" as const, trackId: "tr_picture" as const,
    clip: { id: "cl_name" as const, startFrame: 120, durationFrames: 48, sourceInFrames: 0, source: { kind: "text" as const, label: "Ade", text, look: { ...look, ...lookPatch }, ...source } } });
  const request = (commands: unknown[]) => ({ id: REQUEST, productionId: "bell-watch", conversationId: "cv_01J8G0000000000000000000C1", baseRevision: 3,
    sourceFingerprint: FINGERPRINT, commands, summary: "Name her", createdAt: "2026-09-02T10:00:00Z", status: "pending" });

  it("a request's place may carry text, held to the same bounds", () => {
    assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Name her", commands: [name("Ade")] }).success, true);
    assert.equal(EditorRequestSchema.safeParse(request([name("Ade")])).success, true);
    // R-26: the bounds are on the field every text payload shares, so a request meets them as a place does.
    const broken = [name("a".repeat(501)), name(Array(13).fill("a").join("\n")), name(" \n \n"), name("Ade", { font: "serif" }), name("Ade", {}, { size: 0.5 })];
    for (const command of broken) {
      assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Name her", commands: [command] }).success, false, JSON.stringify(command.clip.source).slice(0, 80));
      assert.equal(EditorRequestSchema.safeParse(request([command])).success, false);
    }
    // Nothing is cut to fit, and what a request's preview places is what a write stores (R-4, R-6).
    const preview = previewEditorRequest(base, [name("\nAde\r\nthe healer\n", { label: "Someone" })]);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    const placed = preview.timeline.tracks[0]!.clips.find(clip => clip.id === "cl_name")!;
    assert.deepEqual(placed.source, { kind: "text", label: "Ade", text: "Ade\nthe healer", look });
  });

  it("a request cannot send text-set yet", () => {
    const set = { kind: "text-set", clipIds: ["cl_name"], text: "Kemi" };
    assert.equal(TimelineCommandSchema.safeParse(set).success, true, "a person's command");
    assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Rename her", commands: [set] }).success, false);
    assert.equal(EditorRequestSchema.safeParse(request([set])).success, false);
    assert.equal(TIMELINE_EDITOR_COMMAND_NAMES.split(" | ").includes("text-set"), false, "Arke is not told of a command it cannot send");
  });
});

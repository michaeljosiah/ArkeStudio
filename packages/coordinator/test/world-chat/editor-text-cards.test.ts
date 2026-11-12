import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  EditorRequestSchema,
  ProductionTimelineSchema,
  TEXT_PICTURE_DIR,
  describeEditorTextChange,
  editorTextChanges,
  newId,
  previewEditorRequest,
  storyTimelineFingerprint,
  textPicturePath,
  ulid,
  type ConversationActionCard,
  type ConversationId,
  type MessageId,
  type ModelEditorRequest,
  type TextLook,
  type TimelineCommand,
  type WorldChatContext,
} from "@arke-studio/contracts";
import { ConversationActionLifecycle } from "../../src/arke-actions/lifecycle.js";
import { describeCoordinatorError } from "../../src/errors/user-message.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { readEditorRequest, stageEditorRequests } from "../../src/productions/editor-requests.js";
import { textPictureSizes, textPicturesNamed } from "../../src/productions/editor-text-cache.js";
import { applyHumanTimelineCommand } from "../../src/productions/timeline.js";
import { prepareWorldChatActions, worldChatActionAdapters, type WorldChatActionTurn } from "../../src/world-chat/actions.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { parseTurnResult } from "../../src/world-chat/turn-result.js";
import { EDITOR_TEXT_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";

/**
 * Arke's titles from the answer to the card (SPEC-065 R-35 – R-37, SPEC-039 R-26 – R-31): the
 * answer is held to the record when the turn is parsed, asked of the painter by the turn's dry
 * run, staged as a card that states every title in full, and lands on the timeline only on the
 * person's Approve, as one revision and one Undo entry. Deny leaves the cut as it was.
 */

const AT = "2026-11-12T12:00:00.000Z";
const NOW = () => AT;
const PRODUCTION = "saltlight";
const CONTEXT: WorldChatContext = { kind: "production", productionId: PRODUCTION };
const PROMO: TextLook = { typeface: "eb-garamond", weight: "regular", italic: false, size: 0.071, tracking: 0, leading: 1.2, capitals: false, align: "center",
  x: 0.5, y: 0.75, room: 0.815,
  fill: { kind: "gradient", stops: [{ at: 0, color: "#f6da94" }, { at: 0.38, color: "#e9c069" }, { at: 0.7, color: "#c9973d" }, { at: 1, color: "#9c6a1e" }] },
  edge: { color: "#1a1208", width: 0.022 }, shadow: { color: "#000000", opacity: 0.85, blur: 0.25, dx: 0, dy: 0.03 },
  rule: { length: 0.178, weight: 0.022, gap: 0.42, soft: true }, backing: { kind: "shade", color: "#060402", opacity: 0.9 } };
const NAMES = [["cl_ade", "Ade\nthe healer", 24], ["cl_ife", "Ifẹ", 160], ["cl_kemi", "Kemi", 296], ["cl_tunde", "Tunde", 432]] as const;
const LINES = [
  "Adds text “Ade ⏎ the healer” · Names · frames 24–136 · Lower third",
  "Adds text “Ifẹ” · Names · frames 160–272 · Lower third",
  "Adds text “Kemi” · Names · frames 296–408 · Lower third",
  "Adds text “Tunde” · Names · frames 432–544 · Lower third",
];
const place = (id: string, text: string, startFrame: number, look: object = PROMO, source: object = {}) => ({ kind: "place", trackId: "tr_names",
  clip: { id, startFrame, durationFrames: 112, sourceInFrames: 0, fade: { inFrames: 24, outFrames: 30 },
    source: { kind: "text", label: text.split("\n")[0], text, look, ...source } } });
const ADD_NAMES = { kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" };
const FOUR = [ADD_NAMES, ...NAMES.map(([id, text, startFrame]) => place(id, text, startFrame))];
/** A command as the record takes it. */
const commandOf = (command: object): TimelineCommand => {
  const parsed = EditorRequestSchema.shape.commands.element.safeParse(command);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
};
/** Arke's answer in a production thread, as the model returns it. */
const answer = (commands: readonly object[], summary = "Name the four") =>
  JSON.stringify({ reply: "Ready for you to approve.", candidateOperations: [], groupOperations: [], editorRequests: [{ summary, commands }] });

async function setup() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: NOW });
  closeOnCleanup(() => store.close());
  const conversationId = newId("cv") as ConversationId;
  const log = new WorldChatStore(conversationDir(store.dir, conversationId));
  await log.create(conversationId, AT);
  await log.append({ type: "conversation.created", title: "Names", entryContext: CONTEXT }, { at: AT });
  const lifecycle = new ConversationActionLifecycle({ worldPath: store.dir, worldId: store.worldId,
    adapters: worldChatActionAdapters(store, new ProposalManager(store), NOW, {}), now: NOW });
  const production = () => store.getBundle().productions.find(one => one.meta.id === PRODUCTION)!;
  const still = store.getBundle().artifacts.find(one => one.kind === "board")!;
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production()),
    commands: [{ kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 96, sourceInFrames: 0,
      source: { kind: "artifact", artifactId: still.id, label: "Still" } } }] });
  const raw = () => readFile(join(store.dir, "productions", PRODUCTION, "timeline.json"), "utf8");
  const read = async () => ProductionTimelineSchema.parse(JSON.parse(await raw()));
  return { store, conversationId, log, lifecycle, production, raw, read };
}

async function loaded(log: WorldChatStore) {
  const meta = (await log.readMeta())!;
  return foldConversation(meta.id, meta.createdAt, (await log.read()).events).view;
}

/** The turn as the run hands it on once the answer has parsed: its requests dry-run, then prepared, recorded and bound to cards. */
async function card(w: Awaited<ReturnType<typeof setup>>, raw: string): Promise<ConversationActionCard> {
  const parsed = parseTurnResult(raw, true);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unparsed");
  const requests: readonly ModelEditorRequest[] = parsed.value.editorRequests;
  await stageEditorRequests(w.store, { conversationId: w.conversationId, entryContext: CONTEXT, requests, now: AT, dryRun: true });
  const turn: WorldChatActionTurn = { conversationId: w.conversationId, turnId: newId("turn"), entryContext: CONTEXT, existingCandidates: [], existingGroups: [],
    candidates: [], groups: [], bibleEdits: [], bibleBaseVersion: 1, sceneEdits: [], sceneBaseVersion: null, editorRequests: requests, actions: [], at: AT };
  const prepared = prepareWorldChatActions(w.store, w.lifecycle, turn);
  await w.log.append({ type: "turn.completed",
    message: { id: newId("msg") as MessageId, turnId: turn.turnId, role: "studio", text: "Ready for you to approve.", attachmentIds: [], createdAt: AT },
    run: { id: newId("run"), turnId: turn.turnId, basedOnConversationSeq: 1, status: "completed", adapter: "test", harnessCleanup: "not-required",
      contextDigest: `sha256:${"a".repeat(64)}`, startedAt: AT, endedAt: AT },
    receipts: [], candidates: [], groups: [], tombstones: [], actionPrepareIntents: prepared.map(action => action.intent) }, { at: AT });
  for (const action of prepared) await w.lifecycle.bindIntent(action.intent, action.payload);
  return (await loaded(w.log)).actions.find(action => action.actionId === prepared[0]!.intent.actionId)!;
}

async function decide(w: Awaited<ReturnType<typeof setup>>, action: ConversationActionCard, decision: "approve" | "deny") {
  return w.lifecycle.decide({ kind: "conversation-action-decide", worldId: action.worldId, conversationId: action.conversationId, actionId: action.actionId,
    expectedConversationSeq: (await loaded(w.log)).seq, expectedStatus: "pending", decision, requestId: ulid() });
}

/** Every name the four titles' pictures would be kept under, at every size. */
function pictureNames(): string[] {
  return NAMES.flatMap(([, text]) => textPictureSizes({ text, look: PROMO, label: text }).map(size => {
    const ref = textPicturePath({ text, look: PROMO }, size);
    if (!ref.ok) throw new Error(ref.reason);
    return ref.name;
  }));
}

describe("Arke's titles on a card (SPEC-065 R-35 – R-37)", () => {
  it("Arke's four names reach a card that states each in full, and Approve lands them as one revision and one Undo entry", async () => {
    const w = await setup();
    const base = await w.read();
    const action = await card(w, answer(FOUR));
    const preview = action.shown.productionPreview;
    assert.equal(preview?.kind, "timeline");
    if (preview?.kind !== "timeline") return;
    assert.deepEqual(editorTextChanges(preview.before, preview.after).map(describeEditorTextChange), LINES, "the card's timeline states each title");
    assert.equal(action.shown.body.family, "command");
    if (action.shown.body.family !== "command") return;
    for (const line of LINES) assert.ok(action.shown.body.expectedResult.includes(line), `the approved digest holds ${line}`);

    // Nothing lands, and nothing is painted, before the person approves.
    assert.deepEqual(await w.read(), base);
    assert.equal(await stat(join(w.store.dir, TEXT_PICTURE_DIR)).then(() => true, () => false), false);

    assert.equal((await decide(w, action, "approve")).status, "completed");
    const after = await w.read(), entry = after.history.undo.at(-1);
    assert.equal(after.revision, base.revision + 1);
    assert.equal(after.history.undo.length, base.history.undo.length + 1);
    assert.equal(entry?.kind === "change" ? entry.requestId : null, action.authority.id);
    assert.deepEqual(after.tracks.find(track => track.name === "Names")?.clips.map(clip => clip.source.kind === "text" ? clip.source.text : null), NAMES.map(([, text]) => text));
    assert.equal((await readEditorRequest(w.store, PRODUCTION, action.authority.id))?.status, "accepted");
  });

  it("Deny leaves the cut as it was and names no picture (SPEC-039 R-31)", async () => {
    const w = await setup();
    const before = await w.raw();
    const action = await card(w, answer(FOUR));
    const named = () => textPicturesNamed(w.store.getBundle().productions);
    assert.ok(pictureNames().every(name => named().has(name)), "a pending card's pictures are named, so its Preview can be drawn");
    assert.equal((await decide(w, action, "deny")).status, "denied");
    assert.equal((await readEditorRequest(w.store, PRODUCTION, action.authority.id))?.status, "rejected");
    assert.equal(await w.raw(), before);
    assert.ok(pictureNames().every(name => !named().has(name)));
  });

  it("an answer whose title the record refuses is refused at parse, by field and bound, before any card (R-26, R-37)", async () => {
    const w = await setup();
    const set = (over: object) => ({ kind: "text-set", clipIds: ["cl_ade"], ...over });
    const thirteen = Array(13).fill("a").join("\n");
    const at = "editorRequests.0.commands.0";
    const cases: [object, string][] = [
      [place("cl_name", thirteen, 600), `${at}.clip.source.text: Text holds at most 12 lines`],
      [place("cl_name", "a".repeat(501), 600), `${at}.clip.source.text: Text holds at most 500 characters`],
      [place("cl_name", " \n \n", 600), `${at}.clip.source.text: Type some words`],
      [place("cl_name", "Ade", 600, { ...PROMO, size: 0.5 }), `${at}.clip.source.look.size allows at most 0.4`],
      [place("cl_name", "Ade", 600, PROMO, { font: "serif" }), `${at}.clip.source has unknown field: font`],
      [place("cl_name", "Ade", 600, { ...PROMO, typeface: "arial" }),
        `${at}.clip.source.look.typeface must be one of "geist" | "jost" | "comic-neue" | "bangers" | "eb-garamond" | "cinzel"`],
      [set({ text: thirteen }), `${at}.text: Text holds at most 12 lines`],
      [set({ clipIds: Array.from({ length: 51 }, (_, index) => `cl_n${index}`), look: { size: 0.09 } }), `${at}.clipIds allows at most 50 items`],
    ];
    for (const [command, line] of cases) {
      const parsed = parseTurnResult(answer([command]), true);
      assert.deepEqual(parsed.ok ? [] : parsed.problems.map(problem => problem.safeMessage), [line]);
      // The record refuses the same command, so no request file could hold one for Accept to meet.
      assert.equal(EditorRequestSchema.safeParse({ id: "req_01J8G0000000000000000000R1", productionId: PRODUCTION, conversationId: w.conversationId,
        baseRevision: 1, sourceFingerprint: storyTimelineFingerprint(w.production()), commands: [command], summary: "Name her", createdAt: AT, status: "pending" }).success, false);
    }
    // The words' sentences are the reducer's own, as a person's text-set meets them.
    const named = previewEditorRequest(await w.read(), FOUR.map(commandOf));
    assert.ok(named.ok);
    if (!named.ok) return;
    for (const [words, reason] of [[thirteen, "Text holds at most 12 lines"], ["a".repeat(501), "Text holds at most 500 characters"], [" \n \n", "Type some words"]] as const) {
      assert.deepEqual(previewEditorRequest(named.timeline, [{ kind: "text-set", clipIds: ["cl_ade"], text: words }]), { ok: false, reason });
    }
    assert.equal(w.production().editorRequests.length, 0);
  });

  it("an answer whose title the painter refuses is refused by the turn's dry run, in Accept's words, and stages nothing", async () => {
    const w = await setup();
    const version = (await readWorldMeta(w.store.dir)).schemaVersion;
    assert.ok(version < EDITOR_TEXT_SCHEMA_VERSION);
    const parsed = parseTurnResult(answer([ADD_NAMES, ...NAMES.map(([id, text, startFrame]) => place(id, text, startFrame, { ...PROMO, typeface: "jost" }))]), true);
    assert.ok(parsed.ok, "the record takes it: Jost is a face");
    if (!parsed.ok) return;
    const stage = (dryRun: boolean) => stageEditorRequests(w.store, { conversationId: w.conversationId, entryContext: CONTEXT, requests: parsed.value.editorRequests, now: AT, dryRun });
    for (const dryRun of [true, false]) {
      const refused = await stage(dryRun).then(() => null, (error: unknown) => `The editor request was refused: ${describeCoordinatorError(error)}`);
      assert.equal(refused, "The editor request was refused: \"Name the four\" cannot apply: Jost has no ẹ", `dry run ${dryRun}`);
    }
    assert.equal(await readFile(join(w.store.dir, "productions", PRODUCTION, "editor-requests.json"), "utf8").catch(() => null), null);
    assert.equal((await readWorldMeta(w.store.dir)).schemaVersion, version, "nothing was written, so nothing raised the floor");
  });
});

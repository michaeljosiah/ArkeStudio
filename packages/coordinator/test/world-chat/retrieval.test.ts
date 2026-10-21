import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  migrateLegacyScene,
  type ChatAttachmentId,
  type ConversationId,
  type RunId,
  type WorldChatAttachment,
  type WorldChatCheckReceipt,
  type ProductionTimeline,
  WorldChangeCandidateSchema,
  type WorldChangeCandidate,
  type CandidateGroup,
  type WorldChatStoredEvent,
  type ArkeTargetReadPage,
  type ArtifactSidecar,
} from "@arke-studio/contracts";
import { WorldIndex } from "../../src/index-db/world-index.js";
import { WorldQueryServer } from "../../src/harness/world-query.js";
import { WorldChatAttachmentStore } from "../../src/world-chat/attachments.js";
import { LeaseDeniedError, QueryLeaseRegistry } from "../../src/world-chat/lease.js";
import { RetrievalError, WorldChatRetrieval, type RetrievalDeps } from "../../src/world-chat/retrieval.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { assembleContext } from "../../src/world-chat/context.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { buildItemsFence, exportsFence, type ArkeBuildItemRead, type ArkeExportReadRecord } from "../../src/world-chat/target-reads.js";
import { fixtureBundle } from "../index-db/helpers.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

/**
 * The leased read surface and its receipts (#70 §9.2–§9.4).
 *
 * The receipts are the part that matters. A candidate is called new because a search happened and
 * found nothing — so a search that could not run must say so, and never look like one that ran and
 * came back empty.
 */

const NOW = () => "2026-08-06T10:00:00Z";

async function harness(options: {
  withIndex?: boolean;
  buildItems?: () => readonly ArkeBuildItemRead[];
  exports?: (worldId: string) => readonly ArkeExportReadRecord[];
  withDrafts?: boolean;
  drafts?: RetrievalDeps["getConversationDrafts"];
  textBudget?: number;
} = {}) {
  const worldDir = await makeTempWorld();
  const bundle = await fixtureBundle();
  const index = options.withIndex === false ? null : WorldIndex.open(worldDir, bundle);

  const worldPath = await tempDir("arke-retrieval-");
  const conversationId = newId("cv") as ConversationId;
  const runId = newId("run") as RunId;
  const log = new WorldChatStore(conversationDir(worldPath, conversationId));
  await log.create(conversationId, NOW());
  await log.append(
    { type: "conversation.created", title: "retrieval", entryContext: { kind: "world" } },
    { at: NOW() },
  );

  const attachments = new WorldChatAttachmentStore(worldPath, NOW);
  const state = { world: bundle.meta.worldId as string | null };
  const leases = new QueryLeaseRegistry(() => state.world, () => 1_000);
  const known = new Map<string, WorldChatAttachment>();

  const retrieval = new WorldChatRetrieval({
    leases,
    getBundle: () => bundle,
    getIndex: () => index,
    attachments,
    findAttachment: async (_lease, id) => known.get(id) ?? null,
    ...(options.withDrafts ? { getConversationDrafts: async (lease: import("../../src/world-chat/lease.js").QueryLease) => {
      const loaded = await new WorldChatService(worldPath).load(lease.conversationId);
      if (!loaded || loaded.problems.length) throw new RetrievalError("unavailable", "The retained drafts could not be read completely.");
      return loaded;
    } } : {}),
    ...(options.drafts ? { getConversationDrafts: options.drafts } : {}),
    ...(options.textBudget !== undefined ? { textBudgetChars: () => options.textBudget! } : {}),
    ...(options.exports ? { getExports: () => options.exports!(bundle.meta.worldId) } : {}),
    ...(options.buildItems ? { getBuildItems: options.buildItems } : {}),
    now: NOW,
  });

  const mint = (allowed: ChatAttachmentId[] = []) =>
    leases.mint({ worldId: bundle.meta.worldId, conversationId, runId, allowedAttachmentIds: allowed });

  return { retrieval, leases, mint, state, attachments, conversationId, known, index, runId, bundle, log, worldPath };
}

function retainedSheet(conversationId: ConversationId, type: "character" | "location" | "faction"): WorldChangeCandidate {
  return WorldChangeCandidateSchema.parse({ id: newId("cand"), conversationId, revision: 1, status: "live", settledness: "tentative",
    subject: { kind: "new", label: type }, title: `Retained ${type}`, rationale: "Keep every authored word.", sourceMessageIds: [], evidence: [],
    checks: { state: "partial", basedOnCanonRevision: 1, required: ["sheet-search", "canon-search"], completed: [], consulted: [], likelyDuplicates: [], possibleAmendments: [], contradictionCandidates: [], explanation: "Historical checks." },
    createdAt: NOW(), updatedAt: NOW(), classification: "sheet.create", draft: { type, name: `Retained ${type}`, role: "Keeper", billing: "Supporting", region: "Harbour", canonRules: [], links: [],
      sections: [{ heading: "Look", body: "First paragraph with an exact line break.\n\n" + "Unabridged harbour prose. ".repeat(260) }, { heading: "Sound", body: "A low bell.\n\nThen silence." }] } });
}

function retainedTurn(candidates: WorldChangeCandidate[] = [], groups: CandidateGroup[] = []): WorldChatStoredEvent {
  const turnId = newId("turn");
  return { type: "turn.completed", message: { id: newId("msg"), turnId, role: "studio", text: "A later reply.", attachmentIds: [], createdAt: NOW() },
    run: { id: newId("run"), turnId, basedOnConversationSeq: 0, status: "completed", adapter: "fake", harnessCleanup: "not-required", contextDigest: `sha256:${"a".repeat(64)}`, startedAt: NOW(), endedAt: NOW() }, receipts: [], candidates, groups, tombstones: [] };
}

it("pages authored chapter plans through media progress while full reads and prose changes remain fenced (#2065)", async () => {
  const h = await harness({ withIndex: false }), token = h.mint().token;
  const production = h.bundle.productions.find(p => p.meta.id === "the-ledger-of-nights")!;
  const chapter = production.chapters[0]!;
  const args = { productionId: production.meta.id, limit: 1 };
  const read = async (extra: Record<string, unknown> = {}) => {
    const outcome = await h.retrieval.call(token, "list_chapters", { ...args, ...extra });
    return { page: outcome.result as ArkeTargetReadPage, receipt: outcome.receipt };
  };
  const full = await read(), plan = await read({ section: "plan" });
  assert.equal(plan.receipt.target?.id, `${production.meta.id}::plan`);
  assert.equal(plan.receipt.complete, false);
  assert.equal(plan.page.total, production.chapters.length);
  chapter.audiobook = { chapterVersion: chapter.version, hash: chapter.bodyHash!, takes: 1, flagged: 0, updatedAt: NOW() };
  chapter.voices = { unreadable: true };
  chapter.continuity = { unreadable: true };
  const reread = await read({ section: "plan" });
  assert.deepEqual(reread.page.items, plan.page.items, "derived records are never supplied by an authored-only read");
  assert.equal(reread.receipt.observedRevisionOrDigest, plan.receipt.observedRevisionOrDigest);
  assert.notEqual((await read()).receipt.observedRevisionOrDigest, full.receipt.observedRevisionOrDigest);
  assert.deepEqual((await read()).page.items[0], chapter, "the default still serves the complete summary");
  let page = plan.page;
  const items = [...page.items];
  while (page.nextCursor) { page = (await read({ section: "plan", cursor: page.nextCursor })).page; items.push(...page.items); }
  assert.equal(page.complete, true);
  assert.deepEqual(items, [...production.chapters].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(({ audiobook: _a, voices: _v, continuity: _c, ...authored }) => authored));
  await assert.rejects(read({ cursor: full.page.nextCursor }), /changed while it was being read/);
  await assert.rejects(read({ cursor: plan.page.nextCursor }), /different target/);
  await assert.rejects(read({ section: "audio" }), /section must be plan/);
  chapter.hash = "changed-prose";
  await assert.rejects(read({ section: "plan", cursor: plan.page.nextCursor }), /changed while it was being read/);
});

describe("retained proposition reads", () => {
  it("reopens exact location, character and faction drafts outside the message window without bloating the prompt", async () => {
    const h = await harness({ withIndex: false, withDrafts: true }), token = h.mint().token;
    const candidates = (["location", "character", "faction"] as const).map(type => retainedSheet(h.conversationId, type));
    const messageId = newId("msg"), text = "Keep these three as tentative drafts.";
    const original = retainedTurn(); if (original.type !== "turn.completed") throw new Error("Expected a completed turn");
    await h.log.append({ type: "turn.started", message: { ...original.message, id: messageId, role: "user", text }, run: { ...original.run, status: "running" } }, { at: NOW() });
    candidates.forEach(c => { c.sourceMessageIds = [messageId]; c.evidence = [{ kind: "message", messageId, quote: text, start: 0, end: text.length, purpose: "intent" }]; });
    const group: CandidateGroup = { id: newId("grp"), conversationId: h.conversationId, revision: 1, title: "Harbour inhabitants", rationale: "Their links land together.", members: candidates.map(c => ({ candidateId: c.id, revision: c.revision })), atomic: true, status: "live" };
    candidates.forEach(c => { c.groupId = group.id; });
    await h.log.append({ ...original, candidates, groups: [group] }, { at: NOW() });
    for (let n = 0; n < 28; n++) await h.log.append(retainedTurn(), { at: NOW() });
    const reopened = await new WorldChatService(h.worldPath).load(h.conversationId, { messageLimit: 1 });
    assert.equal(reopened!.messages.length, 1); assert.deepEqual(reopened!.candidates, candidates);
    const prompt = assembleContext({ candidates: reopened!.candidates, groups: reopened!.groups, messages: reopened!.messages, tombstones: [], currentUserMessage: "Settle the retained drafts.", currentUserMessageId: newId("msg") });
    assert.match(prompt.registry, /get_candidate/); assert.ok(!prompt.registry.includes("Unabridged harbour prose"));
    for (const candidate of candidates) {
      let cursor: string | null = null, text = "", pages = 0;
      do {
        const read = await h.retrieval.call(token, "get_candidate", { candidateId: candidate.id, expectedRevision: 1, limit: 1, ...(cursor ? { cursor } : {}) });
        const page = read.result as import("@arke-studio/contracts").ArkeTargetReadPage;
        assert.deepEqual(read.receipt.target, { requirement: "conversation-candidate", id: `${h.conversationId}:${candidate.id}` });
        assert.deepEqual(read.receipt.consulted, []); assert.equal(read.receipt.complete, page.complete);
        for (const chunk of page.items as { offset: number; text: string }[]) { assert.equal(chunk.offset, text.length); assert.ok(chunk.text.length <= 4000); text += chunk.text; }
        cursor = page.nextCursor; pages++;
      } while (cursor);
      assert.ok(pages > 1); assert.deepEqual(JSON.parse(text), { candidate, groups: [group] });
    }
    assert.deepEqual((await new WorldChatService(h.worldPath).load(h.conversationId))!.candidates, candidates, "reads never revise the journal");
  });

  it("fences changed drafts, groups, foreign cursors and missing identities", async () => {
    const h = await harness({ withIndex: false, withDrafts: true }), token = h.mint().token;
    const candidate = retainedSheet(h.conversationId, "location");
    const group: CandidateGroup = { id: newId("grp"), conversationId: h.conversationId, revision: 1, title: "Pair", rationale: "Original", members: [{ candidateId: candidate.id, revision: 1 }], atomic: true, status: "live" };
    await h.log.append(retainedTurn([candidate], [group]), { at: NOW() });
    const args = { candidateId: candidate.id, expectedRevision: 1, limit: 1 };
    const first = await h.retrieval.call(token, "get_candidate", args), cursor = (first.result as { nextCursor: string }).nextCursor;
    await assert.rejects(h.retrieval.call(h.mint().token, "get_candidate", { ...args, cursor }), /cursor is not valid/);
    await h.log.append(retainedTurn([], [{ ...group, revision: 2, rationale: "Changed" }]), { at: NOW() });
    await assert.rejects(h.retrieval.call(token, "get_candidate", { ...args, cursor }), /changed while it was being read/);
    await h.log.append(retainedTurn([{ ...candidate, revision: 2, settledness: "settled" }]), { at: NOW() });
    await assert.rejects(h.retrieval.call(token, "get_candidate", args), /proposition changed/);
    const missing = await h.retrieval.call(token, "get_candidate", { ...args, candidateId: newId("cand") });
    assert.equal(missing.receipt.status, "empty"); assert.equal(missing.receipt.complete, true);
    const foreign = h.leases.mint({ worldId: h.bundle.meta.worldId, conversationId: newId("cv"), runId: newId("run") });
    assert.equal((await h.retrieval.call(foreign.token, "get_candidate", args)).receipt.status, "unavailable");
  });

  it("bounds reads and distinguishes unavailable journals from absence", async () => {
    const h = await harness({ withIndex: false, withDrafts: true, textBudget: 5000 }), token = h.mint().token;
    const candidate = retainedSheet(h.conversationId, "character"); await h.log.append(retainedTurn([candidate]), { at: NOW() });
    const args = { candidateId: candidate.id, expectedRevision: 1, limit: 1 };
    const first = await h.retrieval.call(token, "get_candidate", args);
    await assert.rejects(h.retrieval.call(token, "get_candidate", { ...args, cursor: (first.result as { nextCursor: string }).nextCursor }), /as much retained draft/);
    const absent = await harness({ withIndex: false });
    assert.equal((await absent.retrieval.call(absent.mint().token, "get_candidate", args)).receipt.status, "unavailable");
    const switching = await harness({ withIndex: false, drafts: async () => { switching.state.world = "another-world"; return { candidates: [], groups: [] }; } });
    await assert.rejects(switching.retrieval.call(switching.mint().token, "get_candidate", args), LeaseDeniedError);
  });
});

describe("bounded inventory reads", () => {
  it("transfers every large sidecar exactly while keeping cursors and receipts inside bounded replies", async () => {
    const h = await harness({ withIndex: false }), token = h.mint().token;
    const artifacts: ArtifactSidecar[] = Array.from({ length: 23 }, (_, n) => ({ id: newId("ar"), kind: "image", file: `ledger-${n}.png`,
      hash: "sha256:0123456789abcdef", origin: { by: "user", importedFrom: ('Harbour\\\"\n\t\u0000 🌊 ' + n).repeat(1100) }, links: [], created: NOW() }));
    h.bundle.artifacts = artifacts;
    const chunks = new Map<string, { text: string; next: number }>();
    let cursor: string | null = null, pages = 0;
    do {
      const read = await h.retrieval.call(token, "list_artifacts", { limit: 20, ...(cursor ? { cursor } : {}) });
      const page = read.result as ArkeTargetReadPage, serialized = JSON.stringify(read, null, 2);
      assert.ok(serialized.length < 16_000, `Reply was ${serialized.length} characters`);
      assert.ok(serialized.indexOf('"nextCursor"') < serialized.indexOf('"items"'));
      assert.equal(read.receipt.complete, page.nextCursor === null);
      for (const row of page.items as { kind: string; recordKey: string; part: number; parts: number; text: string }[]) {
        assert.equal(row.kind, "record-chunk");
        const previous = chunks.get(row.recordKey) ?? { text: "", next: 1 };
        assert.equal(row.part, previous.next); assert.ok(row.part <= row.parts);
        chunks.set(row.recordKey, { text: previous.text + row.text, next: row.part + 1 });
      }
      cursor = page.nextCursor; pages++;
    } while (cursor);
    assert.ok(pages > artifacts.length);
    assert.deepEqual([...chunks.values()].map(chunk => JSON.parse(chunk.text)), [...artifacts].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("reads just the named prop or artifact, rejects foreign cursors and fences changes to that record", async () => {
    const h = await harness({ withIndex: false }), token = h.mint().token;
    const prop = { id: newId("prop"), name: "Ledger", states: Array.from({ length: 90 }, (_, n) => ({ id: newId("pst"), name: `State ${n}` })) };
    h.bundle.props = [prop, { id: newId("prop"), name: "Lantern", states: [] }];
    const args = { propId: prop.id, limit: 1 };
    const first = await h.retrieval.call(token, "list_references", args), cursor = (first.result as ArkeTargetReadPage).nextCursor!;
    assert.deepEqual(first.receipt.target, { requirement: "references", id: `prop:${prop.id}` });
    assert.equal(first.receipt.complete, false);
    await assert.rejects(h.retrieval.call(token, "list_references", { ...args, propId: h.bundle.props[1]!.id, cursor }), /different target/);
    await assert.rejects(h.retrieval.call(token, "list_references", { cursor }), /different target/);
    h.bundle.props[1]!.name = "Unrelated change";
    assert.equal((await h.retrieval.call(token, "list_references", { ...args, cursor })).receipt.observedRevisionOrDigest, first.receipt.observedRevisionOrDigest);
    prop.name = "Changed ledger";
    await assert.rejects(h.retrieval.call(token, "list_references", { ...args, cursor }), /changed while it was being read/);
    const artifact: ArtifactSidecar = { id: newId("ar"), kind: "image", file: "ledger.png", hash: "sha256:0123456789abcdef", origin: { by: "user" }, links: [], created: NOW() };
    h.bundle.artifacts = [artifact, { ...artifact, id: newId("ar"), file: "other.png" }];
    const read = await h.retrieval.call(token, "list_artifacts", { artifactId: artifact.id });
    assert.deepEqual((read.result as ArkeTargetReadPage).items, [artifact]);
    assert.deepEqual(read.receipt.target, { requirement: "artifacts", id: `artifact:${artifact.id}` });
    assert.equal(read.receipt.complete, true);
    const absent = await h.retrieval.call(token, "list_artifacts", { artifactId: newId("ar") });
    assert.equal(absent.receipt.status, "empty"); assert.equal(absent.receipt.complete, true);
  });
});

describe("leased retrieval", () => {
  it("pages derived readiness with a receipt for every scene and refuses a changed checklist", async () => {
    const h = await harness(), token = h.mint().token;
    const production = h.bundle.productions.find(p => p.meta.id === "saltlight")!;
    let cursor: string | null = null, rows = 0;
    do {
      const read = await h.retrieval.call(token, "get_readiness", { productionId: "saltlight", limit: 1, ...(cursor ? {cursor} : {}) });
      const page = read.result as { items: unknown[]; complete: boolean; nextCursor: string | null };
      rows += page.items.length; cursor = page.nextCursor;
      assert.equal(read.receipt.tool,"target-read");
      assert.deepEqual(read.receipt.target,{requirement:"readiness",id:"saltlight"});
      assert.equal(read.receipt.complete,page.complete); assert.equal(page.complete,cursor === null);
      assert.ok(read.receipt.observedRevisionOrDigest);
    } while (cursor);
    assert.equal(rows,1 + production.scenes.length);
    const first = await h.retrieval.call(token,"get_readiness",{productionId:"saltlight",limit:1});
    const nextCursor = (first.result as { nextCursor: string }).nextCursor;
    production.scenes[0]!.script = {blocks:[{id:"blk_new",kind:"action",text:"A new script."}]};
    await assert.rejects(() => h.retrieval.call(token,"get_readiness",{productionId:"saltlight",cursor:nextCursor}),/changed while it was being read/);
    const absent = await h.retrieval.call(token,"get_readiness",{productionId:"absent"});
    assert.equal(absent.receipt.status,"empty"); h.index?.close();
  });
  it("searches canon and records what it consulted", async () => {
    const h = await harness();
    const { result, receipt } = await h.retrieval.call(h.mint().token, "search_canon", {
      query: "tide calling",
    });

    assert.equal(receipt.tool, "search-canon");
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.runId, h.runId);
    assert.ok(receipt.searchedCount! > 0, "and says how many entries it searched");
    assert.ok(
      receipt.consulted.some((c) => c.ref.kind === "canon" && c.ref.entryId === "CANON-002"),
      "the entry it found is named in the receipt, at the revision it was read at",
    );
    for (const c of receipt.consulted) assert.match(c.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.ok((result as { floorCleared: boolean }).floorCleared);
    h.index?.close();
  });

  it("searches sheets so the Studio can ask whether somebody already exists", async () => {
    const h = await harness();
    const { receipt } = await h.retrieval.call(h.mint().token, "search_sheets", { query: "Maren Kest" });
    assert.equal(receipt.tool, "search-sheets");
    assert.equal(receipt.status, "complete");
    assert.ok(receipt.consulted.some((c) => c.ref.kind === "sheet" && c.ref.sheetId === "maren-kest"));
    h.index?.close();
  });

  it("reads a production whole: season direction, episodes with promises, the scene index", async () => {
    // Round 3 (2026-08-22): an episode thread asked for its season and got nothing — no tool
    // served production records at all, and the model said so out loud mid-draft.
    const h = await harness();
    const { result, receipt } = await h.retrieval.call(h.mint().token, "get_production", { id: "saltlight" });
    assert.equal(receipt.tool, "get-production");
    assert.equal(receipt.status, "complete");
    const record = result as { id: string; episodes: unknown[]; scenes: { id: string; shots: number }[] };
    assert.equal(record.id, "saltlight");
    assert.ok(Array.isArray(record.episodes));
    assert.ok(record.scenes.some((s) => s.id === "sc_04" && s.shots > 0), "the scene index counts shots");
    assert.equal(receipt.consulted.length, 0, "context, not evidence — nothing here is quotable");
    h.index?.close();
  });

  it("describes an action through the lease, with a receipt that is not a world check", async () => {
    const h = await harness();
    const { result, receipt } = await h.retrieval.call(h.mint().token, "describe_action", { kind: "prop-authoring" });
    assert.equal(receipt.tool, "describe-action");
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.consulted.length, 0, "it read nothing in the world");
    assert.equal((result as { example: { kind: string } }).example.kind, "prop-authoring");

    const unknown = await h.retrieval.call(h.mint().token, "describe_action", { kind: "delete-everything" });
    assert.equal(unknown.receipt.status, "empty");
    h.index?.close();
  });

  it("a production that is not there is an honest empty, not a failure", async () => {
    const h = await harness();
    const { result, receipt } = await h.retrieval.call(h.mint().token, "get_production", { id: "nope" });
    assert.equal(receipt.status, "empty");
    assert.deepEqual(result, { found: false, id: "nope" });
    h.index?.close();
  });

  it("lists productions — the arm round 3 found missing from the leased surface", async () => {
    const h = await harness();
    const { result, receipt } = await h.retrieval.call(h.mint().token, "list_entities", { kind: "production" });
    assert.equal(receipt.status, "complete");
    const rows = (result as { entities: { id: string }[] }).entities;
    assert.ok(rows.some((r) => r.id === "saltlight"), "the fixture production is on the page");
    h.index?.close();
  });

  it("records an honest empty when a search runs and finds nothing", async () => {
    const h = await harness();
    const { receipt } = await h.retrieval.call(h.mint().token, "search_sheets", {
      query: "zzzzqqq nobody",
    });
    assert.equal(receipt.status, "empty");
    assert.ok(receipt.searchedCount! > 0, "it did look, and says how widely");
    h.index?.close();
  });

  it("says unavailable, not empty, when it could not look at all", async () => {
    const h = await harness({ withIndex: false });
    const { result, receipt } = await h.retrieval.call(h.mint().token, "search_sheets", {
      query: "Maren Kest",
    });
    assert.equal(
      receipt.status,
      "unavailable",
      "'I found nothing' and 'I could not look' must not be the same receipt",
    );
    assert.equal((result as { unavailable: boolean }).unavailable, true);
  });

  it("still reads a named entry directly when the index is down (§9.4)", async () => {
    const h = await harness({ withIndex: false });
    const { receipt } = await h.retrieval.call(h.mint().token, "get_entry", { id: "CANON-002" });
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.consulted[0]!.ref.kind, "canon");
  });

  it("reports a missing entry as empty rather than failing the turn", async () => {
    const h = await harness();
    const { result, receipt } = await h.retrieval.call(h.mint().token, "get_entry", { id: "CANON-999" });
    assert.equal(receipt.status, "empty");
    assert.deepEqual(receipt.consulted, []);
    assert.equal((result as { found: boolean }).found, false);
    h.index?.close();
  });

  it("bounds every result set, however much is asked for", async () => {
    const h = await harness();
    const { result } = await h.retrieval.call(h.mint().token, "list_entities", {
      kind: "character",
      limit: 5_000,
    });
    const entities = (result as { entities: unknown[] }).entities;
    assert.ok(entities.length <= 20, "the hard maximum holds regardless of the request");
    h.index?.close();
  });

  it("leaves retired entities out of a listing", async () => {
    const h = await harness();
    const { result } = await h.retrieval.call(h.mint().token, "list_entities", { kind: "canon" });
    const ids = (result as { entities: Array<{ id: string }> }).entities.map((e) => e.id);
    assert.ok(ids.length > 0);
    h.index?.close();
  });

  it("refuses a tool that is not on the surface", async () => {
    const h = await harness();
    await assert.rejects(() => h.retrieval.call(h.mint().token, "commit", {}));
    h.index?.close();
  });

  it("refuses every call once the world has changed underneath it", async () => {
    const h = await harness();
    const token = h.mint().token;
    assert.ok(await h.retrieval.call(token, "get_entry", { id: "CANON-002" }));

    h.state.world = "some-other-world";

    await assert.rejects(
      () => h.retrieval.call(token, "get_entry", { id: "CANON-002" }),
      (err: unknown) => err instanceof LeaseDeniedError && err.failure === "world-changed",
    );
    h.index?.close();
  });

  it("pages a 200-block script without first-N truncation and issues completeness only at the end", async () => {
    const h = await harness();
    const production = h.bundle.productions.find((entry) => entry.meta.id === "saltlight")!;
    const scene = production.scenes.find((entry) => entry.id === "sc_04")!;
    scene.script = {
      blocks: Array.from({ length: 200 }, (_, index) => ({
        id: `blk_line-${String(index).padStart(3, "0")}`,
        kind: "action" as const,
        text: `Line ${index}`,
      })),
    };
    const token = h.mint().token;
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let calls = 0;
    do {
      const { result, receipt } = await h.retrieval.call(token, "get_scene_script", {
        productionId: "saltlight",
        sceneId: "sc_04",
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      const page = result as { items: Array<{ id: string }>; nextCursor: string | null; complete: boolean };
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      calls += 1;
      assert.equal(receipt.tool, "target-read");
      assert.equal(receipt.target?.requirement, "scenes");
      assert.equal(receipt.complete, cursor === null);
      assert.equal(receipt.nextCursor, cursor);
    } while (cursor !== null);

    assert.equal(calls, 10);
    assert.equal(seen.length, 200);
    assert.equal(new Set(seen).size, 200);
    h.index?.close();
  });

  it("rejects a page cursor when the fenced target changes", async () => {
    const h = await harness();
    const scene = h.bundle.productions.find((entry) => entry.meta.id === "saltlight")!.scenes.find((entry) => entry.id === "sc_04")!;
    scene.script = {
      blocks: Array.from({ length: 3 }, (_, index) => ({ id: `blk_row-${index}`, kind: "action" as const, text: `Before ${index}` })),
    };
    const token = h.mint().token;
    const first = await h.retrieval.call(token, "get_scene_script", {
      productionId: "saltlight",
      sceneId: "sc_04",
      limit: 1,
    });
    const cursor = (first.result as { nextCursor: string }).nextCursor;
    scene.script.blocks[1]!.text = "Changed between pages";

    await assert.rejects(
      () => h.retrieval.call(token, "get_scene_script", {
        productionId: "saltlight",
        sceneId: "sc_04",
        cursor,
      }),
      /changed while it was being read/,
    );
    h.index?.close();
  });

  it("includes graph flow authority in a complete scene read", async () => {
    const h = await harness();
    const production = h.bundle.productions.find((entry) => entry.meta.id === "saltlight")!;
    const sceneIndex = production.scenes.findIndex((entry) => entry.id === "sc_04");
    const scene = production.scenes[sceneIndex]!;
    if (!("shots" in scene)) throw new Error("fixture scene was already graph-backed");
    production.scenes[sceneIndex] = migrateLegacyScene(scene) as never;

    const { result, receipt } = await h.retrieval.call(h.mint().token, "get_scene", {
      productionId: "saltlight",
      sceneId: "sc_04",
      limit: 20,
    });
    const page = result as { items: Array<{ kind?: string; flow?: { nodes: unknown[]; edges: unknown[] } }> };
    const structure = page.items.find((item) => item.kind === "scene-flow");
    assert.ok(structure?.flow);
    assert.ok(structure.flow.nodes.length > 0);
    assert.ok(structure.flow.edges.length > 0);
    assert.equal(receipt.complete, true);
    h.index?.close();
  });

  it("returns durable export identity without exposing host paths or raw failures", async () => {
    const h = await harness({
      exports: (worldId) => [{
        id: "ex_finished",
        worldId,
        productionId: "saltlight",
        status: "failed",
        percent: 40,
        output: "C:\\Users\\author\\secret.mp4",
        error: "ffmpeg failed beside C:\\Users\\author\\secret.mp4",
      }],
    });
    const { result } = await h.retrieval.call(h.mint().token, "list_exports", { productionId: "saltlight" });
    const page = result as { items: Array<{ id: string; output: string | null; error: string | null }> };
    assert.deepEqual(page.items, [{
      id: "ex_finished",
      worldId: h.bundle.meta.worldId,
      productionId: "saltlight",
      status: "failed",
      percent: 40,
      output: null,
      error: "export failed",
    }]);
    h.index?.close();
  });

  it("keeps an export target stable while only its advisory progress changes", () => {
    const record: ArkeExportReadRecord = {
      id: "ex_running",
      worldId: "world-1",
      productionId: "saltlight",
      status: "running",
      percent: 10,
      output: null,
      error: null,
    };
    const before = exportsFence([record], record.worldId, record.productionId);
    const afterProgress = exportsFence([{ ...record, percent: 90 }], record.worldId, record.productionId);
    const afterTerminal = exportsFence([{ ...record, status: "done", percent: 100 }], record.worldId, record.productionId);

    assert.equal(afterProgress, before);
    assert.notEqual(afterTerminal, before);
  });

  it("keeps every track and clip addressable beyond the old 12-track and 40-clip prompt bounds", async () => {
    const h = await harness();
    const production = h.bundle.productions.find((entry) => entry.meta.id === "saltlight")!;
    const timeline: ProductionTimeline = {
      schemaVersion: 1,
      revision: 1,
      frameRate: 24,
      history: { undo: [], redo: [] },
      mix: { speechFirst: true, duckingDb: -9, lookAheadMs: 80, releaseMs: 400, limiterCeilingDb: -1 },
      library: [],
      tracks: Array.from({ length: 13 }, (_, trackIndex) => ({
        id: `tr_extra_${trackIndex}`,
        kind: "picture" as const,
        name: `Track ${trackIndex}`,
        order: trackIndex,
        muted: false,
        clips: Array.from({ length: 4 }, (_, clipIndex) => ({
          id: `cl_extra_${trackIndex}_${clipIndex}`,
          startFrame: clipIndex * 24,
          durationFrames: 24,
          sourceInFrames: 0,
          source: { kind: "shot" as const, shotId: "sh_001", sceneNumber: 1, shotNumber: 1, label: "Shot" },
        })),
      })),
    };
    production.timeline = { status: "ready", timeline };
    const token = h.mint().token;
    const items: Array<{ kind: string; clip?: { id: string } }> = [];
    let cursor: string | null | undefined;
    do {
      const { result } = await h.retrieval.call(token, "get_timeline", {
        productionId: "saltlight",
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      const page = result as { items: typeof items; nextCursor: string | null };
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);

    assert.equal(items.filter((item) => item.kind === "track").length, 13);
    assert.equal(items.filter((item) => item.kind === "clip").length, 52);
    assert.ok(items.some((item) => item.clip?.id === "cl_extra_12_3"));
    h.index?.close();
  });
});

describe("leased attachment reads", () => {
  async function withAttachment() {
    const h = await harness();
    const attachment = await h.attachments.ingestText(h.conversationId, "the verse under the harbour");
    h.known.set(attachment.id, attachment);
    return { ...h, attachment };
  }

  it("reads an attachment the run was given", async () => {
    const h = await withAttachment();
    const { result, receipt } = await h.retrieval.call(
      h.mint([h.attachment.id]).token,
      "get_attachment_text",
      { id: h.attachment.id },
    );
    assert.equal(receipt.tool, "get-attachment-text");
    assert.equal(receipt.status, "complete");
    assert.equal((result as { text: string }).text, "the verse under the harbour");
    h.index?.close();
  });

  it("refuses one the run was not given, without saying whether it exists", async () => {
    const h = await withAttachment();
    await assert.rejects(
      () => h.retrieval.call(h.mint().token, "get_attachment_text", { id: h.attachment.id }),
      (err: unknown) => err instanceof LeaseDeniedError && err.failure === "attachment-not-allowed",
    );
    h.index?.close();
  });

  it("stops a run reading an unbounded amount of text", async () => {
    const h = await harness();
    const big = await h.attachments.ingestText(h.conversationId, "x".repeat(200_000));
    h.known.set(big.id, big);
    const token = h.mint([big.id]).token;

    let total = 0;
    for (let i = 0; i < 10; i++) {
      try {
        const { result } = await h.retrieval.call(token, "get_attachment_text", {
          id: big.id,
          offset: total,
        });
        total += (result as { text: string }).text.length;
      } catch {
        break;
      }
    }
    assert.ok(total <= 32_000, `read ${total} characters, over the per-run bound`);
    h.index?.close();
  });

  /**
   * The budget caps how much a run reads, not where from — `offset` is free. So the passages a
   * run was served are the only honest account of what it may quote, and re-reading a prefix at
   * verification time can never reproduce one taken from deep in a long document.
   */
  it("remembers the passages a run was served, so a quotation can be checked against them", async () => {
    const h = await harness();
    const big = await h.attachments.ingestText(h.conversationId, `${"x".repeat(50_000)}THE-DEEP-PART`);
    h.known.set(big.id, big);
    const { result } = await h.retrieval.call(h.mint([big.id]).token, "get_attachment_text", {
      id: big.id,
      offset: 50_000,
    });
    const served = (result as { text: string }).text;
    assert.ok(served.includes("THE-DEEP-PART"));

    assert.deepEqual(h.retrieval.textReadBy(h.runId).get(big.id), [{ offset: 50_000, text: served }]);

    // And it does not outlive the run, or one run could quote what another read.
    h.retrieval.forgetRun(h.runId);
    assert.equal(h.retrieval.textReadBy(h.runId).size, 0);
    h.index?.close();
  });
});

async function rpc(url: string, method: string, params?: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

describe("the served surface", () => {
  async function serve(withLease: boolean) {
    const h = await harness();
    const receipts: WorldChatCheckReceipt[] = [];
    const server = new WorldQueryServer(
      () => null,
      withLease ? { retrieval: h.retrieval, onReceipt: (r) => receipts.push(r) } : undefined,
    );
    await server.start();
    return { h, server, receipts };
  }

  it("offers the world-chat tools on a leased path and the ambient set on the plain one", async () => {
    const { h, server } = await serve(true);
    const token = h.mint().token;

    const leased = await rpc(server.leasedUrl(token)!, "tools/list");
    const names = (leased.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    assert.ok(names.includes("search_sheets"));
    assert.ok(names.includes("get_attachment_text"));
    assert.ok(names.includes("get_production"), "the production read reaches leased callers (round 3)");
    assert.ok(names.includes("get_scene_script"), "complete target reads are leased");
    assert.ok(names.includes("get_timeline"), "the full timeline can be paged without entering prompts");

    const ambient = await rpc(server.url()!, "tools/list");
    const ambientNames = (ambient.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (t) => t.name,
    );
    assert.ok(names.includes("describe_action"), "a collapsed action guide can be expanded (SPEC-050 R-5)");
    assert.ok(!ambientNames.includes("get_attachment_text"), "attachment reads stay leased-only");
    assert.ok(!ambientNames.includes("describe_action"), "drafting agents prepare no world-chat actions");
    assert.ok(ambientNames.includes("get_production"), "drafting agents can read the production too");
    assert.equal(ambientNames.length, 6, "the ambient surface: the original five plus the production read");

    await server.stop();
    h.index?.close();
  });

  it("answers a leased call and hands back its receipt", async () => {
    const { h, server, receipts } = await serve(true);
    const token = h.mint().token;
    const res = await rpc(server.leasedUrl(token)!, "tools/call", {
      name: "search_canon",
      arguments: { query: "tide calling" },
    });
    assert.equal(res.status, 200);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.tool, "search-canon");
    await server.stop();
    h.index?.close();
  });

  /**
   * World evidence needs an observedVersion and a contentHash, and checkReceiptIds needs a
   * check_... id. None of the three is part of the entity, so serialising only the result asked
   * the model to cite values it had never been shown — and an invented one fails verification and
   * takes the whole turn with it. The receipt always held them; now they travel back beside it.
   */
  it("hands the model the citation metadata its evidence has to carry", async () => {
    const { h, server } = await serve(true);
    const token = h.mint().token;
    const res = await rpc(server.leasedUrl(token)!, "tools/call", {
      name: "get_sheet",
      arguments: { id: "maren-kest" },
    });
    const content = (res.body as { result: { content: Array<{ text: string }> } }).result.content;

    const entity = JSON.parse(content[0]!.text) as { id: string };
    assert.equal(entity.id, "maren-kest", "the result stays first and unchanged");

    const cite = JSON.parse(content[1]!.text) as {
      checkReceiptId: string;
      citable: Array<{ ref: unknown; observedVersion: number; contentHash: string }>;
    };
    assert.match(cite.checkReceiptId, /^check_/, "so checkReceiptIds can name a real receipt");
    assert.equal(cite.citable.length, 1);
    assert.match(cite.citable[0]!.contentHash, /^sha256:/);
    assert.equal(typeof cite.citable[0]!.observedVersion, "number");

    await server.stop();
    h.index?.close();
  });

  it("rejects a malformed lease path instead of quietly serving the ambient world", async () => {
    const { h, server } = await serve(true);
    const res = await rpc(`${server.url()}/not-a-real-token`, "tools/list");
    assert.equal(res.status, 404, "falling back to ambient here would be the bypass the lease prevents");
    await server.stop();
    h.index?.close();
  });

  it("rejects a well-formed but unknown lease", async () => {
    const { h, server, receipts } = await serve(true);
    const res = await rpc(server.leasedUrl("a".repeat(64))!, "tools/call", {
      name: "search_canon",
      arguments: { query: "anything" },
    });
    const body = res.body as { result: { isError?: boolean } };
    assert.equal(body.result.isError, true);
    assert.deepEqual(receipts, [], "a denied lease observed nothing, so it records nothing");
    await server.stop();
    h.index?.close();
  });

  it("serves no leased path at all when no lease surface is configured", async () => {
    const { h, server } = await serve(false);
    const res = await rpc(`${server.url()}/${"a".repeat(64)}`, "tools/list");
    assert.equal(res.status, 404);
    await server.stop();
    h.index?.close();
  });
});

it("reads unfinished founding keys completely and fences retry state changes", async () => {
  const items: ArkeBuildItemRead[] = [{ key: "main-photo/maren-kest", kind: "main-photo", subject: "Maren", state: "failed", detail: "provider unavailable" },
    { key: "world-image", kind: "world-image", subject: "World", state: "unauthorized", detail: null }];
  const h = await harness({ buildItems: () => items });
  try {
    const token = h.mint().token;
    const first = await h.retrieval.call(token, "list_build_items", { limit: 1 });
    const page = first.result as { items: ArkeBuildItemRead[]; nextCursor: string };
    assert.equal(first.receipt.complete, false);
    const last = await h.retrieval.call(token, "list_build_items", { cursor: page.nextCursor, limit: 1 });
    assert.equal(last.receipt.complete, true);
    assert.deepEqual(last.receipt.target, { requirement: "founding-build", id: h.bundle.meta.worldId });
    assert.equal(last.receipt.observedRevisionOrDigest, buildItemsFence(items));
    assert.deepEqual([...page.items, ...(last.result as { items: ArkeBuildItemRead[] }).items], items);
    items[1] = { ...items[1]!, state: "running" };
    await assert.rejects(() => h.retrieval.call(token, "list_build_items", { cursor: page.nextCursor }), /changed while it was being read/);
  } finally { h.index?.close(); }
});

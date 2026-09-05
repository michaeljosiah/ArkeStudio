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
} from "@arke-studio/contracts";
import { WorldIndex } from "../../src/index-db/world-index.js";
import { WorldQueryServer } from "../../src/harness/world-query.js";
import { WorldChatAttachmentStore } from "../../src/world-chat/attachments.js";
import { LeaseDeniedError, QueryLeaseRegistry } from "../../src/world-chat/lease.js";
import { WorldChatRetrieval } from "../../src/world-chat/retrieval.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { exportsFence, type ArkeExportReadRecord } from "../../src/world-chat/target-reads.js";
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
  exports?: (worldId: string) => readonly ArkeExportReadRecord[];
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
    ...(options.exports ? { getExports: () => options.exports!(bundle.meta.worldId) } : {}),
    now: NOW,
  });

  const mint = (allowed: ChatAttachmentId[] = []) =>
    leases.mint({ worldId: bundle.meta.worldId, conversationId, runId, allowedAttachmentIds: allowed });

  return { retrieval, leases, mint, state, attachments, conversationId, known, index, runId, bundle };
}

describe("leased retrieval", () => {
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
    assert.ok(!ambientNames.includes("get_attachment_text"), "attachment reads stay leased-only");
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

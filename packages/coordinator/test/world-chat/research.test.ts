import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newId, type ChatAttachmentId, type ConversationId, type RunId } from "@arke-studio/contracts";
import { WorldIndex } from "../../src/index-db/world-index.js";
import { readableText, WorldChatAttachmentStore } from "../../src/world-chat/attachments.js";
import { QueryLeaseRegistry } from "../../src/world-chat/lease.js";
import { WorldChatRetrieval } from "../../src/world-chat/retrieval.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { fixtureBundle } from "../index-db/helpers.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

/**
 * Research, and what a fetched page IS (2026-08-22).
 *
 * The question had to be answered before the feature could exist: this system verifies a
 * quotation against bytes it holds, so a citation checked against a live URL would pass today
 * and fail next month for reasons that have nothing to do with the writing. The answer is that a
 * page is an attachment — already hashed, already quotable, already checkable — so reading one
 * online stores it exactly like a document somebody dropped in, plus the address it came from.
 */

const NOW = () => "2026-08-22T10:00:00Z";

const PAGE = `<!doctype html><html><head><title>Lagos</title>
<style>.x{color:red}</style><script>console.log("not prose")</script></head>
<body><h1>The Third Mainland Bridge</h1>
<p>Eleven and a half kilometres over the lagoon &mdash; the longest in the city.</p>
<p>Opened in 1990.</p></body></html>`;

async function harness(options: { allowed?: boolean; fetch?: typeof globalThis.fetch } = {}) {
  const worldDir = await makeTempWorld();
  const bundle = await fixtureBundle();
  const index = WorldIndex.open(worldDir, bundle);
  const worldPath = await tempDir("arke-research-");
  const conversationId = newId("cv") as ConversationId;
  const runId = newId("run") as RunId;
  const log = new WorldChatStore(conversationDir(worldPath, conversationId));
  await log.create(conversationId, NOW());
  await log.append({ type: "conversation.created", title: "r", entryContext: { kind: "world" } }, { at: NOW() });

  const attachments = new WorldChatAttachmentStore(worldPath, NOW);
  const leases = new QueryLeaseRegistry(() => bundle.meta.worldId, () => 1_000);
  const retrieval = new WorldChatRetrieval({
    leases,
    getBundle: () => bundle,
    getIndex: () => index,
    attachments,
    findAttachment: async (lease, id) =>
      (await new (await import("../../src/world-chat/service.js")).WorldChatService(worldPath).load(lease.conversationId))
        ?.attachments.find((a) => a.id === id) ?? null,
    researchAllowed: () => options.allowed === true,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now: NOW,
  });
  const token = leases.mint({ worldId: bundle.meta.worldId, conversationId, runId, allowedAttachmentIds: [] as ChatAttachmentId[] }).token;
  return { retrieval, token, index, attachments, conversationId };
}

const servePage = (body = PAGE, type = "text/html"): typeof globalThis.fetch =>
  (async () => new Response(body, { status: 200, headers: { "content-type": type } })) as unknown as typeof globalThis.fetch;

describe("reading a page, and keeping it", () => {
  it("is refused while research is off, and says how to turn it on", async () => {
    const h = await harness({ allowed: false, fetch: servePage() });
    const { result, receipt } = await h.retrieval.call(h.token, "fetch_url", { url: "https://example.com/bridge" });
    assert.equal(receipt.tool, "fetch-url");
    assert.equal(receipt.status, "unavailable", "refused is not the same as found nothing");
    assert.match((result as { reason: string }).reason, /Research is off/);
    assert.match((result as { reason: string }).reason, /nothing is read online until you do/);
    h.index?.close();
  });

  it("keeps the page as an attachment that remembers where it came from", async () => {
    const h = await harness({ allowed: true, fetch: servePage() });
    const { result, receipt } = await h.retrieval.call(h.token, "fetch_url", { url: "https://example.com/bridge" });
    assert.equal(receipt.status, "complete");
    const out = result as { attachmentId: string; url: string; fetchedAt: string };
    assert.match(out.attachmentId, /^wca_/);
    assert.equal(out.url, "https://example.com/bridge");
    assert.equal(out.fetchedAt, NOW(), "when it was read is part of the record");
    h.index?.close();
  });

  it("the run can read back what it just fetched, and quote from it", async () => {
    const h = await harness({ allowed: true, fetch: servePage() });
    const fetched = (await h.retrieval.call(h.token, "fetch_url", { url: "https://example.com/bridge" }))
      .result as { attachmentId: string };
    const read = await h.retrieval.call(h.token, "get_attachment_text", { id: fetched.attachmentId });
    const text = JSON.stringify(read.result);
    assert.match(text, /Third Mainland Bridge/, "the prose survived");
    assert.match(text, /Eleven and a half kilometres/);
    assert.doesNotMatch(text, /console\.log/, "and the script did not");
    assert.doesNotMatch(text, /color:red/, "nor the stylesheet");
    h.index?.close();
  });

  it("refuses what it cannot honestly read, in words the turn can pass on", async () => {
    for (const [url, fetcher, expected] of [
      ["not a url", servePage(), /is not an address/],
      ["ftp://example.com/x", servePage(), /http and https only/],
      ["https://example.com/x.png", servePage("bytes", "image/png"), /reads pages, not files/],
      ["https://example.com/empty", servePage("<html><body></body></html>"), /no readable text/],
    ] as const) {
      const h = await harness({ allowed: true, fetch: fetcher });
      const { result, receipt } = await h.retrieval.call(h.token, "fetch_url", { url });
      assert.equal(receipt.status, "empty", `${url} produces a receipt, not a crash`);
      assert.match((result as { reason: string }).reason, expected);
      h.index?.close();
    }
  });

  it("a page that answers with an error is reported, not invented around", async () => {
    const failing = (async () => new Response("nope", { status: 503, headers: { "content-type": "text/html" } })) as unknown as typeof globalThis.fetch;
    const h = await harness({ allowed: true, fetch: failing });
    const { result } = await h.retrieval.call(h.token, "fetch_url", { url: "https://example.com/down" });
    assert.match((result as { reason: string }).reason, /answered 503/);
    h.index?.close();
  });
});

describe("turning a page into text", () => {
  it("keeps the prose, drops the machinery, and decodes what a reader would see", () => {
    const text = readableText(PAGE);
    assert.match(text, /The Third Mainland Bridge/);
    assert.match(text, /Eleven and a half kilometres/);
    assert.doesNotMatch(text, /<[a-z]/i, "no tags survive");
    assert.doesNotMatch(text, /console\.log|color:red/, "no script or style contents");
    assert.doesNotMatch(text, /\n{3,}/, "and blank space is collapsed, so offsets stay meaningful");
  });

  it("decodes the entities a quotation would otherwise never match", () => {
    assert.equal(readableText("<p>salt &amp; light</p>"), "salt & light");
    assert.equal(readableText("<p>&quot;quoted&quot;</p>"), '"quoted"');
  });
});

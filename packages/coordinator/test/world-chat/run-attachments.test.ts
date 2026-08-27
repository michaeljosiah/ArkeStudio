import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  type ChatAttachmentId,
  type ConversationId,
  type HarnessAdapter,
  type WorldBundle,
  type WorldChatMessage,
} from "@arke-studio/contracts";
import {
  MAX_TEXT_READ_CHARS,
  WorldChatAttachmentStore,
  type AttachmentRange,
} from "../../src/world-chat/attachments.js";
import { onePagePdf } from "./build-documents.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { WorldChatRunner } from "../../src/world-chat/run.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { scanWorld } from "../../src/world/scan.js";
import { FIXTURE_WORLD } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

/**
 * Reading a document the user handed over (#70 §13.2).
 *
 * The point of verification here is the same as for messages, and the failure mode is the same:
 * a model asked to support a claim from a document will produce a plausible quotation whether or
 * not the document contains one. So the quotation is checked against the bytes, every time.
 */

const AT = "2026-08-06T10:00:00Z";
const NOW = () => AT;

function fakeAdapter(answers: Array<string | (() => Promise<string>)>): HarnessAdapter {
  let turn = 0;
  return {
    id: "fake",
    capabilities: () => new Set(),
    readiness: () => ({ ready: true }),
    createSession: async () => ({ sessionId: "s1" }),
    sendMessage: async () => ({ ok: true }),
    dispatchAsync: async () => ({ ok: true }),
    streamEvents: () =>
      (async function* () {
        const answer = answers[Math.min(turn++, answers.length - 1)]!;
        const text = typeof answer === "function" ? await answer() : answer;
        yield { type: "message.completed", sessionId: "s1", text };
      })(),
  } as unknown as HarnessAdapter;
}

async function conversation(prefix: string) {
  const worldPath = await tempDir(prefix);
  const conversationId = newId("cv") as ConversationId;
  const store = new WorldChatStore(conversationDir(worldPath, conversationId));
  await store.create(conversationId, AT);
  await store.append(
    { type: "conversation.created", title: "a talk", entryContext: { kind: "world" } },
    { at: AT },
  );
  const attachments = new WorldChatAttachmentStore(worldPath, NOW);
  const bundle: WorldBundle = (await scanWorld(FIXTURE_WORLD)).bundle;

  /**
   * A store as a command would open it: freshly, reading the current tail.
   *
   * Two long-lived stores over one conversation trip the tail-integrity check, which is correct
   * — from the log's point of view the other one is a foreign writer. The coordinator opens a
   * store per command for exactly this reason, and the test does the same rather than holding
   * one across an attachment ingest.
   */
  const freshStore = () => new WorldChatStore(conversationDir(worldPath, conversationId));
  return { worldPath, conversationId, store, attachments, bundle, freshStore };
}

interface RunnerOptions {
  worldPath: string;
  bundle: WorldBundle;
  attachments: WorldChatAttachmentStore;
  adapter: HarnessAdapter;
  onPrepare?: (ids: readonly ChatAttachmentId[]) => void;
  onRead?: (id: string) => void;
  /** Passages get_attachment_text served this run, as the retrieval layer records them. */
  served?: ReadonlyMap<string, readonly AttachmentRange[]>;
}

function runnerFor(options: RunnerOptions): WorldChatRunner {
  return new WorldChatRunner({
    adapter: options.adapter,
    prepare: async ({ attachmentIds }) => {
      options.onPrepare?.(attachmentIds);
      return { cwd: options.worldPath, leaseToken: "t".repeat(64) };
    },
    release: async () => {},
    receiptsFor: () => [],
    runCheckPlan: async () => ({ receipts: [], canonRevision: options.bundle.meta.canonRevision }),
    evidenceSources: (messages: readonly WorldChatMessage[]) => ({
      messages,
      bundle: options.bundle,
      attachments: [],
      attachmentText: new Map(),
    }),
    readAttachmentText: async (a) => {
      options.onRead?.(a.id);
      return (await options.attachments.readText(a)).text;
    },
    attachmentReadsFor: () => options.served ?? new Map<string, readonly AttachmentRange[]>(),
    now: NOW,
  });
}

/** An answer that cites the document, composed once the user's message has an id. */
function citing(
  store: WorldChatStore,
  attachmentId: string,
  contentHash: string,
  quote: string,
): () => Promise<string> {
  return async () => {
    const meta = await store.readMeta();
    const view = foldConversation(meta!.id, meta!.createdAt, (await store.read()).events).view;
    const message = view.messages[0]!;
    return JSON.stringify({
      reply: "Noted from your notes.",
      candidateOperations: [
        {
          op: "create",
          temporaryId: "t1",
          candidate: {
            classification: "canon.create",
            title: "The lock and the drowning",
            rationale: "It is in the document.",
            settledness: "settled",
            checkReceiptIds: [],
            evidence: [
              {
                kind: "message",
                messageId: message.id,
                quote: message.text,
                start: 0,
                end: message.text.length,
                purpose: "intent",
              },
              { kind: "attachment", attachmentId, contentHash, quote, purpose: "supports" },
            ],
            draft: { type: "lore", title: "The lock", statement: "Built when the god drowned.", links: [] },
          },
        },
      ],
      groupOperations: [],
    });
  };
}

describe("reading an attachment", () => {
  it("verifies a quotation that is really in the document", async () => {
    const c = await conversation("arke-att-ok-");
    const doc = await c.attachments.ingestText(
      c.conversationId,
      "The lock was built in the year the god drowned.",
      "notes.txt",
    );

    const scoped: ChatAttachmentId[][] = [];
    const runner = runnerFor({
      ...c,
      adapter: fakeAdapter([citing(c.freshStore(), doc.id, doc.contentHash, "the year the god drowned")]),
      onPrepare: (ids) => scoped.push([...ids]),
    });

    const outcome = await runner.send(c.freshStore(), c.conversationId, "read my notes", [doc.id]);
    assert.equal(outcome.status, "completed");
    assert.deepEqual(scoped[0], [doc.id], "the lease was scoped to exactly the document handed over");
  });

  /**
   * The prompt inlines a document's opening; `get_attachment_text` will serve a passage from any
   * offset, because the run budget caps how much text is read rather than where it is read from.
   * So a model can quite properly quote something far past the opening — and verification that
   * re-read a prefix could never reach it, however long a prefix it read.
   */
  it("verifies a quotation from a passage the tool served, not just the inlined opening", async () => {
    const c = await conversation("arke-att-deep-");
    const buried = "the bells were cast from whale bone";
    const doc = await c.attachments.ingestText(
      c.conversationId,
      `${"filler. ".repeat(MAX_TEXT_READ_CHARS / 4)}${buried}`,
      "long.txt",
    );
    const inlined = await c.attachments.readText(doc);
    assert.ok(inlined.truncated, "the fixture must outrun one read, or it proves nothing");
    assert.ok(!inlined.text.includes(buried), "and the quote must lie outside what is inlined");

    const runner = runnerFor({
      ...c,
      adapter: fakeAdapter([citing(c.freshStore(), doc.id, doc.contentHash, buried)]),
      served: new Map([[doc.id, [{ offset: inlined.text.length + 100, text: `...${buried}...` }]]]),
    });

    const outcome = await runner.send(c.freshStore(), c.conversationId, "read my notes", [doc.id]);
    assert.equal(outcome.status, "completed");
  });

  /**
   * A quote can sit across the join between the inlined opening and the first paged read. The
   * model saw those as one continuous stretch, because they are one — so rejoining them is what
   * makes the citation checkable, and why the offsets are kept rather than the strings alone.
   */
  it("verifies a quotation spanning two windows that really were adjacent", async () => {
    const c = await conversation("arke-att-seam-");
    const whole = `${"filler. ".repeat(1_000)}the bells were cast from whale bone`;
    const doc = await c.attachments.ingestText(c.conversationId, whole, "seam.txt");

    // The prompt inlines [0, n); the next read begins exactly at n, and the quote straddles it.
    const inlined = await c.attachments.readText(doc);
    const rest = whole.slice(inlined.text.length);
    const across = whole.slice(inlined.text.length - 20, inlined.text.length + 20);
    assert.ok(!inlined.text.includes(across), "the quote must not fit inside the opening alone");

    const runner = runnerFor({
      ...c,
      adapter: fakeAdapter([citing(c.freshStore(), doc.id, doc.contentHash, across)]),
      served: new Map([[doc.id, [{ offset: inlined.text.length, text: rest }]]]),
    });

    const outcome = await runner.send(c.freshStore(), c.conversationId, "read my notes", [doc.id]);
    assert.equal(outcome.status, "completed");
  });

  /**
   * The whole chain, for a file whose words had to be got out of it first.
   *
   * A PDF's bytes are not its text, so everything downstream of the extraction — what the prompt
   * inlines, what a quotation is checked against, what the content hash identifies — has to be
   * reading the extraction and not the file. Verification passing is what proves it: the quote is
   * in the document and nowhere in the bytes of it.
   */
  it("verifies a quotation from a PDF", async () => {
    const c = await conversation("arke-att-pdf-");
    const doc = await c.attachments.ingest(c.conversationId, {
      fileName: "treatment.pdf",
      bytes: onePagePdf("The lock was built in the year the god drowned."),
    });
    assert.equal(doc.readability, "extracted-text-available");

    const runner = runnerFor({
      ...c,
      adapter: fakeAdapter([citing(c.freshStore(), doc.id, doc.contentHash, "the year the god drowned")]),
    });

    const outcome = await runner.send(c.freshStore(), c.conversationId, "read my treatment", [doc.id]);
    assert.equal(outcome.status, "completed");
  });

  /** The other side of it: reading a document does not make the rest of it quotable. */
  it("refuses a quotation from a passage this run never read", async () => {
    const c = await conversation("arke-att-unread-");
    const buried = "the bells were cast from whale bone";
    const doc = await c.attachments.ingestText(
      c.conversationId,
      `${"filler. ".repeat(MAX_TEXT_READ_CHARS / 4)}${buried}`,
      "long.txt",
    );

    const runner = runnerFor({
      ...c,
      adapter: fakeAdapter([
        citing(c.freshStore(), doc.id, doc.contentHash, buried),
        citing(c.freshStore(), doc.id, doc.contentHash, buried),
      ]),
    });

    const outcome = await runner.send(c.freshStore(), c.conversationId, "read my notes", [doc.id]);
    assert.equal(outcome.status, "failed", "it is in the file, but nothing this run read contains it");
  });

  it("refuses a quotation the document does not contain", async () => {
    const c = await conversation("arke-att-bad-");
    const doc = await c.attachments.ingestText(c.conversationId, "Nothing about bells here.", "n.txt");

    const runner = runnerFor({
      ...c,
      adapter: fakeAdapter([
        citing(c.freshStore(), doc.id, doc.contentHash, "the bells were whale bone"),
        citing(c.freshStore(), doc.id, doc.contentHash, "the bells were whale bone"),
      ]),
    });

    const outcome = await runner.send(c.freshStore(), c.conversationId, "read it", [doc.id]);
    assert.equal(
      outcome.status,
      "failed",
      "a plausible quotation that is not in the file is what verification exists to catch",
    );
  });

  it("does not read a file the turn did not hand over", async () => {
    const c = await conversation("arke-att-scope-");
    await c.attachments.ingestText(c.conversationId, "private", "s.txt");

    const read: string[] = [];
    const runner = runnerFor({
      ...c,
      adapter: fakeAdapter(["not json", "not json"]),
      onRead: (id) => read.push(id),
    });

    await runner.send(c.freshStore(), c.conversationId, "hello");
    assert.deepEqual(
      read,
      [],
      "a document sitting in the conversation is not opened unless this turn linked it",
    );
  });

  it("never reads a file it could not honestly quote", async () => {
    const c = await conversation("arke-att-img-");
    const image = await c.attachments.ingest(c.conversationId, {
      fileName: "cover.png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    assert.equal(image.readability, "not-readable");

    const read: string[] = [];
    const runner = runnerFor({
      ...c,
      adapter: fakeAdapter(["not json", "not json"]),
      onRead: (id) => read.push(id),
    });

    await runner.send(c.freshStore(), c.conversationId, "look at this", [image.id]);
    assert.deepEqual(read, [], "an image is attachable and referable, but never read as text");
  });
});

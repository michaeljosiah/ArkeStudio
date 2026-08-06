import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type ChatAttachmentId, type ConversationId, type MessageId } from "@arke-studio/contracts";
import {
  attachmentDependencies,
  attachmentDir,
  attachmentFileName,
  AttachmentError,
  blockedFromRemoval,
  detectReadability,
  MAX_TEXT_READ_CHARS,
  WorldChatAttachmentStore,
} from "../../src/world-chat/attachments.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { tempDir } from "../tmp.js";

/**
 * Private conversation attachments (#70 §10.1.1, §13).
 *
 * Two things here are worth more than the rest: that a supplied file name cannot steer where
 * bytes land, and that the app never claims to have read something it cannot read.
 */

const NOW = () => "2026-08-06T10:00:00Z";

async function setup(): Promise<{
  store: WorldChatAttachmentStore;
  worldPath: string;
  conversationId: ConversationId;
}> {
  const worldPath = await tempDir("arke-attach-");
  const conversationId = newId("cv") as ConversationId;
  const log = new WorldChatStore(conversationDir(worldPath, conversationId));
  await log.create(conversationId, NOW());
  await log.append(
    { type: "conversation.created", title: "attachments", entryContext: { kind: "world" } },
    { at: NOW() },
  );
  return { store: new WorldChatAttachmentStore(worldPath, NOW), worldPath, conversationId };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function load(worldPath: string, conversationId: ConversationId) {
  const log = new WorldChatStore(conversationDir(worldPath, conversationId));
  const meta = await log.readMeta();
  return foldConversation(meta!.id, meta!.createdAt, (await log.read()).events).view;
}

describe("attachment file names", () => {
  it("drops directory parts so a name cannot steer where the file lands", () => {
    assert.equal(attachmentFileName("../../../etc/passwd"), "passwd.bin");
    assert.equal(attachmentFileName("C:\\Windows\\System32\\drivers\\etc\\hosts"), "hosts.bin");
    assert.equal(attachmentFileName("notes/../../secrets.txt"), "secrets.txt");
  });

  it("escapes Windows device names, which are reserved in every directory", () => {
    assert.equal(attachmentFileName("CON.txt"), "file-CON.txt");
    assert.equal(attachmentFileName("nul"), "file-nul.bin");
    assert.equal(attachmentFileName("LPT1.md"), "file-LPT1.md");
  });

  it("keeps the extension, because what may be read depends on it", () => {
    assert.equal(attachmentFileName("The Undersong draft.md"), "The-Undersong-draft.md");
    assert.equal(attachmentFileName("no-extension"), "no-extension.bin");
  });
});

describe("readability", () => {
  it("calls real text readable", () => {
    assert.equal(detectReadability("document", bytes("She hears the verse under the harbour.")), "text-readable");
  });

  it("refuses to call a binary document text, whatever it is named", () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff, 0xfe]);
    assert.equal(detectReadability("document", pdf), "not-readable");
  });

  it("never calls media readable", () => {
    assert.equal(detectReadability("image", bytes("this is text")), "not-readable");
    assert.equal(detectReadability("audio", bytes("this is text")), "not-readable");
    assert.equal(detectReadability("video", bytes("this is text")), "not-readable");
  });
});

describe("ingesting an attachment", () => {
  it("files the bytes privately and records what it filed", async () => {
    const { store, worldPath, conversationId } = await setup();
    const attachment = await store.ingest(conversationId, {
      fileName: "harbour-notes.txt",
      bytes: bytes("the verse under the harbour"),
    });

    assert.equal(attachment.kind, "document");
    assert.equal(attachment.readability, "text-readable");
    assert.match(attachment.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(attachment.byteLength, 27);

    const onDisk = await readFile(
      join(attachmentDir(worldPath, conversationId, attachment.id), "harbour-notes.txt"),
      "utf8",
    );
    assert.equal(onDisk, "the verse under the harbour");
  });

  it("puts the attachment inside its own conversation and nowhere else", async () => {
    const { store, worldPath, conversationId } = await setup();
    const attachment = await store.ingest(conversationId, {
      fileName: "../../escape.txt",
      bytes: bytes("x"),
    });
    const dir = attachmentDir(worldPath, conversationId, attachment.id);
    assert.deepEqual(await readdir(dir), ["escape.txt"]);
    assert.ok(dir.includes(conversationId), "and it is under the conversation that owns it");
  });

  it("appears in the folded conversation", async () => {
    const { store, worldPath, conversationId } = await setup();
    const attachment = await store.ingest(conversationId, { fileName: "a.txt", bytes: bytes("hello") });
    const view = await load(worldPath, conversationId);
    assert.deepEqual(view.attachments.map((a) => a.id), [attachment.id]);
  });

  it("refuses an empty file rather than filing nothing", async () => {
    const { store, conversationId } = await setup();
    await assert.rejects(
      () => store.ingest(conversationId, { fileName: "empty.txt", bytes: new Uint8Array(0) }),
      (err: unknown) => err instanceof AttachmentError && err.reason === "empty",
    );
  });

  it("leaves nothing behind when it refuses", async () => {
    const { store, worldPath, conversationId } = await setup();
    await store.ingest(conversationId, { fileName: "kept.txt", bytes: bytes("kept") }).catch(() => {});
    await store
      .ingest(conversationId, { fileName: "empty.txt", bytes: new Uint8Array(0) })
      .catch(() => {});
    // The staging directory itself may remain; what must not is anything inside it, which would
    // be a half-built attachment surviving a failure.
    const staging = join(conversationDir(worldPath, conversationId), "attachments", ".incoming");
    assert.deepEqual(await readdir(staging).catch(() => []), []);
  });

  it("turns a long paste into a document attachment rather than truncating it", async () => {
    const { store, conversationId } = await setup();
    const long = "salt ".repeat(5_000);
    const attachment = await store.ingestText(conversationId, long);
    assert.equal(attachment.kind, "document");
    assert.equal(attachment.readability, "text-readable");
    assert.equal(attachment.byteLength, long.length, "every character is kept");
  });
});

describe("reading an attachment as text", () => {
  it("returns a bounded window and says how much more there is", async () => {
    const { store, conversationId } = await setup();
    const long = "a".repeat(MAX_TEXT_READ_CHARS * 2);
    const attachment = await store.ingestText(conversationId, long);

    const first = await store.readText(attachment);
    assert.equal(first.text.length, MAX_TEXT_READ_CHARS);
    assert.equal(first.truncated, true);
    assert.equal(first.totalChars, MAX_TEXT_READ_CHARS * 2);
    assert.equal(first.contentHash, attachment.contentHash, "quotable against the bytes it came from");

    const second = await store.readText(attachment, { offset: MAX_TEXT_READ_CHARS });
    assert.equal(second.truncated, false, "the window reaches the end");
  });

  it("will not exceed the per-call bound however large a range is asked for", async () => {
    const { store, conversationId } = await setup();
    const attachment = await store.ingestText(conversationId, "b".repeat(100_000));
    const read = await store.readText(attachment, { limit: 100_000 });
    assert.equal(read.text.length, MAX_TEXT_READ_CHARS);
  });

  it("refuses a file it cannot read instead of returning gibberish", async () => {
    const { store, conversationId } = await setup();
    const attachment = await store.ingest(conversationId, {
      fileName: "cover.png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    assert.equal(attachment.readability, "not-readable");
    await assert.rejects(
      () => store.readText(attachment),
      (err: unknown) => err instanceof AttachmentError && err.reason === "not-text-readable",
    );
  });

  it("says so plainly when the bytes have gone", async () => {
    const { store, worldPath, conversationId } = await setup();
    const attachment = await store.ingestText(conversationId, "here for now");
    await rm(attachmentDir(worldPath, conversationId, attachment.id), { recursive: true, force: true });
    await assert.rejects(
      () => store.readText(attachment),
      (err: unknown) => err instanceof AttachmentError && err.reason === "not-found",
    );
  });
});

describe("promotion into the world", () => {
  it("files a copy and records the artifact against the conversation", async () => {
    const { store, worldPath, conversationId } = await setup();
    const attachment = await store.ingestText(conversationId, "a map of the lower town");

    const filed: string[] = [];
    const artifactId = await store.promote(conversationId, attachment, async (input) => {
      filed.push(input.fileName);
      return "art_001";
    });

    assert.equal(artifactId, "art_001");
    assert.deepEqual(filed, ["pasted-text.txt"]);
    const view = await load(worldPath, conversationId);
    assert.equal(view.attachments[0]!.promotedArtifactId, "art_001");
  });

  it("does not file a second copy when the button is pressed twice", async () => {
    const { store, worldPath, conversationId } = await setup();
    const attachment = await store.ingestText(conversationId, "once");
    await store.promote(conversationId, attachment, async () => "art_001");

    const again = (await load(worldPath, conversationId)).attachments[0]!;
    let called = 0;
    const artifactId = await store.promote(conversationId, again, async () => {
      called += 1;
      return "art_002";
    });

    assert.equal(called, 0, "the artifact path is not asked a second time");
    assert.equal(artifactId, "art_001", "and the answer is the artifact that already exists");
  });

  it("keeps the private copy, because the conversation's evidence quotes it", async () => {
    const { store, worldPath, conversationId } = await setup();
    const attachment = await store.ingestText(conversationId, "quoted later");
    await store.promote(conversationId, attachment, async () => "art_001");
    const stillThere = await readFile(
      join(attachmentDir(worldPath, conversationId, attachment.id), "pasted-text.txt"),
      "utf8",
    );
    assert.equal(stillThere, "quoted later");
  });
});

describe("what depends on an attachment", () => {
  it("finds nothing for a file nobody has used", async () => {
    const { store, worldPath, conversationId } = await setup();
    const attachment = await store.ingestText(conversationId, "unused");
    const deps = attachmentDependencies(await load(worldPath, conversationId), attachment.id);
    assert.deepEqual(deps.citingCandidateIds, []);
    assert.deepEqual(deps.linkedMessageIds, []);
    assert.equal(blockedFromRemoval(deps), null);
  });

  it("reports the turns that referred to it", async () => {
    const { store, worldPath, conversationId } = await setup();
    const attachment = await store.ingestText(conversationId, "referred to");
    const messageId = newId("msg") as MessageId;
    await store.link(conversationId, attachment.id, messageId);

    const deps = attachmentDependencies(await load(worldPath, conversationId), attachment.id);
    assert.deepEqual(deps.linkedMessageIds, [messageId]);

    await store.unlink(conversationId, attachment.id, messageId);
    assert.deepEqual(
      attachmentDependencies(await load(worldPath, conversationId), attachment.id).linkedMessageIds,
      [],
      "removing the chip stops future turns referring to it",
    );
  });

  it("still has the bytes after the chip is removed", async () => {
    const { store, worldPath, conversationId } = await setup();
    const attachment = await store.ingestText(conversationId, "kept regardless");
    const messageId = newId("msg") as MessageId;
    await store.link(conversationId, attachment.id, messageId);
    await store.unlink(conversationId, attachment.id, messageId);

    const read = await store.readText((await load(worldPath, conversationId)).attachments[0]!);
    assert.equal(read.text, "kept regardless", "unlinking is not deletion");
  });

  it("returns nothing for an attachment that was never filed", async () => {
    const { worldPath, conversationId } = await setup();
    const deps = attachmentDependencies(
      await load(worldPath, conversationId),
      newId("wca") as ChatAttachmentId,
    );
    assert.deepEqual(deps.citingCandidateIds, []);
    assert.equal(blockedFromRemoval(deps), null);
  });
});

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
  CHAT_DOCUMENT_EXTENSIONS,
  detectReadability,
  MAX_TEXT_READ_CHARS,
  refuseUnreadable,
  WorldChatAttachmentStore,
} from "../../src/world-chat/attachments.js";
import { oneParagraphDocx, onePagePdf, pictureOnlyPdf } from "./build-documents.js";
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

/**
 * What World Chat will take, this round (§13.2, §23.2).
 *
 * The gate is deliberately narrower than the artifact path's: a conversation may only be handed
 * what it can honestly read. A chip that looks attached while the reply cannot see the file is
 * worse than a refusal, because the person carries on talking as though it had been read.
 */
describe("refusing what a conversation could not read", () => {
  it("takes markdown and plain text", () => {
    assert.equal(refuseUnreadable("draft.md", bytes("# The Undersong")), null);
    assert.equal(refuseUnreadable("notes.txt", bytes("the bells again")), null);
  });

  it("names the kind it is refusing, rather than saying no", () => {
    const image = refuseUnreadable("maren.png", bytes("not really a png"));
    assert.match(image!, /image/, "so the person knows it is the kind and not the file");
    assert.match(image!, /maren\.png/, "and which file it was");
    assert.match(refuseUnreadable("take.wav", bytes("x"))!, /audio/);
    assert.match(refuseUnreadable("archive.zip", bytes("x"))!, /not a document/);
  });

  /**
   * PDF and Word are read by taking them apart, and whether there is anything inside one is not
   * a question the name or the first few bytes can answer. So this gate lets them past and
   * `ingest` decides — still before anything is written, and still with a sentence.
   */
  it("leaves the formats that are read by extraction to the extractor", () => {
    assert.equal(refuseUnreadable("brief.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01])), null);
    assert.equal(refuseUnreadable("treatment.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04])), null);
    // Not a blanket exemption for anything binary: a .doc is a format this does not read.
    assert.match(refuseUnreadable("treatment.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))!, /not a document/);
  });

  it("refuses a text file that is secretly binary", () => {
    assert.ok(refuseUnreadable("notes.txt", new Uint8Array([0x00, 0x01, 0x02])));
  });

  it("offers only what it can read in the picker", () => {
    assert.deepEqual([...CHAT_DOCUMENT_EXTENSIONS].sort(), ["docx", "md", "pdf", "txt"]);
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

  /**
   * A manuscript is not unreadable because of where its 4096th byte falls.
   *
   * The sample is a fixed count of bytes, so it cuts wherever that lands, and prose out of a word
   * processor is full of three-byte characters for it to land inside. Every one of these is plain
   * text that a fatal non-streaming decoder called invalid UTF-8, refusing the whole document at
   * the point of attaching it with a sentence about it not being readable as text.
   */
  it("calls prose readable when a character straddles the end of the sample", () => {
    for (const ch of ["—", "’", "“", "…", "é"]) {
      for (let pad = 4093; pad <= 4096; pad++) {
        const text = "a".repeat(pad) + ch + " and the rest of an ordinary manuscript.";
        assert.equal(
          detectReadability("document", bytes(text)),
          "text-readable",
          `U+${ch.codePointAt(0)?.toString(16)} at pad ${pad}`,
        );
      }
    }
  });

  /** Tolerating the cut is not tolerating rubbish: bad bytes anywhere else still fail. */
  it("still refuses invalid UTF-8 that is not an artefact of the cut", () => {
    // 0xC3 0x28 is a leading byte followed by a non-continuation - illegal, and nowhere near the end.
    const bad = new Uint8Array([...bytes("a".repeat(100)), 0xc3, 0x28, ...bytes("b".repeat(100))]);
    assert.equal(detectReadability("document", bad), "not-readable");
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

  /**
   * A PDF or a Word file arrives as an ordinary attachment with its words already out of it.
   *
   * Two things are kept, and which is which matters: the original is what gets filed into the
   * world if the person promotes it, and the extraction is what the conversation reads and
   * quotes. The hash stays the file's own, so a quotation still names the file it came from.
   */
  it("keeps a PDF's words beside the PDF", async () => {
    const { store, worldPath, conversationId } = await setup();
    const attachment = await store.ingest(conversationId, {
      fileName: "treatment.pdf",
      bytes: onePagePdf("The bells again."),
    });

    assert.equal(attachment.kind, "document");
    assert.equal(attachment.readability, "extracted-text-available");
    assert.equal(await store.readWholeText(attachment), "The bells again.");
    assert.deepEqual(
      new Uint8Array(await store.readBytes(attachment)).slice(0, 5),
      new Uint8Array(onePagePdf("The bells again.")).slice(0, 5),
      "the file itself is untouched",
    );

    const dir = attachmentDir(worldPath, conversationId, attachment.id);
    assert.deepEqual((await readdir(dir)).sort(), [".extracted.txt", "treatment.pdf"]);
  });

  it("reads a Word file the same way", async () => {
    const { store, conversationId } = await setup();
    const attachment = await store.ingest(conversationId, {
      fileName: "notes.docx",
      bytes: oneParagraphDocx("She hears it under the harbour."),
    });
    assert.equal(attachment.readability, "extracted-text-available");
    assert.equal(await store.readWholeText(attachment), "She hears it under the harbour.");
  });

  /**
   * A file with nothing to read is refused in the same breath as one of the wrong kind.
   *
   * This is the case the honesty rule was written for: a scan attaches, looks attached, and the
   * reply cannot see a word of it, so the person carries on talking as though it had been read.
   */
  it("refuses a PDF with no words in it, and files nothing", async () => {
    const { store, worldPath, conversationId } = await setup();
    await assert.rejects(
      () => store.ingest(conversationId, { fileName: "scan.pdf", bytes: pictureOnlyPdf() }),
      (err: unknown) =>
        err instanceof AttachmentError && err.reason === "not-text-readable" && /may be a scan/.test(err.message),
    );
    const dir = join(conversationDir(worldPath, conversationId), "attachments");
    assert.deepEqual(await readdir(dir).catch(() => []), [], "not even a staging directory of one");
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

  /*
   * The per-call figure is a default, not a ceiling.
   *
   * It was both, and the ceiling was the quiet half: the same method loads the text that goes
   * into the prompt, so every document was cut to eight thousand characters before any budget had
   * an opinion. What a call may return is governed by the run's text budget, which the caller
   * passes down — not by a clamp that could not tell the tool path from the prompt path.
   */
  it("honours a larger range when the caller asks for one", async () => {
    const { store, conversationId } = await setup();
    const attachment = await store.ingestText(conversationId, "b".repeat(100_000));
    const read = await store.readText(attachment, { limit: 100_000 });
    assert.equal(read.text.length, 100_000);
    assert.equal(read.truncated, false);
  });

  it("reads a whole document for the path that puts it in the prompt", async () => {
    const { store, conversationId } = await setup();
    const whole = "c".repeat(MAX_TEXT_READ_CHARS * 7 + 13);
    const attachment = await store.ingestText(conversationId, whole);
    assert.equal(await store.readWholeText(attachment), whole);
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

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  newId,
  type CandidateId,
  type ChatAttachmentId,
  type ConversationId,
  type MessageId,
  type WorldChatAttachment,
  type WorldChatLoaded,
} from "@arke-studio/contracts";
import { kindForFile } from "../artifacts/filing.js";
import { spoolName } from "../artifacts/spool.js";
import {
  EXTRACTED_EXTENSIONS,
  extractDocumentText,
  extractionRefusal,
  isExtractable,
} from "./document-text.js";
import { toExtendedLength } from "../world/paths.js";
import { conversationDir, WorldChatStore } from "./store.js";

/**
 * Private conversation attachments (#70 §10.1.1, §13).
 *
 * These are unfinished workspace, not world artifacts. They live inside the conversation, never
 * enter the index, and leave with it. The distinction matters because the world is the record of
 * what has been agreed: a reference photo somebody dropped into a chat to think out loud with has
 * not been agreed to anything, and filing it automatically would put it in the world's history on
 * the strength of a passing thought.
 *
 * Promotion is therefore always explicit, and always the user's.
 */

/** Matches the filing path's ceiling, so an attachment cannot be a way around it. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * What one `get_attachment_text` call returns when it does not say (§19).
 *
 * A default, not a ceiling. It used to be both, and the ceiling was the quiet half: the same
 * method loads the text that goes into the prompt, so a document was cut to eight thousand
 * characters before any budget had an opinion about it. Whatever the prompt then said about
 * carrying attachments whole, whole meant the first eight thousand characters.
 *
 * What a call may actually return is governed where it should be — by the run's own text budget,
 * which the caller passes down.
 */
export const MAX_TEXT_READ_CHARS = 8_000;

/**
 * A passage of a document, and where in it that passage begins.
 *
 * The offset is what makes two reads comparable. A run pages through a long document one window
 * at a time, and a quotation may sit across the join between two of them — which is a real
 * quotation of text really read, but only if the windows were adjacent. Without the offsets,
 * consecutive windows and unrelated ones look identical.
 */
export interface AttachmentRange {
  offset: number;
  text: string;
}

/**
 * Fold ranges into the longest passages that were actually contiguous.
 *
 * Overlapping and abutting windows join; a gap between them does not close. That gap is the
 * point: a quote spanning two passages the model never read consecutively is not evidence, and
 * concatenating everything would manufacture text that appears nowhere in the document.
 */
export function mergeAttachmentRanges(ranges: readonly AttachmentRange[]): string[] {
  const sorted = [...ranges].filter((r) => r.text.length > 0).sort((a, b) => a.offset - b.offset);
  const merged: AttachmentRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.offset > last.offset + last.text.length) {
      merged.push({ ...range });
      continue;
    }
    const overlap = last.offset + last.text.length - range.offset;
    if (overlap < range.text.length) last.text += range.text.slice(overlap);
  }
  return merged.map((r) => r.text);
}

/**
 * The floor for what one run may read out of attachments, across all calls (§19).
 *
 * A floor rather than the figure: like every other budget here it is taken from the window of the
 * model that answers, and this is what applies when none can be named.
 */
export const MAX_TEXT_PER_RUN_CHARS = 32_000;

export const MAX_LINKED_ATTACHMENTS_PER_TURN = 20;

/** Longer typed input becomes a document attachment rather than being cut (§19). */
export const MAX_MESSAGE_CHARS = 16_000;

/**
 * Where the words got out of a PDF or a Word file are kept, beside the file itself.
 *
 * The leading dot is what makes the name safe to hard-code: `spoolName` strips leading dots from
 * every name it is given, so no attachment can ever be called this and collide with it.
 */
export const EXTRACTED_TEXT_FILE = ".extracted.txt";

/** CON, PRN, AUX, NUL, COM0–9, LPT0–9 — reserved on Windows in any directory. */
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export class AttachmentError extends Error {
  constructor(
    readonly reason:
      | "empty"
      | "too-large"
      | "unsafe-name"
      | "not-found"
      | "not-text-readable"
      | "escapes-conversation",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export function attachmentsDir(worldPath: string, conversationId: ConversationId): string {
  return join(conversationDir(worldPath, conversationId), "attachments");
}

export function attachmentDir(
  worldPath: string,
  conversationId: ConversationId,
  attachmentId: ChatAttachmentId,
): string {
  return join(attachmentsDir(worldPath, conversationId), attachmentId);
}

function attachmentPath(worldPath: string, attachment: WorldChatAttachment): string {
  const dir = resolve(attachmentDir(worldPath, attachment.conversationId, attachment.id));
  if (attachmentFileName(attachment.fileName) !== attachment.fileName) {
    throw new AttachmentError("escapes-conversation", "That attachment name is no longer safe.");
  }
  const path = resolve(dir, attachment.fileName);
  if (path !== dir && !path.startsWith(dir + sep)) {
    throw new AttachmentError("escapes-conversation", "That attachment escapes its conversation.");
  }
  return path;
}

/**
 * A name safe to write.
 *
 * `spoolName` already drops directory parts, so a name cannot steer where the file lands. The
 * device-name escape on top of it is this path's own: an attachment name comes from whoever sent
 * the file, and `CON.txt` is a device on Windows in every directory, so it would fail the write
 * rather than land somewhere unexpected.
 */
export function attachmentFileName(raw: string): string {
  const safe = spoolName(raw);
  return RESERVED_DEVICE.test(safe) ? `file-${safe}` : safe;
}

function chatKind(fileName: string): WorldChatAttachment["kind"] {
  const kind = kindForFile(fileName);
  // `board` exists for artifacts and has no meaning here.
  return kind === "board" ? "other" : kind;
}

/**
 * What may honestly be claimed about this file (§13.2).
 *
 * Decided from the bytes, not the extension. A `.txt` holding a binary blob is not text, and
 * saying otherwise would let the Studio imply it had read something it never opened.
 *
 * This answers one question only: are these bytes themselves text. A PDF's are not, and never
 * will be — what makes a PDF readable is the extraction step, which `ingest` runs and records as
 * a readability of its own.
 *
 * The sample is decoded as a *stream*, and that is the whole of the difference between this
 * working and this rejecting ordinary prose. Cutting at a fixed 4096 bytes cuts wherever 4096
 * bytes happens to land, which for anything typographic — a curly quote, an em-dash, an ellipsis,
 * an accented name — is one byte inside a character about two times in three that a multi-byte
 * character straddles the line. A non-streaming fatal decoder calls that truncation invalid UTF-8
 * and the document is refused as unreadable, so whether a manuscript can be attached at all comes
 * down to where its four-thousand-and-ninety-sixth byte falls. Streaming holds an incomplete
 * trailing sequence back instead of throwing, which is the question actually being asked: is what
 * we have seen so far text. Invalid bytes anywhere but the cut still fail, and so does a NUL.
 */
export function detectReadability(
  kind: WorldChatAttachment["kind"],
  bytes: Uint8Array,
): WorldChatAttachment["readability"] {
  if (kind !== "document") return "not-readable";
  const sample = bytes.subarray(0, 4096);
  if (sample.includes(0)) return "not-readable";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return "text-readable";
  } catch {
    return "not-readable";
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * What the picker offers World Chat, and why it is narrower than the artifact path's list.
 *
 * A conversation may only be handed what it can honestly read (§13.2). Images, audio and video
 * would arrive as a chip the Studio could name but never open — multimodal understanding is
 * explicitly deferred (§23.2) — and a chip that looks attached while the reply cannot see it is
 * worse than a refusal, because the person goes on talking as though it had been read.
 *
 * PDF and Word were out for the same reason and are in now for the reason the refusal named:
 * there is an extraction step. The rule has not moved. What can be read is still decided by the
 * file rather than by its name, only now that decision has two ways of coming out true — the
 * bytes are text, or text can be got out of them — and a file that satisfies neither is refused
 * as plainly as before.
 */
export const CHAT_DOCUMENT_EXTENSIONS: readonly string[] = ["md", "txt", ...EXTRACTED_EXTENSIONS];

/**
 * Whether this file can be handed to a conversation, or the sentence explaining why not.
 *
 * Checked before anything is written, so a refused file leaves nothing behind to clean up.
 *
 * The kind gate is here; the deeper one is not. Whether there are words inside a PDF is only
 * answerable by taking it apart, and `ingest` is where that happens — once, on the way in,
 * rather than twice because two callers each wanted an answer. It refuses in the same breath and
 * just as early: nothing is written until the text is in hand.
 */
export function refuseUnreadable(fileName: string, bytes: Uint8Array): string | null {
  const kind = chatKind(fileName);
  if (kind !== "document") {
    return `World Chat can only read text for now, and ${fileName} is ${kind === "other" ? "not a document" : `${kind === "image" ? "an" : "a"} ${kind} file`}.`;
  }
  if (isExtractable(fileName)) return null;
  if (detectReadability(kind, bytes) !== "text-readable") {
    return `${fileName} is not readable as text — World Chat cannot open it yet.`;
  }
  return null;
}

export interface IngestInput {
  fileName: string;
  bytes: Uint8Array;
  /** Set when the bytes came off the web rather than from the person (2026-08-22). */
  source?: { url: string; fetchedAt: string };
}

/** Refused reads, in the words the turn can pass on. */
export class FetchRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "FetchRefused";
  }
}

/** How much of one page is worth keeping; beyond this the read is a window, not the document. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * Readable text out of a page, without pulling in a parser.
 *
 * Scripts and styles go first — their contents are not prose and would be quoted as though they
 * were — then tags become spaces, entities are decoded, and runs of blank space collapse. This
 * is deliberately plain: a quotation has to match what was stored, so the transformation that
 * produces the stored text must be one anybody can reason about later.
 */
export function readableText(html: string): string {
  const withoutCode = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const entities: Record<string, string> = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
    // The marks prose actually uses. Left raw, "&mdash;" would sit inside a stored quotation
    // and never match what the model read on the page.
    "&mdash;": "—", "&ndash;": "–", "&hellip;": "…", "&rsquo;": "’",
    "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”", "&#8217;": "’",
  };
  return withoutCode
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (m) => entities[m.toLowerCase()] ?? m)
    // Horizontal space only: the newlines above are the paragraph structure, and collapsing
    // them here would join sentences that the page kept apart.
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

export class WorldChatAttachmentStore {
  constructor(
    readonly worldPath: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private store(conversationId: ConversationId): WorldChatStore {
    return new WorldChatStore(conversationDir(this.worldPath, conversationId));
  }

  /**
   * File bytes privately against a conversation.
   *
   * The directory is assembled away from its final name and moved into place in one step, so a
   * crash mid-write leaves nothing that looks like a complete attachment. The event is appended
   * only once the bytes are there: an event describing a file that does not exist would survive
   * every restart and describe it forever.
   */
  async ingest(conversationId: ConversationId, input: IngestInput): Promise<WorldChatAttachment> {
    if (input.bytes.byteLength === 0) {
      throw new AttachmentError("empty", "There was nothing in that file.");
    }
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      const mb = Math.round(input.bytes.byteLength / (1024 * 1024));
      throw new AttachmentError("too-large", `${mb} MB is larger than this app will copy in.`);
    }

    const fileName = attachmentFileName(input.fileName);
    if (!fileName) throw new AttachmentError("unsafe-name", "That file name cannot be used.");

    /**
     * A PDF or a Word file is read by getting its words out first (§13.2).
     *
     * Before anything is written, so a file with nothing in it leaves nothing behind — and
     * before the id is minted, so the refusal is about the file rather than about an attachment
     * that briefly existed. What comes back is kept beside the original: the original is what
     * gets filed into the world if the person promotes it, and the extraction is what the
     * conversation reads and quotes.
     */
    let extracted: string | null = null;
    if (isExtractable(fileName)) {
      const result = extractDocumentText(fileName, input.bytes);
      if (result && !result.ok) {
        throw new AttachmentError("not-text-readable", extractionRefusal(fileName, result.reason));
      }
      extracted = result?.text ?? null;
    }

    const id = newId("wca") as ChatAttachmentId;
    const finalDir = attachmentDir(this.worldPath, conversationId, id);
    const target = resolve(finalDir, fileName);
    // Belt to spoolName's braces: whatever the name was, the file lands inside this attachment.
    if (target !== resolve(finalDir) && !target.startsWith(resolve(finalDir) + sep)) {
      throw new AttachmentError("escapes-conversation", "That file name cannot be used.");
    }

    const staging = join(attachmentsDir(this.worldPath, conversationId), ".incoming", id);
    await mkdir(toExtendedLength(staging), { recursive: true });
    try {
      await writeFile(toExtendedLength(join(staging, fileName)), input.bytes);
      if (extracted !== null) {
        await writeFile(toExtendedLength(join(staging, EXTRACTED_TEXT_FILE)), extracted, "utf8");
      }
      await mkdir(toExtendedLength(join(finalDir, "..")), { recursive: true });
      await rename(toExtendedLength(staging), toExtendedLength(finalDir));
    } catch (err) {
      await rm(toExtendedLength(staging), { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    const kind = chatKind(fileName);
    const attachment: WorldChatAttachment = {
      id,
      conversationId,
      fileName,
      kind,
      contentHash: digest(input.bytes),
      byteLength: input.bytes.byteLength,
      // The hash stays the file's own. What is quoted is the extraction, and it is derived from
      // these bytes by one function — so the hash still identifies what any quotation came from,
      // and a different file cannot produce the same one.
      readability: extracted !== null ? "extracted-text-available" : detectReadability(kind, input.bytes),
      linkedMessageIds: [],
      ...(input.source !== undefined ? { source: input.source } : {}),
      createdAt: this.now(),
    };
    await this.store(conversationId).append({ type: "attachment.created", attachment }, { at: attachment.createdAt });
    return attachment;
  }

  /**
   * Text too long to be a message becomes a document attachment (§13.2, §19).
   *
   * Deliberately the same object as an uploaded file rather than a special case, so there is one
   * set of rules about what may be read and quoted rather than a second quieter one for paste.
   */
  async ingestText(
    conversationId: ConversationId,
    text: string,
    fileName = "pasted-text.txt",
  ): Promise<WorldChatAttachment> {
    return this.ingest(conversationId, {
      fileName: fileName.endsWith(".txt") || fileName.endsWith(".md") ? fileName : `${fileName}.txt`,
      bytes: new TextEncoder().encode(text),
    });
  }

  /**
   * Read a page from the web and keep it, so what was read stays checkable (2026-08-22).
   *
   * The page becomes an ordinary attachment. That is the whole design: this system verifies a
   * quotation against bytes it holds, and the web moves — a citation checked against a live URL
   * would pass today and fail next month for reasons that have nothing to do with the writing.
   * Stored, the quote is checked against what was actually read, forever.
   *
   * Only http and https, only a page the person's own machine can reach, and only when research
   * is turned on. Nothing here follows a link it was not given.
   */
  async fetchPage(
    conversationId: ConversationId,
    url: string,
    deps: { fetch?: typeof globalThis.fetch } = {},
  ): Promise<WorldChatAttachment> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new FetchRefused(`"${url}" is not an address this can read.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new FetchRefused(`${parsed.protocol} is not a protocol this reads — http and https only.`);
    }
    const doFetch = deps.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await doFetch(parsed.toString(), {
        redirect: "follow",
        headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
      });
    } catch (err) {
      throw new FetchRefused(`that page could not be reached: ${err instanceof Error ? err.message : "no answer"}`);
    }
    if (!response.ok) throw new FetchRefused(`that page answered ${response.status}.`);
    const type = response.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      throw new FetchRefused(`that address is ${type || "not text"}, and this reads pages, not files.`);
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.byteLength > MAX_PAGE_BYTES) throw new FetchRefused("that page is larger than this will keep.");
    const html = new TextDecoder("utf-8", { fatal: false }).decode(raw);
    const text = /text\/plain/i.test(type) ? html.trim() : readableText(html);
    if (text === "") throw new FetchRefused("there was no readable text on that page.");

    const fetchedAt = this.now();
    return this.ingest(conversationId, {
      // The address is the name, so the attachment says where it came from before it is opened.
      fileName: `${parsed.hostname}${parsed.pathname}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) + ".txt",
      bytes: new TextEncoder().encode(`${parsed.toString()}

${text}`),
      source: { url: parsed.toString(), fetchedAt },
    });
  }

  /** "Refer to this attachment in this turn." Linkage is scoped to one conversation (§13.1). */
  async link(conversationId: ConversationId, attachmentId: ChatAttachmentId, messageId: MessageId): Promise<void> {
    await this.store(conversationId).append(
      { type: "attachment.linked", attachmentId, messageId },
      { at: this.now() },
    );
  }

  /** Stops future turns referring to it. The bytes stay until the conversation is deleted. */
  async unlink(conversationId: ConversationId, attachmentId: ChatAttachmentId, messageId: MessageId): Promise<void> {
    await this.store(conversationId).append(
      { type: "attachment.unlinked", attachmentId, messageId },
      { at: this.now() },
    );
  }

  async readBytes(attachment: WorldChatAttachment): Promise<Uint8Array> {
    try {
      return await readFile(toExtendedLength(attachmentPath(this.worldPath, attachment)));
    } catch {
      throw new AttachmentError("not-found", "That attachment is no longer on disk.");
    }
  }

  /**
   * The characters this attachment reads as — the file itself, or what was got out of it.
   *
   * One method rather than a branch at every call site, because the difference is exactly what
   * the rest of the system should not have to know: a conversation reads text, and whether that
   * text was decoded or extracted is settled once, at the door.
   */
  private async readCharacters(attachment: WorldChatAttachment): Promise<string> {
    if (attachment.readability !== "extracted-text-available") {
      return new TextDecoder("utf-8").decode(await this.readBytes(attachment));
    }
    const path = join(
      attachmentDir(this.worldPath, attachment.conversationId, attachment.id),
      EXTRACTED_TEXT_FILE,
    );
    try {
      return await readFile(toExtendedLength(path), "utf8");
    } catch {
      throw new AttachmentError("not-found", "That attachment is no longer on disk.");
    }
  }

  /**
   * A bounded window of an attachment's text (§9.2, §13.2).
   *
   * Refuses rather than guessing when the file is not text. Returns the content hash alongside
   * the text so a quotation taken from it can be verified later against the bytes it came from,
   * and reports the total length so a caller can tell a window from a whole document — a model
   * told only "here is the text" would cite a truncated file as though it had read all of it.
   */
  /**
   * The whole document, for the path that puts it in the prompt.
   *
   * What survives is the prompt budget's decision, made against the model's window with
   * everything else in view — not this method's, made per document before anything is known.
   */
  async readWholeText(attachment: WorldChatAttachment): Promise<string> {
    return (await this.readText(attachment, { limit: Number.POSITIVE_INFINITY })).text;
  }

  async readText(
    attachment: WorldChatAttachment,
    range: { offset?: number; limit?: number } = {},
  ): Promise<{ text: string; contentHash: string; offset: number; totalChars: number; truncated: boolean }> {
    if (attachment.readability === "not-readable") {
      throw new AttachmentError(
        "not-text-readable",
        `${attachment.fileName} cannot be read as text in this chat.`,
      );
    }
    const whole = await this.readCharacters(attachment);
    const offset = Math.max(0, Math.trunc(range.offset ?? 0));
    // No upper clamp: the caller's limit is the caller's business, and the run's text budget is
    // what actually bounds it. Clamping here bounded the prompt as well, which was never the point.
    const limit = Math.max(1, Math.trunc(range.limit ?? MAX_TEXT_READ_CHARS));
    const text = whole.slice(offset, offset + limit);
    return {
      text,
      contentHash: attachment.contentHash,
      offset,
      totalChars: whole.length,
      truncated: offset + text.length < whole.length,
    };
  }

  /**
   * File a copy into the world, and record where it went (§13.1).
   *
   * The filing itself belongs to the artifact path, which already owns dedupe, consent and the
   * sidecar; this records the result against the conversation so the chip can say "filed in the
   * world" and mean it. Recording is idempotent because the user can press the button twice and
   * a second artifact would be a duplicate of the first with no way to tell them apart.
   *
   * The private copy is not deleted. It is what the conversation's own evidence quotes, and
   * removing it would leave those quotations unverifiable.
   */
  async promote(
    conversationId: ConversationId,
    attachment: WorldChatAttachment,
    requestId: string,
    fileIntoWorld: (input: { fileName: string; bytes: Uint8Array; sourcePath: string }) => Promise<string>,
  ): Promise<string> {
    if (attachment.conversationId !== conversationId) {
      throw new AttachmentError("escapes-conversation", "That attachment belongs to a different conversation.");
    }
    if (attachment.promotedArtifactId !== undefined) return attachment.promotedArtifactId;
    const sourcePath = attachmentPath(this.worldPath, attachment);
    const bytes = await this.readBytes(attachment);
    if (bytes.byteLength !== attachment.byteLength || digest(bytes) !== attachment.contentHash) {
      throw new AttachmentError("not-found", "That attachment changed after it was added to the conversation.");
    }
    const artifactId = await fileIntoWorld({ fileName: attachment.fileName, bytes, sourcePath });
    await this.store(conversationId).append(
      { type: "attachment.promoted", attachmentId: attachment.id, artifactId },
      { at: this.now(), requestId },
    );
    return artifactId;
  }
}

/**
 * What still depends on an attachment (#70 §13.1).
 *
 * Removing a chip is not deletion — it stops future turns referring to the file, and the bytes
 * stay. That distinction is what makes this safe, and it is worth stating in code rather than
 * leaving to whoever writes the button: a proposition that quotes a document is only checkable
 * for as long as the document is there, so anything that would actually remove bytes has to know
 * what it would take with them.
 */
export interface AttachmentDependencies {
  /** Propositions whose evidence quotes this attachment. */
  citingCandidateIds: CandidateId[];
  /** Turns that referred to it. */
  linkedMessageIds: MessageId[];
  /** Set once a copy is filed in the world; that copy survives independently. */
  promotedArtifactId?: string;
}

export function attachmentDependencies(
  loaded: WorldChatLoaded,
  attachmentId: ChatAttachmentId,
): AttachmentDependencies {
  const citingCandidateIds = loaded.candidates
    .filter((candidate) =>
      candidate.evidence.some((e) => e.kind === "attachment" && e.attachmentId === attachmentId),
    )
    .map((candidate) => candidate.id);

  const attachment = loaded.attachments.find((a) => a.id === attachmentId);
  const linkedMessageIds = [
    ...new Set([
      ...(attachment?.linkedMessageIds ?? []),
      ...loaded.messages.filter((m) => m.attachmentIds.includes(attachmentId)).map((m) => m.id),
    ]),
  ];

  return {
    citingCandidateIds,
    linkedMessageIds,
    ...(attachment?.promotedArtifactId !== undefined
      ? { promotedArtifactId: attachment.promotedArtifactId }
      : {}),
  };
}

/**
 * Why an attachment's bytes cannot be removed yet, or null when they can.
 *
 * Separate from the removal itself so the reason can be shown before the button is pressed,
 * matching how conversation deletion already explains itself.
 */
export function blockedFromRemoval(deps: AttachmentDependencies): "cited-by-evidence" | null {
  return deps.citingCandidateIds.length > 0 ? "cited-by-evidence" : null;
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { newId, type HarnessAdapter, type Take, type WorldChatAttachment } from "@arke-studio/contracts";
import { ConversationImages } from "../../src/world-chat/images.js";
import { QueryLeaseRegistry, LeaseDeniedError } from "../../src/world-chat/lease.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { WorldChatRetrieval } from "../../src/world-chat/retrieval.js";
import { WorldChatAttachmentStore } from "../../src/world-chat/attachments.js";
import { WorldQueryServer } from "../../src/harness/world-query.js";
import { WorldStore } from "../../src/world/store.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { encodePng, solidImage, decodePng } from "../../src/references/png.js";
import { createImageRenditionMaker, imageRendition, IMAGE_MAX_BYTES } from "../../src/world-chat/image-rendition.js";
import { BenchStore, sessionDir, sessionMediaDir } from "../../src/bench/store.js";
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function metadataChunk() {
  const body = Buffer.from("note\0PRIVATE_METADATA"), type = Buffer.from("tEXt"), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  let value = 0xffffffff;
  for (const byte of Buffer.concat([type, body])) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, type, body, crc]);
}

async function harness(options: { supported?: boolean; local?: boolean; allowed?: boolean; publish?: () => Promise<void>;
  bytes?: Uint8Array; maker?: import("../../src/world-chat/image-rendition.js").ImageRenditionMaker } = {}) {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir);
  closeOnCleanup(() => store.close());
  const cv = newId("cv"), run = newId("run"), chat = new WorldChatStore(conversationDir(dir, cv));
  await chat.create(cv, "2026-10-04T04:00:00Z");
  await chat.append({ type: "conversation.created", title: "Images", entryContext: { kind: "world" } });
  let active: string | null = store.worldId, permitted = options.allowed !== false;
  const leases = new QueryLeaseRegistry(() => active);
  const attachments: WorldChatAttachment[] = [];
  for (const [index, color] of [[255, 0, 0, 255], [0, 0, 255, 255]].entries()) {
    const bytes = options.bytes ?? encodePng(solidImage(3, 2, color as [number, number, number, number]));
    const id = newId("wca"), path = join(conversationDir(dir, cv), "attachments", id);
    await mkdir(path, { recursive: true }); await writeFile(join(path, `look-${index}.png`), bytes);
    const attachment: WorldChatAttachment = { id, conversationId: cv, fileName: `look-${index}.png`, kind: "image",
      contentHash: digest(bytes), byteLength: bytes.length, readability: "not-readable", linkedMessageIds: [], createdAt: "2026-10-04T04:00:00Z" };
    attachments.push(attachment); await chat.append({ type: "attachment.created", attachment });
  }
  const lease = leases.mint({ worldId: store.worldId, conversationId: cv, runId: run, allowedAttachmentIds: attachments.map(a => a.id) });
  const adapter = { imageInput: options.supported !== false, imageInputForSession: () => options.supported !== false,
    imageDestinationForSession: () => ({ provider: "test-cloud", local: options.local === true }) } as unknown as HarnessAdapter;
  const images = new ConversationImages(store, leases, { adapter, ...(options.maker ? { maker: options.maker } : {}),
    allowed: async () => permitted, publish: options.publish ?? (async () => {}) });
  const controller = new AbortController();
  images.start(run, "session", controller.signal);
  const retrieval = new WorldChatRetrieval({ leases, getBundle: () => store.getBundle(), getIndex: () => null,
    attachments: new WorldChatAttachmentStore(dir), findAttachment: async (_lease, id) => attachments.find(a => a.id === id) ?? null,
    readImage: (lease, args) => images.read(lease, args) });
  return { store, chat, cv, lease, attachments, images, retrieval, setActive: (id: string | null) => { active = id; },
    forbid: () => { permitted = false; }, abort: () => controller.abort() };
}

describe("conversation image inspection — SPEC-050 R-31..R-34", () => {
  it("compares two distinct candidate looks as actual pixels and persists one provider notice with every byte receipt", async () => {
    const h = await harness();
    const colors: number[][] = [];
    for (const attachment of h.attachments) {
      const read = await h.retrieval.call(h.lease.token, "view_image", { kind: "attachment", id: attachment.id });
      assert.equal(read.receipt.image!.sourceHash, attachment.contentHash);
      assert.equal(read.receipt.image!.posterOnly, false);
      const png = Buffer.from(read.imageContent![0]!.data, "base64");
      assert.equal(digest(png), read.receipt.image!.renditionHash);
      colors.push(Array.from(decodePng(png).pixels.slice(0, 4)));
    }
    assert.deepEqual(colors, [[255, 0, 0, 255], [0, 0, 255, 255]]);
    const loaded = await new WorldChatService(h.store.dir).load(h.cv);
    assert.equal(loaded!.imageDisclosures!.length, 1);
    assert.equal(loaded!.imageDisclosures![0]!.images.length, 2);
    assert.equal(loaded!.imageReceipts!.length, 2);
    assert.equal(h.store.getBundle().meta.schemaVersion, 53);
    await assert.rejects(readWorldMeta(h.store.dir, { supports: 52 }), /newer|schema|version/i);
  });
  it("keeps text-only adapters honest without raising the world schema or disclosing imaginary handoffs", async () => {
    const h = await harness({ supported: false }), version = h.store.getBundle().meta.schemaVersion;
    const result = await h.retrieval.call(h.lease.token, "view_image", { kind: "attachment", id: h.attachments[0]!.id });
    assert.equal(result.receipt.status, "unavailable"); assert.equal(result.imageContent, undefined);
    assert.match(JSON.stringify(result.result), /view_image.*cannot inspect images/);
    assert.equal(h.store.getBundle().meta.schemaVersion, version);
    assert.equal((await new WorldChatService(h.store.dir).load(h.cv))!.imageReceipts, undefined);
  });
  it("reads actual world key art, candidates and kit-relative images from the authoritative catalogue", async () => {
    const h = await harness(), bytes = encodePng(solidImage(3, 3, [8, 9, 10, 255]));
    const files = ["world-art.png", "incoming/master-look/candidate-1.png", "references/seeing-kit/photo.png",
      "references/seeing-kit/close.png", "references/seeing-kit/old-face.png", "artifacts/seeing.png"];
    const artifactId = newId("ar");
    const binaryFiles = await Promise.all(files.map(async path => {
      const previous = await readFile(join(h.store.dir, path)).catch(() => null);
      return { path, action: previous ? "replace" as const : "create" as const, encoding: "base64" as const,
        content: Buffer.from(bytes).toString("base64"), baseHash: previous ? digest(previous) : null };
    }));
    await h.store.commit({ kind: "image-test", source: "test", files: [
      ...binaryFiles,
      { path: "references/seeing-kit/kit.json", action: "create", baseHash: null,
        content: JSON.stringify({ sheetId: "seeing-kit", mainPhoto: { file: "photo.png", source: "upload" }, tiles: [], compilations: [],
          looks: [{ id: "look", file: "photo.png", closeFile: "close.png", mainFile: "old-face.png", kind: "costume", prompt: "Red jacket", acceptedAt: "2026-10-04T04:00:00Z" }] }) },
      { path: "artifacts/seeing.json", action: "create", baseHash: null, content: JSON.stringify({ id: artifactId, kind: "image",
        file: "seeing.png", hash: digest(bytes), origin: { by: "user" }, links: [], created: "2026-10-04T04:00:00Z" }) },
    ] });
    for (const file of files.slice(0, -1)) {
      const read = await h.retrieval.call(h.lease.token, "view_image", { kind: "reference", file });
      assert.ok(read.imageContent, `${file} is a catalogue-authorized picture`);
      assert.equal(read.receipt.image!.sourceHash, digest(bytes));
    }
    const artifact = await h.retrieval.call(h.lease.token, "view_image", { kind: "artifact", id: artifactId });
    assert.ok(artifact.imageContent); assert.equal(artifact.receipt.image!.sourceHash, digest(bytes));
  });
  it("reads an immutable Bench take independently of the live composer", async () => {
    const h = await harness(), sessionId = newId("sess"), takeId = newId("tk");
    const bench = new BenchStore(sessionDir(h.store.dir, sessionId));
    await bench.create(sessionId, "2026-10-04T04:00:00Z");
    await bench.append({ type: "takes-reserved", takes: [{ id: takeId, n: 1, requestId: "image-test",
      request: { mode: "image", brief: "Red look", references: [], keyframes: [], provider: "fal", model: "test-image", params: { kind: "image", count: 1 } },
      createdAt: "2026-10-04T04:00:00Z" }] });
    const bytes = encodePng(solidImage(2, 2, [255, 10, 20, 255])), media = join(h.store.dir, sessionMediaDir(sessionId, takeId));
    await mkdir(media, { recursive: true }); await writeFile(join(media, "look.png"), bytes);
    await bench.append({ type: "take-completed", takeId, media: { file: "look.png", hash: digest(bytes) }, completedAt: "2026-10-04T04:00:00Z" });
    const image = await h.retrieval.call(h.lease.token, "view_image", { kind: "bench-take", sessionId, takeId });
    assert.ok(image.imageContent); assert.equal(image.receipt.image!.sourceHash, digest(bytes));
  });
  it("discovers production images, reads a frozen seed and seeks a pass segment's own poster", async () => {
    const positions: number[] = [], red = encodePng(solidImage(2, 2, [255, 0, 0, 255])), blue = encodePng(solidImage(2, 2, [0, 0, 255, 255]));
    const h = await harness({ maker: { render: async (bytes, extension, _signal, atSec = 0) => {
      if (extension === ".png") return bytes;
      positions.push(atSec); return atSec === 2 ? blue : red;
    } } });
    const production = h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
    const { media: _media, ...base } = production.takes.find(t => t.kind === "clip")!;
    const frame: Take = { ...base, id: newId("tk"), kind: "frame", media: "frame.png", startFrame: "artifacts/frozen-seed.png" };
    const pass: Take = { ...base, id: newId("tk"), media: "pass.mp4" };
    const segment: Take = { ...base, id: newId("tk"), segment: { passTakeId: pass.id, inSec: 2, outSec: 4 } };
    await h.store.commit({ kind: "production-images-test", source: "test", files: [
      ...[frame, pass, segment].map(take => ({ path: `productions/saltlight/takes/${take.id}/take.json`, action: "create" as const, baseHash: null, content: JSON.stringify(take) })),
      ...[[`productions/saltlight/takes/${frame.id}/frame.png`, red], [`productions/saltlight/takes/${pass.id}/pass.mp4`, red], ["artifacts/frozen-seed.png", blue]].map(([path, bytes]) =>
        ({ path: path as string, action: "create" as const, baseHash: null, encoding: "base64" as const, content: Buffer.from(bytes as Uint8Array).toString("base64") })),
    ] });
    const sources = new Map<string, Record<string, Record<string, unknown>>>();
    let cursor: string | undefined;
    do {
      const read = await h.retrieval.call(h.lease.token, "list_takes", { productionId: "saltlight", limit: 20, ...(cursor ? { cursor } : {}) });
      const page = read.result as { items: Array<{ kind: string; take?: Take; imageSources?: Record<string, Record<string, unknown>> }>; nextCursor: string | null };
      for (const row of page.items) if (row.take && row.imageSources) sources.set(row.take.id, row.imageSources);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const picture = await h.retrieval.call(h.lease.token, "view_image", sources.get(frame.id)!.poster!);
    const seed = await h.retrieval.call(h.lease.token, "view_image", sources.get(frame.id)!.startFrame!);
    assert.equal(picture.receipt.image!.posterOnly, false);
    assert.equal(seed.receipt.image!.sourceHash, digest(blue));
    assert.deepEqual(Array.from(decodePng(Buffer.from(seed.imageContent![0]!.data, "base64")).pixels.slice(0, 4)), [0, 0, 255, 255]);
    const whole = await h.retrieval.call(h.lease.token, "view_image", sources.get(pass.id)!.poster!);
    const part = await h.retrieval.call(h.lease.token, "view_image", sources.get(segment.id)!.poster!);
    assert.deepEqual(positions, [0, 2]);
    assert.equal(part.receipt.image!.sourceHash, whole.receipt.image!.sourceHash);
    assert.notEqual(part.receipt.image!.id, whole.receipt.image!.id);
    assert.notEqual(part.receipt.image!.renditionHash, whole.receipt.image!.renditionHash);
    assert.equal(part.receipt.image!.posterOnly, true);
    assert.match(JSON.stringify(part.result), /motion and audio were not inspected/);
  });
  it("refuses missing, audio, escaping and conversation-attachment production image sources", async () => {
    const h = await harness(), production = h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
    const base = production.takes.find(t => t.kind === "clip")!;
    const cases = [
      { media: "../../world-art.png", frame: "poster" },
      { media: "voice.wav", kind: "voice", frame: "poster" },
      { startFrame: "../world-art.png", frame: "start-frame" },
      { startFrame: `.conversations/${h.cv}/attachments/${h.attachments[0]!.id}/look-0.png`, frame: "start-frame" },
      { frame: "start-frame" },
    ];
    for (const { frame, ...overrides } of cases) {
      const take = { ...base, ...overrides, id: newId("tk") };
      await h.store.commit({ kind: "production-images-test", source: "test", files: [{ path: `productions/saltlight/takes/${take.id}/take.json`, action: "create", baseHash: null, content: JSON.stringify(take) }] });
      const read = await h.retrieval.call(h.lease.token, "view_image", { kind: "production-take", productionId: "saltlight", takeId: take.id, frame });
      assert.equal(read.receipt.status, "unavailable"); assert.equal(read.imageContent, undefined);
    }
    const missing = await h.retrieval.call(h.lease.token, "view_image", { kind: "production-take", productionId: "the-ledger-of-nights", takeId: base.id, frame: "poster" });
    assert.equal(missing.receipt.status, "unavailable");
  });
  it("hands out only a labelled poster and metadata when inspecting a video artifact", async () => {
    const poster = encodePng(solidImage(2, 2, [4, 5, 6, 255]));
    const h = await harness({ maker: { render: async () => poster } }), id = newId("ar");
    const clip = Buffer.concat(["ftyp", "moov", "mdat"].map(tag => Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from(tag)])));
    await h.store.commit({ kind: "video-test", source: "test", files: [
      { path: "artifacts/poster-source.mp4", action: "create", baseHash: null, encoding: "base64", content: clip.toString("base64") },
      { path: "artifacts/poster-source.json", action: "create", baseHash: null, content: JSON.stringify({ id, kind: "video", file: "poster-source.mp4",
        hash: digest(clip), links: [], origin: { by: "user" }, created: "2026-10-04T04:00:00Z" }) },
    ] });
    const read = await h.retrieval.call(h.lease.token, "view_image", { kind: "artifact", id });
    assert.equal(read.receipt.image!.posterOnly, true);
    assert.equal(read.receipt.image!.sourceHash, digest(clip));
    assert.match(JSON.stringify(read.result), /Poster frame only/);
    assert.match(JSON.stringify(read.result), /byteLength/);
    assert.deepEqual(Buffer.from(read.imageContent![0]!.data, "base64"), Buffer.from(poster));
  });

  it("refuses cloud policy, permits local inspection, and enforces the selected attachment lease", async () => {
    const cloud = await harness({ allowed: false });
    assert.equal((await cloud.retrieval.call(cloud.lease.token, "view_image", { kind: "attachment", id: cloud.attachments[0]!.id })).receipt.status, "unavailable");
    const local = await harness({ allowed: false, local: true });
    assert.ok((await local.retrieval.call(local.lease.token, "view_image", { kind: "attachment", id: local.attachments[0]!.id })).imageContent);
    assert.equal((await new WorldChatService(local.store.dir).load(local.cv))!.imageDisclosures, undefined);
    await assert.rejects(local.retrieval.call(local.lease.token, "view_image", { kind: "attachment", id: newId("wca") }), LeaseDeniedError);
  });
  it("refuses changed bytes, uncatalogued paths and world navigation before handing out pixels", async () => {
    const h = await harness(), a = h.attachments[0]!;
    await writeFile(join(conversationDir(h.store.dir, h.cv), "attachments", a.id, a.fileName), encodePng(solidImage(2, 2, [0, 255, 0, 255])));
    assert.equal((await h.retrieval.call(h.lease.token, "view_image", { kind: "attachment", id: a.id })).receipt.status, "unavailable");
    assert.equal((await h.retrieval.call(h.lease.token, "view_image", { kind: "reference", file: "world.json" })).receipt.status, "unavailable");
    h.setActive(null);
    await assert.rejects(h.retrieval.call(h.lease.token, "view_image", { kind: "attachment", id: a.id }), LeaseDeniedError);
  });
  it("rechecks privacy and the lease after publishing the pre-send notice", async () => {
    let revoke!: () => void;
    const h = await harness({ publish: async () => revoke() }); revoke = h.forbid;
    const read = await h.retrieval.call(h.lease.token, "view_image", { kind: "attachment", id: h.attachments[0]!.id });
    assert.equal(read.receipt.status, "unavailable"); assert.equal(read.imageContent, undefined);
    assert.equal((await new WorldChatService(h.store.dir).load(h.cv))!.imageReceipts!.length, 1, "receipt records prepared bytes; it does not claim the model understood them");
  });
  it("reads an accepted prop-state reference from the current prop catalogue", async () => {
    const h = await harness(), propId = newId("prop"), stateId = newId("pst"), takeId = newId("tk");
    const bytes = encodePng(solidImage(2, 2, [17, 18, 19, 255]));
    const file = `takes/${takeId}/state.png`, path = `references/${propId}/${file}`;
    await h.store.commit({ kind: "prop-image-test", source: "test", files: [
      { path, action: "create", baseHash: null, encoding: "base64", content: Buffer.from(bytes).toString("base64") },
      { path: `references/${propId}/prop.json`, action: "create", baseHash: null, content: JSON.stringify({ id: propId, name: "Lamp", states: [
        { id: stateId, name: "Lit", reference: { id: "psr-test", file, sourceTakeId: takeId, acceptedAt: "2026-10-04T04:00:00Z" } },
      ] }) },
    ] });
    assert.equal(h.store.getBundle().props.find(prop => prop.id === propId)!.states[0]!.reference!.file, file);
    const read = await h.retrieval.call(h.lease.token, "view_image", { kind: "reference", file: path });
    assert.ok(read.imageContent); assert.equal(read.receipt.image!.sourceHash, digest(bytes));
  });
  it("delivers GIF and MKV attachments to the rendition codec through the contained read", async () => {
    const seen: string[] = [], poster = encodePng(solidImage(2, 2, [1, 2, 3, 255]));
    const h = await harness({ maker: { render: async (_bytes, extension) => { seen.push(extension); return poster; } } });
    for (const [index, extension] of ["gif", "mkv"].entries()) {
      const a = h.attachments[index]!, bytes = extension === "gif" ? Buffer.from("GIF89a") : Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
      a.fileName = `source.${extension}`; a.kind = extension === "gif" ? "image" : "video";
      a.contentHash = digest(bytes); a.byteLength = bytes.length;
      await writeFile(join(conversationDir(h.store.dir, h.cv), "attachments", a.id, a.fileName), bytes);
      await h.chat.append({ type: "attachment.created", attachment: a });
      const read = await h.retrieval.call(h.lease.token, "view_image", { kind: "attachment", id: a.id });
      assert.ok(read.imageContent); assert.equal(read.receipt.image!.posterOnly, extension === "mkv");
    }
    assert.deepEqual(seen, [".gif", ".mkv"]);
  });
  it("aborts a running rendition without persisting a disclosure or handing out pixels", async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const h = await harness({ maker: { render: async (_bytes, _extension, signal) => {
      assert.ok(signal); entered();
      return await new Promise<Uint8Array>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } } });
    const pending = h.retrieval.call(h.lease.token, "view_image", { kind: "attachment", id: h.attachments[0]!.id });
    await started; h.abort();
    const read = await pending;
    assert.equal(read.imageContent, undefined);
    assert.equal((await new WorldChatService(h.store.dir).load(h.cv))!.imageDisclosures, undefined);
  });
  it("bounds the accumulated base64 image payload before persisting an over-budget handoff", async () => {
    const bytes = encodePng({ width: 1000, height: 1000, pixels: randomBytes(4_000_000) });
    const h = await harness({ bytes });
    let accepted = 0;
    for (let i = 0; i < 10; i++) {
      const read = await h.retrieval.call(h.lease.token, "view_image", { kind: "attachment", id: h.attachments[0]!.id });
      if (!read.imageContent) { assert.match(JSON.stringify(read.result), /20 MB encoded/); break; }
      assert.ok(read.imageContent[0]!.data.length <= 4_000_000); accepted++;
    }
    assert.ok(accepted > 0 && accepted < 10);
    const persisted = (await h.chat.read()).events.filter(e => e.event.type === "image.receipt");
    assert.equal(persisted.length, accepted);
  });
  it("returns MCP image blocks rather than base64 text", async () => {
    const h = await harness(), server = new WorldQueryServer(() => h.store);
    await server.start(); closeOnCleanup(() => server.stop());
    server.attachLease(h.lease.token, { retrieval: h.retrieval, onReceipt: () => {} });
    const reply = await fetch(server.leasedUrl(h.lease.token)!, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "view_image", arguments: { kind: "attachment", id: h.attachments[0]!.id } } }) });
    const payload = await reply.json() as { result: { content: Array<{ type: string; data?: string }> } };
    assert.equal(payload.result.content.filter(c => c.type === "image").length, 1);
  });
});

describe("bounded metadata-free renditions", () => {
  it("downsamples noisy PNG bytes below the encoded provider limit", async () => {
    const source = encodePng({ width: 1000, height: 1000, pixels: randomBytes(4_000_000) });
    assert.ok(source.length > IMAGE_MAX_BYTES);
    const result = await imageRendition(source, ".png");
    assert.ok(result.data.length <= IMAGE_MAX_BYTES);
    assert.ok(result.width < 1000 && result.height < 1000);
  });
  it("shrinks the longest edge, strips ancillary metadata and bounds decompression", async () => {
    const source = encodePng(solidImage(2000, 10, [1, 2, 3, 255]));
    const marked = Buffer.concat([source.slice(0, -12), metadataChunk(), source.slice(-12)]);
    assert.ok(marked.includes(Buffer.from("PRIVATE_METADATA")));
    const image = await imageRendition(marked, ".png");
    assert.equal(image.width, 1568); assert.ok(image.height <= 10);
    assert.deepEqual(Array.from(decodePng(image.data).pixels.slice(0, 4)), [1, 2, 3, 255]);
    assert.equal(Buffer.from(image.data).includes(Buffer.from("tEXt")), false);
    assert.equal(Buffer.from(image.data).includes(Buffer.from("PRIVATE_METADATA")), false);
    const bomb = Buffer.from(source); bomb.writeUInt32BE(0xffffffff, 16);
    await assert.rejects(imageRendition(bomb, ".png"), /dimensions/);
  });
  it("uses the bounded media runner for image codecs and a single video poster", async () => {
    let args: readonly string[] = [];
    const controller = new AbortController();
    const maker = createImageRenditionMaker({ run: async (command, limits) => {
      assert.equal(limits.signal, controller.signal);
      args = command; await writeFile(command.at(-1)!, encodePng(solidImage(2, 2, [1, 2, 3, 255])));
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    } });
    const result = await maker.render(new Uint8Array([1]), ".mp4", controller.signal, 2.25);
    assert.equal(decodePng(result).width, 2); assert.ok(args.includes("-map_metadata"));
    assert.equal(args[args.indexOf("-frames:v") + 1], "1");
    assert.equal(args[args.indexOf("-map") + 1], "0:v:0");
    assert.equal(args[args.indexOf("-ss") + 1], "2.25");
    assert.ok(args.indexOf("-ss") > args.indexOf("-i"));
    await assert.rejects(imageRendition(result, ".png", undefined, undefined, 2.25), /decoder/);
  });
});

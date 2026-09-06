import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComfyUiSettings, DomainEvent, Job, LedgerEntry, RecipeReadiness, RuntimeProbes } from "@arke-studio/contracts";
import { comfyUiRecoveryDecision } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";
import {
  comfyUiChildEnvironment,
  ComfyUiEngineService,
  comfyUiUrlIsLoopback,
  engineInstanceId,
  type ComfyUiRecipeFacts,
  type EngineServiceDeps,
} from "../../src/comfyui/engine.js";
import { readCustomNodeRef } from "../../src/comfyui/node-ref.js";
import { sanitizeComfyUiMedia } from "../../src/comfyui/sanitize.js";
import { verifyArtifact } from "../../src/queue/verify.js";
import { JobQueue, type EnqueueInput } from "../../src/queue/dispatcher.js";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { FakeProvider, pngBytes } from "../queue/fake-provider.js";
import type { ChildSupervisor, SupervisedSpec } from "../../src/supervisor.js";

/**
 * SPEC-021 in the coordinator: sanitisation (§2.10), the engine service (§2.2, §2.5, §2.12),
 * enqueue admission and per-source recovery in the queue (§2.11, R-16), and provenance that
 * agrees with the ledger (§2.9).
 */

const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC";

// ---------------------------------------------------------------------------
// Sanitisation (§2.10, R-14)
// ---------------------------------------------------------------------------

function crc32(_: Uint8Array): number {
  return 0; // structure is what the sanitiser reads; CRCs are opaque bytes to it
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  out.set(payload, 8);
  view.setUint32(8 + payload.length, crc32(payload));
  return out;
}

function pngWithText(): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk("IHDR", new Uint8Array(13));
  const workflow = pngChunk("tEXt", new TextEncoder().encode('prompt\0{"1":{"class_type":"KSampler"}}'));
  const international = pngChunk("iTXt", new TextEncoder().encode("workflow\0\0\0\0\0{}"));
  const idat = pngChunk("IDAT", new Uint8Array([1, 2, 3, 4]));
  const iend = pngChunk("IEND", new Uint8Array(0));
  const parts = [signature, ihdr, workflow, idat, international, iend];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32(data: Uint8Array, at: number): number {
  return ((data[at]! << 24) | (data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!) >>> 0;
}

function mp4Box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  out.set(body, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function wavBytes(): Uint8Array {
  const data = new Uint8Array(46);
  const view = new DataView(data.buffer);
  data.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, data.length - 8, true);
  data.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  data.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, 2, true);
  data.set([1, 0], 44);
  return data;
}

function flacWithComment(): Uint8Array {
  const streamBody = new Uint8Array(34);
  const streamView = new DataView(streamBody.buffer);
  streamView.setUint16(0, 16, false);
  streamView.setUint16(2, 16, false);
  const packed = (BigInt(44_100) << 44n) | (15n << 36n) | 16n;
  streamView.setUint32(10, Number(packed >> 32n), false);
  streamView.setUint32(14, Number(packed & 0xffffffffn), false);
  const streamInfo = concat(new Uint8Array([0, 0, 0, 34]), streamBody);
  const comment = new TextEncoder().encode('prompt={"graph":true}');
  const commentHead = new Uint8Array([
    0x84,
    comment.length >>> 16,
    (comment.length >>> 8) & 0xff,
    comment.length & 0xff,
  ]);
  const header = new Uint8Array([0xff, 0xf8, 0x69, 0x08, 0, 15]);
  const frameHead = concat(header, new Uint8Array([testFlacCrc8(header)]));
  const frameWithoutCrc = concat(frameHead, new Uint8Array([1, 2, 3, 4]));
  const crc = testFlacCrc16(frameWithoutCrc);
  const frame = concat(frameWithoutCrc, new Uint8Array([crc >>> 8, crc & 0xff]));
  return concat(new TextEncoder().encode("fLaC"), streamInfo, commentHead, comment, frame);
}

function testFlacCrc8(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function testFlacCrc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** An stco with one entry, pointing at `offset`. */
function stcoBox(offset: number): Uint8Array {
  const body = new Uint8Array(12);
  const view = new DataView(body.buffer);
  view.setUint32(4, 1); // entry count (version/flags at 0)
  view.setUint32(8, offset);
  return mp4Box("stco", body);
}

describe("landed media loses its embedded workflow (§2.10)", () => {
  it("png: text chunks are stripped, structure survives, and the workflow is gone", () => {
    const result = sanitizeComfyUiMedia("arke_00001_.png", pngWithText());
    assert.ok(result.ok);
    if (!result.ok) return;
    const text = new TextDecoder("latin1").decode(result.data);
    assert.equal(text.includes("KSampler"), false);
    assert.equal(text.includes("workflow"), false);
    assert.match(text, /IHDR/);
    assert.match(text, /IDAT/);
    assert.match(text, /IEND/);
    assert.ok(result.strippedBytes > 0);
  });

  it("webp: EXIF and XMP go, the RIFF size is corrected, and the VP8X flags stop lying", () => {
    const vp8x = concat(
      new TextEncoder().encode("VP8X"),
      new Uint8Array([10, 0, 0, 0]),
      new Uint8Array([0b0000_1100, 0, 0, 0, 1, 0, 0, 1, 0, 0]), // EXIF+XMP flags set
    );
    const exif = concat(
      new TextEncoder().encode("EXIF"),
      new Uint8Array([4, 0, 0, 0]),
      new TextEncoder().encode("wkfl"),
    );
    const vp8 = concat(
      new TextEncoder().encode("VP8 "),
      new Uint8Array([2, 0, 0, 0]),
      new Uint8Array([9, 9]),
      new Uint8Array([0]),
    );
    const payload = concat(new TextEncoder().encode("WEBP"), vp8x, exif, vp8);
    const header = concat(new TextEncoder().encode("RIFF"), new Uint8Array(4));
    new DataView(header.buffer).setUint32(4, payload.length, true);
    const result = sanitizeComfyUiMedia("clip.webp", concat(header, payload));
    assert.ok(result.ok);
    if (!result.ok) return;
    const text = new TextDecoder("latin1").decode(result.data);
    assert.equal(text.includes("EXIF"), false);
    assert.equal(text.includes("wkfl"), false);
    assert.match(text, /VP8X/);
    // The VP8X metadata flags are cleared to match the chunks no longer present.
    const vp8xAt = result.data.findIndex(
      (_, i) => new TextDecoder("latin1").decode(result.data.subarray(i, i + 4)) === "VP8X",
    );
    assert.equal(result.data[vp8xAt + 8]! & 0b0000_1100, 0);
    // The RIFF size covers exactly what is left.
    const riffSize = new DataView(result.data.buffer, result.data.byteOffset).getUint32(4, true);
    assert.equal(riffSize, result.data.length - 8);
  });

  it("mp4 with trailing moov: udta is dropped and the chunk offsets are untouched", () => {
    const ftyp = mp4Box("ftyp", new TextEncoder().encode("isom"));
    const mdat = mp4Box("mdat", new Uint8Array([9, 9, 9, 9]));
    const mdatDataAt = ftyp.length + 8;
    const moov = mp4Box(
      "moov",
      concat(
        mp4Box("trak", mp4Box("mdia", mp4Box("minf", mp4Box("stbl", stcoBox(mdatDataAt))))),
        mp4Box("udta", new TextEncoder().encode("ComfyUI workflow JSON here")),
      ),
    );
    const result = sanitizeComfyUiMedia("clip.mp4", concat(ftyp, mdat, moov));
    assert.ok(result.ok);
    if (!result.ok) return;
    const text = new TextDecoder("latin1").decode(result.data);
    assert.equal(text.includes("workflow"), false);
    assert.equal(text.includes("udta"), false);
    // stco still points at the mdat payload — nothing before it moved.
    const stcoAt = text.indexOf("stco");
    assert.equal(u32(result.data, stcoAt + 4 + 8), mdatDataAt);
  });

  it("mp4 with leading moov: removing metadata shifts mdat, and stco is corrected by exactly that", () => {
    const udta = mp4Box("udta", new TextEncoder().encode("prompt-graph-bytes"));
    const stblFor = (offset: number) =>
      mp4Box("trak", mp4Box("mdia", mp4Box("minf", mp4Box("stbl", stcoBox(offset)))));
    const ftyp = mp4Box("ftyp", new TextEncoder().encode("isom"));
    // Original layout: ftyp, moov(trak+udta), mdat — stco points into mdat's payload.
    const moovWith = mp4Box("moov", concat(stblFor(0), udta)); // placeholder offset, patched below
    const mdatAt = ftyp.length + moovWith.length;
    const moov = mp4Box("moov", concat(stblFor(mdatAt + 8), udta));
    const mdat = mp4Box("mdat", new Uint8Array([7, 7, 7, 7]));
    const result = sanitizeComfyUiMedia("clip.mp4", concat(ftyp, moov, mdat));
    assert.ok(result.ok);
    if (!result.ok) return;
    const text = new TextDecoder("latin1").decode(result.data);
    assert.equal(text.includes("prompt-graph"), false);
    const stcoAt = text.indexOf("stco");
    const corrected = u32(result.data, stcoAt + 4 + 8);
    // The new mdat payload position: `indexOf("mdat")` finds the TYPE string, which sits 4
    // bytes into the box, so the payload begins 4 bytes past it — everything shrank by udta.
    const newMdatAt = text.indexOf("mdat");
    assert.equal(corrected, newMdatAt + 4);
  });

  it("every track's chunk-offset table is corrected, not just the first", () => {
    // Two traks, as a video file with an audio track has. A walk that stopped at the first
    // stco would leave the second track's chunks pointing into the bytes that moved.
    const udta = mp4Box("udta", new TextEncoder().encode("prompt-graph-bytes-here"));
    const trak = (offset: number) =>
      mp4Box("trak", mp4Box("mdia", mp4Box("minf", mp4Box("stbl", stcoBox(offset)))));
    const ftyp = mp4Box("ftyp", new TextEncoder().encode("isom"));
    // Sized in two passes: the offsets must point into the real mdat payload.
    const draft = mp4Box("moov", concat(trak(0), trak(0), udta));
    const mdatAt = ftyp.length + draft.length;
    const moov = mp4Box("moov", concat(trak(mdatAt + 8), trak(mdatAt + 12), udta));
    const mdat = mp4Box("mdat", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const result = sanitizeComfyUiMedia("clip.mp4", concat(ftyp, moov, mdat));
    assert.ok(result.ok);
    if (!result.ok) return;
    const text = new TextDecoder("latin1").decode(result.data);
    assert.equal(text.includes("prompt-graph"), false);
    const newMdatPayload = text.indexOf("mdat") + 4;
    // Both tables shifted by exactly the udta's size, keeping their 4-byte separation.
    const first = text.indexOf("stco");
    const second = text.indexOf("stco", first + 1);
    assert.notEqual(second, -1, "both traks survived");
    assert.equal(u32(result.data, first + 4 + 8), newMdatPayload);
    assert.equal(u32(result.data, second + 4 + 8), newMdatPayload + 4);
  });

  it("an unknown container is refused with the container named — never landed as-is", () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
    const result = sanitizeComfyUiMedia("clip.webm", webm);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /webm\/matroska/);
    assert.match(result.reason, /refused/);
  });

  it("flac: comments are stripped and the structurally complete audio still verifies", () => {
    const result = sanitizeComfyUiMedia("voice.flac", flacWithComment());
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(new TextDecoder().decode(result.data).includes("prompt"), false);
    assert.ok(result.strippedBytes > 0);
    assert.equal(verifyArtifact({ name: "voice.flac", contentType: "audio/flac", data: result.data }), null);
  });

  it("refuses a truncated FLAC rather than landing a prefix as playable audio", () => {
    const result = sanitizeComfyUiMedia("voice.flac", new TextEncoder().encode("fLaC"));
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /bad signature|incomplete metadata|no audio/);
  });
});

// ---------------------------------------------------------------------------
// The engine service (§2.2, §2.5, §2.12)
// ---------------------------------------------------------------------------

const FACTS: ComfyUiRecipeFacts[] = [
  {
    id: "comfyui-draft-image",
    displayName: "Local · Draft Image",
    capability: "image",
    version: 1,
    minVramMb: 6000,
    minFreeVramMb: 6000,
    recommendedVramMb: 8000,
    checkpoints: [
      {
        file: "checkpoints/sd_xl_base_1.0.safetensors",
        sha256: "a".repeat(64),
        sizeMb: 6617,
        url: "https://x/",
      },
    ],
    customNodes: [],
    nodeClasses: ["KSampler", "SaveImage"],
    identity: {
      id: "comfyui-draft-image",
      version: 1,
      templateDigest: "b".repeat(64),
      dependencyDigest: "c".repeat(64),
    },
  },
];

interface FakeEngineWorld {
  files: Set<string>;
  hashes: Map<string, string>;
  fetches: string[];
  spawned: SupervisedSpec[];
  urls: Map<string, { version?: string; devices?: unknown[] }>;
  nodeRefs: Map<string, string | null>;
  objectInfoUnavailable: boolean;
}

function engineDeps(
  world: FakeEngineWorld,
  appRoot: string,
  recipes: readonly ComfyUiRecipeFacts[] = FACTS,
): EngineServiceDeps {
  let processEpoch = 0;
  return {
    appRoot,
    recipes,
    fetch: async (url) => {
      world.fetches.push(url);
      if (url === "http://127.0.0.1:51999/system_stats") {
        return new Response(JSON.stringify({ system: { comfyui_version: "0.33.1" } }), { status: 200 });
      }
      if (url === "http://127.0.0.1:51999/object_info") {
        if (world.objectInfoUnavailable) throw new Error("object info unavailable");
        return new Response(JSON.stringify({ KSampler: {}, SaveImage: {} }), { status: 200 });
      }
      for (const [base, behaviour] of world.urls) {
        if (url.startsWith(base)) {
          if (url.endsWith("/system_stats")) {
            return new Response(
              JSON.stringify({
                system: { comfyui_version: behaviour.version ?? "0.33.1" },
                ...(behaviour.devices !== undefined ? { devices: behaviour.devices } : {}),
              }),
              { status: 200 },
            );
          }
          if (url.endsWith("/object_info")) {
            if (world.objectInfoUnavailable) throw new Error("object info unavailable");
            return new Response(JSON.stringify({ KSampler: {}, SaveImage: {} }), { status: 200 });
          }
        }
      }
      throw new Error(`ECONNREFUSED ${url}`);
    },
    fileExists: async (path) => world.files.has(path.replaceAll("\\", "/")),
    // Derived from the same file set, so a nested layout in the fake behaves like one on disk.
    listDirectories: async (path) => {
      const prefix = `${path.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
      const names = new Set<string>();
      for (const file of world.files) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const head = rest.split("/")[0];
        if (head !== undefined && rest.includes("/")) names.add(head);
      }
      return [...names];
    },
    hashFile: async (path) => world.hashes.get(path.replaceAll("\\", "/")) ?? null,
    writeTextFile: async () => {},
    readNodeRef: async (path) => world.nodeRefs.get(path.replaceAll("\\", "/")) ?? null,
    createSupervisor: (spec) => {
      world.spawned.push(spec);
      const fake = {
        status: "healthy" as const,
        port: 51999,
        reason: undefined,
        on: () => fake,
        off: () => fake,
        start: async () => {},
        stop: async () => {},
      };
      return fake as unknown as ChildSupervisor;
    },
    registerSupervisorExitBackstop: () => () => {},
    createProcessEpoch: () => `process-${++processEpoch}`,
    homeDir: "C:/Users/nadia",
  };
}

function fakeWorld(): FakeEngineWorld {
  return {
    files: new Set(),
    hashes: new Map(),
    fetches: [],
    spawned: [],
    urls: new Map(),
    nodeRefs: new Map(),
    objectInfoUnavailable: false,
  };
}

const NO_SETTINGS: ComfyUiSettings = { enginePath: null, engineUrl: null, modelsDir: null };
const PROBES: RuntimeProbes = { vramMb: 10240, memMb: 32000, diskFreeMb: 100000 };

describe("the engine service resolves, probes, and never spawns a URL (§2.2, D13)", () => {
  it("absent when nothing is configured and nothing is found, with detection offers when they exist", async () => {
    const world = fakeWorld();
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings(NO_SETTINGS);
    assert.equal(service.engineStatus().source, "absent");
    assert.equal(service.engineStatus().state, "absent");
    assert.equal(service.baseUrl(), null);
    assert.equal(await service.externallySelected(), false);

    // A well-known folder holding an install becomes an offer, not an installation.
    world.files.add("C:/Users/nadia/ComfyUI/main.py");
    await service.applySettings(NO_SETTINGS);
    const detected = service.engineStatus().detected;
    assert.equal(detected.length, 1);
    assert.match(detected[0]!.location, /ComfyUI/);
    assert.equal(await service.externallySelected(), false, "an offer is not an externally selected engine");
    assert.equal(world.spawned.length, 0, "detection never spawns");
  });

  it("a user URL is probed, never spawned, and its version decides compatibility (D14)", async () => {
    const world = fakeWorld();
    world.urls.set("http://127.0.0.1:8188", { version: "0.33.1" });
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({ enginePath: null, engineUrl: "http://127.0.0.1:8188", modelsDir: null });
    const status = service.engineStatus();
    assert.equal(status.source, "user-url");
    assert.equal(status.state, "ready");
    assert.equal(status.version, "0.33.1");
    assert.equal(status.locality, "local");
    assert.equal(world.spawned.length, 0, "a URL is never spawned (D13)");
    assert.equal(service.baseUrl(), "http://127.0.0.1:8188");

    world.urls.set("http://127.0.0.1:8188", { version: "0.2.2" });
    await service.applySettings({ enginePath: null, engineUrl: "http://127.0.0.1:8188", modelsDir: null });
    const old = service.engineStatus();
    assert.equal(old.state, "incompatible");
    assert.match(old.detail!, /0\.2\.2/);
    assert.equal(service.baseUrl(), null, "an incompatible engine is not dispatched to");
  });

  it("Check now reconnects a URL that became available after its first probe", async () => {
    const world = fakeWorld();
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({ enginePath: null, engineUrl: "http://127.0.0.1:8188", modelsDir: null });
    assert.equal(service.engineStatus().state, "unreachable");

    world.urls.set("http://127.0.0.1:8188", { version: "0.33.1" });
    await service.checkNow();

    assert.equal(service.engineStatus().state, "ready");
    assert.equal(service.baseUrl(), "http://127.0.0.1:8188");
    await service.dispose();
  });

  it("Check now repeats discovery when ComfyUI starts after Arke", async () => {
    const world = fakeWorld();
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings(NO_SETTINGS);
    assert.deepEqual(service.engineStatus().detected, []);

    world.urls.set("http://127.0.0.1:8188", { version: "0.33.1" });
    await service.checkNow();

    assert.deepEqual(service.engineStatus().detected, [
      { location: "http://127.0.0.1:8188", version: "0.33.1" },
    ]);
    await service.dispose();
  });

  it("keeps the nested transport code when a probe fails", async () => {
    const world = fakeWorld();
    const deps = engineDeps(world, "C:/app");
    deps.fetch = async () => {
      const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
      throw new TypeError("fetch failed", { cause: socket });
    };
    const service = new ComfyUiEngineService(deps);

    await service.applySettings({ enginePath: null, engineUrl: "http://127.0.0.1:8188", modelsDir: null });

    assert.match(service.engineStatus().detail ?? "", /TypeError: fetch failed \[UND_ERR_SOCKET\]/);
    await service.dispose();
  });

  it("classifies a non-loopback URL as remote", async () => {
    const world = fakeWorld();
    world.urls.set("http://10.0.0.4:8188", { version: "0.33.1" });
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({ enginePath: null, engineUrl: "http://10.0.0.4:8188", modelsDir: null });
    assert.equal(service.engineStatus().locality, "remote");
    assert.equal(service.engineIdentity()?.locality, "remote");
  });

  it("classifies exact localhost as local throughout the engine identity", async () => {
    const url = "http://localhost:8188";
    const world = fakeWorld();
    world.urls.set(url, { version: "0.33.1" });
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({ enginePath: null, engineUrl: url, modelsDir: null });
    assert.equal(service.engineStatus().locality, "local");
    assert.equal(service.engineIdentity()?.locality, "local");
    assert.equal(service.voiceUploadDestination(), null);
  });

  it("trusts only exact loopback hosts", () => {
    for (const url of [
      "http://127.0.0.1:8188",
      "http://[::1]:8188",
      "http://localhost:8188",
      "HTTP://LOCALHOST:8188",
      "http://user@localhost:8188",
    ]) {
      assert.equal(comfyUiUrlIsLoopback(url), true, url);
    }
    for (const url of [
      "http://localhost.:8188",
      "http://localhost.example:8188",
      "http://localhost@evil.example:8188",
      "http://127.0.0.2:8188",
      "http://127.attacker.example:8188",
      "http://2130706433:8188",
      "http://0x7f000001:8188",
      "http://127.1:8188",
      "http://[0:0:0:0:0:0:0:1]:8188",
      "http://[::ffff:127.0.0.1]:8188",
      "http://10.0.0.4:8188",
    ]) {
      assert.equal(comfyUiUrlIsLoopback(url), false, url);
    }
  });

  it("names a remote voice destination without exposing URL credentials or request data", async () => {
    const world = fakeWorld();
    const url = "https://voice-user:voice-secret@127.attacker.example:8443/private?token=request-secret";
    world.urls.set("https://voice-user:voice-secret@127.attacker.example:8443", { version: "0.33.1" });
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({ enginePath: null, engineUrl: url, modelsDir: null });
    const destination = service.voiceUploadDestination();
    assert.equal(destination?.label, "127.attacker.example:8443");
    assert.equal(destination?.token, service.instanceId());
    assert.equal(JSON.stringify(destination).includes("voice-secret"), false);
    assert.equal(JSON.stringify(destination).includes("request-secret"), false);
    assert.equal(JSON.stringify(destination).includes("/private"), false);
  });

  it("does not apply this machine's GPU probes to a remote engine", async () => {
    const world = fakeWorld();
    world.urls.set("http://10.0.0.4:8188", {
      version: "0.33.1",
      devices: [{ type: "cuda", vram_total: 10240 * 1024 * 1024, torch_vram_total: 8002 * 1024 * 1024 }],
    });
    world.files.add("C:/models/checkpoints/sd_xl_base_1.0.safetensors");
    world.hashes.set("C:/models/checkpoints/sd_xl_base_1.0.safetensors", "a".repeat(64));
    let freeReads = 0;
    const service = new ComfyUiEngineService({
      ...engineDeps(world, "C:/app"),
      freeVramMb: async () => {
        freeReads += 1;
        return 360;
      },
    });
    await service.applySettings({
      enginePath: null,
      engineUrl: "http://10.0.0.4:8188",
      modelsDir: "C:/models",
    });
    const recipe = (await service.status({ vramMb: 4096, memMb: 32000, diskFreeMb: 1000 })).recipes[0]!;
    assert.equal(recipe.state, "unknown");
    assert.match(recipe.reason ?? "", /Remote engine VRAM could not be measured/);
    assert.doesNotMatch(recipe.reason ?? "", /This machine has/);
    assert.equal(freeReads, 0, "neither local GPU reading is applied to a remote engine");
  });

  it("a user path with the portable layout is spawned and supervised with metadata disabled", async () => {
    const world = fakeWorld();
    world.files.add("C:/AI/ComfyUI/python_embeded/python.exe");
    world.files.add("C:/AI/ComfyUI/ComfyUI/main.py");
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({ enginePath: "C:\\AI\\ComfyUI", engineUrl: null, modelsDir: null });
    assert.equal(world.spawned.length, 1);
    const spec = world.spawned[0]!;
    assert.match(spec.command!, /python\.exe$/);
    assert.ok(spec.args!.includes("--disable-metadata"), "defence in depth even though landing sanitises");
    assert.ok(spec.args!.includes("--listen"));
    assert.equal(spec.inheritEnv, false);
    assert.equal(spec.env?.["HF_HUB_OFFLINE"], "1");
    assert.equal(spec.env?.["OPENAI_API_KEY"], undefined);
    assert.equal(service.engineStatus().state, "ready");
    assert.equal(service.baseUrl(), "http://127.0.0.1:51999");
  });

  it("publishes when a supervised engine's reclaimable reservation changes", async () => {
    const world = fakeWorld();
    world.files.add("C:/AI/ComfyUI/python_embeded/python.exe");
    world.files.add("C:/AI/ComfyUI/ComfyUI/main.py");
    world.files.add("C:/AI/ComfyUI/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors");
    world.hashes.set(
      "C:/AI/ComfyUI/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors",
      "a".repeat(64),
    );
    let holdFreeReading = false;
    let announceFreeReading!: () => void;
    const freeReadingStarted = new Promise<void>((resolve) => {
      announceFreeReading = resolve;
    });
    let releaseFreeReading!: () => void;
    const freeReadingHeld = new Promise<void>((resolve) => {
      releaseFreeReading = resolve;
    });
    const service = new ComfyUiEngineService({
      ...engineDeps(world, "C:/app"),
      freeVramMb: async () => {
        if (holdFreeReading) {
          announceFreeReading();
          await freeReadingHeld;
        }
        return 360;
      },
    });
    await service.applySettings({ enginePath: "C:/AI/ComfyUI", engineUrl: null, modelsDir: null });
    const validateHealth = world.spawned[0]!.validateHealth!;
    let publications = 0;
    service.subscribe(() => {
      publications += 1;
    });

    await validateHealth(new Response(JSON.stringify({
      system: { comfyui_version: "0.33.1" },
      devices: [{ type: "cuda", vram_total: 10240 * 1024 * 1024, torch_vram_total: 8002 * 1024 * 1024 }],
    })));
    assert.equal((await service.status(PROBES)).recipes[0]!.state, "ready");

    holdFreeReading = true;
    const statusDuringChange = service.status(PROBES);
    await freeReadingStarted;
    await validateHealth(new Response(JSON.stringify({
      system: { comfyui_version: "0.33.1" },
      devices: [{ type: "cuda", vram_total: 10240 * 1024 * 1024, torch_vram_total: 0 }],
    })));
    holdFreeReading = false;
    releaseFreeReading();
    assert.equal(publications, 1, "healthy-to-healthy measurement changes are observable");
    assert.equal(
      (await statusDuringChange).recipes[0]!.state,
      "disabled",
      "an older in-flight snapshot cannot overwrite the changed reading",
    );
  });

  it("changes process identity when a spawned child restarts at the same filesystem location", async () => {
    const world = fakeWorld();
    world.files.add("C:/AI/ComfyUI/python_embeded/python.exe");
    world.files.add("C:/AI/ComfyUI/ComfyUI/main.py");
    const deps = engineDeps(world, "C:/app");
    let emitStatus: (() => void) | null = null;
    let status: "starting" | "healthy" | "unhealthy" = "healthy";
    let spawnEpoch = 1;
    deps.createSupervisor = (spec) => {
      world.spawned.push(spec);
      const fake = {
        get status() {
          return status;
        },
        get spawnEpoch() {
          return spawnEpoch;
        },
        port: 51999,
        reason: undefined,
        on: (_event: string, listener: () => void) => {
          emitStatus = listener;
          return fake;
        },
        off: () => fake,
        start: async () => {
          status = "starting";
          emitStatus?.();
          status = "healthy";
          emitStatus?.();
        },
        stop: async () => {},
      };
      return fake as unknown as ChildSupervisor;
    };
    const service = new ComfyUiEngineService(deps);
    await service.applySettings({ enginePath: "C:/AI/ComfyUI", engineUrl: null, modelsDir: null });
    const first = service.engineIdentity();
    assert.equal(first?.source, "user-path");
    assert.ok(first?.processEpoch);

    status = "unhealthy";
    const notify = emitStatus as (() => void) | null;
    notify?.();
    spawnEpoch = 2;
    status = "starting";
    notify?.();
    const replacement = service.engineIdentity();
    assert.equal(replacement?.instanceId, first?.instanceId, "the location identity stays stable");
    assert.notEqual(replacement?.processEpoch, first?.processEpoch, "the replacement process is distinct");
    await service.dispose();
  });

  it("disposal removes the supervisor listener and process-exit backstop before stopping it", async () => {
    const world = fakeWorld();
    world.files.add("C:/AI/ComfyUI/python_embeded/python.exe");
    world.files.add("C:/AI/ComfyUI/ComfyUI/main.py");
    const calls: string[] = [];
    const deps = engineDeps(world, "C:/app");
    deps.createSupervisor = (spec) => {
      world.spawned.push(spec);
      const fake = {
        status: "healthy" as const,
        port: 51999,
        reason: undefined,
        on: () => fake,
        off: () => {
          calls.push("off");
          return fake;
        },
        start: async () => {},
        stop: async () => {
          calls.push("stop");
        },
      };
      return fake as unknown as ChildSupervisor;
    };
    deps.registerSupervisorExitBackstop = () => () => calls.push("backstop");
    const service = new ComfyUiEngineService(deps);
    await service.applySettings({ enginePath: "C:/AI/ComfyUI", engineUrl: null, modelsDir: null });
    await service.dispose();
    assert.deepEqual(calls, ["backstop", "off", "stop"]);
  });

  it("joins a paused settings write and cannot start a supervisor after disposal", async () => {
    const world = fakeWorld();
    world.files.add("C:/AI/ComfyUI/python_embeded/python.exe");
    world.files.add("C:/AI/ComfyUI/ComfyUI/main.py");
    const deps = engineDeps(world, "C:/app");
    let writeStarted!: () => void;
    const writing = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writePaused = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    deps.writeTextFile = async () => {
      writeStarted();
      await writePaused;
    };
    let starts = 0;
    deps.createSupervisor = (spec) => {
      world.spawned.push(spec);
      const fake = {
        status: "healthy" as const,
        port: 51999,
        reason: undefined,
        on: () => fake,
        off: () => fake,
        start: async () => {
          starts += 1;
        },
        stop: async () => {},
      };
      return fake as unknown as ChildSupervisor;
    };
    const service = new ComfyUiEngineService(deps);
    const applying = service.applySettings({
      enginePath: "C:/AI/ComfyUI",
      engineUrl: null,
      modelsDir: "C:/models",
    });
    await writing;

    let disposeSettled = false;
    const disposing = service.dispose().finally(() => {
      disposeSettled = true;
    });
    await Promise.resolve();
    const settledBeforeWrite = disposeSettled;
    releaseWrite();
    await Promise.all([applying, disposing]);

    assert.equal(settledBeforeWrite, false, "dispose joins the serialized settings pass");
    assert.equal(world.spawned.length, 0, "the paused continuation never creates a supervisor");
    assert.equal(starts, 0);
    assert.equal(service.baseUrl(), null);
    assert.equal(service.engineStatus().source, "absent");
  });

  it("finds the managed engine inside the archive's wrapper folder, where the installer put it", async () => {
    // The bug this closes: the tree installer accepts its marker one level deep, because the
    // upstream 7z wraps everything in ComfyUI_windows_portable/. Resolution only looked at the
    // root, so a freshly installed managed engine resolved as absent — setup would offer the
    // 2 GB download again on every launch and the engine could never start.
    const world = fakeWorld();
    world.files.add("C:/app/comfyui-runtime/ComfyUI_windows_portable/python_embeded/python.exe");
    world.files.add("C:/app/comfyui-runtime/ComfyUI_windows_portable/ComfyUI/main.py");
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings(NO_SETTINGS);
    const status = service.engineStatus();
    assert.equal(status.source, "managed");
    assert.equal(status.state, "ready");
    assert.equal(world.spawned.length, 1, "and it is actually launched");
    // The models folder must follow the real base, not the wrapper — one resolver, one answer.
    assert.equal(
      service.modelsDir()?.replaceAll("\\", "/"),
      "C:/app/comfyui-runtime/ComfyUI_windows_portable/ComfyUI/models",
    );
  });

  it("a user pointing at the wrapper folder gets the same answer as pointing inside it", async () => {
    const world = fakeWorld();
    world.files.add("C:/AI/portable/python_embeded/python.exe");
    world.files.add("C:/AI/portable/ComfyUI/main.py");
    const outer = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await outer.applySettings({ enginePath: "C:/AI", engineUrl: null, modelsDir: null });
    const inner = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await inner.applySettings({ enginePath: "C:/AI/portable", engineUrl: null, modelsDir: null });
    assert.equal(outer.engineStatus().state, "ready");
    assert.equal(inner.engineStatus().state, "ready");
    assert.equal(outer.modelsDir(), inner.modelsDir());
  });

  it("a bare install with no interpreter fails with the remedy, not a spawn error", async () => {
    const world = fakeWorld();
    world.files.add("C:/AI/ComfyUI/main.py");
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({ enginePath: "C:\\AI\\ComfyUI", engineUrl: null, modelsDir: null });
    const status = service.engineStatus();
    assert.equal(status.state, "failed");
    assert.match(status.detail!, /point Settings at its URL/);
    assert.equal(world.spawned.length, 0);
  });

  it("instance identity is an opaque digest, stable under trailing-slash and case noise", () => {
    assert.equal(
      engineInstanceId("user-path", "C:\\AI\\ComfyUI\\"),
      engineInstanceId("user-path", "c:\\ai\\comfyui"),
    );
    assert.notEqual(
      engineInstanceId("user-path", "C:\\AI\\ComfyUI"),
      engineInstanceId("user-url", "C:\\AI\\ComfyUI"),
    );
    assert.doesNotMatch(engineInstanceId("user-path", "C:\\AI\\ComfyUI"), /comfyui/i);
  });

  it("keeps case-sensitive URL paths, queries, and credentials in the opaque identity", () => {
    const id = (url: string): string => engineInstanceId("user-url", url);
    assert.notEqual(id("https://voice.example/EngineA"), id("https://voice.example/enginea"));
    assert.notEqual(
      id("https://voice.example/EngineA?workspace=North"),
      id("https://voice.example/EngineA?workspace=north"),
    );
    assert.notEqual(
      id("https://voice-user:first@voice.example/EngineA"),
      id("https://voice-user:second@voice.example/EngineA"),
    );
    assert.equal(
      id("HTTPS://VOICE.EXAMPLE:443/EngineA?workspace=North"),
      id("https://voice.example/EngineA?workspace=North"),
      "scheme, host, and an explicit default port are safe to canonicalise",
    );
  });
});

describe("pre-flight names the file and both digests (§2.5, R-9)", () => {
  async function serviceAt(world: FakeEngineWorld): Promise<ComfyUiEngineService> {
    world.files.add("C:/AI/ComfyUI/python_embeded/python.exe");
    world.files.add("C:/AI/ComfyUI/ComfyUI/main.py");
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({ enginePath: "C:/AI/ComfyUI", engineUrl: null, modelsDir: null });
    return service;
  }

  it("a missing checkpoint refuses naming the file", async () => {
    const service = await serviceAt(fakeWorld());
    const verdict = await service.preflight("comfyui-draft-image");
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.match(verdict.reason, /sd_xl_base_1\.0\.safetensors is missing/);
  });

  it("a digest mismatch refuses naming expected and found (R-9's exact demand)", async () => {
    const world = fakeWorld();
    const service = await serviceAt(world);
    const file = "C:/AI/ComfyUI/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors";
    world.files.add(file);
    world.hashes.set(file, "9d41c8".padEnd(64, "f"));
    const verdict = await service.preflight("comfyui-draft-image");
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.match(verdict.reason, /expected sha256 aaaaaaaa/);
    assert.match(verdict.reason, /found sha256 9d41c8ff/);

    // The verdict is what readiness reports until re-verified (§2.5 → §2.12).
    const status = await service.status(PROBES);
    const recipe = status.recipes[0]!;
    assert.equal(recipe.state, "disabled");
    assert.match(recipe.reason!, /does not match its pinned version/);
  });

  it("a matching file dispatches, and the readiness verdict clears", async () => {
    const world = fakeWorld();
    const service = await serviceAt(world);
    const file = "C:/AI/ComfyUI/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors";
    world.files.add(file);
    world.hashes.set(file, "a".repeat(64));
    assert.deepEqual(await service.preflight("comfyui-draft-image"), { ok: true });
    const status = await service.status(PROBES);
    assert.equal(status.recipes[0]!.state, "ready");
  });

  it("fails closed when the engine changes while a checkpoint is being hashed", async () => {
    const world = fakeWorld();
    const file = "C:/models/checkpoints/sd_xl_base_1.0.safetensors";
    world.files.add(file);
    world.urls.set("http://127.0.0.1:8188", {});
    world.urls.set("http://127.0.0.1:8189", {});
    let releaseHash!: () => void;
    const hashing = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    const deps = engineDeps(world, "C:/app");
    deps.hashFile = async () => {
      await hashing;
      return "a".repeat(64);
    };
    const service = new ComfyUiEngineService(deps);
    await service.applySettings({
      enginePath: null,
      engineUrl: "http://127.0.0.1:8188",
      modelsDir: "C:/models",
    });
    const preflight = service.preflight("comfyui-draft-image");
    const switched = service.applySettings({
      enginePath: null,
      engineUrl: "http://127.0.0.1:8189",
      modelsDir: "C:/models",
    });
    releaseHash();
    const verdict = await preflight;
    await switched;
    assert.equal(verdict.ok, false);
    if (!verdict.ok)
      assert.match(verdict.reason, /engine (changed during dependency verification|lifecycle changed)/);
  });

  it("cancels a long checkpoint scan on disposal instead of holding shutdown open", async () => {
    const world = fakeWorld();
    const file = "C:/AI/ComfyUI/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors";
    world.files.add(file);
    let aborted = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const deps = engineDeps(world, "C:/app");
    deps.hashFile = (_path, signal) =>
      new Promise((resolve) => {
        markStarted();
        if (signal?.aborted) {
          aborted = true;
          resolve(null);
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve(null);
          },
          { once: true },
        );
      });
    world.files.add("C:/AI/ComfyUI/python_embeded/python.exe");
    world.files.add("C:/AI/ComfyUI/ComfyUI/main.py");
    const service = new ComfyUiEngineService(deps);
    await service.applySettings({ enginePath: "C:/AI/ComfyUI", engineUrl: null, modelsDir: null });
    const scan = service.preflight("comfyui-draft-image");
    await started;
    await service.dispose();
    const verdict = await scan;
    assert.equal(aborted, true);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.reason, /verification was stopped/);
  });

  it("Re-verify refreshes node classes as well as dependency hashes", async () => {
    const world = fakeWorld();
    const service = await serviceAt(world);
    const file = "C:/AI/ComfyUI/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors";
    world.files.add(file);
    world.hashes.set(file, "a".repeat(64));
    assert.equal((await service.status(PROBES)).recipes[0]!.state, "ready");

    world.objectInfoUnavailable = true;
    await service.reverify(["comfyui-draft-image"]);
    const unavailable = await service.status(PROBES);
    assert.equal(unavailable.recipes[0]!.state, "disabled");
    assert.match(unavailable.recipes[0]!.reason!, /node catalogue could not be verified/);

    world.objectInfoUnavailable = false;
    await service.reverify(["comfyui-draft-image"]);
    assert.equal((await service.status(PROBES)).recipes[0]!.state, "ready");
    assert.equal(world.spawned.length, 1, "re-verification did not restart the active engine");
  });

  it("lets a manual Re-verify bypass a persistent digest receipt", async () => {
    const world = fakeWorld();
    const file = "C:/AI/ComfyUI/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors";
    world.files.add("C:/AI/ComfyUI/python_embeded/python.exe");
    world.files.add("C:/AI/ComfyUI/ComfyUI/main.py");
    world.files.add(file);
    world.hashes.set(file, "a".repeat(64));
    const deps = engineDeps(world, "C:/app");
    const hashFile = deps.hashFile;
    const forced: Array<boolean | undefined> = [];
    deps.hashFile = async (path, signal, force) => {
      forced.push(force);
      return hashFile(path, signal, force);
    };
    const service = new ComfyUiEngineService(deps);
    await service.applySettings({ enginePath: "C:/AI/ComfyUI", engineUrl: null, modelsDir: null });

    await service.reverify(["comfyui-draft-image"], true);

    assert.deepEqual(forced, [true]);
  });

  it("an unreadable custom-node identity fails closed, and an exact clean identity passes", async () => {
    const nodeRecipe: ComfyUiRecipeFacts = {
      ...FACTS[0]!,
      id: "node-recipe",
      checkpoints: [],
      customNodes: [{ id: "PinnedNode", pinnedRef: "d".repeat(40) }],
      nodeClasses: [],
      identity: { ...FACTS[0]!.identity, id: "node-recipe" },
    };
    const world = fakeWorld();
    world.files.add("C:/AI/ComfyUI/python_embeded/python.exe");
    world.files.add("C:/AI/ComfyUI/ComfyUI/main.py");
    const nodeDir = "C:/AI/ComfyUI/ComfyUI/custom_nodes/PinnedNode";
    world.files.add(nodeDir);
    world.nodeRefs.set(nodeDir, "d".repeat(40));
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app", [nodeRecipe]));
    await service.applySettings({ enginePath: "C:/AI/ComfyUI", engineUrl: null, modelsDir: null });

    world.nodeRefs.set(nodeDir, null);
    const unreadable = await service.preflight("node-recipe");
    assert.equal(unreadable.ok, false);
    if (!unreadable.ok) assert.match(unreadable.reason, /identity could not be read; it is unverified/);
    assert.equal((await service.status(PROBES)).recipes[0]!.state, "disabled");

    world.nodeRefs.set(nodeDir, "d".repeat(40));
    assert.deepEqual(await service.preflight("node-recipe"), { ok: true });
    assert.equal((await service.status(PROBES)).recipes[0]!.state, "ready");
  });

  it("a known-incomplete dependency closure is unavailable even when the engine answers", async () => {
    const recipe: ComfyUiRecipeFacts = {
      ...FACTS[0]!,
      id: "blocked-recipe",
      checkpoints: [],
      customNodes: [],
      nodeClasses: [],
      unavailableReason: "immutable model artifacts are unavailable",
      identity: { ...FACTS[0]!.identity, id: "blocked-recipe" },
    };
    const world = fakeWorld();
    world.urls.set("http://10.0.0.4:8188", {});
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app", [recipe]));
    await service.applySettings({ enginePath: null, engineUrl: "http://127.0.0.1:8188", modelsDir: null });
    const status = await service.status(PROBES);
    assert.equal(status.recipes[0]!.state, "disabled");
    assert.equal(status.recipes[0]!.reason, "immutable model artifacts are unavailable");
    assert.deepEqual(await service.preflight("blocked-recipe"), {
      ok: false,
      reason: "immutable model artifacts are unavailable",
      // The walk declares which step refused (SPEC-032 R-20): a catalogue refusal, not a file's.
      reasonKind: "catalogue",
    });
  });
});

describe("custom-node content identity", () => {
  const COMMIT = "dedd982ab999633d5296c3e5a152ef772941fb82";

  it("accepts only a full immutable identity written by verified setup", async () => {
    const dir = await tempDir("arke-node-ref-");
    await writeFile(join(dir, ".arke-content-id"), `${COMMIT}\n`);
    assert.equal(await readCustomNodeRef(dir), COMMIT);
  });

  it("rejects missing, malformed and non-commit identity markers", async () => {
    const dir = await tempDir("arke-node-ref-");
    assert.equal(await readCustomNodeRef(dir), null);
    await writeFile(join(dir, ".arke-content-id"), "main\n");
    assert.equal(await readCustomNodeRef(dir), null);
    await writeFile(join(dir, ".arke-content-id"), `${COMMIT}extra\n`);
    assert.equal(await readCustomNodeRef(dir), null);
  });
});

describe("the managed child environment", () => {
  it("allow-lists runtime variables, strips credentials, and disables model-network fallbacks", () => {
    const env = comfyUiChildEnvironment({
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      TEMP: "C:\\Temp",
      OPENAI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      HTTP_PROXY: "http://credentialled-proxy.invalid",
    });
    assert.deepEqual(
      { SystemRoot: env["SystemRoot"], PATH: env["PATH"], TEMP: env["TEMP"] },
      { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", TEMP: "C:\\Temp" },
    );
    assert.equal(env["OPENAI_API_KEY"], undefined);
    assert.equal(env["AWS_SECRET_ACCESS_KEY"], undefined);
    assert.equal(env["HTTP_PROXY"], undefined);
    assert.equal(env["PYTHONNOUSERSITE"], "1");
    assert.equal(env["HF_HUB_OFFLINE"], "1");
  });
});

describe("readiness is one ladder with a specific reason on every rung (§2.12, R-10)", () => {
  it("URL engine without a mapped models folder: disabled with verification stated unavailable (D13)", async () => {
    const world = fakeWorld();
    world.urls.set("http://10.0.0.4:8188", {});
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({ enginePath: null, engineUrl: "http://10.0.0.4:8188", modelsDir: null });
    const status = await service.status(PROBES);
    assert.equal(status.recipes[0]!.state, "disabled");
    assert.match(status.recipes[0]!.reason!, /cannot verify this engine's files/);
    assert.doesNotMatch(
      status.recipes[0]!.reason!,
      /missing/,
      "never wording that implies the files are merely missing",
    );
  });

  it("fails closed when the engine's node catalogue cannot be read", async () => {
    const world = fakeWorld();
    world.urls.set("http://127.0.0.1:8188", {});
    world.files.add("C:/models/checkpoints/sd_xl_base_1.0.safetensors");
    world.hashes.set("C:/models/checkpoints/sd_xl_base_1.0.safetensors", "a".repeat(64));
    world.objectInfoUnavailable = true;
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({
      enginePath: null,
      engineUrl: "http://127.0.0.1:8188",
      modelsDir: "C:/models",
    });
    const status = await service.status(PROBES);
    assert.equal(status.recipes[0]!.state, "disabled");
    assert.match(status.recipes[0]!.reason!, /node catalogue could not be verified/);
  });

  it("VRAM below the floor: both figures and the cloud alternative; unknown stays unknown and dispatchable (D15)", async () => {
    const world = fakeWorld();
    world.urls.set("http://localhost:8188", {});
    world.files.add("C:/models/checkpoints/sd_xl_base_1.0.safetensors");
    world.hashes.set("C:/models/checkpoints/sd_xl_base_1.0.safetensors", "a".repeat(64));
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({
      enginePath: null,
      engineUrl: "http://localhost:8188",
      modelsDir: "C:/models",
    });

    const small = await service.status({ vramMb: 4096, memMb: 32000, diskFreeMb: 1000 });
    assert.equal(small.recipes[0]!.state, "disabled");
    assert.match(small.recipes[0]!.reason!, /Needs 6 GB VRAM\. This machine has 4 GB\./);

    const unknown = await service.status({ vramMb: null, memMb: 32000, diskFreeMb: 1000 });
    assert.equal(unknown.recipes[0]!.state, "unknown");
    // Whole sentence, not a match: the local branch of this string spent a release reading
    // "VRAM VRAM could not be measured", the word arriving once from the locality ternary and
    // once from the literal after it. A substring assertion cannot see a duplicate it sits
    // inside, which is why the old regex here passed throughout (issue 687).
    assert.equal(
      unknown.recipes[0]!.reason,
      "VRAM could not be measured. The 6 GB floor was not checked.",
    );
  });

  /**
   * A card big enough and busy anyway (SPEC-022 §2.6).
   *
   * Checking only the total is what let a 10 GB machine read "ready" and then page to disk for
   * half an hour. But raw free memory counts the engine's own resident model against us, and
   * dispatch unloads that before giving up — so readiness measures that reclaim where the engine
   * reports it, retaining the old allowance only as a compatibility fallback.
   */
  async function readiness(freeMb: number | null, devices?: unknown[]): Promise<string> {
    const world = fakeWorld();
    world.urls.set("http://127.0.0.1:8188", { devices });
    world.files.add("C:/models/checkpoints/sd_xl_base_1.0.safetensors");
    world.hashes.set("C:/models/checkpoints/sd_xl_base_1.0.safetensors", "a".repeat(64));
    const service = new ComfyUiEngineService({
      ...engineDeps(world, "C:/app"),
      freeVramMb: async () => freeMb,
    });
    await service.applySettings({
      enginePath: null,
      engineUrl: "http://127.0.0.1:8188",
      modelsDir: "C:/models",
    });
    const status = await service.status({ vramMb: 10240, memMb: 32000, diskFreeMb: 1000 });
    return `${status.recipes[0]!.state}|${status.recipes[0]!.reason ?? ""}`;
  }

  it("uses the local engine's measured PyTorch reservation instead of understating its reclaim (#775)", async () => {
    const warmEngine = [{
      type: "cuda",
      vram_total: 10240 * 1024 * 1024,
      torch_vram_total: 8002 * 1024 * 1024,
    }];
    assert.equal((await readiness(360, warmEngine)).startsWith("ready|"), true);
  });

  it("keeps a measured zero authoritative when another program really owns the card (#775)", async () => {
    const coldEngine = [{ type: "cuda", vram_total: 10240 * 1024 * 1024, torch_vram_total: 0 }];
    const busy = await readiness(360, coldEngine);
    assert.equal(busy.startsWith("disabled|"), true);
    assert.match(busy, /Needs 6 GB free/);
  });

  it("reads only the primary CUDA device and falls back for malformed measurements", async () => {
    const primaryCold = [
      { type: "cuda", vram_total: 10240 * 1024 * 1024, torch_vram_total: 0 },
      { type: "cuda", vram_total: 10240 * 1024 * 1024, torch_vram_total: 8002 * 1024 * 1024 },
    ];
    assert.equal((await readiness(360, primaryCold)).startsWith("disabled|"), true);
    assert.equal(
      (await readiness(2048, [{ type: "cuda", torch_vram_total: -1 }])).startsWith("ready|"),
      true,
      "a malformed field retains the compatibility allowance",
    );
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    assert.equal(
      (await readiness(0, [{ type: "cuda", vram_total: unsafe, torch_vram_total: unsafe }])).startsWith("disabled|"),
      true,
      "implausible counters cannot advertise unlimited reclaim",
    );
  });

  it("converts the engine's byte count to whole MiB without rounding up", async () => {
    const total = 10240 * 1024 * 1024;
    const justUnderOneMiB = [{ type: "cuda", vram_total: total, torch_vram_total: 1024 * 1024 - 1 }];
    const exactlyOneMiB = [{ type: "cuda", vram_total: total, torch_vram_total: 1024 * 1024 }];
    assert.equal((await readiness(5999, justUnderOneMiB)).startsWith("disabled|"), true);
    assert.equal((await readiness(5999, exactlyOneMiB)).startsWith("ready|"), true);
  });

  it("refuses only a card no amount of unloading could rescue", async () => {
    // The 6 GB floor with a 4 GB reclaim allowance: under 2 GB free is hopeless, over it is not.
    const hopeless = await readiness(1024);
    assert.equal(hopeless.startsWith("disabled|"), true);
    assert.match(hopeless, /Needs 6 GB free\. This machine has 1 GB free of 10 GB/);
    assert.match(hopeless, /close other programs using the graphics card/);
    // Not the too-small sentence: that card is fine, it is the machine that is busy.
    assert.equal(/This machine has 10 GB\./.test(hopeless), false);
  });

  it("stays ready where unloading the engine would plausibly be enough", async () => {
    // 2 GB free against a 6 GB floor used to disable. Dispatch would have unloaded a resident
    // model and succeeded, so readiness no longer takes the feature away on a guess — it defers
    // to the dispatch check, which frees first and refuses in a quarter of a second if it must.
    assert.equal((await readiness(2048)).startsWith("ready|"), true);
    assert.equal((await readiness(9000)).startsWith("ready|"), true);
  });

  it("takes one free-memory snapshot for every recipe in a status result", async () => {
    const world = fakeWorld();
    world.urls.set("http://127.0.0.1:8188", {});
    world.files.add("C:/models/checkpoints/sd_xl_base_1.0.safetensors");
    world.hashes.set("C:/models/checkpoints/sd_xl_base_1.0.safetensors", "a".repeat(64));
    let freeReads = 0;
    const second = {
      ...FACTS[0]!,
      id: "comfyui-second-image",
      identity: { ...FACTS[0]!.identity, id: "comfyui-second-image" },
    };
    const service = new ComfyUiEngineService({
      ...engineDeps(world, "C:/app", [FACTS[0]!, second]),
      freeVramMb: async () => {
        freeReads += 1;
        return 2048;
      },
    });
    await service.applySettings({ enginePath: null, engineUrl: "http://127.0.0.1:8188", modelsDir: "C:/models" });

    const status = await service.status(PROBES);

    assert.deepEqual(status.recipes.map((recipe) => recipe.state), ["ready", "ready"]);
    assert.equal(freeReads, 1);
  });

  it("a streaming recipe's small free floor still has a sayable busy state", async () => {
    // H3's shape: a 4 GB free floor sitting under the 4 GB reclaim allowance. Unbounded, the
    // busy inequality could never hold for any nonnegative reading — a slammed card advertised
    // ready, and Generate bought the dependency verification walk before dispatch refused. The
    // allowance caps at half the floor, so under 2 GB free is busy and the verified ~4 GB is not.
    const streaming = async (freeMb: number): Promise<string> => {
      const world = fakeWorld();
      world.urls.set("http://127.0.0.1:8188", {});
      world.files.add("C:/models/checkpoints/sd_xl_base_1.0.safetensors");
      world.hashes.set("C:/models/checkpoints/sd_xl_base_1.0.safetensors", "a".repeat(64));
      const service = new ComfyUiEngineService({
        ...engineDeps(world, "C:/app"),
        recipes: [{ ...FACTS[0]!, minVramMb: 10000, minFreeVramMb: 4000 }],
        freeVramMb: async () => freeMb,
      });
      await service.applySettings({ enginePath: null, engineUrl: "http://127.0.0.1:8188", modelsDir: "C:/models" });
      const status = await service.status({ vramMb: 10240, memMb: 32000, diskFreeMb: 1000 });
      return `${status.recipes[0]!.state}|${status.recipes[0]!.reason ?? ""}`;
    };
    const slammed = await streaming(500);
    assert.equal(slammed.startsWith("disabled|"), true);
    assert.match(slammed, /Needs 4 GB free/);
    assert.equal((await streaming(4100)).startsWith("ready|"), true);
  });

  it("a declared memory floor is a readiness rung, because mapped weights never meet the setup gate", async () => {
    // The manifest gate only steers setup: weights already sitting in a mapped models folder
    // reach dispatch admission through this walk alone, and the H3 workload that measured 32 GB
    // would exhaust a 16 GB machine. Memory is not VRAM's problem — /free reclaims nothing —
    // so there is no busy tier, just the floor and the same cloud alternative.
    const withMemFloor = async (memMb: number | null): Promise<string> => {
      const world = fakeWorld();
      world.urls.set("http://127.0.0.1:8188", {});
      world.files.add("C:/models/checkpoints/sd_xl_base_1.0.safetensors");
      world.hashes.set("C:/models/checkpoints/sd_xl_base_1.0.safetensors", "a".repeat(64));
      const service = new ComfyUiEngineService({
        ...engineDeps(world, "C:/app"),
        recipes: [{ ...FACTS[0]!, minMemMb: 30720 }],
        freeVramMb: async () => 9000,
      });
      await service.applySettings({ enginePath: null, engineUrl: "http://127.0.0.1:8188", modelsDir: "C:/models" });
      const status = await service.status({ vramMb: 10240, memMb, diskFreeMb: 1000 });
      return `${status.recipes[0]!.state}|${status.recipes[0]!.reason ?? ""}`;
    };
    const short = await withMemFloor(16000);
    assert.equal(short.startsWith("disabled|"), true);
    assert.match(short, /Needs 30 GB memory\. This machine has 16 GB/);
    assert.equal((await withMemFloor(32000)).startsWith("ready|"), true);
    // Unmeasured memory is unknown-and-dispatchable (D15), the same doctrine as the card.
    const unmeasured = await withMemFloor(null);
    assert.equal(unmeasured.startsWith("unknown|"), true);
    assert.match(unmeasured, /Memory could not be measured/);
  });

  it("a declared free-memory floor is a busy rung beside the card's, advisory and optimistic (issue 846)", async () => {
    // The total floor above admits a 32 GB machine with 3 GB of it free, and offloading spends
    // free RAM. Same doctrine as vram-busy: a measured shortfall disables with the machine's own
    // figures and the cloud alternative; unmeasured dispatches; a remote engine is never judged
    // by this machine's memory.
    const withFreeFloor = async (freeMemMb: number | null, engineUrl = "http://127.0.0.1:8188"): Promise<RecipeReadiness> => {
      const world = fakeWorld();
      world.urls.set(engineUrl, {});
      world.files.add("C:/models/checkpoints/sd_xl_base_1.0.safetensors");
      world.hashes.set("C:/models/checkpoints/sd_xl_base_1.0.safetensors", "a".repeat(64));
      const service = new ComfyUiEngineService({
        ...engineDeps(world, "C:/app"),
        recipes: [{ ...FACTS[0]!, minMemMb: 30720, minFreeMemMb: 20000 }],
        freeVramMb: async () => 9000,
        freeMemMb: async () => freeMemMb,
      });
      await service.applySettings({ enginePath: null, engineUrl, modelsDir: "C:/models" });
      return (await service.status({ vramMb: 10240, memMb: 32000, diskFreeMb: 1000 })).recipes[0]!;
    };
    const short = await withFreeFloor(3000);
    assert.equal(short.state, "disabled");
    assert.equal(short.reasonKind, "memory-busy");
    assert.match(short.reason ?? "", /Needs 20 GB memory free\. This machine has 3 GB free of 31 GB — close other programs/);
    assert.equal(short.cloudAlternative, "Cloud image still works.");
    assert.equal((await withFreeFloor(24000)).state, "ready");
    assert.equal((await withFreeFloor(null)).state, "ready", "unmeasured free memory dispatches (D15)");
    // A remote engine never reaches this rung — the walk stops at the card it cannot measure —
    // and this machine's 3 GB must not become the reason either way.
    const remote = await withFreeFloor(3000, "http://10.0.0.7:8188");
    assert.notEqual(remote.state, "disabled");
    assert.notEqual(remote.reasonKind, "memory-busy");
  });

  it("a card that cannot be asked how much is free is not refused for it", async () => {
    // D15 again: unknown stays unknown. A build with no way to ask must not disable local work
    // on every machine, so a null free reading falls back to the total the probe did measure.
    assert.equal((await readiness(null)).startsWith("ready|"), true);
  });

  it("missing weights: the count, not a generic unavailable", async () => {
    const world = fakeWorld();
    world.urls.set("http://10.0.0.4:8188", {});
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({
      enginePath: null,
      engineUrl: "http://10.0.0.4:8188",
      modelsDir: "C:/models",
    });
    const status = await service.status(PROBES);
    assert.equal(status.recipes[0]!.state, "disabled");
    assert.match(status.recipes[0]!.reason!, /1 of 1 model file missing/);
  });

  it("a weight file that has just landed stops reading as missing before its digest is read", async () => {
    /*
     * Issue 686. Readiness used to compute the pin verdict inline, which on a 6.5 GB checkpoint
     * is a minute or more of SHA-256 in the middle of the one call the coordinator awaits before
     * publishing. So a model Arke had just spent ten minutes downloading went on saying "1 of 1
     * model file missing", and Re-verify — the control that exists for exactly that — looked
     * inert, each press queueing another read of the bytes already being read.
     *
     * The rungs before the digest are all cheap. They answer while it is being read.
     */
    const world = fakeWorld();
    world.urls.set("http://127.0.0.1:51999", {});
    const deps = engineDeps(world, "C:/app");
    let releaseDigest!: () => void;
    const digestRead = new Promise<void>((resolve) => {
      releaseDigest = resolve;
    });
    const readDigest = deps.hashFile;
    const service = new ComfyUiEngineService({
      ...deps,
      hashFile: async (path, signal) => {
        await digestRead;
        return readDigest(path, signal);
      },
    });
    await service.applySettings({
      enginePath: null,
      engineUrl: "http://127.0.0.1:51999",
      modelsDir: "C:/models",
    });
    assert.match((await service.status(PROBES)).recipes[0]!.reason!, /1 of 1 model file missing/);

    // The download completes: the file is on disk, its digest not yet read.
    const landed = "C:/models/checkpoints/sd_xl_base_1.0.safetensors";
    world.files.add(landed);
    world.hashes.set(landed, "a".repeat(64));
    const reverified = service.reverify(["comfyui-draft-image"]);

    const during = await service.status(PROBES);
    assert.doesNotMatch(during.recipes[0]!.reason!, /missing/, "the file is present and was measured");
    assert.match(during.recipes[0]!.reason!, /still being verified/);
    // Still refused, because a verdict nobody has reached is not a pass (R-19 fails closed).
    assert.equal(during.recipes[0]!.state, "disabled");

    releaseDigest();
    await reverified;
    assert.equal((await service.status(PROBES)).recipes[0]!.state, "ready");
  });
});

// ---------------------------------------------------------------------------
// The queue: admission, frozen identity, recovery, sanitisation (§2.11, R-16)
// ---------------------------------------------------------------------------

function queueWith(
  clients: Record<string, FakeProvider>,
  journalPath: string,
  worldDir: string,
  extras: {
    admit?: (input: EnqueueInput) => Promise<{ ok: true } | { ok: false; reason: string }>;
    recoverLocal?: (job: Job, prior: Job | undefined) => ReturnType<typeof comfyUiRecoveryDecision> | null;
    prepareArtifact?: (
      job: Job,
      artifact: { name: string; contentType: string; data: Uint8Array },
    ) =>
      | { ok: true; artifact: { name: string; contentType: string; data: Uint8Array } }
      | { ok: false; reason: string };
    providerConcurrency?: Readonly<Record<string, number>>;
    awaitRecoveryReady?: (provider: string) => Promise<boolean>;
  } = {},
): { queue: JobQueue; events: DomainEvent[]; ledger: LedgerEntry[] } {
  const events: DomainEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const queue = new JobQueue({
    journalPath,
    clients,
    getKey: async () => "k",
    emit: (e) => events.push(e),
    ledger: {
      readJobIds: async () => new Set(ledger.map((e) => e.jobId)),
      has: async (jobId) => ledger.some((e) => e.jobId === jobId),
      append: async (entry) => {
        ledger.push(entry);
      },
    },
    landInWorld: async (_worldId, fn) => {
      await fn(worldDir);
      return true;
    },
    pollIntervalMs: 5,
    ...extras,
  });
  return { queue, events, ledger };
}

const RECIPE_IDENTITY = {
  id: "comfyui-draft-image",
  version: 1,
  templateDigest: "b".repeat(64),
  dependencyDigest: "c".repeat(64),
};

function localInput(): EnqueueInput {
  return {
    worldId: WORLD,
    target: { kind: "bench-take", id: "s/1" },
    capability: "image",
    provider: "comfyui",
    model: "comfyui-draft-image",
    params: { prompt: "x" },
    estimatedMicroUsd: 0,
    recipe: RECIPE_IDENTITY,
    engine: { source: "user-url", instanceId: "abc123" },
  };
}

describe("enqueue admission refuses with the readiness reason before anything is journalled (R-16)", () => {
  it("a not-ready recipe never reaches the journal", async () => {
    const dir = await tempDir("arke-cq-");
    const { queue } = queueWith({ comfyui: new FakeProvider() }, join(dir, "jobs.jsonl"), dir, {
      admit: async (input) =>
        input.provider === "comfyui"
          ? { ok: false, reason: "Needs 8 GB VRAM. This machine has 6 GB. Cloud image still works." }
          : { ok: true },
    });
    await queue.start();
    await assert.rejects(queue.enqueue(localInput()), /Needs 8 GB VRAM/);
    const journal = await readFile(join(dir, "jobs.jsonl"), "utf8").catch(() => "");
    assert.equal(journal.trim(), "", "nothing was journalled for refused work");
    queue.dispose();
  });

  it("frozen identity rides the journal and the folded job", async () => {
    const dir = await tempDir("arke-cq-");
    const provider = new FakeProvider();
    provider.artifacts = [{ name: "out.png", contentType: "image/png", data: pngBytes() }];
    const { queue } = queueWith({ comfyui: new FakeProvider() }, join(dir, "jobs.jsonl"), dir);
    await queue.start();
    const job = await queue.enqueue(localInput());
    assert.deepEqual(job.recipe, RECIPE_IDENTITY);
    assert.deepEqual(job.engine, { source: "user-url", instanceId: "abc123" });
    const journal = await readFile(join(dir, "jobs.jsonl"), "utf8");
    assert.match(journal, new RegExp(RECIPE_IDENTITY.templateDigest));
    queue.dispose();
  });
});

describe("recovery consults the per-source policy (§2.11)", () => {
  async function journalWith(
    dir: string,
    status: "running" | "submitting",
    engine: Job["engine"],
  ): Promise<string> {
    const path = join(dir, "jobs.jsonl");
    const job: Job = {
      id: "jb_01J8E0000000000000000000Z9",
      idempotencyKey: "01J8E1000000000000000000Z9",
      worldId: WORLD,
      target: { kind: "bench-take", id: "s/1" },
      capability: "image",
      provider: "comfyui",
      model: "comfyui-draft-image",
      params: { prompt: "x" },
      estimatedMicroUsd: 0,
      recipe: RECIPE_IDENTITY,
      ...(engine !== undefined ? { engine } : {}),
      status,
      providerJobId: status === "running" ? "p-old" : null,
      attempt: 1,
      error: null,
      createdAt: "2026-08-18T10:00:00.000Z",
      updatedAt: "2026-08-18T10:00:01.000Z",
    };
    await writeFile(path, `${JSON.stringify(job)}\n`);
    return path;
  }

  it("a spawned engine's running job requeues — the relaunched engine holds no old work", async () => {
    const dir = await tempDir("arke-cq-");
    const path = await journalWith(dir, "running", { source: "managed", instanceId: "m1" });
    const provider = new FakeProvider();
    const { queue } = queueWith({ comfyui: provider }, path, dir, {
      recoverLocal: (job) =>
        job.status === "running" || job.status === "submitting"
          ? comfyUiRecoveryDecision({ status: job.status, engine: job.engine, currentInstanceId: "m1" })
          : null,
    });
    const report = await queue.start();
    assert.deepEqual(
      report.map((r) => r.action),
      ["requeued"],
    );
    assert.equal(provider.pollCount, 0, "the old prompt id was never polled");
    queue.dispose();
  });

  it("a recovered synchronous local job waits for readiness, then requeues instead of polling its empty map", async () => {
    const dir = await tempDir("arke-kokoro-q-");
    const path = join(dir, "jobs.jsonl");
    const job: Job = {
      id: "jb_01J8E000000000000000000K70",
      idempotencyKey: "01J8E100000000000000000K70",
      worldId: WORLD,
      target: { kind: "voice-line", id: "sh_12" },
      capability: "voice-tts",
      provider: "kokoro",
      model: "kokoro-82m",
      params: { voiceId: "af_bella", text: "the harbour remembers" },
      estimatedMicroUsd: 0,
      status: "running",
      providerJobId: "kokoro-old-memory-id",
      attempt: 1,
      error: null,
      createdAt: "2026-08-18T10:00:00.000Z",
      updatedAt: "2026-08-18T10:00:01.000Z",
    };
    await writeFile(path, `${JSON.stringify(job)}\n`);
    const provider = new FakeProvider();
    let ready!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      ready = resolve;
    });
    const { queue } = queueWith({ kokoro: provider }, path, dir, {
      recoverLocal: (candidate) => (candidate.provider === "kokoro" ? { action: "requeue" } : null),
      awaitRecoveryReady: async (candidate) => (candidate === "kokoro" ? gate : true),
    });

    const report = await queue.start();
    assert.equal(report[0]?.action, "requeued");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(provider.pollCount, 0);
    assert.equal(provider.submitCount, 0);
    ready(true);
    await until(() => provider.submitCount === 1, "the released job to be submitted");
    await until(() => provider.pollCount === 1, "only the newly submitted provider id to be polled");
    queue.dispose();
  });

  it("keeps recovered Kokoro work blocked when Voxa settles without Kokoro readiness", async () => {
    const dir = await tempDir("arke-kokoro-blocked-q-");
    const path = join(dir, "jobs.jsonl");
    const job: Job = {
      id: "jb_01J8E000000000000000000K71",
      idempotencyKey: "01J8E100000000000000000K71",
      worldId: WORLD,
      target: { kind: "voice-line", id: "sh_12" },
      capability: "voice-tts",
      provider: "kokoro",
      model: "kokoro-82m",
      params: { voiceId: "af_bella", text: "the harbour remembers" },
      estimatedMicroUsd: 0,
      status: "running",
      providerJobId: "kokoro-old-memory-id",
      attempt: 1,
      error: null,
      createdAt: "2026-08-18T10:00:00.000Z",
      updatedAt: "2026-08-18T10:00:01.000Z",
    };
    await writeFile(path, `${JSON.stringify(job)}\n`);
    const provider = new FakeProvider();
    const { queue } = queueWith({ kokoro: provider }, path, dir, {
      recoverLocal: (candidate) => (candidate.provider === "kokoro" ? { action: "requeue" } : null),
      awaitRecoveryReady: async () => false,
    });

    await queue.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(queue.listJobs()[0]?.status, "queued");
    assert.equal(provider.pollCount, 0);
    assert.equal(provider.submitCount, 0);
    queue.dispose();
  });

  it("keeps recovered spooled Kokoro audio behind the same Voxa readiness gate", async () => {
    const dir = await tempDir("arke-kokoro-spool-q-");
    const worldDir = await tempDir("arke-kokoro-spool-world-");
    const path = join(dir, "jobs.jsonl");
    const provider = new FakeProvider();
    provider.inlineArtifacts = [{ name: "speech.wav", contentType: "audio/wav", data: wavBytes() }];
    let worldAvailable = false;
    const first = new JobQueue({
      journalPath: path,
      clients: { kokoro: provider },
      getKey: async () => "",
      emit: () => {},
      ledger: { readJobIds: async () => new Set(), has: async () => false, append: async () => {} },
      landInWorld: async (_worldId, fn) => {
        if (!worldAvailable) return false;
        await fn(worldDir);
        return true;
      },
      pollIntervalMs: 5,
    });
    await first.start();
    const job = await first.enqueue({
      worldId: WORLD,
      target: { kind: "voice-line", id: "sh_12" },
      capability: "voice-tts",
      provider: "kokoro",
      model: "kokoro-82m",
      params: { voiceId: "af_bella", text: "the harbour remembers" },
      estimatedMicroUsd: 0,
      landing: { dir: "productions/saltlight/audio" },
    });
    await until(
      () => first.listJobs()[0]?.error?.includes("waiting for the owning world") === true,
      "the job to report that it is waiting for the owning world",
    );
    first.dispose();
    await first.drain();

    let release!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    worldAvailable = true;
    const second = new JobQueue({
      journalPath: path,
      clients: { kokoro: provider },
      getKey: async () => "",
      emit: () => {},
      ledger: { readJobIds: async () => new Set(), has: async () => false, append: async () => {} },
      landInWorld: async (_worldId, fn) => {
        await fn(worldDir);
        return true;
      },
      awaitRecoveryReady: async () => ready,
      pollIntervalMs: 5,
    });
    await second.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      second.listJobs()[0]?.status,
      "running",
      "the pre-crash row remains visible but does no work",
    );
    assert.equal(provider.submitCount, 1);
    assert.equal(provider.pollCount, 0);
    release(true);
    await until(() => second.listJobs()[0]?.status === "succeeded", "the released job to succeed");
    assert.equal(provider.submitCount, 1);
    assert.equal(provider.pollCount, 0);
    assert.equal(second.listJobs()[0]?.id, job.id);
    second.dispose();
  });

  it("fail-resolves a legacy running ElevenLabs memory id without polling or charging again", async () => {
    const dir = await tempDir("arke-eleven-q-");
    const path = join(dir, "jobs.jsonl");
    const job: Job = {
      id: "jb_01J8E000000000000000000E11",
      idempotencyKey: "01J8E100000000000000000E11",
      worldId: WORLD,
      target: { kind: "voice-line", id: "sh_12" },
      capability: "voice-tts",
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      params: { voiceId: "v1", text: "the harbour remembers" },
      estimatedMicroUsd: 6_000,
      status: "running",
      providerJobId: "elevenlabs-old-memory-id",
      attempt: 1,
      error: null,
      createdAt: "2026-08-18T10:00:00.000Z",
      updatedAt: "2026-08-18T10:00:01.000Z",
    };
    await writeFile(path, `${JSON.stringify(job)}\n`);
    const provider = new FakeProvider();
    const reason = "the paid response belonged to an earlier process; the job was not submitted again";
    const { queue, ledger } = queueWith({ elevenlabs: provider }, path, dir, {
      recoverLocal: (candidate) =>
        candidate.provider === "elevenlabs" && candidate.status === "running"
          ? { action: "fail", reason }
          : null,
    });

    const report = await queue.start();
    assert.equal(report[0]?.action, "failed");
    assert.equal(queue.listJobs()[0]?.status, "failed");
    assert.match(queue.listJobs()[0]?.error ?? "", /not submitted again/);
    assert.equal(provider.pollCount, 0);
    assert.equal(provider.submitCount, 0);
    assert.equal(ledger.length, 1);
    queue.dispose();
  });

  it("does not pump requeued work until the spawned engine is ready", async () => {
    const dir = await tempDir("arke-cq-");
    const path = await journalWith(dir, "running", { source: "managed", instanceId: "m1" });
    const provider = new FakeProvider();
    let release!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const { queue } = queueWith({ comfyui: provider }, path, dir, {
      recoverLocal: (job) =>
        job.status === "running" || job.status === "submitting"
          ? comfyUiRecoveryDecision({ status: job.status, engine: job.engine, currentInstanceId: "m1" })
          : null,
      awaitRecoveryReady: async (providerId) => (providerId === "comfyui" ? ready : true),
    });

    const report = await queue.start();
    assert.deepEqual(
      report.map((row) => row.action),
      ["requeued"],
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(provider.submitCount, 0, "recovery did not race the engine's startup");
    release(true);
    await until(() => provider.submitCount === 1, "the requeued job to be submitted once ready");
    queue.dispose();
  });

  it("resumes a recovered URL poll when readiness returns after the initial wait", async () => {
    const dir = await tempDir("arke-cq-");
    const path = await journalWith(dir, "running", { source: "user-url", instanceId: "same" });
    const provider = new FakeProvider();
    provider.remote.set("p-old", {
      remoteId: "p-old",
      createdAt: "2026-08-18T10:00:00.000Z",
      state: "succeeded",
    });
    const { queue } = queueWith({ comfyui: provider }, path, dir, {
      recoverLocal: (job) =>
        job.status === "running" || job.status === "submitting"
          ? comfyUiRecoveryDecision({ status: job.status, engine: job.engine, currentInstanceId: "same" })
          : null,
      awaitRecoveryReady: async () => false,
    });

    const report = await queue.start();
    assert.deepEqual(
      report.map((row) => row.action),
      ["resumed-polling"],
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(provider.pollCount, 0);
    queue.releaseRecovery("comfyui");
    await until(() => provider.pollCount > 0, "the resumed poll to run once readiness returns");
    queue.dispose();
  });

  it("does not run a deferred old-engine poll after that job is retired", async () => {
    const dir = await tempDir("arke-cq-");
    const path = await journalWith(dir, "running", { source: "user-url", instanceId: "same" });
    const provider = new FakeProvider();
    const { queue } = queueWith({ comfyui: provider }, path, dir, {
      recoverLocal: (job) =>
        job.status === "running" || job.status === "submitting"
          ? comfyUiRecoveryDecision({ status: job.status, engine: job.engine, currentInstanceId: "same" })
          : null,
      awaitRecoveryReady: async () => false,
    });

    await queue.start();
    await queue.failJobsForRetiredEngine("comfyui", () => false, "the engine changed");
    queue.releaseRecovery("comfyui");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(provider.pollCount, 0);
    assert.equal(queue.listJobs()[0]!.status, "failed");
    queue.dispose();
  });

  it("a changed engine fails the orphan with the reason stated, and never polls the old id", async () => {
    const dir = await tempDir("arke-cq-");
    const path = await journalWith(dir, "running", { source: "user-url", instanceId: "old-engine" });
    const provider = new FakeProvider();
    const { queue, ledger } = queueWith({ comfyui: provider }, path, dir, {
      recoverLocal: (job) =>
        job.status === "running" || job.status === "submitting"
          ? comfyUiRecoveryDecision({
              status: job.status,
              engine: job.engine,
              currentInstanceId: "new-engine",
            })
          : null,
    });
    const report = await queue.start();
    assert.equal(report[0]!.action, "failed");
    assert.match(report[0]!.detail!, /no longer configured/);
    assert.equal(provider.pollCount, 0);
    const failed = queue.listJobs().find((j) => j.id === "jb_01J8E0000000000000000000Z9")!;
    assert.equal(failed.status, "failed");
    // A terminal local job still writes its ledger row, at local-zero (R-12, R-15).
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.actualMicroUsd, 0);
    assert.equal(ledger[0]!.actualSource, "local-zero");
    queue.dispose();
  });

  it("a surviving engine's ambiguous submission holds, priced as GPU time rather than money", async () => {
    const dir = await tempDir("arke-cq-");
    const path = await journalWith(dir, "submitting", { source: "user-url", instanceId: "same" });
    const { queue } = queueWith({ comfyui: new FakeProvider() }, path, dir, {
      recoverLocal: (job) =>
        job.status === "running" || job.status === "submitting"
          ? comfyUiRecoveryDecision({ status: job.status, engine: job.engine, currentInstanceId: "same" })
          : null,
    });
    const report = await queue.start();
    assert.equal(report[0]!.action, "held-for-user");
    assert.match(report[0]!.detail!, /GPU time — no charge/);
    assert.doesNotMatch(report[0]!.detail!, /charge about|charge of unknown size/);
    queue.dispose();
  });
});

describe("the ComfyUI provider has one process-wide execution lane", () => {
  it("serialises work across worlds even when other providers default to two", async () => {
    const dir = await tempDir("arke-cq-");
    const provider = new FakeProvider();
    provider.submitHangs = true;
    const { queue } = queueWith({ comfyui: provider }, join(dir, "jobs.jsonl"), dir, {
      providerConcurrency: { comfyui: 1 },
    });
    await queue.start();
    await queue.enqueue(localInput());
    await queue.enqueue({ ...localInput(), worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD" });
    await until(() => provider.submitCount === 1, "the first of the two jobs to take the lane");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(provider.submitCount, 1);
    assert.equal(provider.maxObservedConcurrent, 1);
    queue.dispose();
  });
});

describe("sanitisation runs before landing, and a refusal fails the job (§2.10)", () => {
  it("bytes are rewritten by the hook before verification", async () => {
    const dir = await tempDir("arke-cq-");
    const provider = new FakeProvider();
    provider.artifacts = [{ name: "arke_00001_.png", contentType: "image/png", data: pngWithText() }];
    const { queue } = queueWith({ comfyui: provider }, join(dir, "jobs.jsonl"), dir, {
      prepareArtifact: (job, artifact) => {
        if (job.provider !== "comfyui") return { ok: true, artifact };
        const result = sanitizeComfyUiMedia(artifact.name, artifact.data);
        return result.ok ? { ok: true, artifact: { ...artifact, data: result.data } } : result;
      },
    });
    await queue.start();
    const job = await queue.enqueue({ ...localInput(), landing: { dir: "incoming/x" } });
    await queue.waitForIdle();
    const landedJob = queue.listJobs().find((j) => j.id === job.id)!;
    assert.equal(landedJob.status, "succeeded");
    // landedFiles are world-relative and always forward-slashed; join() takes those on
    // Windows too, so the separator swap this used to do only made the path unreadable
    // on Linux, where a backslash is an ordinary character in a filename.
    const landed = await readFile(join(dir, landedJob.landedFiles![0]!));
    assert.equal(new TextDecoder("latin1").decode(landed).includes("KSampler"), false);
    queue.dispose();
  });

  it("an unsanitisable container fails the job with the container named", async () => {
    const dir = await tempDir("arke-cq-");
    const provider = new FakeProvider();
    provider.artifacts = [
      { name: "clip.webm", contentType: "video/webm", data: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) },
    ];
    const { queue } = queueWith({ comfyui: provider }, join(dir, "jobs.jsonl"), dir, {
      prepareArtifact: (job, artifact) => {
        if (job.provider !== "comfyui") return { ok: true, artifact };
        const result = sanitizeComfyUiMedia(artifact.name, artifact.data);
        return result.ok ? { ok: true, artifact: { ...artifact, data: result.data } } : result;
      },
    });
    await queue.start();
    const job = await queue.enqueue({ ...localInput(), capability: "video", landing: { dir: "incoming/x" } });
    await queue.waitForIdle();
    const failed = queue.listJobs().find((j) => j.id === job.id)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /webm\/matroska/);
    queue.dispose();
  });
});

// ---------------------------------------------------------------------------
// Arrival provenance agrees with the ledger (§2.9, R-13)
// ---------------------------------------------------------------------------

describe("nothing graph-shaped reaches renderer state (R-14, R-1)", () => {
  it("every event a full local dispatch emits is free of graph content and host paths", async () => {
    const dir = await tempDir("arke-cq-");
    const provider = new FakeProvider();
    provider.artifacts = [{ name: "arke_00001_.png", contentType: "image/png", data: pngWithText() }];
    const { queue, events } = queueWith({ comfyui: provider }, join(dir, "jobs.jsonl"), dir, {
      prepareArtifact: (job, artifact) => {
        if (job.provider !== "comfyui") return { ok: true, artifact };
        const result = sanitizeComfyUiMedia(artifact.name, artifact.data);
        return result.ok ? { ok: true, artifact: { ...artifact, data: result.data } } : result;
      },
    });
    await queue.start();
    await queue.enqueue({ ...localInput(), landing: { dir: "incoming/x" } });
    await queue.waitForIdle();
    // Events ARE renderer state: job.updated carries the whole job row, and the read model
    // folds these straight into ClientState.
    const wire = JSON.stringify(events);
    assert.ok(events.length > 0, "the dispatch emitted events");
    for (const forbidden of [
      "class_type",
      "KSampler",
      "CheckpointLoaderSimple",
      "SaveImage",
      "ckpt_name",
      "latent_image",
    ]) {
      assert.equal(wire.includes(forbidden), false, `"${forbidden}" reached renderer state`);
    }
    // The digests that ARE allowed through are identity, not structure.
    assert.match(wire, /templateDigest/);
    queue.dispose();
  });
});

describe("the frozen identity reaches the wire, where it can be enforced (R-15)", () => {
  it("submit receives the job's recipe identity, not just its model id", async () => {
    const dir = await tempDir("arke-cq-");
    const seen: Array<Record<string, unknown>> = [];
    const provider = new FakeProvider();
    const original = provider.submit.bind(provider);
    provider.submit = async (key, request) => {
      seen.push(request as unknown as Record<string, unknown>);
      return original(key, request);
    };
    const { queue } = queueWith({ comfyui: provider }, join(dir, "jobs.jsonl"), dir);
    await queue.start();
    await queue.enqueue(localInput());
    await queue.waitForIdle();
    assert.equal(seen.length, 1);
    // Freezing identity at enqueue is only half of R-15; this is the half that lets a client
    // refuse a catalogue that has moved past what the job was accepted as.
    assert.deepEqual(seen[0]!["recipe"], RECIPE_IDENTITY);
    queue.dispose();
  });
});

describe("retiring an engine mid-flight (§2.11)", () => {
  it("fails the work that belonged to it, and leaves work that still matches alone", async () => {
    // The bug this closes: changing the engine in Settings left running jobs polling — and the
    // poll went to the NEW engine with an id only the OLD one ever issued, which reads as the
    // engine having lost the job rather than the user having moved it.
    const dir = await tempDir("arke-cq-");
    const provider = new FakeProvider();
    provider.pollState = "running";
    const { queue, ledger } = queueWith({ comfyui: provider }, join(dir, "jobs.jsonl"), dir);
    await queue.start();
    const mine = await queue.enqueue(localInput());
    const theirs = await queue.enqueue({
      ...localInput(),
      engine: { source: "user-url", instanceId: "other" },
    });
    const failed = await queue.failJobsForRetiredEngine(
      "comfyui",
      (job) => job.engine?.instanceId === "abc123",
      "the engine this job ran on is no longer configured — it was not resumed against the new one",
    );
    assert.deepEqual(
      failed.map((j) => j.id),
      [theirs.id],
      "only the job whose engine retired",
    );
    const after = queue.listJobs();
    assert.equal(after.find((j) => j.id === theirs.id)!.status, "failed");
    assert.match(after.find((j) => j.id === theirs.id)!.error!, /no longer configured/);
    assert.notEqual(after.find((j) => j.id === mine.id)!.status, "failed");
    // Terminal local work still records its zero.
    assert.equal(ledger.find((e) => e.jobId === theirs.id)!.actualSource, "local-zero");
    queue.dispose();
  });

  for (const sample of [
    { label: "image", capability: "image", model: "comfyui-draft-image", params: { prompt: "x" } },
    {
      label: "video",
      capability: "video",
      model: "comfyui-draft-video",
      params: { prompt: "x", durationSec: 2 },
    },
    {
      label: "voice",
      capability: "voice-tts",
      model: "comfyui-cloned-voice",
      params: { text: "x", voiceId: "v" },
    },
  ] as const) {
    it(`requeues an active ${sample.label} job when a spawned process restarts at the same path`, async () => {
      const dir = await tempDir("arke-cq-");
      const provider = new FakeProvider();
      provider.pollState = "running";
      const { queue, ledger } = queueWith({ comfyui: provider }, join(dir, "jobs.jsonl"), dir, {
        providerConcurrency: { comfyui: 1 },
      });
      await queue.start();
      const job = await queue.enqueue({
        ...localInput(),
        capability: sample.capability,
        model: sample.model,
        params: sample.params,
        recipe: { ...RECIPE_IDENTITY, id: sample.model },
        engine: { source: "managed", instanceId: "same-path", processEpoch: "process-1" },
      });
      await until(
        () => queue.listJobs().find((candidate) => candidate.id === job.id)?.status === "running",
        `the ${sample.label} job to reach running before the engine is retired`,
      );

      queue.blockRecovery("comfyui");
      const retired = await queue.failJobsForRetiredEngine(
        "comfyui",
        (candidate) => candidate.engine?.processEpoch === "process-2",
        "the engine changed",
        () => ({ source: "managed", instanceId: "same-path", processEpoch: "process-2" }),
      );
      assert.deepEqual(
        retired.map((candidate) => candidate.id),
        [job.id],
      );
      const queued = queue.listJobs().find((candidate) => candidate.id === job.id)!;
      assert.equal(queued.status, "queued");
      assert.equal(queued.providerJobId, null);
      assert.equal(queued.engine?.processEpoch, "process-2");
      assert.equal(ledger.length, 0, "retirement is a free rerun, not a terminal outcome");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(provider.submitCount, 1, "the replacement is gated while it starts");

      queue.releaseRecovery("comfyui");
      await until(() => provider.submitCount === 2, "the replacement job to be submitted");
      assert.equal(
        queue.listJobs().find((candidate) => candidate.id === job.id)?.engine?.processEpoch,
        "process-2",
      );
      assert.equal(provider.maxObservedConcurrent, 1, "the retired run released its process lane");
      queue.dispose();
    });
  }
});

describe("every local outcome records local-zero, not just the successful one", () => {
  it("a cancelled local job still writes its ledger row at zero (R-12)", async () => {
    const dir = await tempDir("arke-cq-");
    const provider = new FakeProvider();
    provider.pollState = "running"; // stays in flight so there is something to cancel
    const { queue, ledger } = queueWith({ comfyui: provider }, join(dir, "jobs.jsonl"), dir);
    await queue.start();
    const job = await queue.enqueue(localInput());
    // Settle in `running` before cancelling, and ASSERT we got there rather than proceeding
    // whatever happened. Cancelling mid-submit races the dispatcher's own transition to
    // running, which would overwrite the cancellation — a real but separate window, and not
    // what this test is about. `until` carries the budget that keeps it deterministic under load.
    await until(
      () => queue.listJobs().find((j) => j.id === job.id)?.status === "running",
      "the job to reach running before the cancel",
    );
    await queue.cancel(job.id);
    const cancelled = queue.listJobs().find((j) => j.id === job.id)!;
    assert.equal(cancelled.status, "cancelled");
    const row = ledger.find((e) => e.jobId === job.id)!;
    assert.equal(row.outcome, "cancelled");
    assert.equal(row.actualMicroUsd, 0, "a cancelled local run cost nothing, and that is knowable");
    assert.equal(row.actualSource, "local-zero");
    queue.dispose();
  });
});

describe("a local take carries local-zero and its recipe version (§2.9)", () => {
  it("actualSource rides through arrival, and provenance records the frozen version", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: () => "2026-08-18T12:00:00.000Z" });
    const rel = "productions/saltlight/incoming/sh_01/out.png";
    await mkdir(join(dir, "productions/saltlight/incoming/sh_01"), { recursive: true });
    await writeFile(join(dir, rel), Buffer.from("png-ish"));
    const job: Job = {
      id: "jb_01J8E0000000000000000000L1",
      idempotencyKey: "01J8E1000000000000000000L1",
      worldId: WORLD,
      productionId: "saltlight",
      target: { kind: "shot", id: "sh_01" },
      capability: "image",
      provider: "comfyui",
      model: "comfyui-draft-image",
      params: { prompt: "x", provenance: { canonRevision: 7, sheets: {} } },
      estimatedMicroUsd: 0,
      recipe: RECIPE_IDENTITY,
      engine: { source: "managed", instanceId: "m1" },
      status: "succeeded",
      providerJobId: "p1",
      attempt: 1,
      landing: { dir: "productions/saltlight/incoming/sh_01" },
      landedFiles: [rel],
      error: null,
      createdAt: "2026-08-18T11:00:00.000Z",
      updatedAt: "2026-08-18T11:01:00.000Z",
    };
    const takes = await recordTakesFromJob(store, job, 0, {}, "local-zero");
    assert.equal(takes.length, 1);
    assert.equal(takes[0]!.cost.actualSource, "local-zero");
    assert.equal(takes[0]!.provenance.recipeVersion, 1);
    assert.equal(takes[0]!.provenance.canonRevision, 7);
    await store.close();
  });

  it("a pass's segments carry local-zero too — a divided zero is still local (§2.9)", async () => {
    // The failure this closes: segments were stamped manifest-derived unconditionally, so a
    // local pass produced takes that disagreed with their own ledger row about the zero.
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: () => "2026-08-18T12:00:00.000Z" });
    const rel = "productions/saltlight/incoming/sc_01/out.mp4";
    await mkdir(join(dir, "productions/saltlight/incoming/sc_01"), { recursive: true });
    await writeFile(join(dir, rel), Buffer.from("mp4-ish"));
    const job: Job = {
      id: "jb_01J8E0000000000000000000L2",
      idempotencyKey: "01J8E1000000000000000000L2",
      worldId: WORLD,
      productionId: "saltlight",
      target: { kind: "scene-pass", id: "sc_01", coversShots: ["sh_01", "sh_02"] },
      capability: "video",
      provider: "comfyui",
      model: "comfyui-draft-video",
      params: {
        prompt: "x",
        provenance: { canonRevision: 7, sheets: {} },
        shotPlan: [
          { shotId: "sh_01", number: 1, startSec: 0, endSec: 2 },
          { shotId: "sh_02", number: 2, startSec: 2, endSec: 5 },
        ],
      },
      estimatedMicroUsd: 0,
      recipe: { ...RECIPE_IDENTITY, id: "comfyui-draft-video" },
      engine: { source: "managed", instanceId: "m1" },
      status: "succeeded",
      providerJobId: "p1",
      attempt: 1,
      landing: { dir: "productions/saltlight/incoming/sc_01" },
      landedFiles: [rel],
      error: null,
      createdAt: "2026-08-18T11:00:00.000Z",
      updatedAt: "2026-08-18T11:01:00.000Z",
    };
    const takes = await recordTakesFromJob(store, job, 0, {}, "local-zero");
    assert.equal(takes.length, 3, "the pass plus two segments");
    for (const take of takes) {
      assert.equal(take.cost.actualSource, "local-zero", take.id);
      assert.equal(take.provenance.recipeVersion, 1, take.id);
    }
    assert.ok(
      takes.slice(1).every((t) => t.cost.allocated === true),
      "segments are allocated shares",
    );
    await store.close();
  });
});

describe("engine version compatibility is per recipe (SPEC-021 R-18, R-19; issue 592)", () => {
  const devices = [{ type: "cuda", vram_total: 10240 * 1024 * 1024, torch_vram_total: 0 }];
  const above: ComfyUiRecipeFacts = { ...FACTS[0]!, id: "needs-newer", displayName: "Needs newer", checkpoints: [], minEngineVersion: "0.40.0" };
  const within: ComfyUiRecipeFacts = { ...FACTS[0]!, id: "runs-here", displayName: "Runs here", checkpoints: [], exercisedThroughVersion: "0.30.0" };

  it("disables exactly the recipe above the engine, naming its own requirement, and states an untested pairing without refusing", async () => {
    const world = fakeWorld();
    world.urls.set("http://127.0.0.1:8188", { version: "0.33.1", devices });
    const service = new ComfyUiEngineService({ ...engineDeps(world, "C:/app", [above, within]), freeVramMb: async () => 8000 });
    await service.applySettings({ enginePath: null, engineUrl: "http://127.0.0.1:8188", modelsDir: null });
    const { recipes } = await service.status(PROBES);
    const newer = recipes.find((r) => r.recipeId === "needs-newer")!;
    const here = recipes.find((r) => r.recipeId === "runs-here")!;
    assert.equal(newer.state, "disabled");
    assert.match(newer.reason ?? "", /Needs newer needs ComfyUI 0\.40\.0 or later — this engine reports 0\.33\.1/);
    assert.doesNotMatch(newer.reason ?? "", /floor/, "the recipe's requirement is named, not the module floor");
    assert.equal(here.state, "ready", "the recipe the engine satisfies stays ready");
    assert.match(here.untested ?? "", /0\.33\.1 is newer than the 0\.30\.0/);
    assert.match((await service.preflight("needs-newer")).ok ? "" : (await service.preflight("needs-newer") as { reason: string }).reason, /0\.40\.0/, "pre-flight re-checks the floor");
    assert.equal(service.identityFor("runs-here")?.recipe.engineVersion, "0.33.1", "the reported version is frozen into the identity");
  });
});

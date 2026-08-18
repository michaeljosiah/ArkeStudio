import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComfyUiSettings, DomainEvent, Job, LedgerEntry, RuntimeProbes } from "@arke-studio/contracts";
import { comfyUiRecoveryDecision } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { ComfyUiEngineService, engineInstanceId, type ComfyUiRecipeFacts, type EngineServiceDeps } from "../../src/comfyui/engine.js";
import { sanitizeComfyUiMedia } from "../../src/comfyui/sanitize.js";
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

/** Poll a condition to a deadline. Returns whether it became true, so callers can assert it. */
async function waitFor(condition: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return condition();
}

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
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(payload, 8);
  view.setUint32(8 + payload.length, crc32(payload));
  return out;
}

function pngWithText(): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk("IHDR", new Uint8Array(13));
  const workflow = pngChunk("tEXt", new TextEncoder().encode("prompt\0{\"1\":{\"class_type\":\"KSampler\"}}"));
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
  return (data[at]! << 24 | data[at + 1]! << 16 | data[at + 2]! << 8 | data[at + 3]!) >>> 0;
}

function mp4Box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
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
    const exif = concat(new TextEncoder().encode("EXIF"), new Uint8Array([4, 0, 0, 0]), new TextEncoder().encode("wkfl"));
    const vp8 = concat(new TextEncoder().encode("VP8 "), new Uint8Array([2, 0, 0, 0]), new Uint8Array([9, 9]), new Uint8Array([0]));
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
    const vp8xAt = result.data.findIndex((_, i) => new TextDecoder("latin1").decode(result.data.subarray(i, i + 4)) === "VP8X");
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
    const trak = (offset: number) => mp4Box("trak", mp4Box("mdia", mp4Box("minf", mp4Box("stbl", stcoBox(offset)))));
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
    recommendedVramMb: 8000,
    checkpoints: [{ file: "checkpoints/sd_xl_base_1.0.safetensors", sha256: "a".repeat(64), sizeMb: 6617, url: "https://x/" }],
    customNodes: [],
    nodeClasses: ["KSampler", "SaveImage"],
    identity: { id: "comfyui-draft-image", version: 1, templateDigest: "b".repeat(64), dependencyDigest: "c".repeat(64) },
  },
];

interface FakeEngineWorld {
  files: Set<string>;
  hashes: Map<string, string>;
  fetches: string[];
  spawned: SupervisedSpec[];
  urls: Map<string, { version?: string }>;
}

function engineDeps(world: FakeEngineWorld, appRoot: string): EngineServiceDeps {
  return {
    appRoot,
    recipes: FACTS,
    fetch: async (url) => {
      world.fetches.push(url);
      for (const [base, behaviour] of world.urls) {
        if (url.startsWith(base)) {
          if (url.endsWith("/system_stats")) {
            return new Response(JSON.stringify({ system: { comfyui_version: behaviour.version ?? "0.33.1" } }), { status: 200 });
          }
          if (url.endsWith("/object_info")) {
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
    createSupervisor: (spec) => {
      world.spawned.push(spec);
      const fake = {
        status: "healthy" as const,
        port: 51999,
        reason: undefined,
        on: () => fake,
        start: async () => {},
        stop: async () => {},
      };
      return fake as unknown as ChildSupervisor;
    },
    homeDir: "C:/Users/nadia",
  };
}

function fakeWorld(): FakeEngineWorld {
  return { files: new Set(), hashes: new Map(), fetches: [], spawned: [], urls: new Map() };
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
    assert.equal(await service.externallyPresent(), false);

    // A well-known folder holding an install becomes an offer, not an installation.
    world.files.add("C:/Users/nadia/ComfyUI/main.py");
    await service.applySettings(NO_SETTINGS);
    const detected = service.engineStatus().detected;
    assert.equal(detected.length, 1);
    assert.match(detected[0]!.location, /ComfyUI/);
    assert.equal(await service.externallyPresent(), true);
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
    assert.equal(world.spawned.length, 0, "a URL is never spawned (D13)");
    assert.equal(service.baseUrl(), "http://127.0.0.1:8188");

    world.urls.set("http://127.0.0.1:8188", { version: "0.2.2" });
    await service.applySettings({ enginePath: null, engineUrl: "http://127.0.0.1:8188", modelsDir: null });
    const old = service.engineStatus();
    assert.equal(old.state, "incompatible");
    assert.match(old.detail!, /0\.2\.2/);
    assert.equal(service.baseUrl(), null, "an incompatible engine is not dispatched to");
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
    assert.equal(service.engineStatus().state, "ready");
    assert.equal(service.baseUrl(), "http://127.0.0.1:51999");
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
    assert.equal(engineInstanceId("user-path", "C:\\AI\\ComfyUI\\"), engineInstanceId("user-path", "c:\\ai\\comfyui"));
    assert.notEqual(engineInstanceId("user-path", "C:\\AI\\ComfyUI"), engineInstanceId("user-url", "C:\\AI\\ComfyUI"));
    assert.doesNotMatch(engineInstanceId("user-path", "C:\\AI\\ComfyUI"), /comfyui/i);
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
    assert.doesNotMatch(status.recipes[0]!.reason!, /missing/, "never wording that implies the files are merely missing");
  });

  it("VRAM below the floor: both figures and the cloud alternative; unknown stays unknown and dispatchable (D15)", async () => {
    const world = fakeWorld();
    world.urls.set("http://10.0.0.4:8188", {});
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({ enginePath: null, engineUrl: "http://10.0.0.4:8188", modelsDir: "C:/models" });
    world.files.add("C:/models/checkpoints/sd_xl_base_1.0.safetensors");

    const small = await service.status({ vramMb: 4096, memMb: 32000, diskFreeMb: 1000 });
    assert.equal(small.recipes[0]!.state, "disabled");
    assert.match(small.recipes[0]!.reason!, /Needs 6 GB VRAM\. This machine has 4 GB\./);

    const unknown = await service.status({ vramMb: null, memMb: 32000, diskFreeMb: 1000 });
    assert.equal(unknown.recipes[0]!.state, "unknown");
    assert.match(unknown.recipes[0]!.reason!, /VRAM could not be measured\. The 6 GB floor was not checked\./);
  });

  it("missing weights: the count, not a generic unavailable", async () => {
    const world = fakeWorld();
    world.urls.set("http://10.0.0.4:8188", {});
    const service = new ComfyUiEngineService(engineDeps(world, "C:/app"));
    await service.applySettings({ enginePath: null, engineUrl: "http://10.0.0.4:8188", modelsDir: "C:/models" });
    const status = await service.status(PROBES);
    assert.equal(status.recipes[0]!.state, "disabled");
    assert.match(status.recipes[0]!.reason!, /1 of 1 model file missing/);
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
    prepareArtifact?: (job: Job, artifact: { name: string; contentType: string; data: Uint8Array }) => { ok: true; artifact: { name: string; contentType: string; data: Uint8Array } } | { ok: false; reason: string };
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
  async function journalWith(dir: string, status: "running" | "submitting", engine: Job["engine"]): Promise<string> {
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
    assert.deepEqual(report.map((r) => r.action), ["requeued"]);
    assert.equal(provider.pollCount, 0, "the old prompt id was never polled");
    queue.dispose();
  });

  it("a changed engine fails the orphan with the reason stated, and never polls the old id", async () => {
    const dir = await tempDir("arke-cq-");
    const path = await journalWith(dir, "running", { source: "user-url", instanceId: "old-engine" });
    const provider = new FakeProvider();
    const { queue, ledger } = queueWith({ comfyui: provider }, path, dir, {
      recoverLocal: (job) =>
        job.status === "running" || job.status === "submitting"
          ? comfyUiRecoveryDecision({ status: job.status, engine: job.engine, currentInstanceId: "new-engine" })
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
    const landed = await readFile(join(dir, landedJob.landedFiles![0]!.replaceAll("/", "\\")));
    assert.equal(new TextDecoder("latin1").decode(landed).includes("KSampler"), false);
    queue.dispose();
  });

  it("an unsanitisable container fails the job with the container named", async () => {
    const dir = await tempDir("arke-cq-");
    const provider = new FakeProvider();
    provider.artifacts = [{ name: "clip.webm", contentType: "video/webm", data: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) }];
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
    for (const forbidden of ["class_type", "KSampler", "CheckpointLoaderSimple", "SaveImage", "ckpt_name", "latent_image"]) {
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
    const theirs = await queue.enqueue({ ...localInput(), engine: { source: "user-url", instanceId: "other" } });
    const failed = await queue.failJobsForRetiredEngine(
      "comfyui",
      (job) => job.engine?.instanceId === "abc123",
      "the engine this job ran on is no longer configured — it was not resumed against the new one",
    );
    assert.deepEqual(failed.map((j) => j.id), [theirs.id], "only the job whose engine retired");
    const after = queue.listJobs();
    assert.equal(after.find((j) => j.id === theirs.id)!.status, "failed");
    assert.match(after.find((j) => j.id === theirs.id)!.error!, /no longer configured/);
    assert.notEqual(after.find((j) => j.id === mine.id)!.status, "failed");
    // Terminal local work still records its zero.
    assert.equal(ledger.find((e) => e.jobId === theirs.id)!.actualSource, "local-zero");
    queue.dispose();
  });
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
    // what this test is about. A generous budget keeps it deterministic under load.
    const settled = await waitFor(
      () => queue.listJobs().find((j) => j.id === job.id)?.status === "running",
      10_000,
    );
    assert.ok(settled, "the job reached running before the cancel");
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
    assert.ok(takes.slice(1).every((t) => t.cost.allocated === true), "segments are allocated shares");
    await store.close();
  });
});

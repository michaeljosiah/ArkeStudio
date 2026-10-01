import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AppSettingsSchema,
  BenchRequestSnapshotSchema,
  benchUpscalePlan,
  engineFloorClause,
  upscaleCropCopy,
  upscaleFrameCopy,
  upscalePlan,
  upscaleRateCopy,
  upscaleTimeCopy,
  type BenchTake,
} from "../src/index.js";

/* Upscale to 1080p (design turn 178): the frame, the crop stated before the press, and the time. */

describe("the frame and the crop (design 178a)", () => {
  it("states the design's crops: 2% top and bottom for 1344×768, 1% each side for 864×480", () => {
    const wide = upscalePlan({ width: 1344, height: 768 })!;
    assert.deepEqual(wide.to, { width: 1920, height: 1080 });
    assert.equal(upscaleCropCopy(wide.crop), "2% top and bottom");
    assert.equal(upscaleFrameCopy(wide), "1344×768 → 1920×1080");
    const small = upscalePlan({ width: 864, height: 480 })!;
    assert.deepEqual(small.to, { width: 1920, height: 1080 });
    assert.equal(upscaleCropCopy(small.crop), "1% each side");
  });

  it("frames a portrait source 1080×1920, and an exact 16:9 source loses nothing", () => {
    const tall = upscalePlan({ width: 480, height: 864 })!;
    assert.equal(tall.aspect, "9:16");
    assert.deepEqual(tall.to, { width: 1080, height: 1920 });
    assert.equal(upscaleCropCopy(tall.crop), "1% top and bottom");
    assert.equal(upscaleCropCopy(upscalePlan({ width: 1280, height: 720 })!.crop), "None");
  });

  it("offers nothing for a source already at the size, a square, or a frame it cannot read", () => {
    assert.equal(upscalePlan({ width: 1920, height: 1080 }), null);
    assert.equal(upscalePlan({ width: 3840, height: 2160 }), null);
    assert.equal(upscalePlan({ width: 1080, height: 1920 }), null);
    assert.equal(upscalePlan({ width: 1024, height: 1024 }), null);
    assert.equal(upscalePlan({ width: 0, height: 480 }), null);
  });

  it("reads the take's own measured frame, and only for a finished video", () => {
    const take = {
      status: "succeeded",
      request: { mode: "video" },
      media: { file: "output-1.mp4", hash: "sha256:00000000", info: { durationSec: 7.3, hasAudio: true, width: 1344, height: 768 } },
    } as unknown as BenchTake;
    assert.equal(benchUpscalePlan(take)?.to.width, 1920);
    assert.equal(benchUpscalePlan({ ...take, status: "running" }), null);
    assert.equal(benchUpscalePlan({ ...take, request: { ...take.request, mode: "image" } }), null);
    assert.equal(benchUpscalePlan({ ...take, media: { ...take.media!, info: { durationSec: 7.3, hasAudio: true } } }), null);
  });
});

describe("what an engine below the floor is told (design 178d)", () => {
  it("names the minor version the recipe needs", () => {
    assert.equal(engineFloorClause("0.38.0"), "Needs ComfyUI 0.38");
    assert.equal(engineFloorClause("0.38.2"), "Needs ComfyUI 0.38.2");
  });
});

describe("the time, measured on this machine (design 178a, 178c)", () => {
  const at = "2026-10-01T12:00:00.000Z";
  it("is a dash until one upscale has completed", () => {
    assert.equal(upscaleRateCopy(undefined), "—");
    assert.equal(upscaleRateCopy([]), "—");
    assert.equal(upscaleTimeCopy(undefined, 7.3), "—");
  });

  it("is the mean rate per second of output, and that rate times the source's length", () => {
    // The two measured runs: 4.7 min for 2 s, 14.3 min for 7.3 s.
    const samples = [{ secPerOutputSec: (4.7 * 60) / 2, at }, { secPerOutputSec: (14.3 * 60) / 7.3, at }];
    assert.equal(upscaleRateCopy(samples), "~2 min / s");
    assert.equal(upscaleTimeCopy([samples[1]!], 7.3), "~14 min");
    assert.equal(upscaleRateCopy([{ secPerOutputSec: 30, at }]), "~30 s / s");
  });

  it("is kept with the device's sampling timings, and a settings file without it still parses", () => {
    assert.equal(AppSettingsSchema.parse({}).localSampling.rates, undefined);
    const kept = AppSettingsSchema.parse({ localSampling: { choices: {}, timings: {}, rates: { "comfyui-seedvr2-upscale": [{ secPerOutputSec: 117, at }] } } });
    assert.equal(kept.localSampling.rates?.["comfyui-seedvr2-upscale"]?.[0]?.secPerOutputSec, 117);
  });
});

describe("an upscale take's record", () => {
  const base = {
    mode: "video",
    brief: "",
    references: [],
    keyframes: [],
    provider: "comfyui",
    model: "comfyui-seedvr2-upscale",
    params: { kind: "video", aspect: "16:9", resolution: "1080p" },
    upscale: {
      sourceTakeId: "tk_01JTTTTTTTTTTTTTTTTTTTTTT0",
      sourceN: 19,
      sourceHash: "sha256:00000000000000aa",
      size: "1080p",
      aspect: "16:9",
      from: { width: 1344, height: 768 },
      to: { width: 1920, height: 1080 },
      crop: { edge: "top and bottom", percent: 2 },
    },
  };

  it("names its source by id, number and hash, and is a video take", () => {
    assert.equal(BenchRequestSnapshotSchema.safeParse(base).success, true);
    assert.equal(BenchRequestSnapshotSchema.safeParse({ ...base, mode: "image", params: { kind: "image", count: 1 } }).success, false);
  });
});

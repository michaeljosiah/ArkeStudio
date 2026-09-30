import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AppSettingsSchema,
  ClientMessageSchema,
  JobSamplingSchema,
  ModelSamplingSchema,
  SamplingSettingSchema,
  SamplingValuesSchema,
  effectiveSampling,
  samplingEstimateCopy,
  samplingEstimateSec,
  samplingOptions,
  samplingProblems,
  samplingSummary,
  type ModelSampling,
} from "../src/index.js";
import { isRemoteHostCommand } from "../src/remote-command-access.js";

const CATALOGUE: ModelSampling = {
  presets: [
    { id: "fast", values: { steps: 8, speedAdapter: 1, shift: 12, sampler: "euler", scheduler: "simple" } },
    { id: "balanced", values: { steps: 10, speedAdapter: 0.75, shift: 9, sampler: "euler", scheduler: "simple" } },
    { id: "quality", values: { steps: 12, speedAdapter: 0.5, shift: 6, sampler: "euler", scheduler: "simple" } },
  ],
  samplers: ["euler", "dpmpp_2m", "ddim"],
  schedulers: ["simple", "beta", "ddim_uniform"],
  clipSec: 10,
};
const custom = { steps: 20, speedAdapter: 0.6, shift: 7.5, sampler: "dpmpp_2m", scheduler: "beta" };

describe("sampling bounds (design turn 177)", () => {
  it("accepts the edges and refuses one past each", () => {
    assert.ok(SamplingValuesSchema.safeParse({ ...custom, steps: 4, speedAdapter: 0, shift: 1 }).success);
    assert.ok(SamplingValuesSchema.safeParse({ ...custom, steps: 30, speedAdapter: 1, shift: 15 }).success);
    for (const bad of [{ steps: 3 }, { steps: 31 }, { steps: 8.5 }, { speedAdapter: 1.05 }, { speedAdapter: -0.05 }, { speedAdapter: 0.33 }, { shift: 0.9 }, { shift: 15.1 }]) {
      assert.equal(SamplingValuesSchema.safeParse({ ...custom, ...bad }).success, false, JSON.stringify(bad));
    }
  });

  it("the speed adapter moves in 0.05, float noise and all", () => {
    assert.ok(SamplingValuesSchema.safeParse({ ...custom, speedAdapter: 0.1 + 0.05 }).success);
    assert.ok(SamplingValuesSchema.safeParse({ ...custom, speedAdapter: 0.35 }).success);
  });

  it("a preset stores its name only; Custom stores its values", () => {
    assert.ok(SamplingSettingSchema.safeParse({ preset: "quality" }).success);
    assert.equal(SamplingSettingSchema.safeParse({ preset: "quality", values: custom }).success, false);
    assert.equal(SamplingSettingSchema.safeParse({ preset: "custom" }).success, false);
    assert.ok(SamplingSettingSchema.safeParse({ preset: "custom", values: custom }).success);
  });

  it("a catalogue lists fast first and each preset once", () => {
    assert.ok(ModelSamplingSchema.safeParse(CATALOGUE).success);
    assert.equal(ModelSamplingSchema.safeParse({ ...CATALOGUE, presets: [...CATALOGUE.presets].reverse() }).success, false);
  });

  it("the wire message carries a setting or null, and a paired browser may send it", () => {
    const message = { kind: "set-local-sampling", recipeId: "comfyui-h3-video", sampling: { preset: "balanced" } };
    assert.ok(ClientMessageSchema.safeParse(message).success);
    assert.ok(ClientMessageSchema.safeParse({ ...message, sampling: null }).success);
    assert.equal(ClientMessageSchema.safeParse({ ...message, sampling: { preset: "custom", values: { ...custom, steps: 40 } } }).success, false);
    assert.equal(isRemoteHostCommand(ClientMessageSchema.parse(message)), false);
  });

  it("a malformed block in the settings file costs the choices, never the file", () => {
    const settings = AppSettingsSchema.parse({ localSampling: { choices: { x: { preset: "custom" } } } });
    assert.deepEqual(settings.localSampling, { choices: {}, timings: {} });
    assert.deepEqual(AppSettingsSchema.parse({}).localSampling, { choices: {}, timings: {} });
  });
});

describe("effective sampling", () => {
  it("nothing stored is Fast, a preset resolves from the catalogue, Custom keeps its values", () => {
    assert.deepEqual(effectiveSampling(CATALOGUE, undefined), { preset: "fast", ...CATALOGUE.presets[0]!.values });
    assert.deepEqual(effectiveSampling(CATALOGUE, { preset: "quality" }), { preset: "quality", ...CATALOGUE.presets[2]!.values });
    assert.deepEqual(effectiveSampling(CATALOGUE, { preset: "custom", values: custom }), { preset: "custom", ...custom });
    assert.ok(JobSamplingSchema.safeParse(effectiveSampling(CATALOGUE, { preset: "custom", values: custom })).success);
  });

  it("a stored Custom the catalogue no longer vouches for falls back to Fast", () => {
    const narrowed = { ...CATALOGUE, samplers: ["euler"] };
    assert.equal(effectiveSampling(narrowed, { preset: "custom", values: custom }).preset, "fast");
  });
});

describe("Custom's checks and options", () => {
  it("names each field that cannot be saved", () => {
    assert.deepEqual(samplingProblems(custom, CATALOGUE), []);
    assert.deepEqual(samplingProblems({ ...custom, steps: 40, shift: Number.NaN, sampler: "lcm" }, CATALOGUE), ["steps", "shift", "sampler"]);
  });

  it("narrows the allow-list to what the engine advertises, and ignores an answer that names none of it", () => {
    const engine = { samplers: ["euler", "ddim", "lcm"], schedulers: ["simple", "karras"] };
    assert.deepEqual(samplingOptions(CATALOGUE, engine), { samplers: ["euler", "ddim"], schedulers: ["simple"] });
    assert.deepEqual(samplingProblems(custom, CATALOGUE, engine), ["sampler", "scheduler"]);
    assert.deepEqual(samplingOptions(CATALOGUE, { samplers: ["lcm"], schedulers: [] }), { samplers: CATALOGUE.samplers, schedulers: CATALOGUE.schedulers });
    assert.deepEqual(samplingOptions(CATALOGUE, null), { samplers: CATALOGUE.samplers, schedulers: CATALOGUE.schedulers });
  });

  it("summarises values, naming the sampler only where it differs from Fast", () => {
    assert.equal(samplingSummary(CATALOGUE.presets[2]!.values), "12 steps · speed 0.5 · shift 6");
    assert.equal(samplingSummary(custom, CATALOGUE.presets[0]!.values), "20 steps · speed 0.6 · shift 7.5 · dpmpp_2m · beta");
  });
});

describe("the measured time", () => {
  it("is a dash until a run completes, then the mean per-step time times the steps plus the fixed time", () => {
    assert.equal(samplingEstimateSec(undefined, 8), null);
    assert.equal(samplingEstimateCopy(samplingEstimateSec([], 8)), "—");
    const samples = [
      { secPerStep: 50, fixedSec: 100, at: "2026-09-30T10:00:00.000Z" },
      { secPerStep: 70, fixedSec: 140, at: "2026-09-30T11:00:00.000Z" },
    ];
    assert.equal(samplingEstimateSec(samples, 8), 60 * 8 + 120);
    assert.equal(samplingEstimateCopy(600), "~10 min");
    assert.equal(samplingEstimateCopy(42), "~42 s");
  });
});

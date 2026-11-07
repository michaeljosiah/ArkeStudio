import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AppSettingsSchema,
  ClientMessageSchema,
  JobSamplingSchema,
  LocalSamplingSettingsSchema,
  ModelSamplingSchema,
  SamplingSettingSchema,
  SamplingValuesSchema,
  effectiveSampling,
  localRunCopy,
  localRunEstimate,
  samplingEstimateCopy,
  samplingEstimateSec,
  samplingOptions,
  samplingProblems,
  samplingSummary,
  type LocalRunSample,
  type LocalSamplingSettings,
  type ManifestModel,
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

  it("uses the median, so one cold start that loads every weight does not move the figure", () => {
    const at = "2026-09-30T10:00:00.000Z";
    const samples = [
      { secPerStep: 60, fixedSec: 100, at },
      { secPerStep: 60, fixedSec: 100, at },
      { secPerStep: 180, fixedSec: 600, at },
    ];
    assert.equal(samplingEstimateSec(samples, 8), 60 * 8 + 100);
  });
});

describe("the time beside Generate (issue 2401)", () => {
  const at = "2026-11-03T10:00:00.000Z";
  const row = (extra: Partial<ManifestModel> = {}): ManifestModel =>
    ({
      id: "local",
      provider: "comfyui",
      capability: "image",
      displayName: "Local",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "unmetered" },
      ...extra,
    }) as ManifestModel;
  const settings = (extra: Partial<LocalSamplingSettings> = {}): LocalSamplingSettings => ({ choices: {}, timings: {}, ...extra });
  const run = (engineSec: number, extra: Partial<LocalRunSample> = {}): LocalRunSample => ({ engineSec, at, ...extra });

  it("says nothing for a cloud row, whatever is recorded under its id", () => {
    const cloud = row({ pricing: { kind: "perImage", microUsdPerImage: 80_000 } });
    assert.equal(localRunEstimate(cloud, {}, settings({ runs: { local: [run(30)] } })), null);
  });

  it("falls back to the catalogue's reference run, then to nothing", () => {
    const typical = row({ pricing: { kind: "unmetered", typicalRunSec: 636 } });
    assert.deepEqual(localRunEstimate(typical, {}, undefined), { seconds: 636, source: "reference" });
    assert.equal(localRunEstimate(row(), {}, undefined), null);
  });

  it("prefers this machine's runs to the catalogue's", () => {
    const typical = row({ pricing: { kind: "unmetered", typicalRunSec: 636 } });
    assert.deepEqual(localRunEstimate(typical, {}, settings({ runs: { local: [run(200)] } })), { seconds: 200, source: "machine" });
  });

  it("takes the median of whole runs, which a slow first load barely moves", () => {
    const runs = { local: [run(60), run(62), run(600), run(58), run(61)] };
    assert.deepEqual(localRunEstimate(row(), {}, settings({ runs })), { seconds: 61, source: "machine" });
  });

  it("reads only runs that ran like the request: size within a quarter, length within a second", () => {
    const runs = {
      local: [
        run(60, { megapixels: 1 }),
        run(240, { megapixels: 4 }),
        run(100, { durationSec: 5 }),
        run(300, { durationSec: 15 }),
      ],
    };
    const measured = settings({ runs });
    assert.equal(localRunEstimate(row(), { megapixels: 4.5, durationSec: 15 }, measured)?.seconds, 270, "the 1 MP and the 5 s runs are out");
    // 1.25 MP is the edge of a quarter either way; 1.34 MP is past it.
    assert.equal(localRunEstimate(row(), { megapixels: 1.25, durationSec: 5 }, settings({ runs: { local: [run(60, { megapixels: 1 })] } }))?.seconds, 60);
    assert.equal(localRunEstimate(row(), { megapixels: 2 }, settings({ runs: { local: [run(60, { megapixels: 1 })] } })), null);
    assert.equal(localRunEstimate(row(), { durationSec: 7 }, settings({ runs: { local: [run(100, { durationSec: 5 })] } })), null);
    assert.equal(localRunEstimate(row(), { durationSec: 6 }, settings({ runs: { local: [run(100, { durationSec: 5 })] } }))?.seconds, 100);
  });

  it("does not mix a reference route's runs with the plain route's", () => {
    const measured = settings({ runs: { local: [run(100), run(900, { route: "reference" })] } });
    assert.equal(localRunEstimate(row(), {}, measured)?.seconds, 100);
    assert.equal(localRunEstimate(row(), { route: "reference" }, measured)?.seconds, 900);
  });

  it("states a sampled recipe's time from its per-step timings, at the chosen preset and length", () => {
    const sampled = row({ capability: "video", sampling: CATALOGUE });
    const timings = { local: [{ secPerStep: 60, fixedSec: 120, at }] };
    // Fast is 8 steps; the timings are stated for the catalogue's 10 s clip.
    assert.equal(localRunEstimate(sampled, { durationSec: 10 }, settings({ timings }))?.seconds, 60 * 8 + 120);
    assert.equal(localRunEstimate(sampled, { durationSec: 5 }, settings({ timings }))?.seconds, 60 * 4 + 120);
    const quality = settings({ timings, choices: { local: { preset: "quality" } } });
    assert.equal(localRunEstimate(sampled, { durationSec: 10 }, quality)?.seconds, 60 * 12 + 120);
    assert.equal(localRunEstimate(sampled, {}, settings({ timings }))?.seconds, 60 * 8 + 120, "no length is the catalogue's own clip");
  });

  it("does not read a whole run sampled at other steps as this preset's", () => {
    const sampled = row({ capability: "video", sampling: CATALOGUE });
    const runs = { local: [run(900, { steps: 12 })] };
    assert.equal(localRunEstimate(sampled, {}, settings({ runs })), null, "Fast is 8 steps");
    assert.equal(localRunEstimate(sampled, {}, settings({ runs, choices: { local: { preset: "quality" } } }))?.seconds, 900);
  });

  it("states an upscaler's time as its measured rate times what it would make", () => {
    const upscaler = row({ capability: "video", upscale: { size: "1080p", minEngineVersion: "0.38.0" } });
    const rates = { local: [{ secPerOutputSec: 120, at }] };
    assert.equal(localRunEstimate(upscaler, { durationSec: 7 }, settings({ rates }))?.seconds, 840);
  });

  it("says which machine a figure is from, and multiplies by the takes a press makes", () => {
    assert.equal(localRunCopy({ seconds: 240, source: "machine" }), "~4 min");
    assert.equal(localRunCopy({ seconds: 636, source: "reference" }), "~11 min · reference");
    assert.equal(localRunCopy({ seconds: 40, source: "machine" }, 3), "~2 min");
    assert.equal(localRunCopy(null), null);
  });

  it("a settings file with runs in it reads back whole, and one without them still reads", () => {
    const stored = { choices: {}, timings: {}, runs: { local: [run(60, { megapixels: 1, durationSec: 5, steps: 8, route: "reference" })] } };
    assert.deepEqual(LocalSamplingSettingsSchema.parse(stored), stored);
    assert.equal(LocalSamplingSettingsSchema.parse({ choices: {}, timings: {} }).runs, undefined);
    assert.equal(LocalSamplingSettingsSchema.safeParse({ choices: {}, timings: {}, runs: { local: [{ engineSec: 0, at }] } }).success, false);
  });
});

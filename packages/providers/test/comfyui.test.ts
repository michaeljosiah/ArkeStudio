import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatchDuration, durationOptions, estimateMicroUsd } from "@arke-studio/contracts";
import { ComfyUiClient, COMFYUI_VERSION_FLOOR, meetsVersionFloor } from "../src/clients/comfyui.js";
import {
  callerParamNames,
  COMFYUI_MANIFEST_MODELS,
  COMFYUI_RECIPES,
  comfyUiRecipeById,
  comfyUiRecipeIdentity,
  recipeDependencyDigest,
  recipeNodeClasses,
  recipeTemplateDigest,
  SDXL_BUCKETS,
  substituteRecipeParams,
  wanFramesForSeconds,
} from "../src/comfyui/recipes.js";
import { redactComfyUiBody, scrubPaths } from "../src/comfyui/redact.js";
import { captureProviderClient } from "../src/capture.js";
import { FalClient } from "../src/clients/fal.js";
import { SHIPPED_MANIFEST } from "../src/manifest-data.js";
import type { FetchLike } from "../src/types.js";

/**
 * SPEC-021 §3.2: recipes round-trip like any model, substitution cannot alter structure, the
 * client speaks the pinned API shape, cancellation is targeted, and no graph survives capture.
 */

const OK_PREFLIGHT = async () => ({ ok: true }) as const;
const BASE = () => "http://127.0.0.1:8188";

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch fake that records what was sent: route → {status, body}, matched in order. */
function engineFake(routes: Array<{ match: RegExp; status: number; body?: unknown; bytes?: Uint8Array }>): {
  fetch: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const hit = routes.find((r) => r.match.test(url));
    if (!hit) throw new Error(`ECONNREFUSED ${url}`);
    if (hit.bytes) return new Response(Buffer.from(hit.bytes), { status: hit.status });
    return new Response(hit.body !== undefined ? JSON.stringify(hit.body) : "", { status: hit.status });
  };
  return { fetch, calls };
}

// ---------------------------------------------------------------------------
// The catalogue and its projection (R-2, R-3)
// ---------------------------------------------------------------------------

describe("the recipe catalogue projects into the manifest like any other model", () => {
  it("every recipe has exactly one manifest row, and no row leaks a graph", () => {
    for (const recipe of COMFYUI_RECIPES) {
      const rows = SHIPPED_MANIFEST.models.filter((m) => m.id === recipe.id);
      assert.equal(rows.length, 1, recipe.id);
      const row = rows[0]!;
      assert.equal(row.provider, "comfyui");
      assert.equal(row.capability, recipe.capability);
      assert.equal(row.pricing.kind, "unmetered");
      assert.equal(row.requires?.vramMb, recipe.hardware.minVramMb);
      // The projection is the boundary (R-1): nothing graph-shaped crosses it.
      assert.equal(JSON.stringify(row).includes("class_type"), false);
    }
  });

  it("estimates at zero, so pass packing and pre-dispatch arithmetic need no special case", () => {
    for (const row of COMFYUI_MANIFEST_MODELS) {
      assert.equal(estimateMicroUsd(row, { durationSec: 5, images: 1 }), 0);
    }
  });

  it("the video row's lengths round-trip through dispatchDuration as numbers with real frames", () => {
    const row = SHIPPED_MANIFEST.models.find((m) => m.id === "comfyui-draft-video")!;
    assert.deepEqual(durationOptions(row), [2, 3, 5]);
    for (const seconds of durationOptions(row)) {
      const choice = dispatchDuration(row, seconds);
      assert.equal(choice.kind, "asked");
      if (choice.kind === "asked") {
        assert.equal(typeof choice.wire, "number");
        // Every offered length maps to a legal Wan latent length (4k+1 frames at 24 fps).
        const frames = wanFramesForSeconds(choice.wire as number);
        assert.notEqual(frames, null, `${seconds}s`);
        assert.equal((frames! - 1) % 4, 0, `${frames} frames is 4k+1`);
      }
    }
    // Longer than the longest is refused at planning, not discovered at the engine.
    assert.equal(dispatchDuration(row, 8).kind, "over-cap");
  });

  it("zero custom nodes ship (D11), while every checkpoint pin is a real digest", () => {
    for (const recipe of COMFYUI_RECIPES) {
      assert.equal(recipe.requires.customNodes.length, 0, recipe.id);
      assert.ok(recipe.requires.checkpoints.length > 0, recipe.id);
      for (const checkpoint of recipe.requires.checkpoints) {
        assert.match(checkpoint.sha256, /^[0-9a-f]{64}$/, checkpoint.file);
        assert.ok(checkpoint.sizeMb > 0);
        assert.match(checkpoint.url, /^https:\/\/huggingface\.co\//);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Substitution (T-3): declared leaf slots, and nothing else
// ---------------------------------------------------------------------------

describe("substitution cannot alter structure", () => {
  const image = comfyUiRecipeById("comfyui-draft-image")!;
  const video = comfyUiRecipeById("comfyui-draft-video")!;

  it("writes a validated value into exactly the bound slots", () => {
    const graph = substituteRecipeParams(image, { prompt: "a tide-clock", width: 1216, height: 832, seed: 7 });
    assert.equal(graph["6"]!.inputs["text"], "a tide-clock");
    assert.equal(graph["5"]!.inputs["width"], 1216);
    assert.equal(graph["3"]!.inputs["seed"], 7);
    // The negative prompt is recipe-authoring, not a control: untouched.
    assert.equal(graph["7"]!.inputs["text"], "blurry, deformed, watermark, text");
  });

  it("rejects a param not on the list (R-2)", () => {
    assert.throws(
      () => substituteRecipeParams(image, { prompt: "x", width: 1024, height: 1024, sampler_name: "ddim" }),
      /not a parameter/,
    );
  });

  it("refuses a missing required param — no placeholder ever ships as real work", () => {
    assert.throws(() => substituteRecipeParams(image, { width: 1024, height: 1024 }), /"prompt" is required/);
  });

  it("enforces every value against the recipe's own schema", () => {
    assert.throws(
      () => substituteRecipeParams(video, { prompt: "x", durationSec: 7, aspect: "16:9", length: 121, width: 1280, height: 704 }),
      /must be one of 2, 3, 5/,
    );
    assert.throws(
      () => substituteRecipeParams(image, { prompt: "y".repeat(2001), width: 1024, height: 1024 }),
      /over 2000 characters/,
    );
    assert.throws(
      () => substituteRecipeParams(image, { prompt: "x", width: 10_000, height: 1024 }),
      /over 2048/,
    );
  });

  it("a binding aimed at a link slot refuses rather than severing an edge", () => {
    const sabotaged = {
      ...image,
      params: { ...image.params, prompt: { ...image.params["prompt"]!, bind: [["3", "model"]] as const } },
    };
    assert.throws(
      () => substituteRecipeParams(sabotaged, { prompt: "x", width: 1024, height: 1024 }),
      /link slot .* structure is not substitutable/,
    );
  });

  it("a binding naming a slot the template does not declare refuses", () => {
    const sabotaged = {
      ...image,
      params: { ...image.params, prompt: { ...image.params["prompt"]!, bind: [["6", "lora_path"]] as const } },
    };
    assert.throws(() => substituteRecipeParams(sabotaged, { prompt: "x", width: 1024, height: 1024 }), /does not declare/);
  });

  it("never mutates the shipped template — the catalogue is frozen", () => {
    assert.throws(() => {
      (image.graph["6"]!.inputs as Record<string, unknown>)["text"] = "mutated";
    }, TypeError);
    const before = recipeTemplateDigest(image);
    substituteRecipeParams(image, { prompt: "one", width: 1024, height: 1024 });
    assert.equal(recipeTemplateDigest(image), before);
  });

  it("internal params are not caller-facing", () => {
    const names = callerParamNames(video);
    assert.ok(names.has("prompt"));
    assert.ok(names.has("durationSec"));
    assert.equal(names.has("length"), false);
    assert.equal(names.has("width"), false);
  });
});

describe("recipe identity (§2.11)", () => {
  const video = comfyUiRecipeById("comfyui-draft-video")!;

  it("is digests over canonical bytes: same content, same digest, whatever the key order", () => {
    const identity = comfyUiRecipeIdentity(video);
    assert.match(identity.templateDigest, /^[0-9a-f]{64}$/);
    assert.match(identity.dependencyDigest, /^[0-9a-f]{64}$/);
    const reordered = {
      ...video,
      requires: { ...video.requires, checkpoints: [...video.requires.checkpoints].reverse() },
    };
    assert.equal(recipeDependencyDigest(reordered), identity.dependencyDigest);
  });

  it("a changed pin is a different dependency digest", () => {
    const drifted = {
      ...video,
      requires: {
        ...video.requires,
        checkpoints: video.requires.checkpoints.map((c, i) =>
          i === 0 ? { ...c, sha256: "0".repeat(64) } : c,
        ),
      },
    };
    assert.notEqual(recipeDependencyDigest(drifted), recipeDependencyDigest(video));
  });

  it("names every node class the compatibility probe must find (D14)", () => {
    const classes = recipeNodeClasses(video);
    for (const wanted of ["UNETLoader", "CLIPLoader", "VAELoader", "Wan22ImageToVideoLatent", "KSampler", "SaveVideo"]) {
      assert.ok(classes.includes(wanted), wanted);
    }
  });
});

// ---------------------------------------------------------------------------
// The client (T-4, D14)
// ---------------------------------------------------------------------------

describe("the compatibility probe is the API floor (D14)", () => {
  it("no engine → both capabilities unavailable with the remedy, not an ENOENT", async () => {
    const client = new ComfyUiClient(engineFake([]).fetch, () => null, OK_PREFLIGHT);
    const probes = await client.validateKey("");
    assert.equal(probes.length, 2);
    assert.ok(probes.every((p) => !p.available && /no ComfyUI engine/.test(p.reason ?? "")));
  });

  it("an old engine is incompatible with its version named — never generically unavailable", async () => {
    const { fetch } = engineFake([
      { match: /system_stats/, status: 200, body: { system: { comfyui_version: "0.2.7" } } },
    ]);
    const probes = await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).validateKey("");
    assert.ok(probes.every((p) => !p.available));
    assert.match(probes[0]!.reason!, /0\.2\.7/);
    assert.match(probes[0]!.reason!, new RegExp(COMFYUI_VERSION_FLOOR.replace(/\./g, "\\.")));
  });

  it("an engine that reports no version is below the floor by definition", async () => {
    const { fetch } = engineFake([{ match: /system_stats/, status: 200, body: { system: {} } }]);
    const probes = await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).validateKey("");
    assert.ok(probes.every((p) => !p.available && /did not report/.test(p.reason ?? "")));
  });

  it("a modern engine unlocks both capabilities", async () => {
    const { fetch } = engineFake([
      { match: /system_stats/, status: 200, body: { system: { comfyui_version: "0.33.1" } } },
    ]);
    assert.deepEqual(await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).validateKey(""), [
      { capability: "image", available: true },
      { capability: "video", available: true },
    ]);
  });

  it("compares versions numerically, not lexically", () => {
    assert.equal(meetsVersionFloor("0.33.1"), true); // "0.33" < "0.3.45" lexically — the trap
    assert.equal(meetsVersionFloor("0.3.45"), true);
    assert.equal(meetsVersionFloor("0.3.44"), false);
    assert.equal(meetsVersionFloor("v0.4.0"), true);
    assert.equal(meetsVersionFloor("garbage"), null);
  });
});

describe("submit dispatches the substituted graph, and refuses before the wire when it must", () => {
  it("image: prompt and snapped bucket ride; the engine sees a whole, well-formed graph", async () => {
    const { fetch, calls } = engineFake([
      { match: /\/prompt$/, status: 200, body: { prompt_id: "p-1", number: 3, node_errors: {} } },
    ]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    const result = await client.submit("", {
      model: "comfyui-draft-image",
      capability: "image",
      params: { prompt: "the tide-clock at dusk", output: { width: 1216, height: 832, aspect: "3:2" }, provenance: { canonRevision: 1 } },
    });
    assert.equal(result.remoteId, "p-1");
    const posted = calls.find((c) => /\/prompt$/.test(c.url))!.body as {
      prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      client_id: string;
    };
    assert.equal(posted.client_id, "arke-studio");
    assert.equal(posted.prompt["6"]!.inputs["text"], "the tide-clock at dusk");
    assert.equal(posted.prompt["5"]!.inputs["width"], 1216);
    assert.equal(posted.prompt["9"]!.class_type, "SaveImage");
    // The coordinator's own keys never reach the engine.
    assert.equal(JSON.stringify(posted).includes("provenance"), false);
  });

  it("snaps an off-bucket size onto a real SDXL bucket rather than passing it through", async () => {
    // The previous test hands in dimensions that already ARE the 3:2 bucket, so it would pass
    // with the snap deleted. This one cannot: 1500x1000 is not a bucket, and an off-bucket
    // latent is exactly what makes SDXL generate badly.
    const { fetch, calls } = engineFake([
      { match: /\/prompt$/, status: 200, body: { prompt_id: "p-1", node_errors: {} } },
    ]);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
      model: "comfyui-draft-image",
      capability: "image",
      params: { prompt: "x", output: { width: 1500, height: 1000 } },
    });
    const posted = calls.find((c) => /\/prompt$/.test(c.url))!.body as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    const width = posted.prompt["5"]!.inputs["width"] as number;
    const height = posted.prompt["5"]!.inputs["height"] as number;
    assert.notEqual(width, 1500, "the requested size was not passed through");
    const buckets = Object.values(SDXL_BUCKETS);
    assert.ok(
      buckets.some((b) => b.width === width && b.height === height),
      `${width}x${height} is one of the training buckets`,
    );
    // 3:2 is the nearest shape to 1.5, so the snap is to the bucket, not merely to any bucket.
    assert.deepEqual({ width, height }, SDXL_BUCKETS["3:2"]);
  });

  it("video: seconds become the legal 4k+1 frame count and the aspect picks the dimensions", async () => {
    const { fetch, calls } = engineFake([
      { match: /\/prompt$/, status: 200, body: { prompt_id: "p-2", number: 4, node_errors: {} } },
    ]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    await client.submit("", {
      model: "comfyui-draft-video",
      capability: "video",
      params: { prompt: "harbour at dawn", durationSec: 3, aspect: "9:16" },
    });
    const posted = calls.find((c) => /\/prompt$/.test(c.url))!.body as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.equal(posted.prompt["7"]!.inputs["length"], 73);
    assert.equal(posted.prompt["7"]!.inputs["width"], 704);
    assert.equal(posted.prompt["7"]!.inputs["height"], 1280);
    assert.equal(posted.prompt["10"]!.inputs["fps"], 24);
  });

  it("accepts the params the real dispatch surfaces build, not only the neutral shape", async () => {
    // The bug this closes: the bench pre-converts a length through dispatchDuration and sends
    // `duration`, the production planner sends `durationSec`, and both send `resolution`. The
    // client's allow-list knew only `durationSec`, so every local video generation at a length
    // the picker openly offered failed terminally before reaching the engine. These are the
    // exact param shapes bench/service.ts and productions/ops.ts construct.
    const shapes: Array<{ label: string; params: Record<string, unknown>; frames: number }> = [
      { label: "bench, 3s chosen", params: { prompt: "harbour", duration: 3, resolution: "704p" }, frames: 73 },
      { label: "bench, 2s chosen", params: { prompt: "harbour", duration: 2 }, frames: 49 },
      { label: "productions, neutral", params: { prompt: "harbour", durationSec: 5, resolution: "704p" }, frames: 121 },
      { label: "nothing chosen", params: { prompt: "harbour" }, frames: 121 },
    ];
    for (const shape of shapes) {
      const { fetch, calls } = engineFake([
        { match: /\/prompt$/, status: 200, body: { prompt_id: "p-ok", node_errors: {} } },
      ]);
      const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
      await client.submit("", { model: "comfyui-draft-video", capability: "video", params: shape.params });
      const posted = calls.find((c) => /\/prompt$/.test(c.url))!.body as {
        prompt: Record<string, { inputs: Record<string, unknown> }>;
      };
      // Not merely accepted — the chosen length actually reaches the latent, rather than
      // silently defaulting while the estimate and the take record what the user picked.
      assert.equal(posted.prompt["7"]!.inputs["length"], shape.frames, shape.label);
    }
  });

  it("a length the recipe does not offer refuses, naming what it does offer", async () => {
    const { fetch } = engineFake([{ match: /\/prompt$/, status: 200, body: { prompt_id: "p" } }]);
    await assert.rejects(
      new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
        model: "comfyui-draft-video",
        capability: "video",
        params: { prompt: "x", duration: 4 },
      }),
      /cannot be asked for 4s — it offers 2, 3, 5s/,
    );
  });

  it("a failed pre-flight refuses before any request reaches the engine (§2.5, R-9)", async () => {
    const { fetch, calls } = engineFake([{ match: /\/prompt$/, status: 200, body: { prompt_id: "px" } }]);
    const client = new ComfyUiClient(fetch, BASE, async () => ({
      ok: false as const,
      reason: 'checkpoints\\sd_xl_base_1.0.safetensors does not match its pinned digest',
    }));
    await assert.rejects(
      client.submit("", { model: "comfyui-draft-image", capability: "image", params: { prompt: "x" } }),
      (err: Error & { submissionRejected?: boolean }) => {
        assert.match(err.message, /pinned digest/);
        assert.equal(err.submissionRejected, true, "a refusal is a rejection, never an ambiguous submission");
        return true;
      },
    );
    assert.equal(calls.length, 0, "nothing reached the engine");
  });

  it("references are refused — the row said none before commit (R-10)", async () => {
    const { fetch, calls } = engineFake([]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    await assert.rejects(
      client.submit("", {
        model: "comfyui-draft-image",
        capability: "image",
        params: { prompt: "x", references: ["references/kest.png"] },
      }),
      /takes no reference images/,
    );
    assert.equal(calls.length, 0);
  });

  it("an engine rejection is a rejection, not an ambiguous submission", async () => {
    const { fetch } = engineFake([
      {
        match: /\/prompt$/,
        status: 400,
        body: { error: { message: "invalid prompt" }, node_errors: { "7": { errors: [{ message: "length invalid" }] } } },
      },
    ]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    await assert.rejects(
      client.submit("", { model: "comfyui-draft-video", capability: "video", params: { prompt: "x" } }),
      (err: Error & { submissionRejected?: boolean }) => {
        assert.equal(err.submissionRejected, true);
        // A count, never node ids: this message becomes job.error and reaches the renderer (R-1).
        assert.match(err.message, /1 node\(s\) reported invalid/);
        assert.doesNotMatch(err.message, /nodes: 7/);
        return true;
      },
    );
  });

  it("a job whose catalogue has moved on refuses rather than running a different graph (R-15)", async () => {
    // The failure this closes: a v1 job sits queued across an app update, and the build it
    // wakes up in ships v2 under the same id. Freezing the identity at enqueue only helps if
    // something reads it — this is that read.
    const { fetch, calls } = engineFake([{ match: /\/prompt$/, status: 200, body: { prompt_id: "p-x" } }]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    const stale = { id: "comfyui-draft-image", version: 1, templateDigest: "0".repeat(64), dependencyDigest: "0".repeat(64) };
    await assert.rejects(
      client.submit("", {
        model: "comfyui-draft-image",
        capability: "image",
        params: { prompt: "x" },
        recipe: stale,
      }),
      (err: Error & { submissionRejected?: boolean }) => {
        assert.match(err.message, /refused rather than run against a different graph/);
        assert.match(err.message, /v1/);
        assert.equal(err.submissionRejected, true, "a refusal is terminal, never an ambiguous submission");
        return true;
      },
    );
    assert.equal(calls.length, 0, "nothing reached the engine");
  });

  it("the identity this build actually ships passes through unchanged", async () => {
    const { fetch } = engineFake([{ match: /\/prompt$/, status: 200, body: { prompt_id: "p-y" } }]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    const current = comfyUiRecipeIdentity(comfyUiRecipeById("comfyui-draft-image")!);
    const result = await client.submit("", {
      model: "comfyui-draft-image",
      capability: "image",
      params: { prompt: "x" },
      recipe: current,
    });
    assert.equal(result.remoteId, "p-y");
  });

  it("a changed pin alone is enough to refuse — the version need not have moved", async () => {
    // Recipes are versioned, not mutated (§2.3). If a build ever ships v1 with a different
    // pinned checkpoint, the digests diverge even though the version reads the same, and the
    // job is still not the job that was accepted.
    const { fetch } = engineFake([{ match: /\/prompt$/, status: 200, body: { prompt_id: "p-z" } }]);
    const current = comfyUiRecipeIdentity(comfyUiRecipeById("comfyui-draft-image")!);
    await assert.rejects(
      new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
        model: "comfyui-draft-image",
        capability: "image",
        params: { prompt: "x" },
        recipe: { ...current, dependencyDigest: "f".repeat(64) },
      }),
      /refused rather than run against a different graph/,
    );
  });

  it("an unknown model refuses — the catalogue is the only source of dispatchable work (R-1)", async () => {
    const client = new ComfyUiClient(engineFake([]).fetch, BASE, OK_PREFLIGHT);
    await assert.rejects(
      client.submit("", { model: "totally-made-up", capability: "image", params: { prompt: "x" } }),
      /not a shipped recipe/,
    );
  });
});

describe("poll maps the engine's two surfaces onto queue states, without inventing progress", () => {
  const queueWith = (running: string[], pending: string[]) => ({
    queue_running: running.map((id, i) => [i, id, {}, {}, []]),
    queue_pending: pending.map((id, i) => [i + 10, id, {}, {}, []]),
  });

  it("pending → queued, running → running, and no progress figure is invented (§1.2)", async () => {
    const { fetch } = engineFake([
      { match: /\/queue$/, status: 200, body: queueWith(["other"], ["p-9"]) },
    ]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    const queued = await client.poll("", "p-9");
    assert.deepEqual(queued, { state: "queued" });
    const { fetch: fetch2 } = engineFake([
      { match: /\/queue$/, status: 200, body: queueWith(["p-9"], []) },
    ]);
    assert.deepEqual(await new ComfyUiClient(fetch2, BASE, OK_PREFLIGHT).poll("", "p-9"), { state: "running" });
  });

  it("a completed history entry succeeds; an error entry fails with the engine's own message", async () => {
    const { fetch } = engineFake([
      { match: /\/queue$/, status: 200, body: queueWith([], []) },
      {
        match: /\/history\/p-ok$/,
        status: 200,
        body: { "p-ok": { status: { status_str: "success", completed: true }, outputs: {} } },
      },
    ]);
    assert.deepEqual(await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).poll("", "p-ok"), { state: "succeeded" });

    const { fetch: failed } = engineFake([
      { match: /\/queue$/, status: 200, body: queueWith([], []) },
      {
        match: /\/history\/p-bad$/,
        status: 200,
        body: {
          "p-bad": {
            status: {
              status_str: "error",
              completed: false,
              messages: [
                [
                  "execution_error",
                  {
                    exception_message: "CUDA out of memory loading C:\\Users\\alice\\ComfyUI\\models\\sd_xl.safetensors",
                    node_type: "KSampler",
                  },
                ],
              ],
            },
          },
        },
      },
    ]);
    const result = await new ComfyUiClient(failed, BASE, OK_PREFLIGHT).poll("", "p-bad");
    assert.equal(result.state, "failed");
    assert.match(result.error!, /CUDA out of memory/);
    // This string becomes job.error and renders in Activity: the filename is actionable, the
    // host path and the node's class type are not ours to show (R-1, SPEC-001 R-9).
    assert.match(result.error!, /sd_xl\.safetensors/);
    assert.doesNotMatch(result.error!, /C:\\Users|alice|KSampler/);
  });

  it("an id the engine no longer knows is a stated failure — its queue was in-memory", async () => {
    const { fetch } = engineFake([
      { match: /\/queue$/, status: 200, body: queueWith([], []) },
      { match: /\/history\/gone$/, status: 200, body: {} },
    ]);
    const result = await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).poll("", "gone");
    assert.equal(result.state, "failed");
    assert.match(result.error!, /no longer knows this prompt/);
  });
});

describe("fetch takes the recipe's declared output node, and nothing else (§2.6)", () => {
  it("fetches each named file through /view and ignores other nodes' outputs", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const { fetch, calls } = engineFake([
      {
        match: /\/history\/p-1$/,
        status: 200,
        body: {
          "p-1": {
            outputs: {
              // A preview node the graph never declared as THE output: ignored wholesale.
              "8": { images: [{ filename: "preview.png", subfolder: "", type: "temp" }] },
              "9": { images: [{ filename: "arke_00001_.png", subfolder: "", type: "output" }] },
            },
          },
        },
      },
      { match: /\/view\?/, status: 200, bytes: png },
    ]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    const artifacts = await client.fetchArtifacts("", "p-1", { model: "comfyui-draft-image" });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]!.contentType, "image/png");
    const views = calls.filter((c) => /\/view\?/.test(c.url));
    assert.equal(views.length, 1);
    assert.match(views[0]!.url, /arke_00001_\.png/);
    assert.doesNotMatch(views[0]!.url, /preview\.png/);
  });

  it("refuses without the recipe id — authoritative output selection cannot be guessed", async () => {
    const client = new ComfyUiClient(engineFake([]).fetch, BASE, OK_PREFLIGHT);
    await assert.rejects(client.fetchArtifacts("", "p-1"), /without the recipe id/);
  });
});

describe("cancellation targets only the requested prompt (R-17)", () => {
  const queue = (running: string, pending: string[]) => ({
    queue_running: [[0, running, {}, {}, []]],
    queue_pending: pending.map((id, i) => [i + 1, id, {}, {}, []]),
  });

  it("a pending prompt is deleted by id — the running one is untouched", async () => {
    const { fetch, calls } = engineFake([
      { match: /\/queue$/, status: 200, body: queue("someone-elses", ["mine"]) },
    ]);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).cancel("", "mine");
    const posts = calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1);
    assert.match(posts[0]!.url, /\/queue$/);
    assert.deepEqual(posts[0]!.body, { delete: ["mine"] });
  });

  it("the running prompt is interrupted only when it is provably ours", async () => {
    const { fetch, calls } = engineFake([
      { match: /\/queue$/, status: 200, body: queue("mine", []) },
      { match: /\/interrupt$/, status: 200, body: {} },
    ]);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).cancel("", "mine");
    assert.ok(calls.some((c) => /\/interrupt$/.test(c.url)));
  });

  it("a stranger's running prompt on a shared engine is left exactly alone", async () => {
    const { fetch, calls } = engineFake([
      { match: /\/queue$/, status: 200, body: queue("someone-elses", []) },
    ]);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).cancel("", "mine");
    assert.equal(calls.filter((c) => c.method === "POST").length, 0, "no delete, no interrupt");
  });
});

// ---------------------------------------------------------------------------
// Capture redaction (§2.10, R-14)
// ---------------------------------------------------------------------------

describe("no graph survives capture", () => {
  const graph = comfyUiRecipeById("comfyui-draft-image")!.graph;

  it("a /prompt request persists digest, node count and byte count — never the graph", () => {
    const redacted = redactComfyUiBody("request", "http://127.0.0.1:8188/prompt", {
      prompt: graph,
      client_id: "arke-studio",
    }) as { prompt: Record<string, unknown>; client_id: string };
    assert.equal(redacted.client_id, "arke-studio");
    assert.equal(redacted.prompt["comfyui"], "graph-redacted");
    assert.match(String(redacted.prompt["graphDigest"]), /^sha256:[0-9a-f]{64}$/);
    assert.equal(redacted.prompt["nodeCount"], Object.keys(graph).length);
    assert.ok((redacted.prompt["byteCount"] as number) > 0);
    assert.equal(JSON.stringify(redacted).includes("class_type"), false);
  });

  it("a graph far over the 512 KiB record cap becomes a fixed-size summary — dispatch is never blocked", () => {
    const huge: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
    for (let i = 0; i < 20_000; i++) huge[String(i)] = { class_type: "KSampler", inputs: { text: "x".repeat(40) } };
    const redacted = redactComfyUiBody("request", "http://x/prompt", { prompt: huge }) as Record<string, unknown>;
    assert.ok(Buffer.byteLength(JSON.stringify(redacted), "utf8") < 1024, "summary stays tiny");
    assert.ok(((redacted["prompt"] as Record<string, unknown>)["byteCount"] as number) > 512 * 1024);
  });

  it("a FAILED history entry loses its traceback, current_inputs, node id and node type", () => {
    // The shape ComfyUI actually returns for an execution failure: `current_inputs` is the
    // failing node's resolved inputs — a literal graph fragment — and `traceback` is a list of
    // absolute engine paths. The success-shaped test below never exercised either.
    const redacted = redactComfyUiBody("response", "http://127.0.0.1:8188/history/p-1", {
      "p-1": {
        prompt: [3, "p-1", graph, {}, ["9"]],
        status: {
          status_str: "error",
          completed: false,
          messages: [
            ["execution_start", { prompt_id: "p-1" }],
            [
              "execution_error",
              {
                prompt_id: "p-1",
                node_id: "3",
                node_type: "KSampler",
                exception_type: "torch.cuda.OutOfMemoryError",
                exception_message: "CUDA out of memory loading C:\\Users\\alice\\ComfyUI\\models\\checkpoints\\sd_xl_base_1.0.safetensors",
                traceback: ["File \"C:\\\\Users\\\\alice\\\\ComfyUI\\\\execution.py\", line 317, in execute"],
                current_inputs: { text: "the tide-clock at dusk", ckpt_name: "sd_xl_base_1.0.safetensors" },
                current_outputs: [],
              },
            ],
          ],
        },
        meta: { "9": { node_id: "9", display_node: "9", real_node_id: "9" } },
      },
    }) as Record<string, Record<string, unknown>>;
    const text = JSON.stringify(redacted);
    // No graph fragment, no traceback, no node identity.
    assert.equal(text.includes("current_inputs"), false);
    assert.equal(text.includes("traceback"), false);
    assert.equal(text.includes("execution.py"), false);
    assert.equal(text.includes("KSampler"), false);
    assert.equal(text.includes("node_id"), false);
    assert.equal(text.includes("the tide-clock at dusk"), false);
    // No host path — the filename is the actionable half and survives.
    assert.equal(text.includes("C:\\\\Users"), false);
    assert.equal(text.includes("alice"), false);
    assert.match(text, /sd_xl_base_1\.0\.safetensors/);
    // What a diagnostic needs does survive: it failed, and why.
    assert.equal((redacted["p-1"]!["status"] as { status_str?: string }).status_str, "error");
    assert.match(text, /CUDA out of memory/);
    // A field nobody allow-listed cannot ride along, however upstream grows.
    assert.equal(text.includes("meta"), false);
  });

  it("scrubs windows and posix paths to basenames, leaving ordinary prose alone", () => {
    assert.equal(scrubPaths("cannot read C:\\Users\\alice\\models\\vae.safetensors"), "cannot read vae.safetensors");
    assert.equal(scrubPaths("missing /home/alice/comfy/models/x.ckpt here"), "missing x.ckpt here");
    assert.equal(scrubPaths("a plain sentence with no path in it"), "a plain sentence with no path in it");
    // A ratio is not a path.
    assert.equal(scrubPaths("aspect 16/9 selected"), "aspect 16/9 selected");
  });

  it("leaves URLs intact — the drive-letter rule must not read the 'p' of 'http'", () => {
    // The bug this closes: `[A-Za-z]:[\\/]` matched the "p://" of "http://", so the scrubber
    // ate the whole URL and left the last segment glued to "http" — deleting exactly the
    // detail a download or connection failure is about.
    assert.equal(
      scrubPaths("connect to http://127.0.0.1:8188/prompt refused"),
      "connect to http://127.0.0.1:8188/prompt refused",
    );
    assert.equal(
      scrubPaths("Failed to download https://huggingface.co/Comfy-Org/repo/resolve/main/wan.safetensors"),
      "Failed to download https://huggingface.co/Comfy-Org/repo/resolve/main/wan.safetensors",
    );
    // And still scrubs a real path standing next to one.
    assert.equal(
      scrubPaths("from https://host/a/b into C:\\Users\\alice\\models\\wan.safetensors"),
      "from https://host/a/b into wan.safetensors",
    );
  });

  it("a history response's embedded prompt tuple is redacted; status and outputs survive", () => {
    const redacted = redactComfyUiBody("response", "http://127.0.0.1:8188/history/p-1", {
      "p-1": {
        prompt: [3, "p-1", graph, { extra: true }, ["9"]],
        status: { status_str: "success", completed: true },
        outputs: { "9": { images: [{ filename: "arke_00001_.png" }] } },
      },
    }) as Record<string, Record<string, unknown>>;
    assert.equal(JSON.stringify(redacted).includes("class_type"), false);
    assert.deepEqual(redacted["p-1"]!["status"], { status_str: "success", completed: true });
    // The filenames survive; the node ids that keyed them do not.
    assert.match(JSON.stringify(redacted["p-1"]!["outputs"]), /arke_00001_/);
    assert.equal(JSON.stringify(redacted["p-1"]!["outputs"]).includes('"9"'), false);
  });

  it("a queue response keeps ids and positions, and drops every embedded graph", () => {
    const redacted = redactComfyUiBody("response", "http://127.0.0.1:8188/queue", {
      queue_running: [[0, "p-1", graph, {}, ["9"]]],
      queue_pending: [[1, "p-2", graph, {}, ["9"]]],
    }) as { queue_running: unknown[][]; queue_pending: unknown[][] };
    assert.deepEqual(redacted.queue_running, [[0, "p-1"]]);
    assert.deepEqual(redacted.queue_pending, [[1, "p-2"]]);
  });

  it("object_info is summarized to a count — megabytes of schemas answer one question", () => {
    const redacted = redactComfyUiBody("response", "http://x/object_info", {
      KSampler: { input: {} },
      SaveImage: { input: {} },
    }) as Record<string, unknown>;
    assert.deepEqual(redacted, { comfyui: "object-info-summarized", nodeClassCount: 2 });
  });

  it("other providers' bodies pass through untouched elsewhere", () => {
    const body = { prompt: "a plain string prompt for a fal route" };
    assert.deepEqual(redactComfyUiBody("request", "https://queue.fal.run/x/prompt", body), body);
  });

  it("the capture WIRING redacts, not just the redactor in isolation", async () => {
    // Every assertion above tests the pure function. None proved captureProviderClient actually
    // calls it for comfyui — deleting that one line in capture.ts would have left them all
    // green while every graph went to payload history verbatim.
    const started: Array<{ provider: string; endpoint: string; body: unknown }> = [];
    const capture = {
      start: async (input: { provider: string; endpoint: string; body: unknown }) => {
        started.push({ provider: input.provider, endpoint: input.endpoint, body: input.body });
        return "pc_1";
      },
      finish: async () => {},
      fail: async () => {},
    };
    const { fetch } = engineFake([{ match: /\/prompt$/, status: 200, body: { prompt_id: "p-1" } }]);
    const wrapped = captureProviderClient(
      "comfyui",
      (f) => new ComfyUiClient(f, BASE, OK_PREFLIGHT),
      fetch,
      capture as never,
    );
    await wrapped.submit("", { model: "comfyui-draft-image", capability: "image", params: { prompt: "x" } });
    const prompt = started.find((s) => s.endpoint.endsWith("/prompt"));
    assert.ok(prompt, "the submission was captured");
    const body = prompt!.body as { prompt: Record<string, unknown> };
    assert.equal(body.prompt["comfyui"], "graph-redacted");
    assert.equal(JSON.stringify(started).includes("class_type"), false);
  });

  it("a NON-comfyui provider's graph-shaped body is left alone by the same wiring", async () => {
    // The redaction is provider-aware; wiring it for everyone would quietly rewrite other
    // providers' payloads. This is the other half of that guarantee.
    const started: unknown[] = [];
    const capture = {
      start: async (input: { body: unknown }) => {
        started.push(input.body);
        return "pc_1";
      },
      finish: async () => {},
      fail: async () => {},
    };
    const echo: FetchLike = async () => new Response(JSON.stringify({ request_id: "r1" }), { status: 200 });
    const wrapped = captureProviderClient(
      "fal",
      (f) => new FalClient(f),
      echo,
      capture as never,
    );
    await wrapped
      .submit("k", { model: "seedance-2.0", capability: "video", params: { prompt: "x" } })
      .catch(() => {});
    assert.ok(started.length > 0);
    assert.equal(JSON.stringify(started).includes("graph-redacted"), false);
  });
});

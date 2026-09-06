import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import {
  characterSpeakingVideoRoutes,
  dispatchDuration,
  durationOptions,
  estimateMicroUsd,
  frameDispatchFor,
  modelCapabilityCopy,
} from "@arke-studio/contracts";
import { ComfyUiClient, COMFYUI_VERSION_FLOOR, meetsVersionFloor, type ProgressSocket } from "../src/clients/comfyui.js";
import {
  callerParamNames,
  COMFYUI_MANIFEST_MODELS,
  COMFYUI_RECIPES,
  comfyUiRecipeById,
  comfyUiRecipeIdentity,
  recipeDependencyDigest,
  recipeNodeClasses,
  h3FramesForSeconds,
  recipeTemplateDigest,
  SDXL_BUCKETS,
  substituteRecipeParams,
  wanFramesForSeconds,
} from "../src/comfyui/recipes.js";
import { redactComfyUiBody, scrubPaths } from "../src/comfyui/redact.js";
import { captureProviderClient } from "../src/capture.js";
import { FalClient } from "../src/clients/fal.js";
import { SHIPPED_MANIFEST } from "../src/manifest-data.js";
import { ProviderBusyError, type FetchLike } from "../src/types.js";

/**
 * SPEC-021 §3.2: recipes round-trip like any model, substitution cannot alter structure, the
 * client speaks the pinned API shape, cancellation is targeted, and no graph survives capture.
 */

const OK_PREFLIGHT = async () => ({ ok: true }) as const;
const BASE = () => "http://127.0.0.1:8188";
const VOICE_REFERENCE = {
  name: `${"a".repeat(64)}.wav`,
  contentType: "audio/wav" as const,
  data: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]),
};

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  redirect?: RequestRedirect;
  /** The upload's filename, when the request carried a form rather than JSON. */
  filename?: string;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", failed);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** A fetch fake that records what was sent: route → {status, body}, matched in order. */
function engineFake(routes: Array<{ match: RegExp; status: number; body?: unknown; bytes?: Uint8Array }>): {
  fetch: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    // A voice dispatch uploads its clip as multipart, so the recorded call keeps the filename
    // the engine was given — the value LoadAudio will later be asked for by name.
    const form = init?.body instanceof FormData ? init.body : null;
    const uploaded = form?.get("image");
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      ...(init?.redirect !== undefined ? { redirect: init.redirect } : {}),
      ...(uploaded instanceof File ? { filename: uploaded.name } : {}),
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

  it("every dependency a recipe declares is pinned to something verifiable", () => {
    // D11 said v1 ships zero custom nodes and any future node is vendored. The cloned-voice recipe
    // (SPEC-022) is that future node arriving: an engine of this class cannot run on core nodes.
    // So the invariant under test is the one D11 was protecting — nothing unpinned — rather than
    // the count it happened to state while the count was zero.
    for (const recipe of COMFYUI_RECIPES) {
      for (const node of recipe.requires.customNodes) {
        assert.match(node.pinnedRef, /^[0-9a-f]{40}$/, `${recipe.id}: ${node.id} needs a commit pin`);
      }
      for (const checkpoint of recipe.requires.checkpoints) {
        assert.match(checkpoint.sha256, /^[0-9a-f]{64}$/, checkpoint.file);
        assert.ok(checkpoint.sizeMb > 0);
        assert.match(checkpoint.url, /^https:\/\/huggingface\.co\//);
      }
    }
  });

  it("the image and video recipes still need no custom node (D11 holds where it was written)", () => {
    for (const id of ["comfyui-draft-image", "comfyui-draft-video", "comfyui-h3-video", "comfyui-h3-video-768"]) {
      const recipe = comfyUiRecipeById(id)!;
      assert.equal(recipe.requires.customNodes.length, 0, id);
      assert.ok(recipe.requires.checkpoints.length > 0, id);
    }
  });

  it("the h3 row's lengths round-trip as numbers on the model's own 17k+5 grid", () => {
    const row = SHIPPED_MANIFEST.models.find((m) => m.id === "comfyui-h3-video")!;
    // Every length H3 offers, in order, each one run on the reference machine: 5, 10 and 15 on
    // 2026-08-28, then 4, 6, 7 and 8 on 2026-09-06 (issue 848) so a DEFAULT_SHOT_SEC shot no
    // longer renders 124 frames for 96, and a 6 s shot no longer files as 10. 9 and 11–14 are
    // unrun and snap up. The RAM low-water marks are on the map's comment; none was a floor.
    assert.deepEqual(durationOptions(row), [4, 5, 6, 7, 8, 10, 15]);
    assert.equal(dispatchDuration(row, 20).kind, "over-cap");
    for (const seconds of durationOptions(row)) {
      const choice = dispatchDuration(row, seconds);
      assert.equal(choice.kind, "asked");
      if (choice.kind === "asked") {
        assert.equal(typeof choice.wire, "number");
        const frames = h3FramesForSeconds(choice.wire as number);
        assert.notEqual(frames, null, `${seconds}s`);
        assert.equal((frames! - 5) % 17, 0, `${frames} frames is 17k+5`);
      }
    }
    assert.equal(dispatchDuration(row, 20).kind, "over-cap");
  });

  it("h3 states two vram floors, and the row carries every machine floor the run measured", () => {
    const h3 = comfyUiRecipeById("comfyui-h3-video")!;
    // Card size and free-right-now are different questions: requiring the 10 GB card floor FREE
    // would refuse the exact configuration the recipe was verified on (~4.1 GB free, streaming).
    assert.equal(h3.hardware.minVramMb, 10000);
    assert.equal(h3.hardware.minFreeVramMb, 4000);
    assert.match(h3.hardware.floorSource, /measured through ComfyUI/);
    const row = COMFYUI_MANIFEST_MODELS.find((model) => model.id === h3.id)!;
    // System RAM was the resource the verified run nearly exhausted, so the floor lives on the
    // recipe (readiness enforces it — weights in a mapped folder never meet fitFor) and
    // projects into the row for setup's gate: one number, two enforcement points.
    assert.equal(h3.hardware.minMemMb, 30720);
    assert.equal(row.requires?.memMb, h3.hardware.minMemMb);
    // The authored runs-well boundary: between the minimum and this, offered but not recommended.
    assert.equal(row.requires?.recommendedVramMb, 24000);
    // int8_convrot and NVFP4 AWQ are CUDA quantisations, and the node-catalogue probe cannot
    // see that — the loader classes exist on every backend. Declared, so a big AMD card is
    // refused before the 42 GB download rather than at model load.
    assert.deepEqual(row.requires?.accelerator, ["cuda"]);
  });

  it("the h3 row is admitted as a speaking-sample route, stated untested and offered after the verified ones", () => {
    const routes = characterSpeakingVideoRoutes(SHIPPED_MANIFEST.models);
    const row = SHIPPED_MANIFEST.models.find((m) => m.id === "comfyui-h3-video")!;
    // The whole point of issue 863: one face and sound, both declared, and H3's sound is declared
    // as what it is — always emitted, no switch — rather than as a `generate_audio` it does not have.
    assert.equal(row.accepts.referenceImages, 1);
    assert.equal(row.limits.alwaysSound, true);
    assert.equal(row.limits.soundChoice, undefined);
    assert.ok(routes.some((m) => m.id === row.id), "h3 is offered as a speaking-sample route");
    // Offered, not defaulted: the picker's first entry is a verified route while H3's speech is
    // untested, which is what keeps a fifteen-minute local run from becoming the quiet default.
    assert.equal(row.speechVideo, "untested");
    assert.notEqual(routes[0]?.id, row.id);
  });

  it("the h3 row answers the one frame query the planner asks, on its own endpoint (issue 845)", () => {
    const row = SHIPPED_MANIFEST.models.find((m) => m.id === "comfyui-h3-video")!;
    // Before the mode was declared this answered null and every boundary frame fell back to a
    // cold text-to-video run — the accepted still, the drawn keyframe and the chained pass alike.
    const one = frameDispatchFor(row, 1);
    assert.ok(one !== null, "h3 takes a first frame");
    assert.equal(one.mode, "first-frame");
    // Not a sibling route: node 7 with `first_frame` bound is the image-to-video graph.
    assert.equal(one.route, null);
    assert.deepEqual(one.locked, []);
    // `last_frame` is on the node but has never been run under the floor, so it is not offered.
    assert.equal(frameDispatchFor(row, 2), null);
    // The picker's copy reads the same authority, and the draft row still claims nothing.
    assert.match(modelCapabilityCopy(row), /start frame/);
    const draft = SHIPPED_MANIFEST.models.find((m) => m.id === "comfyui-draft-video")!;
    assert.equal(frameDispatchFor(draft, 1), null);
    assert.doesNotMatch(modelCapabilityCopy(draft), /frame/);
    // The mode adds no duration vocabulary of its own, so a framed shot offers h3's own lengths.
    assert.deepEqual(durationOptions(row, { taskMode: "first-frame" }), [4, 5, 6, 7, 8, 10, 15]);
  });

  it("the h3 recipe is the first whose output carries sound, muxed by the graph itself (D14 names it)", () => {
    const recipe = comfyUiRecipeById("comfyui-h3-video")!;
    const classes = recipeNodeClasses(recipe);
    for (const wanted of [
      "UNETLoader",
      "LoraLoaderModelOnly",
      "MiniMaxH3SigmaShift",
      "MiniMaxH3ImageToVideo",
      "ConditioningZeroOut",
      "KSampler",
      "VAEDecode",
      "VAEDecodeAudio",
      "CreateVideo",
      "SaveVideo",
    ]) {
      assert.ok(classes.includes(wanted), wanted);
    }
    // The frames the FL2VA node could take stay unbound in v1 (R-2): no param reaches them.
    for (const spec of Object.values(recipe.params)) {
      for (const [, inputKey] of spec.bind) {
        assert.notEqual(inputKey, "first_frame");
        assert.notEqual(inputKey, "last_frame");
      }
    }
  });

  it("the cloned voice stays unavailable until its complete immutable dependency closure is catalogued", () => {
    const voice = comfyUiRecipeById("comfyui-cloned-voice")!;
    assert.equal(voice.capability, "voice-tts");
    assert.equal(voice.requires.customNodes[0]?.id, "TTS-Audio-Suite");
    // No invented files or hashes: production readiness refuses this recipe, so the node cannot
    // perform the old undeclared first-generation download.
    assert.deepEqual(voice.requires.checkpoints, []);
    assert.match(voice.requires.unavailableReason ?? "", /immutable TTS-Audio-Suite archive/);
    assert.match(voice.requires.unavailableReason ?? "", /hashed IndexTTS 2\.5 model files/);
    // 8 GB, not the 6 GB first shipped: the model measured 5.44 GB on a Python harness and the
    // recipe still could not finish on a 10 GB card, because the engine hosting it costs more and
    // the machine had 3.36 GB already spoken for. The floor carries that headroom because the
    // gate compares against TOTAL VRAM (SPEC-022 §2.6).
    assert.equal(voice.hardware.minVramMb, 8000);
    assert.match(voice.hardware.floorSource, /measured through ComfyUI/);
    const row = COMFYUI_MANIFEST_MODELS.find((model) => model.id === voice.id)!;
    assert.deepEqual(row.limits.deliveries, undefined, "the current graph exposes provider-default delivery only");
    assert.equal(JSON.stringify(voice.graph).includes("emotionAlpha"), false);
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
  it("no engine → every capability is unavailable with the remedy, not an ENOENT", async () => {
    const client = new ComfyUiClient(engineFake([]).fetch, () => null, OK_PREFLIGHT);
    const probes = await client.validateKey("");
    assert.equal(probes.length, 3);
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

  it("a modern engine unlocks every advertised capability", async () => {
    const { fetch } = engineFake([
      { match: /system_stats/, status: 200, body: { system: { comfyui_version: "0.33.1" } } },
    ]);
    assert.deepEqual(await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).validateKey(""), [
      { capability: "image", available: true },
      { capability: "video", available: true },
      { capability: "voice-tts", available: true },
    ]);
  });

  /*
   * #631. Every base here was written without a trailing slash, so nothing exercised the shape a
   * person actually saves: the URL field's placeholder reads `http://127.0.0.1:8188` and the
   * value stored from it may well end in `/`. Joined unchanged that asks for `//system_stats`,
   * which ComfyUI answers 404 to while serving `/system_stats` a 200 — so a healthy engine read
   * as "the engine did not answer" and every local recipe stayed disabled behind it.
   */
  it("a base with a trailing slash does not become a double slash", async () => {
    const { fetch, calls } = engineFake([
      { match: /system_stats/, status: 200, body: { system: { comfyui_version: "0.33.1" } } },
    ]);
    const probes = await new ComfyUiClient(fetch, () => "http://127.0.0.1:8188/", OK_PREFLIGHT).validateKey("");
    assert.ok(
      probes.every((probe) => probe.available),
      "a reachable engine behind a trailing-slash URL is still reachable",
    );
    assert.equal(calls[0]!.url, "http://127.0.0.1:8188/system_stats");
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
    const posted = calls.find((c) => c.url.endsWith("/prompt"))!.body as {
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
    const posted = calls.find((c) => c.url.endsWith("/prompt"))!.body as {
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
    const posted = calls.find((c) => c.url.endsWith("/prompt"))!.body as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.equal(posted.prompt["7"]!.inputs["length"], 73);
    assert.equal(posted.prompt["7"]!.inputs["width"], 704);
    assert.equal(posted.prompt["7"]!.inputs["height"], 1280);
    assert.equal(posted.prompt["10"]!.inputs["fps"], 24);
  });

  it("h3 768p: the same graph at the native size, offering only the length run there (issue 849)", async () => {
    const native = comfyUiRecipeById("comfyui-h3-video-768")!;
    const base = comfyUiRecipeById("comfyui-h3-video")!;
    // One graph, one set of weights, two recipes: the identity differs by id alone, so a job
    // frozen against either row is refused against the other and verified once per file.
    assert.deepEqual(native.graph, base.graph);
    assert.deepEqual(native.requires.checkpoints, base.requires.checkpoints);
    assert.equal(comfyUiRecipeIdentity(native).templateDigest, comfyUiRecipeIdentity(base).templateDigest);
    assert.notEqual(comfyUiRecipeIdentity(native).id, comfyUiRecipeIdentity(base).id);
    // Its own floors, measured on the reference card rather than transcribed from the 24 GB
    // boundary; the 24 GB figure stays the authored runs-well line.
    assert.equal(native.hardware.minVramMb, 10000);
    assert.equal(native.hardware.recommendedVramMb, 24000);
    assert.match(native.hardware.floorSource, /1344×768×124 frames/);
    const { fetch, calls } = engineFake([
      { match: /\/prompt$/, status: 200, body: { prompt_id: "p-768", number: 5, node_errors: {} } },
    ]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    await client.submit("", {
      model: "comfyui-h3-video-768",
      capability: "video",
      params: { prompt: "harbour at dawn, gulls crying", durationSec: 5, aspect: "16:9" },
    });
    const posted = calls.find((c) => c.url.endsWith("/prompt"))!.body as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.equal(posted.prompt["7"]!.inputs["length"], 124);
    assert.equal(posted.prompt["7"]!.inputs["width"], 1344);
    assert.equal(posted.prompt["7"]!.inputs["height"], 768);
    assert.equal(posted.prompt["15"], undefined, "text-to-video drops the frame carriers here too");
    // A length the 480p row offers is still refused here until it has been run at this size.
    await assert.rejects(
      client.submit("", { model: "comfyui-h3-video-768", capability: "video", params: { prompt: "x", durationSec: 10 } }),
      /cannot be asked for 10s — it offers 5s/,
    );
    // The row says the same: one length, one size, no frame mode and no reference budget.
    const row = SHIPPED_MANIFEST.models.find((m) => m.id === "comfyui-h3-video-768")!;
    assert.deepEqual(durationOptions(row), [5]);
    assert.deepEqual(row.limits.resolutions, ["768p"]);
    assert.equal(frameDispatchFor(row, 1), null);
    assert.equal(row.accepts.referenceImages, 0);
  });

  it("h3 video: seconds become the 17k+5 frame count, the aspect picks the verified dimensions", async () => {
    const { fetch, calls } = engineFake([
      { match: /\/prompt$/, status: 200, body: { prompt_id: "p-h3", number: 4, node_errors: {} } },
    ]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    await client.submit("", {
      model: "comfyui-h3-video",
      capability: "video",
      params: { prompt: "harbour at dawn, gulls crying", durationSec: 5, aspect: "9:16" },
    });
    const posted = calls.find((c) => c.url.endsWith("/prompt"))!.body as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.equal(posted.prompt["7"]!.inputs["length"], 124);
    assert.equal(posted.prompt["7"]!.inputs["width"], 480);
    assert.equal(posted.prompt["7"]!.inputs["height"], 864);
    // The prompt reaches the FL2VA node itself — it is the conditioning assembly, not CLIPTextEncode.
    assert.equal(posted.prompt["7"]!.inputs["prompt"], "harbour at dawn, gulls crying");
    assert.equal(posted.prompt["12"]!.inputs["fps"], 24);
    // No face sent, so the carrier nodes and the slot they fed are gone: this is byte for byte
    // the text-to-video graph v1 shipped, and `LoadImage.image` never reaches the engine holding
    // a placeholder it has no file for.
    assert.equal("first_frame" in posted.prompt["7"]!.inputs, false);
    assert.equal(posted.prompt["14"], undefined);
    assert.equal(posted.prompt["15"], undefined);
  });

  it("h3 video: one face is uploaded by its own bytes, cropped to the bucket, and bound as the first frame", async () => {
    const face = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
    const { fetch, calls } = engineFake([
      { match: /\/upload\/image$/, status: 200, body: { name: "kest.png", subfolder: "" } },
      { match: /\/prompt$/, status: 200, body: { prompt_id: "p-face", node_errors: {} } },
    ]);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
      model: "comfyui-h3-video",
      capability: "video",
      params: { prompt: "kest speaks to camera", durationSec: 5, aspect: "9:16", references: ["references/kest/main.png"] },
      imageReferences: [{ name: "reference-01.png", contentType: "image/png", data: face }],
    });
    const upload = calls.find((c) => c.url.endsWith("/upload/image"))!;
    // The world reader names references positionally, and the engine's input/ folder is one flat
    // namespace shared by every world on the machine — so the bytes name themselves before they go.
    assert.equal(upload.filename, `${createHash("sha256").update(face).digest("hex")}.png`);
    const posted = calls.find((c) => c.url.endsWith("/prompt"))!.body as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    // What the engine answered, not what was sent: LoadImage takes a name from its own folder.
    assert.equal(posted.prompt["14"]!.inputs["image"], "kest.png");
    assert.deepEqual(posted.prompt["7"]!.inputs["first_frame"], ["15", 0]);
    // The node's own resize of first_frame is a plain stretch, so the scaler crops to exactly the
    // canvas being generated — a portrait photo on a portrait bucket here, and the same numbers.
    assert.equal(posted.prompt["15"]!.inputs["crop"], "center");
    assert.equal(posted.prompt["15"]!.inputs["width"], 480);
    assert.equal(posted.prompt["15"]!.inputs["height"], 864);
    assert.equal(posted.prompt["7"]!.inputs["width"], 480);
    assert.equal(posted.prompt["7"]!.inputs["height"], 864);
  });

  it("h3 video: the planner's framed bag binds the boundary still as the first frame (issue 845)", async () => {
    // The exact bag the pass compiler emits for a first-frame route with no endpoint of its own
    // (issue 154): the still rides as the one reference, and its identity rides beside it. The
    // allow-list must let the identity through — refusing it would fail every framed shot on
    // the row the moment the mode was declared.
    const still = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 4, 4, 4, 4]);
    const { fetch, calls } = engineFake([
      { match: /\/upload\/image$/, status: 200, body: { name: "still.png", subfolder: "" } },
      { match: /\/prompt$/, status: 200, body: { prompt_id: "p-still", node_errors: {} } },
    ]);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
      model: "comfyui-h3-video",
      capability: "video",
      params: {
        prompt: "kest turns from the window",
        durationSec: 5,
        aspect: "16:9",
        references: ["artifacts/frame-shot-1.png"],
        taskMode: "first-frame",
        startFrame: "artifacts/frame-shot-1.png",
        frameArtifact: { id: "artifact-1", hash: "sha256:abc" },
        dispatchTiming: { slotSource: "shot-duration", slotDurationSec: 5, requestedDurationSec: 5, providerDurationMode: "requested", providerPaddingSec: 0 },
        provenance: { sheets: [] },
      },
      imageReferences: [{ name: "reference-01.png", contentType: "image/png", data: still }],
    });
    const posted = calls.find((c) => c.url.endsWith("/prompt"))!.body as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.equal(posted.prompt["14"]!.inputs["image"], "still.png");
    assert.deepEqual(posted.prompt["7"]!.inputs["first_frame"], ["15", 0]);
    assert.equal(posted.prompt["7"]!.inputs["length"], 124);
  });

  it("a recipe with one frame refuses two pictures, and one with none still refuses every picture", async () => {
    const picture = { name: "reference-01.png", contentType: "image/png" as const, data: Uint8Array.from([1, 2]) };
    const two = engineFake([{ match: /./, status: 200, body: { prompt_id: "p" } }]);
    await assert.rejects(
      new ComfyUiClient(two.fetch, BASE, OK_PREFLIGHT).submit("", {
        model: "comfyui-h3-video",
        capability: "video",
        params: { prompt: "x", references: ["a.png", "b.png"] },
        imageReferences: [picture, picture],
      }),
      /takes one reference image/,
    );
    assert.equal(two.calls.length, 0);
    const none = engineFake([{ match: /./, status: 200, body: { prompt_id: "p" } }]);
    await assert.rejects(
      new ComfyUiClient(none.fetch, BASE, OK_PREFLIGHT).submit("", {
        model: "comfyui-draft-video",
        capability: "video",
        params: { prompt: "x", references: ["a.png"] },
        imageReferences: [picture],
      }),
      /takes no reference images/,
    );
    assert.equal(none.calls.length, 0);
  });

  it("a face the queue named but never prepared refuses, rather than generating a stranger", async () => {
    const { fetch, calls } = engineFake([{ match: /./, status: 200, body: { prompt_id: "p" } }]);
    await assert.rejects(
      new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
        model: "comfyui-h3-video",
        capability: "video",
        params: { prompt: "x", references: ["references/kest/main.png"] },
      }),
      /reference image that never arrived/,
    );
    assert.equal(calls.length, 0);
  });

  it("a length h3 does not offer refuses with h3's own menu, not wan's", async () => {
    const { fetch } = engineFake([{ match: /\/prompt$/, status: 200, body: { prompt_id: "p" } }]);
    await assert.rejects(
      new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
        model: "comfyui-h3-video",
        capability: "video",
        params: { prompt: "x", duration: 3 },
      }),
      /cannot be asked for 3s — it offers 4, 5, 6, 7, 8, 10, 15s/,
    );
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
      { label: "productions, neutral", params: { prompt: "harbour", durationSec: 5, resolution: "704p", continuedFrom: "tk_01J8F0000000000000000000B2" }, frames: 121 },
      { label: "nothing chosen", params: { prompt: "harbour" }, frames: 121 },
    ];
    for (const shape of shapes) {
      const { fetch, calls } = engineFake([
        { match: /\/prompt$/, status: 200, body: { prompt_id: "p-ok", node_errors: {} } },
      ]);
      const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
      await client.submit("", { model: "comfyui-draft-video", capability: "video", params: shape.params });
      const posted = calls.find((c) => c.url.endsWith("/prompt"))!.body as {
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

describe("audio comes back as audio, so it can be verified (SPEC-022 spike)", () => {
  it("names a wav's type, rather than leaving it an unverifiable blob", async () => {
    // ComfyUI's audio save nodes emit the same {filename, subfolder, type} shape under a
    // different key, so the fetch itself was already format-agnostic. What was missing was the
    // TYPE: verifyArtifact dispatches on it, and an unnamed type falls through to "a non-empty
    // body is the best check available" — a truncated download filed as a take, played as silence.
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const { fetch, calls } = engineFake([
      {
        match: /\/history\/p-1$/,
        status: 200,
        body: {
          "p-1": {
            outputs: { "9": { audio: [{ filename: "arke_00001_.wav", subfolder: "", type: "output" }] } },
          },
        },
      },
      { match: /\/view\?/, status: 200, bytes: wav },
    ]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    const artifacts = await client.fetchArtifacts("", "p-1", { model: "comfyui-draft-image" });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]!.contentType, "audio/wav");
    assert.equal(artifacts[0]!.name, "output-1.wav");
    assert.match(calls.filter((c) => /\/view\?/.test(c.url))[0]!.url, /arke_00001_\.wav/);
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
    assert.ok(calls.some((c) => c.url.endsWith("/interrupt")));
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
      respond: async () => {},
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
      respond: async () => {},
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

/**
 * Speaking a line in a cloned voice (SPEC-022 T-10).
 *
 * Every one of these failed against the shipped client before the voice path existed, and none
 * of the 2,400 tests noticed: the recipe had only ever been proven by a graph posted by hand,
 * which is precisely the path that skips this file.
 */
describe("the cloned-voice recipe on the wire", () => {
  const VOICE_PARAMS = {
    voiceId: "harbour-glass",
    text: "The tide turns when it turns.",
    audioFormat: "flac",
    voiceReference: true,
  };
  const ROUTES = [
    { match: /\/upload\/image$/, status: 200, body: { name: "harbour-glass.wav", subfolder: "" } },
    { match: /\/prompt$/, status: 200, body: { prompt_id: "p-v1", node_errors: {} } },
  ];

  it("uploads the clip and gives LoadAudio the engine's own name for it", async () => {
    // `LoadAudio.audio` is a dropdown over the engine's input directory, so a path from this
    // machine means nothing there. Passing one through produced a graph the engine rejected.
    const { fetch, calls } = engineFake(ROUTES);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
      model: "comfyui-cloned-voice",
      capability: "voice-tts",
      params: VOICE_PARAMS,
      voiceReference: VOICE_REFERENCE,
    });
    assert.equal(calls.some((c) => c.url.endsWith("/upload/image") && c.method === "POST"), true, "clip was never uploaded");
    assert.equal(calls.find((c) => c.url.endsWith("/upload/image"))?.redirect, "manual");
    const posted = calls.find((c) => c.url.endsWith("/prompt"))!.body as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.equal(posted.prompt["1"]!.inputs["audio"], "harbour-glass.wav");
    assert.equal(posted.prompt["4"]!.inputs["text"], VOICE_PARAMS.text);
  });

  it("uploads before it submits, never after", async () => {
    // The name has to exist on the engine before the graph naming it is queued.
    const { fetch, calls } = engineFake(ROUTES);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
      model: "comfyui-cloned-voice",
      capability: "voice-tts",
      params: VOICE_PARAMS,
      voiceReference: VOICE_REFERENCE,
    });
    const order = calls.map((c) => c.url);
    assert.equal(
      order.findIndex((u) => u.endsWith("/upload/image")) < order.findIndex((u) => u.endsWith("/prompt")),
      true,
    );
  });

  it("keeps a subfolder, because that is part of the name the dropdown shows", async () => {
    const { fetch, calls } = engineFake([
      { match: /\/upload\/image$/, status: 200, body: { name: "clip.wav", subfolder: "arke" } },
      { match: /\/prompt$/, status: 200, body: { prompt_id: "p-v2", node_errors: {} } },
    ]);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
      model: "comfyui-cloned-voice",
      capability: "voice-tts",
      params: VOICE_PARAMS,
      voiceReference: VOICE_REFERENCE,
    });
    const posted = calls.find((c) => c.url.endsWith("/prompt"))!.body as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.equal(posted.prompt["1"]!.inputs["audio"], "arke/clip.wav");
  });

  it("uploads only the content-addressed name, never a host path", async () => {
    const { fetch, calls } = engineFake(ROUTES);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
      model: "comfyui-cloned-voice",
      capability: "voice-tts",
      params: VOICE_PARAMS,
      voiceReference: VOICE_REFERENCE,
    });
    const upload = calls.find((c) => c.url.endsWith("/upload/image"))!;
    assert.equal(upload.filename, VOICE_REFERENCE.name);
    assert.equal(upload.filename.includes("worlds"), false);
  });

  it("refuses a non-content-addressed upload name before provider I/O", async () => {
    const { fetch, calls } = engineFake(ROUTES);
    await assert.rejects(
      new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
        model: "comfyui-cloned-voice",
        capability: "voice-tts",
        params: VOICE_PARAMS,
        voiceReference: { ...VOICE_REFERENCE, name: "harbour-glass.wav" },
      }),
      /safe content-addressed name/,
    );
    assert.equal(calls.length, 0);
  });

  it("does not replay clip bytes to the target of an HTTP 307", async (t) => {
    let redirectedRequests = 0;
    let redirectedBytes = 0;
    const redirected = createServer((request, response) => {
      redirectedRequests += 1;
      request.on("data", (chunk: Buffer) => {
        redirectedBytes += chunk.byteLength;
      });
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ name: VOICE_REFERENCE.name, subfolder: "" }));
      });
    });
    const redirectedUrl = await listen(redirected);
    t.after(() => closeServer(redirected));

    let uploadBytes = 0;
    const engine = createServer((request, response) => {
      request.on("data", (chunk: Buffer) => {
        uploadBytes += chunk.byteLength;
      });
      request.on("end", () => {
        response.writeHead(307, { Location: `${redirectedUrl}/stolen-upload` });
        response.end();
      });
    });
    const engineUrl = await listen(engine);
    t.after(() => closeServer(engine));

    await assert.rejects(
      new ComfyUiClient(
        (url, init) => fetch(url, init),
        () => engineUrl,
        OK_PREFLIGHT,
      ).submit("", {
        model: "comfyui-cloned-voice",
        capability: "voice-tts",
        params: VOICE_PARAMS,
        voiceReference: VOICE_REFERENCE,
      }),
      /redirected the voice recording upload \(HTTP 307\)/,
    );
    assert.ok(
      uploadBytes > VOICE_REFERENCE.data.byteLength,
      "the first server received the multipart upload",
    );
    assert.equal(redirectedRequests, 0, "fetch did not resend the POST to the redirect target");
    assert.equal(redirectedBytes, 0, "the redirect target received none of the clip bytes");
  });

  it("does not follow redirects for prompt submission or voice-output downloads", async () => {
    const promptFake = engineFake([
      {
        match: /\/upload\/image$/,
        status: 200,
        body: { name: VOICE_REFERENCE.name, subfolder: "" },
      },
      { match: /\/prompt$/, status: 307, body: {} },
    ]);
    await assert.rejects(
      new ComfyUiClient(promptFake.fetch, BASE, OK_PREFLIGHT).submit("", {
        model: "comfyui-cloned-voice",
        capability: "voice-tts",
        params: VOICE_PARAMS,
        voiceReference: VOICE_REFERENCE,
      }),
      /redirected prompt submission \(HTTP 307\)/,
    );
    assert.equal(promptFake.calls.find((call) => call.url.endsWith("/prompt"))?.redirect, "manual");

    const downloadFake = engineFake([
      {
        match: /\/history\/p-v1$/,
        status: 200,
        body: {
          "p-v1": {
            outputs: {
              "5": { audio: [{ filename: "voice.flac", subfolder: "", type: "output" }] },
            },
          },
        },
      },
      { match: /\/view\?/, status: 307, body: {} },
    ]);
    await assert.rejects(
      new ComfyUiClient(downloadFake.fetch, BASE, OK_PREFLIGHT).fetchArtifacts("", "p-v1", {
        model: "comfyui-cloned-voice",
      }),
      /redirected the download.*HTTP 307/,
    );
    assert.equal(downloadFake.calls.find((call) => call.url.includes("/history/"))?.redirect, "manual");
    assert.equal(downloadFake.calls.find((call) => call.url.includes("/view?"))?.redirect, "manual");
  });

  it("takes every key a real voice dispatch carries", async () => {
    /*
     * Copied verbatim from a job the installed app actually built, not invented here. The
     * allow-list named none of them, and because it refuses one key at a time each rebuild
     * surfaced exactly one more: `voiceId`, then `requestId`, then whatever came next. The
     * whole envelope belongs in one test so the next addition fails here and not on a machine.
     */
    const { fetch } = engineFake(ROUTES);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
      model: "comfyui-cloned-voice",
      capability: "voice-tts",
      params: {
        ...VOICE_PARAMS,
        seed: 42,
        requestId: "01M0D1RN20G5MVYTEKNM0Q51GV",
        purpose: "candidate-preview",
        sheetId: "aurora-sabato",
        sheetVersion: 5,
        characterCount: 174,
      },
      voiceReference: VOICE_REFERENCE,
    });
  });

  it("asks for a line to speak, not a prompt", async () => {
    // This recipe has no `prompt` param at all: a line is spoken verbatim, never described.
    const { fetch } = engineFake(ROUTES);
    await assert.rejects(
      new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
        model: "comfyui-cloned-voice",
        capability: "voice-tts",
        params: { voiceId: "v", audioFormat: "flac", voiceReference: true },
        voiceReference: VOICE_REFERENCE,
      }),
      /needs a line to speak/,
    );
  });

  it("does not put a file on the engine for a job pre-flight refuses", async () => {
    const { fetch, calls } = engineFake(ROUTES);
    await assert.rejects(
      new ComfyUiClient(fetch, BASE, async () => ({ ok: false as const, reason: "pinned node drifted" })).submit(
        "",
        { model: "comfyui-cloned-voice", capability: "voice-tts", params: VOICE_PARAMS, voiceReference: VOICE_REFERENCE },
      ),
    );
    assert.equal(calls.some((c) => c.url.endsWith("/upload/image")), false);
  });

  it("refuses when the queue did not attach confined clip bytes", async () => {
    const { fetch, calls } = engineFake(ROUTES);
    await assert.rejects(
      new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
        model: "comfyui-cloned-voice", capability: "voice-tts", params: VOICE_PARAMS,
      }),
      /needs the voice's own recording/,
    );
    assert.equal(calls.length, 0);
  });
});

/**
 * What the engine says it is doing (SPEC-021 D16).
 *
 * The exclusion this amends was written against queue position, which is not a fraction of the
 * work done. These assert the two things that make the step counter different: it comes from the
 * node's own count, and it never carries the node's id.
 */
describe("progress from the engine's socket", () => {
  function socketFake(): {
    open: (url: string) => ProgressSocket;
    send: (msg: unknown) => void;
    urls: string[];
    closed: string[];
  } {
    const urls: string[] = [];
    const closed: string[] = [];
    let live: ProgressSocket | null = null;
    return {
      urls,
      closed,
      open: (url) => {
        urls.push(url);
        live = { onMessage: null, onClose: null, close: () => closed.push(url) };
        return live;
      },
      send: (msg) => live?.onMessage?.(JSON.stringify(msg)),
    };
  }

  const RUNNING = [{ match: /\/queue$/, status: 200, body: { queue_running: [[0, "p-1"]], queue_pending: [] } }];

  it("reports the node's own count, named by what the recipe is doing", async () => {
    // Through a real submit: what a prompt is DOING is recorded there, because the socket only
    // ever says which node is stepping and that is a node id (R-1).
    const { fetch } = engineFake([
      { match: /\/upload\/image$/, status: 200, body: { name: "c.wav", subfolder: "" } },
      { match: /\/prompt$/, status: 200, body: { prompt_id: "p-1", node_errors: {} } },
      ...RUNNING,
    ]);
    const sock = socketFake();
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT, sock.open);
    await client.submit("", {
      model: "comfyui-cloned-voice",
      capability: "voice-tts",
      params: { voiceId: "v", text: "A line.", audioFormat: "flac", voiceReference: true },
      voiceReference: VOICE_REFERENCE,
    });
    await client.poll("", "p-1");
    assert.equal(sock.urls[0], "ws://127.0.0.1:8188/ws?clientId=arke-studio");
    sock.send({ type: "progress", data: { prompt_id: "p-1", value: 20, max: 25, node: "4" } });
    const result = await client.poll("", "p-1");
    assert.deepEqual(result.step, { stage: "speaking", done: 20, total: 25 });
    assert.equal(result.progress, 0.8);
  });

  it("says nothing for a prompt it did not dispatch", async () => {
    // After a restart the app is polling a prompt it has no record of. A count with no idea what
    // is being counted is the unlabelled bar D16 refuses, so it reports state only.
    const { fetch } = engineFake(RUNNING);
    const sock = socketFake();
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT, sock.open);
    await client.poll("", "p-1");
    sock.send({ type: "progress", data: { prompt_id: "p-1", value: 20, max: 25 } });
    assert.equal((await client.poll("", "p-1")).step, undefined);
  });

  it("never carries the engine's node id", async () => {
    // R-1: no node id reaches a user, and `step.stage` is rendered verbatim on a row.
    const { fetch } = engineFake(RUNNING);
    const sock = socketFake();
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT, sock.open);
    await client.poll("", "p-1");
    sock.send({ type: "progress", data: { prompt_id: "p-1", value: 3, max: 10, node: "4" } });
    const result = await client.poll("", "p-1");
    assert.equal(JSON.stringify(result).includes('"4"'), false);
  });

  it("says nothing rather than guessing when the engine has not counted yet", async () => {
    // Between accept and the first step there is no figure, and inventing one — from queue
    // position or elapsed time — is exactly what the original exclusion refused.
    const { fetch } = engineFake(RUNNING);
    const sock = socketFake();
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT, sock.open);
    const result = await client.poll("", "p-1");
    assert.equal(result.state, "running");
    assert.equal(result.step, undefined);
    assert.equal(result.progress, undefined);
  });

  it("forgets a prompt's count when it finishes", async () => {
    const { fetch } = engineFake(RUNNING);
    const sock = socketFake();
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT, sock.open);
    await client.poll("", "p-1");
    sock.send({ type: "progress", data: { prompt_id: "p-1", value: 9, max: 10 } });
    sock.send({ type: "execution_success", data: { prompt_id: "p-1" } });
    assert.equal((await client.poll("", "p-1")).step, undefined);
  });

  it("keeps dispatching when the socket cannot be opened", async () => {
    // Progress is the one thing a dispatch works perfectly well without.
    const { fetch } = engineFake(RUNNING);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT, () => {
      throw new Error("no socket here");
    });
    assert.equal((await client.poll("", "p-1")).state, "running");
  });

  it("replaces a progress socket when the engine source changes and closes it on dispose", async () => {
    const { fetch } = engineFake(RUNNING);
    const sock = socketFake();
    let base = "http://127.0.0.1:8188";
    const client = new ComfyUiClient(fetch, () => base, OK_PREFLIGHT, sock.open);
    await client.poll("", "p-1");
    base = "http://127.0.0.1:8288";
    await client.poll("", "p-1");
    assert.deepEqual(sock.urls, [
      "ws://127.0.0.1:8188/ws?clientId=arke-studio",
      "ws://127.0.0.1:8288/ws?clientId=arke-studio",
    ]);
    assert.deepEqual(sock.closed, ["ws://127.0.0.1:8188/ws?clientId=arke-studio"]);
    client.dispose();
    assert.deepEqual(sock.closed, [
      "ws://127.0.0.1:8188/ws?clientId=arke-studio",
      "ws://127.0.0.1:8288/ws?clientId=arke-studio",
    ]);
    await assert.rejects(client.poll("", "p-1"), /provider client is disposed/);
  });

  it("can close a source-bound socket immediately while keeping the client reusable", async () => {
    const { fetch } = engineFake(RUNNING);
    const sock = socketFake();
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT, sock.open);
    await client.poll("", "p-1");
    client.resetTransport();
    assert.deepEqual(sock.closed, ["ws://127.0.0.1:8188/ws?clientId=arke-studio"]);
    await client.poll("", "p-1");
    assert.equal(sock.urls.length, 2);
  });
});

/**
 * Room on the card, asked at the moment it matters (SPEC-022 §2.6).
 *
 * The start-up probe reads the card's TOTAL size, so a machine clears the floor and then runs out
 * because something else already had the card. These cover the question being asked again at
 * dispatch, the engine being told to put things down, and the refusal naming both figures.
 */
describe("making room on the graphics card", () => {
  const VOICE = {
    model: "comfyui-cloned-voice" as const,
    capability: "voice-tts" as const,
    params: { voiceId: "v", text: "A line.", audioFormat: "flac", voiceReference: true },
    voiceReference: VOICE_REFERENCE,
  };
  const ROUTES = [
    { match: /\/free$/, status: 200, body: {} },
    { match: /\/upload\/image$/, status: 200, body: { name: "c.wav", subfolder: "" } },
    { match: /\/prompt$/, status: 200, body: { prompt_id: "p-1", node_errors: {} } },
  ];
  // No real clock in here: the wait after `/free` is a quarter of a second a poll, and a test
  // that sat through the window would be the stall the window exists to bound.
  // The clock is the sum of the sleeps, so the window is measured rather than counted.
  const client = (free: () => Promise<number | null>, fetch: FetchLike, onSleep: (ms: number) => void = () => {}) => {
    let now = 0;
    const sleep = async (ms: number): Promise<void> => { now += ms; onSleep(ms); };
    return new ComfyUiClient(fetch, BASE, OK_PREFLIGHT, undefined, free, undefined, undefined, sleep, () => now);
  };

  it("dispatches when the card cannot be measured", async () => {
    // D15: unknown stays unknown and dispatches. A card this build cannot read is not a card it
    // may refuse — that would disable local voice forever on any machine without nvidia-smi.
    const { fetch, calls } = engineFake(ROUTES);
    await client(async () => null, fetch).submit("", VOICE);
    assert.equal(calls.some((c) => c.url.endsWith("/free")), false, "nothing to free when nothing is known");
  });

  it("does not apply this machine's free-memory probe to a remote engine", async () => {
    const { fetch, calls } = engineFake(ROUTES);
    await new ComfyUiClient(
      fetch,
      BASE,
      OK_PREFLIGHT,
      undefined,
      async () => 1,
      undefined,
      () => "remote",
    ).submit("", VOICE);
    assert.equal(calls.some((c) => c.url.endsWith("/free")), false);
    assert.equal(calls.some((c) => c.url.endsWith("/prompt")), true);
  });

  it("leaves the engine's model cache alone when there is already room", async () => {
    // `/free` throws away the loaded models, so calling it before every dispatch buys a cold
    // start on every line. It is worth doing only when the card is actually short.
    const { fetch, calls } = engineFake(ROUTES);
    await client(async () => 12_000, fetch).submit("", VOICE);
    assert.equal(calls.some((c) => c.url.endsWith("/free")), false);
  });

  it("asks the engine to put things down when the card is short, then goes ahead", async () => {
    const { fetch, calls } = engineFake(ROUTES);
    let asked = 0;
    await client(async () => (++asked === 1 ? 3000 : 9000), fetch).submit("", VOICE);
    assert.equal(calls.some((c) => c.url.endsWith("/free") && c.method === "POST"), true);
    assert.equal(calls.some((c) => c.url.endsWith("/prompt")), true, "it should proceed once there is room");
  });

  it("names both figures when there is still not enough, and does not dispatch", async () => {
    // The whole point: say so before the wait, not after half an hour of paging to disk.
    const { fetch, calls } = engineFake(ROUTES);
    await assert.rejects(
      client(async () => 3072, fetch).submit("", VOICE),
      (err: Error) => {
        assert.match(err.message, /needs 7\.8 GB of free graphics memory/);
        assert.match(err.message, /this machine has 3\.0 GB free/);
        assert.match(err.message, /close other programs/);
        // "then try again" has to be true (#692): a full card is a busy engine, not a refused
        // request, so the queue must read it as transient — backed off, retried, and offered a
        // live Retry when it gives up — never as the witnessed rejection that ends an attempt.
        assert.ok(err instanceof ProviderBusyError, "a busy card declares its own class");
        assert.equal(err.failureClass, "transient");
        assert.equal("submissionRejected" in err, false);
        return true;
      },
    );
    assert.equal(calls.some((c) => c.url.endsWith("/prompt")), false, "nothing was queued");
    assert.equal(calls.some((c) => c.url.endsWith("/upload/image")), false, "no clip left on the engine");
  });

  it("keeps asking the card for a moment, because the engine says yes before it has put anything down", async () => {
    // `/free` sets flags and answers; the worker thread unloads when it next wakes. Measured the
    // instant the answer lands, the card is the card as it was — which #692 saw as alternate
    // shots refused on a card that was free a moment later.
    const { fetch, calls } = engineFake(ROUTES);
    const readings = [3000, 3000, 3000, 9000];
    const sleeps: number[] = [];
    await client(async () => readings.shift() ?? 9000, fetch, (ms) => { sleeps.push(ms); }).submit("", VOICE);
    assert.equal(calls.filter((c) => c.url.endsWith("/free")).length, 1, "asked to put things down once, never once per poll");
    assert.equal(calls.some((c) => c.url.endsWith("/prompt")), true, "dispatched once the card emptied");
    assert.equal(sleeps.length, 2, "one wait per short reading after the engine answered");
  });

  it("gives up after a bounded window, with the same refusal", async () => {
    const { fetch, calls } = engineFake(ROUTES);
    let asked = 0;
    const sleeps: number[] = [];
    await assert.rejects(
      client(async () => { asked += 1; return 3072; }, fetch, (ms) => { sleeps.push(ms); }).submit("", VOICE),
      (err: Error) => {
        assert.ok(err instanceof ProviderBusyError, "still the transient it was");
        assert.match(err.message, /needs 7\.8 GB of free graphics memory/);
        assert.match(err.message, /this machine has 3\.0 GB free/);
        return true;
      },
    );
    assert.equal(calls.some((c) => c.url.endsWith("/prompt")), false, "nothing was queued");
    assert.ok(sleeps.length >= 4 && sleeps.length <= 12, `bounded, and long enough to matter: ${sleeps.length} waits`);
    assert.ok(sleeps.reduce((sum, ms) => sum + ms, 0) <= 3000, "a couple of seconds, not a stall");
    assert.equal(asked, sleeps.length + 1, "measured before asking, on the answer, and after every wait that ended inside the window");
  });

  it("bounds the window by elapsed time, so a slow probe cannot stretch it", async () => {
    // The desktop's probe is an nvidia-smi run with a five-second timeout. Counting polls would
    // let eight slow readings hold a job in `submitting` for most of a minute.
    const { fetch, calls } = engineFake(ROUTES);
    let now = 0;
    let asked = 0;
    const slowProbe = async (): Promise<number | null> => { asked += 1; now += 1500; return 3072; };
    const slow = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT, undefined, slowProbe, undefined, undefined, async (ms) => { now += ms; }, () => now);
    await assert.rejects(slow.submit("", VOICE), (err: Error) => err instanceof ProviderBusyError);
    assert.ok(asked <= 4, `asked ${asked} times: a probe that takes 1.5 s runs the window out in two rounds, not eight`);
    assert.equal(calls.some((c) => c.url.endsWith("/prompt")), false, "nothing was queued");
  });

  it("stops waiting on the card the moment the job is cancelled", async () => {
    // The engine's slot is held until submit returns — the queue frees it in runJob's finally —
    // so a cancelled job that kept polling would block the next local job for the rest of the
    // window. The wait ends on the signal, and the loop reads it after every wait.
    const { fetch, calls } = engineFake(ROUTES);
    const controller = new AbortController();
    let now = 0;
    let asked = 0;
    const probe = async (): Promise<number | null> => { asked += 1; return 3072; };
    const sleep = async (ms: number): Promise<void> => { now += ms; controller.abort(); };
    const cancelled = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT, undefined, probe, undefined, undefined, sleep, () => now);
    await assert.rejects(cancelled.submit("", { ...VOICE, signal: controller.signal }), (err: Error) => err.name === "AbortError");
    assert.equal(asked, 2, "measured before asking and on the answer, then never again");
    assert.equal(calls.some((c) => c.url.endsWith("/prompt")), false, "nothing was queued");
  });

  it("dispatches when the card stops being measurable mid-window (D15)", async () => {
    const { fetch, calls } = engineFake(ROUTES);
    const readings: Array<number | null> = [3000, 3000, null];
    await client(async () => readings.shift() ?? null, fetch).submit("", VOICE);
    assert.equal(calls.some((c) => c.url.endsWith("/prompt")), true, "the probe failing is not the card filling up");
  });
});

/**
 * Putting things down after a run (issue 846).
 *
 * A long ComfyUI session gets slower as it goes because what a video job streamed through system
 * memory stays resident until the process ends. The queue says when the lane has drained; these
 * cover what the client does with that — the one `/free`, only for a video recipe, and only on an
 * engine whose memory is this machine's to reclaim.
 */
describe("putting things down when the lane drains", () => {
  const ROUTES = [{ match: /\/free$/, status: 200, body: {} }];

  it("asks a local engine to unload after a video job", async () => {
    const { fetch, calls } = engineFake(ROUTES);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).release("comfyui-h3-video");
    const freed = calls.filter((c) => c.url.endsWith("/free") && c.method === "POST");
    assert.equal(freed.length, 1);
    assert.deepEqual(freed[0]!.body, { unload_models: true, free_memory: true });
  });

  it("leaves a voice or image recipe's cache alone, and a remote engine's memory to its owner", async () => {
    const { fetch, calls } = engineFake(ROUTES);
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).release("comfyui-cloned-voice");
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).release("comfyui-draft-image");
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).release("not-a-recipe");
    await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT, undefined, undefined, undefined, () => "remote").release("comfyui-h3-video");
    await new ComfyUiClient(fetch, () => null, OK_PREFLIGHT).release("comfyui-h3-video");
    assert.equal(calls.some((c) => c.url.endsWith("/free")), false);
  });
});

describe("a job runs on the engine version it was priced against, or not at all (SPEC-021 R-19; issue 592)", () => {
  it("refuses before /prompt when the engine now reports another version, naming both, and proceeds when it matches", async () => {
    const { comfyUiRecipeById, comfyUiRecipeIdentity } = await import("../src/comfyui/recipes.js");
    const identity = comfyUiRecipeIdentity(comfyUiRecipeById("comfyui-draft-image")!);
    const { fetch, calls } = engineFake([
      { match: /\/system_stats$/, status: 200, body: { system: { comfyui_version: "0.34.0" } } },
      { match: /\/prompt$/, status: 200, body: { prompt_id: "p-9", number: 1, node_errors: {} } },
    ]);
    const client = new ComfyUiClient(fetch, BASE, OK_PREFLIGHT);
    const request = {
      model: "comfyui-draft-image",
      capability: "image" as const,
      params: { prompt: "the tide-clock at dusk", output: { width: 1216, height: 832, aspect: "3:2" }, provenance: { canonRevision: 1 } },
    };
    await assert.rejects(
      () => client.submit("", { ...request, recipe: { ...identity, engineVersion: "0.33.1" } }),
      /priced against ComfyUI 0\.33\.1, and the engine now reports 0\.34\.0/,
    );
    assert.equal(calls.some((c) => c.url.endsWith("/prompt")), false, "nothing reached /prompt");
    const result = await client.submit("", { ...request, recipe: { ...identity, engineVersion: "0.34.0" } });
    assert.equal(result.remoteId, "p-9");
  });
});

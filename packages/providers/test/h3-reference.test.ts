import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { characterAudioRoute, mappedReferenceKinds, multimediaCapacity, validateReferences, referencePrompt, modelCapabilityCopy, frameDispatchFor } from "@arke-studio/contracts";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import { H3_REFERENCE, H3_REFERENCE_MODEL } from "../src/comfyui/h3-reference-recipe.js";
import { COMFYUI_RECIPES, comfyUiRecipeIdentity, recipeTemplateDigest } from "../src/comfyui/recipes.js";
import { SHIPPED_MANIFEST } from "../src/manifest-data.js";
import type { SubmitRequest, FetchLike } from "../src/types.js";

const bytes = Uint8Array.from([1, 2, 3]);
const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function request(): SubmitRequest {
  return { model: H3_REFERENCE.id, capability: "video", recipe: comfyUiRecipeIdentity(H3_REFERENCE),
    params: { prompt: "<Picture 1> and <Picture 2> move like <Video 1>; <Audio 2> guides the sound.", durationSec: 5,
      references: ["first.png", "second.png"], videoReferences: ["clip.mp4"], referenceMedia: [{ kind: "audio", file: "tone.wav", hash, durationSec: 2 }] },
    imageReferences: ["first.png", "second.png"].map(name => ({ name, contentType: "image/png", data: bytes })),
    videoReferences: [{ contentType: "video/mp4", data: bytes, durationSec: 2, referenceVideo24fps: true }],
    mediaAudioReferences: [{ name: "tone.wav", contentType: "audio/wav", data: bytes, durationSec: 2 }] };
}
function engine(locality: "local" | "remote" = "local") {
  const calls: string[] = [], graphs: Record<string, { class_type: string; inputs: Record<string, unknown> }>[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/upload/image")) {
      const file = (init!.body as FormData).get("image") as File;
      return new Response(JSON.stringify({ name: file.name }), { status: 200 });
    }
    if (url.endsWith("/prompt")) {
      graphs.push(JSON.parse(String(init!.body)).prompt);
      return new Response(JSON.stringify({ prompt_id: "h3-reference" }), { status: 200 });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const client = new ComfyUiClient(fetch, () => "http://127.0.0.1:8188", async () => ({ ok: true }), undefined, undefined, undefined, () => locality);
  return { client, calls, graphs };
}

test("R2V registration agrees across recipe, manifest, transport, budgets and picker", () => {
  const model = SHIPPED_MANIFEST.models.find(row => row.id === H3_REFERENCE.id)!;
  assert.ok(model);
  assert.ok(COMFYUI_RECIPES.includes(H3_REFERENCE));
  assert.deepEqual(mappedReferenceKinds(model.provider), ["image", "video", "audio"]);
  assert.equal(model.accepts.referenceImages, H3_REFERENCE.referenceImages!.length);
  assert.equal(model.accepts.referenceVideos, H3_REFERENCE.referenceVideos!.length);
  assert.equal(model.accepts.referenceAudio, H3_REFERENCE.referenceAudio!.length);
  assert.equal(multimediaCapacity([], model).videoCeilingSec, 15);
  assert.equal(frameDispatchFor(model, 1), null);
  assert.match(modelCapabilityCopy(model), /video refs ×3.*audio refs ×3/);
  assert.equal(characterAudioRoute(model)!.requiresImages, false);
  assert.equal(characterAudioRoute(model)!.supportsPerformanceSync, false);
  assert.equal(characterAudioRoute(model, "first-frame"), null);
  assert.equal(multimediaCapacity([], SHIPPED_MANIFEST.models.find(row => row.id === "comfyui-h3-video")!).videoCeilingSec, 0);
});

test("R2V maps mixed references and removes every unused carrier and soundtrack link", async () => {
  const { client, graphs, calls } = engine();
  await client.submit("", request());
  assert.equal(calls.filter(url => url.endsWith("/upload/image")).length, 4);
  const graph = graphs[0]!;
  assert.deepEqual(graph["7"]!.inputs["ref_images.ref_image_0"], ["20", 0]);
  assert.deepEqual(graph["7"]!.inputs["ref_images.ref_image_1"], ["21", 0]);
  assert.deepEqual(graph["7"]!.inputs["ref_videos.ref_video_0"], ["50", 0]);
  assert.deepEqual(graph["7"]!.inputs["ref_video_audios.ref_video_audio_0"], ["50", 1]);
  assert.deepEqual(graph["7"]!.inputs["ref_audios.ref_audio_0"], ["60", 0]);
  for (const node of ["22", "41", "51", "61"]) assert.equal(graph[node], undefined);
  assert.equal(graph["7"]!.inputs["ref_video_audios.ref_video_audio_1"], undefined);
  assert.equal(graph["7"]!.inputs["first_frame"], undefined);
  assert.match(String(graph["40"]!.inputs.file), /^[a-f0-9]{64}\.mp4$/);
  assert.equal(graph["9"]!.inputs.steps, 4);
  client.dispose();
});

test("audio-only R2V carries the audio without requiring a fake first frame", async () => {
  const { client, graphs } = engine();
  const input = request();
  input.imageReferences = []; input.videoReferences = []; input.params.references = []; input.params.videoReferences = [];
  await client.submit("", input);
  assert.equal(graphs[0]!["7"]!.inputs["ref_images.ref_image_0"], undefined);
  assert.equal(graphs[0]!["7"]!.inputs["ref_video_audios.ref_video_audio_0"], undefined);
  assert.ok(graphs[0]!["60"]);
  client.dispose();
});

test("invalid, missing, changed and remotely directed references fail before uploads", async () => {
  const cases: Array<(input: SubmitRequest) => void> = [
    input => { input.videoReferences![0]!.referenceVideo24fps = undefined; },
    input => { input.videoReferences = []; },
    input => { input.mediaAudioReferences = []; },
    input => { input.mediaAudioReferences![0]!.data = Uint8Array.from([9]); },
    input => { input.mediaAudioReferences![0]!.durationSec = NaN; },
    input => { input.params.taskMode = "first-frame"; },
    input => { input.params.audioReferences = { version: 1, disabled: false, route: H3_REFERENCE.id, references: [], problems: ["missing sample"] }; },
  ];
  for (const mutate of cases) {
    const { client, calls } = engine(), input = request(); mutate(input);
    await assert.rejects(client.submit("", input)); assert.deepEqual(calls, []); client.dispose();
  }
  const { client, calls } = engine("remote");
  await assert.rejects(client.submit("", request()), /local engine/);
  assert.deepEqual(calls, []); client.dispose();
});

test("file counts and per-file duration constrain admission, including unknown measurements", () => {
  const model = H3_REFERENCE_MODEL;
  assert.equal(validateReferences(Array.from({ length: 4 }, () => ({ kind: "video" as const, durationSec: 2 })), model).ok, false);
  assert.equal(validateReferences([{ kind: "video", durationSec: 6 }], model).ok, false);
  assert.equal(validateReferences([{ kind: "audio", durationSec: NaN }], model).ok, false);
  assert.equal(validateReferences([{ kind: "audio", durationSec: 2 }, { kind: "video", durationSec: 2 }], model).ok, true);
});

test("prompt vocabulary accounts for video soundtracks and standalone audio before character voices", () => {
  assert.equal(referencePrompt("Image 1: Ada. @Image 2 matches image 1. @Video 1. @Audio 1", H3_REFERENCE_MODEL, 1, 0, true),
    "<Picture 1>: Ada. <Picture 2> matches <Picture 1>. <Video 1>. <Audio 2>");
  assert.equal(referencePrompt("Ada uses @Audio1", H3_REFERENCE_MODEL, 2, 1), "Ada uses <Audio 4>");
  assert.equal(referencePrompt("Already <Audio 2>", H3_REFERENCE_MODEL, 2), "Already <Audio 2>");
  assert.equal(referencePrompt("Audio 1 should fade. Video 1 shows image 1; use @Image 1.", H3_REFERENCE_MODEL),
    "Audio 1 should fade. Video 1 shows image 1; use <Picture 1>.");
});

test("soundtrack attachment changes invalidate frozen recipe identity", () => {
  const changed = structuredClone(H3_REFERENCE);
  changed.referenceVideos = changed.referenceVideos!.map((ref, index) => index ? ref : { ...ref, extraSlots: [] });
  assert.notEqual(recipeTemplateDigest(changed), recipeTemplateDigest(H3_REFERENCE));
});

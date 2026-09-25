import assert from "node:assert/strict";
import { test } from "node:test";
import { AdapterReleaseSchema } from "@arke-studio/contracts";
import { HEARMEMAN_ADAPTERS } from "../src/comfyui/hearmeman.generated.js";
import { H3_ADAPTER_BUNDLES } from "../src/comfyui/adapter-bundles.js";
import { recipeWithAdapters, adapterValidationCandidate } from "../src/comfyui/adapters.js";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import { comfyUiRecipeById, comfyUiRecipeIdentity } from "../src/comfyui/recipes.js";

test("pinned inventory accounts for all 14 artifacts without claiming GPU verification", () => {
  assert.equal(HEARMEMAN_ADAPTERS.length, 14);
  assert.equal(HEARMEMAN_ADAPTERS.reduce((sum, row) => sum + row.source.bytes, 0), 4061177176);
  for (const row of HEARMEMAN_ADAPTERS) {
    assert.ok(row.id.endsWith(row.source.sha256));
    assert.equal(row.source.revision, "de4c3bc6122e68b88407c03dfecf521c803f098d");
    assert.ok(row.compatibility.every(pair => pair.state !== "verified"));
    for (const id of row.supersedes) assert.ok(HEARMEMAN_ADAPTERS.some(prior => prior.id === id && prior.adapterId === row.adapterId));
  }
});

test("the experimental bundle chains all fourteen pinned adapters and freezes every dependency", () => {
  const base = comfyUiRecipeById("comfyui-h3-video")!, before = structuredClone(base);
  const bundle = H3_ADAPTER_BUNDLES[0]!, selected = bundle.selections;
  assert.equal(selected.length, 14);
  assert.deepEqual(selected.map(row => row.releaseId), HEARMEMAN_ADAPTERS.map(row => row.id));
  const composed = recipeWithAdapters(base, selected);
  assert.deepEqual(base, before);
  selected.forEach((row, i) => {
    const node = composed.graph[`arke_adapter_${i}`]!;
    assert.equal(node.inputs.strength_model, 1);
    assert.equal(node.inputs.lora_name, `arke/${row.sha256}.safetensors`);
    assert.deepEqual(node.inputs.model, i ? [`arke_adapter_${i - 1}`, 0] : base.graph["3"]!.inputs.model);
    assert.ok(composed.requires.checkpoints.some(file => file.sha256 === row.sha256));
  });
  assert.deepEqual(composed.graph["3"]!.inputs.model, ["arke_adapter_13", 0]);
  assert.deepEqual(comfyUiRecipeIdentity(composed).adapters, selected);
  assert.deepEqual(composed.hardware, base.hardware);
  assert.equal(bundle.status, "experimental");
  assert.throws(() => recipeWithAdapters(base, selected.slice(1)), /bundle/);
  assert.throws(() => recipeWithAdapters(base, [...selected].reverse()), /bundle/);
  assert.throws(() => recipeWithAdapters(comfyUiRecipeById("comfyui-h3-video-768")!, selected), /validation/);
  const altered = structuredClone(HEARMEMAN_ADAPTERS);
  altered[13]!.compatibility[0]!.state = "unverified";
  altered[13]!.compatibility[0]!.reason = "Fixture validation pending";
  assert.throws(() => recipeWithAdapters(base, selected, altered), /validation pending/);
});

test("bundle submission resolves every engine filename and retains all frozen choices", async () => {
  const base = comfyUiRecipeById("comfyui-h3-video")!, selected = H3_ADAPTER_BUNDLES[0]!.selections;
  const composed = recipeWithAdapters(base, selected), identity = comfyUiRecipeIdentity(composed);
  let submitted: Record<string, { inputs: Record<string, unknown> }> | undefined, guarded = 0;
  const names = selected.map((row, i) => `arke${i % 2 ? "\\" : "/"}${row.sha256}.safetensors`);
  const client = new ComfyUiClient(async (url, init) => {
    if (url.endsWith("/system_stats")) return Response.json({ system: { comfyui_version: "0.33.1" } });
    if (url.endsWith("/object_info/LoraLoaderModelOnly")) return Response.json({ LoraLoaderModelOnly: { input: { required: { lora_name: [names] } } } });
    if (url.endsWith("/prompt")) { submitted = JSON.parse(String(init?.body)).prompt; return Response.json({ prompt_id: "fixture-bundle" }); }
    throw new Error(`Unexpected request: ${url}`);
  }, () => "http://127.0.0.1:8188", async () => ({ ok: true }), undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, async () => { guarded++; });
  try {
    await client.submit("", { model: base.id, capability: "video", recipe: identity,
      params: { prompt: "A red cube moves.", seed: 1, durationSec: 5, aspect: "16:9", adapters: selected } });
    assert.ok(guarded > 0);
    names.forEach((name, i) => assert.equal(submitted![`arke_adapter_${i}`]!.inputs.lora_name, name));
    assert.deepEqual(identity.adapters, selected);
    assert.deepEqual(submitted!["3"]!.inputs.model, ["arke_adapter_13", 0]);
  } finally { client.dispose(); }
});

test("selection changes only the declared model slot, freezes exact provenance and raises measured floors", () => {
  const base = comfyUiRecipeById("comfyui-h3-video")!;
  const before = structuredClone(base);
  const release = AdapterReleaseSchema.parse({ ...HEARMEMAN_ADAPTERS[0], compatibility: [{ recipeId: base.id, state: "verified", reason: "Fixture only",
    evidence: "Synthetic graph test, not GPU evidence", minStrength: 0.25, maxStrength: 1,
    minEngineVersion: "0.37.0", exercisedThroughVersion: "0.37.0",
    hardware: { minVramMb: 12000, minFreeVramMb: 6000, minMemMb: 32000, minFreeMemMb: 20000 } }] });
  const selection = [{ releaseId: release.id, sha256: release.source.sha256, strength: 0.5 }];
  assert.equal(recipeWithAdapters(base, []), base);
  const composed = recipeWithAdapters(base, selection, [release]);
  assert.deepEqual(base, before);
  assert.deepEqual(composed.graph["3"]!.inputs.model, ["arke_adapter_0", 0]);
  assert.deepEqual(composed.graph.arke_adapter_0!.inputs.model, base.graph["3"]!.inputs.model);
  assert.equal(composed.graph.arke_adapter_0!.inputs.lora_name, `arke/${release.source.sha256}.safetensors`);
  assert.ok(composed.hardware.minVramMb >= 12000);
  assert.deepEqual(comfyUiRecipeIdentity(composed).adapters, selection);
  assert.notEqual(comfyUiRecipeIdentity(composed).templateDigest, comfyUiRecipeIdentity(base).templateDigest);
  assert.notEqual(comfyUiRecipeIdentity(composed).dependencyDigest, comfyUiRecipeIdentity(base).dependencyDigest);
  assert.throws(() => recipeWithAdapters(base, [{ ...selection[0], strength: 1.5 }], [release]), /strength/);
  assert.throws(() => recipeWithAdapters(base, selection, [{ ...release, compatibility: [{ recipeId: base.id, state: "unverified", reason: "GPU validation pending" }] }]), /validation/);
  assert.throws(() => recipeWithAdapters(base, [{ ...selection[0], sha256: "f".repeat(64) }], [release]), /changed/);
});

test("the maintainer candidate does not grant production verification or bypass the host guard", async () => {
  const base = comfyUiRecipeById("comfyui-h3-video")!;
  const release = { ...HEARMEMAN_ADAPTERS[0]!, compatibility: [{ recipeId: base.id, state: "unverified" as const, reason: "GPU validation pending" }] };
  const selections = [{ releaseId: release.id, sha256: release.source.sha256, strength: 1 }];
  const before = structuredClone(release);
  const candidate = adapterValidationCandidate(base, selections, [release]);
  assert.deepEqual(release, before);
  assert.deepEqual(candidate.adapters, selections);
  assert.throws(() => recipeWithAdapters(base, selections, [release]), /validation/);
  const client = new ComfyUiClient(async () => { throw new Error("Must refuse before HTTP"); }, () => "http://127.0.0.1:8188",
    async () => ({ ok: true }), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    adapterValidationCandidate);
  try {
    await assert.rejects(client.submit("", { model: base.id, capability: "video", recipe: comfyUiRecipeIdentity(candidate),
      params: { adapters: selections } }), /authorization is unavailable/);
  } finally { client.dispose(); }
});

test("all fourteen owner approvals preserve actual coverage and the base recipe guards", () => {
  const base = comfyUiRecipeById("comfyui-h3-video")!;
  const outcomes: Record<string, number> = {};
  for (const release of HEARMEMAN_ADAPTERS) {
    const pair = release.compatibility.find(row => row.recipeId === base.id)!;
    assert.equal(pair.state, "owner-approved");
    const coverage = pair.ownerApproval!.generation;
    outcomes[coverage] = (outcomes[coverage] ?? 0) + 1;
    const selected = [{ releaseId: release.id, sha256: release.source.sha256, strength: 1 }];
    const composed = recipeWithAdapters(base, selected);
    assert.deepEqual(composed.hardware, base.hardware);
    assert.deepEqual(composed.engine, base.engine);
    assert.throws(() => recipeWithAdapters(base, [{ ...selected[0], strength: 0.5 }]), /strength/);
    assert.throws(() => recipeWithAdapters(comfyUiRecipeById("comfyui-h3-video-768")!, selected), /validation/);
    assert.throws(() => recipeWithAdapters(comfyUiRecipeById("comfyui-h3-reference-video")!, selected), /validation/);
  }
  assert.deepEqual(outcomes, { completed: 10, "memory-blocked": 2, "not-run": 2 });
});

test("adapter transport follows the engine's filename spelling and rejects missing or unrelated paths", async () => {
  const base = comfyUiRecipeById("comfyui-h3-video")!, release = HEARMEMAN_ADAPTERS[0]!;
  const selected = [{ releaseId: release.id, sha256: release.source.sha256, strength: 1 }];
  const candidate = adapterValidationCandidate(base, selected);
  for (const name of [`arke/${release.source.sha256}.safetensors`, `arke\\${release.source.sha256}.safetensors`, `other/${release.source.sha256}.safetensors`]) {
    let sent: unknown;
    const client = new ComfyUiClient(async (url, init) => {
      if (url.endsWith("/system_stats")) return Response.json({ system: { comfyui_version: "0.33.1" } });
      if (url.endsWith("/object_info/LoraLoaderModelOnly")) return Response.json({ LoraLoaderModelOnly: { input: { required: { lora_name: [[name]] } } } });
      if (url.endsWith("/prompt")) { sent = JSON.parse(String(init?.body)).prompt.arke_adapter_0.inputs.lora_name; return Response.json({ prompt_id: "fixture-prompt" }); }
      throw new Error(`Unexpected request: ${url}`);
    }, () => "http://127.0.0.1:8188", async () => ({ ok: true }), undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, async () => {}, adapterValidationCandidate);
    try {
      const dispatch = client.submit("", { model: base.id, capability: "video", recipe: comfyUiRecipeIdentity(candidate),
        params: { prompt: "A red cube moves.", seed: 1, durationSec: 5, aspect: "16:9", adapters: selected } });
      if (name.startsWith("other/")) { await assert.rejects(dispatch, /not advertised/); assert.equal(sent, undefined); }
      else { await dispatch; assert.equal(sent, name); }
      assert.equal(candidate.graph.arke_adapter_0!.inputs.lora_name, `arke/${release.source.sha256}.safetensors`);
    } finally { client.dispose(); }
  }
});

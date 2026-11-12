import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EFFECT_ANALYSIS_PROFILE, defaultEffectClip, prepareEffectReactions } from "@arke-studio/contracts";
import { EffectManifestCache, readEffectManifest } from "../src/lib/editor-effect-analysis.js";
import { PreviewReactionBank, renderPreviewFrame, type PreviewFrameRequest } from "../src/lib/editor-preview-frame.js";
import { analysisManifest } from "./effect-analysis-fixture.js";

const response = (value: unknown) => new Response(JSON.stringify(value));
const fetched = (value: unknown): typeof fetch => async () => response(value);
const signal = () => new AbortController().signal;

describe("immutable effect reaction loading (SPEC-053 R-14–16, R-20)", () => {
  it("validates both immutable hashes before returning an authenticated media response", async () => {
    const manifest = analysisManifest();
    let received = "";
    const fetcher: typeof fetch = async url => { received = String(url); return response(manifest); };
    assert.deepEqual(await readEffectManifest("/media/world/analysis.json?cap=fixture", manifest.manifestKey, manifest.sourceFingerprint, signal(), fetcher), manifest);
    assert.equal(received, "/media/world/analysis.json?cap=fixture");
    const damaged = structuredClone(manifest); damaged.features.energy[7] = 0.5;
    await assert.rejects(readEffectManifest("/media", manifest.manifestKey, manifest.sourceFingerprint, signal(), fetched(damaged)), /content check/);
    await assert.rejects(readEffectManifest("/media", manifest.manifestKey, "f".repeat(64), signal(), fetched(manifest)), /another source/);
  });

  it("rejects malformed clocks and bounds both declared and streamed bytes before parsing", async () => {
    const manifest = analysisManifest();
    const malformed = structuredClone(manifest); malformed.features.beat.pop();
    await assert.rejects(readEffectManifest("/media", manifest.manifestKey, manifest.sourceFingerprint, signal(), fetched(malformed)), /shared frame window/);
    const oversized: typeof fetch = async () => new Response("{}", { headers: { "content-length": String(EFFECT_ANALYSIS_PROFILE.maxManifestBytes + 1) } });
    await assert.rejects(readEffectManifest("/media", manifest.manifestKey, manifest.sourceFingerprint, signal(), oversized), /supported size/);
    const chunked: typeof fetch = async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(EFFECT_ANALYSIS_PROFILE.maxManifestBytes)); controller.enqueue(new Uint8Array(1)); controller.close();
    } }));
    await assert.rejects(readEffectManifest("/media", manifest.manifestKey, manifest.sourceFingerprint, signal(), chunked), /supported size/);
  });

  it("deduplicates a shared source and bounds concurrency while cancelling obsolete requests", async () => {
    const manifests = [analysisManifest(0), analysisManifest(0.5), analysisManifest(1)];
    const starts: string[] = [], completions = new Map<string, () => void>();
    const fetcher: typeof fetch = (url, options) => new Promise((resolve, reject) => {
      const key = String(url); starts.push(key);
      completions.set(key, () => resolve(response(manifests.find(row => row.manifestKey === key))));
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    });
    const cache = new EffectManifestCache(key => key, fetcher);
    cache.retain(new Set(manifests.map(row => row.manifestKey)));
    const results = manifests.map(row => cache.get(row.manifestKey, row.sourceFingerprint));
    assert.equal(cache.get(manifests[0]!.manifestKey, manifests[0]!.sourceFingerprint), results[0]);
    assert.equal(starts.length, 2);
    const rejected = Promise.all(results.slice(0, 2).map(promise => assert.rejects(promise, { name: "AbortError" })));
    cache.retain(new Set([manifests[2]!.manifestKey]));
    await rejected;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts.length, 3);
    completions.get(manifests[2]!.manifestKey)!();
    assert.deepEqual(await results[2], manifests[2]);
    assert.throws(() => cache.retain(new Set(Array.from({ length: 9 }, (_, index) => String(index)))), /eight/);
    cache.destroy();
  });

  it("explicit retry replaces a failed immutable fetch", async () => {
    const manifest = analysisManifest(); let calls = 0;
    const cache = new EffectManifestCache(key => key, async () => { calls++; return calls === 1 ? new Response("", { status: 503 }) : response(manifest); });
    cache.retain(new Set([manifest.manifestKey]));
    await assert.rejects(cache.get(manifest.manifestKey, manifest.sourceFingerprint), /503/);
    cache.retry(manifest.manifestKey);
    assert.deepEqual(await cache.get(manifest.manifestKey, manifest.sourceFingerprint), manifest);
    assert.equal(calls, 2); cache.destroy();
  });

  it("uses per-effect source mappings and refuses stale worker epochs without consulting prior frames", () => {
    const loud = analysisManifest(), silent = analysisManifest(0, { kind: "audio-track", trackId: "tr_audio" });
    const first = defaultEffectClip({ id: "cl_one", lineageId: "ef_one", seed: 42, startFrame: 0, durationFrames: 240, preset: "lights" });
    const second = { ...structuredClone(first), id: "cl_two" as const, lineageId: "ef_two" as const, seed: 7 };
    for (const effect of [first, second]) { effect.reaction = { ...effect.reaction, enabled: true, strength: 1, energy: 1, limit: 1, smoothingFrames: 0, property: "brightness" }; }
    first.audioInput = loud.descriptor.binding; second.audioInput = silent.descriptor.binding;
    const sources = { manifestsByKey: { [loud.manifestKey]: loud, [silent.manifestKey]: silent }, manifestKeyByEffectId: { [first.id]: loud.manifestKey, [second.id]: silent.manifestKey } };
    const bank = new PreviewReactionBank();
    bank.install({ kind: "analysis", analysisEpoch: 1, effects: [first, second], startFrame: 0, endFrame: 240, ...sources });
    const request: PreviewFrameRequest = { id: 1, generation: 0, analysisEpoch: 1, absoluteFrame: 100, frameRate: 24, width: 96, height: 54, pictures: [], composition: [first, second] };
    const prepared = prepareEffectReactions([first, second], sources.manifestsByKey, sources.manifestKeyByEffectId, { startFrame: 0, endFrame: 240 });
    const expected = renderPreviewFrame(request, prepared);
    assert.deepEqual(bank.render(request), expected);
    assert.notDeepEqual(expected, renderPreviewFrame(request), "reactive frame is not mislabeled base atmosphere");
    bank.install({ kind: "analysis", analysisEpoch: 2, effects: [first, second], startFrame: 0, endFrame: 240, manifestsByKey: {}, manifestKeyByEffectId: {} });
    assert.throws(() => bank.render(request), /obsolete analysis/);
    assert.deepEqual(bank.render({ ...request, analysisEpoch: 2 }), renderPreviewFrame(request), "new source pending analysis falls back explicitly to the base");
    bank.install({ kind: "analysis", analysisEpoch: 3, effects: [first, second], startFrame: 0, endFrame: 240, ...sources });
    assert.deepEqual(bank.render({ ...request, analysisEpoch: 3 }), expected, "scrub/reinstall preserves the same production frame");
  });
});

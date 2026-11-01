import assert from "node:assert/strict";
import { it } from "node:test";
import { foldBenchSession, NO_BACKGROUND_MUSIC, type ModelManifest } from "@arke-studio/contracts";
import { prepareBenchSubject } from "../../src/bench/subject.js";
import { planBenchDispatch } from "../../src/bench/service.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

it("production Bench appends master-track policy to the compiled request without editing the saved body", async () => {
  const store = await WorldStore.open(await makeTempWorld()); closeOnCleanup(() => store.close());
  const world = structuredClone(store.getBundle()), production = world.productions.find(p => p.meta.id === "saltlight")!;
  production.meta.models = { ...production.meta.models, video: "policy-video" };
  production.spine = { schemaVersion: 1, revision: 1, trackArtifactId: "ar_01J8G0000000000000000000R1", markers: [], anchors: {}, updatedAt: "2026-11-01T12:00:00Z" };
  world.artDirection.audio.music = "allow-model-score";
  const manifest: ModelManifest = { manifestVersion: 1, generated: "2026-11-01T12:00:00Z", models: [{ id: "policy-video", provider: "fal", capability: "video", displayName: "Video",
    accepts: { referenceImages: 8, startFrame: false, endFrame: false }, limits: { maxDurationSec: 20, durations: { "4": "4" }, soundChoice: true }, pricing: { kind: "perSecond", microUsdPerSecond: 10 } }] };
  const prepared = await prepareBenchSubject(world, { productionId: production.meta.id, sceneId: "sc_04", subject: { kind: "shot", shotId: "sh_12" }, mode: "video",
    settings: null, manifest, sources: { read: async () => ({ hash: "sha256:deadbeefdeadbeef" }) } });
  assert.ok(prepared.ok, prepared.ok ? undefined : prepared.reason);
  const session = foldBenchSession({ schemaVersion: 1, id: "sess_01J8F3K2QW9VZX4N7M0RTYB6HC", createdAt: "2026-11-01T12:00:00Z", subject: prepared.prefill.subject }, []);
  session.composer = prepared.prefill.composer; session.tokenRegistry = prepared.prefill.references; session.subjectTokens = session.tokenRegistry.map(r => r.token);
  const before = structuredClone(session), plan = planBenchDispatch(session, world, manifest, { worldId: store.worldId, requestId: "policy", at: "2026-11-01T12:00:00Z" });
  assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
  assert.ok(String(plan.inputs[0]!.params.prompt).includes(NO_BACKGROUND_MUSIC));
  assert.equal(String(plan.inputs[0]!.params.prompt).split(NO_BACKGROUND_MUSIC).length, 2);
  assert.equal(plan.reserved[0]!.request.brief, before.composer.brief); assert.deepEqual(session, before);
  production.spine = null;
  const ordinary = planBenchDispatch(session, world, manifest, { worldId: store.worldId, requestId: "ordinary", at: "2026-11-01T12:00:00Z" });
  assert.ok(ordinary.ok, ordinary.ok ? undefined : ordinary.reason);
  assert.equal(String(ordinary.inputs[0]!.params.prompt).includes(NO_BACKGROUND_MUSIC), false);
});

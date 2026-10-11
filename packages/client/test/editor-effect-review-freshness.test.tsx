import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { buildRenderPlan, defaultExportPreset, effectAnalysisCanonicalJson, EDITOR_EFFECT_RENDERER_VERSION,
  EFFECT_ANALYSIS_PROFILE, EFFECT_PRESET_CATALOGUE, EFFECT_RENDER_PROFILE, seedStoryPictureTimeline,
  type ClientState, type ProductionBundle } from "@arke-studio/contracts";
import { prepareEffectReviewFreshness, checkEffectReviewFreshness, type EffectReviewFreshnessInput,
  type PreparedEffectReviewFreshness } from "../src/lib/editor-effect-review-freshness.js";
import { effectReviewTimeline } from "../src/lib/editor-effect-review-authoring.js";
import { useEffectReviewFreshness, type EffectReviewFreshness } from "../src/screens/editor-effect-review-freshness.js";
import { effectProposalFixture } from "./effect-proposal-fixture.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); });
const digest = async (material: string) => createHash("sha256").update(material).digest("hex");
const hash = (value: unknown) => createHash("sha256").update(effectAnalysisCanonicalJson(value)).digest("hex");

/** Capture the same independent successful plan/profile fence as the coordinator. */
function fixture(): EffectReviewFreshnessInput {
  const state = structuredClone(FIXTURE_STATE) as ClientState, production = state.world!.productions[0]!;
  const base = seedStoryPictureTimeline(production), version = effectProposalFixture().version;
  production.timeline = { status: "ready", timeline: base, hash: `sha256:${hash(base)}` };
  const candidate = effectReviewTimeline(base, version);
  const result = buildRenderPlan({ production, artifacts: state.world!.artifacts, timeline: { status: "ready", timeline: candidate },
    scope: { kind: "production" }, preset: defaultExportPreset(production.meta) });
  assert.ok(result.ok);
  version.dependencies = { ...version.dependencies, base: { revision: base.revision, timelineHash: production.timeline.hash! },
    resolutionHash: hash(result.plan), profiles: { rendererVersion: EDITOR_EFFECT_RENDERER_VERSION, analysisProfileId: EFFECT_ANALYSIS_PROFILE.id,
      catalogueHash: hash({ catalogue: EFFECT_PRESET_CATALOGUE, renderer: EFFECT_RENDER_PROFILE, analysis: EFFECT_ANALYSIS_PROFILE }) } };
  return { production, artifacts: state.world!.artifacts, base, version };
}
function selectDifferentTake(production: ProductionBundle): ProductionBundle {
  const next = structuredClone(production), original = next.takes.find(take => take.kind === "clip")!;
  const replacement = { ...original, id: "tk_01J8F0000000000000000000B3" as const, media: "replacement.mp4" };
  next.takes.push(replacement);
  next.selections[original.coversShots[0]!] = { ...next.selections[original.coversShots[0]!]!, acceptedTakeId: replacement.id };
  return next;
}
function mount() { const element = document.createElement("div"); document.body.append(element); const root = createRoot(element); roots.push(root); return root; }

describe("effect proposal observable freshness", () => {
  it("matches the frozen coordinator candidate plan without changing Current", async () => {
    const input = fixture(), before = structuredClone(input);
    assert.equal(await checkEffectReviewFreshness(prepareEffectReviewFreshness(input), digest), null);
    assert.deepEqual(input, before);
  });
  it("detects selected media changes while the authored timeline revision and hash remain unchanged", async () => {
    const input = fixture(), production = selectDifferentTake(input.production);
    assert.deepEqual(production.timeline, input.production.timeline);
    const prepared = prepareEffectReviewFreshness({ ...input, production });
    assert.equal(prepared.immediateReason, null);
    assert.match((await checkEffectReviewFreshness(prepared, digest))!, /media resolution changed/i);
  });
  it("detects same-path replacement using observed artifact and take digests", async () => {
    const input = fixture(), artifact = input.artifacts[0]!, rawHash = "ab".repeat(32);
    input.version.dependencies.sources = [{ path: `artifacts/${artifact.file}`, sha256: rawHash }];
    const matching = input.artifacts.map(row => row.id === artifact.id ? { ...row, hash: `sha256:${rawHash.slice(0, 16)}` } : row);
    assert.equal(await checkEffectReviewFreshness(prepareEffectReviewFreshness({ ...input, artifacts: matching }), digest), null);
    const changed = matching.map(row => row.id === artifact.id ? { ...row, hash: `sha256:${"cd".repeat(8)}` } : row);
    assert.match(prepareEffectReviewFreshness({ ...input, artifacts: changed }).immediateReason!, /Media changed/);
    const take = input.production.takes.find(row => row.media)!;
    input.version.dependencies.sources = [{ path: `productions/${input.production.meta.id}/takes/${take.id}/${take.media}`, sha256: rawHash }];
    const production = structuredClone(input.production); production.takes.find(row => row.id === take.id)!.mediaHash = `sha256:${"cd".repeat(32)}`;
    assert.match(prepareEffectReviewFreshness({ ...input, production }).immediateReason!, /Media changed/);
    assert.deepEqual(production.timeline, input.production.timeline);
  });
  it("names removed frozen media, changed profiles and same-revision Current file changes", async () => {
    const input = fixture(), artifact = input.artifacts[0]!;
    input.version.dependencies.sources = [{ path: `artifacts/${artifact.file}`, sha256: "ab".repeat(32) }];
    assert.match(prepareEffectReviewFreshness({ ...input, artifacts: [] }).immediateReason!, /Media unavailable/);
    input.version.dependencies.sources = [];
    input.version.dependencies.profiles.catalogueHash = "00".repeat(32);
    assert.match((await checkEffectReviewFreshness(prepareEffectReviewFreshness(input), digest))!, /catalogue/);
    const production = structuredClone(input.production);
    assert.equal(production.timeline?.status, "ready");
    if (production.timeline?.status === "ready") production.timeline.hash = `sha256:${"fe".repeat(32)}`;
    assert.match(prepareEffectReviewFreshness({ ...input, production }).immediateReason!, /Current changed/);
  });
  it("never lets an earlier digest clear newer stale media for the same candidate version", async () => {
    const input = fixture(), next = { ...input, production: selectDifferentTake(input.production) };
    const pending: Array<{ prepared: PreparedEffectReviewFreshness; resolve: (reason: string | null) => void }> = [];
    const check = (prepared: PreparedEffectReviewFreshness) => new Promise<string | null>(resolve => pending.push({ prepared, resolve }));
    let latest!: EffectReviewFreshness;
    function Probe({ value }: { value: EffectReviewFreshnessInput }) {
      latest = useEffectReviewFreshness(value.production, value.artifacts, value.base, value.version, check); return null;
    }
    const root = mount(); await act(async () => root.render(<Probe value={input} />));
    assert.equal(latest.checking, true); assert.equal(pending.length, 1);
    await act(async () => root.render(<Probe value={next} />));
    assert.equal(latest.checking, true); assert.equal(pending.length, 2);
    assert.equal(pending[0]!.prepared.candidateHash, pending[1]!.prepared.candidateHash);
    await act(async () => pending[1]!.resolve(await checkEffectReviewFreshness(pending[1]!.prepared, digest)));
    const stale = latest.staleReason; assert.match(stale!, /media resolution changed/); assert.equal(latest.checking, false);
    await act(async () => pending[0]!.resolve(await checkEffectReviewFreshness(pending[0]!.prepared, digest)));
    assert.deepEqual(latest, { checking: false, staleReason: stale });
  });
  it("does no hashing for hidden candidates and drops in-flight work when inspection closes", async () => {
    const input = fixture(); let finish: ((reason: string | null) => void) | undefined, calls = 0, latest!: EffectReviewFreshness;
    const check = () => { calls++; return new Promise<string | null>(resolve => { finish = resolve; }); };
    function Probe({ inspected }: { inspected: boolean }) {
      latest = useEffectReviewFreshness(input.production, input.artifacts, input.base, inspected ? input.version : undefined, check); return null;
    }
    const root = mount(); await act(async () => root.render(<Probe inspected={false} />));
    assert.equal(calls, 0); assert.deepEqual(latest, { checking: false, staleReason: null });
    await act(async () => root.render(<Probe inspected />)); assert.equal(calls, 1); assert.equal(latest.checking, true);
    await act(async () => root.render(<Probe inspected={false} />));
    await act(async () => finish!("Old digest failure"));
    assert.deepEqual(latest, { checking: false, staleReason: null });
  });
});

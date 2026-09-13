import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findHarnessModel, harnessModelDisabled, harnessModelManifestEntry, harnessModelReference,
  ManifestModelSchema, ModelInfoSchema, type ModelInfo,
} from "../src/index.js";

const legacy = (id: string, providerModelId = id, provider: "anthropic" | "openai" = "anthropic") => ManifestModelSchema.parse({
  id, providerModelId, provider, capability: "llm", displayName: id,
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "unmetered" },
});
const opus: ModelInfo = { id: "claude-example[1m]", provider: "anthropic", aliases: ["opus[1m]", "default"], isDefault: true };
const sonnet: ModelInfo = { id: "claude-other", provider: "anthropic", aliases: ["sonnet"] };

describe("harness model identity", () => {
  it("keeps provider and opaque model ids separate, including unknown providers and slashes", () => {
    const remote: ModelInfo = { id: "team/model:tag", provider: "private-harness-provider" };
    assert.equal(harnessModelReference(remote), "private-harness-provider/team/model:tag");
    assert.equal(findHarnessModel("private-harness-provider/team/model:tag", [remote]), remote);
  });

  it("pins canonical provider-qualified identities even if another row aliases that name", () => {
    const alias: ModelInfo = { id: "different", provider: "anthropic", aliases: [opus.id] };
    assert.equal(findHarnessModel(harnessModelReference(opus), [alias, opus]), opus);
  });

  it("resolves an advertised alias within its provider without substituting another provider", () => {
    const other: ModelInfo = { id: "custom", provider: "openai", aliases: ["sonnet"] };
    assert.equal(findHarnessModel("anthropic/sonnet", [sonnet, other]), sonnet);
    assert.equal(findHarnessModel("sonnet", [sonnet, other]), undefined);
    assert.equal(findHarnessModel("sonnet", [sonnet]), sonnet);
  });

  it("does not turn a missing qualified model into another provider's bare model id", () => {
    const remote: ModelInfo = { id: "openai/deleted", provider: "private-provider" };
    assert.equal(findHarnessModel("openai/deleted", [remote]), undefined);
    assert.equal(findHarnessModel("private-provider/openai/deleted", [remote]), remote);
  });

  it("refuses ambiguous alias rows and duplicate canonical identities", () => {
    const alias: ModelInfo = { id: "other", provider: "anthropic", aliases: ["sonnet"] };
    assert.equal(findHarnessModel("anthropic/sonnet", [sonnet, alias]), undefined);
    assert.equal(findHarnessModel(harnessModelReference(sonnet), [sonnet, { ...sonnet }]), undefined);
  });

  it("reads legacy world ids through providerModelId without admitting stale or media-only entries", () => {
    const old = legacy("old-world-choice", "sonnet");
    assert.equal(findHarnessModel("old-world-choice", [sonnet], [old]), sonnet);
    assert.equal(findHarnessModel("old-world-choice", [opus], [old]), undefined);
    assert.equal(findHarnessModel("old-world-choice", [sonnet], [{ ...old, capability: "image" }]), undefined);
    assert.equal(findHarnessModel("old-world-choice", [{ ...sonnet, provider: "openai" }], [old]), undefined);
  });

  it("does not conflate a context variant with its base model", () => {
    const base: ModelInfo = { id: "claude-example", provider: "anthropic" };
    assert.equal(findHarnessModel("anthropic/claude-example", [opus, base]), base);
    assert.equal(findHarnessModel("anthropic/claude-example", [opus]), undefined);
    assert.equal(harnessModelManifestEntry(opus, [legacy("base-choice", base.id)]), undefined);
  });

  it("does not make manifest membership a condition of selecting a new live model", () => {
    const next: ModelInfo = { id: "tomorrow", provider: "new-provider" };
    assert.equal(findHarnessModel("new-provider/tomorrow", [next], [legacy("old")]), next);
    assert.equal(harnessModelManifestEntry(next, [legacy("old")]), undefined);
  });
});

describe("legacy disabled preferences", () => {
  it("honors canonical refs, advertised aliases and legacy manifest ids for the same provider", () => {
    const old = legacy("old-world-choice", "sonnet");
    for (const disabled of ["anthropic/claude-other", "anthropic/sonnet", "old-world-choice"]) {
      assert.equal(harnessModelDisabled(sonnet, [disabled], [old]), true, disabled);
    }
    assert.equal(harnessModelManifestEntry(sonnet, [old]), old);
  });

  it("does not disable an unrelated provider merely because its model has the same bare id", () => {
    const other: ModelInfo = { ...sonnet, provider: "private-provider" };
    const old = legacy("claude-other");
    assert.equal(harnessModelDisabled(other, ["claude-other"], [old]), false);
    assert.equal(harnessModelDisabled(other, ["anthropic/claude-other"], [old]), false);
    assert.equal(harnessModelDisabled(other, ["private-provider/claude-other"], [old]), true);
  });
});

describe("catalog metadata on the wire", () => {
  it("distinguishes unknown modalities from an explicit text-only result", () => {
    assert.equal(ModelInfoSchema.parse(sonnet).inputModalities, undefined);
    assert.deepEqual(ModelInfoSchema.parse({ ...sonnet, inputModalities: ["text"] }).inputModalities, ["text"]);
    assert.deepEqual(ModelInfoSchema.parse({ ...sonnet, inputModalities: [] }).inputModalities, []);
    assert.equal(ModelInfoSchema.safeParse({ ...sonnet, inputTokenLimit: 0 }).success, false);
    assert.equal(ModelInfoSchema.safeParse({ ...sonnet, inputTokenLimit: 1.5 }).success, false);
  });
});

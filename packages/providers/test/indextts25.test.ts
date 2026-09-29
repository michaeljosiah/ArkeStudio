import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { INDEXTTS25_MANIFEST, INDEXTTS25_CHECKPOINTS, indexTtsManifestIssues, indexTtsBuildAvailability } from "../src/comfyui/indextts25.js";
import { comfyUiRecipeById, recipeDependencyDigest } from "../src/comfyui/recipes.js";

describe("IndexTTS 2.5 dependency manifest", () => {
  it("catalogues the full pinned source and all 26 model/config/tokenizer/auxiliary files", () => {
    assert.deepEqual(indexTtsManifestIssues(INDEXTTS25_MANIFEST), []);
    assert.equal(INDEXTTS25_CHECKPOINTS.length, 26);
    assert.equal(INDEXTTS25_CHECKPOINTS.reduce((sum, file) => sum + file.sizeBytes, 0), 8290508298);
    assert.equal(INDEXTTS25_MANIFEST.models[0]!.revision, "ba2480d9f7f629eb18f6acaebb357679d9ba88a4");
    assert.ok(INDEXTTS25_CHECKPOINTS.some(file => file.file.endsWith("codec.pth")));
    assert.ok(!INDEXTTS25_CHECKPOINTS.some(file => file.file.includes("MaskGCT")), "2.5 uses its own codec, not the legacy 2.0 auxiliary");
  });

  it("rejects omission of every individual required artifact and a completely empty model list", () => {
    for (const missing of [null, {}, { ...INDEXTTS25_MANIFEST, python: undefined }, { ...INDEXTTS25_MANIFEST, source: undefined }]) {
      assert.ok(indexTtsManifestIssues(missing).length > 0);
      assert.equal(indexTtsBuildAvailability(missing).status, "unsupported_in_build");
    }
    for (const artifact of INDEXTTS25_CHECKPOINTS) {
      const broken = structuredClone(INDEXTTS25_MANIFEST);
      for (const group of broken.models) group.files = group.files.filter(file => file.file !== artifact.file);
      assert.ok(indexTtsManifestIssues(broken).some(issue => issue === `Required model artifact is missing: ${artifact.file}`), artifact.file);
      assert.equal(indexTtsBuildAvailability(broken).status, "unsupported_in_build");
    }
    assert.equal(indexTtsManifestIssues({ ...INDEXTTS25_MANIFEST, models: [] }).filter(issue => issue.startsWith("Required model artifact")).length, 26);
  });

  it("rejects mutable source or model URLs, bad hashes, sizes, paths and duplicates", () => {
    const changes = [
      (m: typeof INDEXTTS25_MANIFEST) => { m.source.commit = "main"; },
      (m: typeof INDEXTTS25_MANIFEST) => { m.source.archive.sha256 = "0".repeat(64); },
      (m: typeof INDEXTTS25_MANIFEST) => { m.source.archive.url = m.source.archive.url.replace(m.source.commit, "main"); },
      (m: typeof INDEXTTS25_MANIFEST) => { m.models[0]!.revision = "main"; },
      (m: typeof INDEXTTS25_MANIFEST) => { m.models[0]!.repository = "other/IndexTTS-2.5"; },
      (m: typeof INDEXTTS25_MANIFEST) => { m.models[0]!.files[0]!.url = m.models[0]!.files[0]!.url.replace(m.models[0]!.revision, "main"); },
      (m: typeof INDEXTTS25_MANIFEST) => { m.models[0]!.files[0]!.sha256 = ""; },
      (m: typeof INDEXTTS25_MANIFEST) => { m.models[0]!.files[0]!.sizeBytes = 0; },
      (m: typeof INDEXTTS25_MANIFEST) => { m.models[0]!.files[0]!.sizeMb = 1; },
      (m: typeof INDEXTTS25_MANIFEST) => { m.models[0]!.files[0]!.file = "../outside.pth"; },
      (m: typeof INDEXTTS25_MANIFEST) => { m.models[0]!.files[0]!.file = "C:/outside.pth"; },
      (m: typeof INDEXTTS25_MANIFEST) => {
        m.models[0]!.files[0]!.file = m.models[0]!.files[0]!.file.replace("LICENSE", "license");
        m.models[0]!.files[0]!.url = m.models[0]!.files[0]!.url.replace("LICENSE", "license");
      },
      (m: typeof INDEXTTS25_MANIFEST) => { m.models[0]!.files.push(m.models[0]!.files[0]!); },
      (m: typeof INDEXTTS25_MANIFEST) => { m.models.push(m.models[0]!); },
      (m: typeof INDEXTTS25_MANIFEST) => { m.python.lockSha256 = ""; },
      (m: typeof INDEXTTS25_MANIFEST) => { m.python.packageCount = 0; },
      (m: typeof INDEXTTS25_MANIFEST) => { m.python.lockFile = "../outside.lock"; },
      (m: typeof INDEXTTS25_MANIFEST) => { m.python.arch = "arm64"; },
    ];
    for (const change of changes) {
      const broken = structuredClone(INDEXTTS25_MANIFEST);
      change(broken);
      assert.ok(indexTtsManifestIssues(broken).length > 0, change.toString());
    }
  });

  it("ships a digest-verified candidate lock with exact versions and hashes for every resolved package", async () => {
    const lock = await readFile(new URL(`../../../${INDEXTTS25_MANIFEST.python.lockFile}`, import.meta.url));
    assert.equal(createHash("sha256").update(lock).digest("hex"), INDEXTTS25_MANIFEST.python.lockSha256);
    const requirements = lock.toString().split(/\\\r?\n/).join(" ").split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith("#"));
    assert.equal(requirements.length, INDEXTTS25_MANIFEST.python.packageCount);
    const names = new Set<string>();
    for (const line of requirements) {
      assert.match(line, /^[a-zA-Z0-9_.-]+==[^\s]+\s+--hash=sha256:[a-f0-9]{64}/);
      const name = line.split("==")[0]!;
      assert.ok(!names.has(name), name);
      names.add(name);
    }
    for (const name of ["torch", "torchaudio", "transformers", "librosa", "numpy", "omegaconf", "modelscope", "sentencepiece", "tiktoken", "fugashi", "unidic-lite", "matplotlib"]) {
      assert.ok(names.has(name), `${name} is required by the pinned inference code`);
    }
  });

  it("does not mistake model/source completeness or a candidate lock for a supported build", () => {
    const availability = indexTtsBuildAvailability(INDEXTTS25_MANIFEST);
    assert.equal(availability.status, "unsupported_in_build");
    assert.match(availability.reason!, /Python dependency/);
    const untested = structuredClone(INDEXTTS25_MANIFEST);
    untested.python.installationVerified = false;
    untested.python.bundle = { url: "https://example.test/pinned.zip", sha256: INDEXTTS25_MANIFEST.source.archive.sha256, sizeBytes: 123 };
    assert.equal(indexTtsBuildAvailability(untested).status, "unsupported_in_build");
    const unpublished = structuredClone(INDEXTTS25_MANIFEST);
    unpublished.python.installationVerified = true;
    assert.equal(indexTtsBuildAvailability(unpublished).status, "unsupported_in_build");
    const noSmoke = structuredClone(INDEXTTS25_MANIFEST);
    noSmoke.python.bundle = untested.python.bundle;
    assert.equal(indexTtsBuildAvailability(noSmoke).status, "unsupported_in_build");
    noSmoke.python.offlineInferenceVerified = true;
    assert.match(indexTtsBuildAvailability(noSmoke).reason!, /managed installation.*not integrated/,
      "manifest flags alone cannot supply a missing managed installer");
    const recipe = comfyUiRecipeById("comfyui-cloned-voice")!;
    assert.equal(recipe.requires.unavailableReason, availability.reason);
    assert.equal(recipe.displayName, "Local · Cloned Voice");
  });

  it("freezes provisioning identity together with weights and custom-node source", () => {
    const recipe = comfyUiRecipeById("comfyui-cloned-voice")!;
    const changed = structuredClone(recipe);
    changed.requires.provisioningDigest = "b".repeat(64);
    assert.notEqual(recipeDependencyDigest(changed), recipeDependencyDigest(recipe));
    assert.equal(recipe.requires.checkpoints.length, 26);
  });
});

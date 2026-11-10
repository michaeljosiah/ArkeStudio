import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { assertSupportedSpeechFiles, pruneUnsupportedSpeechFiles } from "../scripts/speech-runtime-files.mjs";

it("rejects the omitted ARM bootstrappers and prunes only those files from an x64 runtime", t => {
  const root = mkdtempSync(join(tmpdir(), "arke-speech-files-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const packages = join(root, "Lib/site-packages");
  const foreign = ["pip/_vendor/distlib/t64-arm.exe", "pip/_vendor/distlib/w64-arm.exe", "setuptools/cli-arm64.exe", "setuptools/gui-arm64.exe"];
  const retained = ["pip/_vendor/distlib/t64.exe", "pip/_vendor/distlib/w64.exe", "setuptools/cli-64.exe", "setuptools/__init__.py", "pip/LICENSE.txt"];
  for (const relative of [...foreign, ...retained]) {
    const path = join(packages, relative); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, relative);
  }
  assert.throws(() => assertSupportedSpeechFiles(root), /Unsupported speech bootstrap/);
  pruneUnsupportedSpeechFiles(root);
  assert.doesNotThrow(() => assertSupportedSpeechFiles(root));
  for (const relative of retained) assert.equal(readFileSync(join(packages, relative), "utf8"), relative);
  pruneUnsupportedSpeechFiles(root); // Re-staging is safe.
});

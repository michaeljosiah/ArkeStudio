import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { ArtifactTransferSettingsSchema } from "@arke-studio/contracts";
import { ArtifactResultFiles, ArtifactCheckpointInvalid } from "../../src/queue/artifact-files.js";
import { tempDir } from "../tmp.js";

it("lowering new-result preferences cannot strand a completed receipt saved under raised limits", async () => {
  const root = await tempDir("arke-result-preference-"), job = { id: "saved-one", attempt: 1, provider: "fal", providerJobId: "accepted-one", resultReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" };
  let settings = ArtifactTransferSettingsSchema.parse({ maxFiles: 65 });
  const files = new ArtifactResultFiles(join(root, "jobs.jsonl"), undefined, undefined, () => settings);
  const artifacts = Array.from({ length: 65 }, (_, index) => ({ name: `${index}.bin`, contentType: "application/octet-stream", data: new Uint8Array([index]) }));
  await files.save(job, artifacts, new AbortController().signal);
  settings = ArtifactTransferSettingsSchema.parse({ maxFiles: 1 });
  assert.equal((await files.read(job))!.artifacts.length, 65);
  await assert.rejects(files.save({ ...job, resultReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" }, artifacts, new AbortController().signal), ArtifactCheckpointInvalid);
  assert.equal((await files.read(job))!.artifacts.length, 65);
});

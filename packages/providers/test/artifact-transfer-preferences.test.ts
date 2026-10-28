import assert from "node:assert/strict";
import { it } from "node:test";
import { ArtifactTransferSettingsSchema } from "@arke-studio/contracts";
import { FalClient } from "../src/clients/fal.js";
import { ProviderArtifactLimitError } from "../src/types.js";

const remote = "fal-ai/flux-2-pro::accepted-one";
it("FAL accepts an explicitly raised file count and retains its default for ordinary callers", async () => {
  let requests = 0;
  const client = new FalClient(async url => {
    requests++;
    return url.includes("/requests/") ? Response.json({ images: Array.from({ length: 65 }, () => ({ url: "https://assets.test/file" })) }) : new Response(new Uint8Array([1]));
  });
  await assert.rejects(client.fetchArtifacts("key", remote), ProviderArtifactLimitError); assert.equal(requests, 1);
  const result = await client.fetchArtifacts("key", remote, undefined, { transferSettings: ArtifactTransferSettingsSchema.parse({ maxFiles: 65 }) });
  assert.equal(result.length, 65); assert.equal(requests, 67);
});
it("FAL applies selected per-file and total limits to actual bytes, not just headers", async () => {
  let media = 0;
  const client = new FalClient(async url => url.includes("/requests/")
    ? Response.json({ images: [{ url: "https://assets.test/a" }, { url: "https://assets.test/b" }] })
    : (media++, new Response(new Uint8Array(600 * 1024))));
  const small = ArtifactTransferSettingsSchema.parse({ maxFileMiB: 1, maxTotalMiB: 1 });
  await assert.rejects(client.fetchArtifacts("key", remote, undefined, { transferSettings: small }), ProviderArtifactLimitError);
  assert.equal(media, 2);
  const result = await client.fetchArtifacts("key", remote, undefined, { transferSettings: { ...small, maxTotalMiB: 2 } });
  assert.equal(result.length, 2); assert.equal(result[1]!.data.length, 600 * 1024);
});

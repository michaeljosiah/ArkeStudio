import assert from "node:assert/strict";
import { it } from "node:test";
import { ArtifactTransferSettingsSchema } from "@arke-studio/contracts";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import { FalClient } from "../src/clients/fal.js";
import { HiggsfieldClient } from "../src/clients/higgsfield.js";
import { ProviderArtifactLimitError, type ArtifactFetchOptions, type FetchLike } from "../src/types.js";

function fixture(provider: "fal" | "comfyui" | "higgsfield", asset: FetchLike, count = 1) {
  let downloads = 0, queries = 0;
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("/requests/")) { queries++; return Response.json({ images: Array.from({ length: count }, () => ({ url: "https://assets.test/file" })) }); }
    if (url.includes("/history/")) { queries++; return Response.json({ accepted: { outputs: { "9": { images: Array.from({ length: count }, () => ({ filename: "arke_00001_.png" })) } } } }); }
    downloads++; return asset(url, init);
  };
  const run = async () => { queries++; return { code: 0, stdout: JSON.stringify({ result_url: "https://assets.test/file" }), stderr: "" }; };
  const client = provider === "fal" ? new FalClient(fetch) : provider === "higgsfield" ? new HiggsfieldClient(run, fetch)
    : new ComfyUiClient(fetch, () => "http://127.0.0.1:8188", async () => ({ ok: true }));
  return { retrieve: (options?: ArtifactFetchOptions) => client.fetchArtifacts("", provider === "fal" ? "fal-ai/flux-2-pro::accepted" : "accepted",
    { model: "comfyui-draft-image" }, options), downloads: () => downloads, queries: () => queries };
}

for (const provider of ["fal", "comfyui", "higgsfield"] as const) {
  it(`${provider} enforces selected decoded-file limits and accepts an explicitly raised limit`, async () => {
    const settings = ArtifactTransferSettingsSchema.parse({ maxFileMiB: 1, maxTotalMiB: 2 });
    const source = fixture(provider, async () => new Response(new Uint8Array(1100 * 1024)));
    await assert.rejects(source.retrieve({ transferSettings: settings }), ProviderArtifactLimitError);
    const result = await source.retrieve({ transferSettings: { ...settings, maxFileMiB: 2 } });
    assert.equal(result[0]!.data.length, 1100 * 1024);
  });

  it(`${provider} cancels a stalled original body at the selected deadline`, async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let entered!: () => void, cancelled = 0;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const source = fixture(provider, async () => new Response(new ReadableStream<Uint8Array>({
      pull() { entered(); return new Promise<void>(() => {}); }, cancel() { cancelled++; },
    })));
    const outcome = assert.rejects(source.retrieve({ transferSettings: ArtifactTransferSettingsSchema.parse({ timeoutMinutes: 1 }) }), { name: "TimeoutError" });
    await ready;
    context.mock.timers.tick(60_000);
    await outcome;
    await Promise.resolve();
    assert.equal(cancelled, 1); assert.equal(source.downloads(), 1);
  });

  it(`${provider} refuses an already cancelled retrieval before any provider I/O`, async () => {
    const source = fixture(provider, async () => new Response("unreachable")), abort = new AbortController();
    abort.abort(new Error("user stopped"));
    await assert.rejects(source.retrieve({ signal: abort.signal }), /user stopped/);
    assert.equal(source.queries(), 0); assert.equal(source.downloads(), 0);
  });
}

it("ComfyUI enforces one file-count and aggregate budget across the recipe's declared outputs", async () => {
  const many = fixture("comfyui", async () => new Response(new Uint8Array([1])), 65);
  await assert.rejects(many.retrieve(), ProviderArtifactLimitError); assert.equal(many.downloads(), 0);
  assert.equal((await many.retrieve({ transferSettings: ArtifactTransferSettingsSchema.parse({ maxFiles: 65 }) })).length, 65);
  const combined = fixture("comfyui", async () => new Response(new Uint8Array(600 * 1024)), 2);
  const settings = ArtifactTransferSettingsSchema.parse({ maxFileMiB: 1, maxTotalMiB: 1 });
  await assert.rejects(combined.retrieve({ transferSettings: settings }), ProviderArtifactLimitError);
  assert.equal((await combined.retrieve({ transferSettings: { ...settings, maxTotalMiB: 2 } })).length, 2);
});

it("cancelling a Higgsfield result query cannot start a download when the original CLI answers later", async () => {
  let finish!: (result: { code: number; stdout: string; stderr: string }) => void, entered!: () => void, downloads = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const client = new HiggsfieldClient(async () => { entered(); return new Promise(resolve => { finish = resolve; }); }, async () => { downloads++; return new Response("late"); });
  const abort = new AbortController(), outcome = assert.rejects(client.fetchArtifacts("", "accepted", undefined, { signal: abort.signal }), /user stopped/);
  await ready; abort.abort(new Error("user stopped")); await outcome;
  finish({ code: 0, stdout: JSON.stringify({ result_url: "https://assets.test/file" }), stderr: "" });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(downloads, 0);
});

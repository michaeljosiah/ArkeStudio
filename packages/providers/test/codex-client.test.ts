import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROVIDERS } from "@arke-studio/contracts";
import { CodexClient, type CodexImageRunner } from "../src/clients/codex.js";
import { createProviderClients } from "../src/registry.js";
import { ProviderAuthError, ProviderRequestRejectedError, type FetchLike } from "../src/types.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const runner = (over: Partial<CodexImageRunner> = {}): CodexImageRunner => ({
  status: async () => ({ authMode: "chatgpt", imageGeneration: true }),
  generate: async () => ({ bytes: PNG, mimeType: "image/png" }),
  ...over,
});
const noFetch = (() => Promise.reject(new Error("no network"))) as FetchLike;

describe("codex image client", () => {
  it("is an external-credential image provider and is absent without a runner", () => {
    assert.equal(PROVIDERS.codex.credential, "external");
    assert.deepEqual(PROVIDERS.codex.capabilities, ["image"]);
    assert.equal(createProviderClients({ fetch: noFetch }).codex, undefined);
    assert.ok(createProviderClients({ fetch: noFetch, codexImage: runner() }).codex);
  });

  it("probes available only for a ChatGPT sign-in that offers images", async () => {
    assert.deepEqual(await new CodexClient(runner()).validateKey(""), [{ capability: "image", available: true }]);
    const reason = async (status: Awaited<ReturnType<CodexImageRunner["status"]>>) =>
      (await new CodexClient(runner({ status: async () => status })).validateKey(""))[0]!;
    assert.match((await reason({ authMode: "none", imageGeneration: false })).reason!, /codex login/);
    assert.match((await reason({ authMode: "apiKey", imageGeneration: true })).reason!, /ChatGPT sign-in/);
    assert.match((await reason({ authMode: "chatgpt", imageGeneration: false })).reason!, /does not offer image/);
    const down = await new CodexClient(runner({ status: async () => { throw new Error("Codex is not running."); } })).validateKey("");
    assert.equal(down[0]!.available, false);
  });

  it("returns the picture from submit, passes references through and reports no cost", async () => {
    let seen: Parameters<CodexImageRunner["generate"]>[0] | undefined;
    const client = new CodexClient(runner({ generate: async input => { seen = input; return { bytes: PNG, mimeType: "image/png" }; } }));
    const reference = { name: "ref", contentType: "image/png" as const, data: PNG };
    const result = await client.submit("", { model: "codex-image", capability: "image", params: { prompt: "a lighthouse", references: [{}] }, imageReferences: [reference] });
    assert.equal(seen!.prompt, "a lighthouse"); assert.deepEqual(seen!.references, [reference]);
    assert.equal(result.artifacts![0]!.name, "image-1.png"); assert.equal(result.costMicroUsd, undefined);
    assert.deepEqual(await client.poll("", result.remoteId), { state: "succeeded" });
    assert.deepEqual(await client.fetchArtifacts("", result.remoteId), result.artifacts);
    assert.equal((await client.poll("", "missing")).state, "failed");
    assert.equal(client.declarations.reportsCost, false);
  });

  it("refuses a missing prompt, an unprepared reference and any other capability", async () => {
    const client = new CodexClient(runner());
    await assert.rejects(client.submit("", { model: "m", capability: "image", params: { prompt: " " } }), /prompt is required/);
    await assert.rejects(client.submit("", { model: "m", capability: "image", params: { prompt: "x", references: [{}] } }), /not every image reference/);
    await assert.rejects(client.submit("", { model: "m", capability: "video", params: { prompt: "x" } }), /only image/);
  });

  it("maps a plan limit to a rejected request and a lost sign-in to an auth error", async () => {
    const limit = Object.assign(new Error("limit"), { name: "CodexImageLimitError", resetsAt: 1900000000 });
    await assert.rejects(new CodexClient(runner({ generate: async () => { throw limit; } })).submit("", { model: "m", capability: "image", params: { prompt: "x" } }),
      error => error instanceof ProviderRequestRejectedError && /image limit.*2030/.test(error.message));
    await assert.rejects(new CodexClient(runner({ generate: async () => { throw new Error("Codex image generation is not available for this login."); } })).submit("", { model: "m", capability: "image", params: { prompt: "x" } }),
      error => error instanceof ProviderAuthError);
  });
});

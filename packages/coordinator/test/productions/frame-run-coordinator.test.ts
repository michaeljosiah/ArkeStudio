import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { ulid, type ClientMessage, type DomainEvent, type ManifestModel, type ModelManifest } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { tempDir } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

type StartResult = Extract<DomainEvent, { type: "production.frame-run-start-result" }>;

describe("frame-run coordinator acknowledgements", () => {
  it("always refuses start when the world store and manifest are unavailable", async () => {
    const root = await tempDir("arke-frame-run-coordinator-");
    const provider = new FsWorldProvider(root);
    const events: DomainEvent[] = [];
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      appVersion: "test",
      changeLogPath: join(root, "changes.jsonl"),
      observeEvent: (event) => events.push(event),
    });
    const requestId = ulid();
    const quoteId = ulid();
    const message = {
      kind: "frame-run-start",
      requestId,
      quoteId,
      quoteSignature: `sha256:${"a".repeat(64)}`,
      quotedMicroUsd: 1,
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      productionId: "saltlight",
      sceneId: "sc_04",
      mode: "per-shot",
      modelId: "image-model",
      scope: "all",
    } as ClientMessage;
    await (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> })
      .handleClientMessage(message);
    const results = events.filter((event): event is StartResult => event.type === "production.frame-run-start-result");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.disposition, "refused");
    assert.equal(results[0]!.requestId, requestId);
    assert.equal(results[0]!.quoteId, quoteId);
    await coordinator.stop();
    await provider.close();
  });

  it("emits refused only when first-step queue admission fails", async () => {
    const made = await makeTempRoot();
    const provider = new FsWorldProvider(made.root);
    await provider.loadWorld(WORLD_ID);
    const image: ManifestModel = {
      id: "frame-image",
      provider: "fal",
      capability: "image",
      displayName: "Frame Image",
      accepts: { referenceImages: 8, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "perImage", microUsdPerImage: 1000 },
    };
    const video: ManifestModel = {
      id: "board-video",
      provider: "fal",
      capability: "video",
      displayName: "Board Video",
      accepts: { referenceImages: 4, startFrame: false, endFrame: false },
      limits: { maxDurationSec: 30, storyboardPanels: 6 },
      pricing: { kind: "perSecond", microUsdPerSecond: 1000 },
    };
    const manifest: ModelManifest = { manifestVersion: 1, generated: "2026-08-30", models: [image, video] };
    const events: DomainEvent[] = [];
    const coordinator = new Coordinator({
      provider,
      manifest,
      adapter: null,
      appVersion: "test",
      changeLogPath: join(made.root, "changes.jsonl"),
      observeEvent: (event) => events.push(event),
    });
    try {
      coordinator.emit({
        at: new Date().toISOString(),
        type: "provider.status",
        providers: [{
          id: "fal",
          configured: true,
          validation: "valid",
          probes: [{ capability: "image", available: true }, { capability: "video", available: true }],
          fault: null,
        }],
      });
      const send = (message: ClientMessage) =>
        (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
      const requestId = ulid();
      await send({
      kind: "frame-run-quote",
      requestId,
      worldId: WORLD_ID,
      productionId: "saltlight",
      sceneId: "sc_04",
      mode: "per-shot",
      modelId: image.id,
      scope: "all",
      });
      const quoted = events.find((event) => event.type === "production.frame-run-quote");
      assert.ok(quoted?.type === "production.frame-run-quote");
      assert.equal(quoted.quote.blockedReason, null);
      await send({
      kind: "frame-run-start",
      requestId,
      quoteId: quoted.quote.quoteId,
      quoteSignature: quoted.quote.signature!,
      quotedMicroUsd: quoted.quote.estimatedMicroUsd!,
      worldId: WORLD_ID,
      productionId: "saltlight",
      sceneId: "sc_04",
      mode: "per-shot",
      modelId: image.id,
      scope: "all",
      });
      const results = events.filter((event): event is StartResult => event.type === "production.frame-run-start-result");
      assert.deepEqual(results.map((result) => result.disposition), ["refused"]);
      assert.deepEqual(
        await readdir(join(made.worldDir, "productions", "saltlight", "runs")).catch(() => []),
        [],
        "the unjournaled provisional run is removed",
      );
    } finally {
      await coordinator.stop();
      await provider.close();
    }
  });
});

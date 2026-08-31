import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  newId,
  ulid,
  type ClientMessage,
  type DomainEvent,
  type SessionId,
} from "@arke-studio/contracts";
import { openBenchSession, openSubjectBenchSession } from "../../src/bench/service.js";
import { sessionMediaDir } from "../../src/bench/store.js";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const CLOCK = () => "2026-08-31T12:00:00.000Z";

describe("production subject coordinator replies", () => {
  it("reserves each concurrent dispatch from that command's persisted composer", async () => {
    const { root, worldDir } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    closeOnCleanup(() => provider.close());
    await provider.loadWorld(WORLD_ID);
    const sessionId = newId("sess") as SessionId;
    const opened = await openBenchSession(worldDir, CLOCK, {
      sessionId,
      defaultModel: { provider: "fal", model: "test-image" },
      initial: { mode: "image", brief: "Initial draft." },
    });
    assert.ok(opened);
    const events: DomainEvent[] = [];
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      observeEvent: (event) => events.push(event),
      manifest: {
        manifestVersion: 1,
        generated: "2026-08-31",
        models: [
          {
            id: "test-image",
            provider: "fal",
            capability: "image",
            displayName: "Test Image",
            accepts: { referenceImages: 0, startFrame: false, endFrame: false },
            limits: { aspects: ["16:9"] },
            pricing: { kind: "perImage", microUsdPerImage: 1 },
          },
        ],
      },
    });
    const send = (message: ClientMessage) =>
      (
        coordinator as unknown as {
          handleClientMessage(message: ClientMessage): Promise<void>;
        }
      ).handleClientMessage(message);
    const firstRequest = ulid();
    const secondRequest = ulid();
    const dispatch = (requestId: string, brief: string) =>
      send({
        kind: "bench-dispatch",
        worldId: WORLD_ID,
        sessionId,
        requestId,
        composer: {
          mode: "image",
          provider: "fal",
          model: "test-image",
          params: { kind: "image", count: 1, aspect: "16:9" },
          brief,
        },
      });

    await Promise.all([
      dispatch(firstRequest, "First exact draft."),
      dispatch(secondRequest, "Second exact draft."),
    ]);

    const session = await opened.store.fold();
    const requests = new Map(session?.takes.map((take) => [take.requestId, take.request.brief]));
    assert.equal(requests.get(firstRequest), "First exact draft.");
    assert.equal(requests.get(secondRequest), "Second exact draft.");
    assert.deepEqual(session?.takes.map((take) => take.n), [1, 2]);
  });

  it("answers Open and Rebuild when asynchronous preparation throws", async () => {
    const { root, worldDir } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    closeOnCleanup(() => provider.close());
    await provider.loadWorld(WORLD_ID);
    const sessionId = newId("sess") as SessionId;
    await openSubjectBenchSession(worldDir, sessionId, CLOCK(), {
      subject: {
        kind: "shot",
        productionId: "saltlight",
        productionTitle: "Saltlight",
        sceneId: "sc_04",
        sceneNumber: 4,
        sceneTitle: "The verse rises",
        shotId: "sh_12",
        shotNumber: 12,
        shotTitle: "Maren at the rail",
        durationSec: 4,
        aspect: "16:9",
      },
      title: "Saltlight - Scene 4 - Shot 12",
      references: [],
      composer: {
        mode: "image",
        provider: "fal",
        model: "fal-ai/flux-pro/kontext/max/text-to-image",
        params: { kind: "image", count: 1, aspect: "16:9" },
        brief: "Maren at the rail.",
        activeTokens: [],
        keyframeTokens: [],
      },
    });
    const events: DomainEvent[] = [];
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      observeEvent: (event) => events.push(event),
    });
    (coordinator as unknown as { appSettings: { load(): Promise<never> } }).appSettings = {
      load: async () => {
        throw new Error("settings unavailable");
      },
    };
    const send = (message: ClientMessage) =>
      (
        coordinator as unknown as {
          handleClientMessage(message: ClientMessage): Promise<void>;
        }
      ).handleClientMessage(message);

    const openRequest = ulid();
    await send({
      kind: "bench-open-subject",
      worldId: WORLD_ID,
      requestId: openRequest,
      productionId: "saltlight",
      sceneId: "sc_04",
      subject: { kind: "shot", shotId: "sh_12" },
    });
    const rebuildRequest = ulid();
    await send({
      kind: "bench-rebuild-subject",
      worldId: WORLD_ID,
      requestId: rebuildRequest,
      sessionId,
    });

    const answers = events.filter(
      (event): event is Extract<DomainEvent, { type: "bench.subject-opened" }> =>
        event.type === "bench.subject-opened",
    );
    assert.deepEqual(
      answers.map((answer) => [answer.requestId, answer.sessionId, answer.reason]),
      [
        [openRequest, null, "settings unavailable"],
        [rebuildRequest, null, "settings unavailable"],
      ],
    );
  });

  it("lets a concurrent Discard finish before Accept can file the same take", async () => {
    const { root, worldDir } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    closeOnCleanup(() => provider.close());
    await provider.loadWorld(WORLD_ID);
    const world = provider.openStore?.();
    assert.ok(world);
    const sessionId = newId("sess") as SessionId;
    const takeId = newId("tk");
    const productionTakeId = newId("tk");
    const artifactId = newId("ar");
    const opened = await openSubjectBenchSession(worldDir, sessionId, CLOCK(), {
      subject: {
        kind: "shot",
        productionId: "saltlight",
        productionTitle: "Saltlight",
        sceneId: "sc_04",
        sceneNumber: 4,
        sceneTitle: "The verse rises",
        shotId: "sh_12",
        shotNumber: 12,
        shotTitle: "Maren at the rail",
        durationSec: 4,
        aspect: "16:9",
      },
      title: "Saltlight - Scene 4 - Shot 12",
      references: [],
      composer: {
        mode: "image",
        provider: "fal",
        model: "test-image",
        params: { kind: "image", count: 1, aspect: "16:9" },
        brief: "Maren at the rail.",
        activeTokens: [],
        keyframeTokens: [],
      },
    });
    await opened.store.append({
      type: "takes-reserved",
      takes: [
        {
          id: takeId,
          n: 1,
          requestId: "subject-dispatch",
          request: {
            mode: "image",
            brief: "Maren at the rail.",
            references: [],
            keyframes: [],
            provider: "fal",
            model: "test-image",
            params: { kind: "image", count: 1, aspect: "16:9" },
            productionProvenance: {
              canonRevision: world.getBundle().meta.canonRevision,
              sheets: {},
            },
            filing: {
              kind: "shot",
              productionId: "saltlight",
              sceneId: "sc_04",
              shotId: "sh_12",
              productionTakeId,
              frameArtifactId: artifactId,
            },
          },
          createdAt: CLOCK(),
        },
      ],
    });
    await opened.store.append({
      type: "take-completed",
      takeId,
      media: { file: "take.png", hash: "sha256:deadbeefdeadbeef" },
      completedAt: CLOCK(),
    });
    await mkdir(join(worldDir, sessionMediaDir(sessionId, takeId)), { recursive: true });
    await writeFile(join(worldDir, sessionMediaDir(sessionId, takeId), "take.png"), "still bytes");

    const events: DomainEvent[] = [];
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      observeEvent: (event) => events.push(event),
    });
    const send = (message: ClientMessage) =>
      (
        coordinator as unknown as {
          handleClientMessage(message: ClientMessage): Promise<void>;
        }
      ).handleClientMessage(message);
    const artifactCount = world.getBundle().artifacts.length;
    await send({
      kind: "bench-keep",
      worldId: WORLD_ID,
      sessionId,
      requestId: ulid(),
      takeId,
    });
    assert.equal((await opened.store.fold())?.takes[0]?.disposition, "open");
    assert.equal(
      world.getBundle().artifacts.length,
      artifactCount,
      "Keep cannot bypass subject Accept filing",
    );
    const discard = send({
      kind: "bench-discard",
      worldId: WORLD_ID,
      sessionId,
      requestId: ulid(),
      takeId,
    });
    const acceptRequest = ulid();
    const accept = send({
      kind: "bench-accept",
      worldId: WORLD_ID,
      sessionId,
      requestId: acceptRequest,
      takeId,
    });
    await Promise.all([discard, accept]);

    const session = await opened.store.fold();
    assert.equal(session?.takes[0]?.disposition, "discarded");
    assert.equal(
      world
        .getBundle()
        .productions.find((production) => production.meta.id === "saltlight")
        ?.takes.some((take) => take.id === productionTakeId),
      false,
      "Discard files nothing even when Accept overlaps it",
    );
    const answer = events.find(
      (event): event is Extract<DomainEvent, { type: "bench.subject-accepted" }> =>
        event.type === "bench.subject-accepted" && event.requestId === acceptRequest,
    );
    assert.equal(answer?.accepted, false);
  });
});

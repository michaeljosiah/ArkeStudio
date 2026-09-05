import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { newId, type ComfyUiStatus, type SessionId } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { openBenchSession } from "../../src/bench/service.js";
import { BenchStore, sessionDir } from "../../src/bench/store.js";
import { ComfyUiEngineService, type EngineServiceDeps } from "../../src/comfyui/engine.js";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const CLOCK = () => "2026-08-25T12:00:00.000Z";

function engineService(root: string): ComfyUiEngineService {
  const deps: EngineServiceDeps = {
    appRoot: root,
    recipes: [],
    fetch: async () => {
      throw new Error("offline");
    },
    fileExists: async () => false,
    listDirectories: async () => [],
    hashFile: async () => null,
    writeTextFile: async () => {},
    readNodeRef: async () => null,
    createSupervisor: () => {
      throw new Error("no engine should be spawned");
    },
    registerSupervisorExitBackstop: () => () => {},
    createProcessEpoch: () => "process-test",
    homeDir: "C:/Users/test",
    clock: CLOCK,
  };
  return new ComfyUiEngineService(deps);
}

describe("Bench dispatch racing coordinator shutdown", () => {
  it("never binds a reservation to a job id that did not reach the queue journal", async () => {
    const { root, worldDir } = await makeTempRoot();
    const sessionId = newId("sess") as SessionId;
    const opened = await openBenchSession(worldDir, CLOCK, {
      sessionId,
      defaultModel: { provider: "comfyui", model: "comfyui-draft-image" },
      initial: { mode: "image", brief: "A tide-clock under rain." },
    });
    assert.ok(opened);

    const provider = new FsWorldProvider(root, { clock: CLOCK });
    await provider.loadWorld(WORLD_ID);
    const service = engineService(root);
    let pauseAdmission = false;
    let admissionEntered!: () => void;
    const inAdmission = new Promise<void>((resolve) => {
      admissionEntered = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionPaused = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    service.status = async (): Promise<ComfyUiStatus> => {
      if (pauseAdmission) {
        admissionEntered();
        await admissionPaused;
      }
      return {
        engine: {
          source: "absent",
          state: "absent",
          locality: "local",
          location: null,
          version: null,
          instanceId: null,
          detail: null,
          detected: [],
        },
        recipes: [
          {
            recipeId: "comfyui-draft-image",
            recipeVersion: 1,
            displayName: "Local Draft Image",
            capability: "image",
            state: "ready",
          },
        ],
        checkedAt: CLOCK(),
      };
    };
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      appRoot: root,
      manifest: SHIPPED_MANIFEST,
      dispatchClients: { comfyui: new FakeProvider() },
      comfyui: { service },
    });
    const { port, token } = await coordinator.start(0);
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(socket, "open");
    socket.send(JSON.stringify({ kind: "hello", token, lastSeq: 0 }));
    await once(socket, "message");

    try {
      pauseAdmission = true;
      socket.send(
        JSON.stringify({
          kind: "bench-dispatch",
          worldId: WORLD_ID,
          sessionId,
          requestId: "01J8E10000000000000000SD01",
          composer: {
            mode: "image",
            provider: "comfyui",
            model: "comfyui-draft-image",
            params: { kind: "image", count: 1 },
            brief: "The exact priced tide-clock draft.",
          },
        }),
      );
      await inAdmission;

      const stopping = coordinator.stop();
      releaseAdmission();
      await stopping;

      const session = await new BenchStore(sessionDir(worldDir, sessionId)).fold();
      const journal = await readFile(join(root, "queue", "jobs.jsonl"), "utf8").catch(() => "");
      const journalled = new Set(
        journal
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { id: string }).id),
      );
      assert.equal(session?.takes.length, 1);
      assert.equal(session?.takes[0]?.request.brief, "The exact priced tide-clock draft.");
      assert.equal(session?.takes[0]?.status, "failed");
      assert.equal(session?.takes[0]?.jobId, undefined);
      assert.equal(
        session?.takes.every((take) => take.jobId === undefined || journalled.has(take.jobId)),
        true,
        "every reserved take with a job id has a durable queue row",
      );
      assert.equal(journal.trim(), "");
    } finally {
      releaseAdmission();
      socket.close();
      await coordinator.stop();
      await provider.close();
    }
  });
});

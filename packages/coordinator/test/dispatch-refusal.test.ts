import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { FrameSchema, type Frame } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../src/coordinator.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "./world/helpers.js";

/**
 * A dispatch the coordinator cannot honour has to come back as a refusal.
 *
 * composeDispatches refuses work by throwing — a shot longer than the model can make, a pass over
 * its reference limit — and the plan is recomputed here precisely because the dialog cannot be
 * trusted to have blocked first. Thrown out of the message handler those refusals became an
 * unhandled rejection: nothing answered the request, the dialog waited for a job that never came,
 * and Node is entitled to end the process on one.
 */

class TestClient {
  private socket: WebSocket;
  readonly frames: Frame[] = [];
  private waiters: Array<() => void> = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket.on("message", (data) => {
      this.frames.push(FrameSchema.parse(JSON.parse(String(data))));
      for (const w of this.waiters.splice(0)) w();
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
  }

  send(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** Resolves on the first frame matching, or throws — a hang is the failure under test. */
  async until(match: (frame: Frame) => boolean, label: string): Promise<Frame> {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const hit = this.frames.find(match);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 100);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}

describe("a dispatch the coordinator refuses (adversarial pass on #150)", () => {
  it("answers with a refusal instead of throwing out of the handler", async () => {
    const { root, worldDir } = await makeTempRoot();
    // A shot longer than any route can make. Nothing in the fixture is this long, and nothing
    // needs to be: the point is a frame arriving for work the dialog would have blocked.
    const scenePath = join(worldDir, "productions", "saltlight", "scenes", "04-the-verse-rises.json");
    const scene = JSON.parse(await readFile(scenePath, "utf8")) as { shots: Array<{ durationSec?: number }> };
    scene.shots[0]!.durationSec = 22;
    await writeFile(scenePath, `${JSON.stringify(scene, null, 2)}\n`, "utf8");

    const provider = new FsWorldProvider(root, { clock: () => "2026-08-06T12:00:00.000Z" });
    await provider.loadWorld(WORLD_ID);
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      manifest: SHIPPED_MANIFEST,
    });
    const { port } = await coordinator.start(0);
    const client = new TestClient(port);
    await client.open();
    try {
      // The protocol opens with a hello; nothing is served before one.
      client.send({ kind: "hello", lastSeq: 0 });
      await client.until((f) => f.kind === "snapshot", "the opening snapshot");

      // Veo 3.1 makes 4s, 6s or 8s and nothing longer. Per shot, a 22s shot is refused at
      // composition — the case the dialog blocks, arriving anyway from a stale one.
      const requestId = "01J8E10000000000000000RF12";
      client.send({
        kind: "dispatch-scene",
        requestId,
        worldId: WORLD_ID,
        productionId: "saltlight",
        sceneFile: "04-the-verse-rises",
        mode: "per-shot",
        modelId: "veo-3.1",
      });

      const frame = await client.until(
        (f) => f.kind === "event" && f.event.type === "queue.enqueue-result" && f.event.requestId === requestId,
        "the refusal",
      );
      assert.equal(frame.kind, "event");
      if (frame.kind !== "event" || frame.event.type !== "queue.enqueue-result") return;
      assert.equal(frame.event.disposition, "rejected", "answered, not dropped");
      assert.deepEqual(frame.event.acceptedJobIds, [], "nothing was queued");
      assert.match(
        frame.event.failures[0]!.reason,
        /longer than the 8s Veo 3\.1 can make/,
        "and the reason names the shot and the length that would fit",
      );

      // Still serving: a refused frame is a refused frame, not the end of the session.
      const before = client.frames.length;
      client.send({ kind: "hello", lastSeq: 0 });
      await client.until((f) => client.frames.length > before && f.kind === "snapshot", "a snapshot after the refusal");
    } finally {
      // A failed assertion must not leave the server listening: an open handle hangs the runner
      // long after the reason has scrolled past.
      client.close();
      await coordinator.stop();
      // And the store with it: an open WorldStore keeps the runner alive long after the test.
      await provider.close();
    }
  });
});

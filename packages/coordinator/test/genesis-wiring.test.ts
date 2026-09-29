import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import WebSocket from "ws";
import { agentForPurpose, FrameSchema, type Frame, type HarnessAdapter } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../src/coordinator.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { makeTempRoot } from "./world/helpers.js";

/**
 * The world door's conversation runs only when both halves are there: a harness adapter to talk
 * through and the authoring roster to talk as. A mutation sample found the wiring untested — with
 * `adapter && authoring` turned into `||`, a coordinator with one half built a Genesis service
 * around a missing adapter, and every test passed. Each half alone must refuse plainly.
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
    await new Promise<void>((resolve, reject) => { this.socket.once("open", resolve); this.socket.once("error", reject); });
  }
  send(msg: unknown): void { this.socket.send(JSON.stringify(msg)); }
  async until(match: (frame: Frame) => boolean, label: string): Promise<Frame> {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const hit = this.frames.find(match);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 100); });
    }
  }
  close(): void { this.socket.close(); }
}

/** An adapter that would answer if asked: the point is that with no roster it must not be asked. */
function idleAdapter(): HarnessAdapter {
  return {
    id: "idle",
    capabilities: () => new Set(),
    readiness: () => ({ ready: true }),
    prepareSession() {},
    async createSession() { throw new Error("the adapter was asked to open a session"); },
    async sendMessage() { throw new Error("the adapter was asked to speak"); },
    async dispatchAsync() { throw new Error("the adapter was asked to dispatch"); },
    async interrupt() {},
    streamEvents() { return { [Symbol.asyncIterator]: async function* () {} }; },
  } as unknown as HarnessAdapter;
}

async function genesisStatus(options: { adapter: HarnessAdapter | null; authoring: boolean }): Promise<string> {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  const coordinator = new Coordinator({
    provider, adapter: options.adapter, ...(options.authoring ? { authoring: { agentForPurpose } } : {}),
    changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test", manifest: SHIPPED_MANIFEST,
  });
  const { port, token } = await coordinator.start(0);
  const client = new TestClient(port);
  await client.open();
  try {
    client.send({ kind: "hello", token, lastSeq: 0 });
    await client.until((frame) => frame.kind === "snapshot", "snapshot");
    client.send({ kind: "genesis-chat", genesisId: "gen-wiring", text: "A harbour town that forgot its bell." });
    const status = await client.until((frame) => frame.kind === "event" && frame.event.type === "genesis.status", "genesis status");
    assert.ok(status.kind === "event" && status.event.type === "genesis.status");
    return `${status.event.status}: ${status.event.detail ?? ""}`;
  } finally {
    client.close();
    await coordinator.stop();
    await provider.close();
  }
}

it("refuses the door's conversation plainly when either half of authoring is missing", async () => {
  assert.equal(await genesisStatus({ adapter: idleAdapter(), authoring: false }), "failed: authoring is not configured", "an adapter with no roster");
  assert.equal(await genesisStatus({ adapter: null, authoring: true }), "failed: authoring is not configured", "a roster with no adapter");
});

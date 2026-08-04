import assert from "node:assert/strict";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { FrameSchema, type ClientState, type Frame } from "@arke-studio/contracts";
import { Transport } from "../src/transport.js";

const STATE: ClientState = {
  app: {
    version: "0.0.0-test",
    health: {
      coordinator: { status: "healthy" },
      harness: { status: "unavailable", reason: "not configured" },
      voice: { status: "unavailable", reason: "not configured" },
    },
    jobs: [],
    ledger: [],
    providers: [],
    manifest: null,
    routing: { defaults: {}, faults: [] },
    spend: null,
    backgroundNotifications: "issues-only",
    runtime: null,
    voiceRuntime: null,
    drift: [],
    agents: [],
    harnessModels: [],
    queues: [],
    setup: null,
    env: null,
  },
  worlds: [],
  world: null,
};

const EVENT = {
  at: "2026-08-01T10:00:00Z",
  type: "health.changed",
  component: "voice",
  status: "starting",
} as const;

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

  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  async nextFrame(count = 1): Promise<void> {
    while (this.frames.length < count) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for a frame")), 5_000);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async closed(): Promise<number> {
    return new Promise((resolve) => this.socket.once("close", (code) => resolve(code)));
  }

  close(): void {
    this.socket.close();
  }
}

describe("Transport", () => {
  it("sends one snapshot then monotonically sequenced events (R-3)", async () => {
    const transport = new Transport({ getSnapshot: () => STATE });
    const port = await transport.start(0);
    try {
      const client = new TestClient(port);
      await client.open();
      client.send({ kind: "hello" });
      await client.nextFrame(1);

      transport.broadcast(EVENT);
      transport.broadcast({ ...EVENT, status: "healthy" });
      await client.nextFrame(3);

      assert.equal(client.frames[0]!.kind, "snapshot");
      assert.deepEqual(
        client.frames.map((f) => f.seq),
        [1, 2, 3],
      );
      assert.equal(client.frames[1]!.kind, "event");
      client.close();
    } finally {
      await transport.stop();
    }
  });

  it("answers a reconnect carrying lastSeq with a fresh snapshot, never a partial replay (D4)", async () => {
    const transport = new Transport({ getSnapshot: () => STATE });
    const port = await transport.start(0);
    try {
      const first = new TestClient(port);
      await first.open();
      first.send({ kind: "hello" });
      await first.nextFrame(1);
      transport.broadcast(EVENT);
      await first.nextFrame(2);
      first.close();

      const second = new TestClient(port);
      await second.open();
      second.send({ kind: "hello", lastSeq: 2 });
      await second.nextFrame(1);
      assert.equal(second.frames[0]!.kind, "snapshot");
      assert.equal(second.frames[0]!.seq, 1, "sequence is per connection");
      second.close();
    } finally {
      await transport.stop();
    }
  });

  it("routes non-hello messages to the coordinator only after hello", async () => {
    const seen: unknown[] = [];
    const transport = new Transport({ getSnapshot: () => STATE, onMessage: (m) => seen.push(m) });
    const port = await transport.start(0);
    try {
      const client = new TestClient(port);
      await client.open();
      client.send({ kind: "hello" });
      await client.nextFrame(1);
      client.send({ kind: "open-world", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC" });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(seen.length, 1);

      const rude = new TestClient(port);
      await rude.open();
      rude.send({ kind: "open-world", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC" });
      assert.equal(await rude.closed(), 1002);
      client.close();
    } finally {
      await transport.stop();
    }
  });

  it("closes a connection that sends a malformed message rather than guessing", async () => {
    const transport = new Transport({ getSnapshot: () => STATE });
    const port = await transport.start(0);
    try {
      const client = new TestClient(port);
      await client.open();
      client.sendRaw("not json at all");
      assert.equal(await client.closed(), 1002);
    } finally {
      await transport.stop();
    }
  });
});

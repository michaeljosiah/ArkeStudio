import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import WebSocket from "ws";
import { FrameSchema, type Frame } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../src/coordinator.js";
import { devCipher } from "../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { makeTempRoot } from "./world/helpers.js";

/**
 * Updates never cross the host boundary (R-13, D7): the coordinator holds no Electron, so a
 * person's "Install and restart" is a command it hands to the desktop's injected service. The
 * negative half — no Electron import — is a text check in first-run.test.ts; this is the positive
 * half, driven through the socket: each update command reaches the service it names, once.
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

/** A hang is the failure under test, so the wait has a deadline and a name. */
async function eventually(label: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it("hands each update command to the desktop's injected service, and nothing else installs", async () => {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  const calls: string[] = [];
  const updates = {
    check: async () => { calls.push("check"); },
    download: async () => { calls.push("download"); },
    installAndRestart: async () => { calls.push("installAndRestart"); },
    installOnClose: async () => { calls.push("installOnClose"); },
    acknowledge: () => { calls.push("acknowledge"); },
  };
  const coordinator = new Coordinator({
    provider, adapter: null, appRoot: root, cipher: devCipher(), manifest: SHIPPED_MANIFEST,
    changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test", updates,
  });
  const { port, token } = await coordinator.start(0);
  const client = new TestClient(port);
  await client.open();
  try {
    client.send({ kind: "hello", token, lastSeq: 0 });
    await client.until((frame) => frame.kind === "snapshot", "snapshot");
    client.send({ kind: "install-update-and-restart" });
    await eventually("install and restart", () => calls.includes("installAndRestart"));
    client.send({ kind: "install-update-on-close" });
    await eventually("install on close", () => calls.includes("installOnClose"));
    client.send({ kind: "acknowledge-update" });
    await eventually("acknowledge", () => calls.includes("acknowledge"));
    assert.deepEqual(calls, ["installAndRestart", "installOnClose", "acknowledge"], "each command reaches its own method, once, in order");
  } finally {
    client.close();
    await coordinator.stop();
    await provider.close();
  }
});

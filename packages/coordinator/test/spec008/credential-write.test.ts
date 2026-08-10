import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { FrameSchema, type Frame } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";

/**
 * What happens to a key the user just pasted (SPEC-008 R-5, R-6; issue #227).
 *
 * The dev coordinator was built without a cipher, so it built no credential store, so
 * `set-credential` returned early — no error, no event, no log line. Settings accepted the key,
 * every generation surface went on saying "no provider with a key", and nothing connected the
 * two: the failure was indistinguishable from a rejected key, a typo, or a broken provider.
 * These tests are about the write being answered, either way.
 */

const KEY = "sk-not-a-real-key-000000000000";

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

  async until(match: (frame: Frame) => boolean, label: string): Promise<Frame> {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const hit = this.frames.find(match);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
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

/** The provider row as the last provider.status frame described it. */
function statusFor(frames: Frame[], id: string) {
  const last = [...frames].reverse().find((f) => f.kind === "event" && f.event.type === "provider.status");
  if (last?.kind !== "event" || last.event.type !== "provider.status") return undefined;
  return last.event.providers.find((p) => p.id === id);
}

describe("a credential write is always answered (R-6, issue #227)", () => {
  it("a build with no credential storage says so, instead of dropping the key", async () => {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: () => "2026-08-09T12:00:00.000Z" });
    // No cipher — exactly the dev coordinator's old shape.
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      appRoot: root,
    });
    const { port } = await coordinator.start(0);
    const client = new TestClient(port);
    await client.open();
    try {
      client.send({ kind: "hello", lastSeq: 0 });
      await client.until((f) => f.kind === "snapshot", "the opening snapshot");
      client.send({ kind: "set-credential", provider: "openai", key: KEY });
      await client.until(
        (f) => f.kind === "event" && f.event.type === "provider.status" && statusFor([f], "openai")?.fault !== null,
        "a provider status carrying the fault",
      );
      const status = statusFor(client.frames, "openai");
      assert.match(status!.fault!, /credential storage/, "the reason is the store, not the key");
      assert.equal(status!.configured, false, "and it does not claim to hold a key it discarded");
      // The plaintext never reaches a frame on this path (R-6, R-8).
      assert.equal(JSON.stringify(client.frames).includes(KEY), false, "no frame carries the key back");
    } finally {
      client.close();
      await coordinator.stop();
      await provider.close();
    }
    // Read after the stop, which is what drains the operational log.
    const log = await readFile(join(root, "logs", "app.jsonl"), "utf8").catch(() => "");
    assert.match(log, /provider\.fault/, "it is recorded too — diagnosing this used to need the source");
    assert.equal(log.includes(KEY), false, "and the line about it does not quote the key");
  });

  it("a build with storage stores it and reports configured, with no fault", async () => {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: () => "2026-08-09T12:00:00.000Z" });
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      appRoot: root,
      cipher: devCipher(),
      credentialsFileName: "credentials.dev.dat",
    });
    const { port } = await coordinator.start(0);
    const client = new TestClient(port);
    await client.open();
    try {
      client.send({ kind: "hello", lastSeq: 0 });
      await client.until((f) => f.kind === "snapshot", "the opening snapshot");
      client.send({ kind: "set-credential", provider: "openai", key: KEY });
      await client.until(
        (f) => f.kind === "event" && f.event.type === "provider.status" && statusFor([f], "openai")?.configured === true,
        "a provider status reporting the key stored",
      );
      assert.equal(statusFor(client.frames, "openai")!.fault, null, "nothing failed, so nothing is reported");
      // The dev store writes to its own file, so pointing ARKE_STUDIO_ROOT at a real app root
      // can never leave the desktop's credentials.dat encrypted with a key that died at exit.
      const stored = await readFile(join(root, "credentials.dev.dat"), "utf8");
      assert.equal(stored.includes(KEY), false, "what rests is the cipher's output");
      await assert.rejects(() => readFile(join(root, "credentials.dat"), "utf8"), "the desktop's file is untouched");
    } finally {
      client.close();
      await coordinator.stop();
      await provider.close();
    }
  });
});

describe("the dev cipher (issue #227)", () => {
  it("round-trips, and rests as something other than the key", () => {
    const cipher = devCipher();
    assert.equal(cipher.isAvailable(), true);
    const sealed = cipher.encryptString(KEY);
    assert.equal(sealed.toString("utf8").includes(KEY), false);
    assert.equal(sealed.toString("base64").includes(Buffer.from(KEY).toString("base64")), false);
    assert.equal(cipher.decryptString(sealed), KEY);
  });

  it("cannot read another run's ciphertext, which is why dev clears the file on start", () => {
    // The key is per-process and written nowhere; last run's bytes are unreadable by design.
    // Left in place they would have Settings showing a stored key that no dispatch could use.
    const sealed = devCipher().encryptString(KEY);
    assert.throws(() => devCipher().decryptString(sealed));
  });

  it("refuses a truncated buffer rather than reading past the end of it", () => {
    const sealed = devCipher().encryptString(KEY);
    assert.throws(() => devCipher().decryptString(sealed.subarray(0, 20)), /too short/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { FrameSchema, SIGNED_OUT, type AccountState, type Frame } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { NO_CLOUD_YET, NoArkeCloud, type AccountService } from "../src/account.js";
import { Coordinator } from "../src/coordinator.js";
import { devCipher } from "../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { makeTempRoot } from "./world/helpers.js";

/**
 * The Arke account (design turn 151) is the coordinator's state, the way vendor sign-in is:
 * the client sends frames, the service moves, every client sees `account.changed`. There is
 * no cloud yet, so the shipped service is `NoArkeCloud` — signed out, and both doors answer
 * with the one clause — and the seam is `CoordinatorOptions.account`, driven here through the
 * socket with a service of the test's own so the wiring is what is proved, not the placeholder.
 */

describe("NoArkeCloud, the local default", () => {
  it("is signed out, refuses either door with one clause, and cancel clears the refusal", async () => {
    const service = new NoArkeCloud();
    const seen: AccountState[] = [];
    service.onChange((state) => seen.push(state));
    assert.deepEqual(service.current(), SIGNED_OUT);
    await service.signIn();
    assert.deepEqual(service.current(), { kind: "signed-out", refusal: NO_CLOUD_YET });
    await service.signIn();
    assert.equal(seen.length, 1, "a second press on a refused door does not say it again");
    await service.cancelSignIn();
    assert.deepEqual(service.current(), SIGNED_OUT);
    await service.createAccount();
    assert.deepEqual(service.current(), { kind: "signed-out", refusal: NO_CLOUD_YET });
    await service.signOut();
    assert.deepEqual(service.current(), SIGNED_OUT);
    await service.open("plan");
    assert.deepEqual(service.current(), SIGNED_OUT, "no cloud, no page: nothing moves");
    assert.equal(seen.length, 4);
  });
});

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

/** A service the test drives: every door records its press and moves to whatever the test says. */
class Recording implements AccountService {
  readonly calls: string[] = [];
  private state: AccountState = SIGNED_OUT;
  readonly listeners = new Set<(state: AccountState) => void>();
  current(): AccountState { return this.state; }
  async signIn(): Promise<void> { this.calls.push("signIn"); this.move({ kind: "signing-in" }); }
  async createAccount(): Promise<void> { this.calls.push("createAccount"); this.move({ kind: "signing-in" }); }
  async cancelSignIn(): Promise<void> { this.calls.push("cancelSignIn"); this.move(SIGNED_OUT); }
  async signOut(): Promise<void> { this.calls.push("signOut"); this.move(SIGNED_OUT); }
  async open(page: "account" | "plan"): Promise<void> { this.calls.push(`open:${page}`); }
  onChange(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  move(next: AccountState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

describe("the frames reach the service and its moves reach every client", () => {
  it("carries the account in the snapshot, hands each frame to its door, and publishes account.changed", async () => {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root);
    const account = new Recording();
    const changeLogPath = join(root, "logs", "changes.jsonl");
    const coordinator = new Coordinator({
      provider, adapter: null, appRoot: root, cipher: devCipher(), manifest: SHIPPED_MANIFEST,
      changeLogPath, appVersion: "test", account,
    });
    const { port, token } = await coordinator.start(0);
    const client = new TestClient(port);
    await client.open();
    try {
      client.send({ kind: "hello", token, lastSeq: 0 });
      const snapshot = await client.until((frame) => frame.kind === "snapshot", "snapshot");
      assert.equal(snapshot.kind, "snapshot");
      assert.deepEqual(snapshot.state.app.account, SIGNED_OUT, "the snapshot carries the service's state");

      client.send({ kind: "account-sign-in" });
      const began = await client.until(
        (frame) => frame.kind === "event" && frame.event.type === "account.changed" && frame.event.account.kind === "signing-in",
        "the handoff began",
      );
      assert.equal(began.kind, "event");

      client.send({ kind: "account-cancel-sign-in" });
      await client.until(
        (frame) => frame.kind === "event" && frame.event.type === "account.changed" && frame.event.account.kind === "signed-out",
        "the handoff was taken back",
      );

      // A sign-in that came back — the cloud's doing, not a frame's — reaches the client the same way.
      const helen: AccountState = {
        kind: "signed-in",
        person: { name: "Helen Marsh", email: "helen@marsh.studio", picture: null },
        plan: { name: "Free", paid: false },
        session: "ok",
      };
      account.move(helen);
      const arrived = await client.until(
        (frame) => frame.kind === "event" && frame.event.type === "account.changed" && frame.event.account.kind === "signed-in",
        "the person arrived",
      );
      assert.equal(arrived.kind, "event");
      assert.ok(arrived.event.type === "account.changed");
      assert.deepEqual(arrived.event.account, helen);

      client.send({ kind: "account-open", page: "plan" });
      client.send({ kind: "account-open", page: "account" });
      client.send({ kind: "account-create" });
      client.send({ kind: "account-sign-out" });
      await client.until(
        (frame) => frame.kind === "event" && frame.event.type === "account.changed" && frame.event.account.kind === "signed-out"
          && client.frames.filter((f) => f.kind === "event" && f.event.type === "account.changed").length >= 5,
        "signed out again",
      );
      assert.deepEqual(
        account.calls,
        ["signIn", "cancelSignIn", "open:plan", "open:account", "createAccount", "signOut"],
        "each frame reaches its own door, once, in order",
      );
      assert.equal(account.listeners.size, 1, "the coordinator listens while it runs");
    } finally {
      client.close();
      await coordinator.stop();
      await provider.close();
    }
    // A host's service can answer a handoff long after stop(); the coordinator has let go by then.
    assert.equal(account.listeners.size, 0, "stop() detaches the subscription with the rest");
    // Who is signed in is UI state with a name and an address in it: the append-only log would
    // keep them past the sign-out, so the event never reaches it (SPEC-025 R-26). Read after
    // stop, which drains the writes; the boot's own events prove the file is the one written.
    assert.ok(existsSync(changeLogPath), "the change log was written");
    const log = readFileSync(changeLogPath, "utf8");
    assert.ok(log.includes('"env.check"'), "and holds the boot's events");
    assert.ok(!log.includes("account.changed") && !log.includes("helen@marsh.studio"), "but no account state");
  });
});

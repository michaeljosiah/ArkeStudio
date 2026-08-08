import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { FrameSchema, type Frame, type Job } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Deleting a finished job, end to end (SPEC-014 R-13). The dispatcher suite proves the journal
 * and the guards; this proves the wire — that the message the Activity screen sends reaches a
 * live queue, that the removal comes back as a pushed event rather than a poll (R-14), and that
 * a client connecting afterwards is never handed the row again.
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

function terminalJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "jb_01J8E0000000000000000000J1",
    idempotencyKey: "01J8E1000000000000000000K1",
    worldId: WORLD_ID,
    productionId: "saltlight",
    target: { kind: "shot", id: "sh_12" },
    capability: "video",
    provider: "fal",
    model: "seedance-2.0",
    params: {},
    estimatedMicroUsd: 130000,
    status: "succeeded",
    providerJobId: "rm_1",
    attempt: 1,
    error: null,
    createdAt: "2026-08-06T11:59:00.000Z",
    updatedAt: "2026-08-06T12:00:00.000Z",
    ...overrides,
  };
}

describe("deleting a job from Activity reaches the queue (SPEC-014 R-13)", () => {
  it("removes the row for this client and the next, and leaves the ledger alone", async () => {
    const { root } = await makeTempRoot();
    const job = terminalJob();
    const running = terminalJob({
      id: "jb_01J8E0000000000000000000J2",
      idempotencyKey: "01J8E1000000000000000000K2",
      status: "running",
    });
    await mkdir(join(root, "queue"), { recursive: true });
    await writeFile(
      join(root, "queue", "jobs.jsonl"),
      `${JSON.stringify(job)}\n${JSON.stringify(running)}\n`,
      "utf8",
    );

    const provider = new FsWorldProvider(root, { clock: () => "2026-08-06T12:00:00.000Z" });
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      appRoot: root,
      // Any dispatch surface at all is enough for the queue to exist; nothing here submits.
      dispatchClients: {},
    });
    const { port } = await coordinator.start(0);
    const client = new TestClient(port);
    await client.open();
    try {
      client.send({ kind: "hello", lastSeq: 0 });
      const opening = await client.until((f) => f.kind === "snapshot", "the opening snapshot");
      assert.equal(opening.kind, "snapshot");
      if (opening.kind !== "snapshot") return;
      assert.ok(
        opening.state.app.jobs.some((j) => j.id === job.id),
        "the finished job is on the screen to begin with",
      );
      // Its ledger entry landed at start-up (SPEC-009 R-16) — the figure the deletion must not move.
      const ledgerBefore = await readFile(join(root, "ledger.jsonl"), "utf8");
      assert.match(ledgerBefore, new RegExp(job.id), "the spend is recorded before we delete");

      client.send({ kind: "delete-job", jobId: job.id });
      const frame = await client.until(
        (f) => f.kind === "event" && f.event.type === "job.deleted" && f.event.jobId === job.id,
        "the deletion event",
      );
      assert.equal(frame.kind, "event", "pushed, not polled for (R-14)");

      // A job still in flight is not history: the same message on it does nothing at all.
      const before = client.frames.length;
      client.send({ kind: "delete-job", jobId: running.id });
      client.send({ kind: "hello", lastSeq: 0 });
      const after = await client.until(
        (f) => f.kind === "snapshot" && client.frames.indexOf(f) >= before,
        "a snapshot after the deletion",
      );
      assert.equal(after.kind, "snapshot");
      if (after.kind !== "snapshot") return;
      assert.ok(!after.state.app.jobs.some((j) => j.id === job.id), "a later client is not handed it again");
      assert.ok(after.state.app.jobs.some((j) => j.id === running.id), "and work in flight is untouched");
      assert.equal(await readFile(join(root, "ledger.jsonl"), "utf8"), ledgerBefore, "what was spent stays spent");
    } finally {
      client.close();
      await coordinator.stop();
      await provider.close();
    }
  });
});

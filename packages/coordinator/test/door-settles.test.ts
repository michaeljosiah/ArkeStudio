import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import WebSocket from "ws";
import { agentForPurpose, FrameSchema, type Frame, type HarnessAdapter } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../src/coordinator.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "./world/helpers.js";

/**
 * Pressing Begin is the yes (2026-08-22).
 *
 * A world begun from a conversation stages one proposal per character and per place and settles
 * each as soon as the sheet-editor has filled it in — nobody is asked to approve a sketch they
 * just described. The settle hung off the drafting promise's `then`, so a drafting agent that
 * *threw* — no model configured, a session that died, a budget spent — took the settle down with
 * it, and the skeleton it never filled arrived in Needs you asking for a decision the author had
 * already made. The sentence they typed is in that file; it stands without the agent's help.
 */

const CLOCK = () => "2026-08-22T12:00:00.000Z";

/**
 * A harness that fails, in one of two places.
 *
 * `createSession` is the guarded one: the drafting service catches it, reports a failed run and
 * returns normally. `prepareSession` is not — it runs inside `writeSessionFiles`, ahead of every
 * try block in the service, so a throw there rejects the whole drafting promise. That is the
 * failure the settle used to be chained behind, and the only one of the two that regresses.
 */
function brokenAdapter(where: "prepare" | "create"): HarnessAdapter {
  return {
    id: "broken",
    capabilities: () => new Set(),
    readiness: () => ({ ready: true }),
    prepareSession() {
      if (where === "prepare") throw new Error("this harness cannot be configured");
    },
    async createSession() {
      throw new Error("no session for you");
    },
    async sendMessage() {
      throw new Error("no session for you");
    },
    async dispatchAsync() {
      throw new Error("no session for you");
    },
    async interrupt() {},
    streamEvents() {
      return { [Symbol.asyncIterator]: async function* () {} };
    },
  } as unknown as HarnessAdapter;
}

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
    // Generous on purpose: this asserts that a settle happens at all, not how fast. Under the
    // full suite the coordinator shares a machine with a dozen other WebSocket tests, and an
    // 8-second deadline failed there while passing alone — a red test that means nothing.
    const deadline = Date.now() + 30_000;
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

  lastSnapshot(): Extract<Frame, { kind: "snapshot" }> {
    const snapshots = this.frames.filter((f) => f.kind === "snapshot");
    const last = snapshots[snapshots.length - 1];
    assert.ok(last?.kind === "snapshot", "a snapshot had arrived");
    return last;
  }

  close(): void {
    this.socket.close();
  }
}

async function drive(where: "prepare" | "create"): Promise<void> {
  {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    await provider.loadWorld(WORLD_ID);
    const coordinator = new Coordinator({
      provider,
      adapter: brokenAdapter(where),
      authoring: { agentForPurpose },
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      manifest: SHIPPED_MANIFEST,
    });
    const { port } = await coordinator.start(0);
    const client = new TestClient(port);
    await client.open();
    try {
      client.send({ kind: "hello", lastSeq: 0 });
      await client.until((f) => f.kind === "snapshot", "the opening snapshot");

      client.send({
        kind: "create-sheet-from-sentence",
        worldId: WORLD_ID,
        sheetType: "character",
        name: "Ifeoma Adaeze",
        sentence: "Eighteen, and already fluent in the arithmetic of other people's days.",
        settle: true,
      });

      // The sheet lands in the world, written from the sentence and nothing else.
      await client.until(
        (f) =>
          f.kind === "snapshot" &&
          f.state.world?.sheets.some((s) => s.name === "Ifeoma Adaeze") === true,
        "the sheet in the world",
      );

      const world = client.lastSnapshot().state.world;
      assert.ok(world, "the world is open");
      assert.equal(
        world.proposals.filter((p) => p.proposal.summary.includes("Ifeoma Adaeze")).length,
        0,
        "no decision is asked for over a sketch the author described themselves",
      );
    } finally {
      client.close();
      await coordinator.stop();
      await provider.close();
    }
  }
}

describe("a sheet the author asked for at the door", () => {
  it("settles when the drafting agent cannot start a session", async () => {
    await drive("create");
  });

  it("settles when the drafting promise rejects outright", async () => {
    // The regression. Chained as `.run(...).then(settle)`, this rejection skipped the settle
    // and the unfilled skeleton went to Needs you — a decision the author made by pressing Begin.
    await drive("prepare");
  });
});

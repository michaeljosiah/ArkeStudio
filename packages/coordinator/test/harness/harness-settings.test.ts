import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { FrameSchema, type Frame, type HarnessAvailability, type HarnessStatus } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * A harness that is not on the machine cannot be turned on.
 *
 * The screen disables the control, but that is a courtesy: the availability it was drawn from can
 * be minutes old, and a user can uninstall Claude Code with Settings still open. Enforced here
 * because the cost of getting it wrong is not a confusing screen — it is replacing working
 * authoring with a lane that cannot start, discovered at the next launch.
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

const CLAUDE_PRESENT: HarnessAvailability = {
  id: "claude",
  label: "Claude Code",
  installed: true,
  version: "2.1.235",
  blocked: null,
  bundled: false,
};

const CLAUDE_ABSENT: HarnessAvailability = {
  id: "claude",
  label: "Claude Code",
  installed: false,
  version: null,
  blocked: "Claude Code was not found on this machine.",
  bundled: false,
};

/** The last harness.status the coordinator sent — what a screen would be showing. */
function lastStatus(frames: Frame[]): HarnessStatus | undefined {
  const hits = frames.filter((f) => f.kind === "event" && f.event.type === "harness.status");
  const last = hits.at(-1);
  return last?.kind === "event" && last.event.type === "harness.status" ? last.event.harness : undefined;
}

/** What is actually on disk — the only thing the next launch reads. */
async function storedEngine(root: string): Promise<string | undefined> {
  const raw = await readFile(join(root, "settings.json"), "utf8").catch(() => null);
  return raw === null ? undefined : (JSON.parse(raw) as { harness?: { engine?: string } }).harness?.engine;
}

async function withCoordinator(
  detected: HarnessAvailability,
  body: (client: TestClient, root: string) => Promise<void>,
  reuseRoot?: string,
): Promise<string> {
  const root = reuseRoot ?? (await makeTempRoot()).root;
  const provider = new FsWorldProvider(root, { clock: () => "2026-08-19T12:00:00.000Z" });
  await provider.loadWorld(WORLD_ID);
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    detectHarnesses: async () => [detected],
  });
  const { port } = await coordinator.start(0);
  const client = new TestClient(port);
  await client.open();
  try {
    client.send({ kind: "hello", lastSeq: 0 });
    await client.until((f) => f.kind === "snapshot", "the opening snapshot");
    await body(client, root);
  } finally {
    client.close();
    await coordinator.stop();
  }
  return root;
}

describe("choosing a harness", () => {
  it("offers the bundled one alongside whatever was detected", async () => {
    await withCoordinator(CLAUDE_PRESENT, async (client) => {
      client.send({ kind: "detect-harnesses" });
      await client.until((f) => f.kind === "event" && f.event.type === "harness.status", "the harness list");
      const status = lastStatus(client.frames);
      assert.deepEqual(
        status?.harnesses.map((h) => h.id),
        ["opencode", "claude"],
        "OpenCode is never detected — it ships in the installer",
      );
      assert.equal(status?.engine, "opencode", "and runs until somebody chooses otherwise");
    });
  });

  it("accepts a harness that is installed, and writes it where launch will read it", async () => {
    const root = await withCoordinator(CLAUDE_PRESENT, async (client, root) => {
      client.send({ kind: "set-harness-engine", engine: "claude" });
      await client.until(
        (f) => f.kind === "event" && f.event.type === "harness.status" && f.event.harness.engine === "claude",
        "the accepted choice",
      );
      assert.equal(await storedEngine(root), "claude", "persisted, or the choice dies with the process");
    });
    assert.ok(root);
  });

  it("refuses one that is not installed, and answers with the truth rather than silence", async () => {
    await withCoordinator(CLAUDE_ABSENT, async (client, root) => {
      client.send({ kind: "set-harness-engine", engine: "claude" });
      await client.until((f) => f.kind === "event" && f.event.type === "harness.status", "the refusal");

      const status = lastStatus(client.frames);
      assert.equal(status?.engine, "opencode", "the refusal holds");
      assert.equal(
        status?.harnesses.find((h) => h.id === "claude")?.blocked,
        CLAUDE_ABSENT.blocked,
        "and the reason travels with it, so the screen corrects itself rather than guesses",
      );
      assert.equal(await storedEngine(root), undefined, "nothing written for a choice that was refused");
    });
  });

  it("falls back to OpenCode when a chosen harness disappears, without erasing the choice", async () => {
    // Uninstalling Claude Code should not silently cost the user their setting: reinstalling ought
    // to restore what they picked, not present them with a decision they already made.
    const root = await withCoordinator(CLAUDE_PRESENT, async (client) => {
      client.send({ kind: "set-harness-engine", engine: "claude" });
      await client.until(
        (f) => f.kind === "event" && f.event.type === "harness.status" && f.event.harness.engine === "claude",
        "the accepted choice",
      );
    });

    await withCoordinator(
      CLAUDE_ABSENT,
      async (client, sameRoot) => {
        client.send({ kind: "detect-harnesses" });
        await client.until((f) => f.kind === "event" && f.event.type === "harness.status", "the fresh list");
        assert.equal(lastStatus(client.frames)?.engine, "opencode", "reported as what is actually running");
        assert.equal(await storedEngine(sameRoot), "claude", "but the choice is still on disk");
      },
      root,
    );
  });
});

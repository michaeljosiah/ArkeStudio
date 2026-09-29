import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { FrameSchema, type Frame, type HarnessAvailability, type HarnessStatus } from "@arke-studio/contracts";
import { Coordinator, type CoordinatorOptions } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { DispatchClient } from "../../src/queue/dispatcher.js";
import { FakeProvider } from "../queue/fake-provider.js";
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

const CHOSEN = String.raw`C:\Users\someone\.local\bin\claude.exe`;

const CLAUDE_PRESENT: HarnessAvailability = {
  id: "claude",
  label: "Claude Code",
  installed: true,
  version: "2.1.235",
  source: "path",
  blocked: null,
  bundled: false,
};

const CLAUDE_ABSENT: HarnessAvailability = {
  id: "claude",
  label: "Claude Code",
  installed: false,
  version: null,
  source: null,
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
  opts: {
    pick?: () => Promise<string | null>;
    pickCodex?: () => Promise<string | null>;
    sawPath?: (p: string | null) => void;
    sawCodexPath?: (p: string | null) => void;
    harnessEngineOverride?: CoordinatorOptions["harnessEngineOverride"];
    harnessLaunchEngine?: CoordinatorOptions["harnessLaunchEngine"];
    harnessInfo?: CoordinatorOptions["harnessInfo"];
    /** What Ollama lists, for the local harness's availability; absent means no Ollama client. */
    ollama?: () => Promise<Array<{ id: string; contextLength?: number; tools: boolean; vision: boolean; assumed?: true }>>;
  } = {},
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
    ...(opts.harnessEngineOverride ? { harnessEngineOverride: opts.harnessEngineOverride } : {}),
    ...(opts.harnessLaunchEngine ? { harnessLaunchEngine: opts.harnessLaunchEngine } : {}),
    ...(opts.harnessInfo ? { harnessInfo: opts.harnessInfo } : {}),
    ...(opts.ollama ? { dispatchClients: { ollama: Object.assign(new FakeProvider(), { listModels: opts.ollama }) as DispatchClient } } : {}),
    detectHarnesses: async (configuredPath, codexPath) => {
      opts.sawPath?.(configuredPath);
      opts.sawCodexPath?.(codexPath);
      return [detected];
    },
    ...(opts.pick ? { chooseClaudeExecutable: opts.pick } : {}),
    ...(opts.pickCodex ? { chooseCodexExecutable: opts.pickCodex } : {}),
  });
  const { port, token } = await coordinator.start(0);
  const client = new TestClient(port);
  await client.open();
  try {
    client.send({ kind: "hello", token, lastSeq: 0 });
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
        ["opencode", "arke", "claude"],
        "OpenCode and the local harness are never detected — they ship in the installer",
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

  it("retains the configured engine when its executable disappears", async () => {
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
        assert.equal(lastStatus(client.frames)?.engine, "claude", "the preference is distinct from the running lane");
        assert.equal(lastStatus(client.frames)?.launchEngine, "claude", "the missing startup engine is still identified without process metadata");
        assert.equal(await storedEngine(sameRoot), "claude", "but the choice is still on disk");
      },
      root,
    );
  });

  for (const launch of [
    { name: "saved engine", expected: "claude", options: {} },
    { name: "environment override", expected: "codex", options: { harnessEngineOverride: "codex" as const } },
    { name: "host launch choice without metadata", expected: "codex", options: { harnessLaunchEngine: "codex" as const } },
    { name: "host metadata", expected: "opencode", options: {
      harnessEngineOverride: "codex" as const,
      harnessLaunchEngine: "codex" as const,
      harnessInfo: { generation: "v2" as const, source: "bundled" as const, version: "2.0.0", beta: false },
    } },
  ]) {
    it(`captures the ${launch.name} before the first status and keeps it when preferences change`, async () => {
      const root = (await makeTempRoot()).root;
      await writeFile(join(root, "settings.json"), JSON.stringify({ harness: { engine: "claude" } }), "utf8");
      await withCoordinator(CLAUDE_ABSENT, async client => {
        // No discovery request first: the initial published status already follows a new preference.
        client.send({ kind: "set-harness-engine", engine: "opencode" });
        await client.until(frame => frame.kind === "event" && frame.event.type === "harness.status", "the changed preference");
        assert.equal(lastStatus(client.frames)?.engine, "opencode");
        assert.equal(lastStatus(client.frames)?.launchEngine, launch.expected);
      }, root, launch.options);
    });
  }


  it("keeps a chosen executable and hands it to discovery", async () => {
    /*
     * The dead end this closes: a GUI app inherits the environment that launched it, so a
     * perfectly good Claude Code under something like `~/.local/bin` can be invisible to it.
     * The screen then says "not here" about a file the user is looking at, with nothing to do.
     */
    const seen: Array<string | null> = [];
    await withCoordinator(
      CLAUDE_PRESENT,
      async (client, root) => {
        client.send({ kind: "choose-claude-executable" });
        await client.until(
          (f) => f.kind === "event" && f.event.type === "harness.status" && f.event.harness.claudePath !== null,
          "the chosen path",
        );
        assert.equal(lastStatus(client.frames)?.claudePath, CHOSEN, "shown, so it can be seen and cleared");
        const raw = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as {
          harness?: { claudePath?: string };
        };
        assert.equal(raw.harness?.claudePath, CHOSEN, "persisted for the next launch");
        assert.ok(seen.includes(CHOSEN), "and handed to discovery, or choosing it changes nothing");
      },
      undefined,
      { pick: async () => CHOSEN, sawPath: (p) => seen.push(p) },
    );
  });

  it("treats a cancelled dialog as no answer, not as a clearing", async () => {
    await withCoordinator(
      CLAUDE_PRESENT,
      async (client, root) => {
        client.send({ kind: "choose-claude-executable" });
        await client.until((f) => f.kind === "event" && f.event.type === "harness.status", "a first answer");
        client.send({ kind: "choose-claude-executable" });
        await new Promise((r) => setTimeout(r, 400));
        const raw = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as {
          harness?: { claudePath?: string };
        };
        assert.equal(raw.harness?.claudePath, CHOSEN, "cancelling must not throw away the earlier choice");
      },
      undefined,
      { pick: (() => { let first = true; return async () => (first ? ((first = false), CHOSEN) : null); })() },
    );
  });

  it("clears the chosen executable on request", async () => {
    await withCoordinator(
      CLAUDE_PRESENT,
      async (client, root) => {
        client.send({ kind: "choose-claude-executable" });
        await client.until(
          (f) => f.kind === "event" && f.event.type === "harness.status" && f.event.harness.claudePath !== null,
          "the chosen path",
        );
        client.send({ kind: "clear-claude-executable" });
        await client.until(
          (f) => f.kind === "event" && f.event.type === "harness.status" && f.event.harness.claudePath === null,
          "the cleared path",
        );
        const raw = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as {
          harness?: { claudePath?: string | null };
        };
        assert.equal(raw.harness?.claudePath, null, "back to whatever PATH offers");
      },
      undefined,
      { pick: async () => CHOSEN },
    );
  });

  it("persists Codex selection and its independent executable path, then clears only that path", async () => {
    const chosen = String.raw`C:\tools\codex.exe`;
    const seen: Array<string | null> = [];
    const codex: HarnessAvailability = { ...CLAUDE_PRESENT, id: "codex", label: "Codex", version: "0.154.0" };
    await withCoordinator(codex, async (client, root) => {
      client.send({ kind: "choose-claude-executable" });
      await client.until(frame => frame.kind === "event" && frame.event.type === "harness.status" && frame.event.harness.claudePath === CHOSEN, "Claude path");
      client.send({ kind: "choose-codex-executable" });
      await client.until(frame => frame.kind === "event" && frame.event.type === "harness.status" && frame.event.harness.codexPath === chosen, "Codex path");
      assert.ok(seen.includes(chosen), "Codex discovery receives the configured Codex path");
      client.send({ kind: "set-harness-engine", engine: "codex" });
      await client.until(frame => frame.kind === "event" && frame.event.type === "harness.status" && frame.event.harness.engine === "codex", "Codex engine");
      assert.equal(await storedEngine(root), "codex");
      client.send({ kind: "clear-codex-executable" });
      await client.until(frame => frame.kind === "event" && frame.event.type === "harness.status" && frame.event.harness.engine === "codex" && frame.event.harness.codexPath === null, "cleared Codex path");
      const saved = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as { harness: { codexPath: string | null; claudePath: string | null } };
      assert.equal(saved.harness.codexPath, null);
      assert.equal(saved.harness.claudePath, CHOSEN, "Codex path controls cannot erase Claude's independent configuration");
    }, undefined, { pick: async () => CHOSEN, pickCodex: async () => chosen, sawCodexPath: path => seen.push(path) });
  });

  it("refuses an incompatible Codex version without replacing the saved engine", async () => {
    const blocked: HarnessAvailability = {
      ...CLAUDE_ABSENT, id: "codex", label: "Codex", version: "0.144.0",
      blocked: "Codex 0.154.0 or later is required.",
    };
    await withCoordinator(blocked, async (client, root) => {
      client.send({ kind: "set-harness-engine", engine: "codex" });
      await client.until(frame => frame.kind === "event" && frame.event.type === "harness.status", "Codex refusal");
      assert.equal(lastStatus(client.frames)?.engine, "opencode");
      assert.equal(lastStatus(client.frames)?.harnesses.find(harness => harness.id === "codex")?.blocked, blocked.blocked);
      assert.equal(await storedEngine(root), undefined);
    });
  });
});

describe("choosing the local harness (issue 1247)", () => {
  const GEMMA = { id: "gemma4:12b", contextLength: 262_144, tools: true, vision: true };

  it("is selectable once Ollama answers with a 256k model that calls tools, and is never an executable to find", async () => {
    await withCoordinator(CLAUDE_PRESENT, async (client, root) => {
      client.send({ kind: "detect-harnesses" });
      await client.until((f) => f.kind === "event" && f.event.type === "harness.status", "the harness list");
      assert.deepEqual(lastStatus(client.frames)?.harnesses.find((h) => h.id === "arke"),
        { id: "arke", label: "Local", installed: true, version: null, source: null, blocked: null, bundled: true });
      client.send({ kind: "set-harness-engine", engine: "arke" });
      await client.until((f) => f.kind === "event" && f.event.type === "harness.status" && f.event.harness.engine === "arke", "the local engine");
      assert.equal(await storedEngine(root), "arke");
    }, undefined, { ollama: async () => [GEMMA] });
  });

  it("is refused, with the reason, when Ollama is missing, silent, or holds nothing it can write with", async () => {
    const cases: Array<[string, (() => Promise<Array<typeof GEMMA>>) | undefined, RegExp]> = [
      ["no Ollama client", undefined, /not set up on this machine/],
      ["Ollama not answering", async () => { throw new Error("down"); }, /not answering/],
      ["only a 128k model", async () => [{ ...GEMMA, contextLength: 131_072 }], /256k context window and calls tools/],
      ["only a model that cannot call tools", async () => [{ ...GEMMA, tools: false }], /256k context window and calls tools/],
    ];
    for (const [label, ollama, reason] of cases) {
      await withCoordinator(CLAUDE_PRESENT, async (client, root) => {
        client.send({ kind: "set-harness-engine", engine: "arke" });
        await client.until((f) => f.kind === "event" && f.event.type === "harness.status", `${label}: the refusal`);
        const arke = lastStatus(client.frames)?.harnesses.find((h) => h.id === "arke");
        assert.equal(arke?.installed, false, label);
        assert.match(arke?.blocked ?? "", reason, label);
        assert.equal(lastStatus(client.frames)?.engine, "opencode", label);
        assert.equal(await storedEngine(root), undefined, `${label}: the saved engine is untouched`);
      }, undefined, ollama ? { ollama } : {});
    }
  });
});

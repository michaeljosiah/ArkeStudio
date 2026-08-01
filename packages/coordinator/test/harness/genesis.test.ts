import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSessionConfig } from "@arke-studio/adapter-opencode";
import type { DomainEvent, HarnessAdapter, HarnessEvent } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { GenesisService } from "../../src/harness/genesis.js";

/** An adapter that behaves like a world-author: writes draft.json into its cwd, then replies. */
function draftingAdapter(): HarnessAdapter & { created: string[] } {
  const subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
  const push = (event: HarnessEvent) => {
    for (const sub of subscribers) {
      sub.queue.push(event);
      sub.wake?.();
      sub.wake = null;
    }
  };
  let sessions = 0;
  const cwdBySession = new Map<string, string>();
  const adapter: HarnessAdapter & { created: string[] } = {
    created: [] as string[],
    id: "mock",
    capabilities: () => new Set([]),
    readiness: () => ({ ready: true }),
    async createSession(input) {
      sessions += 1;
      const sessionId = `gen_s${sessions}`;
      adapter.created.push(sessionId);
      cwdBySession.set(sessionId, input.cwd ?? ".");
      return { sessionId };
    },
    async sendMessage(input) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async dispatchAsync(input) {
      const cwd = cwdBySession.get(input.sessionId)!;
      void (async () => {
        await writeFile(
          join(cwd, "draft.json"),
          JSON.stringify({
            name: "The Undersong",
            logline: "A drowned god still sings beneath the harbour.",
            tone: "quiet dread",
            characters: [{ name: "Maren Kest", line: "Tide-caller, the last one" }],
            threads: ["Who governs what the water leaves behind?"],
            surplus: "ignored by the tolerant schema",
          }),
        );
        push({ type: "message.completed", sessionId: input.sessionId, text: "Named it The Undersong — who hears the song first?" });
      })();
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
      const sub: { queue: HarnessEvent[]; wake: (() => void) | null } = { queue: [], wake: null };
      subscribers.add(sub);
      return {
        [Symbol.asyncIterator]() {
          return (async function* () {
            try {
              while (!signal?.aborted) {
                const next = sub.queue.shift();
                if (next) {
                  yield next;
                  continue;
                }
                await new Promise<void>((resolve) => {
                  signal?.addEventListener("abort", () => resolve(), { once: true });
                  sub.wake = resolve;
                });
              }
            } finally {
              subscribers.delete(sub);
            }
          })();
        },
      };
    },
  };
  return adapter;
}

describe("genesis conversations in the sandbox (prototype 12a)", () => {
  it("runs the world-author in the sandbox, records both turns, and surfaces the draft", async () => {
    const dir = await tempDir("arke-genesis-");
    const events: DomainEvent[] = [];
    const adapter = draftingAdapter();
    const genesis = new GenesisService(adapter, (e) => events.push(e), {
      buildConfig: () => buildSessionConfig({}),
    });

    await genesis.run(dir, "gen-abc", "A coastal city where a drowned god still sings.");

    const turns = events.filter((e) => e.type === "genesis.turn");
    assert.deepEqual(
      turns.map((t) => (t.type === "genesis.turn" ? t.role : "")),
      ["user", "gate"],
    );
    const draft = events.find((e) => e.type === "genesis.draft");
    assert.ok(draft && draft.type === "genesis.draft");
    assert.equal(draft.draft.name, "The Undersong");
    assert.equal(draft.draft.characters[0]!.name, "Maren Kest");
    assert.ok(!("surplus" in draft.draft), "unknown keys are stripped, not fatal");

    const statuses = events.filter((e) => e.type === "genesis.status").map((e) => (e.type === "genesis.status" ? e.status : ""));
    assert.deepEqual(statuses, ["running", "completed"]);

    // The confinement config landed in the sandbox before the session was created.
    const config = JSON.parse(await readFile(join(dir, "opencode.json"), "utf8")) as Record<string, unknown>;
    assert.ok(config["agent"]);

    // A second turn continues the same session; release forgets it.
    await genesis.run(dir, "gen-abc", "Whose job is it to hear the song?");
    assert.equal(adapter.created.length, 1, "the conversation keeps its session");
    genesis.release("gen-abc");
    await genesis.run(dir, "gen-abc", "One more thing.");
    assert.equal(adapter.created.length, 2, "a released conversation starts fresh");
  });
});

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

/**
 * An adapter that behaves like the models actually do: it holds the conversation and never
 * touches draft.json. It answers the narrow follow-up with JSON — fenced, with a sentence in
 * front of it, because that is how the answer really arrives.
 */
function talkingAdapter(json = DRAFT_JSON): HarnessAdapter & { prompts: string[] } {
  const subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
  const push = (event: HarnessEvent) => {
    for (const sub of subscribers) {
      sub.queue.push(event);
      sub.wake?.();
      sub.wake = null;
    }
  };
  const adapter: HarnessAdapter & { prompts: string[] } = {
    prompts: [] as string[],
    id: "talker",
    capabilities: () => new Set([]),
    readiness: () => ({ ready: true }),
    async createSession() {
      return { sessionId: "gen_talk" };
    },
    async sendMessage(input) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async dispatchAsync(input) {
      const text = input.parts.map((p) => p.text).join("");
      adapter.prompts.push(text);
      const asked = adapter.prompts.length > 1;
      void (async () => {
        push({
          type: "message.completed",
          sessionId: input.sessionId,
          text: asked ? `Here it is:\n\n\`\`\`json\n${json}\n\`\`\`` : "The Pallid Beacon — pale stone in black water.",
        });
      })();
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
      const sub: { queue: HarnessEvent[]; wake: (() => void) | null } = { queue: [], wake: null };
      subscribers.add(sub);
      return {
        async *[Symbol.asyncIterator]() {
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
        },
      };
    },
  };
  return adapter;
}

/**
 * An adapter that takes the prompt, says nothing, and answers an interrupt with silence too —
 * exactly what a session that accepted a message without starting a turn does.
 */
function muteAdapter(): HarnessAdapter {
  return {
    id: "mute",
    capabilities: () => new Set([]),
    readiness: () => ({ ready: true }),
    async createSession() {
      return { sessionId: "gen_mute" };
    },
    async sendMessage(input) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async dispatchAsync(input) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async interrupt() {
      /* nothing to interrupt, so nothing is emitted — the silence is the point */
    },
    streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
      return {
        // Hand-rolled rather than a generator: this stream yields nothing, ever, and ends only
        // when the caller gives up on it.
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<HarnessEvent>> {
              if (!signal?.aborted) {
                await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
              }
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  } as HarnessAdapter;
}

const DRAFT_JSON = JSON.stringify({
  name: "The Pallid Beacon",
  logline: "A drowned lighthouse that only appears in fog.",
  tone: "eerie, liminal",
  locations: [{ name: "The Pallid Beacon", line: "Rises from the water only when the fog is thick." }],
  threads: ["Does it warn, lure, or simply exist?"],
});

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

  it("asks for the draft when the agent only talks, and writes it here", async () => {
    // What a real model does most of the time: answer the question, ignore the file. Measured
    // against OpenCode 1.18.10 — nought for four before this path existed.
    const dir = await tempDir("arke-genesis-talker-");
    const events: DomainEvent[] = [];
    const adapter = talkingAdapter();
    const genesis = new GenesisService(adapter, (e) => events.push(e), {
      buildConfig: () => buildSessionConfig({}),
    });

    await genesis.run(dir, "gen-talk", "A lighthouse that only appears in fog.");

    const draft = events.find((e) => e.type === "genesis.draft");
    assert.ok(draft && draft.type === "genesis.draft", "the rail is populated even so");
    assert.equal(draft.draft.name, "The Pallid Beacon");
    // The file is still the record — whoever typed it.
    const onDisk = JSON.parse(await readFile(join(dir, "draft.json"), "utf8")) as { name?: string };
    assert.equal(onDisk.name, "The Pallid Beacon");
    assert.equal(adapter.prompts.length, 2, "one conversation turn, then one narrow ask");
    const statuses = events.filter((e) => e.type === "genesis.status").map((e) => (e.type === "genesis.status" ? e.status : ""));
    assert.deepEqual(statuses, ["running", "completed"]);
  });

  it("the wall clock ends the turn even when the harness never answers", async () => {
    // The case seen in the packaged app: a session that accepted the prompt but started no
    // turn. Interrupting it produces nothing, so a deadline that waits to be told is not a
    // deadline — the screen sat on "shaping the draft…" for as long as anyone watched.
    const dir = await tempDir("arke-genesis-mute-");
    const events: DomainEvent[] = [];
    const genesis = new GenesisService(muteAdapter(), (e) => events.push(e), {
      buildConfig: () => buildSessionConfig({}),
      wallClockMs: 120,
    });

    await genesis.run(dir, "gen-mute", "say something");

    const last = events.findLast((e) => e.type === "genesis.status");
    assert.ok(last && last.type === "genesis.status");
    assert.equal(last.status, "timeout", "it ends itself");
    assert.match(last.detail ?? "", /wall-clock/);
  });

  it("a turn that settles nothing is not an error, and does not flicker the rail", async () => {
    const dir = await tempDir("arke-genesis-empty-");
    const events: DomainEvent[] = [];
    const genesis = new GenesisService(talkingAdapter("{}"), (e) => events.push(e), {
      buildConfig: () => buildSessionConfig({}),
    });

    await genesis.run(dir, "gen-empty", "Tell me about fog.");

    assert.ok(!events.some((e) => e.type === "genesis.draft"), "nothing settled, nothing emitted");
    const statuses = events.filter((e) => e.type === "genesis.status").map((e) => (e.type === "genesis.status" ? e.status : ""));
    assert.deepEqual(statuses, ["running", "completed"], "and it is still a completed turn");
  });
});

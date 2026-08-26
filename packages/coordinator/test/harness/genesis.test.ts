import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainEvent, HarnessAdapter, HarnessEvent } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { attachToSandbox } from "../../src/artifacts/genesis-attachments.js";
import { GenesisService } from "../../src/harness/genesis.js";
import { sessionTokenBudget } from "../../src/harness/token-budget.js";

/** An adapter that behaves like a world-author: writes draft.json into its cwd, then replies. */
function draftingAdapter(): HarnessAdapter & { created: string[] } {
  // Declares what the live OpenCode adapters declare: the confinement has to reach the sandbox
  // through the adapter now, and a stub that offered nothing would let this pass by absence.
  const sessionFiles = () => [{ name: "opencode.json", contents: `${JSON.stringify({ agent: {} }, null, 2)}
` }];
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
    sessionFiles,
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
            look: "salt-bleached watercolour, cold light off the water",
            threads: ["Who governs what the water leaves behind?"],
            surplus: "ignored by the tolerant schema",
          }),
        );
        // One entity, one file — the blueprint shape (SPEC-031 R-1).
        await mkdir(join(cwd, "draft", "characters"), { recursive: true });
        await writeFile(
          join(cwd, "draft", "characters", "maren-kest.json"),
          JSON.stringify({
            name: "Maren Kest",
            line: "Tide-caller, the last one",
            brief: { apparentAge: "around forty", hair: "grey-streaked, salt-stiff" },
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
  it("counts session setup as a running turn so a duplicate start is refused", async () => {
    const dir = await tempDir("arke-genesis-");
    const events: DomainEvent[] = [];
    const adapter = talkingAdapter();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = adapter.createSession.bind(adapter);
    adapter.createSession = async (input) => {
      await wait;
      return create(input);
    };
    const genesis = new GenesisService(adapter, (event) => events.push(event), { sessionInput: (input) => input });

    const first = genesis.run(dir, "gen-setup", "first");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(genesis.isRunning("gen-setup"), true);
    await genesis.run(dir, "gen-setup", "second");
    assert.ok(
      events.some(
        (event) =>
          event.type === "genesis.status" &&
          event.genesisId === "gen-setup" &&
          event.detail === "a turn is already running in this conversation",
      ),
    );
    release();
    await first;
  });

  it("runs the world-author in the sandbox, records both turns, and surfaces the draft", async () => {
    const dir = await tempDir("arke-genesis-");
    const events: DomainEvent[] = [];
    const adapter = draftingAdapter();
    const genesis = new GenesisService(adapter, (e) => events.push(e), {
      sessionInput: (input) => input,
    });

    await genesis.run(dir, "gen-abc", "A coastal city where a drowned god still sings.");

    const turns = events.filter((e) => e.type === "genesis.turn");
    assert.deepEqual(
      turns.map((t) => (t.type === "genesis.turn" ? t.role : "")),
      ["user", "gate"],
    );
    const folded = events.find((e) => e.type === "genesis.blueprint");
    assert.ok(folded && folded.type === "genesis.blueprint");
    assert.equal(folded.blueprint.name, "The Undersong");
    assert.equal(folded.blueprint.look, "salt-bleached watercolour, cold light off the water");
    assert.equal(folded.blueprint.characters[0]!.name, "Maren Kest");
    assert.equal(folded.blueprint.characters[0]!.slug, "maren-kest", "the filename is the identity");
    assert.equal(folded.blueprint.characters[0]!.brief?.apparentAge, "around forty");
    assert.ok(!("surplus" in folded.blueprint), "unknown keys are stripped, not fatal");

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

  it("surfaces the turn in flight, verb by verb — thinking, the tool, then writing", async () => {
    // The first conversation anyone has with the studio must never sit silent for a whole
    // model turn: a quiet stretch is indistinguishable from a hang.
    const dir = await tempDir("arke-genesis-");
    const events: DomainEvent[] = [];
    const subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
    const push = (event: HarnessEvent) => {
      for (const sub of subscribers) {
        sub.queue.push(event);
        sub.wake?.();
        sub.wake = null;
      }
    };
    const adapter: HarnessAdapter = {
      id: "prog",
      capabilities: () => new Set([]),
      readiness: () => ({ ready: true }),
      async createSession() {
        return { sessionId: "gen_prog" };
      },
      async sendMessage(input) {
        return { sessionId: input.sessionId, correlationId: "c" };
      },
      async dispatchAsync(input) {
        void (async () => {
          push({ type: "tool.activity", sessionId: input.sessionId, tool: "webfetch", summary: "fetched a page" });
          push({ type: "message.delta", sessionId: input.sessionId, text: "Named" });
          push({ type: "message.delta", sessionId: input.sessionId, text: "Named it" });
          push({ type: "message.completed", sessionId: input.sessionId, text: "Named it The Undersong." });
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
    const genesis = new GenesisService(adapter, (e) => events.push(e), {
      sessionInput: (input) => input,
    });
    await genesis.run(dir, "gen-prog", "A coastal city.");
    const labels = events.filter((e) => e.type === "genesis.progress").map((e) => (e.type === "genesis.progress" ? e.label : ""));
    assert.equal(labels[0], "Thinking", "the resting label lands before any tool runs");
    assert.ok(labels.includes("Writing"), "a stretch of writing says so once");
    assert.equal(labels.filter((l) => l === "Writing").length, 1, "once per stretch, not per token");
  });

  it("asks for the draft when the agent only talks, and writes it here", async () => {
    // What a real model does most of the time: answer the question, ignore the file. Measured
    // against OpenCode 1.18.10 — nought for four before this path existed.
    const dir = await tempDir("arke-genesis-talker-");
    const events: DomainEvent[] = [];
    const adapter = talkingAdapter();
    const genesis = new GenesisService(adapter, (e) => events.push(e), {
      sessionInput: (input) => input,
    });

    await genesis.run(dir, "gen-talk", "A lighthouse that only appears in fog.");

    const folded = events.find((e) => e.type === "genesis.blueprint");
    assert.ok(folded && folded.type === "genesis.blueprint", "the rail is populated even so");
    assert.equal(folded.blueprint.name, "The Pallid Beacon");
    assert.equal(
      folded.blueprint.locations[0]?.name,
      "The Pallid Beacon",
      "a pre-blueprint draft's entity arrays still fold",
    );
    // The file is still the record — whoever typed it.
    const onDisk = JSON.parse(await readFile(join(dir, "draft.json"), "utf8")) as { name?: string };
    assert.equal(onDisk.name, "The Pallid Beacon");
    assert.equal(adapter.prompts.length, 2, "one conversation turn, then one narrow ask");
    const statuses = events.filter((e) => e.type === "genesis.status").map((e) => (e.type === "genesis.status" ? e.status : ""));
    assert.deepEqual(statuses, ["running", "completed"]);
  });

  it("tells the agent what it has been handed, once, and not again after that", async () => {
    // Handing a file over has to mean something in the conversation. It sits in the agent's
    // own working directory, but a model does not go looking — so it is named in the prompt,
    // once. Named every turn it reads as an instruction to keep re-reading it.
    const dir = await tempDir("arke-genesis-attach-");
    const adapter = talkingAdapter();
    const genesis = new GenesisService(adapter, () => {}, { sessionInput: (input) => input });
    await attachToSandbox(dir, await (async () => {
      const src = join(await tempDir("arke-genesis-src-"), "Series Bible.md");
      await writeFile(src, "# The Undersong\n");
      return src;
    })());

    await genesis.run(dir, "gen-attach", "A lighthouse that only appears in fog.");
    assert.match(adapter.prompts[0]!, /attachments\/series-bible\.md/, "the first turn names it");
    assert.ok(!/attachments/.test(adapter.prompts[1]!), "the narrow draft ask does not repeat it");

    await genesis.run(dir, "gen-attach", "Who keeps the light?");
    assert.ok(!/attachments/.test(adapter.prompts[2]!), "and neither does the next turn");
  });

  it("the wall clock ends the turn even when the harness never answers", async () => {
    // The case seen in the packaged app: a session that accepted the prompt but started no
    // turn. Interrupting it produces nothing, so a deadline that waits to be told is not a
    // deadline — the screen sat on "shaping the draft…" for as long as anyone watched.
    const dir = await tempDir("arke-genesis-mute-");
    const events: DomainEvent[] = [];
    const genesis = new GenesisService(muteAdapter(), (e) => events.push(e), {
      sessionInput: (input) => input,
      wallClockMs: 120,
    });

    await genesis.run(dir, "gen-mute", "say something");

    const last = events.findLast((e) => e.type === "genesis.status");
    assert.ok(last && last.type === "genesis.status");
    assert.equal(last.status, "timeout", "it ends itself");
    assert.match(last.detail ?? "", /wall-clock/);
  });

  it("a corrupt draft.json triggers the rescue instead of blanking the rail", async () => {
    // The failure the rescue exists for, in its new shape: the agent tore draft.json (or
    // wrote a field past its cap), and the fold would otherwise read it as an empty identity
    // beside intact entity files — erasing the name the rail already held.
    const dir = await tempDir("arke-genesis-torn-");
    await writeFile(join(dir, "draft.json"), "{torn");
    await mkdir(join(dir, "draft", "characters"), { recursive: true });
    await writeFile(
      join(dir, "draft", "characters", "maren-kest.json"),
      JSON.stringify({ name: "Maren Kest", line: "Tide-caller" }),
    );
    const events: DomainEvent[] = [];
    const adapter = talkingAdapter();
    const genesis = new GenesisService(adapter, (e) => events.push(e), {
      sessionInput: (input) => input,
    });

    await genesis.run(dir, "gen-torn", "Keep going.");

    assert.equal(adapter.prompts.length, 2, "the narrow ask ran");
    const folded = events.find((e) => e.type === "genesis.blueprint");
    assert.ok(folded && folded.type === "genesis.blueprint");
    assert.equal(folded.blueprint.name, "The Pallid Beacon", "identity recovered, not blanked");
    assert.ok(
      folded.blueprint.characters.some((c) => c.slug === "maren-kest"),
      "the entity files were never at risk",
    );
  });

  it("a withdrawal that empties the plan still reaches the rail (R-2)", async () => {
    // The one blueprint change that says nothing at all: the only settled entity retracted.
    // The emit gate must still fire — the rail holding a character the author took out is
    // exactly what "neither the resumed conversation nor Begin sees it again" forbids.
    const dir = await tempDir("arke-genesis-withdraw-");
    await mkdir(join(dir, "draft", "characters"), { recursive: true });
    const file = join(dir, "draft", "characters", "old-tom.json");
    await writeFile(file, JSON.stringify({ name: "Old Tom", line: "keeps the ledger" }));
    const events: DomainEvent[] = [];
    const base = talkingAdapter("{}");
    const adapter: HarnessAdapter = {
      ...base,
      async dispatchAsync(input) {
        // The whole turn: mark him withdrawn, write nothing else, reply in words.
        await writeFile(file, JSON.stringify({ name: "Old Tom", withdrawn: true }));
        return base.dispatchAsync(input);
      },
    };
    const genesis = new GenesisService(adapter, (e) => events.push(e), {
      sessionInput: (input) => input,
    });
    await genesis.run(dir, "gen-withdraw", "Take Old Tom out.");
    const folded = events.findLast((e) => e.type === "genesis.blueprint");
    assert.ok(folded && folded.type === "genesis.blueprint", "the retraction is a change the rail sees");
    assert.equal(folded.blueprint.characters.length, 0, "and Begin never sees him again");
  });

  it("a turn that settles nothing is not an error, and does not flicker the rail", async () => {
    const dir = await tempDir("arke-genesis-empty-");
    const events: DomainEvent[] = [];
    const genesis = new GenesisService(talkingAdapter("{}"), (e) => events.push(e), {
      sessionInput: (input) => input,
    });

    await genesis.run(dir, "gen-empty", "Tell me about fog.");

    assert.ok(!events.some((e) => e.type === "genesis.blueprint"), "nothing settled, nothing emitted");
    const statuses = events.filter((e) => e.type === "genesis.status").map((e) => (e.type === "genesis.status" ? e.status : ""));
    assert.deepEqual(statuses, ["running", "completed"], "and it is still a completed turn");
  });
});

/**
 * What one creation conversation may spend (§8.5).
 *
 * The guard is against a runaway — an agent looping on its own output — and as a flat 120,000 it
 * rationed honest work instead: an author who attaches a series bible spends most of that having
 * it read, and the turns after were interrupted with "passed the 120,000-token budget".
 */
describe("what one agent conversation may spend", () => {
  /* The two floors in play: world creation's, and sheet authoring's. */
  const CREATION = 120_000;
  const AUTHORING = 200_000;

  it("falls back to each service's own floor when no model window can be named", () => {
    assert.equal(sessionTokenBudget(undefined, CREATION), CREATION);
    assert.equal(sessionTokenBudget(null, AUTHORING), AUTHORING);
    assert.equal(sessionTokenBudget(0, CREATION), CREATION, "a nonsense window is no window");
  });

  it("takes it from the window of the model that answers", () => {
    // The window this machine's harness actually reports.
    assert.equal(sessionTokenBudget(922_000, CREATION), 9_220_000);
    assert.equal(sessionTokenBudget(922_000, AUTHORING), 9_220_000);
  });

  it("never drops below the floor for a very small window", () => {
    assert.equal(sessionTokenBudget(1_000, CREATION), CREATION);
    assert.equal(sessionTokenBudget(1_000, AUTHORING), AUTHORING);
  });
});

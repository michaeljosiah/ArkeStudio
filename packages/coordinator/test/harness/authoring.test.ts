import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MockHarnessAdapter, agentForPurpose, buildSessionConfig } from "@arke-studio/adapter-opencode";
import type { DomainEvent, HarnessAdapter, HarnessEvent } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { AuthoringService } from "../../src/harness/authoring.js";
import { GrantStore } from "../../src/harness/grants.js";
import { settlePermission } from "../../src/harness/authoring.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";
const WORLD_ID = "01J8F3K2QW9VZX4N7M0RTYB6HC";
const MAREN = "characters/maren-kest.md";

async function setup() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  const gate = new ProposalManager(store);
  const proposal = await gate.stage({
    kind: "sheet-edit",
    summary: "studio draft",
    source: "chat:studio",
    targets: [{ path: MAREN }],
  });
  return { dir, store, gate, proposal };
}

function service(adapter: HarnessAdapter, events: DomainEvent[], opts: { wallClockMs?: number; tokenBudget?: number } = {}) {
  return new AuthoringService(adapter, (e) => events.push(e), {
    buildConfig: buildSessionConfig,
    agentForPurpose,
    ...opts,
  });
}

/** An adapter whose turn never completes — for cancellation and timeout paths. */
function neverendingAdapter(): HarnessAdapter & { interrupted: string[] } {
  const subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
  const push = (event: HarnessEvent) => {
    for (const sub of subscribers) {
      sub.queue.push(event);
      sub.wake?.();
      sub.wake = null;
    }
  };
  const adapter: HarnessAdapter & { interrupted: string[]; interrupt(id: string): Promise<void> } = {
    id: "stuck",
    interrupted: [],
    capabilities: () => new Set(),
    readiness: () => ({ ready: true }),
    async createSession() {
      return { sessionId: "ses_stuck" };
    },
    async sendMessage(input) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async dispatchAsync(input) {
      push({ type: "message.delta", sessionId: input.sessionId, text: "thinking…" });
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async interrupt(id: string) {
      adapter.interrupted.push(id);
      push({ type: "session.ended", sessionId: id, reason: "cancelled", detail: "interrupted" });
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

describe("authoring sessions over proposals (R-9, R-12, R-13)", () => {
  it("writes the session config into the proposal, runs, and ends completed with the work kept", async () => {
    const { dir, store, gate, proposal } = await setup();
    const events: DomainEvent[] = [];
    const authoring = service(new MockHarnessAdapter(), events);

    await authoring.run(
      store,
      gate,
      { worldId: WORLD_ID, proposalId: proposal.id, purpose: "authoring", instruction: "revise appearance" },
      "http://127.0.0.1:1/mcp",
    );

    const statuses = events.filter((e) => e.type === "authoring.status").map((e) => (e.type === "authoring.status" ? e.status : ""));
    assert.deepEqual(statuses, ["running", "completed"]);

    // Studio wrote the confinement config into the working directory (R-5, R-9, R-10).
    const config = JSON.parse(
      await readFile(join(dir, ".proposals", proposal.id, "opencode.json"), "utf8"),
    ) as { agent: Record<string, { tools: Record<string, boolean> }>; mcp: Record<string, unknown> };
    assert.equal(config.agent["sheet-editor"]!.tools["bash"], false);
    assert.ok(config.mcp["arke-world"]);

    // The proposal is intact and still staged (R-12).
    assert.ok(store.getBundle().proposals.some((p) => p.proposal.id === proposal.id));
    await store.close();
  });

  it("the conversation persists: a second turn reuses the session and both sides land as turns", async () => {
    const { store, gate, proposal } = await setup();
    const events: DomainEvent[] = [];
    const adapter = new MockHarnessAdapter();
    let created = 0;
    const originalCreate = adapter.createSession.bind(adapter);
    adapter.createSession = async (input) => {
      created += 1;
      return originalCreate(input);
    };
    const authoring = service(adapter, events);

    await authoring.run(
      store,
      gate,
      { worldId: WORLD_ID, proposalId: proposal.id, purpose: "authoring", instruction: "give her a scar" },
      "http://127.0.0.1:1/mcp",
    );
    await authoring.run(
      store,
      gate,
      { worldId: WORLD_ID, proposalId: proposal.id, purpose: "authoring", instruction: "and fray the collar thread" },
      "http://127.0.0.1:1/mcp",
    );

    assert.equal(created, 1, "the second instruction continues the same session — same agent, same context");

    const turns = events.filter((e) => e.type === "authoring.turn");
    assert.deepEqual(
      turns.map((t) => (t.type === "authoring.turn" ? t.role : "")),
      ["user", "gate", "user", "gate"],
      "each turn records the instruction going in and the reply coming back",
    );
    assert.equal(turns[0]!.type === "authoring.turn" ? turns[0]!.text : "", "give her a scar");

    // Settling the proposal ends the conversation; the next run starts fresh.
    authoring.release(proposal.id);
    await authoring.run(
      store,
      gate,
      { worldId: WORLD_ID, proposalId: proposal.id, purpose: "authoring", instruction: "one more" },
      "http://127.0.0.1:1/mcp",
    );
    assert.equal(created, 2, "a released conversation does not haunt the next one");
    await store.close();
  });

  it("cancellation is immediate, stated, and costs nothing (R-13, D8)", async () => {
    const { store, gate, proposal } = await setup();
    const events: DomainEvent[] = [];
    const adapter = neverendingAdapter();
    const authoring = service(adapter, events);

    const run = authoring.run(store, gate, {
      worldId: WORLD_ID,
      proposalId: proposal.id,
      purpose: "authoring",
      instruction: "never finishes",
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(authoring.isRunning(proposal.id), true);
    // The same fact by the name the snapshot asks for it under (issue 239): a client that
    // reloads now has no event to learn this from, so the state it is handed has to carry it.
    assert.deepEqual(authoring.liveRuns(), [proposal.id]);
    await authoring.cancel(proposal.id);
    await run;

    assert.deepEqual(authoring.liveRuns(), [], "and the run is gone from it once it ends");

    assert.deepEqual(adapter.interrupted, ["ses_stuck"]);
    const final = events.findLast((e) => e.type === "authoring.status");
    assert.equal(final?.type === "authoring.status" && final.status, "cancelled");
    assert.ok(store.getBundle().proposals.some((p) => p.proposal.id === proposal.id), "proposal intact");
    await store.close();
  });

  it("the wall clock ends a stuck run with a stated reason (R-13, D7)", async () => {
    const { store, gate, proposal } = await setup();
    const events: DomainEvent[] = [];
    const adapter = neverendingAdapter();
    const authoring = service(adapter, events, { wallClockMs: 300 });

    await authoring.run(store, gate, {
      worldId: WORLD_ID,
      proposalId: proposal.id,
      purpose: "authoring",
      instruction: "never finishes",
    });
    const final = events.findLast((e) => e.type === "authoring.status");
    // The interrupt fires at the deadline; the stuck adapter answers with a cancelled ending,
    // and the recorded reason names the wall clock.
    assert.ok(final?.type === "authoring.status" && ["timeout", "cancelled"].includes(final.status));
    assert.ok(
      events.some(
        (e) => e.type === "authoring.status" && (e.detail?.includes("wall-clock") || e.status === "timeout"),
      ) || adapter.interrupted.length === 1,
      "the deadline interrupted the session",
    );
    await store.close();
  });

  it("a harness that is not ready fails the run with the stated reason, not a throw (R-4)", async () => {
    const { store, gate, proposal } = await setup();
    const events: DomainEvent[] = [];
    const adapter = new MockHarnessAdapter();
    await adapter.dispose(); // readiness now false
    const authoring = service(adapter, events);
    await authoring.run(store, gate, {
      worldId: WORLD_ID,
      proposalId: proposal.id,
      purpose: "authoring",
      instruction: "x",
    });
    const final = events.findLast((e) => e.type === "authoring.status");
    assert.equal(final?.type === "authoring.status" && final.status, "failed");
    assert.ok(store.getBundle().proposals.some((p) => p.proposal.id === proposal.id), "proposal intact");
    await store.close();
  });
});

describe("permission backstop and remembered grants (R-16, R-17)", () => {
  it("remembers an always grant across store instances and answers without prompting", async () => {
    const root = await tempDir("arke-grants-");

    const first = new GrantStore(root);
    assert.equal(await first.covers("bash"), false);
    await first.remember("bash", CLOCK());
    assert.equal(await first.covers("bash"), true);

    const second = new GrantStore(root); // restart
    assert.equal(await second.covers("bash"), true, "grants persist");
    const grants = await second.list();
    await second.revoke(grants[0]!.id);
    assert.equal(await second.covers("bash"), false, "revocation holds");
  });

  it("settles covered requests silently and surfaces the rest in Studio language", async () => {
    const root = await tempDir("arke-grants-");
    const grants = new GrantStore(root);
    await grants.remember("webfetch", CLOCK());
    const adapter = new MockHarnessAdapter();
    const events: DomainEvent[] = [];

    await settlePermission(adapter, grants, (e) => events.push(e), {
      permissionId: "p1",
      actionClass: "webfetch",
    });
    const settled = events[0]!;
    assert.equal(settled.type, "permission.settled");
    assert.equal(settled.type === "permission.settled" && settled.remembered, true);

    await settlePermission(adapter, grants, (e) => events.push(e), {
      permissionId: "p2",
      actionClass: "bash",
    });
    const pending = events.findLast((e) => e.type === "permission.pending");
    assert.equal(pending?.type === "permission.pending" && pending.description, "The agent wants to run a shell command");
  });
});

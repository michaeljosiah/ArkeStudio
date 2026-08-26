import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockHarnessAdapter } from "@arke-studio/adapter-opencode";
import {
  agentForPurpose,
  type DomainEvent,
  type HarnessAdapter,
  type HarnessEvent,
} from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { AuthoringService, settlePendingPermission } from "../../src/harness/authoring.js";
import { GrantStore } from "../../src/harness/grants.js";
import { settlePermission } from "../../src/harness/authoring.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { draftSceneSkeleton } from "../../src/productions/ops.js";
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
    sessionInput: (input) => input,
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

/**
 * An adapter that writes a file each turn — the drafting agent's actual behaviour, which the
 * mock adapter does not have: it edits its target with raw file tools and says it is done.
 * Each dispatch takes the next body in the list, so a turn can be made to write something the
 * gate refuses and the turn after it to write the repair.
 */
function writingAdapter(target: string, bodies: string[], written: string[]): HarnessAdapter {
  const subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
  const push = (event: HarnessEvent) => {
    for (const sub of subscribers) {
      sub.queue.push(event);
      sub.wake?.();
      sub.wake = null;
    }
  };
  return {
    id: "writer",
    capabilities: () => new Set(),
    readiness: () => ({ ready: true }),
    async createSession() {
      return { sessionId: "ses_writer" };
    },
    async sendMessage(input) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async dispatchAsync(input) {
      const body = bodies[written.length] ?? bodies.at(-1)!;
      written.push(body);
      await writeFile(target, body, "utf8");
      push({ type: "message.completed", sessionId: input.sessionId, text: "done" });
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
}

describe("authoring sessions over proposals (R-9, R-12, R-13)", () => {
  it("counts session setup as active so a second start cannot enter the proposal", async () => {
    const { store, gate, proposal } = await setup();
    const events: DomainEvent[] = [];
    const adapter = new MockHarnessAdapter();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = adapter.createSession.bind(adapter);
    adapter.createSession = async (input) => {
      await wait;
      return create(input);
    };
    const authoring = service(adapter, events);
    const first = authoring.run(store, gate, {
      worldId: WORLD_ID,
      proposalId: proposal.id,
      purpose: "authoring",
      instruction: "first",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(authoring.isRunning(proposal.id), true);

    await authoring.run(store, gate, {
      worldId: WORLD_ID,
      proposalId: proposal.id,
      purpose: "authoring",
      instruction: "second",
    });
    assert.ok(
      events.some(
        (event) =>
          event.type === "authoring.status" &&
          event.proposalId === proposal.id &&
          event.detail === "a session is already running on this proposal",
      ),
    );
    release();
    await first;
    await store.close();
  });

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

  it("what the agent wrote is read back, and a record the gate would refuse is sent back to be repaired", async () => {
    // The drafting agent writes its target with raw file tools, so until this check the first
    // thing to read the result was the Accept the person pressed — and by then the session that
    // could have fixed it was gone. Live on 0.5.30 the agent dropped a comma after `inherits`.
    const { dir, store } = await setup();
    const gate = new ProposalManager(store);
    const draft = await draftSceneSkeleton(store, gate, {
      productionId: "saltlight",
      brief: "The chalk circle waits.",
    });
    const target = join(dir, ".proposals", draft.proposalId, ...draft.path.split("/"));
    const written: string[] = [];
    const adapter = writingAdapter(target, [
      // Turn one: the shape the agent actually produced — a scene, but not a readable one.
      '{ "id": "sc_x", "number": 1, "order": 1, "slug": "x", "title": "X" "status": "draft", "version": 1, "shots": [] }',
      // Turn two: the repair.
      JSON.stringify(
        { id: "sc_x", number: 1, order: 1, slug: "x", title: "X", status: "draft", version: 1, shots: [] },
        null,
        2,
      ),
    ], written);
    const events: DomainEvent[] = [];
    const authoring = service(adapter, events);

    await authoring.run(store, gate, {
      worldId: WORLD_ID,
      proposalId: draft.proposalId,
      purpose: "drafting",
      instruction: draft.instruction,
    });

    assert.equal(written.length, 2, "the turn that wrote something unreadable was sent back once");
    const turns = events.filter((e) => e.type === "authoring.turn");
    const theirs = turns.filter((t) => t.type === "authoring.turn" && t.role === "user");
    assert.equal(theirs.length, 1, "only the words the person typed are attributed to them");
    assert.equal(theirs[0]!.type === "authoring.turn" ? theirs[0]!.text : "", draft.instruction);
    const repair = turns.find(
      (t) => t.type === "authoring.turn" && /cannot be accepted as it stands/.test(t.text),
    );
    assert.ok(repair, "the repair is a turn on the record, not a hidden retry");
    assert.equal(
      repair.type === "authoring.turn" ? repair.role : "",
      "gate",
      "and it speaks in the gate's own name (review 2026-08-22), not the person's",
    );
    assert.match(repair.type === "authoring.turn" ? repair.text : "", /not a scene/, "in the gate's own words");
    assert.deepEqual(await gate.recordProblems(draft.proposalId), [], "what stands would now be accepted");
    const statuses = events
      .filter((e) => e.type === "authoring.status")
      .map((e) => (e.type === "authoring.status" ? e.status : ""));
    assert.equal(statuses.at(-1), "completed", "the run is only called done once the file is one");
    await store.close();
  });

  it("a Stop that lands between the run ending and the repair starting is honoured", async () => {
    // The run is cleared from `this.runs` before the gate reads the file back, so a Stop pressed
    // in that window used to find nothing to cancel — and the repair turn started anyway,
    // spending a turn on a proposal the person had just stopped (review 2026-08-22).
    const { dir, store } = await setup();
    const gate = new ProposalManager(store);
    const draft = await draftSceneSkeleton(store, gate, {
      productionId: "saltlight",
      brief: "The chalk circle waits, stopped.",
    });
    const target = join(dir, ".proposals", draft.proposalId, ...draft.path.split("/"));
    const written: string[] = [];
    const adapter = writingAdapter(target, Array(4).fill('{ "id": "sc_x" "broken": true }'), written);
    const events: DomainEvent[] = [];
    const authoring = service(adapter, events);

    // The Stop arrives exactly in the gap: the run has ended, the gate is reading the result.
    const readBack = gate.recordProblems.bind(gate);
    gate.recordProblems = async (id: string) => {
      await authoring.cancel(draft.proposalId);
      return readBack(id);
    };

    await authoring.run(store, gate, {
      worldId: WORLD_ID,
      proposalId: draft.proposalId,
      purpose: "drafting",
      instruction: draft.instruction,
    });

    assert.equal(written.length, 1, "the refused draft was not repaired — the person said stop");
    await store.close();
  });

  it("a fresh instruction supersedes a stale Stop; the repair loop works again", async () => {
    const { dir, store } = await setup();
    const gate = new ProposalManager(store);
    const draft = await draftSceneSkeleton(store, gate, {
      productionId: "saltlight",
      brief: "The chalk circle, resumed.",
    });
    const target = join(dir, ".proposals", draft.proposalId, ...draft.path.split("/"));
    const written: string[] = [];
    const adapter = writingAdapter(target, [
      '{ "id": "sc_x", "number": 1, "order": 1, "slug": "x", "title": "X" "status": "draft", "version": 1, "shots": [] }',
      JSON.stringify(
        { id: "sc_x", number: 1, order: 1, slug: "x", title: "X", status: "draft", version: 1, shots: [] },
        null,
        2,
      ),
    ], written);
    const events: DomainEvent[] = [];
    const authoring = service(adapter, events);

    // A Stop with nothing running marks the proposal; the next instruction must clear it —
    // otherwise one cancelled turn would silently disable repairs for the proposal's whole life.
    await authoring.cancel(draft.proposalId);
    await authoring.run(store, gate, {
      worldId: WORLD_ID,
      proposalId: draft.proposalId,
      purpose: "drafting",
      instruction: draft.instruction,
    });

    assert.equal(written.length, 2, "the unreadable first draft was sent back and repaired");
    assert.deepEqual(await gate.recordProblems(draft.proposalId), [], "what stands would now be accepted");
    await store.close();
  });

  it("an agent that cannot repair its own file is not asked forever; the draft stands and the gate refuses it", async () => {
    const { dir, store } = await setup();
    const gate = new ProposalManager(store);
    const draft = await draftSceneSkeleton(store, gate, {
      productionId: "saltlight",
      brief: "The chalk circle waits again.",
    });
    const target = join(dir, ".proposals", draft.proposalId, ...draft.path.split("/"));
    const written: string[] = [];
    // Every turn writes the same unreadable file: the agent is not going to be talked into it.
    const adapter = writingAdapter(target, Array(6).fill('{ "id": "sc_x" "broken": true }'), written);
    const events: DomainEvent[] = [];
    const authoring = service(adapter, events);

    await authoring.run(store, gate, {
      worldId: WORLD_ID,
      proposalId: draft.proposalId,
      purpose: "drafting",
      instruction: draft.instruction,
    });

    assert.equal(written.length, 3, "the first turn plus two repairs, then it stops asking");
    const outcome = await gate.accept(draft.proposalId);
    assert.equal(outcome.status, "invalid", "and the gate still refuses it rather than writing it");
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

  it("settles an allowed covered request silently and surfaces an allowed uncovered one", async () => {
    const root = await tempDir("arke-grants-");
    const grants = new GrantStore(root);
    await grants.remember("webfetch", CLOCK());
    const adapter = new MockHarnessAdapter();
    adapter.prepareSession?.({ preparationId: "prep_allowed", researchWeb: true });
    const session = await adapter.createSession({
      purpose: "authoring",
      cwd: root,
      agent: "sheet-editor",
      preparationId: "prep_allowed",
    });
    const events: DomainEvent[] = [];

    await settlePermission(adapter, grants, (e) => events.push(e), {
      sessionId: session.sessionId,
      permissionId: "p1",
      actionClass: "webfetch",
    });
    const settled = events[0]!;
    assert.equal(settled.type, "permission.settled");
    assert.equal(settled.type === "permission.settled" && settled.remembered, true);

    await settlePermission(adapter, grants, (e) => events.push(e), {
      sessionId: session.sessionId,
      permissionId: "p2",
      actionClass: "edit",
    });
    const pending = events.findLast((e) => e.type === "permission.pending");
    assert.equal(pending?.type === "permission.pending" && pending.description, "The agent wants to edit a file");
  });

  it("rejects a remembered grant denied by the session confinement and records the defect", async () => {
    const root = await tempDir("arke-grants-");
    const grants = new GrantStore(root);
    await grants.remember("edit", CLOCK());
    const adapter = new MockHarnessAdapter();
    adapter.prepareSession?.({ preparationId: "prep_denied" });
    const session = await adapter.createSession({
      purpose: "world-chat",
      cwd: root,
      agent: "world-builder",
      preparationId: "prep_denied",
    });
    const events: DomainEvent[] = [];
    const defects: Array<{ adapter: string; sessionId: string; reason: string }> = [];

    const result = await settlePermission(
      adapter,
      grants,
      (event) => events.push(event),
      {
        sessionId: session.sessionId,
        permissionId: "p-denied",
        actionClass: "edit",
        detail: "C:/world/private.md",
      },
      (defect) => {
        defects.push(defect);
      },
    );

    assert.equal(result, "settled");
    assert.deepEqual(adapter.permissionDecisions.at(-1), {
      permissionId: "p-denied",
      decision: "reject",
      message: "Denied by Arke Studio's active confinement.",
    });
    assert.ok(!events.some((event) => event.type === "permission.pending"), "denial never reaches the prompt UI");
    assert.deepEqual(events.at(-1), {
      at: events.at(-1)!.at,
      type: "permission.settled",
      permissionId: "p-denied",
      decision: "reject",
      remembered: false,
    });
    assert.equal(defects.length, 1);
    assert.equal(defects[0]!["reason"], "edit is denied by the active confinement");
    assert.ok(!("actionClass" in defects[0]!), "raw harness action classes are not logged");
    assert.ok(!("detail" in defects[0]!), "paths and harness resources are not logged");
    assert.equal(await grants.covers("edit"), true, "the durable grant remains stored but inert");
  });

  it("does not apply a remembered grant to an action the adapter has not mapped", async () => {
    const root = await tempDir("arke-grants-");
    const grants = new GrantStore(root);
    await grants.remember("future-tool", CLOCK());
    const adapter = new MockHarnessAdapter();
    adapter.prepareSession?.({ preparationId: "prep_unknown" });
    const session = await adapter.createSession({
      purpose: "authoring",
      cwd: root,
      agent: "sheet-editor",
      preparationId: "prep_unknown",
    });
    const events: DomainEvent[] = [];

    const result = await settlePermission(adapter, grants, (event) => events.push(event), {
      sessionId: session.sessionId,
      permissionId: "p-unknown",
      actionClass: "future-tool",
    });

    assert.equal(result, "pending");
    assert.equal(adapter.permissionDecisions.length, 0, "an unmapped action cannot be silently granted");
    const pending = events.at(-1);
    assert.equal(pending?.type, "permission.pending");
    assert.equal(
      pending?.type === "permission.pending" && pending.description,
      "The agent wants to use a capability Studio does not recognise yet",
    );
  });

  it("does not claim an automatic denial settled until the harness confirms it", async () => {
    const root = await tempDir("arke-grants-");
    const adapter = new MockHarnessAdapter();
    adapter.permissionAckStatus = "unconfirmed";
    adapter.prepareSession?.({ preparationId: "prep_unconfirmed" });
    const session = await adapter.createSession({
      purpose: "world-chat",
      cwd: root,
      agent: "world-builder",
      preparationId: "prep_unconfirmed",
    });
    const events: DomainEvent[] = [];

    const result = await settlePermission(adapter, new GrantStore(root), (event) => events.push(event), {
      sessionId: session.sessionId,
      permissionId: "p-unconfirmed",
      actionClass: "edit",
    });

    assert.equal(result, "retry");
    assert.equal(events.length, 0, "no settled or pending event is emitted without acknowledgement");
  });

  it("retires an automatic decision when the harness says the request is stale", async () => {
    const root = await tempDir("arke-grants-");
    const adapter = new MockHarnessAdapter();
    adapter.permissionAckStatus = "stale";
    adapter.prepareSession?.({ preparationId: "prep_stale" });
    const session = await adapter.createSession({
      purpose: "world-chat",
      cwd: root,
      agent: "world-builder",
      preparationId: "prep_stale",
    });

    const result = await settlePermission(adapter, new GrantStore(root), () => {}, {
      sessionId: session.sessionId,
      permissionId: "p-stale",
      actionClass: "edit",
    });
    assert.equal(result, "gone");
  });

  it("remembers a visible always choice only after the harness confirms it", async () => {
    const root = await tempDir("arke-grants-");
    const grants = new GrantStore(root);
    const adapter = new MockHarnessAdapter();
    adapter.permissionAckStatus = "unconfirmed";

    assert.equal(
      await settlePendingPermission(adapter, grants, {
        permissionId: "p-user",
        actionClass: "future-tool",
        decision: "always",
      }),
      "retry",
    );
    assert.equal(await grants.covers("future-tool"), false);

    adapter.permissionAckStatus = "confirmed";
    assert.equal(
      await settlePendingPermission(adapter, grants, {
        permissionId: "p-user",
        actionClass: "future-tool",
        decision: "always",
      }),
      "settled",
    );
    assert.equal(await grants.covers("future-tool"), true);
  });
});

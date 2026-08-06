import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newId, type ChatAttachmentId, type ConversationId, type RunId } from "@arke-studio/contracts";
import { LeaseDeniedError, QueryLeaseRegistry } from "../../src/world-chat/lease.js";

/**
 * Run-scoped query leases (#70 §9.1).
 *
 * The test that carries the weight is the world switch. Everything else here is bookkeeping; that
 * one is the difference between a conversation reading its own world and a conversation reading
 * somebody else's without anybody noticing.
 */

function setup(options: { world?: string | null; at?: number; runActive?: boolean } = {}) {
  const state = {
    world: options.world === undefined ? "world-a" : options.world,
    at: options.at ?? 1_000,
    runActive: options.runActive ?? true,
  };
  const registry = new QueryLeaseRegistry(
    () => state.world,
    () => state.at,
    () => state.runActive,
  );
  return { registry, state };
}

function mint(registry: QueryLeaseRegistry, world = "world-a", attachments: ChatAttachmentId[] = []) {
  return registry.mint({
    worldId: world,
    conversationId: newId("cv") as ConversationId,
    runId: newId("run") as RunId,
    allowedAttachmentIds: attachments,
  });
}

function denial(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof LeaseDeniedError) return err.failure;
    throw err;
  }
  throw new Error("expected the lease to be denied");
}

describe("query lease", () => {
  it("resolves a freshly minted token", () => {
    const { registry } = setup();
    const lease = mint(registry);
    assert.equal(registry.verify(lease.token).runId, lease.runId);
  });

  it("refuses to answer out of a different world after a switch", () => {
    const { registry, state } = setup();
    const lease = mint(registry, "world-a");
    assert.ok(registry.verify(lease.token), "valid while its own world is open");

    state.world = "world-b";

    assert.equal(
      denial(() => registry.verify(lease.token)),
      "world-changed",
      "the lease must not follow the user to the world they switched to",
    );
  });

  it("refuses once the world is closed rather than waiting for one to open", () => {
    const { registry, state } = setup();
    const lease = mint(registry, "world-a");
    state.world = null;
    assert.equal(
      denial(() => registry.verify(lease.token)),
      "world-closed",
    );
  });

  it("does not come back to life when the original world is reopened", () => {
    const { registry, state } = setup();
    const lease = mint(registry, "world-a");

    state.world = "world-b";
    registry.revokeAll(); // what closing a world does
    state.world = "world-a";

    assert.equal(
      denial(() => registry.verify(lease.token)),
      "unknown-token",
      "a lease dropped on close stays dropped, even if the same world comes back",
    );
  });

  it("expires on time and forgets the token", () => {
    const { registry, state } = setup();
    const lease = registry.mint({
      worldId: "world-a",
      conversationId: newId("cv") as ConversationId,
      runId: newId("run") as RunId,
      ttlMs: 500,
    });

    state.at = 1_499;
    assert.ok(registry.verify(lease.token), "still inside its window");

    state.at = 1_500;
    assert.equal(
      denial(() => registry.verify(lease.token)),
      "expired",
      "expiry is inclusive of the boundary",
    );
    assert.equal(registry.size, 0, "and the expired lease is not kept around");
  });

  it("stops working the moment its run stops, without waiting for expiry", () => {
    const { registry, state } = setup();
    const lease = mint(registry);
    state.runActive = false;
    assert.equal(
      denial(() => registry.verify(lease.token)),
      "run-not-active",
      "a missed revoke must not leave a dead run reading the world",
    );
  });

  it("rejects an unknown token", () => {
    const { registry } = setup();
    assert.equal(
      denial(() => registry.verify("not-a-real-token")),
      "unknown-token",
    );
  });

  it("allows only the read-only world-chat surface", () => {
    const { registry } = setup();
    const lease = mint(registry);
    assert.ok(registry.verify(lease.token, "search_canon"));
    assert.ok(registry.verify(lease.token, "get_attachment_text"));
    assert.equal(
      denial(() => registry.verify(lease.token, "commit")),
      "operation-not-allowed",
    );
  });

  it("reads only the attachments the run was given", () => {
    const { registry } = setup();
    const allowed = newId("wca") as ChatAttachmentId;
    const other = newId("wca") as ChatAttachmentId;
    const lease = mint(registry, "world-a", [allowed]);

    registry.assertAttachmentAllowed(lease, allowed);
    assert.equal(
      denial(() => registry.assertAttachmentAllowed(lease, other)),
      "attachment-not-allowed",
      "another conversation's private attachment is not reachable from this run",
    );
  });

  it("revokes by run and by conversation without touching the others", () => {
    const { registry } = setup();
    const keep = mint(registry);
    const drop = mint(registry);

    registry.revokeRun(drop.runId);
    assert.equal(
      denial(() => registry.verify(drop.token)),
      "unknown-token",
    );
    assert.ok(registry.verify(keep.token), "an unrelated run keeps its lease");

    registry.revokeConversation(keep.conversationId);
    assert.equal(
      denial(() => registry.verify(keep.token)),
      "unknown-token",
    );
  });

  it("gives every lease a distinct unguessable token", () => {
    const { registry } = setup();
    const tokens = new Set(Array.from({ length: 50 }, () => mint(registry).token));
    assert.equal(tokens.size, 50);
    for (const token of tokens) assert.match(token, /^[0-9a-f]{64}$/);
  });

  it("sweeps expired leases without disturbing live ones", () => {
    const { registry, state } = setup();
    const conversationId = newId("cv") as ConversationId;
    registry.mint({ worldId: "world-a", conversationId, runId: newId("run") as RunId, ttlMs: 100 });
    const live = registry.mint({
      worldId: "world-a",
      conversationId,
      runId: newId("run") as RunId,
      ttlMs: 10_000,
    });

    state.at = 2_000;
    assert.equal(registry.sweep(), 1);
    assert.equal(registry.size, 1);
    assert.ok(registry.verify(live.token));
  });
});

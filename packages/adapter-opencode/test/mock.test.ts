import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@arke-studio/contracts";
import { MockHarnessAdapter } from "../src/mock.js";

describe("MockHarnessAdapter", () => {
  it("honours the adapter contract: session, send, sequenced events", async () => {
    const adapter = new MockHarnessAdapter();
    assert.equal(adapter.readiness().ready, true);
    assert.ok(adapter.capabilities().has("events"));

    const collected: HarnessEvent[] = [];
    const abort = new AbortController();
    const pump = (async () => {
      for await (const event of adapter.streamEvents(abort.signal)) {
        collected.push(event);
        if (collected.length >= 2) break;
      }
    })();

    const session = await adapter.createSession({ purpose: "ask" });
    const receipt = await adapter.sendMessage({
      sessionId: session.sessionId,
      parts: [{ type: "text", text: "Can Maren call a tide she has not stood in?" }],
    });
    assert.equal(receipt.sessionId, session.sessionId);
    assert.ok(receipt.correlationId.length > 0);

    await pump;
    abort.abort();
    assert.equal(collected[0]!.type, "session.created");
    assert.equal(collected[1]!.type, "message.completed");
  });

  it("relays permission decisions and confirms via the replied event", async () => {
    const adapter = new MockHarnessAdapter();
    const ack = await adapter.respondToPermission({ permissionId: "perm_1", decision: "once" });
    assert.deepEqual(ack, { permissionId: "perm_1", status: "confirmed" });
  });

  it("stops streaming when disposed", async () => {
    const adapter = new MockHarnessAdapter();
    const pump = (async () => {
      const seen: HarnessEvent[] = [];
      for await (const event of adapter.streamEvents()) seen.push(event);
      return seen;
    })();
    await adapter.dispose();
    const seen = await pump;
    assert.equal(seen.length, 0);
    assert.equal(adapter.readiness().ready, false);
  });
});

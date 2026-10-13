import assert from "node:assert/strict";
import test from "node:test";
import { DomainEventSchema } from "../src/events.js";

test("chat creation replies correlate success and refusal without permitting arbitrary IDs or fields", () => {
  const reply = { type: "world-chat.create-result", at: "2026-10-13T19:00:00.000Z", worldId: "world", requestId: "origin-request" };
  assert.ok(DomainEventSchema.safeParse({ ...reply, conversationId: "cv_01J8F0000000000000000000C9" }).success);
  assert.ok(DomainEventSchema.safeParse({ ...reply, detail: "Your draft is retained." }).success);
  assert.equal(DomainEventSchema.safeParse({ ...reply, conversationId: "../other" }).success, false);
  assert.equal(DomainEventSchema.safeParse({ ...reply, requestId: "" }).success, false);
  assert.equal(DomainEventSchema.safeParse({ ...reply, path: "/private/world" }).success, false);
});

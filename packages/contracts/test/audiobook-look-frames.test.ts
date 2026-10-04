import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainEventSchema } from "../src/events.js";
import { ClientMessageSchema } from "../src/frames.js";

/**
 * The frames a look is made and chosen by (design turn 193, SPEC-047 R-112, R-118).
 */
const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC";
const TAKE = "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G3";
const REQ = "01J00000000000000000000001";
const base = { worldId: WORLD, sheetId: "maren-kest", lookKind: "costume", mode: "stay-close", prompt: "Storm coat.", count: 3, requestId: REQ };

describe("the frames a look is made and chosen by", () => {
  it("asks for full-body candidates, or the close view of a candidate or a look, and nothing else of the kind", () => {
    assert.ok(ClientMessageSchema.safeParse({ kind: "generate-character-looks", ...base, framing: "full-body" }).success);
    assert.ok(ClientMessageSchema.safeParse({ kind: "generate-character-looks", ...base, count: 1, framing: "close", closeOf: { takeId: TAKE } }).success);
    assert.ok(ClientMessageSchema.safeParse({ kind: "generate-character-looks", ...base, count: 1, framing: "close", closeOf: { lookId: "council-coat" } }).success);
    assert.ok(ClientMessageSchema.safeParse({ kind: "generate-character-looks", ...base }).success, "the Cast page's exploration is as it was");
    assert.equal(ClientMessageSchema.safeParse({ kind: "generate-character-looks", ...base, framing: "portrait" }).success, false);
  });

  it("accepts a look with its close view and the chapter that chooses it, or a close view for a look already held", () => {
    const accept = { kind: "accept-character-look", worldId: WORLD, sheetId: "maren-kest", takeId: TAKE };
    assert.ok(ClientMessageSchema.safeParse(accept).success);
    assert.ok(ClientMessageSchema.safeParse({ ...accept, closeTakeId: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G4", choose: { productionId: "saltlight", chapterFile: "01-neap", key: "maren-kest", sheet: "maren-kest" } }).success);
    assert.ok(ClientMessageSchema.safeParse({ ...accept, closeFor: "council-coat" }).success);
    assert.equal(ClientMessageSchema.safeParse({ ...accept, choose: { productionId: "saltlight" } }).success, false);
  });

  it("chooses a kit look for a character in a chapter, or takes the choice away", () => {
    const choose = { kind: "choose-audiobook-look", worldId: WORLD, productionId: "saltlight", chapterFile: "01-neap", key: "maren-kest", sheet: "maren-kest", requestId: REQ };
    assert.ok(ClientMessageSchema.safeParse({ ...choose, lookId: TAKE }).success);
    assert.ok(ClientMessageSchema.safeParse({ ...choose, lookId: null }).success);
    assert.equal(ClientMessageSchema.safeParse({ ...choose }).success, false, "a choice names the look or null");
  });

  it("asks which chapters chose each look, and is answered with their numbers by look", () => {
    assert.ok(ClientMessageSchema.safeParse({ kind: "read-audiobook-looks", worldId: WORLD, productionId: "saltlight", requestId: REQ }).success);
    const answer = { at: "2026-10-04T09:00:00.000Z", type: "audiobook.looks", requestId: REQ, worldId: WORLD, productionId: "saltlight", usage: { [TAKE]: [1, 3] } };
    assert.ok(DomainEventSchema.safeParse(answer).success);
    assert.equal(DomainEventSchema.safeParse({ ...answer, usage: { [TAKE]: ["one"] } }).success, false);
  });
});

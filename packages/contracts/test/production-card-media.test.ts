import assert from "node:assert/strict";
import { it } from "node:test";
import { ConversationCardMediaSchema, PrepareConversationTakeReviewSchema } from "../src/arke-actions.js";
import { newId, ulid } from "../src/ids.js";
import { ClientMessageSchema } from "../src/frames.js";
import { isRemoteHostCommand } from "../src/remote-command-access.js";

it("typed card media accepts world-relative addresses and refuses host paths and URL credentials", () => {
  const media = { kind: "image", path: "productions/saltlight/takes/tk_1/frame.png", alt: "Frame", role: "Start frame" };
  assert.equal(ConversationCardMediaSchema.safeParse(media).success, true);
  for (const path of ["C:/secret.png", "C:\\secret.png", "/secret.png", "../secret.png", "references/../../secret.png", "https://example.com/a.png?token=secret"]) {
    assert.equal(ConversationCardMediaSchema.safeParse({ ...media, path }).success, false, path);
  }
});
it("Select has a closed preparation frame with no acceptance or generation input, including on a paired phone", () => {
  const frame = { kind: "conversation-take-review-prepare", worldId: ulid(), conversationId: newId("cv"), sourceActionId: newId("act"),
    takeId: newId("tk"), shotId: "sh_12", expectedConversationSeq: 4, requestId: ulid() };
  const parsed = ClientMessageSchema.parse(frame);
  assert.equal(isRemoteHostCommand(parsed), false);
  assert.equal(PrepareConversationTakeReviewSchema.safeParse({ ...frame, approve: true }).success, false);
  assert.equal(PrepareConversationTakeReviewSchema.safeParse({ ...frame, prompt: "Spend again" }).success, false);
});

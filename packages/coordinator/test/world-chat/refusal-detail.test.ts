import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainEventSchema } from "@arke-studio/contracts";
import { refusalDetail } from "../../src/coordinator.js";

/**
 * A refusal that is too long to send (driven 2026-08-22).
 *
 * `world-chat.wrap-up-refused` bounds `detail` at 300. The gate's own wording can be longer, so
 * emitting a refusal verbatim threw on its own schema — the event never reached a client, and
 * the person who pressed Wrap up got nothing at all: no proposal, no reason, no sign that
 * anything had happened. Found by talking a shot change into a scene thread and watching the
 * button do nothing twice.
 */

const LONG =
  "some changes could not be written: productions/the-unasked/scenes/the-wrong-shape.json: " +
  "shot ids sh_1, sh_2 already belong to \"The true answer\" in this production — every shot id " +
  "must be unique across the whole production, because takes and selections key by shot id " +
  "alone. Renumber this scene's shots from sh_7 upward, keeping each shot's own number as it is.";

describe("a refusal is never silenced by its own length", () => {
  it("fits the event that carries it, and still reads as a sentence", () => {
    assert.ok(LONG.length > 300, "the message this was found with is over the bound");
    const detail = refusalDetail(LONG);
    assert.ok(detail.length <= 300, `got ${detail.length}`);
    assert.match(detail, /^some changes could not be written/, "it still opens with the cause");
    assert.match(detail, /\u2026$/, "and says it was cut");
    assert.doesNotMatch(detail, /\s\u2026$/, "trimmed at a word, not mid-space");
  });

  it("the clamped detail passes the schema that refused the raw one", () => {
    const event = {
      at: "2026-08-22T13:38:19.764Z",
      type: "world-chat.wrap-up-refused",
      conversationId: "cv_01M0MTWDEQG83VNX58HPQZ96EG",
      requestId: "e5bf5720-900d-4bdb-a599-d35050f7cbb5",
      reason: "materialise",
    };
    assert.throws(() => DomainEventSchema.parse({ ...event, detail: LONG }), "the raw message is what threw");
    assert.doesNotThrow(() => DomainEventSchema.parse({ ...event, detail: refusalDetail(LONG) }));
  });

  it("a short refusal is passed through untouched, and an empty one still says something", () => {
    assert.equal(refusalDetail("Nothing in this conversation is settled enough to propose yet."),
      "Nothing in this conversation is settled enough to propose yet.");
    assert.equal(refusalDetail("   "), "This could not be written.");
  });
});

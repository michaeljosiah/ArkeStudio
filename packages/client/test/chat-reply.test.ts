import assert from "node:assert/strict";
import { it } from "node:test";
import { chatReplyParts } from "../src/lib/chat-reply.js";

it("keeps chapter headings with their prose and round-trips exact line endings", () => {
  const first = "# Warning slip\r\n\r\n" + "Maren read the slip.\r\n\r\n".repeat(160);
  const second = "# Slack water\r\n\r\n" + "At slack water they crossed.\r\n\r\n".repeat(160);
  const parts = chatReplyParts(first + second);
  assert.equal(parts.join(""), first + second);
  assert.deepEqual(parts, [first, second]);
});

it("ends at paragraphs and keeps an otherwise stranded heading in the next part", () => {
  const first = "The watch was over. ".repeat(350) + "\n\n";
  const next = "### The warning\n\n" + "Nobody left the room. ".repeat(130) + "\n\n";
  assert.deepEqual(chatReplyParts(first + next), [first, next]);
});

it("bounds unusually long paragraphs without dropping whitespace or splitting surrogate pairs", () => {
  for (const text of ["word ".repeat(35_000), "a".repeat(7_999) + "🌊".repeat(10_000), " ".repeat(20_000), "", "Short reply."]) {
    const parts = chatReplyParts(text);
    assert.equal(parts.join(""), text);
    assert.ok(parts.every(part => part.length <= 8_000));
    assert.ok(parts.every(part => !/[\uD800-\uDBFF]$/.test(part)));
    assert.ok(parts.every(part => !/^[\uDC00-\uDFFF]/.test(part)));
  }
});

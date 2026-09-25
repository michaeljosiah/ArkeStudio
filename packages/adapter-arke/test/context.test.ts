import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, fitToWindow, promptBudget, TRIMMED_TOOL_RESULT } from "../src/context.js";
import type { ChatMessage } from "../src/ollama.js";

const big = (n: number) => "x".repeat(n);
const exchange = (i: number, size: number): ChatMessage[] => [
  { role: "user", content: `question ${i} ${big(size)}` },
  { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { path: `${i}.md` } } }] },
  { role: "tool", tool_name: "read", content: `file ${i} ${big(size)}` },
  { role: "assistant", content: `answer ${i}` },
];

test("the budget leaves room for the reply", () => {
  assert.equal(promptBudget(32_768), 28_672);
  assert.equal(promptBudget(4_096), 3_072);
});

test("a conversation that fits is left exactly as it is", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "rules" }, ...exchange(1, 100), { role: "user", content: "now" }];
  const before = JSON.stringify(messages);
  assert.equal(fitToWindow(messages, [], 3_000, messages.length - 1), true);
  assert.equal(JSON.stringify(messages), before, "an untouched history is what keeps the prompt cache warm");
});

const exchangeWith = (i: number, question: number, result: number): ChatMessage[] => [
  { role: "user", content: `question ${i} ${big(question)}` },
  { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { path: `${i}.md` } } }] },
  { role: "tool", tool_name: "read", content: `file ${i} ${big(result)}` },
  { role: "assistant", content: `answer ${i}` },
];

test("old tool results go first, and the latest round's are kept", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "rules" }, ...exchangeWith(1, 50, 3_000), ...exchangeWith(2, 50, 3_000), { role: "user", content: "now" }];
  assert.equal(fitToWindow(messages, [], 2_000, messages.length - 1), true);
  assert.equal(messages.length, 10, "trimming results was enough, so no exchange was dropped");
  assert.equal(messages[3]!.content, TRIMMED_TOOL_RESULT);
  assert.equal(messages[3]!.tool_name, "read");
  assert.ok(messages[7]!.content.startsWith("file 2"), "what the model is reasoning from now stays");
});

test("then whole exchanges go, oldest first, and the system prompt and current turn never", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "rules" }];
  for (let i = 1; i <= 6; i++) messages.push(...exchangeWith(i, 1_500, 100));
  messages.push({ role: "user", content: "now" });
  const current = messages.at(-1)!;
  assert.equal(fitToWindow(messages, [], 2_500, messages.length - 1), true);
  assert.ok(estimateTokens(messages, []) <= 2_500 * 0.7, "cut deep, so one trim lasts several turns");
  assert.equal(messages[0]!.content, "rules");
  assert.equal(messages.at(-1), current);
  assert.equal(messages[1]!.role, "user", "the history starts at the beginning of an exchange");
  assert.ok(!messages.some((m) => m.content.startsWith("question 1 ")), "the oldest exchange went first");
  assert.ok(messages.some((m) => m.content.startsWith("question 6 ")), "the newest stayed");
  for (const [i, m] of messages.entries()) {
    if (m.tool_calls) assert.equal(messages[i + 1]?.role, "tool", "no call is left without its answer");
  }
});

test("when the current turn alone cannot fit, it says so rather than cutting what is being answered", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "rules" }, ...exchange(1, 100), { role: "user", content: big(12_000) }];
  assert.equal(fitToWindow(messages, [], 3_000, messages.length - 1), false);
  assert.equal(messages.at(-1)!.content.length, 12_000);
});

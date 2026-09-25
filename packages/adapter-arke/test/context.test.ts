import test from "node:test";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { estimateTokens, fitToWindow, promptBudget, TRIMMED_TOOL_RESULT, WITHIN_TURN } from "../src/context.js";
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

test("token-dense scripts are estimated from their bytes, so they are never undercounted", () => {
  const han = estimateTokens([{ role: "user", content: "漢".repeat(1_000) }], []);
  const emoji = estimateTokens([{ role: "user", content: "🌊".repeat(1_000) }], []);
  assert.ok(han >= 1_000, `a Han character is at least a token (${han})`);
  assert.ok(emoji >= 2_000, `an emoji is at least two (${emoji})`);
  assert.ok(estimateTokens([{ role: "user", content: "x".repeat(3_000) }], []) < 1_100, "ASCII keeps its three to a token");
});

test("every tool result gathered for the current turn is kept; a turn whose evidence cannot fit says so", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "compare a and b" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { path: "a.md" } } }] },
    { role: "tool", tool_name: "read", content: `a ${big(4_000)}` },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { path: "b.md" } } }] },
    { role: "tool", tool_name: "read", content: `b ${big(4_000)}` },
  ];
  assert.equal(fitToWindow(messages, [], 2_000, 1), false);
  assert.ok(messages[3]!.content.startsWith("a "), "the first file is still what the model compares");
});

test("a re-ask the loop wrote inside a turn is dropped with that turn, never left on its own", () => {
  const reask: ChatMessage = { role: "user", content: "Your tool call could not be read: bad. Send it again." };
  WITHIN_TURN.add(reask);
  const messages: ChatMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: `first ${big(3_000)}` },
    { role: "assistant", content: "<tool_call>{bad}</tool_call>" },
    reask,
    { role: "assistant", content: "answer" },
    { role: "user", content: "now" },
  ];
  // Dropping only up to the correction would already be under the target, leaving it orphaned.
  assert.equal(fitToWindow(messages, [], 1_000, 5), true);
  assert.deepEqual(messages.map((m) => m.role), ["system", "user"], "the whole first turn went, correction and all");
  assert.equal(messages[1]!.content, "now");
});

test("dense ASCII — base64, hashes, minified JSON — is counted by its shape, not its length", () => {
  const per = (text: string) => (estimateTokens([{ role: "user", content: text }], []) - 8) / text.length;
  assert.ok(per(randomBytes(3_000).toString("base64")) >= 0.45, "base64");
  assert.ok(per(randomBytes(2_000).toString("hex")) >= 0.6, "hex");
  assert.ok(per(JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, v: i * 3.14 })))) >= 0.6, "minified JSON");
  assert.ok(per("The harbour town is Saltlight, and the bells ring at slack water.") < 0.5, "prose stays cheap");
});

test("a large image counts for what it is, so a turn carrying one is judged against the real cost", () => {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.write("IHDR", 12, "latin1"); header.writeUInt32BE(3840, 16); header.writeUInt32BE(2160, 20);
  const image = header.toString("base64");
  const small = estimateTokens([{ role: "tool", content: "", images: [] }], []);
  const large = estimateTokens([{ role: "tool", content: "", images: [image] }], []);
  assert.ok(large - small >= 16_000, `a 4K screenshot is thousands of tokens, not a flat charge (${large - small})`);
});

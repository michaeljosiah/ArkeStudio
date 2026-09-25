import type { ChatMessage, ChatTool } from "./ollama.js";

/**
 * Keeping a conversation inside the context window it was given (issue 1247, Phase 3).
 *
 * Ollama does not refuse a prompt larger than `num_ctx`: it drops the beginning, which is the
 * system prompt — the confinement statement and the role's brief. A long session would quietly
 * become a model with no instructions. So the loop trims before it asks, and ends the turn with
 * a stated reason when even the current turn cannot fit.
 *
 * Trimming breaks the prompt cache for one call, which is the cost of doing it at all. It is paid
 * rarely because the cut is deep: the conversation is brought well under the window, not just
 * under it, and the trimmed history is kept, so the next turns share a prefix again.
 */

/**
 * A deliberately cautious estimate. Tokenisers differ by model and none is available here;
 * three characters a token over-counts English prose and JSON, which is the safe direction —
 * trimming a little early costs a cache miss, trimming late costs the system prompt.
 */
const CHARS_PER_TOKEN = 3;
const TOKENS_PER_MESSAGE = 8;
/** What an image costs a vision model, roughly, whatever its size on disk. */
const TOKENS_PER_IMAGE = 768;
/** How far under the budget a trim aims, so that one trim buys several turns. */
const TRIM_TARGET = 0.7;

export const TRIMMED_TOOL_RESULT = "[Earlier tool result removed to fit the context window.]";

export function estimateTokens(messages: readonly ChatMessage[], tools: readonly ChatTool[]): number {
  let chars = JSON.stringify(tools).length;
  let extra = 0;
  for (const message of messages) {
    chars += message.content.length;
    if (message.tool_calls) chars += JSON.stringify(message.tool_calls).length;
    extra += TOKENS_PER_MESSAGE + (message.images?.length ?? 0) * TOKENS_PER_IMAGE;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + extra;
}

/** The part of the window a prompt may use: the rest is left for the reply. */
export function promptBudget(numCtx: number): number {
  return numCtx - Math.min(4_096, Math.floor(numCtx / 4));
}

/**
 * Brings `messages` under `budget`, in place. `turnStart` is the index of the current turn's
 * user message: nothing from it onward is dropped, because it is what is being answered.
 *
 * Old tool results go first — a file read three turns ago is the bulkiest and least needed
 * thing in a writing conversation — then whole earlier exchanges, oldest first, each taken with
 * its tool calls and their answers so no call is left unanswered. The system prompt is never
 * touched. Returns false when the current turn alone does not fit.
 */
export function fitToWindow(messages: ChatMessage[], tools: readonly ChatTool[], budget: number, turnStart: number): boolean {
  if (estimateTokens(messages, tools) <= budget) return true;
  const target = Math.floor(budget * TRIM_TARGET);
  // The current turn's latest round is what the model is about to reason from; a round from an
  // earlier turn is history like any other.
  const lastRound = messages.findLastIndex((message) => message.role === "assistant" && message.tool_calls !== undefined);
  const keepFrom = lastRound > turnStart ? lastRound : messages.length;
  for (let at = 1; at < messages.length && estimateTokens(messages, tools) > target; at++) {
    const message = messages[at]!;
    if (message.role !== "tool" || at > keepFrom || message.content === TRIMMED_TOOL_RESULT) continue;
    messages[at] = { role: "tool", ...(message.tool_name !== undefined ? { tool_name: message.tool_name } : {}), content: TRIMMED_TOOL_RESULT };
  }
  let start = turnStart;
  while (estimateTokens(messages, tools) > target) {
    // One exchange: from the first user message after the system prompt up to the next one.
    const next = messages.findIndex((message, index) => index > 1 && message.role === "user");
    if (next < 0 || next > start || messages[1]?.role !== "user") break;
    messages.splice(1, next - 1);
    start -= next - 1;
  }
  return estimateTokens(messages, tools) <= budget;
}

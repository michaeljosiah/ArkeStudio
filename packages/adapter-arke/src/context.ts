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
 * A deliberately cautious estimate. Tokenisers differ by model and none is available here, so
 * the count errs high — trimming a little early costs a cache miss, trimming late costs the
 * instructions.
 *
 * Counted by the shape of the text, not its length, because the same number of characters can
 * be a few tokens or many. A run of letters is a word, and three letters a token over-counts
 * every language written in Latin script; each digit and each symbol is a token of its own,
 * which is what makes hashes, base64 and minified JSON dense; a line break is a token. Any other
 * script is counted from its UTF-8 bytes at a rate that over-counts CJK and emoji, which are
 * often a token a character and sometimes several.
 */
const LETTERS_PER_TOKEN = 3;
const OTHER_BYTES_PER_TOKEN = 1.5;
const ASCII_SHAPES = /[A-Za-z]+|[0-9]|\n|[ \t\r]+|[!-/:-@[-`{-~]/g;
const TOKENS_PER_MESSAGE = 8;
/** What an image costs a vision model, roughly, whatever its size on disk. */
const TOKENS_PER_IMAGE = 768;
/** How far under the budget a trim aims, so that one trim buys several turns. */
const TRIM_TARGET = 0.7;

export const TRIMMED_TOOL_RESULT = "[Earlier tool result removed to fit the context window.]";

export function estimateTokens(messages: readonly ChatMessage[], tools: readonly ChatTool[]): number {
  let total = textTokens(JSON.stringify(tools));
  for (const message of messages) {
    total += textTokens(message.content) + TOKENS_PER_MESSAGE + (message.images?.length ?? 0) * TOKENS_PER_IMAGE;
    if (message.tool_calls) total += textTokens(JSON.stringify(message.tool_calls));
  }
  return Math.ceil(total);
}

function textTokens(text: string): number {
  let tokens = 0;
  let matched = 0;
  for (const [shape] of text.matchAll(ASCII_SHAPES)) {
    matched += shape.length;
    const first = shape.charCodeAt(0);
    const letters = (first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a);
    // Spaces and tabs ride on the word after them.
    if (letters) tokens += Math.ceil(shape.length / LETTERS_PER_TOKEN);
    else if (shape[0] !== " " && shape[0] !== "\t" && shape[0] !== "\r") tokens += 1;
  }
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 0x80) ascii++;
  // Any other ASCII — control characters — is a token each. ASCII is one UTF-8 byte a
  // character, so the bytes that are not ASCII are the rest.
  return tokens + (ascii - matched) + (Buffer.byteLength(text, "utf8") - ascii) / OTHER_BYTES_PER_TOKEN;
}

/**
 * Messages the loop wrote itself inside a turn — the re-ask after an unreadable tool call. They
 * are not the start of an exchange, so trimming takes them with the turn that produced them.
 */
export const WITHIN_TURN = new WeakSet<ChatMessage>();

/** The part of the window a prompt may use: the rest is left for the reply. */
export function promptBudget(numCtx: number): number {
  return numCtx - Math.min(4_096, Math.floor(numCtx / 4));
}

/**
 * Brings `messages` under `budget`, in place. `turnStart` is the index of the current turn's
 * user message: nothing from it onward is dropped or shortened, because it — the request and
 * every tool result gathered for it — is what is being answered. A turn whose own evidence does
 * not fit ends as over budget rather than answering from part of it.
 *
 * Old tool results go first — a file read three turns ago is the bulkiest and least needed
 * thing in a writing conversation — then whole earlier exchanges, oldest first, each taken with
 * its tool calls and their answers so no call is left unanswered. The system prompt is never
 * touched. Returns false when the current turn alone does not fit.
 */
export function fitToWindow(messages: ChatMessage[], tools: readonly ChatTool[], budget: number, turnStart: number): boolean {
  if (estimateTokens(messages, tools) <= budget) return true;
  const target = Math.floor(budget * TRIM_TARGET);
  for (let at = 1; at < turnStart && estimateTokens(messages, tools) > target; at++) {
    const message = messages[at]!;
    if (message.role !== "tool" || message.content === TRIMMED_TOOL_RESULT) continue;
    messages[at] = { role: "tool", ...(message.tool_name !== undefined ? { tool_name: message.tool_name } : {}), content: TRIMMED_TOOL_RESULT };
  }
  let start = turnStart;
  while (estimateTokens(messages, tools) > target) {
    // One exchange: from the first user message after the system prompt up to the next one.
    const next = messages.findIndex((message, index) => index > 1 && message.role === "user" && !WITHIN_TURN.has(message));
    if (next < 0 || next > start || messages[1]?.role !== "user") break;
    messages.splice(1, next - 1);
    start -= next - 1;
  }
  return estimateTokens(messages, tools) <= budget;
}

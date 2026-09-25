import { object, type JsonObject } from "@arke-studio/confined-tools";
import type { ChatToolCall } from "./ollama.js";

/**
 * Tool calls that arrived as text (issue 1247, Phase 3).
 *
 * Ollama turns a model's call into `tool_calls` only when the model's template marks it the way
 * Ollama expects. Smaller local models often write the call into their reply instead: a bare
 * JSON object, the same in a code fence, or wrapped in `<tool_call>` tags. Treating that as the
 * reply would show a person a JSON blob and do nothing.
 *
 * Recovery is strict on purpose. The whole reply must be the call — a call mentioned inside
 * prose is prose — and the arguments must parse as written. Nothing is repaired: a write
 * whose content had to be guessed at is worse than no write, so a call that cannot be read is
 * sent back to the model once with the reason, never mended.
 */
export type RecoveredCall =
  | { call: ChatToolCall }
  /** It is plainly a tool call, and it cannot be read. The reason is for the model. */
  | { unreadable: string }
  | null;

const TAGGED = /^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/;
const FENCED = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/;
const NAMED = /"(?:name|tool)"\s*:\s*"([^"]+)"/;

/**
 * `known` is every tool name that could be meant — offered or not — so that an untagged JSON
 * reply is read as a call only when it names one. A call to a tool that exists but is not offered
 * is still returned as a call: the confinement refuses it and says so, which is the honest answer.
 */
export function recoverToolCall(content: string, known: ReadonlySet<string>): RecoveredCall {
  const text = content.trim();
  const tagged = TAGGED.exec(text);
  const body = tagged?.[1] ?? FENCED.exec(text)?.[1] ?? (text.startsWith("{") && text.endsWith("}") ? text : null);
  if (body === null) return null;
  let parsed: JsonObject;
  try { parsed = object(JSON.parse(body)); } catch {
    if (tagged) return { unreadable: "the text inside <tool_call> is not valid JSON" };
    // Untagged, broken JSON is only ours when it plainly names a tool: a structured reply the
    // model botched is the reply's problem, but a botched call to `write` is a call, and the
    // model should be told it did not run rather than have the JSON shown as its answer.
    const named = NAMED.exec(body)?.[1];
    return named !== undefined && known.has(named) ? { unreadable: `the call to ${named} is not valid JSON` } : null;
  }
  const inner = object(parsed.function);
  const name = [inner.name, parsed.name, parsed.tool].find((value): value is string => typeof value === "string" && value.length > 0);
  if (name === undefined) return tagged ? { unreadable: "the call does not name a tool" } : null;
  // A structured reply can have a field called "name"; only a tool's name makes it a call.
  if (!tagged && !known.has(name)) return null;
  const raw = inner.arguments ?? parsed.arguments ?? parsed.parameters ?? parsed.args;
  if (raw === undefined) return { call: { function: { name, arguments: {} } } };
  let args: unknown = raw;
  if (typeof raw === "string") {
    try { args = JSON.parse(raw); } catch { return { unreadable: `the arguments for ${name} are not valid JSON` }; }
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { unreadable: `the arguments for ${name} must be a JSON object` };
  return { call: { function: { name, arguments: args as JsonObject } } };
}

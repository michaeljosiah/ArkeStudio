import type { HarnessEvent } from "@arke-studio/contracts";

/**
 * Pure translation of one Agent SDK message into normalised {@link HarnessEvent}s. Side-effect
 * free and table-testable; the adapter owns the I/O and the session bookkeeping.
 *
 * Unrecognised shapes dead-letter rather than propagating partials (SPEC-001 R-14) — the same
 * discipline the OpenCode normaliser keeps, and it matters more here because the message
 * vocabulary belongs to a binary that updates itself.
 */

export interface NormalizeState {
  /** Assistant text so far this turn. The contract's delta carries the accumulated text. */
  text: string;
  /** Tool-use ids already surfaced, so a repeated block does not repeat the activity line. */
  toolsSeen: Set<string>;
}

export function createNormalizeState(): NormalizeState {
  return { text: "", toolsSeen: new Set() };
}

export type NormalizeOutcome =
  | { kind: "events"; events: HarnessEvent[] }
  | { kind: "ignore" }
  | { kind: "dead-letter"; reason: string };

/**
 * Message types that carry nothing the contracts need. Listed rather than ignored wholesale so
 * the dead-letter record keeps meaning something (SPEC-001 R-14) — a stream where everything
 * unknown is silently dropped cannot tell us when the vocabulary moves under us.
 */
const IGNORED = new Set(["system", "user", "stream_event"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Tool activity in the product's own language, not the harness's (SPEC-005 R-15). */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const file = str(input["file_path"]) ?? str(input["path"]);
  const base = file ? file.split(/[\\/]/).pop() : undefined;
  if (name.startsWith("mcp__arke-world__")) {
    const tool = name.slice("mcp__arke-world__".length);
    const query = str(input["query"]);
    const id = str(input["id"]);
    if (tool === "search_canon") return query ? `checked canon — "${query}"` : "checked canon";
    if (tool === "get_entry") return id ? `read canon entry ${id}` : "read a canon entry";
    if (tool === "get_sheet") return id ? `read the sheet for ${id}` : "read a sheet";
    return `asked the world for ${tool.replace(/_/g, " ")}`;
  }
  switch (name) {
    case "Read":
      return base ? `read ${base}` : "read a file";
    case "Edit":
    case "Write":
      return base ? `edited ${base}` : "edited a file";
    case "Glob":
    case "Grep": {
      const pattern = str(input["pattern"]);
      return pattern ? `searched for ${pattern}` : "searched the proposal";
    }
    case "TodoWrite":
      return "updated its checklist";
    case "Skill":
      return `opened the ${str(input["skill"]) ?? "craft"} guidance`;
    default:
      return `used ${name}`;
  }
}

interface AssistantBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

export function normalizeClaude(raw: unknown, sessionId: string, state: NormalizeState): NormalizeOutcome {
  if (typeof raw !== "object" || raw === null) return { kind: "dead-letter", reason: "message is not an object" };
  const message = raw as { type?: string; message?: { content?: unknown }; subtype?: string; is_error?: boolean; result?: unknown };
  if (typeof message.type !== "string") return { kind: "dead-letter", reason: "missing message type" };

  if (message.type === "assistant") {
    const content = message.message?.content;
    if (!Array.isArray(content)) return { kind: "dead-letter", reason: "assistant message without content blocks" };
    const events: HarnessEvent[] = [];
    for (const block of content as AssistantBlock[]) {
      if (block.type === "text" && typeof block.text === "string") {
        state.text += block.text;
        events.push({ type: "message.delta", sessionId, text: state.text });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const id = block.id ?? `${block.name}:${state.toolsSeen.size}`;
        if (state.toolsSeen.has(id)) continue;
        state.toolsSeen.add(id);
        events.push({ type: "tool.activity", sessionId, tool: block.name, summary: toolSummary(block.name, block.input ?? {}) });
      }
    }
    return events.length > 0 ? { kind: "events", events } : { kind: "ignore" };
  }

  if (message.type === "result") {
    // `is_error` is the authority, not `subtype` — a turn that failed to authenticate still
    // arrives as subtype "success" (measured), with the failure only in is_error and the text.
    if (message.is_error === true) {
      const detail = typeof message.result === "string" ? message.result : "the turn failed";
      return {
        kind: "events",
        events: [
          { type: "session.error", sessionId, message: detail },
          { type: "session.ended", sessionId, reason: "error", detail },
        ],
      };
    }
    const text = typeof message.result === "string" ? message.result : state.text;
    return {
      kind: "events",
      events: [
        { type: "message.completed", sessionId, text },
        { type: "session.ended", sessionId, reason: "completed" },
      ],
    };
  }

  if (message.type === "rate_limit_event") {
    /*
     * The SDK grew this after the adapter was written, and it dead-lettered here (round 3,
     * 2026-08-22) — so a draft crawling through a provider rate limit looked stuck, with the
     * only trace six identical lines in a log nobody watches. It means exactly one thing the
     * person deserves to see: the turn is waiting, not wedged.
     */
    return {
      kind: "events",
      events: [{ type: "tool.activity", sessionId, tool: "rate-limit", summary: "Waiting out a rate limit" }],
    };
  }

  if (IGNORED.has(message.type)) return { kind: "ignore" };
  return { kind: "dead-letter", reason: `unrecognised message type ${message.type}` };
}

import type { HarnessEvent } from "@arke-studio/contracts";

/**
 * Pure translation of one OpenCode SSE frame into normalised {@link HarnessEvent}s
 * (SPEC-005 R-14, R-15). Side-effect-free and table-testable; the adapter owns the I/O.
 *
 * OpenCode ≥1.17 wraps frames in `{ directory, project, payload: { type, properties } }`;
 * the unwrap here is what keeps every event from dead-lettering as "missing type".
 */

export type NormalizeOutcome =
  | { kind: "events"; events: HarnessEvent[] }
  | { kind: "ignore" }
  | { kind: "dead-letter"; reason: string };

export interface NormalizeState {
  roleByMessage: Map<string, string>;
  /** Last assistant text per session, so the turn's end can finalise it. */
  textBySession: Map<string, { messageId: string; text: string }>;
  /** Tool calls already surfaced (per callID) so running→completed updates don't repeat. */
  toolsSeen: Set<string>;
  /** Cumulative token usage per session, for the budget check (R-13). */
  tokensBySession: Map<string, number>;
}

export function createNormalizeState(): NormalizeState {
  return {
    roleByMessage: new Map(),
    textBySession: new Map(),
    toolsSeen: new Set(),
    tokensBySession: new Map(),
  };
}

/**
 * The `session.next.*` stream (OpenCode ≥1.18 /api/event): granular step frames. A turn may
 * span several steps — a step ending in a tool call is followed by another; only a finish
 * that is not a tool continuation ends the turn.
 */
function normalizeSessionNext(
  type: string,
  p: Record<string, unknown>,
  state: NormalizeState,
): NormalizeOutcome {
  const sessionId = typeof p["sessionID"] === "string" ? (p["sessionID"] as string) : undefined;
  if (!sessionId) return { kind: "dead-letter", reason: `${type} without sessionID` };
  const messageId = typeof p["assistantMessageID"] === "string" ? (p["assistantMessageID"] as string) : sessionId;

  switch (type) {
    case "session.next.text.delta": {
      const delta = typeof p["delta"] === "string" ? (p["delta"] as string) : "";
      const existing = state.textBySession.get(sessionId);
      const text = (existing?.text ?? "") + delta;
      state.textBySession.set(sessionId, { messageId, text });
      return { kind: "events", events: [{ type: "message.delta", sessionId, correlationId: messageId, text }] };
    }
    case "session.next.text.ended": {
      const text = typeof p["text"] === "string" ? (p["text"] as string) : (state.textBySession.get(sessionId)?.text ?? "");
      state.textBySession.set(sessionId, { messageId, text });
      return { kind: "events", events: [{ type: "message.delta", sessionId, correlationId: messageId, text }] };
    }
    case "session.next.tool.called": {
      const tool = typeof p["tool"] === "string" ? (p["tool"] as string) : "a tool";
      const callId = typeof p["callID"] === "string" ? (p["callID"] as string) : `${messageId}:${tool}`;
      if (state.toolsSeen.has(callId)) return { kind: "ignore" };
      state.toolsSeen.add(callId);
      return {
        kind: "events",
        events: [
          {
            type: "tool.activity",
            sessionId,
            tool,
            summary: toolSummary(tool, p["input"] as Record<string, unknown> | undefined, undefined),
          },
        ],
      };
    }
    case "session.next.tool.error": {
      const error = p["error"];
      return {
        kind: "events",
        events: [
          {
            type: "tool.activity",
            sessionId,
            tool: typeof p["tool"] === "string" ? (p["tool"] as string) : "a tool",
            summary: `a tool failed: ${typeof error === "string" ? error.slice(0, 120) : "see the session"}`,
          },
        ],
      };
    }
    case "session.next.step.ended": {
      const tokens = p["tokens"] as Record<string, unknown> | undefined;
      if (tokens) {
        const total = ["input", "output", "reasoning"].reduce((sum, key) => {
          const v = tokens[key];
          return sum + (typeof v === "number" ? v : 0);
        }, 0);
        if (total > 0) state.tokensBySession.set(sessionId, (state.tokensBySession.get(sessionId) ?? 0) + total);
      }
      const finish = typeof p["finish"] === "string" ? (p["finish"] as string) : "";
      // A step that ended to run tools is a continuation; anything else ends the turn.
      if (finish && !/tool/i.test(finish)) {
        const last = state.textBySession.get(sessionId);
        state.textBySession.delete(sessionId);
        return {
          kind: "events",
          events: [
            {
              type: "message.completed",
              sessionId,
              ...(last ? { correlationId: last.messageId, text: last.text } : { text: "" }),
            },
          ],
        };
      }
      return { kind: "ignore" };
    }
    case "session.next.error": {
      const error = p["error"];
      return {
        kind: "events",
        events: [
          {
            type: "session.error",
            sessionId,
            message: typeof error === "string" ? error : JSON.stringify(error ?? "session error").slice(0, 200),
          },
        ],
      };
    }
    default:
      // prompt.admitted, prompted, step.started, text.started, tool.input.*, tool.success,
      // context.updated, and whatever the stream grows next — known noise, ignored.
      return { kind: "ignore" };
  }
}

const IGNORED_TYPES = new Set([
  "server.connected",
  "server.heartbeat",
  "sync",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.compacted",
  "session.diff",
  "session.status",
  "message.part.delta",
  "message.removed",
  "file.edited",
  "file.watcher.updated",
  "lsp.updated",
  "lsp.client.diagnostics",
  "installation.updated",
  "ide.installed",
  "todo.updated",
  "storage.write",
  "question.asked",
  "question.replied",
  "plugin.added",
  "catalog.updated",
  "project.updated",
]);

interface RawEvent {
  type?: string;
  properties?: Record<string, unknown>;
}

function sessionIdOf(p: Record<string, unknown>): string | undefined {
  const direct = p["sessionID"] ?? p["sessionId"] ?? p["session_id"];
  if (typeof direct === "string" && direct) return direct;
  const nested = (p["info"] ?? p["part"] ?? p["session"]) as Record<string, unknown> | undefined;
  const inner = nested?.["sessionID"] ?? nested?.["id"];
  return typeof inner === "string" && inner ? inner : undefined;
}

/** Render a tool invocation as a product-language progress line (R-15). */
export function toolSummary(tool: string, input: Record<string, unknown> | undefined, title: string | undefined): string {
  if (tool.includes("search_canon")) {
    const q = typeof input?.["query"] === "string" ? ` — "${input["query"]}"` : "";
    return `checked canon${q}`;
  }
  if (tool.includes("get_entry")) {
    return `read canon entry ${String(input?.["id"] ?? "")}`.trim();
  }
  if (tool.includes("get_sheet")) {
    return `read sheet ${String(input?.["id"] ?? "")}`.trim();
  }
  if (tool.includes("list_entities")) {
    return `listed ${String(input?.["kind"] ?? "entities")}`;
  }
  if (tool.includes("related")) {
    return `followed citations from ${String(input?.["id"] ?? "")}`.trim();
  }
  if (tool === "edit" || tool === "write" || tool === "patch") {
    const path = typeof input?.["filePath"] === "string" ? (input["filePath"] as string) : undefined;
    const name = path ? (path.split(/[\\/]/).pop() ?? path) : "a file";
    return `${tool === "write" ? "wrote" : "edited"} ${name}`;
  }
  if (tool === "read") {
    const path = typeof input?.["filePath"] === "string" ? (input["filePath"] as string) : undefined;
    return `read ${path ? (path.split(/[\\/]/).pop() ?? path) : "a file"}`;
  }
  return title && title.length > 0 ? title : `used ${tool}`;
}

export function normalizeOpenCode(raw: unknown, state: NormalizeState): NormalizeOutcome {
  if (typeof raw !== "object" || raw === null) {
    return { kind: "dead-letter", reason: "frame is not an object" };
  }
  let e = raw as RawEvent;
  if (typeof e.type !== "string") {
    const payload = (raw as { payload?: unknown }).payload;
    if (payload && typeof payload === "object" && typeof (payload as RawEvent).type === "string") {
      e = payload as RawEvent;
    }
  }
  if (typeof e.type !== "string") return { kind: "dead-letter", reason: "missing event type" };
  // Two live generations: `properties` (legacy /global/event, wrapped) and `data` (/api/event).
  const p = e.properties ?? (e as { data?: Record<string, unknown> }).data ?? {};

  if (e.type.startsWith("session.next.")) return normalizeSessionNext(e.type, p, state);

  switch (e.type) {
    case "message.updated": {
      const info = p["info"] as
        | {
            id?: string;
            sessionID?: string;
            role?: string;
            type?: string;
            finish?: string;
            tokens?: Record<string, unknown>;
          }
        | undefined;
      const role = info?.role ?? info?.type; // the /api generation carries `type: "assistant"`
      if (info?.id && role) state.roleByMessage.set(info.id, role);
      if (info?.sessionID && info.tokens) {
        const total = ["input", "output", "reasoning"].reduce((sum, key) => {
          const v = info.tokens?.[key];
          return sum + (typeof v === "number" ? v : 0);
        }, 0);
        if (total > 0) {
          state.tokensBySession.set(info.sessionID, (state.tokensBySession.get(info.sessionID) ?? 0) + total);
        }
      }
      // The /api generation marks turn completion on the message itself (`finish`), and does
      // not always follow with a session.idle — treat it as the turn's end.
      //
      // Except when the finish is a tool call. A turn that reads a file finishes its first
      // message with "tool-calls" and carries straight on; taking that for the end reports a
      // completed turn carrying no text, seconds before the agent says anything. The
      // session.next branch above has always known this (`!/tool/i`) — this one did not, so a
      // world-author asked to read an attachment answered with silence.
      if (
        info?.sessionID &&
        role === "assistant" &&
        typeof info.finish === "string" &&
        info.finish.length > 0 &&
        !/tool/i.test(info.finish)
      ) {
        const last = state.textBySession.get(info.sessionID);
        state.textBySession.delete(info.sessionID);
        return {
          kind: "events",
          events: [
            {
              type: "message.completed",
              sessionId: info.sessionID,
              ...(last ? { correlationId: last.messageId, text: last.text } : { text: "" }),
            },
          ],
        };
      }
      return { kind: "ignore" };
    }

    case "message.part.updated": {
      const part = p["part"] as
        | {
            sessionID?: string;
            messageID?: string;
            type?: string;
            text?: string;
            tool?: string;
            callID?: string;
            state?: { status?: string; title?: string; input?: Record<string, unknown> };
          }
        | undefined;
      const sessionId = part?.sessionID;
      if (!part || !sessionId) return { kind: "dead-letter", reason: "part without sessionID" };

      if (part.type === "text" && typeof part.text === "string" && part.messageID) {
        const role = state.roleByMessage.get(part.messageID);
        if (role === "user") return { kind: "ignore" };
        state.textBySession.set(sessionId, { messageId: part.messageID, text: part.text });
        return {
          kind: "events",
          events: [{ type: "message.delta", sessionId, correlationId: part.messageID, text: part.text }],
        };
      }
      if (part.type === "tool" && part.tool) {
        const status = part.state?.status;
        const key = `${part.callID ?? part.messageID ?? ""}:${part.tool}`;
        // Surface once, when the call starts running — progress, not an audit log.
        if ((status === "running" || status === "completed") && !state.toolsSeen.has(key)) {
          state.toolsSeen.add(key);
          return {
            kind: "events",
            events: [
              {
                type: "tool.activity",
                sessionId,
                tool: part.tool,
                summary: toolSummary(part.tool, part.state?.input, part.state?.title),
              },
            ],
          };
        }
        return { kind: "ignore" };
      }
      return { kind: "ignore" };
    }

    case "session.idle": {
      const sessionId = sessionIdOf(p);
      if (!sessionId) return { kind: "dead-letter", reason: "session.idle without sessionID" };
      const last = state.textBySession.get(sessionId);
      state.textBySession.delete(sessionId);
      return {
        kind: "events",
        events: [
          {
            type: "message.completed",
            sessionId,
            ...(last ? { correlationId: last.messageId, text: last.text } : { text: "" }),
          },
        ],
      };
    }

    case "session.error": {
      const sessionId = sessionIdOf(p);
      const error = p["error"] as { name?: string; data?: { message?: string } } | string | undefined;
      const message =
        typeof error === "string"
          ? error
          : [error?.name, error?.data?.message].filter(Boolean).join(": ") || "session error";
      return {
        kind: "events",
        events: [{ type: "session.error", ...(sessionId ? { sessionId } : {}), message }],
      };
    }

    case "permission.updated":
    case "permission.asked": {
      const id = (p["id"] ?? (p["permission"] as Record<string, unknown> | undefined)?.["id"]) as
        | string
        | undefined;
      const sessionId = sessionIdOf(p) ?? "";
      if (!id) return { kind: "dead-letter", reason: `${e.type} without id` };
      const kind = (p["type"] ?? p["pattern"] ?? "an action") as string;
      return {
        kind: "events",
        events: [
          {
            type: "permission.requested",
            sessionId,
            permissionId: id,
            actionClass: String(kind),
          },
        ],
      };
    }

    case "permission.replied": {
      const id = (p["permissionID"] ?? p["id"]) as string | undefined;
      const sessionId = sessionIdOf(p) ?? "";
      if (!id) return { kind: "dead-letter", reason: "permission.replied without id" };
      const decision = (p["response"] ?? p["reply"] ?? "once") as string;
      return {
        kind: "events",
        events: [
          {
            type: "permission.replied",
            sessionId,
            permissionId: id,
            decision: decision === "always" ? "always" : decision === "reject" ? "reject" : "once",
          },
        ],
      };
    }

    default:
      if (IGNORED_TYPES.has(e.type)) return { kind: "ignore" };
      return { kind: "dead-letter", reason: `unrecognised event type: ${e.type}` };
  }
}

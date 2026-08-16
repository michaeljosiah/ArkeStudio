import type { HarnessEvent } from "@arke-studio/contracts";
import { toolSummary } from "../normalize.js";

/**
 * Pure translation of one OpenCode v2 event into normalised {@link HarnessEvent}s (issue 327
 * §6). Side-effect-free and table-testable; the adapter owns the I/O.
 *
 * v2 frames are flat: `{ id, type, data, location?, durable? }` — no payload wrapper, no
 * `properties`. The vocabulary was measured against 0.0.0-next-17444 end to end, including a
 * full keyed turn with a held tool call and a permission round trip.
 */

export type NormalizeV2Outcome =
  | { kind: "events"; events: HarnessEvent[] }
  | { kind: "ignore" }
  | { kind: "dead-letter"; reason: string }
  /**
   * The turn ended well, and the event says nothing else: `session.execution.succeeded`
   * carries no text (measured). The adapter answers by fetching the final assistant message —
   * the same fetch resync performs after a reconnect, so completion and recovery share one
   * code path instead of drifting apart.
   */
  | { kind: "turn-succeeded"; sessionId: string };

export interface NormalizeV2State {
  /** Accumulated assistant text per session, built from session.text.delta frames. */
  textBySession: Map<string, { messageId: string; text: string }>;
  /** Tool-call names learned from session.tool.input.started, keyed by call id. */
  toolNameByCall: Map<string, string>;
  /** Tool calls already surfaced, so held→executed transitions don't repeat (R-15). */
  toolsSeen: Set<string>;
  /**
   * Cumulative token usage per session. v2's `session.usage.updated` carries the session's
   * running totals (measured — it mirrors the session object), so this is SET, never added:
   * adding what is already a total double-counts every turn after the first.
   */
  tokensBySession: Map<string, number>;
}

export function createNormalizeV2State(): NormalizeV2State {
  return {
    textBySession: new Map(),
    toolNameByCall: new Map(),
    toolsSeen: new Set(),
    tokensBySession: new Map(),
  };
}

/**
 * Registration and catalog noise, dropped without record. A location load emits a burst of
 * ~100 `plugin.added` frames (measured); dead-lettering those churns the bounded dead-letter
 * buffer into uselessness exactly when something real drops (R-14). This set exists so the
 * dead-letter record keeps meaning something.
 */
const IGNORED_V2_TYPES = new Set([
  "server.connected",
  "plugin.added",
  "plugin.updated",
  "catalog.updated",
  "models-dev.refreshed",
  "integration.updated",
  "integration.connection.updated",
  "agent.updated",
  "command.updated",
  "skill.updated",
  "reference.updated",
  "websearch.updated",
  "config.updated",
  "filesystem.changed",
  "log.synced",
  "worktree.updated",
  "worktree.resolved",
  // Session-stream frames that carry nothing the contracts need:
  "session.created", // surfaced by the adapter itself on createSession, not from the stream
  "session.instructions.updated",
  "session.step.started",
  "session.step.ended",
  "session.reasoning.started",
  "session.reasoning.ended",
  "session.reasoning.delta",
  "session.text.started",
  "session.tool.input.delta",
  "session.tool.progress",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.delta",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.execution.started",
  "session.agent.selected",
  "session.model.selected",
  "session.renamed", // the hidden title agent renames sessions mid-turn (measured)
  "session.moved",
  "session.usage.recorded",
  "session.synthetic",
  "session.skill.activated",
  "session.revert.cleared",
  "session.revert.committed",
  "session.deleted",
  "session.forked",
  // Never observed on the pinned build (the §12 spike watched full turns; only
  // execution.succeeded closed them), and mapping it to a completion doubles the message
  // fetch. POST .../wait is the API-level idle backstop; the stream needs one signal.
  "session.idle",
]);

interface RawV2Event {
  type?: string;
  data?: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function normalizeOpenCodeV2(raw: unknown, state: NormalizeV2State): NormalizeV2Outcome {
  if (typeof raw !== "object" || raw === null) {
    return { kind: "dead-letter", reason: "frame is not an object" };
  }
  const e = raw as RawV2Event;
  if (typeof e.type !== "string") return { kind: "dead-letter", reason: "missing event type" };
  const d = e.data ?? {};

  switch (e.type) {
    case "session.text.delta": {
      const sessionId = str(d["sessionID"]);
      if (!sessionId) return { kind: "dead-letter", reason: "session.text.delta without sessionID" };
      const messageId = str(d["assistantMessageID"]) ?? sessionId;
      const delta = typeof d["delta"] === "string" ? (d["delta"] as string) : "";
      const text = (state.textBySession.get(sessionId)?.text ?? "") + delta;
      state.textBySession.set(sessionId, { messageId, text });
      // The contract's delta carries the full accumulated text, matching the v1 backing.
      return { kind: "events", events: [{ type: "message.delta", sessionId, correlationId: messageId, text }] };
    }

    case "session.text.ended": {
      const sessionId = str(d["sessionID"]);
      if (!sessionId) return { kind: "ignore" };
      const messageId = str(d["assistantMessageID"]) ?? sessionId;
      const text = typeof d["text"] === "string" && d["text"].length > 0
        ? (d["text"] as string)
        : (state.textBySession.get(sessionId)?.text ?? "");
      state.textBySession.set(sessionId, { messageId, text });
      return { kind: "ignore" };
    }

    case "session.execution.succeeded": {
      const sessionId = str(d["sessionID"]);
      if (!sessionId) return { kind: "dead-letter", reason: "session.execution.succeeded without sessionID" };
      return { kind: "turn-succeeded", sessionId };
    }

    case "session.execution.failed": {
      const sessionId = str(d["sessionID"]);
      const error = d["error"] as { type?: string; message?: string } | undefined;
      // Structured on the wire (measured: { type: "provider.auth", message: "" }) — keep the
      // type in front so "provider.auth" survives even an empty message.
      const message = [error?.type, error?.message].filter((s) => typeof s === "string" && s.length > 0).join(": ")
        || "session execution failed";
      state.textBySession.delete(sessionId ?? "");
      return { kind: "events", events: [{ type: "session.error", ...(sessionId ? { sessionId } : {}), message }] };
    }

    case "session.execution.interrupted": {
      const sessionId = str(d["sessionID"]);
      if (!sessionId) return { kind: "dead-letter", reason: "session.execution.interrupted without sessionID" };
      const reason = str(d["reason"]) ?? "interrupted";
      state.textBySession.delete(sessionId);
      return {
        kind: "events",
        events: [{ type: "session.ended", sessionId, reason: "cancelled", detail: reason }],
      };
    }

    case "session.usage.updated": {
      const sessionId = str(d["sessionID"]);
      const tokens = d["tokens"] as Record<string, unknown> | undefined;
      if (sessionId && tokens) {
        const total = ["input", "output", "reasoning"].reduce((sum, key) => {
          const v = tokens[key];
          return sum + (typeof v === "number" ? v : 0);
        }, 0);
        if (total > 0) state.tokensBySession.set(sessionId, total);
      }
      return { kind: "ignore" };
    }

    case "session.tool.input.started": {
      const call = str(d["id"]);
      const name = str(d["name"]);
      if (call && name) state.toolNameByCall.set(call, name);
      return { kind: "ignore" };
    }

    case "session.tool.input.ended": {
      return { kind: "ignore" };
    }

    case "session.tool.called": {
      const sessionId = str(d["sessionID"]);
      if (!sessionId) return { kind: "dead-letter", reason: "session.tool.called without sessionID" };
      const call = str(d["id"]);
      // Dedup only what is identifiable: collapsing id-less calls onto one session-wide key
      // would silently drop every such call after the first.
      if (call !== undefined) {
        if (state.toolsSeen.has(call)) return { kind: "ignore" };
        state.toolsSeen.add(call);
      }
      // The call frame carries input but not the tool's name (measured); the name arrived on
      // session.tool.input.started and was remembered by call id.
      const tool = (call !== undefined ? state.toolNameByCall.get(call) : undefined) ?? "a tool";
      return {
        kind: "events",
        events: [
          {
            type: "tool.activity",
            sessionId,
            tool,
            summary: toolSummary(tool, d["input"] as Record<string, unknown> | undefined, undefined),
          },
        ],
      };
    }

    case "permission.asked": {
      const id = str(d["id"]);
      if (!id) return { kind: "dead-letter", reason: "permission.asked without id" };
      // v2 has no global reply route — a session-less ask is unanswerable, and surfacing it
      // with a blank sessionId only moves the failure to respondToPermission, which would
      // report "stale" without ever posting. Dead-letter it where it can be seen (R-14).
      const sessionId = str(d["sessionID"]);
      if (!sessionId) return { kind: "dead-letter", reason: "permission.asked without sessionID" };
      const action = str(d["action"]) ?? "an action";
      const resources = Array.isArray(d["resources"])
        ? (d["resources"] as unknown[]).filter((r): r is string => typeof r === "string")
        : [];
      return {
        kind: "events",
        events: [
          {
            type: "permission.requested",
            sessionId,
            permissionId: id,
            actionClass: action,
            ...(resources.length > 0 ? { detail: resources.join(", ").slice(0, 300) } : {}),
          },
        ],
      };
    }

    case "permission.replied": {
      const id = str(d["requestID"]);
      const sessionId = str(d["sessionID"]) ?? "";
      if (!id) return { kind: "dead-letter", reason: "permission.replied without requestID" };
      const reply = str(d["reply"]) ?? "once";
      return {
        kind: "events",
        events: [
          {
            type: "permission.replied",
            sessionId,
            permissionId: id,
            decision: reply === "always" ? "always" : reply === "reject" ? "reject" : "once",
          },
        ],
      };
    }

    default:
      if (IGNORED_V2_TYPES.has(e.type)) return { kind: "ignore" };
      return { kind: "dead-letter", reason: `unrecognised event type: ${e.type}` };
  }
}

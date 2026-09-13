import {
  advanceWorldChatInputQueue, emptyWorldChatInputQueue, unresolvedWorldChatInputs,
  type WorldChatEventEnvelope, type WorldChatInputEvent, type WorldChatInputPromotion,
  type WorldChatProblem, type WorldChatStoredEvent,
} from "@arke-studio/contracts";
import { stableJson } from "../arke-actions/digest.js";

export type InputStoredEvent = Extract<WorldChatStoredEvent, { type: WorldChatInputEvent["type"] | "input.promoted" }>;

export function isInputEvent(event: WorldChatStoredEvent): event is InputStoredEvent {
  return event.type.startsWith("input.") || event.type.startsWith("input-queue.");
}

/** Replay is read-only. Startup writes a pause separately; reading twice must not dispatch anything. */
export function foldWorldChatInputs(events: readonly WorldChatEventEnvelope[]) {
  let queue = emptyWorldChatInputQueue();
  const problems: WorldChatProblem[] = [];
  const acceptedSequences = new Set<number>();
  const running = new Map<string, { turnId: string; sessionId?: string }>();
  for (const { event, seq } of events) {
    if (isInputEvent(event)) {
      let problem: string | undefined;
      if (event.type === "input.promoted") {
        const row = queue.inputs.find(one => one.input.messageId === event.messageId);
        if (running.size > 0) problem = "An input was promoted while a run was still active.";
        else if (!row || event.messageId !== event.message.id || event.turnId !== event.message.turnId ||
          event.turnId !== event.run.turnId || event.runId !== event.run.id || event.message.role !== "user" ||
          event.run.status !== "running" || event.message.text !== row.input.request.text ||
          event.message.createdAt !== row.input.createdAt ||
          stableJson(event.message.attachmentIds) !== stableJson(row.input.request.attachmentIds) ||
          stableJson(event.constraints) !== stableJson(row.input.constraints)) {
          problem = "A promoted turn changed the input's identity, content or constraints.";
        }
      }
      if (event.type === "input.offer-started") {
        const run = running.get(event.attempt.runId);
        if (event.attempt.ordinal !== 1) problem = "Corrections cannot be offered to a structured-result repair attempt.";
        else if (!run || run.turnId !== event.attempt.turnId || run.sessionId !== event.attempt.sessionId) {
          problem = "The input offer does not belong to the active run's native session.";
        }
      }
      const transition: WorldChatInputEvent | WorldChatInputPromotion = event;
      const advanced = problem ? { queue: { ...queue, pauseReason: "integrity" as const }, problem }
        : advanceWorldChatInputQueue(queue, transition, seq);
      queue = advanced.queue;
      if (advanced.problem) {
        problems.push({ kind: "interior-corruption", atSeq: seq, detail: advanced.problem });
      } else {
        acceptedSequences.add(seq);
        if (event.type === "input.promoted") running.set(event.runId, { turnId: event.turnId });
      }
    } else if (event.type === "turn.started" || event.type === "run.retry-started") {
      running.set(event.run.id, { turnId: event.run.turnId,
        ...(event.run.harnessSessionId ? { sessionId: event.run.harnessSessionId } : {}),
      });
    } else if (event.type === "run.session-created") {
      const run = running.get(event.runId);
      if (run) running.set(event.runId, { ...run, sessionId: event.harnessSessionId });
    } else if (event.type === "run.finished" || event.type === "turn.completed") {
      running.delete(event.run.id);
      // The terminal event is itself durable: failure cannot leave automatic queue advancement enabled.
      if (event.run.status !== "completed" && unresolvedWorldChatInputs(queue).length > 0 && queue.pauseReason === null) {
        queue = { ...queue, revision: queue.revision + 1, pauseReason: event.run.status === "cancelled" ? "stopped" :
          event.run.status === "timeout" ? "timeout" : event.run.status === "budget-exceeded" ? "budget-exceeded" : "failed" };
      }
    } else if (event.type === "conversation.archived" && queue.inputs.length > 0 && queue.pauseReason === null) {
      queue = { ...queue, revision: queue.revision + 1, pauseReason: "archived" };
    }
  }
  return { queue, problems, acceptedSequences, running };
}

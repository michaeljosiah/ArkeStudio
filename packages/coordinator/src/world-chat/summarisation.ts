import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  newId,
  type HarnessAdapter,
  type SessionConfigInput,
  type WorldChatMessage,
} from "@arke-studio/contracts";
import { extractJson } from "../canon/ask.js";
import { createPreparedSession, type SessionInput } from "../harness/session-files.js";
import { toExtendedLength } from "../world/paths.js";
import { boundSummary, shouldSummarise } from "./context.js";
import type { WorldChatStore } from "./store.js";
import { foldWorldChatInputs } from "./input-fold.js";

export interface ConversationSummaryRequest {
  readonly previousSummary?: string;
  readonly messages: readonly Pick<WorldChatMessage, "id" | "role" | "text">[];
}

export type ConversationSummariser = (input: ConversationSummaryRequest) => Promise<string | null>;

interface SummaryFlight {
  rerun: boolean;
  promise: Promise<boolean>;
}

const inFlight = new Map<string, SummaryFlight>();

/** Condense newly completed turns, preserving the previous summary when the model cannot answer. */
export function refreshConversationSummary(
  store: WorldChatStore,
  summarise: ConversationSummariser,
): Promise<boolean> {
  const absolute = resolve(store.dir).replaceAll("\\", "/");
  const key = process.platform === "win32" || process.platform === "darwin" ? absolute.toLowerCase() : absolute;
  const existing = inFlight.get(key);
  if (existing) {
    existing.rerun = true;
    return existing.promise;
  }
  const flight: SummaryFlight = { rerun: false, promise: Promise.resolve(false) };
  flight.promise = (async () => {
    let updated = false;
    do {
      flight.rerun = false;
      updated = await refreshConversationSummaryOnce(store, summarise) || updated;
    } while (flight.rerun);
    return updated;
  })().finally(() => {
    if (inFlight.get(key) === flight) inFlight.delete(key);
  });
  inFlight.set(key, flight);
  return flight.promise;
}

async function refreshConversationSummaryOnce(
  store: WorldChatStore,
  summarise: ConversationSummariser,
): Promise<boolean> {
  const { events } = await store.read();
  const previous = [...events].reverse().find((envelope) => envelope.event.type === "summary.updated");
  const through = previous?.event.type === "summary.updated" ? previous.event.throughSeq : 0;
  let throughSeq = through;
  for (const envelope of events) {
    if (envelope.seq > through && envelope.event.type === "turn.completed") throughSeq = envelope.seq;
  }
  const messages: Array<Pick<WorldChatMessage, "id" | "role" | "text">> = [];
  const inputs = foldWorldChatInputs(events);
  if (inputs.problems.length) return false;
  const completed = new Map(events.flatMap(({ event, seq }) => event.type === "turn.completed" ? [[event.run.id, seq] as const] : []));
  const summarisedIds = new Set(events.flatMap(({ event }) => event.type === "summary.updated" ? event.sourceMessageIds : []));
  let lateInclusion = false;
  let includedThroughSeq = 0;
  let turnCount = 0;
  for (const envelope of events) {
    const inWindow = envelope.seq > through && envelope.seq <= throughSeq;
    if (inWindow && (envelope.event.type === "turn.started" ||
      (envelope.event.type === "input.promoted" && inputs.acceptedSequences.has(envelope.seq)))) messages.push(envelope.event.message);
    if (envelope.event.type === "input.included" && inputs.acceptedSequences.has(envelope.seq) &&
      completed.has(envelope.event.attempt.runId) && !summarisedIds.has(envelope.event.messageId)) {
      const messageId = envelope.event.messageId;
      const input = inputs.queue.inputs.find(row => row.input.messageId === messageId)?.input;
      if (input) messages.push({ id: messageId, role: "user", text: input.request.text });
      includedThroughSeq = Math.max(includedThroughSeq, envelope.seq);
      lateInclusion ||= envelope.seq > completed.get(envelope.event.attempt.runId)!;
    }
    if (inWindow && envelope.event.type === "turn.completed") {
      messages.push(envelope.event.message);
      turnCount++;
    }
  }
  const recentTurnsLength = messages.reduce((sum, message) => sum + message.text.length, 0);
  // Reconciliation may arrive after completion or even after its summary. Include it once
  // without advancing the normal boundary past a later turn that is still running.
  if (!lateInclusion && !shouldSummarise({ turnCount, recentTurnsLength })) return false;

  const text = await summarise({
    ...(previous?.event.type === "summary.updated" ? { previousSummary: previous.event.text } : {}),
    messages,
  });
  if (text === null || text.trim() === "") return false;
  const summary = boundSummary({
    throughSeq,
    sourceMessageIds: messages.map((message) => message.id),
    text: text.trim(),
  });
  await store.append(
    { type: "summary.updated", ...summary, sourceMessageIds: [...summary.sourceMessageIds] },
    { at: new Date().toISOString(), requestId: `conversation-summary:${throughSeq}:${includedThroughSeq}` },
  );
  return true;
}

const SummaryResponseSchema = z.object({ summary: z.string().min(1).max(8_000) }).strict();
const SUMMARY_TIMEOUT_MS = 120_000;

/** A separate, tool-free harness turn whose answer can only become non-authoritative context. */
export function makeConversationSummariser(
  adapter: HarnessAdapter,
  sessionInput: SessionInput,
  scratchRoot: string,
): ConversationSummariser {
  return async (input) => {
    const scratch = join(scratchRoot, `summary-${newId("run")}`);
    await mkdir(toExtendedLength(scratch), { recursive: true });
    const sessionConfig: SessionConfigInput = sessionInput({});
    const session = await createPreparedSession(adapter, scratch, sessionConfig, {
      purpose: "world-chat",
      agent: "conversation-summarizer",
    });
    const abort = new AbortController();
    let finalText = "";
    const collected = (async () => {
      for await (const event of adapter.streamEvents(abort.signal)) {
        if (!("sessionId" in event) || event.sessionId !== session.sessionId) continue;
        if (event.type === "message.completed") {
          finalText = event.text ?? "";
          return;
        }
        if (event.type === "session.error") throw new Error(event.message);
      }
    })();
    const prior = input.previousSummary
      ? `Existing summary:\n${input.previousSummary}\n\n`
      : "";
    const transcript = input.messages
      .map((message) => `${message.role === "user" ? "User" : "Studio"} [${message.id}]: ${message.text}`)
      .join("\n\n");
    const prompt = `${prior}New conversation messages to incorporate:\n${transcript}`;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("conversation summarisation timed out")), SUMMARY_TIMEOUT_MS);
    });
    try {
      await adapter.dispatchAsync({ sessionId: session.sessionId, parts: [{ type: "text", text: prompt }] });
      await Promise.race([collected, timeout]);
      const parsed = SummaryResponseSchema.safeParse(extractJson(finalText));
      return parsed.success ? parsed.data.summary.trim() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(deadline);
      abort.abort();
      await rm(toExtendedLength(scratch), { recursive: true, force: true }).catch(() => {});
    }
  };
}

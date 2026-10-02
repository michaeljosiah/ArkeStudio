import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  newId,
  type HarnessAdapter,
  type WorldChatMessage,
} from "@arke-studio/contracts";
import { extractJson } from "../canon/ask.js";
import { createPreparedSession, type SessionInput } from "../harness/session-files.js";
import { toExtendedLength } from "../world/paths.js";
import { boundSummary, shouldSummarise } from "./context.js";
import type { WorldChatStore } from "./store.js";
import { foldWorldChatInputs } from "./input-fold.js";

type SummaryMessage = Pick<WorldChatMessage, "id" | "role" | "text"> & {
  /** Ties a correction confirmed late to the reply it reached, which an earlier summary may hold. */
  replyMessageId?: WorldChatMessage["id"];
};

export interface ConversationSummaryRequest {
  readonly previousSummary?: string;
  readonly messages: readonly SummaryMessage[];
  /** The model the conversation's latest answer ran on, for when the summariser has none of its own. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export type ConversationSummariser = (input: ConversationSummaryRequest) => Promise<string | null>;

interface SummaryFlight {
  rerun: boolean;
  promise: Promise<boolean>;
}

const inFlight = new Map<string, SummaryFlight>();

/** Stop waiting even when an injected summariser does not honour cancellation. */
function cancellable<T>(promise: Promise<T>, signal: AbortSignal | undefined, fallback: T): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) { void promise.catch(() => {}); return Promise.resolve(fallback); }
  return new Promise<T>((resolve, reject) => {
    const stop = () => { signal.removeEventListener("abort", stop); resolve(fallback); };
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", stop); resolve(value); },
      error => { signal.removeEventListener("abort", stop); reject(error); },
    );
  });
}

/** Condense newly completed turns, preserving the previous summary when the model cannot answer. */
export function refreshConversationSummary(
  store: WorldChatStore,
  summarise: ConversationSummariser,
  signal?: AbortSignal,
): Promise<boolean> {
  const absolute = resolve(store.dir).replaceAll("\\", "/");
  const key = process.platform === "win32" || process.platform === "darwin" ? absolute.toLowerCase() : absolute;
  const existing = inFlight.get(key);
  if (existing) {
    existing.rerun = true;
    return cancellable(existing.promise, signal, false);
  }
  const flight: SummaryFlight = { rerun: false, promise: Promise.resolve(false) };
  flight.promise = (async () => {
    let updated = false;
    do {
      flight.rerun = false;
      updated = await refreshConversationSummaryOnce(store, summarise, signal) || updated;
    } while (flight.rerun && !signal?.aborted);
    return updated;
  })().finally(() => {
    if (inFlight.get(key) === flight) inFlight.delete(key);
  });
  inFlight.set(key, flight);
  return cancellable(flight.promise, signal, false);
}

async function refreshConversationSummaryOnce(
  store: WorldChatStore,
  summarise: ConversationSummariser,
  signal?: AbortSignal,
): Promise<boolean> {
  const { events } = await store.read();
  const previous = [...events].reverse().find((envelope) => envelope.event.type === "summary.updated");
  const through = previous?.event.type === "summary.updated" ? previous.event.throughSeq : 0;
  let throughSeq = through;
  for (const envelope of events) {
    if (envelope.seq > through && (envelope.event.type === "turn.completed" || envelope.event.type === "founding.message")) throughSeq = envelope.seq;
  }
  // Additional input (SPEC-045 R-26): only corrections proven included in a finished run count,
  // and damaged input history is never summarised into context.
  const inputs = foldWorldChatInputs(events);
  if (inputs.problems.length) return false;
  const completed = new Map(events.flatMap(({ event, seq }) => event.type === "turn.completed" ? [[event.run.id, seq] as const] : []));
  const summarisedIds = new Set(events.flatMap(({ event }) => event.type === "summary.updated" ? event.sourceMessageIds : []));
  let lateInclusion = false;
  let includedThroughSeq = 0;
  const corrections = new Map<string, SummaryMessage[]>();
  for (const { event, seq } of events) {
    if (event.type !== "input.included" || !inputs.acceptedSequences.has(seq) ||
      !completed.has(event.attempt.runId) || summarisedIds.has(event.messageId)) continue;
    const input = inputs.queue.inputs.find(row => row.input.messageId === event.messageId)?.input;
    const runId = event.attempt.runId;
    if (input) corrections.set(runId, [...(corrections.get(runId) ?? []), { id: event.messageId, role: "user", text: input.request.text }]);
    includedThroughSeq = Math.max(includedThroughSeq, seq);
    lateInclusion ||= seq > completed.get(runId)!;
  }
  const messages: SummaryMessage[] = [];
  let turnCount = 0;
  let model: string | undefined;
  for (const envelope of events) {
    const event = envelope.event;
    const inWindow = envelope.seq > through && envelope.seq <= throughSeq;
    if (inWindow && (event.type === "turn.started" || event.type === "founding.message" ||
      (event.type === "input.promoted" && inputs.acceptedSequences.has(envelope.seq)))) messages.push(event.message);
    if (inWindow && event.type === "founding.message" && event.message.role === "studio") turnCount++;
    if (event.type === "turn.completed") {
      // The log records when inclusion became known. The summary instead puts that direction
      // before the reply that used it, even when later turns have finished since.
      for (const correction of corrections.get(event.run.id) ?? []) {
        messages.push({ ...correction, replyMessageId: event.message.id });
      }
      if (inWindow) {
        messages.push(event.message);
        turnCount++;
        model = event.run.model ?? model;
      }
    }
  }
  const recentTurnsLength = messages.reduce((sum, message) => sum + message.text.length, 0);
  // A correction reconciled after its turn, or after that turn's summary, is folded in once
  // without moving the boundary past a later turn still running.
  if (signal?.aborted || (!lateInclusion && !shouldSummarise({ turnCount, recentTurnsLength }))) return false;

  const text = await cancellable(summarise({
    ...(signal ? { signal } : {}),
    ...(previous?.event.type === "summary.updated" ? { previousSummary: previous.event.text } : {}),
    messages,
    ...(model !== undefined ? { model } : {}),
  }), signal, null);
  if (signal?.aborted || text === null || text.trim() === "") return false;
  const summary = boundSummary({
    throughSeq,
    sourceMessageIds: messages.map((message) => message.id),
    text: text.trim(),
  });
  await store.append(
    { type: "summary.updated", ...summary, sourceMessageIds: [...summary.sourceMessageIds] },
    // The plain form whenever no correction is involved, so request ids match older summaries.
    { at: new Date().toISOString(), requestId: `conversation-summary:${throughSeq}${includedThroughSeq > 0 ? `:${includedThroughSeq}` : ""}` },
  );
  return true;
}

const SummaryResponseSchema = z.object({ summary: z.string().min(1).max(8_000) }).strict();
const SUMMARY_TIMEOUT_MS = 120_000;
/** On Arke's local harness: a model on the person's own card is slower and costs nothing to wait for. */
const LOCAL_SUMMARY_TIMEOUT_MS = 10 * 60_000;

/** A separate, tool-free harness turn whose answer can only become non-authoritative context. */
export function makeConversationSummariser(
  adapter: HarnessAdapter,
  sessionInput: SessionInput,
  scratchRoot: string,
): ConversationSummariser {
  return async (input) => {
    const scratch = join(scratchRoot, `summary-${newId("run")}`);
    await mkdir(toExtendedLength(scratch), { recursive: true });
    const abort = new AbortController();
    let sessionId: string | undefined;
    const stop = () => {
      abort.abort(input.signal?.reason);
      if (sessionId) void adapter.interrupt?.(sessionId).catch(() => {});
    };
    input.signal?.addEventListener("abort", stop, { once: true });
    if (input.signal?.aborted) stop();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // Configured and created inside the cleanup boundary: the configuration may be refused
      // (issue 1247), and a refused summary that left its directory behind would leave another
      // on every retry, since no checkpoint is written for it. Handed over still pending, so
      // the creation timeout bounds the wait on discovery too — a flight stuck ahead of that
      // timer would hold every later summary behind it.
      const create = (model?: string) => createPreparedSession(adapter, scratch, sessionInput({
        agent: "conversation-summarizer", ...(model !== undefined ? { model } : {}),
      }), { purpose: "world-chat", agent: "conversation-summarizer" }, undefined, abort.signal);
      /*
       * Its own model first — a Settings choice for the summariser, or the default — and the
       * conversation's model only when that is refused. With nothing chosen for it and only a
       * model that must be chosen by name installed, every summary was refused and the old one
       * silently kept, so a long thread stopped being condensed while the chat answered fine.
       */
      let session: Awaited<ReturnType<typeof create>>;
      try { session = await create(); }
      catch (error) {
        if (abort.signal.aborted || input.model === undefined) throw error;
        session = await create(input.model);
      }
      sessionId = session.sessionId;
      if (abort.signal.aborted) { stop(); return null; }
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
      .map((message) => `${message.role === "user" ? "User" : "Studio"} [${message.id}]${message.replyMessageId
        ? ` (direction included in Studio reply [${message.replyMessageId}])` : ""}: ${message.text}`)
      .join("\n\n");
      const prompt = `${prior}New conversation messages to incorporate:\n${transcript}`;
      const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("conversation summarisation timed out")), adapter.id === "arke" ? LOCAL_SUMMARY_TIMEOUT_MS : SUMMARY_TIMEOUT_MS);
      });
      await cancellable(Promise.race([
        Promise.all([
          adapter.dispatchAsync({ sessionId: session.sessionId, parts: [{ type: "text", text: prompt }] }),
          collected,
        ]),
        timeout,
      ]).then(() => undefined), abort.signal, undefined);
      if (abort.signal.aborted) return null;
      const parsed = SummaryResponseSchema.safeParse(extractJson(finalText));
      return parsed.success ? parsed.data.summary.trim() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", stop);
      abort.abort();
      await rm(toExtendedLength(scratch), { recursive: true, force: true }).catch(() => {});
    }
  };
}

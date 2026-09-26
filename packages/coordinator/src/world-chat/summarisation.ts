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

export interface ConversationSummaryRequest {
  readonly previousSummary?: string;
  readonly messages: readonly Pick<WorldChatMessage, "id" | "role" | "text">[];
  /** The model the conversation's latest answer ran on, for when the summariser has none of its own. */
  readonly model?: string;
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
  let turnCount = 0;
  let model: string | undefined;
  for (const envelope of events) {
    if (envelope.seq <= through || envelope.seq > throughSeq) continue;
    if (envelope.event.type === "turn.started") messages.push(envelope.event.message);
    if (envelope.event.type === "turn.completed") {
      messages.push(envelope.event.message);
      turnCount++;
      model = envelope.event.run.model ?? model;
    }
  }
  const recentTurnsLength = messages.reduce((sum, message) => sum + message.text.length, 0);
  if (!shouldSummarise({ turnCount, recentTurnsLength })) return false;

  const text = await summarise({
    ...(previous?.event.type === "summary.updated" ? { previousSummary: previous.event.text } : {}),
    messages,
    ...(model !== undefined ? { model } : {}),
  });
  if (text === null || text.trim() === "") return false;
  const summary = boundSummary({
    throughSeq,
    sourceMessageIds: messages.map((message) => message.id),
    text: text.trim(),
  });
  await store.append(
    { type: "summary.updated", ...summary, sourceMessageIds: [...summary.sourceMessageIds] },
    { at: new Date().toISOString(), requestId: `conversation-summary:${throughSeq}` },
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
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // Configured and created inside the cleanup boundary: the configuration may be refused
      // (issue 1247), and a refused summary that left its directory behind would leave another
      // on every retry, since no checkpoint is written for it. Handed over still pending, so
      // the creation timeout bounds the wait on discovery too — a flight stuck ahead of that
      // timer would hold every later summary behind it.
      const create = (model?: string) => createPreparedSession(adapter, scratch, sessionInput({
        agent: "conversation-summarizer", ...(model !== undefined ? { model } : {}),
      }), { purpose: "world-chat", agent: "conversation-summarizer" });
      /*
       * Its own model first — a Settings choice for the summariser, or the default — and the
       * conversation's model only when that is refused. With nothing chosen for it and only a
       * model that must be chosen by name installed, every summary was refused and the old one
       * silently kept, so a long thread stopped being condensed while the chat answered fine.
       */
      let session: Awaited<ReturnType<typeof create>>;
      try { session = await create(); }
      catch (error) {
        if (input.model === undefined) throw error;
        session = await create(input.model);
      }
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
      const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("conversation summarisation timed out")), adapter.id === "arke" ? LOCAL_SUMMARY_TIMEOUT_MS : SUMMARY_TIMEOUT_MS);
      });
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

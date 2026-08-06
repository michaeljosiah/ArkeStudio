import {
  newId,
  type CandidateChecks,
  type ConversationId,
  type HarnessAdapter,
  type MessageId,
  type ModelCandidateDraft,
  type RunId,
  type TurnId,
  type WorldChatCheckReceipt,
  type WorldChatMessage,
  type WorldChatLoaded,
  type WorldChatRun,
} from "@arke-studio/contracts";
import { assembleContext } from "./context.js";
import { deriveChecks, planFor } from "./check-plan.js";
import { correctiveMessage, validateTurnResult, type TurnProblem } from "./turn-result.js";
import type { EvidenceSources } from "./evidence.js";
import { foldConversation } from "./fold.js";
import { WorldChatStore } from "./store.js";

/**
 * One turn: a message goes out, a reply and its propositions come back (#70 §8).
 *
 * This is the piece that makes the conversation a conversation. Everything around it already
 * existed — the store, the lease, the parser, the check plan — and each was built to be run by
 * something. This is that something, and its whole job is ordering: what is written before the
 * model is asked, what is written only after the answer has been checked, and what happens when
 * an answer never comes.
 *
 * The ordering is not arbitrary. The user's message is durable *before* the model is asked,
 * because a message that was typed and sent is a fact regardless of what the model does with it —
 * losing it on a timeout would lose the user's own words. Everything the model produced is
 * durable only *after* it has been validated whole, because a reply that refers to propositions
 * which did not persist is worse than no reply.
 */

/** A turn that takes longer than this is not going to arrive (§19). */
export const DEFAULT_TURN_TIMEOUT_MS = 120_000;

export interface RunDeps {
  adapter: HarnessAdapter | null;
  /** Mint a lease and produce the scratch directory the session runs in. */
  prepare: (input: { conversationId: ConversationId; runId: RunId }) => Promise<{
    cwd: string;
    leaseToken: string;
  }>;
  /** Release the lease and clean the scratch, whatever the outcome. */
  release: (input: { conversationId: ConversationId; runId: RunId }) => Promise<void>;
  /** Receipts this run produced, in order. */
  receiptsFor: (runId: RunId) => readonly WorldChatCheckReceipt[];
  /** Run the coordinator's own check plan for one draft and return what it found. */
  runCheckPlan: (input: {
    draft: ModelCandidateDraft;
    leaseToken: string;
  }) => Promise<{ receipts: readonly WorldChatCheckReceipt[]; canonRevision: number }>;
  evidenceSources: (messages: readonly WorldChatMessage[]) => EvidenceSources;
  /**
   * The focused slice of accepted world state a run may see (§8.5).
   *
   * Only this section comes from outside: the rest of the context is the conversation's own
   * fold, which the runner already has. Optional because a conversation is still a conversation
   * without it.
   */
  worldContext?: (view: WorldChatLoaded) => string;
  now: () => string;
  timeoutMs?: number;
}

export type TurnOutcome =
  | { status: "completed"; reply: string }
  | { status: "failed"; reason: string; problems?: readonly TurnProblem[] }
  | { status: "cancelled" }
  | { status: "timeout" }
  | { status: "unavailable"; reason: string };

/**
 * Ask the model, once, and return whatever it finally said.
 *
 * The abort signal is the caller's: cancelling a turn has to stop the stream, not merely stop
 * waiting for it, or a cancelled run keeps consuming a model that nobody is listening to.
 */
async function askOnce(
  adapter: HarnessAdapter,
  sessionId: string,
  prompt: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  let finalText = "";
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  const events = adapter.streamEvents(abort.signal);
  const collected = (async () => {
    for await (const event of events) {
      if (!("sessionId" in event) || event.sessionId !== sessionId) continue;
      if (event.type === "message.completed") {
        finalText = event.text ?? "";
        return;
      }
      if (event.type === "session.error") throw new Error(event.message);
    }
  })();

  await adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: prompt }] });

  // Refed deliberately: an unref'd deadline never fires in a process with nothing else pending,
  // which is exactly the case a timeout is for.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  /**
   * Cancellation has to arrive as a rejection, not as an empty answer.
   *
   * Aborting the stream ends the iterator, so `collected` would otherwise resolve with no text —
   * and an empty answer is indistinguishable from a bad one, which means a cancelled turn would
   * spend its corrective retry asking a model nobody is waiting for.
   */
  const cancelled = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("cancelled"));
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });
  try {
    await Promise.race([collected, timeout, cancelled]);
  } finally {
    clearTimeout(deadline);
    abort.abort();
    signal.removeEventListener("abort", onAbort);
  }
  return finalText;
}

export class WorldChatRunner {
  private readonly cancelling = new Map<string, AbortController>();

  constructor(private readonly deps: RunDeps) {}

  /** Stop a run now. Local and immediate: the log says interrupted without waiting for a model. */
  cancel(conversationId: ConversationId): boolean {
    const controller = this.cancelling.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Send one message and take a turn.
   *
   * `store` is the conversation's own log. The sequence is: append the user's message and a
   * running run; ask; validate; append everything or nothing.
   */
  async send(
    store: WorldChatStore,
    conversationId: ConversationId,
    text: string,
    attachmentIds: readonly string[] = [],
  ): Promise<TurnOutcome> {
    const adapter = this.deps.adapter;
    if (!adapter || !adapter.readiness().ready) {
      return { status: "unavailable", reason: adapter?.readiness().reason ?? "the studio is not available" };
    }

    // Before the first await of any kind. `send` reads the log to number the run, and that read
    // is itself an await — registering after it left Cancel unable to find a run that had
    // already started.
    const controller = new AbortController();
    this.cancelling.set(conversationId, controller);

    const at = this.deps.now();
    const turnId = newId("turn") as TurnId;
    const runId = newId("run") as RunId;
    const message: WorldChatMessage = {
      id: newId("msg") as MessageId,
      turnId,
      role: "user",
      text,
      attachmentIds: [...attachmentIds] as WorldChatMessage["attachmentIds"],
      createdAt: at,
    };

    /**
     * Context comes from the conversation's own fold, not from the caller.
     *
     * The first version of this took a callback that only ever saw the new message, so every
     * turn arrived with no history: the Studio could not remember what was said two turns ago,
     * which makes a conversation into a series of unrelated questions. The fold is the record of
     * what has been said and understood, so it is what the model is given — bounded by §8.5, and
     * with retractions travelling as keys so a withdrawn idea is not put back in front of it.
     */
    const { events } = await store.read();
    const meta = await store.readMeta();
    const view = foldConversation(conversationId, meta?.createdAt ?? at, events).view;
    const assembled = assembleContext({
      ...(view.summary !== undefined ? { summary: view.summary } : {}),
      candidates: view.candidates,
      messages: view.messages,
      tombstones: tombstonesFrom(events),
      ...(this.deps.worldContext ? { worldContext: this.deps.worldContext(view) } : {}),
      currentUserMessage: text,
    });

    const run: WorldChatRun = {
      id: runId,
      turnId,
      basedOnConversationSeq: events.length,
      status: "running",
      adapter: adapter.id,
      harnessCleanup: "pending",
      contextDigest: assembled.digest,
      startedAt: at,
    };

    // The user's words are durable before the model is asked. Whatever happens next, they said it.
    await store.append({ type: "turn.started", message, run }, { at });
    if (controller.signal.aborted) {
      await this.finish(store, run, "interrupted", "cancelled before the studio was asked");
      this.cancelling.delete(conversationId);
      return { status: "cancelled" };
    }

    const { cwd, leaseToken } = await this.deps.prepare({ conversationId, runId });

    try {
      const session = await adapter.createSession({ purpose: "world-chat", cwd, agent: "world-builder" });
      const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

      const prompt = renderPrompt(assembled);
      let raw = await askOnce(adapter, session.sessionId, prompt, timeoutMs, controller.signal);

      let outcome = await this.applyResult(store, conversationId, raw, runId, leaseToken, at);
      if (!outcome.ok) {
        // The one corrective turn (§8.4). It names the faults and asks for the whole result
        // again — never a partial fix, which would come back as a partial result.
        // Recorded before the retry, so a crash between the two attempts leaves a log that says
        // one was made rather than one that looks like a single failed turn.
        await store.append(
          {
            type: "run.retry-started",
            run: { ...run, safeDetail: outcome.problems.map((p) => p.code).join(",").slice(0, 500) },
          },
          { at: this.deps.now() },
        );
        raw = await askOnce(
          adapter,
          session.sessionId,
          correctiveMessage(outcome.problems),
          timeoutMs,
          controller.signal,
        );
        outcome = await this.applyResult(store, conversationId, raw, runId, leaseToken, at);
      }

      if (!outcome.ok) {
        await this.finish(store, run, "failed", "the studio's answer could not be used");
        return { status: "failed", reason: "the answer could not be used", problems: outcome.problems };
      }
      return { status: "completed", reply: outcome.reply };
    } catch (err) {
      const cancelled = controller.signal.aborted;
      const timedOut = err instanceof Error && err.message === "timeout";
      const status = cancelled ? "interrupted" : timedOut ? "timeout" : "failed";
      await this.finish(store, run, status, safeDetail(err));
      if (cancelled) return { status: "cancelled" };
      if (timedOut) return { status: "timeout" };
      return { status: "failed", reason: safeDetail(err) };
    } finally {
      this.cancelling.delete(conversationId);
      await this.deps.release({ conversationId, runId });
    }
  }

  /**
   * Validate one answer and, if it holds, append the whole turn.
   *
   * The check plan runs here rather than inside validation because it is the coordinator's own
   * work: the model's searches are context, and these are what decide whether a proposition may
   * be called new (§8.3.1).
   */
  private async applyResult(
    store: WorldChatStore,
    conversationId: ConversationId,
    raw: string,
    runId: RunId,
    leaseToken: string,
    at: string,
  ): Promise<{ ok: true; reply: string } | { ok: false; problems: readonly TurnProblem[] }> {
    const { events } = await store.read();
    const meta = await store.readMeta();
    // The fold is what makes a correction land on the proposition it corrects. Validating
    // against an empty set would make every turn create new propositions and every retraction
    // fail to suppress anything — the conversation would accumulate contradictions instead of
    // being corrected by talking.
    const folded = foldConversation(conversationId, meta?.createdAt ?? at, events).view;
    const messages = folded.messages;
    const checksByDraft = new Map<ModelCandidateDraft, CandidateChecks>();

    const outcome = validateTurnResult({
      raw,
      conversationId,
      messages,
      existing: folded.candidates,
      groups: folded.groups,
      tombstones: tombstonesFrom(events),
      receiptsThisRun: this.deps.receiptsFor(runId),
      evidenceSources: this.deps.evidenceSources(messages),
      checksFor: (draft) => checksByDraft.get(draft) ?? emptyChecks(),
      now: this.deps.now,
    });

    if (!outcome.ok) return { ok: false, problems: outcome.problems };

    // Checks are run after the shape is known to be valid: there is no point searching the world
    // on behalf of a result that is about to be rejected for a bad quotation.
    for (const candidate of outcome.turn.candidates) {
      const draft = candidate as unknown as ModelCandidateDraft;
      const plan = planFor(draft);
      const { receipts, canonRevision } = await this.deps.runCheckPlan({ draft, leaseToken });
      checksByDraft.set(draft, deriveChecks({ draft, plan, receipts, canonRevision }));
    }

    const revalidated = outcome.turn.candidates.map((candidate) => ({
      ...candidate,
      checks: checksByDraft.get(candidate as unknown as ModelCandidateDraft) ?? candidate.checks,
    }));

    await store.append(
      {
        type: "turn.completed",
        message: {
          id: newId("msg") as MessageId,
          turnId: newId("turn") as TurnId,
          role: "studio",
          text: outcome.turn.reply,
          attachmentIds: [],
          createdAt: this.deps.now(),
        },
        run: { ...runFrom(events, runId), status: "completed", endedAt: this.deps.now() },
        receipts: [...this.deps.receiptsFor(runId)],
        candidates: revalidated,
        groups: outcome.turn.groups,
        tombstones: outcome.turn.tombstones,
      },
      { at },
    );
    return { ok: true, reply: outcome.turn.reply };
  }

  private async finish(
    store: WorldChatStore,
    run: WorldChatRun,
    status: WorldChatRun["status"],
    detail: string,
  ): Promise<void> {
    await store.append(
      {
        type: "run.finished",
        run: { ...run, status, endedAt: this.deps.now(), safeDetail: detail.slice(0, 500) },
      },
      { at: this.deps.now() },
    );
  }
}

function emptyChecks(): CandidateChecks {
  return {
    state: "partial",
    basedOnCanonRevision: 0,
    required: [],
    completed: [],
    consulted: [],
    likelyDuplicates: [],
    possibleAmendments: [],
    contradictionCandidates: [],
    explanation: "Not everything needed has been checked yet.",
  };
}

/** Every retraction so far, so a withdrawn idea is not re-detected (§6.4). */
function tombstonesFrom(
  events: ReadonlyArray<{ event: { type: string } }>,
): import("@arke-studio/contracts").CandidateTombstone[] {
  const tombstones: import("@arke-studio/contracts").CandidateTombstone[] = [];
  for (const { event } of events) {
    if (event.type === "turn.completed") {
      tombstones.push(...((event as unknown as { tombstones?: never[] }).tombstones ?? []));
    }
  }
  return tombstones;
}

function runFrom(events: ReadonlyArray<{ event: { type: string } }>, runId: RunId): WorldChatRun {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!.event as unknown as { run?: WorldChatRun };
    if (event.run?.id === runId) return event.run;
  }
  throw new Error("the run that is being completed is not in the log");
}

/**
 * Operator-safe failure text.
 *
 * Never the raw error: a harness error can carry a prompt, and a prompt carries the world. This
 * reaches the run record, which is read by whoever is diagnosing a failure rather than by the
 * person who was talking.
 */
function safeDetail(err: unknown): string {
  if (!(err instanceof Error)) return "the turn did not complete";
  if (err.message === "timeout") return "the studio took too long to answer";
  return "the studio could not complete this turn";
}

/** The context sections, in the order the agent brief expects them. */
function renderPrompt(assembled: ReturnType<typeof assembleContext>): string {
  const sections: string[] = [];
  if (assembled.summary) sections.push(`## The conversation so far\n${assembled.summary}`);
  if (assembled.registry) sections.push(`## What you have already understood\n${assembled.registry}`);
  if (assembled.tombstones) {
    sections.push(
      `## Withdrawn — do not propose these again\n${assembled.tombstones}`,
    );
  }
  if (assembled.worldContext) sections.push(`## From the world\n${assembled.worldContext}`);
  if (assembled.recentTurns) sections.push(`## Recent turns\n${assembled.recentTurns}`);
  sections.push(`## They just said\n${assembled.currentUserMessage}`);
  return sections.join("\n\n");
}

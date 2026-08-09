import {
  newId,
  type CandidateChecks,
  type ConversationId,
  type HarnessAdapter,
  type MessageId,
  type ModelCandidateDraft,
  type RunId,
  type TurnId,
  type ChatAttachmentId,
  type WorldChatAttachment,
  type WorldChatCheckReceipt,
  type WorldChatMessage,
  type WorldChatLoaded,
  type WorldChatRun,
} from "@arke-studio/contracts";
import { assembleContext, type ContextAttachment } from "./context.js";
import { THINKING_LABEL, workingLabel, WRITING_LABEL } from "./project.js";
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
  /**
   * Mint a lease and produce the scratch directory the session runs in.
   *
   * `attachmentIds` are the only attachments this run may read. Scoped per run rather than per
   * conversation: a document handed over in one turn should not become readable forever, and a
   * file attached to another conversation must never be reachable at all (§9.1, §13.2).
   */
  prepare: (input: {
    conversationId: ConversationId;
    runId: RunId;
    attachmentIds: readonly ChatAttachmentId[];
  }) => Promise<{ cwd: string; leaseToken: string }>;
  /** Release the lease and clean the scratch, whatever the outcome. */
  release: (input: { conversationId: ConversationId; runId: RunId }) => Promise<void>;
  /** Receipts this run produced, in order. */
  receiptsFor: (runId: RunId) => readonly WorldChatCheckReceipt[];
  /** Run the coordinator's own check plan for one draft and return what it found. */
  runCheckPlan: (input: {
    draft: ModelCandidateDraft;
    leaseToken: string;
  }) => Promise<{ receipts: readonly WorldChatCheckReceipt[]; canonRevision: number }>;
  /** The world half of evidence verification; the conversation half comes from the fold. */
  evidenceSources: (messages: readonly WorldChatMessage[]) => EvidenceSources;
  /**
   * The opening of a readable attachment, as the prompt inlines it, or null.
   *
   * Needed so an attachment quotation can be verified against the bytes it claims to come from.
   * Without it every such quotation fails, which is worse than not offering attachments at all:
   * the Studio would read a document through the tool and then be unable to cite it.
   */
  readAttachmentText?: (attachment: WorldChatAttachment) => Promise<string | null>;
  /**
   * The passages this run pulled through `get_attachment_text`, per attachment.
   *
   * The other half of what a quotation may be checked against. The prompt inlines only a
   * document's opening, while the tool will serve a passage from any offset — the run budget
   * caps how much text is read, not where it is read from — so a model may quite properly quote
   * something a megabyte in. Re-reading a prefix at verification time cannot reach it, and a
   * turn rejected for quoting what it correctly read is the failure this whole path keeps
   * producing. Absent, only the inlined opening is quotable.
   */
  attachmentReadsFor?: (runId: RunId) => ReadonlyMap<string, readonly string[]>;
  /**
   * The focused slice of accepted world state a run may see (§8.5).
   *
   * Only this section comes from outside: the rest of the context is the conversation's own
   * fold, which the runner already has. Optional because a conversation is still a conversation
   * without it.
   */
  worldContext?: (view: WorldChatLoaded) => string;
  /** What the conversation was opened about, worded for the model (#70 phase 6). */
  describeEntry?: (context: NonNullable<WorldChatLoaded["entryContext"]>) => string;
  /**
   * What the studio is doing, while it is doing it (§15.3).
   *
   * Transient and fire-and-forget: nothing durable depends on it, and a turn that produced no
   * progress at all is still a complete turn. Labels arrive already worded — the runner never
   * hands a tool summary outwards.
   */
  onProgress?: (conversationId: ConversationId, label: string) => void;
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
  onProgress?: (label: string) => void,
): Promise<string> {
  let finalText = "";
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  const events = adapter.streamEvents(abort.signal);
  const collected = (async () => {
    let writing = false;
    for await (const event of events) {
      if (!("sessionId" in event) || event.sessionId !== sessionId) continue;
      if (event.type === "message.completed") {
        finalText = event.text ?? "";
        return;
      }
      if (event.type === "tool.activity") {
        // The tool, never its summary: the summary names entities, and that is what receipts are
        // for (R-18). The verb is all a progress line is allowed to be.
        onProgress?.(workingLabel(event.tool));
        writing = false;
      } else if (event.type === "message.delta" && !writing) {
        // Said once per stretch of writing rather than per token: a label that changes on every
        // delta is a strobe, and it would say the same word each time anyway.
        writing = true;
        onProgress?.(WRITING_LABEL);
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

  /**
   * Whether a turn is in flight for this conversation, right now.
   *
   * The log cannot answer this. A run left `running` with no terminal event is what a live turn
   * and a crashed one both look like on disk, so the fold calls every such run interrupted — which
   * is right for a crash and wrong for the two minutes somebody is waiting for an answer. This
   * map is the only thing that knows the difference, because it holds the abort controller of a
   * turn that is actually happening.
   */
  isRunning(conversationId: ConversationId): boolean {
    return this.cancelling.has(conversationId);
  }

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
    return this.runTurn(store, conversationId, text, attachmentIds);
  }

  /**
   * Run a turn that already exists again, after it failed (§10.1.1).
   *
   * No second user message. They said it once, and a run that timed out is the app's failure,
   * not theirs -- making them retype it to recover would charge them for it. The original words
   * are read back out of the log and asked again under a fresh run on the same turn.
   */
  async retry(store: WorldChatStore, conversationId: ConversationId, turnId: TurnId): Promise<TurnOutcome> {
    const { events } = await store.read();
    const meta = await store.readMeta();
    const view = foldConversation(conversationId, meta?.createdAt ?? this.deps.now(), events).view;
    const original = view.messages.find((m) => m.turnId === turnId && m.role === "user");
    if (!original) return { status: "failed", reason: "that turn is not in this conversation" };
    if (view.messages.some((m) => m.turnId === turnId && m.role === "studio")) {
      // Already answered -- a second click, or a stale screen. Re-asking would duplicate a reply.
      return { status: "completed", reply: "" };
    }
    return this.runTurn(store, conversationId, original.text, original.attachmentIds, turnId);
  }

  /**
   * The turn itself. `existingTurnId` set means this is a retry: a new run against words already
   * in the log, recorded as `run.retry-started` rather than as a second `turn.started`.
   */
  private async runTurn(
    store: WorldChatStore,
    conversationId: ConversationId,
    text: string,
    attachmentIds: readonly string[] = [],
    existingTurnId?: TurnId,
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
    const turnId = existingTurnId ?? (newId("turn") as TurnId);
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
    // On a retry the words being asked again are already in the log under their original id, and
    // that id is the one evidence must cite — the fresh `message` above is never appended then.
    const original = existingTurnId
      ? view.messages.find((m) => m.turnId === existingTurnId && m.role === "user")
      : undefined;
    const currentMessage = original ?? message;
    // What was handed over goes into the prompt (§13.2). Without this the model is never told an
    // attachment exists, and answers "I can't see an attached document" — truthfully, from where
    // it is standing, which is the worst kind of wrong answer to debug.
    const handed = await this.readAttachments(view, attachmentIds);
    const assembled = assembleContext({
      ...(view.entryContext && this.deps.describeEntry
        ? { entryContext: this.deps.describeEntry(view.entryContext) }
        : {}),
      ...(view.summary !== undefined ? { summary: view.summary } : {}),
      candidates: view.candidates,
      groups: view.groups,
      // Without the filter a retry shows the message twice — once in the recent turns (it is in
      // the log by then) and once as what they just said — and a model that notices the
      // duplication spends its attention on it.
      messages: view.messages.filter((m) => m.id !== currentMessage.id),
      tombstones: tombstonesFrom(events),
      ...(this.deps.worldContext ? { worldContext: this.deps.worldContext(view) } : {}),
      attachments: contextAttachments(view, attachmentIds, handed.text),
      currentUserMessage: text,
      currentUserMessageId: currentMessage.id,
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
    // On a retry they already are, so only the new run is recorded.
    await store.append(
      existingTurnId ? { type: "run.retry-started", run } : { type: "turn.started", message, run },
      { at },
    );
    if (controller.signal.aborted) {
      await this.finish(store, run, "interrupted", "cancelled before the studio was asked");
      this.cancelling.delete(conversationId);
      return { status: "cancelled" };
    }

    const linked = attachmentIds as readonly ChatAttachmentId[];
    const { cwd, leaseToken } = await this.deps.prepare({
      conversationId,
      runId,
      attachmentIds: linked,
    });

    try {
      const session = await adapter.createSession({ purpose: "world-chat", cwd, agent: "world-builder" });
      const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

      const progress = this.deps.onProgress
        ? (label: string) => this.deps.onProgress?.(conversationId, label)
        : undefined;
      // Said before the model is even asked, so the screen has something the moment the message
      // lands rather than after the first tool call — which may be twenty seconds in.
      progress?.(THINKING_LABEL);

      const prompt = renderPrompt(assembled);
      let raw = await askOnce(adapter, session.sessionId, prompt, timeoutMs, controller.signal, progress);

      let outcome = await this.applyResult(store, conversationId, raw, runId, leaseToken, at, linked);
      if (!outcome.ok) {
        // The one corrective turn (§8.4). It names the faults and asks for the whole result
        // again — never a partial fix, which would come back as a partial result.
        // Recorded before the retry, so a crash between the two attempts leaves a log that says
        // one was made rather than one that looks like a single failed turn.
        await store.append(
          {
            type: "run.retry-started",
            run: { ...run, safeDetail: [...new Set(outcome.problems.map((p) => p.code))].join(",").slice(0, 500) },
          },
          { at: this.deps.now() },
        );
        progress?.("Working it through again");
        raw = await askOnce(
          adapter,
          session.sessionId,
          correctiveMessage(outcome.problems),
          timeoutMs,
          controller.signal,
          progress,
        );
        outcome = await this.applyResult(store, conversationId, raw, runId, leaseToken, at, linked);
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
   * The attachments this run may read, and their text.
   *
   * Only what the turn was given, and only what can honestly be read as text. An unreadable file
   * is still attachable and linkable — the chat simply cannot quote it, and saying so is better
   * than a quotation nobody can check (§13.2). Shared by the prompt and by evidence verification
   * so a quotation is checked against exactly the bytes the model was shown.
   */
  private async readAttachments(
    view: WorldChatLoaded,
    allowed: readonly string[],
  ): Promise<{ readable: WorldChatAttachment[]; text: Map<string, string> }> {
    const readable = view.attachments.filter(
      (a) => allowed.includes(a.id) && a.readability !== "not-readable",
    );
    const text = new Map<string, string>();
    if (this.deps.readAttachmentText) {
      for (const attachment of readable) {
        const body = await this.deps.readAttachmentText(attachment).catch(() => null);
        if (body !== null) text.set(attachment.id, body);
      }
    }
    return { readable, text };
  }

  /**
   * Everything this run may have quoted from: the openings it was shown, and the passages it
   * asked for. Kept as separate ranges so a quotation cannot be assembled across the join
   * between two passages that are not adjacent in the document.
   */
  private quotableAttachmentText(
    readable: readonly WorldChatAttachment[],
    inlined: ReadonlyMap<string, string>,
    runId: RunId,
  ): Map<string, readonly string[]> {
    const served = this.deps.attachmentReadsFor?.(runId) ?? new Map<string, readonly string[]>();
    const quotable = new Map<string, readonly string[]>();
    for (const attachment of readable) {
      const opening = inlined.get(attachment.id);
      const passages = [...(opening !== undefined ? [opening] : []), ...(served.get(attachment.id) ?? [])];
      if (passages.length > 0) quotable.set(attachment.id, passages);
    }
    return quotable;
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
    allowed: readonly ChatAttachmentId[],
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

    const { readable, text: inlined } = await this.readAttachments(folded, allowed);
    const attachmentText = this.quotableAttachmentText(readable, inlined, runId);

    const outcome = validateTurnResult({
      raw,
      conversationId,
      messages,
      existing: folded.candidates,
      groups: folded.groups,
      tombstones: tombstonesFrom(events),
      receiptsThisRun: this.deps.receiptsFor(runId),
      evidenceSources: {
        ...this.deps.evidenceSources(messages),
        attachments: readable,
        attachmentText,
      },
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

/**
 * The attachments this turn was handed, as the prompt needs them.
 *
 * Unreadable ones are included deliberately. The model must be able to say "you attached a PNG
 * and I cannot read it" — leaving it out entirely produces a flat denial that the file exists,
 * which is what somebody who just attached it will read as the feature being broken.
 */
function contextAttachments(
  view: WorldChatLoaded,
  allowed: readonly string[],
  text: ReadonlyMap<string, string>,
): ContextAttachment[] {
  return view.attachments
    .filter((a) => allowed.includes(a.id))
    .map((a) => {
      const body = text.get(a.id);
      return {
        // Attachment evidence cites both, so both have to be in front of the model (§13.2).
        id: a.id,
        contentHash: a.contentHash,
        fileName: a.fileName,
        kind: a.kind,
        readable: a.readability !== "not-readable",
        ...(body !== undefined ? { text: body } : {}),
      };
    });
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
  // First, because it frames everything after it.
  if (assembled.entryContext) sections.push(`## What this is about
${assembled.entryContext}`);
  if (assembled.summary) sections.push(`## The conversation so far\n${assembled.summary}`);
  if (assembled.registry) sections.push(`## What you have already understood\n${assembled.registry}`);
  if (assembled.tombstones) {
    sections.push(
      `## Withdrawn — do not propose these again\n${assembled.tombstones}`,
    );
  }
  if (assembled.worldContext) sections.push(`## From the world\n${assembled.worldContext}`);
  if (assembled.recentTurns) sections.push(`## Recent turns\n${assembled.recentTurns}`);
  // Last before what they just said, because that is usually the sentence about it — "can you
  // see the attached document" reads against the thing itself rather than across the world.
  if (assembled.attachments) {
    sections.push(`## What they handed you\n${assembled.attachments}`);
  }
  // The id on its own line, so the text below it is unambiguously what offsets index into.
  sections.push(`## They just said\n[${assembled.currentUserMessageId}]\n${assembled.currentUserMessage}`);
  return sections.join("\n\n");
}

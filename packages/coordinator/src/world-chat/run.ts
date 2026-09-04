import {
  newId,
  REFUSED_TOOLS_MAX,
  type BibleEdit,
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
import type { ModelEditorRequest, ModelSceneEdit, WorldChatContext, WorldChatSubject } from "@arke-studio/contracts";
import { mergeAttachmentRanges, type AttachmentRange } from "./attachments.js";
import { BibleEditError, BibleStaleError } from "../world/bible.js";
import { SceneEditRefused } from "../productions/scene-edits.js";
import { AUTH_FAILURE_REASON, isAuthShapedFailure } from "../harness/vendor-auth.js";
import { assembleContext, budgetFor, type ContextAttachment } from "./context.js";
import type { CurrentLook } from "./look.js";
import { THINKING_LABEL, workingLabel, WRITING_LABEL } from "./project.js";
import { deriveChecks, planFor } from "./check-plan.js";
import { correctiveMessage, validateTurnResult, type TurnProblem } from "./turn-result.js";
import type { EvidenceSources } from "./evidence.js";
import { foldConversation } from "./fold.js";
import { WorldChatStore } from "./store.js";
import type { PreparedWorldChatAction, WorldChatActionTurn } from "./actions.js";
import { refreshConversationSummary, type ConversationSummariser } from "./summarisation.js";

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

/**
 * How long before a turn is called hung rather than slow (§19).
 *
 * It catches a run that will never arrive; it is not there to police work that takes a while.
 * Two things make a generous figure the right one: a person can stop a turn themselves, from the
 * working line where they can see how long it has been going — so the clock is the backstop and
 * not the control — and a turn may now legitimately take far longer than it used to, because the
 * prompt it carries is bounded by the model's window rather than by a fixed character count.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 15 * 60_000;

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
  /** Atomically configure and create the harness session after preparation succeeds. */
  createSession?: (input: { cwd: string; runId: RunId }) => Promise<{ sessionId: string }>;
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
   * The passages this run pulled through `get_attachment_text`, per attachment, each with the
   * offset it came from.
   *
   * The other half of what a quotation may be checked against. The prompt inlines only a
   * document's opening, while the tool will serve a passage from any offset — the run budget
   * caps how much text is read, not where it is read from — so a model may quite properly quote
   * something a megabyte in. Re-reading a prefix at verification time cannot reach it, and a
   * turn rejected for quoting what it correctly read is the failure this whole path keeps
   * producing. Absent, only the inlined opening is quotable.
   */
  attachmentReadsFor?: (runId: RunId) => ReadonlyMap<string, readonly AttachmentRange[]>;
  /**
   * The focused slice of accepted world state a run may see (§8.5).
   *
   * Only this section comes from outside: the rest of the context is the conversation's own
   * fold, which the runner already has. Optional because a conversation is still a conversation
   * without it.
   */
  worldContext?: (view: WorldChatLoaded) => string;
  /**
   * The world look at the moment the prompt is assembled — its version and its words.
   *
   * Read here rather than after the answer arrives, because that is when the model was shown the
   * description. A look edited while the model was still writing would otherwise be recorded as
   * the one this draft was based on — and the staleness check that exists to catch exactly that
   * would pass, letting a whole-description draft overwrite the edit it never saw.
   *
   * One call returning both, rather than two: read separately, a change landing between them
   * would pin the number from before it and the words from after, which matches nothing that ever
   * existed and is stale against neither.
   */
  artDirectionLook?: () => CurrentLook;
  /**
   * The author's Bible as it stands right now (master §4.5).
   *
   * Read from disk per turn rather than taken off the cached bundle, for two reasons that both
   * bite: the author may have edited `bible.md` in a text editor since this conversation opened,
   * and the Studio itself may have edited it in an earlier turn of this very conversation. A
   * cached copy would show the model a bible that is one edit behind its own last edit, and the
   * version it returns is what the next write is checked against.
   */
  bible?: () => Promise<{ version: number; text: string }>;
  /** Validate this turn's Bible edits against the exact text/version shown, without writing. */
  validateBibleEdits?: (input: {
    edits: readonly BibleEdit[];
    baseVersion: number;
  }) => Promise<void>;
  /**
   * Validate this turn's editor requests against their live base, without staging them.
   *
   * The coordinator validates every command against the live base before a record exists and
   * only for the production the thread is about; a refusal here rejects the turn as a corrective
   * problem, the same way a bible edit that does not resolve does.
   */
  validateEditorRequests?: (input: {
    conversationId: ConversationId;
    entryContext: WorldChatContext | undefined;
    requests: readonly ModelEditorRequest[];
  }) => Promise<void>;
  /**
   * The version of the scene a scene thread is about, read when the prompt is built (SPEC-036
   * R-38) — the fence any rename this turn returns is checked against, for the same reason the
   * bible's version travels with its text. Null for a thread that is not about a scene.
   */
  sceneVersion?: (context: WorldChatContext | undefined) => number | null;
  /**
   * Validate this turn's scene edits and their version fence, without writing.
   */
  validateSceneEdits?: (input: {
    entryContext: WorldChatContext | undefined;
    edits: readonly ModelSceneEdit[];
    baseVersion: number | null;
  }) => Promise<void>;
  /** Build digest-bound intents before the assistant event is appended. This callback must be pure. */
  prepareActions?: (turn: WorldChatActionTurn) => readonly PreparedWorldChatAction[];
  /** Bind authority records only after the assistant event and all its intents are durable. */
  bindActions?: (actions: readonly PreparedWorldChatAction[]) => Promise<void>;
  /** Separate bounded model pass; its output is context only and failure leaves the prior summary. */
  summarise?: ConversationSummariser;
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
  /**
   * A turn that failed, in the operator's terms rather than the person's (§8.4).
   *
   * `safeDetail` collapses every error that is not a timeout into one sentence, which is right
   * for the screen and left the failure undiagnosable from anywhere: a comprehensive bible write
   * landed on disk and reported "that did not go through", with no record anywhere of what threw.
   * The safe sentence still goes to the person; this is the same event with the cause attached.
   */
  onTurnFailed?: (input: { conversationId: ConversationId; runId: RunId; cause: string }) => void;
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
  /** Every tool the confinement refused this turn, by harness name, as it happens (#506). */
  onRefused?: (tool: string) => void,
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
      if (event.type === "tool.refused") {
        /*
         * Nothing happened, so nothing is said about it while the turn runs.
         *
         * A refusal used to arrive as `tool.activity` and became a progress verb — the working
         * line saying "Looking through files" for a read the gate had just declined, which is
         * the studio appearing to do the one thing it refused. It is recorded instead, and shown
         * beside the reply, where it can contradict a claim to have done it (#506).
         */
        onRefused?.(event.tool);
      } else if (event.type === "tool.activity") {
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

  /**
   * Whether any conversation is mid-turn on this runner.
   *
   * Asked before a runner is replaced: one holding a live turn holds the only handle that can
   * stop it, so it outlives a stale store rather than taking an in-flight answer down with it.
   */
  hasRunning(): boolean {
    return this.cancelling.size > 0;
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
    subject?: WorldChatSubject,
  ): Promise<TurnOutcome> {
    return this.runTurn(store, conversationId, text, attachmentIds, undefined, subject);
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
    subject?: WorldChatSubject,
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
    /*
     * The look the model is about to be shown, pinned now.
     *
     * Sampled here rather than when the answer comes back: this is the description going into the
     * prompt, and a look edited while the model is still writing must not be recorded as the one
     * this draft was based on. Doing that would silently satisfy the staleness check whose entire
     * job is to catch a whole-description draft written against a look that has since moved.
     */
    const artDirectionLook = this.deps.artDirectionLook?.();
    /*
     * The bible the model is about to be shown, pinned now — same reasoning as the look above.
     *
     * The version travels with the text because it is what any edit this turn returns will be
     * checked against. Reading the text now and the version later would let an edit made in a
     * text editor between the two be silently overwritten by an answer that never saw it.
     */
    const bible = (await this.deps.bible?.()) ?? { version: 1, text: "" };
    // The scene the thread is about, pinned by version now for the same reason as the bible: a
    // rename this turn returns is checked against what the model was shown, not what is there
    // by the time it answers.
    const sceneBaseVersion = this.deps.sceneVersion?.(view.entryContext) ?? null;
    /*
     * What this prompt may spend, from the window of the model that will answer it.
     *
     * Asked of the adapter rather than assumed: Studio does not choose the model, so the only
     * honest budget is the one the harness can name. Absent — a fresh install with no session to
     * learn from — `budgetFor` returns the floor.
     */
    /**
     * The initiative mode's one sentence (SPEC-023 R-21): it changes how eagerly the studio
     * proposes, and nothing else — wrap-up, readiness, and the gate are identical in all three.
     */
    const INITIATIVE_NARRATION: Record<string, string> = {
      assist:
        " The creator has set this conversation to Assist: answer what is asked, and propose a candidate only when they ask for one or state a decision outright.",
      collaborate:
        " The creator has set this conversation to Collaborate: offer candidates as decisions settle, at the pace of the conversation.",
      develop:
        " The creator has set this conversation to Develop: drive the work forward — surface gaps, propose next candidates unprompted, and keep momentum. Proposing is still all this changes; nothing lands without their explicit acceptance.",
    };
    const assembled = assembleContext({
      budgetChars: budgetFor(adapter.knownInputTokenLimit?.() ?? undefined),
      ...(view.entryContext && this.deps.describeEntry
        ? {
            entryContext: `${this.deps.describeEntry(view.entryContext)}${INITIATIVE_NARRATION[view.initiative ?? "collaborate"]}${subjectNarration(subject)}`,
          }
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
      bible: bible.text,
      attachments: contextAttachments(view, attachmentIds, handed.text),
      currentUserMessage: text,
      currentUserMessageId: currentMessage.id,
    });

    const run: WorldChatRun = {
      id: runId,
      turnId,
      // A sequence number, not a count of records — the two agree only while the numbering is
      // unbroken, and this is written into the log beside real sequence numbers.
      basedOnConversationSeq: events.length > 0 ? events[events.length - 1]!.seq : 0,
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
    let prepared = false;
    try {
      const { cwd, leaseToken } = await this.deps.prepare({
        conversationId,
        runId,
        attachmentIds: linked,
      });
      prepared = true;
      const session = this.deps.createSession
        ? await this.deps.createSession({ cwd, runId })
        : await adapter.createSession({ purpose: "world-chat", cwd, agent: "world-builder" });
      const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

      const progress = this.deps.onProgress
        ? (label: string) => this.deps.onProgress?.(conversationId, label)
        : undefined;
      // Said before the model is even asked, so the screen has something the moment the message
      // lands rather than after the first tool call — which may be twenty seconds in.
      progress?.(THINKING_LABEL);

      /*
       * Refusals accumulate across BOTH attempts of a turn, deduplicated by tool.
       *
       * Across both because the corrective attempt is the same turn from the person's side —
       * they see one reply — and an agent refused a shell on the first attempt is exactly the one
       * likely to try again on the second. Deduplicated because seven `Bash` calls are one thing
       * that was refused, not seven (#506).
       */
      const refusedTools = new Set<string>();
      const refused = (tool: string) => refusedTools.add(tool);

      const prompt = renderPrompt(assembled);
      let raw = await askOnce(adapter, session.sessionId, prompt, timeoutMs, controller.signal, progress, refused);

      let outcome = await this.applyResult(
        store,
        conversationId,
        raw,
        runId,
        leaseToken,
        at,
        linked,
        artDirectionLook,
        bible.version,
        sceneBaseVersion,
        refusedTools,
      );
      if (!outcome.ok) {
        // The one corrective turn (§8.4). It names the faults and asks for the whole result
        // again — never a partial fix, which would come back as a partial result.
        // Recorded before the retry, so a crash between the two attempts leaves a log that says
        // one was made rather than one that looks like a single failed turn.
        await store.append(
          {
            type: "run.retry-started",
            // The retry record carries what was wrong, for the same reason: a retry that says only
          // "schema" cannot be read afterwards, and this is the copy that survives on disk.
          run: {
            ...run,
            safeDetail: [...new Set(outcome.problems.map((p) => p.safeMessage || p.code))].join(" · ").slice(0, 500),
          },
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
          refused,
        );
        outcome = await this.applyResult(
          store,
          conversationId,
          raw,
          runId,
          leaseToken,
          at,
          linked,
          artDirectionLook,
          bible.version,
          sceneBaseVersion,
          refusedTools,
        );
      }

      if (!outcome.ok) {
        /*
         * The problems are already worded for a person and are the whole reason this failed;
         * reporting only that it did is what made the same class of failure unreadable before.
         *
         * That is what this line said while mapping `.code`, so every schema rejection reached
         * the log as the word "schema" and nothing else — which is exactly as unreadable as the
         * version it replaced. Found on 2026-08-21 driving a production thread that failed twice
         * with no way to learn what about the answer was wrong. The message is the payload.
         */
        this.deps.onTurnFailed?.({
          conversationId,
          runId,
          cause: `answer rejected: ${outcome.problems.map((p) => p.safeMessage || p.code).join(" · ")}`,
        });
        /*
         * The same words the log gets, because the person is the one who has to do
         * something about it. "The answer could not be used" tells them a turn failed and
         * leaves them pressing retry against a rejection that will repeat.
         */
        await this.finish(
          store,
          run,
          "failed",
          `rejected: ${outcome.problems.map((p) => p.safeMessage || p.code).join(" · ")}`,
        );
        return { status: "failed", reason: "the answer could not be used", problems: outcome.problems };
      }
      return { status: "completed", reply: outcome.reply };
    } catch (err) {
      const cancelled = controller.signal.aborted;
      const timedOut = err instanceof Error && err.message === "timeout";
      const status = cancelled ? "interrupted" : timedOut ? "timeout" : "failed";
      if (status === "failed") {
        // The raw error, once, where an operator can read it. It never leaves this process and it
        // never reaches the screen — `safeDetail` still decides what the person is told.
        this.deps.onTurnFailed?.({
          conversationId,
          runId,
          cause: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }
      await this.finish(store, run, status, safeDetail(err));
      if (cancelled) return { status: "cancelled" };
      if (timedOut) return { status: "timeout" };
      return { status: "failed", reason: safeDetail(err) };
    } finally {
      this.cancelling.delete(conversationId);
      // `prepare` may fail after minting a lease; release is idempotent and owns partial cleanup.
      await this.deps.release({ conversationId, runId }).catch((error) => {
        if (prepared) throw error;
      });
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
   * Everything this run may have quoted from: the opening it was shown, and the passages it
   * asked for, folded back into whatever was actually contiguous.
   *
   * The opening is a range at offset 0, which is what lets a quotation run from the inlined text
   * into the first paged read — the model saw those as one continuous stretch, because they are
   * one. Passages with a gap between them stay apart, so a quote cannot be assembled across text
   * that was never read.
   */
  private quotableAttachmentText(
    readable: readonly WorldChatAttachment[],
    inlined: ReadonlyMap<string, string>,
    runId: RunId,
  ): Map<string, readonly string[]> {
    const served = this.deps.attachmentReadsFor?.(runId) ?? new Map<string, readonly AttachmentRange[]>();
    const quotable = new Map<string, readonly string[]>();
    for (const attachment of readable) {
      const opening = inlined.get(attachment.id);
      const ranges: AttachmentRange[] = [
        ...(opening !== undefined ? [{ offset: 0, text: opening }] : []),
        ...(served.get(attachment.id) ?? []),
      ];
      const passages = mergeAttachmentRanges(ranges);
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
    /** The look the prompt was assembled against — see RunDeps.artDirectionLook. */
    artDirectionLook: CurrentLook | undefined,
    /** The bible version the prompt was assembled against — see RunDeps.bible. */
    bibleBaseVersion: number,
    /** The scene version the prompt was assembled against, for a scene thread — see RunDeps.sceneVersion. */
    sceneBaseVersion: number | null,
    /** Tools the confinement refused while this turn ran, deduplicated by the caller (#506). */
    refusedTools: ReadonlySet<string> = new Set(),
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
      checksByDraft.set(
        draft,
        deriveChecks({
          draft,
          plan,
          receipts,
          canonRevision,
          ...(artDirectionLook !== undefined ? { artDirectionLook } : {}),
        }),
      );
    }

    const revalidated = outcome.turn.candidates.map((candidate) => ({
      ...candidate,
      checks: {
        ...(checksByDraft.get(candidate as unknown as ModelCandidateDraft) ?? candidate.checks),
        ...(candidate.checks.targetReads !== undefined ? { targetReads: candidate.checks.targetReads } : {}),
      },
    }));

    /*
     * Editor requests are validated before anything durable happens and written after
     * everything else has (SPEC-039 R-27; round eight): the dry run refuses a request that
     * could not land while the bible is still untouched, so a rejected turn leaves neither a
     * card nor an orphaned bible edit, and the corrective retry starts from the base it was
     * shown. The write below follows the bible's; what remains after it is the append.
     */
    const requests = outcome.turn.editorRequests;
    if (requests.length > 0) {
      if (!this.deps.validateEditorRequests || !this.deps.prepareActions || !this.deps.bindActions) {
        return {
          ok: false,
          problems: [
            {
              code: "editor-request-unavailable",
              safeMessage: "Editor requests cannot be made in this conversation. Answer without one.",
            },
          ],
        };
      }
      try {
        await this.deps.validateEditorRequests({ conversationId, entryContext: folded.entryContext, requests });
      } catch (err) {
        return {
          ok: false,
          problems: [
            {
              code: "editor-request",
              safeMessage: `The editor request was refused: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
            },
          ],
        };
      }
    }

    /*
     * The bible is written before the turn is recorded, and a failure here rejects the turn
     * whole (master §4.5, §8.3's all-or-nothing rule).
     *
     * Both orderings lose something and this one loses less. Recording the turn first would let
     * a reply saying "I've added that to your bible" persist beside a bible that never changed —
     * the same confident account of work that does not exist that this file's opening comment
     * refuses for propositions. Writing first risks the opposite: a crash in the window between
     * the commit and the append leaves the edit on disk with no conversation record of it. That
     * one is recoverable and visible — the text is in the bible, the version is in
     * `changes.jsonl`, and the history snapshot is there to restore from — where a reply about
     * an edit that never happened is neither.
     */
    /*
     * A rename is checked before anything durable lands and written after everything else has
     * (codex, PR 716). The fence is read now, so a scene that moved — or a thread that is not
     * about one — refuses while the bible is still untouched. The write itself waits until the
     * bible and the editor requests are in: a rename landed ahead of a bible edit that then
     * refused would leave the scene renamed under a failed turn, and the corrective retry,
     * still fenced to the version the prompt showed, would refuse its own repeat as stale.
     */
    const sceneEdits = outcome.turn.sceneEdits;
    if (sceneEdits.length > 0) {
      if (!this.deps.validateSceneEdits || !this.deps.prepareActions || !this.deps.bindActions) {
        return {
          ok: false,
          problems: [
            {
              code: "scene-edit-unavailable",
              safeMessage: "The scene cannot be renamed in this conversation. Answer without renaming it.",
            },
          ],
        };
      }
      try {
        await this.deps.validateSceneEdits({
          entryContext: folded.entryContext,
          edits: sceneEdits,
          baseVersion: sceneBaseVersion,
        });
      } catch (err) {
        return { ok: false, problems: [{ code: "scene-edit", safeMessage: sceneEditProblem(err) }] };
      }
    }

    if (outcome.turn.bibleEdits.length > 0) {
      if (!this.deps.validateBibleEdits || !this.deps.prepareActions || !this.deps.bindActions) {
        return {
          ok: false,
          problems: [
            {
              code: "bible-unavailable",
              safeMessage: "The bible cannot be edited in this conversation. Answer without editing it.",
            },
          ],
        };
      }
      try {
        await this.deps.validateBibleEdits({
          edits: outcome.turn.bibleEdits,
          baseVersion: bibleBaseVersion,
        });
      } catch (err) {
        // Named precisely, because the corrective turn can act on it: a heading that does not
        // resolve is fixable by the model, and a bible that moved underneath it is not.
        return { ok: false, problems: [{ code: "bible-edit", safeMessage: bibleProblem(err) }] };
      }
    }

    if (outcome.turn.actions.length > 0 && (!this.deps.prepareActions || !this.deps.bindActions)) {
      return {
        ok: false,
        problems: [{ code: "action-unavailable", safeMessage: "World changes are unavailable in this conversation. Answer without changing the world." }],
      };
    }

    const completedRun = runFrom(events, runId);
    let actions: readonly PreparedWorldChatAction[] = [];
    try {
      actions = this.deps.prepareActions?.({
        conversationId,
        turnId: completedRun.turnId,
        entryContext: folded.entryContext,
        existingCandidates: folded.candidates,
        existingGroups: folded.groups,
        candidates: revalidated,
        groups: outcome.turn.groups,
        bibleEdits: outcome.turn.bibleEdits,
        bibleBaseVersion,
        sceneEdits,
        sceneBaseVersion,
        editorRequests: requests,
        actions: outcome.turn.actions,
        receipts: this.deps.receiptsFor(runId),
        at,
      }) ?? [];
    } catch {
      return {
        ok: false,
        problems: [{ code: "action-preparation", safeMessage: "The requested change could not be prepared safely. Answer without it." }],
      };
    }
    await store.append(
      {
        type: "turn.completed",
        message: {
          id: newId("msg") as MessageId,
          turnId: completedRun.turnId,
          role: "studio",
          text: outcome.turn.reply,
          attachmentIds: [],
          createdAt: this.deps.now(),
        },
        run: { ...completedRun, status: "completed", endedAt: this.deps.now() },
        receipts: [...this.deps.receiptsFor(runId)],
        // Written only when there were refusals, and capped at the schema's bound rather than
        // left to reject the whole turn: an answer that survived validation must not be lost
        // because the agent reached for one tool too many.
        ...(refusedTools.size > 0 ? { refusedTools: [...refusedTools].slice(0, REFUSED_TOOLS_MAX) } : {}),
        candidates: revalidated,
        groups: outcome.turn.groups,
        tombstones: outcome.turn.tombstones,
        ...(actions.length > 0 ? { actionPrepareIntents: actions.map((action) => action.intent) } : {}),
      },
      { at },
    );
    if (actions.length > 0) await this.deps.bindActions?.(actions);
    if (this.deps.summarise) {
      void refreshConversationSummary(store, this.deps.summarise).catch(() => {});
    }
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
        ...(a.readability === "extracted-text-available" ? { extracted: true } : {}),
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
  // The one cause worth naming (SPEC-030 R-13): a vendor token the harness could not refresh
  // is the person's to fix, and "could not complete" sends them everywhere but Settings. The
  // stated reason carries no world content, so the operator-safety contract holds.
  if (isAuthShapedFailure(err.message)) return AUTH_FAILURE_REASON;
  return "the studio could not complete this turn";
}

/**
 * Why a bible edit failed, in words the one corrective turn can use (§8.4).
 *
 * `BibleEditError` is the model's to fix — it named a heading the document does not have, and
 * the retry can use `set-section` instead. `BibleStaleError` is not: the author edited the file
 * while the model was writing, and the only honest thing to do is answer without touching it.
 * Neither message carries world content, per TurnProblem's contract.
 */
/**
 * Why a rename failed, in words the corrective turn can use — and only those (codex, PR 716).
 * A refusal is worded for the model already; anything else — a file that vanished, a parse
 * error — carries a path or a stack, which is not the model's to see.
 */
function sceneEditProblem(err: unknown): string {
  if (err instanceof SceneEditRefused) return err.reason.slice(0, 300);
  return "The scene could not be renamed. Answer without renaming it this turn.";
}

function bibleProblem(err: unknown): string {
  if (err instanceof BibleEditError) {
    return `The bible has no section headed "${err.heading.slice(0, 120)}". Use set-section to add one, or name a heading that is there.`;
  }
  if (err instanceof BibleStaleError) {
    return "The bible changed while you were answering, so it was left alone. Answer without editing it this turn.";
  }
  return "The bible could not be edited. Answer without editing it this turn.";
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
  // Before the world's own record, because it is the frame that record sits inside: what the
  // author thinks this world is, in their words, ahead of what the world has so far decided.
  if (assembled.bible) sections.push(`## The author's bible\n${assembled.bible}`);
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

/** What the person has selected while they talk (SPEC-039 R-26), worded for the model. */
function subjectNarration(subject: WorldChatSubject | undefined): string {
  if (subject === undefined) return "";
  const named = subject.kind === "timeline-clip" ? `clip ${subject.clipId}` : `track ${subject.trackId}`;
  return ` They have ${named} selected on the timeline; that is what "this" and "the selected clip" mean.`;
}

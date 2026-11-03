import { newId, unresolvedWorldChatInputs, worldChatInputRouting,
  type ConversationId, type WorldChatInputRequest, type WorldChatInputRouting, type WorldChatLoaded,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { WorldChatRunner, TurnOutcome } from "../world-chat/run.js";
import { WorldChatInputError, WorldChatInputJournal, inputCommandDigest } from "../world-chat/input-journal.js";
import { WorldChatService } from "../world-chat/service.js";
import { foldWorldChatInputs } from "../world-chat/input-fold.js";
import { worldChatContextExists, worldChatSubjectExists } from "../world-chat/context-validation.js";
import { readBenchSession } from "../bench/chat-reads.js";
import type { StartedConversationTurn } from "./conversation-authoring.js";

interface Dependencies {
  runner(id: ConversationId): Pick<WorldChatRunner, "sendQueued" | "isRunning" | "cancel">;
  routing(view: WorldChatLoaded, request: Pick<WorldChatInputRequest, "modelId" | "variant">): WorldChatInputRouting;
  changed(id: ConversationId): Promise<void>;
}

/** One owner per open WorldStore. The log owns words; this serializes decisions, never model waits. */
export class ConversationInputs {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly active = new Map<string, Promise<TurnOutcome>>();
  private readonly failedStops = new Set<string>();
  constructor(private readonly store: WorldStore, private readonly deps: Dependencies) {}

  private exclusive<T>(id: ConversationId, work: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (this.store.closingSignal.aborted) throw new WorldChatInputError("unavailable", "This world closed.");
      return work();
    });
    this.tails.set(id, result);
    void result.finally(() => { if (this.tails.get(id) === result) this.tails.delete(id); }).catch(() => {});
    return result;
  }
  private journal(id: ConversationId) { return new WorldChatInputJournal(this.store, id); }
  private busy(id: ConversationId) { return this.active.has(id) || this.deps.runner(id).isRunning(id); }

  /** Ordinary Send and Retry share the queue's admission gate, so neither can overtake it. */
  start(id: ConversationId, work: () => Promise<StartedConversationTurn | null>, retry = false): Promise<StartedConversationTurn | null> {
    return this.exclusive(id, async () => {
      if (this.busy(id) || this.failedStops.has(id)) return null;
      const journal = this.journal(id), queue = await journal.read();
      if (!retry && unresolvedWorldChatInputs(queue).length) return null;
      // A fresh primary Send with no waiting words can clear an old empty Stop. It never resumes
      // submitted input: those require Continue, including when the author presses Retry.
      if (!retry && queue.pauseReason && !unresolvedWorldChatInputs(queue).length) {
        const view = await new WorldChatService(this.store.dir).load(id);
        if (view) await journal.continue(queue.revision, this.deps.routing(view, {}), newId("wce"));
      }
      const started = await work();
      if (started) started.completion = this.observe(id, started.completion);
      return started;
    });
  }

  async record(id: ConversationId, request: WorldChatInputRequest) {
    return this.exclusive(id, async () => {
      if (request.delivery !== "next") throw new WorldChatInputError("unavailable", "Only Send next is available.");
      const journal = this.journal(id), view = await this.validView(id, request);
      const { events } = await journal.log.read();
      const running = foldWorldChatInputs(events).running;
      if (request.expectedRunId && !running.has(request.expectedRunId) &&
        !events.some(({ event }) => (event.type === "turn.completed" || event.type === "run.finished") && event.run.id === request.expectedRunId)) {
        throw new WorldChatInputError("stale", "That reply changed. Look again before sending.");
      }
      const receipt = await journal.record(request, { routing: this.deps.routing(view, request),
        constraints: { ...(request.subject ? { subject: request.subject } : {}), replyOnly: request.replyOnly === true } });
      // A completion can beat an input over the wire. A failed/stopped reply still leaves it paused.
      if (!this.busy(id) && receipt.queue.pauseReason === null) {
        const terminal = events.findLast(({ event }) => event.type === "turn.completed" || event.type === "run.finished")?.event;
        if (terminal && (terminal.type === "turn.completed" || terminal.type === "run.finished") && terminal.run.status !== "completed") {
          await journal.pause(terminal.run.status === "cancelled" ? "stopped" : "failed", newId("wce"));
        }
      }
      await this.advance(id);
      return receipt;
    });
  }

  async remove(id: ConversationId, messageId: string, revision: number, requestId: string) {
    return this.exclusive(id, () => this.journal(id).remove(messageId, revision, requestId));
  }

  async receipt(id: ConversationId, submissionId: string) {
    return this.exclusive(id, async () => {
      const journal = this.journal(id), queue = await journal.read();
      const original = queue.inputs.find(row => row.input.request.submissionId === submissionId)?.input;
      // A readable event after a failed fsync is not yet a receipt. Replaying admission flushes it.
      if (original) await journal.record(original.request, { routing: original.routing, constraints: original.constraints });
      return journal.read();
    });
  }

  async resume(id: ConversationId, revision: number, routing: WorldChatInputRouting, requestId: string) {
    return this.exclusive(id, async () => {
      if (this.busy(id)) throw new WorldChatInputError("unavailable", "Wait for the active reply to settle before continuing.");
      const journal = this.journal(id), queue = await journal.read(), first = unresolvedWorldChatInputs(queue)[0];
      if (!first) throw new WorldChatInputError("stale", "There are no queued messages to continue.");
      const view = await this.validView(id, first.input.request);
      const current = this.deps.routing(view, first.input.request);
      if (inputCommandDigest(current) !== inputCommandDigest(routing)) throw new WorldChatInputError("stale", "The writing destination changed. Look again before continuing.");
      await journal.continue(revision, current, requestId);
      this.failedStops.delete(id);
      await this.advance(id);
    });
  }

  async stop(id: ConversationId): Promise<void> {
    await this.exclusive(id, async () => {
      const journal = this.journal(id);
      // Persist the pause even when empty: an input already crossing the wire must stay stopped.
      this.failedStops.add(id);
      try {
        const view = await new WorldChatService(this.store.dir).load(id);
        if (view?.entryContext?.kind !== "production-setup") await journal.pause("stopped", newId("wce"));
        this.failedStops.delete(id);
      } finally {
        // Even a failed disk flush must stop native work. The in-memory fence prevents advancing
        // under that uncertain pause until a subsequent Stop or explicit Continue is durable.
        this.deps.runner(id).cancel(id);
      }
    });
  }

  private async validView(id: ConversationId, request: WorldChatInputRequest): Promise<WorldChatLoaded> {
    const view = await new WorldChatService(this.store.dir).load(id), entry = view?.entryContext ?? { kind: "world" as const };
    const exists = entry.kind === "attachment" ? view?.attachments.some(a => a.id === entry.attachmentId) :
      entry.kind === "bench" ? readBenchSession(this.store.dir, entry.sessionId) !== null : worldChatContextExists(this.store.getBundle(), entry);
    const subject = request.subject;
    const subjectExists = !subject || (entry.kind === "bench" ? subject.kind === "take" && readBenchSession(this.store.dir, entry.sessionId)?.takes.some(t => t.id === subject.takeId) : worldChatSubjectExists(this.store.getBundle(), entry, subject));
    if (!view || !exists || !subjectExists) throw new WorldChatInputError("unavailable", "The conversation or selected subject is no longer available.");
    return view;
  }

  private observe(id: ConversationId, completion: Promise<TurnOutcome>): Promise<TurnOutcome> {
    const observed = completion.catch((): TurnOutcome => ({ status: "failed", reason: "The reply could not finish." })).then(async outcome => {
      if (this.store.closingSignal.aborted) return outcome;
      await this.exclusive(id, async () => {
        this.active.delete(id);
        const journal = this.journal(id), queue = await journal.read();
        if (this.failedStops.has(id) || outcome.status !== "completed" && unresolvedWorldChatInputs(queue).length) {
          await journal.pause(this.failedStops.has(id) || outcome.status === "cancelled" ? "stopped" : outcome.status === "completed" ? "stopped" : outcome.status, newId("wce"));
          this.failedStops.delete(id);
        }
        await this.advance(id);
      });
      await this.deps.changed(id);
      return outcome;
    });
    this.active.set(id, observed);
    // The normal command awaits its turn; subsequent queued turns are owned here until settled.
    void observed.catch(() => {});
    return observed;
  }

  /** Called only inside the admission gate. sendQueued reserves the runner before its first await. */
  private async advance(id: ConversationId): Promise<void> {
    if (this.busy(id) || this.failedStops.has(id) || this.store.closingSignal.aborted) return;
    const journal = this.journal(id), queue = await journal.read(), first = unresolvedWorldChatInputs(queue)[0];
    if (queue.pauseReason || !first) return;
    const request = first.input.request;
    let view: WorldChatLoaded;
    try { view = await this.validView(id, request); }
    catch { await journal.pause("unavailable", newId("wce")); return; }
    const routing = this.deps.routing(view, request);
    if (inputCommandDigest(routing) !== inputCommandDigest(worldChatInputRouting(queue, first))) {
      await journal.pause("routing-changed", newId("wce")); return;
    }
    const completion = this.deps.runner(id).sendQueued(journal, first.input.messageId, queue.revision, routing,
      () => { void this.deps.changed(id).catch(() => {}); }, async () => {
        const current = this.deps.routing(await this.validView(id, request), request);
        if (inputCommandDigest(current) !== inputCommandDigest(routing)) throw new WorldChatInputError("stale", "The writing destination changed before this reply started.");
      });
    this.observe(id, completion);
  }
}

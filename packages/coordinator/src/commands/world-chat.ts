import { createHash } from "node:crypto";
import { type ClientState, type ConversationId, modelForCapability, type ModelManifest, projectWorldChatInputQueue, type RippleItem, type SessionId, worldChatContextSchemaVersion } from "@arke-studio/contracts";
import type { AppSettingsFile } from "../app-settings.js";
import { type ConversationActionService, ConversationTakeReviewRefusal } from "../application/conversation-actions.js";
import type { ConversationAuthoringService } from "../application/conversation-authoring.js";
import type { ConversationInputs } from "../application/conversation-inputs.js";
import { fileArtifact } from "../artifacts/filing.js";
import { readBenchSession } from "../bench/chat-reads.js";
import { serialiseSceneConversation } from "../bench/outcome.js";
import { openBenchSession } from "../bench/service.js";
import { acceptDecided, explainAcceptRefusal, landed, type ProposalManager } from "../gate/proposals.js";
import type { MediaProbe } from "../media/probe.js";
import type { ImportFileStorage } from "../storage/import-files.js";
import { CHAT_ATTACHMENT_EXTENSIONS, WorldChatAttachmentStore } from "../world-chat/attachments.js";
import { worldChatContextExists } from "../world-chat/context-validation.js";
import { discoverConversations } from "../world-chat/discover.js";
import { WorldChatInputError, WorldChatInputJournal } from "../world-chat/input-journal.js";
import { blockingDependencies, explainBlocked, routeFor as mediaRouteFor } from "../world-chat/media.js";
import { recordResolution, sendBack } from "../world-chat/resolution.js";
import { ConversationInUseError, WorldChatService } from "../world-chat/service.js";
import { conversationDir, WorldChatStore } from "../world-chat/store.js";
import { refusalDetail, rejectPoint, returnToRail, savePoint, wrapUp, WrapUpError } from "../world-chat/wrapup.js";
import type { WorldStore } from "../world/store.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/** Stable per candidate revision, so a retried handoff reopens instead of creating duplicates. */
function mediaSessionId(candidateId: string, revision: number): SessionId {
  const body = createHash("sha256")
    .update(`${candidateId}:${revision}`)
    .digest("hex")
    .slice(0, 26)
    .toUpperCase();
  return `sess_${body}` as SessionId;
}

/**
 * World Chat: opening and closing a conversation, its queued input and sends, retrying a turn,
 * saving, dropping and wrapping up its points, opening a media brief on the Bench, sending a
 * proposal back to a conversation, creating, deleting, archiving and attaching, and deciding the
 * actions a conversation proposes. A command that answers with its own event — an input or send
 * result, a created conversation, an upload, a prepared review, a decided action — checks the
 * world itself, because the page waits on that answer by its request. So do closing the chat,
 * which a screen sends as it unmounts and may name the world just left, and the commands that
 * first wait for a world's open to settle. The rest act on the open world only.
 */
export function worldChatCommands(ctx: CommandContext, deps: {
  gate: () => ProposalManager | null | undefined;
  manifest: ModelManifest | undefined;
  mediaProbe: MediaProbe | undefined;
  pickFiles: ((input: { accept: readonly string[] }) => Promise<readonly string[]>) | undefined;
  importFileSpace: ImportFileStorage | undefined;
  appSettings: () => AppSettingsFile | null;
  log(entry: Record<string, unknown>): void;
  /** Sends by request for the world's session, so the same request again is the same line. */
  worldChatSends: Map<string, "pending" | { turnId: string }>;
  /** Creates by request, so the same request again is the same conversation. */
  worldChatCreates: Map<string, Promise<{ id: ConversationId } | null>>;
  worldChat: () => ClientState["worldChat"];
  setWorldChat(worldChat: null): void;
  broadcastSnapshot(): void;
  /** The session the Bench is opening, shared with the Bench's own openers. */
  benchOpening(): { worldId: string; sessionId: SessionId | undefined } | null;
  setBenchOpening(opening: { worldId: string; sessionId: SessionId | undefined }): void;
  stillOpen(store: WorldStore): boolean;
  worldOpensSettled(): Promise<void>;
  openWorldChat(store: WorldStore, conversationId: ConversationId): Promise<void>;
  refreshConversations(store: WorldStore): Promise<void>;
  refreshConversationOutcome(store: WorldStore, conversationId: ConversationId): Promise<void>;
  conversationAuthoring(store: WorldStore): ConversationAuthoringService;
  conversationActions(store: WorldStore): ConversationActionService;
  conversationInputs(store: WorldStore): ConversationInputs;
  attachToWorldChat(store: WorldStore, conversationId: ConversationId, sourcePath: string): Promise<void>;
  attachBytesToWorldChat(store: WorldStore, conversationId: ConversationId, name: string, bytes: Uint8Array): Promise<string | undefined>;
  refreshBench(worldId: string, sessionId: SessionId): Promise<void>;
  discoverBenchRows(store: WorldStore): Promise<void>;
}) {
  const worldChatOpen = async (msg: CommandOf<"world-chat-open">): Promise<void> => {
    const store = ctx.openStore();
    if (!store) return;
    if (msg.conversationId === null) {
      deps.setWorldChat(null);
      deps.broadcastSnapshot();
      return;
    }
    await deps.openWorldChat(store, msg.conversationId);
  };

  const conversationTakeReviewPrepare = async (msg: CommandOf<"conversation-take-review-prepare">): Promise<void> => {
    const store = ctx.openStore();
    let actionId: string | undefined;
    let detail: string | undefined;
    try {
      if (!store || store.worldId !== msg.worldId) throw new ConversationTakeReviewRefusal("No matching world is open.");
      actionId = (await deps.conversationActions(store).prepareTakeReview(msg)).actionId;
    } catch (error) {
      detail = error instanceof ConversationTakeReviewRefusal ? error.message : "The take review could not be prepared.";
    }
    ctx.emit({ at: ctx.nowIso(), type: "conversation-action.take-review-prepared", worldId: msg.worldId,
      conversationId: msg.conversationId, requestId: msg.requestId, ...(actionId ? { actionId } : {}), ...(detail ? { detail } : {}) });
    if (store && deps.stillOpen(store)) await deps.refreshConversationOutcome(store, msg.conversationId);
  };

  const conversationActionDecide = async (msg: CommandOf<"conversation-action-decide">): Promise<void> => {
    const store = ctx.openStore();
    if (!store) {
      ctx.emit({
        at: ctx.nowIso(),
        type: "conversation-action.decision-result",
        worldId: msg.worldId,
        conversationId: msg.conversationId,
        actionId: msg.actionId,
        requestId: msg.requestId,
        disposition: "refused",
        reason: "wrong-world",
        detail: "No matching world is open.",
        deduplicated: false,
      });
      return;
    }
    const result = await deps.conversationActions(store).decide(msg);
    if (!deps.stillOpen(store)) return;
    ctx.emit({ at: ctx.nowIso(), type: "conversation-action.decision-result", ...result });
    await deps.refreshConversationOutcome(store, msg.conversationId);
  };

  const worldChatInput = async (msg: CommandOf<"world-chat-input" | "world-chat-input-status" | "world-chat-input-remove" | "world-chat-input-continue">): Promise<void> => {
    await deps.worldOpensSettled();
    const requestId = msg.kind === "world-chat-input" ? msg.input.submissionId : msg.requestId;
    const answer = (admitted: boolean, detail?: string, queue?: import("@arke-studio/contracts").WorldChatInputQueueView, uncertain = false) =>
      ctx.emit({ at: ctx.nowIso(), type: "world-chat.input-result", worldId: msg.worldId,
        conversationId: msg.conversationId, requestId, admitted, uncertain, ...(detail ? { detail } : {}), ...(queue ? { queue } : {}) });
    const store = ctx.openStore();
    if (!store || store.worldId !== msg.worldId || ctx.stopping()) { answer(false, "This world is no longer open. Your message is retained.", undefined, true); return; }
    const journal = new WorldChatInputJournal(store, msg.conversationId), owner = deps.conversationInputs(store);
    try {
      if (msg.kind === "world-chat-input") await owner.record(msg.conversationId, msg.input);
      else if (msg.kind === "world-chat-input-remove") await owner.remove(msg.conversationId, msg.messageId, msg.revision, requestId);
      else if (msg.kind === "world-chat-input-continue") await owner.resume(msg.conversationId, msg.revision, msg.routing, requestId);
      const queue = msg.kind === "world-chat-input-status" ? await owner.receipt(msg.conversationId, requestId) : await journal.read();
      const known = msg.kind !== "world-chat-input-status" || queue.inputs.some(row => row.input.request.submissionId === requestId);
      answer(known, known ? undefined : "This message has not been queued. Your draft is retained.", projectWorldChatInputQueue(queue));
    } catch (error) {
      answer(false, error instanceof WorldChatInputError ? error.message : "The message could not be queued. Your draft is retained; check its status before retrying.", undefined, true);
    }
    await deps.refreshConversationOutcome(store, msg.conversationId);
  };

  const worldChatSend = async (msg: CommandOf<"world-chat-send">): Promise<void> => {
    // Every send is answered for its request (PR 1232): taken as a turn, or not. A decline
    // appends nothing, so without this the sender can only guess from the transcript.
    const answer = (admitted: boolean, turnId?: string) =>
      ctx.emit({
        at: new Date().toISOString(),
        type: "world-chat.send-result",
        conversationId: msg.conversationId,
        requestId: msg.requestId,
        admitted,
        ...(turnId !== undefined ? { turnId } : {}),
      });
    // Before anything is remembered for the request: the open clears what the last world's
    // session remembered, and a line held for the open belongs to the session it opens.
    await deps.worldOpensSettled();
    // The same request again is the same line (codex on PR 1232): still being taken, the
    // first's answer is this one's too; taken, it is answered as taken and not said twice.
    const seen = deps.worldChatSends.get(msg.requestId);
    if (seen === "pending") return;
    if (seen !== undefined) {
      answer(true, seen.turnId);
      return;
    }
    const declined = () => {
      deps.worldChatSends.delete(msg.requestId);
      answer(false);
    };
    const store = ctx.openStore();
    if (!store || store.worldId !== msg.worldId) {
      answer(false);
      return;
    }
    // Kept for the world's session, not by count (codex on PR 1232): a window holds an ask
    // for as long as that, and a retry under a forgotten id would buy a second turn.
    deps.worldChatSends.set(msg.requestId, "pending");
    // Taken only once the runner has made the line a turn (codex on PR 1232): the runner can
    // still decline after this returns — another window's turn running, the world closing —
    // and then the turn ends without the line ever being appended.
    let admitted = false;
    const started = await deps.conversationAuthoring(store).send(msg, (turnId) => {
      admitted = true;
      deps.worldChatSends.set(msg.requestId, { turnId });
      answer(true, turnId);
    }).catch((error: unknown) => {
      declined();
      throw error;
    });
    if (!started) {
      declined();
      return;
    }
    void started.completion.then(
      () => { if (!admitted) declined(); },
      () => { if (!admitted) declined(); },
    );
    const { completion: inFlight, naming } = started;
    // The title may have just changed, and the screen shows the message immediately.
    await deps.refreshConversations(store);
    await deps.openWorldChat(store, msg.conversationId);
    // The input queue's completion already refreshed the outcome before settling, so a second
    // refresh here only rediscovered every conversation and reloaded this one again (issue 2780).
    await inFlight;
    // Naming waits for the turn, so it settles after it (issue 2801).
    if (naming !== null && (await naming)) await deps.refreshConversationOutcome(store, msg.conversationId);
  };

  const worldChatSendStatus = async (msg: CommandOf<"world-chat-send-status">): Promise<void> => {
    // Taken is known for the world's session; anything else is not taken as far as this
    // coordinator knows — declined, never received, or sent to one that has since restarted.
    // Still being taken, the first send's own answer will come.
    // Behind the same wait as the send, so a line still held for an open is found pending
    // rather than answered as never taken — which a window would resend as a second turn.
    await deps.worldOpensSettled();
    const seen = deps.worldChatSends.get(msg.requestId);
    if (seen === "pending") return;
    ctx.emit({
      at: new Date().toISOString(),
      type: "world-chat.send-result",
      conversationId: msg.conversationId,
      requestId: msg.requestId,
      admitted: seen !== undefined,
      ...(seen !== undefined ? { turnId: seen.turnId } : {}),
    });
  };

  const worldChatRetryTurn = async (msg: CommandOf<"world-chat-retry-turn">): Promise<void> => {
    await deps.worldOpensSettled();
    const store = ctx.openStore();
    if (!store) return;
    const started = await deps.conversationAuthoring(store).retry(msg.conversationId, msg.turnId);
    if (!started) return;
    const inFlight = started.completion;
    // The spinner replaces the failure notice immediately, so pressing it looks like it worked.
    await deps.openWorldChat(store, msg.conversationId);
    await inFlight;
    await ctx.refreshWorldSnapshot(msg.worldId);
    await deps.refreshConversations(store);
    await deps.openWorldChat(store, msg.conversationId);
  };

  const worldChatSavePoint = async (msg: CommandOf<"world-chat-save-point">, store: WorldStore): Promise<void> => {
    const gate = deps.gate();
    if (!gate) return;
    const ripples: RippleItem[] = [];
    try {
      /*
       * Staged and accepted in one motion — the assign-voice rule, which the art-direction
       * form already follows: being asked to approve a change you just approved is two steps
       * for one decision. The gate still does the whole job, so the history, the ripples and
       * the change log are identical to a proposal reviewed on the approvals screen; the only
       * thing removed is the screen.
       */
      const saved = await savePoint({
        store,
        gate,
        conversationId: msg.conversationId,
        requestId: msg.requestId,
        candidateId: msg.candidateId,
        expectedCandidateRevision: msg.expectedCandidateRevision,
        ...(msg.expectedGroupRevisions ? { expectedGroupRevisions: msg.expectedGroupRevisions } : {}),
        now: () => new Date().toISOString(),
      });
      for (const proposalId of saved.proposalIds) {
        const staged = await gate.readManifest(proposalId).catch(() => null);
        /*
         * A proposal asking a question is never answered by a press.
         *
         * "This looks close to Bray Half-Hitch — is it a new rule, or a change to that one?"
         * has exactly one person who can answer it, and accepting past it would pick the
         * create silently and put a duplicate in the world. It stays a proposal, which is
         * where that question can be put.
         */
        if (staged?.openChoices?.length) {
          /*
           * Said, not swallowed. The rail promised Save would write this, and instead it has
           * become a question — the point leaves the rail either way, so without this it
           * simply disappears and the promise is what the person remembers.
           */
          ctx.emit({
            at: new Date().toISOString(),
            type: "world-chat.wrap-up-refused",
            conversationId: msg.conversationId,
            requestId: msg.requestId,
            reason: "unknown",
            detail: refusalDetail(
              `${staged.openChoices[0]!.question} It is waiting on the proposals screen, where you can answer it.`,
            ),
          });
          continue;
        }
        const outcome = await acceptDecided(gate, proposalId);
        if (outcome.status === "accepted") ripples.push(...outcome.ripples);
        const at = new Date().toISOString();
        if (landed(outcome) && staged) {
          // The conversation's own account of what became of its propositions (§6.5).
          await recordResolution(store, staged, "accepted", () => at);
          ctx.emit({
            at,
            type: "proposal.resolved",
            worldId: msg.worldId,
            proposalId,
            outcome: "accepted",
          });
        } else if (!landed(outcome)) {
          /*
           * Not written, so not left proposed either — the same taking-back Accept all does.
           *
           * This used to leave the proposal standing, on the reasoning that a waiting proposal
           * is a state a person can finish. What that missed is that staging had already
           * marked the proposition `proposed`: the point left the rail, the conversation had
           * nothing left to correct it from, and the change surfaced on the Cast and approvals
           * screens as a draft that could not be accepted — while the rail said only that the
           * gate had answered a word. Back on the rail it can be talked about, which for every
           * refusal the gate raises is the repair.
           */
          if (staged) {
            await returnToRail(
              new WorldChatStore(conversationDir(store.dir, msg.conversationId)),
              gate,
              staged,
              () => new Date().toISOString(),
            );
          }
          ctx.emit({
            at,
            type: "world-chat.wrap-up-refused",
            conversationId: msg.conversationId,
            requestId: msg.requestId,
            reason: "unknown",
            detail: refusalDetail(
              `This could not be written, so it is back above: ${explainAcceptRefusal(outcome)}.`,
            ),
          });
        }
      }
    } catch (err) {
      const reason = err instanceof WrapUpError ? err.reason : "unknown";
      deps.log({ level: "warn", event: "world-chat.save-point-refused", reason });
      ctx.emit({
        at: new Date().toISOString(),
        type: "world-chat.wrap-up-refused",
        conversationId: msg.conversationId,
        requestId: msg.requestId,
        reason,
        detail: refusalDetail(
          err instanceof WrapUpError ? err.message : "This could not be written, so nothing was.",
        ),
      });
    }
    if (ripples.length > 0) {
      ctx.emit({
        at: new Date().toISOString(),
        type: "world-chat.ripples",
        worldId: msg.worldId,
        conversationId: msg.conversationId,
        requestId: msg.requestId,
        items: ripples,
      });
    }
    await ctx.refreshWorldSnapshot(msg.worldId);
    await deps.refreshConversations(store);
    await deps.openWorldChat(store, msg.conversationId);
  };

  const worldChatRejectPoint = async (msg: CommandOf<"world-chat-reject-point">, store: WorldStore): Promise<void> => {
    try {
      await rejectPoint({
        store,
        conversationId: msg.conversationId,
        candidateId: msg.candidateId,
        expectedCandidateRevision: msg.expectedCandidateRevision,
        ...(msg.expectedGroupRevisions ? { expectedGroupRevisions: msg.expectedGroupRevisions } : {}),
        now: () => new Date().toISOString(),
      });
    } catch (err) {
      ctx.emit({
        at: new Date().toISOString(),
        type: "world-chat.wrap-up-refused",
        conversationId: msg.conversationId,
        requestId: msg.requestId,
        reason: err instanceof WrapUpError ? err.reason : "unknown",
        detail: refusalDetail(
          err instanceof WrapUpError
            ? err.message
            : "That point could not be dropped, so it was left alone.",
        ),
      });
    }
    // The list counts live points and orders by what is waiting, so it moves when one goes.
    await deps.refreshConversations(store);
    await deps.openWorldChat(store, msg.conversationId);
  };

  const worldChatOpenMedia = async (msg: CommandOf<"world-chat-open-media">, store: WorldStore): Promise<void> => {
    const answer = (sessionId: SessionId | null, medium: "image" | "video", reason?: string) =>
      ctx.emit({
        at: ctx.nowIso(),
        type: "world-chat.media-opened",
        worldId: msg.worldId,
        conversationId: msg.conversationId,
        candidateId: msg.candidateId,
        requestId: msg.requestId,
        medium,
        sessionId,
        ...(reason ? { reason } : {}),
      });
    const opening = { worldId: store.worldId, sessionId: undefined as SessionId | undefined };
    deps.setBenchOpening(opening);
    const loaded = await new WorldChatService(store.dir).load(msg.conversationId);
    const candidate = loaded?.candidates.find((one) => one.id === msg.candidateId);
    if (!loaded || !candidate) {
      answer(null, "image", "That media brief is no longer in this conversation.");
      return;
    }
    const candidateMedium =
      candidate.classification === "media.image-opportunity" ? candidate.draft.medium : "image";
    if (candidate.revision !== msg.expectedCandidateRevision) {
      answer(null, candidateMedium, "That media brief changed. Review the latest version and try again.");
      await deps.openWorldChat(store, msg.conversationId);
      return;
    }
    if (candidate.status !== "live" || candidate.classification !== "media.image-opportunity") {
      answer(null, candidateMedium, "That point is not an available media brief.");
      return;
    }
    const medium = candidate.draft.medium;
    const route = mediaRouteFor(candidate, msg.worldId);
    if (route.kind === "invalid") {
      answer(null, medium, route.reason);
      return;
    }
    const bundle = store.getBundle();
    const blocking = blockingDependencies(
      candidate,
      bundle,
      bundle.proposals.map((staged) => staged.proposal),
      loaded.candidates,
    );
    if (blocking.length > 0) {
      answer(null, medium, explainBlocked(blocking));
      return;
    }
    const prior = loaded.mediaHandoffs[candidate.id];
    const sessionId =
      prior?.candidateRevision === candidate.revision
        ? prior.sessionId
        : mediaSessionId(candidate.id, candidate.revision);
    const settings = await deps.appSettings()?.load() ?? null;
    // World chat is world work: the world's own choice first, then Settings (design turn 153).
    const chosen = bundle.meta.models?.[medium];
    const routed = !deps.manifest
      ? undefined
      : chosen !== undefined
        ? deps.manifest.models.find((m) => m.id === chosen && m.capability === medium)
        : modelForCapability(deps.manifest, settings?.routing, medium);
    const enabled = routed && settings?.models.disabled.includes(routed.id) !== true ? routed : null;
    const opened = await openBenchSession(store.dir, () => ctx.nowIso(), {
      sessionId,
      initial: { mode: medium, brief: candidate.draft.brief, title: candidate.title },
      ...(enabled ? { defaultModel: { provider: enabled.provider, model: enabled.id } } : {}),
    }).catch(() => null);
    if (!opened) {
      answer(null, medium, "The Bench could not be prepared. Try again.");
      return;
    }
    if (prior?.candidateRevision !== candidate.revision) {
      await new WorldChatStore(conversationDir(store.dir, msg.conversationId)).append(
        {
          type: "media.handoff-created",
          candidateId: candidate.id,
          candidateRevision: candidate.revision,
          sessionId,
          medium,
        },
        { at: ctx.nowIso(), requestId: `media-handoff:${candidate.id}:${candidate.revision}` },
      );
    }
    if (deps.benchOpening() !== opening || !deps.stillOpen(store) || ctx.stopping()) { answer(sessionId, medium); return; }
    opening.sessionId = sessionId;
    await deps.discoverBenchRows(store);
    if (deps.benchOpening() !== opening || !deps.stillOpen(store) || ctx.stopping()) { answer(sessionId, medium); return; }
    await deps.refreshBench(store.worldId, sessionId);
    await deps.refreshConversations(store);
    await deps.openWorldChat(store, msg.conversationId);
    answer(sessionId, medium);
  };

  const worldChatWrapUp = async (msg: CommandOf<"world-chat-wrap-up">, store: WorldStore): Promise<void> => {
    const gate = deps.gate();
    if (!gate) return;
    const ripples: RippleItem[] = [];
    try {
      await wrapUp({
        store,
        gate,
        conversationId: msg.conversationId,
        requestId: msg.requestId,
        expectedConversationSeq: msg.expectedConversationSeq,
        now: () => new Date().toISOString(),
        /*
         * Accept all writes; it does not stage for a screen the person then has to visit.
         *
         * The conversation is where the deciding happens now, and pressing a button labelled
         * Accept and being taken somewhere else to accept again was the two-step this design
         * removed. Each still goes through the gate, so what lands is identical to a reviewed
         * proposal — only the review is the press that just happened. Handed to wrap-up rather
         * than run after it, because a proposal that will not land has to keep the
         * conversation open, and only wrap-up can still decide not to close.
         *
         * A proposal carrying an open choice is left standing and counted as landed: it is
         * asking a question only the person can answer, so it is not a failure to write — it
         * is the one thing this press was never allowed to decide.
         */
        writeThrough: async (proposalId) => {
          const staged = await gate.readManifest(proposalId).catch(() => null);
          if (staged?.openChoices?.length) return null;
          const outcome = await acceptDecided(gate, proposalId);
          if (outcome.status === "accepted") ripples.push(...outcome.ripples);
          const at = new Date().toISOString();
          // The gate's own words, carried out to the rail. Discarding them left the person
          // with a count and no cause, and left this path undiagnosable from a log.
          if (!landed(outcome)) return explainAcceptRefusal(outcome);
          if (staged) {
            await recordResolution(store, staged, "accepted", () => at);
            ctx.emit({
              at,
              type: "proposal.resolved",
              worldId: msg.worldId,
              proposalId,
              outcome: "accepted",
            });
          }
          return null;
        },
      });
    } catch (err) {
      // A refusal is the answer: nothing was written, and the conversation is still open and
      // still says what it understood. It is said to the screen as well as to the log, because
      // the person is standing in front of the button that did nothing, and a reason only the
      // log can see is not a reason they were given.
      //
      // Only a WrapUpError carries that promise. Wrap-up is a recoverable saga, not one
      // transaction, so anything else — an I/O failure part-way through staging — may have
      // left proposals behind, and saying "nothing was written" there would be a guess
      // presented as a fact. That case says what is known and where to look instead.
      const reason = err instanceof WrapUpError ? err.reason : "unknown";
      deps.log({ level: "warn", event: "world-chat.wrap-up-refused", reason });
      ctx.emit({
        at: new Date().toISOString(),
        type: "world-chat.wrap-up-refused",
        conversationId: msg.conversationId,
        // Named, because this goes to every client: without it a second window's refusal
        // would settle the first window's wrap-up while its proposals were still being made.
        requestId: msg.requestId,
        reason,
        // Every WrapUpError message is already written for a person to read; anything else is
        // ours to explain and not theirs to decode.
        detail: refusalDetail(
          err instanceof WrapUpError
            ? err.message
            : "This did not finish. Check the proposals before trying again — some of them may already be there.",
        ),
      });
    }
    if (ripples.length > 0) {
      ctx.emit({
        at: new Date().toISOString(),
        type: "world-chat.ripples",
        worldId: msg.worldId,
        conversationId: msg.conversationId,
        requestId: msg.requestId,
        items: ripples,
      });
    }
    await ctx.refreshWorldSnapshot(msg.worldId);
    await deps.refreshConversations(store);
    await deps.openWorldChat(store, msg.conversationId);
  };

  const proposalSendBack = async (msg: CommandOf<"proposal-send-back">, store: WorldStore): Promise<void> => {
    const gate = deps.gate();
    if (!gate) return;
    const proposal = await gate.readManifest(msg.proposalId).catch(() => null);
    if (!proposal) return;
    const conversationId = await sendBack(store, gate, proposal, () => new Date().toISOString()).catch(
      () => null,
    );
    await ctx.refreshWorldSnapshot(msg.worldId);
    await deps.refreshConversations(store);
    if (conversationId) await deps.openWorldChat(store, conversationId);
  };

  const worldChatCancel = async (msg: CommandOf<"world-chat-cancel">, store: WorldStore): Promise<void> => {
    await deps.conversationAuthoring(store).cancel(msg.conversationId);
  };

  const worldChatCreate = async (msg: CommandOf<"world-chat-create">): Promise<void> => {
    const store = ctx.openStore();
    const answer = (conversationId?: ConversationId) => ctx.emit({ at: new Date().toISOString(), type: "world-chat.create-result",
      worldId: msg.worldId, requestId: msg.requestId, ...(conversationId ? { conversationId } : { detail: "The conversation could not be created. Your draft is retained." }) });
    if (!store || store.worldId !== msg.worldId) { answer(); return; }
    if (msg.entryContext !== undefined && !(msg.entryContext.kind === "bench" ? readBenchSession(store.dir, msg.entryContext.sessionId) !== null : worldChatContextExists(store.getBundle(), msg.entryContext))) { answer(); return; }
    // The same request again is the same conversation: wait for it and show it.
    const earlier = deps.worldChatCreates.get(msg.requestId);
    if (earlier !== undefined) {
      const made = await earlier;
      if (made === null) { answer(); return; }
      answer(made.id);
      if (ctx.openStore()?.worldId !== store.worldId) return;
      await deps.refreshConversations(store);
      await deps.openWorldChat(store, made.id);
      return;
    }
    let settle!: (made: { id: ConversationId } | null) => void;
    let made = false;
    deps.worldChatCreates.set(msg.requestId, new Promise((resolve) => { settle = resolve; }));
    try {
      // Raise the persisted-context boundary before creating its log (SPEC-002 R-25):
      // older builds must refuse conversation kinds they cannot read. Ordinary contexts
      // retain the first-conversation boundary (#70 §4.1, issue #403).
      await store.ensureSchemaVersion(worldChatContextSchemaVersion(msg.entryContext), "world-chat");
      const service = new WorldChatService(store.dir);
      const create = () =>
        service.create({
          title: msg.title,
          requestId: msg.requestId,
          ...(msg.entryContext ? { entryContext: msg.entryContext } : {}),
        });
      const sceneContext = msg.entryContext?.kind === "scene" ? msg.entryContext : null;
      const row = sceneContext !== null
        ? await serialiseSceneConversation(
            store.dir,
            sceneContext.productionId,
            sceneContext.sceneId,
            async () => {
              const existing = (await discoverConversations(store.dir)).summaries.find(
                (summary) =>
                  summary.status !== "archived" &&
                  summary.entryContext?.kind === "scene" &&
                  summary.entryContext.productionId === sceneContext.productionId &&
                  summary.entryContext.sceneId === sceneContext.sceneId,
              );
              return existing ?? create();
            },
          )
        : await create();
      made = true;
      settle(row);
      answer(row.id);
      if (ctx.openStore()?.worldId !== store.worldId) return;
      await deps.refreshConversations(store);
      await deps.openWorldChat(store, row.id);
      return;
    } catch (error) {
      // Not made: a later request under the same id may try again.
      if (!made) {
        deps.worldChatCreates.delete(msg.requestId);
        settle(null);
        answer();
      }
      throw error;
    }
  };

  const worldChatDelete = async (msg: CommandOf<"world-chat-delete">, store: WorldStore): Promise<void> => {
    try {
      await new WorldChatService(store.dir).delete(msg.conversationId, msg.requestId);
    } catch (err) {
      // A refusal is an answer, not a failure: the conversation is untouched and the row
      // still says which dependency is holding it. Rechecked here rather than trusted from
      // the row, because a turn may have started since that row was drawn.
      deps.log({
        level: "warn",
        event: "world-chat.delete-refused",
        reason: err instanceof ConversationInUseError ? err.reason : "unknown",
      });
      await deps.refreshConversations(store);
      deps.broadcastSnapshot();
      return;
    }
    // The screen the user is standing on may be the one just deleted. Releasing it here means
    // they land on "that conversation is not here" rather than a transcript with no file.
    if (deps.worldChat()?.conversationId === msg.conversationId) {
      deps.setWorldChat(null);
    }
    await deps.refreshConversations(store);
    deps.broadcastSnapshot();
  };

  const worldChatUpload = async (msg: CommandOf<"world-chat-upload">): Promise<void> => {
    const store = ctx.openStore();
    let reason: string | undefined;
    if (!store || store.worldId !== msg.worldId) reason = "That world is no longer open.";
    else {
      try {
        reason = await deps.attachBytesToWorldChat(store, msg.conversationId, msg.name, Buffer.from(msg.data, "base64"));
        // The authoritative workspace precedes the result on the ordered transport.
        await deps.openWorldChat(store, msg.conversationId);
      } catch { reason = "The attachment could not be confirmed. Try again."; }
    }
    if (msg.requestId) ctx.emit({at:ctx.nowIso(),type:"world-chat.upload-result",worldId:msg.worldId,conversationId:msg.conversationId,requestId:msg.requestId,...(reason ? {reason} : {})});
  };

  const worldChatAttach = async (msg: CommandOf<"world-chat-attach">, store: WorldStore): Promise<void> => {
    await deps.attachToWorldChat(store, msg.conversationId, msg.sourcePath);
    await deps.openWorldChat(store, msg.conversationId);
  };

  const worldChatAttachFiles = async (msg: CommandOf<"world-chat-attach-files">, store: WorldStore): Promise<void> => {
    const pick = deps.pickFiles;
    if (!pick) {
      ctx.emit({
        at: new Date().toISOString(),
        type: "world-chat.attachment-refused",
        conversationId: msg.conversationId,
        name: "attaching",
        reason: "this needs the desktop app — a browser session cannot open the file picker",
      });
      return;
    }
    // Known media is retained with an explicit unreadable capability rather than disappearing.
    // Cancelling the dialog is an answer: nothing is said and nothing happens.
    const paths = await pick({ accept: CHAT_ATTACHMENT_EXTENSIONS }).catch(() => [] as readonly string[]);
    for (const sourcePath of paths) {
      await deps.attachToWorldChat(store, msg.conversationId, sourcePath);
    }
    await deps.openWorldChat(store, msg.conversationId);
  };

  const worldChatPromoteAttachment = async (msg: CommandOf<"world-chat-promote-attachment">, store: WorldStore): Promise<void> => {
    const loaded = await new WorldChatService(store.dir).load(msg.conversationId);
    const attachment = loaded?.attachments.find((one) => one.id === msg.attachmentId);
    if (!attachment) return;
    const attachments = new WorldChatAttachmentStore(store.dir, () => ctx.nowIso());
    try {
      await attachments.promote(msg.conversationId, attachment, msg.requestId, async ({ sourcePath }) => {
        const outcome = await fileArtifact(store, { ...(deps.importFileSpace ? { importSpace: deps.importFileSpace } : {}),
          sourcePath,
          importedFrom: `world-chat:${msg.conversationId}/${msg.attachmentId}`,
          ...(deps.mediaProbe ? { mediaProbe: deps.mediaProbe } : {}),
          abandoned: () => !deps.stillOpen(store) || ctx.stopping(),
        });
        if (outcome.outcome === "filed" || outcome.outcome === "deduplicated") return outcome.artifact.id;
        throw new Error(outcome.reason);
      });
    } catch {
      ctx.emit({
        at: ctx.nowIso(),
        type: "world-chat.attachment-refused",
        conversationId: msg.conversationId,
        name: attachment.fileName,
        reason: "this could not be filed in the world",
      });
    }
    await ctx.refreshWorldSnapshot(msg.worldId);
    await deps.openWorldChat(store, msg.conversationId);
  };

  const worldChatSetInitiative = async (msg: CommandOf<"world-chat-set-initiative">, store: WorldStore): Promise<void> => {
    await new WorldChatService(store.dir).setInitiative(msg.conversationId, msg.initiative);
    await deps.refreshConversations(store);
    if (deps.worldChat()?.conversationId === msg.conversationId) {
      await deps.openWorldChat(store, msg.conversationId);
    } else {
      deps.broadcastSnapshot();
    }
  };

  const worldChatArchive = async (msg: CommandOf<"world-chat-archive" | "world-chat-unarchive">, store: WorldStore): Promise<void> => {
    const service = new WorldChatService(store.dir);
    if (msg.kind === "world-chat-archive") await service.archive(msg.conversationId);
    else await service.unarchive(msg.conversationId);
    await deps.refreshConversations(store);
    // Archiving loses nothing, so an open transcript stays open and simply reads as archived.
    if (deps.worldChat()?.conversationId === msg.conversationId) {
      await deps.openWorldChat(store, msg.conversationId);
    } else {
      deps.broadcastSnapshot();
    }
  };

  return {
    "world-chat-open": { scope: "any-world", handle: worldChatOpen },
    "conversation-take-review-prepare": { scope: "any-world", handle: conversationTakeReviewPrepare },
    "conversation-action-decide": { scope: "any-world", handle: conversationActionDecide },
    "world-chat-input": { scope: "any-world", handle: worldChatInput },
    "world-chat-input-status": { scope: "any-world", handle: worldChatInput },
    "world-chat-input-remove": { scope: "any-world", handle: worldChatInput },
    "world-chat-input-continue": { scope: "any-world", handle: worldChatInput },
    "world-chat-send": { scope: "any-world", handle: worldChatSend },
    "world-chat-send-status": { scope: "any-world", handle: worldChatSendStatus },
    "world-chat-retry-turn": { scope: "any-world", handle: worldChatRetryTurn },
    "world-chat-save-point": { scope: "open-world", handle: worldChatSavePoint },
    "world-chat-reject-point": { scope: "open-world", handle: worldChatRejectPoint },
    "world-chat-open-media": { scope: "open-world", handle: worldChatOpenMedia },
    "world-chat-wrap-up": { scope: "open-world", handle: worldChatWrapUp },
    "proposal-send-back": { scope: "open-world", handle: proposalSendBack },
    "world-chat-cancel": { scope: "open-world", handle: worldChatCancel },
    "world-chat-create": { scope: "any-world", handle: worldChatCreate },
    "world-chat-delete": { scope: "open-world", handle: worldChatDelete },
    "world-chat-upload": { scope: "any-world", handle: worldChatUpload },
    "world-chat-attach": { scope: "open-world", handle: worldChatAttach },
    "world-chat-attach-files": { scope: "open-world", handle: worldChatAttachFiles },
    "world-chat-promote-attachment": { scope: "open-world", handle: worldChatPromoteAttachment },
    "world-chat-set-initiative": { scope: "open-world", handle: worldChatSetInitiative },
    "world-chat-archive": { scope: "open-world", handle: worldChatArchive },
    "world-chat-unarchive": { scope: "open-world", handle: worldChatArchive },
  } satisfies CommandModule;
}

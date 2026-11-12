import { ulid, type ConversationId } from "@arke-studio/contracts";
import type { createEngine } from "../application/engine.js";
import { LOCAL_ENGINE_CONTEXT } from "../application/local-policy.js";
import { describeCoordinatorError } from "../errors/user-message.js";
import { DRAFT_CHANGED_DETAIL, landed, type ProposalManager } from "../gate/proposals.js";
import { materialiseDuplicateChoice } from "../world-chat/materialise.js";
import { WorldChatService } from "../world-chat/service.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/**
 * A proposal in the open world: accepted, discarded, rebased, its conflicts and open questions
 * answered, seen, and its fields and passages edited. Open world only. Anything that would write
 * under a draft still being written is refused while it is.
 */
export function proposalCommands(ctx: CommandContext, deps: {
  gate: () => ProposalManager | null | undefined;
  proposals: ReturnType<typeof createEngine>["proposals"];
  /** Lets a proposal's drafting run go once the proposal is settled. */
  release(proposalId: string): void;
  /** True, having said so, when a run is still writing into this proposal (issue 239). */
  refuseWhileDrafting(worldId: string, proposalId: string, requestId?: string): boolean;
}) {
  const edit = async (msg: CommandOf<"proposal-update-field" | "proposal-update-passage">) => {
    const gate = deps.gate();
    if (!gate) return;
    // The journal's revision check cannot see the agent, which does not write through it —
    // so an edit landing mid-run is the interleaving it exists to refuse, unnoticed.
    if (deps.refuseWhileDrafting(msg.worldId, msg.proposalId, msg.requestId)) return;
    const outcome = await (msg.kind === "proposal-update-field"
      ? gate.updateField({
          proposalId: msg.proposalId,
          requestId: msg.requestId,
          path: msg.path,
          field: msg.field,
          value: msg.value,
          expectedDraftRevision: msg.expectedDraftRevision,
        })
      : gate.updatePassage({
          proposalId: msg.proposalId,
          requestId: msg.requestId,
          path: msg.path,
          before: msg.before,
          after: msg.after,
          kept: msg.kept,
          expectedDraftRevision: msg.expectedDraftRevision,
        })
    ).catch(() => "threw" as const);
    // An edit that threw is refused out loud too (codex on PR 1232): said nothing, a screen
    // waiting on it has no answer to end the wait with.
    if (outcome === "threw") {
      ctx.emit({
        at: new Date().toISOString(),
        type: "proposal.blocked",
        worldId: msg.worldId,
        proposalId: msg.proposalId,
        requestId: msg.requestId,
        reason: "invalid",
        detail: "that edit could not be applied to this proposal",
      });
      await ctx.refreshWorldSnapshot(msg.worldId);
      return;
    }
    // A refusal is said out loud. The screen is showing a value the person just typed, and
    // silently reverting it on the next snapshot would read as the app losing their work
    // rather than as somebody else having changed it first.
    if (outcome && outcome.status !== "updated") {
      ctx.emit({
        at: new Date().toISOString(),
        type: "proposal.blocked",
        worldId: msg.worldId,
        proposalId: msg.proposalId,
        requestId: msg.requestId,
        // Stale here is always the draft moving — another window's edit landed first — never
        // the world under it, so nothing is offered to rebase (codex on PR 1232).
        reason:
          outcome.status === "stale"
            ? "draft-changed"
            : outcome.status === "draft-unresolved"
              ? "draft-unresolved"
              : "invalid",
        detail:
          outcome.status === "stale"
            ? "somebody changed this proposal while you were editing — it has been reloaded"
            : outcome.status === "rejected"
              ? outcome.message
              : outcome.status === "unknown-target"
                ? "that file is not part of this proposal"
                : "an earlier edit to this proposal did not finish, and what its files now say is unknown",
      });
    }
    await ctx.refreshWorldSnapshot(msg.worldId);
  };
  return {
    "proposal-accept": {
      scope: "open-world",
      async handle(msg) {
        const gate = deps.gate();
        if (!gate) return;
        // A proposal being written into is not a proposal to commit (issue 239). The client hides
        // Accept while a run is live, but it learns that from a snapshot it may have taken a
        // moment ago, and the run is here — so the refusal is made where the answer is known.
        if (deps.refuseWhileDrafting(msg.worldId, msg.proposalId, msg.requestId)) return;
        // Read before accepting: acceptance rewrites the manifest, and the origin is needed to
        // tell the conversation what became of its propositions.
        try {
          const outcome = (await deps.proposals.accept(LOCAL_ENGINE_CONTEXT, msg.worldId,
            msg.proposalId, {
              operationId: ulid(),
              ...(msg.confirmRipples === undefined ? {} : { confirmRipples: msg.confirmRipples }),
              ...(msg.expectedDraftRevision === undefined ? {} : { expectedDraftRevision: msg.expectedDraftRevision }),
            })).value;
          const at = new Date().toISOString();
          // Refused against a revision the press was fenced to, and the draft has since moved on
          // (codex on PR 1232): another window kept or edited part of it. That is not the world
          // moving, so the answer is to read the newer draft, never to rebase it. Told by what the
          // gate said under its lock, not by reading the proposal again once it has let go.
          const draftMoved = outcome.status === "stale" && outcome.detail === DRAFT_CHANGED_DETAIL;
          // `no-op` retires the proposal too (gate/proposals.ts): every target already reads as
          // proposed, so there is nothing to decide. It has to settle here for the same reason —
          // a conversation whose propositions stayed `proposed` behind a proposal that no longer
          // exists cannot be accepted, discarded, sent back, or even deleted. Recorded as
          // accepted because that is what happened to the words: the world says them.
          if (landed(outcome)) {
            deps.release(msg.proposalId);
            ctx.emit({
              at,
              type: "proposal.resolved",
              worldId: msg.worldId,
              proposalId: msg.proposalId,
              outcome: "accepted",
            });
          } else {
            ctx.emit({
              at,
              type: "proposal.blocked",
              worldId: msg.worldId,
              proposalId: msg.proposalId,
              ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
              reason:
                // `no-op` is not here: it settles above, because the world already says what the
                // proposal says and there is nothing left to block on.
                outcome.status === "needs-reconfirm"
                  ? "needs-reconfirm"
                  : outcome.status === "stale"
                    ? draftMoved ? "draft-changed" : "stale"
                    : outcome.status === "pending-review"
                      ? "pending-review"
                      : outcome.status === "unresolved-conflicts"
                        ? "unresolved-conflicts"
                        : outcome.status === "open-choices"
                          ? "open-choices"
                        : outcome.status === "invalid"
                          ? "invalid"
                          : outcome.status === "draft-unresolved"
                            ? "draft-unresolved"
                            : "target-retired",
              detail:
                outcome.status === "stale"
                  ? draftMoved
                    ? "another change to this draft arrived first; read the draft as it stands now"
                    : `moved since drafting: ${outcome.stalePaths.join(", ")}`
                  : outcome.status === "unresolved-conflicts"
                    ? `${outcome.count} conflicted field${outcome.count === 1 ? "" : "s"} await a choice`
                    : outcome.status === "open-choices"
                      ? `${outcome.count} question${outcome.count === 1 ? "" : "s"} must be answered below before this can be accepted`
                    : outcome.status === "target-retired"
                      ? `retired: ${outcome.paths.join(", ")}`
                      : outcome.status === "invalid"
                        ? outcome.problems.map((p) => `${p.path}: ${p.message}`).join("; ")
                        : outcome.status === "draft-unresolved"
                          ? "an earlier edit to this proposal did not finish, and what its files now say is unknown"
                          : undefined,
              ...(outcome.status === "needs-reconfirm" ? { authoritativeSignature: outcome.signature } : {}),
            });
          }
        } catch {
          // Always answered (codex on PR 1232): a screen holding its controls until the accept
          // settles would otherwise wait on a proposal the refresh shows unchanged. What failed is
          // not relayed. The accept can throw after the gate committed — its bookkeeping and
          // delivery come after — so what is said follows the proposal. The gate's tombstone
          // says it landed, even with its manifest still on disk behind a busy handle (codex on
          // PR 1232). Otherwise standing, it did not finish; gone with no tombstone, it may have
          // landed or lost to another window's discard, and neither is claimed.
          const settled = await gate.landed(msg.proposalId).catch(() => false);
          const standing = settled ? false : await gate.readManifest(msg.proposalId).then(
            () => true as const,
            (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT" ? false as const : null,
          );
          const at = new Date().toISOString();
          if (settled) {
            deps.release(msg.proposalId);
            ctx.emit({ at, type: "proposal.resolved", worldId: msg.worldId, proposalId: msg.proposalId, outcome: "accepted" });
          } else {
            ctx.emit({
              at,
              type: "proposal.blocked",
              worldId: msg.worldId,
              proposalId: msg.proposalId,
              ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
              reason: "invalid",
              detail: standing === true
                ? "this could not be accepted; the proposal still stands"
                : standing === false
                  ? "this proposal is no longer open; read the draft as it stands"
                  : "whether this was accepted is not known; reopen the world to see the draft as it stands",
            });
          }
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "proposal-discard": {
      scope: "open-world",
      async handle(msg) {
        const gate = deps.gate();
        if (!gate) return;
        // Discarding mid-run would delete the directory the agent is writing into (issue 239).
        // Cancel is the way to stop a run, and it leaves the proposal to be discarded after.
        if (deps.refuseWhileDrafting(msg.worldId, msg.proposalId)) return;
        try {
          await deps.proposals.discard(LOCAL_ENGINE_CONTEXT, msg.worldId, msg.proposalId, { operationId: ulid() });
          ctx.emit({
            at: new Date().toISOString(),
            type: "proposal.resolved",
            worldId: msg.worldId,
            proposalId: msg.proposalId,
            outcome: "discarded",
          });
          deps.release(msg.proposalId);
        } catch {
          /* snapshot below */
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "proposal-rebase": {
      scope: "open-world",
      async handle(msg) {
        const gate = deps.gate();
        if (!gate) return;
        // Rebasing rewrites the captured base under files the agent has open (issue 239).
        if (deps.refuseWhileDrafting(msg.worldId, msg.proposalId)) return;
        await gate.rebase(msg.proposalId).catch(() => {});
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "proposal-resolve-conflict": {
      scope: "open-world",
      async handle(msg) {
        const gate = deps.gate();
        if (!gate) return;
        // A choice written into a file the agent is still writing is a choice about to be lost.
        if (deps.refuseWhileDrafting(msg.worldId, msg.proposalId)) return;
        await gate.resolveConflict(msg.proposalId, msg.path, msg.field, msg.choice).catch(() => {});
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "proposal-mark-seen": {
      scope: "open-world",
      async handle(msg) {
        const gate = deps.gate();
        if (!gate) return;
        await gate.markSeen(msg.proposalId).catch(() => {});
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "proposal-resolve-choice": {
      scope: "open-world",
      async handle(msg, store) {
        const gate = deps.gate();
        if (!gate) return;
        if (deps.refuseWhileDrafting(msg.worldId, msg.proposalId)) return;
        let detail: string | null = null;
        try {
          const proposal = await gate.readManifest(msg.proposalId);
          const candidateId = msg.choiceId.startsWith("duplicate-or-amend:")
            ? msg.choiceId.slice("duplicate-or-amend:".length)
            : null;
          const origin = candidateId
            ? (proposal.worldChatOrigins ?? []).find((one) => one.candidateId === candidateId)
            : undefined;
          if (!candidateId || !origin) throw new Error("The point behind this question is no longer available.");
          const loaded = await new WorldChatService(store.dir).load(origin.conversationId as ConversationId);
          const candidate = loaded?.candidates.find(
            (one) => one.id === candidateId && one.revision === origin.candidateRevision,
          );
          if (!candidate) throw new Error("The conversation point changed, so this answer cannot be applied.");
          const reservedId = /^canon\/(CANON-[0-9]+)\.md$/.exec(origin.targetPaths[0] ?? "")?.[1] ?? "";
          const outcome = await gate.resolveOpenChoice(msg, (_current, bundle, at) => {
            const built = materialiseDuplicateChoice(candidate, msg.optionId, reservedId, bundle, at);
            return {
              candidateId,
              action: built.action,
              targets: built.targets,
              fields: built.fields,
            };
          });
          if (outcome.status !== "updated") {
            detail =
              outcome.status === "stale"
                ? "This proposal changed while you were answering. Review the latest version and answer again."
                : outcome.status === "draft-unresolved"
                  ? "An earlier edit did not finish, so this answer cannot safely be applied."
                  : outcome.status === "rejected"
                    ? outcome.message
                    : outcome.status === "invalid-option"
                      ? "That answer is not offered for this question."
                      : "That question has already been answered or removed.";
          }
        } catch (err) {
          detail = describeCoordinatorError(err);
        }
        if (detail) {
          ctx.emit({
            at: new Date().toISOString(),
            type: "proposal.blocked",
            worldId: msg.worldId,
            proposalId: msg.proposalId,
            reason: "invalid",
            detail,
          });
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    // Keeping part of a passage revision is the same kind of edit as changing one field, and is
    // fenced, journalled and refused out loud the same way; only what is edited differs.
    "proposal-update-field": { scope: "open-world", handle: edit },
    "proposal-update-passage": { scope: "open-world", handle: edit },
  } satisfies CommandModule;
}

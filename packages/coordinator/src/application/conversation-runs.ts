import { productionSetupBrief } from "../productions/setup-brief.js";
import { createPreparedSession } from "../harness/session-files.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type WorldChatCheckReceipt, applyBibleEdits } from "@arke-studio/contracts";
import { listPlans } from "../productions/plans.js";
import { readContinuity } from "../productions/continuity.js";
import { readVoices } from "../productions/voices.js";
import { stageEditorRequests } from "../productions/editor-requests.js";
import { applySceneEdits, sceneVersionFor } from "../productions/scene-edits.js";
import { BibleStaleError, readBible } from "../world/bible.js";
import { MarkdownFile } from "../world/text-files.js";
import { toExtendedLength } from "../world/paths.js";
import { chapterDraftingBrief } from "../world-chat/chapter-brief.js";
import { WorldChatService } from "../world-chat/service.js";
import { describeEntryContext } from "../world-chat/entry-context.js";
import { budgetFor, currentLookContext } from "../world-chat/context.js";
import { QueryLeaseRegistry } from "../world-chat/lease.js";
import { WorldChatRetrieval } from "../world-chat/retrieval.js";
import { WorldChatAttachmentStore, MAX_TEXT_PER_RUN_CHARS } from "../world-chat/attachments.js";
import { planFor } from "../world-chat/check-plan.js";
import { createRunScratch, removeRunScratch } from "../world-chat/run-scratch.js";
import { prepareWorldChatActions } from "../world-chat/actions.js";
import { makeConversationSummariser } from "../world-chat/summarisation.js";
import type { WorldStore } from "../world/store.js";
import type { RunDeps } from "../world-chat/run.js";
import type { RetrievalDeps } from "../world-chat/retrieval.js";
import type { WorldQueryServer } from "../harness/world-query.js";
import type { SessionInput } from "../harness/session-files.js";
import type { ConversationActionLifecycle } from "../arke-actions/lifecycle.js";

export interface ConversationRunDependencies {
  adapter: RunDeps["adapter"];
  sessionInput: SessionInput;
  scratchRoot: string;
  summaryDir: string;
  /** Studio selection is consulted only to refuse leases after navigation. */
  activeStore(): WorldStore | null;
  query: Pick<WorldQueryServer, "start" | "attachLease" | "detachLease" | "leasedUrl">;
  actions: ConversationActionLifecycle;
  jobs: NonNullable<RetrievalDeps["getJobs"]>;
  exports: NonNullable<RetrievalDeps["getExports"]>;
  actionExports: NonNullable<NonNullable<Parameters<typeof prepareWorldChatActions>[3]>["getExports"]>;
  researchAllowed: NonNullable<RetrievalDeps["researchAllowed"]>;
  resolveLanguageModel: NonNullable<RunDeps["resolveLanguageModel"]>;
  onTurnFailed: NonNullable<RunDeps["onTurnFailed"]>;
  onProgress: NonNullable<RunDeps["onProgress"]>;
}

/**
 * Assemble the existing writing state machine without Coordinator or UI events.
 * This first extraction still uses a local WorldStore; it is not a cloud authoring API.
 * The caller owns runner caching and shutdown, and supplies host policy and tool delivery.
 */
export function conversationRunDependencies(store: WorldStore, deps: ConversationRunDependencies): RunDeps {
  const leases = new QueryLeaseRegistry(() => deps.activeStore()?.worldId ?? null);
  const attachments = new WorldChatAttachmentStore(store.dir);
  const receipts = new Map<string, WorldChatCheckReceipt[]>();
  /** Which token each run is reading under, so releasing it stops resolving at the server too. */
  const tokenByRun = new Map<string, string>();
  const retrieval = new WorldChatRetrieval({
    leases,
    // The same window the prompt is budgeted from: a run that may be handed a whole library
    // should be able to page back through it as well.
    textBudgetChars: () =>
      Math.max(MAX_TEXT_PER_RUN_CHARS, budgetFor(deps.adapter?.knownInputTokenLimit?.() ?? undefined)),
    getBundle: () => deps.activeStore()?.getBundle() ?? null,
    getIndex: () => deps.activeStore()?.getIndex() ?? null,
    getPlans: (productionId) => listPlans(store, productionId),
    getJobs: () => deps.jobs(),
    getExports: () => deps.exports(),
    getChapterBody: async (productionId, chapterFile) => {
      try {
        const raw = await readFile(
          toExtendedLength(join(store.dir, "productions", productionId, "chapters", `${chapterFile}.md`)),
          "utf8",
        );
        return MarkdownFile.parse(raw).body;
      } catch {
        return null;
      }
    },
    // The record beside a chapter (turn 129), for get_chapter: the bundle has only its stamp.
    getChapterContinuity: async (productionId, chapterFile) => {
      const record = await readContinuity(store, productionId, chapterFile);
      return record === "unreadable" ? null : record;
    },
    getChapterVoices: async (productionId, chapterFile) => {
      const record = await readVoices(store, productionId, chapterFile);
      return record === "unreadable" ? null : record;
    },
    attachments,
    findAttachment: async (lease, id) => {
      const loaded = await new WorldChatService(store.dir).load(lease.conversationId);
      return loaded?.attachments.find((a) => a.id === id) ?? null;
    },
    researchAllowed: deps.researchAllowed,
  });

  const actionLifecycle = deps.actions;
  const summarise = deps.adapter?.readiness().ready
    ? makeConversationSummariser(
        deps.adapter,
        deps.sessionInput,
        deps.summaryDir,
      )
    : undefined;
  return {
    closingSignal: store.closingSignal,
    adapter: deps.adapter ?? null,
    /*
     * A look can only be rewritten by something that can read it — see currentLookContext.
     *
     * From this runner's own world, not from whichever store happens to be open: a turn can
     * still be reading when somebody opens another world, and the provider's selection would
     * have followed them. That would put world B's look, verbatim, in world A's prompt — one
     * world's content shown while talking about another, and an invitation to rewrite A's look
     * into B's words.
     */
    worldContext: () => currentLookContext(store.getBundle().artDirection),
    // A turn held to a passage or to a reply fences this runner's own world first (codex on
    // PR 903), for the same reason as the look above: never whichever world is open now.
    raiseSchemaBoundary: (version) => store.raiseSchemaBoundary(version, "world-chat-constraints"),
    // Read at the same instant as the look above, and from the same world, so what a draft
    // says it was based on is what the model was actually shown — the words as well as the
    // number, because a derived look is v1 however often the world's tone is edited under it.
    artDirectionLook: () => {
      const look = store.getBundle().artDirection;
      return { version: look.version, description: look.description };
    },
    /*
     * Straight off the disk, and from this runner's own world for the same reason as above.
     *
     * Not from the bundle: `bible.md` is the one authored file the app expects to be edited
     * outside it, and the Studio's own edits land mid-conversation. The bundle is refreshed by
     * a rescan, and a turn assembled between an edit and that rescan would show the model a
     * bible one version behind the one it is about to be checked against — which fails the
     * write it was meant to enable.
     */
    bible: async () => {
      const current = await readBible(store.dir);
      return { version: current.version, text: current.text };
    },
    validateBibleEdits: async ({ edits, baseVersion }) => {
      const current = await readBible(store.dir);
      if (current.version !== baseVersion) throw new BibleStaleError(baseVersion, current.version);
      applyBibleEdits(current.text, edits);
    },
    validateEditorRequests: async ({ conversationId, entryContext, requests }) => {
      await stageEditorRequests(store, { conversationId, entryContext, requests, now: store.now(), dryRun: true });
    },
    sceneVersion: (context) => sceneVersionFor(store, context),
    validateSceneEdits: ({ entryContext, edits, baseVersion }) =>
      applySceneEdits(store, { entryContext, edits, baseVersion, dryRun: true }),
    prepareActions: (turn) => prepareWorldChatActions(store, actionLifecycle, turn, {
      getExports: () => deps.actionExports(),
    }),
    bindActions: async (actions) => {
      // Every binding appends to the same conversation, and proposal staging is also guarded per
      // conversation. Run them in turn; any failed intent remains durable for startup recovery.
      for (const action of actions) {
        await actionLifecycle.bindIntent(action.intent, action.payload).catch(() => {});
      }
    },
    ...(summarise ? { summarise } : {}),
    prepare: async ({ conversationId, runId, attachmentIds }) => {
      const lease = leases.mint({
        worldId: store.worldId,
        conversationId,
        runId,
        allowedAttachmentIds: attachmentIds,
      });
      /*
       * Started, not merely asked for.
       *
       * `leasedUrl` answers null until the server is up, and this was the only authoring flow
       * that never started it — so whether World Chat could look anything up depended on
       * whether some other flow had happened to start it first. Open a world and go straight to
       * a conversation and the agent had no arke-world tools at all: it could not find the sheet
       * behind a name, so it could not target an edit at one, and it said so rather than
       * guessing an id. Every other caller starts the server before taking a URL from it.
       */
      await deps.query.start().catch(() => {
        /* a turn without retrieval is worse than one with it, and better than no turn at all */
      });
      /*
       * The run's reads, reachable (#70 §8.2).
       *
       * Registering the lease with the server is what makes the URL below answer anything: it
       * routes `/mcp/<token>` to this conversation's retrieval and records every receipt against
       * the run that earned it. Without it the address was live and every request 404'd.
       */
      deps.query.attachLease(lease.token, {
        retrieval,
        onReceipt: (receipt) => {
          const seen = receipts.get(receipt.runId) ?? [];
          receipts.set(receipt.runId, [...seen, receipt]);
        },
      });
      tokenByRun.set(runId, lease.token);
      // Without a configured app root — a dev or test coordinator — the OS temp directory
      // still satisfies what §8.2 actually requires: somewhere outside the world.
      const cwd = await createRunScratch({ appRoot: deps.scratchRoot, conversationId, runId });
      return { cwd, leaseToken: lease.token };
    },
    release: async ({ conversationId, runId }) => {
      const token = tokenByRun.get(runId);
      if (token) {
        deps.query.detachLease(token);
        tokenByRun.delete(runId);
      }
      leases.revokeRun(runId);
      retrieval.forgetRun(runId);
      receipts.delete(runId);
      await removeRunScratch(deps.scratchRoot, conversationId, runId);
    },
    chapterBrief: ({ leaseToken, productionId, chapterId, budgetChars }) => chapterDraftingBrief(
      store.getBundle(), productionId, chapterId, async (tool, args) => {
        const outcome = await retrieval.call(leaseToken, tool, args);
        const seen = receipts.get(outcome.receipt.runId) ?? [];
        receipts.set(outcome.receipt.runId, [...seen, outcome.receipt]);
        return outcome;
      }, budgetChars,
    ),
    setupBrief: ({ leaseToken, draft, budgetChars }) => productionSetupBrief(
      store.getBundle(), draft, async (tool, args) => {
        const outcome = await retrieval.call(leaseToken, tool, args);
        const seen = receipts.get(outcome.receipt.runId) ?? [];
        receipts.set(outcome.receipt.runId, [...seen, outcome.receipt]);
        return outcome;
      }, budgetChars,
    ),
    receiptsFor: (runId) => receipts.get(runId) ?? [],
    resolveLanguageModel: deps.resolveLanguageModel,
    createSession: ({ cwd, runId, model }) => {
      const token = tokenByRun.get(runId);
      const url = token ? (deps.query.leasedUrl(token) ?? undefined) : undefined;
      return createPreparedSession(
        deps.adapter!,
        cwd,
        deps.sessionInput({
          ...(url ? { worldQueryUrl: url } : {}),
          ...(model !== undefined ? { model } : {}),
        }),
        { purpose: "world-chat", agent: "world-builder" },
      );
    },
    runCheckPlan: async ({ draft, leaseToken }) => {
      const plan = planFor(draft);
      const produced: WorldChatCheckReceipt[] = [];
      /*
       * A call that failed is a check that could not run, not a check nobody asked for.
       *
       * Swallowing the error dropped its receipt, so the category stayed merely *missing* — and
       * missing reads as `partial`, which readiness refuses. The receipt the error carries makes
       * it `unavailable` instead, which deliberately does not block: a broken index is shown to
       * the person and left to their judgement rather than turned into a broken app (§9.4).
       */
      const run = async (tool: string, args: Record<string, unknown>) => {
        try {
          produced.push((await retrieval.call(leaseToken, tool, args)).receipt);
        } catch (err) {
          const receipt = (err as { receipt?: WorldChatCheckReceipt }).receipt;
          if (receipt) produced.push(receipt);
        }
      };

      for (const [category, query] of Object.entries(plan.queries)) {
        await run(category === "sheet-search" ? "search_sheets" : "search_canon", { query });
      }
      for (const target of plan.targets) {
        // Only the world's own entities have a tool to read them. The production records a
        // subject may now name (turn 95's fix) have no `get_entry`/`get_sheet` equivalent, so
        // they are skipped exactly as `world` is rather than reaching a nonexistent call.
        if (target.kind !== "canon" && target.kind !== "sheet") continue;
        const id = target.kind === "canon" ? target.entryId : target.sheetId;
        await run(target.kind === "canon" ? "get_entry" : "get_sheet", { id });
        /*
         * What else touches this entity, when the plan says the answer depends on it.
         *
         * `related-read` is required by `relationship.change` and satisfied by exactly one tool,
         * which nothing here ever called — so every relationship a conversation described stayed
         * `partial` for ever and could not be written. The classification existed, was proposed,
         * reached the rail, and refused with "there is not enough behind it to write it down".
         */
        if (plan.required.includes("related-read")) await run("related", { id });
      }
      // This runner's own world, for the same reason worldContext reads from it: the provider's
      // selection follows whatever the person opened while the turn was still running.
      return { receipts: produced, canonRevision: store.getBundle().meta.canonRevision };
    },
    describeEntry: (context) => describeEntryContext(context, store.getBundle()),
    onTurnFailed: deps.onTurnFailed,
    onProgress: deps.onProgress,
    evidenceSources: (messages) => ({
      messages,
      bundle: store.getBundle(),
      // The runner supplies these from the fold: it knows which attachments this run was
      // given, and reading every attachment a conversation ever had would be both wasteful
      // and wrong.
      attachments: [],
      attachmentText: new Map(),
    }),
    readAttachmentText: async (attachment) => {
      // Whole. What reaches the model is the prompt budget's decision, taken against the
      // window with every other section in view — not a per-document cut made before it.
      return attachments.readWholeText(attachment).catch(() => null);
    },
    // Whatever this run pulled through get_attachment_text, so a passage the model paged to is
    // quotable even though the prompt only ever inlined the document's opening.
    attachmentReadsFor: (runId) => retrieval.textReadBy(runId),
    now: () => new Date().toISOString(),
  };
}

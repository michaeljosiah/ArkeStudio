import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ConversationActionBindingSchema,
  ConversationActionDecisionSchema,
  ConversationActionPrepareIntentSchema,
  ConversationActionReceiptSchema,
  ConversationActionShownProjectionSchema,
  LOCAL_ACTOR_ID,
  newId,
  type ArkeReadObservation,
  type ConversationActionAuthorityBinding,
  type ConversationActionCard,
  type ConversationActionDecision,
  type ConversationActionDecisionResult,
  type ConversationActionId,
  type ConversationActionPrepareIntent,
  type ConversationActionReceipt,
  type ConversationActionShownProjection,
  type ConversationActionStatus,
  type ConversationActionTarget,
  type ConversationId,
  type DecideConversationAction,
  type TurnId,
  type WorldChatEventEnvelope,
} from "@arke-studio/contracts";
import { findArkeAction } from "./registry.js";
import { conversationActionDigest, stableJson } from "./digest.js";
import { readConversationActionTombstones } from "./tombstones.js";
import { foldConversation } from "../world-chat/fold.js";
import {
  ConversationSequenceError,
  conversationDir,
  conversationsDir,
  WorldChatStore,
} from "../world-chat/store.js";

export { conversationActionDigest } from "./digest.js";

export interface PreparedConversationActionAuthority {
  readonly authority: ConversationActionAuthorityBinding;
  readonly authorityRevision: number;
  readonly shown: ConversationActionShownProjection;
  readonly approvalBlockedReason?: string;
}

export type ConversationActionValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "stale" | "blocked"; readonly detail: string };

export interface ConversationActionExecutionOutcome {
  readonly status: "awaiting-host" | "queued" | "running" | "completed" | "failed" | "cancelled" | "stale";
  readonly detail?: string;
  readonly receipt?: ConversationActionReceipt;
}

/**
 * A narrow seam into an existing authority. `execute` must use `action.actionId` as its
 * idempotency key; recovery is allowed to call it again after a crash hid the first result.
 */
export interface ConversationActionAuthorityAdapter {
  readonly actionKind: string;
  prepare?(input: {
    readonly intent: ConversationActionPrepareIntent;
    readonly payload: unknown;
  }): Promise<PreparedConversationActionAuthority>;
  recoverPreparation?(
    intent: ConversationActionPrepareIntent,
  ): Promise<PreparedConversationActionAuthority | null>;
  /** Best-effort cleanup when an interrupted intent has no binding that can be recovered. */
  abandonPreparation?(intent: ConversationActionPrepareIntent): Promise<void>;
  validate(action: ConversationActionCard): Promise<ConversationActionValidation>;
  execute(action: ConversationActionCard): Promise<ConversationActionExecutionOutcome>;
  /** Finish renderer-owned work after `execute` deliberately returned `awaiting-host`. */
  completeHost?(action: ConversationActionCard, payload: unknown): Promise<ConversationActionExecutionOutcome>;
  /** Idempotently settle authority-owned preparation after the local actor's denial is durable. */
  deny?(action: ConversationActionCard): Promise<void>;
  /** Null means the authority still has exactly the projected status. */
  reconcile?(action: ConversationActionCard): Promise<ConversationActionExecutionOutcome | null>;
  /** The exact authority-owned inverse available after successful execution. */
  undo?(action: ConversationActionCard): { readonly kind: string; readonly id: string } | null;
}

export interface PrepareConversationActionInput {
  readonly actionId?: ConversationActionId;
  readonly conversationId: ConversationId;
  readonly turnId: TurnId;
  readonly worldId: string;
  readonly productionId?: string;
  readonly actionKind: string;
  readonly targets: readonly ConversationActionTarget[];
  readonly payload: unknown;
  readonly baseObservations: readonly ArkeReadObservation[];
  readonly dependencies?: readonly ConversationActionId[];
  readonly createdAt?: string;
}

export class ConversationActionPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationActionPreparationError";
  }
}

function terminal(status: ConversationActionStatus): boolean {
  return ["completed", "failed", "cancelled", "denied", "stale", "superseded"].includes(status);
}

function boundedDetail(detail: string, fallback: string): string {
  return detail.trim().slice(0, 1_000) || fallback;
}

function transitionAllowed(from: ConversationActionStatus, to: ConversationActionStatus): boolean {
  const transitions: Record<ConversationActionStatus, readonly ConversationActionStatus[]> = {
    pending: ["completed", "failed", "cancelled", "stale"],
    approved: ["awaiting-host", "queued", "running", "completed", "failed", "cancelled", "stale"],
    "awaiting-host": ["completed", "failed", "cancelled", "stale"],
    queued: ["running", "completed", "failed", "cancelled"],
    running: ["completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
    denied: [],
    stale: [],
    superseded: [],
  };
  return transitions[from].includes(to);
}

function isSameDecisionRequest(
  actionId: ConversationActionId,
  decision: ConversationActionDecision,
  input: DecideConversationAction,
): boolean {
  return actionId === input.actionId &&
    decision.requestId === input.requestId &&
    decision.decision === input.decision &&
    decision.expectedConversationSeq === input.expectedConversationSeq &&
    decision.expectedStatus === input.expectedStatus;
}

function actionMatchesIntent(
  action: ConversationActionCard,
  intent: ConversationActionPrepareIntent,
): boolean {
  return action.actionId === intent.actionId &&
    action.conversationId === intent.conversationId &&
    action.turnId === intent.turnId &&
    action.worldId === intent.worldId &&
    action.productionId === intent.productionId &&
    action.actorId === intent.actorId &&
    action.scope === intent.scope &&
    action.actionKind === intent.actionKind &&
    action.authorityKind === intent.authorityKind &&
    action.cardFamily === intent.cardFamily &&
    action.payloadDigest === intent.payloadDigest &&
    action.createdAt === intent.createdAt &&
    stableJson(action.targets) === stableJson(intent.targets) &&
    stableJson(action.baseObservations) === stableJson(intent.baseObservations) &&
    stableJson(action.dependencies) === stableJson(intent.dependencies);
}

function adaptersByKind(
  adapters: readonly ConversationActionAuthorityAdapter[],
): ReadonlyMap<string, ConversationActionAuthorityAdapter> {
  const map = new Map<string, ConversationActionAuthorityAdapter>();
  for (const adapter of adapters) {
    if (map.has(adapter.actionKind)) throw new Error(`Conversation action adapter repeated ${adapter.actionKind}`);
    map.set(adapter.actionKind, adapter);
  }
  return map;
}

const preparations = new Map<string, Promise<void>>();
const executions = new Map<string, Promise<void>>();

async function serialise<T>(
  operations: Map<string, Promise<void>>,
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = operations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => {
    release = resolveHeld;
  });
  const tail = previous.catch(() => {}).then(() => held);
  operations.set(key, tail);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (operations.get(key) === tail) operations.delete(key);
  }
}

export interface ConversationActionLifecycleOptions {
  /** Resolved for each write because archiving moves the world during an approved action. */
  readonly worldPath: string | (() => string);
  readonly worldId: string;
  readonly adapters?: readonly ConversationActionAuthorityAdapter[];
  readonly now?: () => string;
  /** The coordinator supplies this so an approval cannot outlive the world it was reviewed in. */
  readonly isWorldOpen?: () => boolean;
}

export class ConversationActionLifecycle {
  private readonly adapters: ReadonlyMap<string, ConversationActionAuthorityAdapter>;
  private readonly now: () => string;

  constructor(private readonly options: ConversationActionLifecycleOptions) {
    this.adapters = adaptersByKind(options.adapters ?? []);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async completeHostAction(input: {
    readonly conversationId: ConversationId;
    readonly actionId: ConversationActionId;
    readonly payload: unknown;
  }): Promise<boolean> {
    return serialise(executions, this.operationKey(input.actionId), async () => {
      const action = await this.loadAction(input.conversationId, input.actionId);
      if (!action || action.status !== "awaiting-host") return false;
      if (this.options.isWorldOpen && !this.options.isWorldOpen()) return false;
      const adapter = this.adapters.get(action.actionKind);
      if (!adapter?.completeHost) return false;
      let outcome: ConversationActionExecutionOutcome;
      try {
        outcome = await adapter.completeHost(action, input.payload);
      } catch {
        outcome = { status: "failed", detail: "The host could not finish the approved action." };
      }
      return this.appendOutcome(this.store(action.conversationId), action, outcome);
    });
  }

  /** Build an intent for inclusion in the same `turn.completed` append as the reply. */
  createIntent(input: PrepareConversationActionInput): ConversationActionPrepareIntent {
    if (input.worldId !== this.options.worldId) {
      throw new ConversationActionPreparationError("The action belongs to a different world.");
    }
    const descriptor = findArkeAction(input.actionKind);
    if (!descriptor || descriptor.classification !== "supported-by-arke") {
      throw new ConversationActionPreparationError("That action kind is not available to Arke.");
    }
    if (descriptor.support.preparation.state !== "available") {
      throw new ConversationActionPreparationError(descriptor.support.preparation.reason);
    }
    if (descriptor.support.reads.state !== "available") {
      throw new ConversationActionPreparationError(descriptor.support.reads.reason);
    }
    const payload = descriptor.schema.safeParse(input.payload);
    if (!payload.success) throw new ConversationActionPreparationError("The action payload is not valid for its registered kind.");
    if ("worldId" in payload.data && payload.data.worldId !== input.worldId) {
      throw new ConversationActionPreparationError("The action payload belongs to a different world.");
    }
    if (descriptor.scope === "production" && !input.productionId) {
      throw new ConversationActionPreparationError("A production action must name its production.");
    }
    if (
      input.productionId &&
      "productionId" in payload.data &&
      payload.data.productionId !== input.productionId
    ) {
      throw new ConversationActionPreparationError("The action payload belongs to a different production.");
    }
    const observed = new Set(
      input.baseObservations.filter((observation) => observation.complete).map((observation) => observation.requirement),
    );
    const missing = descriptor.requiredReads.find((requirement) => !observed.has(requirement));
    if (missing) throw new ConversationActionPreparationError(`The action is missing a complete ${missing} observation.`);

    return ConversationActionPrepareIntentSchema.parse({
      actionId: input.actionId ?? newId("act"),
      conversationId: input.conversationId,
      turnId: input.turnId,
      worldId: input.worldId,
      ...(input.productionId ? { productionId: input.productionId } : {}),
      actorId: LOCAL_ACTOR_ID,
      scope: descriptor.scope,
      actionKind: descriptor.kind,
      authorityKind: descriptor.authority,
      cardFamily: descriptor.cardFamily,
      targets: input.targets,
      payloadDigest: conversationActionDigest(payload.data),
      baseObservations: input.baseObservations,
      dependencies: input.dependencies ?? [],
      createdAt: input.createdAt ?? this.now(),
    });
  }

  /** Prepare outside a model turn. Turn completion should use `createIntent` and `bindIntent`. */
  async prepare(input: PrepareConversationActionInput): Promise<ConversationActionCard> {
    const intent = this.createIntent(input);
    return serialise(preparations, this.operationKey(intent.actionId), async () => {
      const store = this.store(intent.conversationId);
      if (!(await store.readMeta())) throw new ConversationActionPreparationError("That conversation does not exist.");
      await this.assertActionIdAvailable(intent);
      for (;;) {
        if (!(await store.readMeta())) {
          throw new ConversationActionPreparationError("That conversation does not exist.");
        }
        const events = (await store.read()).events;
        if (events.some((envelope) => envelope.event.type === "deletion.intent-recorded")) {
          throw new ConversationActionPreparationError("That conversation is being deleted.");
        }
        try {
          const appended = await store.append(
            { type: "action.prepare-intent", intent },
            {
              at: intent.createdAt,
              requestId: `action-prepare:${intent.actionId}`,
              expectedSeq: events.at(-1)?.seq ?? 0,
            },
          );
          if (
            appended.envelope.event.type !== "action.prepare-intent" ||
            stableJson(appended.envelope.event.intent) !== stableJson(intent)
          ) {
            throw new ConversationActionPreparationError(
              "That action ID was already used by a different preparation intent.",
            );
          }
          break;
        } catch (error) {
          if (error instanceof ConversationSequenceError) continue;
          throw error;
        }
      }
      return this.bindIntentUnserialised(intent, input.payload);
    });
  }

  /** Finish an intent already made durable by `turn.completed`. */
  async bindIntent(intent: ConversationActionPrepareIntent, payload: unknown): Promise<ConversationActionCard> {
    return serialise(
      preparations,
      this.operationKey(intent.actionId),
      () => this.bindIntentUnserialised(intent, payload),
    );
  }

  private async bindIntentUnserialised(
    intent: ConversationActionPrepareIntent,
    payload: unknown,
  ): Promise<ConversationActionCard> {
    const store = this.store(intent.conversationId);
    let adapter: ConversationActionAuthorityAdapter | undefined;
    let preparationAttempted = false;
    let bindingAppendAttempted = false;
    let recordFailure = true;
    try {
      if (!(await store.readMeta())) {
        recordFailure = false;
        throw new ConversationActionPreparationError("That conversation does not exist.");
      }
      const events = (await store.read()).events;
      if (events.some((envelope) => envelope.event.type === "deletion.intent-recorded")) {
        recordFailure = false;
        throw new ConversationActionPreparationError("That conversation is being deleted.");
      }
      const durableIntent = events.flatMap((envelope) => {
        const event = envelope.event;
        if (event.type === "action.prepare-intent") return [event.intent];
        return event.type === "turn.completed"
          ? (event.actionPrepareIntents ?? []).filter((one) => one.turnId === event.message.turnId)
          : [];
      }).find((one) => one.actionId === intent.actionId);
      if (!durableIntent) {
        recordFailure = false;
        throw new ConversationActionPreparationError("The preparation intent is not durable.");
      }
      if (stableJson(durableIntent) !== stableJson(intent)) {
        throw new ConversationActionPreparationError("The preparation intent differs from its durable record.");
      }
      await this.assertActionIdAvailable(durableIntent);
      this.validateRegisteredIntent(durableIntent);
      const descriptor = findArkeAction(intent.actionKind);
      if (!descriptor || descriptor.classification !== "supported-by-arke") {
        throw new ConversationActionPreparationError("The durable intent no longer matches its registered action.");
      }
      const parsed = descriptor.schema.safeParse(payload);
      if (!parsed.success || conversationActionDigest(parsed.data) !== intent.payloadDigest) {
        throw new ConversationActionPreparationError("The payload no longer matches the durable preparation intent.");
      }
      if (
        ("worldId" in parsed.data && parsed.data.worldId !== intent.worldId) ||
        (intent.productionId && "productionId" in parsed.data && parsed.data.productionId !== intent.productionId)
      ) {
        throw new ConversationActionPreparationError("The payload belongs to a different action scope.");
      }
      const existing = foldConversation(intent.conversationId, (await store.readMeta())!.createdAt, events)
        .view.actions.find((action) => action.actionId === intent.actionId);
      if (existing) {
        if (actionMatchesIntent(existing, intent)) return existing;
        throw new ConversationActionPreparationError("That action ID was already bound to different immutable content.");
      }
      if (events.some((envelope) =>
        envelope.event.type === "action.prepare-failed" && envelope.event.actionId === intent.actionId
      )) {
        recordFailure = false;
        throw new ConversationActionPreparationError("That action preparation has already failed. Prepare it again.");
      }
      this.validateDependencies(durableIntent, events);
      adapter = this.adapters.get(intent.actionKind);
      if (!adapter?.prepare) {
        throw new ConversationActionPreparationError("No authority adapter can prepare this action.");
      }
      preparationAttempted = true;
      const prepared = await adapter.prepare({ intent: durableIntent, payload: parsed.data });
      return await this.recordPrepared(store, durableIntent, prepared, () => {
        bindingAppendAttempted = true;
      });
    } catch (error) {
      const existing = await this.loadAction(intent.conversationId, intent.actionId).catch(() => undefined);
      if (existing && actionMatchesIntent(existing, intent)) return existing;
      if (existing) recordFailure = false;
      const detail = error instanceof ConversationActionPreparationError
        ? error.message
        : "The action authority could not prepare this action.";
      // Once the binding append starts, its bytes may already be durable even if the call throws.
      // Recovery, not cleanup, owns that uncertainty so it cannot discard a bound authority.
      let abandoned = !preparationAttempted;
      if (preparationAttempted && !bindingAppendAttempted) {
        abandoned = await adapter?.abandonPreparation?.(intent).then(() => true).catch(() => false) ?? false;
      }
      if (recordFailure && !bindingAppendAttempted && abandoned && await store.readMeta()) {
        await this.recordPreparationFailure(store, intent, detail);
      }
      throw error instanceof ConversationActionPreparationError
        ? error
        : new ConversationActionPreparationError(detail);
    }
  }

  async decide(input: DecideConversationAction): Promise<ConversationActionDecisionResult> {
    const base = {
      worldId: input.worldId,
      conversationId: input.conversationId,
      actionId: input.actionId,
      requestId: input.requestId,
      deduplicated: false,
    } as const;
    const refuse = (
      reason: NonNullable<ConversationActionDecisionResult["reason"]>,
      detail: string,
      status?: ConversationActionStatus,
    ): ConversationActionDecisionResult => ({
      ...base,
      disposition: "refused",
      reason,
      detail: boundedDetail(detail, "That action could not be decided."),
      ...(status ? { status } : {}),
    });

    if (input.worldId !== this.options.worldId) {
      return refuse("wrong-world", "That action belongs to a different open world.");
    }
    if (this.options.isWorldOpen && !this.options.isWorldOpen()) {
      return refuse("wrong-world", "That world is no longer open.");
    }
    const store = this.store(input.conversationId);
    const meta = await store.readMeta();
    if (!meta) return refuse("unknown-conversation", "That conversation is no longer available.");
    const events = (await store.read()).events;
    const existingRequest = events.find((event) => event.requestId === input.requestId);
    if (existingRequest) {
      if (
        existingRequest.event.type !== "action.decision-recorded" ||
        !isSameDecisionRequest(existingRequest.event.actionId, existingRequest.event.decision, input)
      ) {
        return refuse("request-conflict", "That request ID was already used for a different operation.");
      }
      const existing = foldConversation(meta.id, meta.createdAt, events).view.actions.find(
        (action) => action.actionId === input.actionId,
      );
      if (existing?.worldId !== undefined && existing.worldId !== input.worldId) {
        return refuse("wrong-world", "That action belongs to a different world.", existing.status);
      }
      if (existing?.status === "approved") {
        const adapter = this.adapters.get(existing.actionKind);
        if (adapter) await this.continueApproved(existing, adapter, true);
      }
      if (existing?.status === "completed") await this.linkAvailableUndo(existing);
      if (existing?.status === "denied") await this.settleDenied(existing);
      const current = await this.loadAction(input.conversationId, input.actionId);
      return {
        ...base,
        disposition: "recorded",
        decision: input.decision,
        ...((current ?? existing) ? { status: (current ?? existing)!.status } : {}),
        deduplicated: true,
      };
    }

    const loaded = foldConversation(meta.id, meta.createdAt, events).view;
    const action = loaded.actions.find((one) => one.actionId === input.actionId);
    if (!action) {
      const owner = await this.findActionConversation(input.actionId);
      return owner && owner !== input.conversationId
        ? refuse("wrong-conversation", "That action belongs to a different conversation.")
        : refuse("unknown-action", "That action is no longer available.");
    }
    if (action.worldId !== input.worldId) {
      return refuse("wrong-world", "That action belongs to a different world.", action.status);
    }
    if (loaded.seq !== input.expectedConversationSeq) {
      return refuse("sequence-mismatch", "The conversation changed. Review the latest card and try again.", action.status);
    }
    if (action.status !== input.expectedStatus) {
      return refuse("status-mismatch", `That action is ${action.status}, not ${input.expectedStatus}.`, action.status);
    }
    if (action.actorId !== LOCAL_ACTOR_ID) {
      return refuse("actor-mismatch", "That action does not belong to the current local actor.", action.status);
    }
    if (input.decision === "approve" && input.expectedStatus !== "pending") {
      return refuse("stale", "That action is stale. Prepare it again before approving.", action.status);
    }

    if (input.decision === "deny") {
      // The person's decision is the source of truth. Cleanup follows it so a crash cannot remove
      // the authority while leaving an approvable card; duplicate requests and restart retry it.
      const denied = await this.recordDecision(store, input, (await this.loadConversation(input.conversationId)).seq);
      const durable = await this.loadAction(input.conversationId, input.actionId);
      if (denied.disposition === "recorded" && durable?.status === "denied") {
        await this.settleDenied(durable);
      }
      return denied;
    }
    if (action.status === "stale") {
      return refuse("stale", "That action is stale. Prepare it again before approving.", action.status);
    }
    const dependency = action.dependencies
      .map((id) => loaded.actions.find((one) => one.actionId === id))
      .find((one) => one?.status !== "completed");
    if (dependency || action.dependencies.some((id) => !loaded.actions.some((one) => one.actionId === id))) {
      return refuse("dependency-blocked", "A required action has not completed successfully.", action.status);
    }
    if (action.approvalBlockedReason) {
      return refuse("adapter-unavailable", action.approvalBlockedReason, action.status);
    }

    const descriptor = findArkeAction(action.actionKind);
    const adapter = this.adapters.get(action.actionKind);
    if (
      !descriptor ||
      descriptor.classification !== "supported-by-arke" ||
      descriptor.scope !== action.scope ||
      descriptor.authority !== action.authority.kind ||
      descriptor.cardFamily !== action.cardFamily ||
      descriptor.permissionReason !== action.shown.permissionReason
    ) {
      return refuse("authority-mismatch", "The registered authority no longer matches this card.", action.status);
    }
    if (descriptor.support.execution.state !== "available" || !adapter) {
      const detail = descriptor.support.execution.state === "blocked"
        ? descriptor.support.execution.reason
        : "No authority adapter can execute this action.";
      return refuse("adapter-unavailable", detail, action.status);
    }

    const validation = await adapter.validate(action).catch(() => ({
      ok: false as const,
      reason: "blocked" as const,
      detail: "The action authority could not validate this action.",
    }));
    if (!validation.ok) {
      if (validation.reason === "stale") {
        const detail = boundedDetail(validation.detail, "The action inputs changed after preparation.");
        try {
          await store.append(
            {
              type: "action.status-changed",
              actionId: action.actionId,
              expectedStatus: "pending",
              status: "stale",
              detail,
            },
            { at: this.now(), expectedSeq: loaded.seq },
          );
        } catch (error) {
          if (error instanceof ConversationSequenceError) {
            const current = await this.loadAction(input.conversationId, input.actionId);
            return refuse(
              "sequence-mismatch",
              "The conversation changed. Review the latest card and try again.",
              current?.status,
            );
          }
          throw error;
        }
        return refuse("stale", detail, "stale");
      }
      return refuse("validation-refused", validation.detail, action.status);
    }
    if (this.options.isWorldOpen && !this.options.isWorldOpen()) {
      return refuse("wrong-world", "That world is no longer open.", action.status);
    }

    const approved = await this.recordDecision(store, input, loaded.seq);
    if (approved.disposition === "refused" || approved.deduplicated) return approved;
    const durable = await this.loadAction(input.conversationId, input.actionId);
    if (durable?.status === "approved") await this.continueApproved(durable, adapter, false);
    const current = await this.loadAction(input.conversationId, input.actionId);
    return { ...approved, ...(current ? { status: current.status } : {}) };
  }

  async recordStatus(
    conversationId: ConversationId,
    actionId: ConversationActionId,
    status: ConversationActionExecutionOutcome["status"],
    options: {
      authority: ConversationActionAuthorityBinding;
      authorityRevision: number;
      detail?: string;
      receipt?: ConversationActionReceipt;
    },
  ): Promise<ConversationActionCard> {
    const store = this.store(conversationId);
    const action = await this.loadAction(conversationId, actionId);
    if (!action) throw new Error(`Unknown conversation action ${actionId}`);
    if (
      stableJson(action.authority) !== stableJson(options.authority) ||
      action.authorityRevision !== options.authorityRevision
    ) {
      throw new Error(`Conversation action ${actionId} belongs to a different authority binding`);
    }
    if (action.status === status) return action;
    if (!transitionAllowed(action.status, status)) throw new Error(`Cannot move ${actionId} from ${action.status} to ${status}`);
    await this.appendOutcome(store, action, { status, ...options });
    return (await this.loadAction(conversationId, actionId))!;
  }

  async supersede(
    conversationId: ConversationId,
    actionId: ConversationActionId,
    supersededBy: ConversationActionId,
    detail?: string,
  ): Promise<void> {
    const store = this.store(conversationId);
    const action = await this.loadAction(conversationId, actionId);
    if (!action || (action.status !== "pending" && action.status !== "stale")) {
      throw new Error(`Conversation action ${actionId} cannot be superseded`);
    }
    const replacement = await this.loadAction(conversationId, supersededBy);
    if (!replacement || replacement.actionId === actionId) {
      throw new Error(`Replacement conversation action ${supersededBy} does not exist`);
    }
    await store.append(
      {
        type: "action.superseded",
        actionId,
        supersededBy,
        ...(detail ? { detail: boundedDetail(detail, "This action was replaced.") } : {}),
      },
      { at: this.now(), expectedSeq: (await this.loadConversation(conversationId)).seq },
    );
  }

  async linkUndo(
    conversationId: ConversationId,
    actionId: ConversationActionId,
    undo: { kind: string; id: string },
  ): Promise<void> {
    const store = this.store(conversationId);
    for (;;) {
      const meta = await store.readMeta();
      if (!meta) throw new Error(`Conversation action ${actionId} is not available`);
      const events = (await store.read()).events;
      if (events.some((envelope) => envelope.event.type === "deletion.intent-recorded")) {
        throw new Error(`Conversation action ${actionId} is being deleted`);
      }
      const loaded = foldConversation(meta.id, meta.createdAt, events).view;
      const action = loaded.actions.find((one) => one.actionId === actionId);
      if (!action || action.status !== "completed") throw new Error(`Conversation action ${actionId} is not completed`);
      if (action.undo) {
        if (action.undo.kind === undo.kind && action.undo.id === undo.id) return;
        throw new Error(`Conversation action ${actionId} already has a different undo link`);
      }
      try {
        await store.append(
          { type: "action.undo-linked", actionId, undo: { ...undo, linkedAt: this.now() } },
          {
            at: this.now(),
            requestId: `action-undo:${actionId}:${undo.kind}:${undo.id}`,
            expectedSeq: loaded.seq,
          },
        );
        return;
      } catch (error) {
        if (error instanceof ConversationSequenceError) continue;
        throw error;
      }
    }
  }

  /** Publish an authority's live outcome without dispatching or replaying the action. */
  async reconcileAction(conversationId: ConversationId, actionId: ConversationActionId): Promise<boolean> {
    return serialise(executions, this.operationKey(actionId), async () => {
      if (this.options.isWorldOpen && !this.options.isWorldOpen()) return false;
      const current = await this.loadAction(conversationId, actionId);
      if (!current || terminal(current.status)) return false;
      const adapter = this.adapters.get(current.actionKind);
      const authority = await adapter?.reconcile?.(current).catch(() => null) ?? null;
      return authority ? this.appendOutcome(this.store(conversationId), current, authority) : false;
    });
  }

  /** Reconcile unbound intents and authority-owned statuses after restart. */
  async recoverConversation(conversationId: ConversationId): Promise<ConversationActionRecoveryOutcome> {
    const store = this.store(conversationId);
    const meta = await store.readMeta();
    const outcome: ConversationActionRecoveryOutcome = { prepared: 0, reconciled: 0, failed: 0 };
    if (!meta) return outcome;
    let events = (await store.read()).events;
    const intents = new Map<string, ConversationActionPrepareIntent>();
    const settledIntents = new Set<string>();
    for (const envelope of events) {
      const event = envelope.event;
      if (event.type === "turn.completed") {
        for (const intent of event.actionPrepareIntents ?? []) {
          if (intent.turnId !== event.message.turnId) continue;
          if (!intents.has(intent.actionId)) intents.set(intent.actionId, intent);
        }
      } else if (event.type === "action.prepare-intent" && !intents.has(event.intent.actionId)) {
        intents.set(event.intent.actionId, event.intent);
      }
      else if (event.type === "action.prepared" || event.type === "action.prepare-failed") {
        settledIntents.add(event.type === "action.prepared" ? event.binding.actionId : event.actionId);
      }
    }

    for (const intent of intents.values()) {
      if (settledIntents.has(intent.actionId)) continue;
      await serialise(preparations, this.operationKey(intent.actionId), async () => {
        const currentEvents = (await store.read()).events;
        if (currentEvents.some((envelope) =>
          (envelope.event.type === "action.prepared" && envelope.event.binding.actionId === intent.actionId) ||
          (envelope.event.type === "action.prepare-failed" && envelope.event.actionId === intent.actionId)
        )) return;

        const adapter = this.adapters.get(intent.actionKind);
        if (!adapter?.recoverPreparation) return;
        let bindingAppendAttempted = false;
        let recoveryAttempted = false;
        try {
          await this.assertActionIdAvailable(intent);
          this.validateRegisteredIntent(intent);
          this.validateDependencies(intent, currentEvents);
          recoveryAttempted = true;
          const prepared = await adapter.recoverPreparation(intent);
          if (prepared) {
            await this.recordPrepared(store, intent, prepared, () => {
              bindingAppendAttempted = true;
            });
            outcome.prepared++;
            return;
          }
          if (!adapter.abandonPreparation) return;
          await adapter.abandonPreparation(intent);
          await this.recordPreparationFailure(
            store,
            intent,
            "Preparation was interrupted before an authoritative binding became durable.",
          );
          outcome.failed++;
        } catch (error) {
          const existing = await this.loadAction(intent.conversationId, intent.actionId).catch(() => undefined);
          if (existing && actionMatchesIntent(existing, intent)) return;
          if (existing) throw error;
          // An uncertain append is left as an open intent. The next recovery pass can inspect its
          // bytes; declaring failure now could discard an authority whose binding is already down.
          if (bindingAppendAttempted) throw error;
          if (recoveryAttempted) {
            const abandoned = await adapter.abandonPreparation?.(intent)
              .then(() => true)
              .catch(() => false) ?? false;
            if (!abandoned) return;
          }
          const detail = error instanceof ConversationActionPreparationError
            ? error.message
            : "The action authority could not recover interrupted preparation.";
          await this.recordPreparationFailure(store, intent, detail);
          outcome.failed++;
        }
      });
    }

    events = (await store.read()).events;
    const actions = foldConversation(meta.id, meta.createdAt, events).view.actions;
    for (const action of actions) {
      if (action.status === "denied") {
        await this.settleDenied(action);
        continue;
      }
      if (terminal(action.status)) {
        if (action.status === "completed") await this.linkAvailableUndo(action);
        continue;
      }
      const adapter = this.adapters.get(action.actionKind);
      if (!adapter) continue;
      if (action.status === "approved") {
        if (await this.continueApproved(action, adapter, true)) outcome.reconciled++;
        continue;
      }
      const reconciled = await this.reconcileAction(action.conversationId, action.actionId);
      if (reconciled) outcome.reconciled++;
    }
    return outcome;
  }

  private store(conversationId: ConversationId): WorldChatStore {
    return new WorldChatStore(conversationDir(this.worldPath(), conversationId));
  }

  private operationKey(actionId: ConversationActionId): string {
    const worldPath = resolve(this.worldPath());
    return `${process.platform === "win32" ? worldPath.toLowerCase() : worldPath}:${actionId}`;
  }

  private worldPath(): string {
    return typeof this.options.worldPath === "function" ? this.options.worldPath() : this.options.worldPath;
  }

  private async settleDenied(action: ConversationActionCard): Promise<void> {
    const adapter = this.adapters.get(action.actionKind);
    if (!adapter?.deny) return;
    await serialise(executions, this.operationKey(action.actionId), async () => {
      const current = await this.loadAction(action.conversationId, action.actionId);
      if (current?.status === "denied") await adapter.deny!(current);
    }).catch(() => {
      /* the durable denial remains authoritative; startup or a duplicate request retries cleanup */
    });
  }

  private async linkAvailableUndo(action: ConversationActionCard): Promise<void> {
    if (action.status !== "completed" || action.undo) return;
    const undo = this.adapters.get(action.actionKind)?.undo?.(action);
    if (undo) await this.linkUndo(action.conversationId, action.actionId, undo);
  }

  private async assertActionIdAvailable(intent: ConversationActionPrepareIntent): Promise<void> {
    const owner = await this.findActionConversation(intent.actionId);
    if (owner && owner !== intent.conversationId) {
      throw new ConversationActionPreparationError("That action ID already belongs to a different conversation.");
    }
    const deleted = (await readConversationActionTombstones(this.worldPath()))
      .some((tombstone) => tombstone.actionId === intent.actionId);
    if (deleted) {
      throw new ConversationActionPreparationError("That action ID belongs to a deleted conversation.");
    }
  }

  private validateRegisteredIntent(intent: ConversationActionPrepareIntent): void {
    const descriptor = findArkeAction(intent.actionKind);
    if (
      intent.worldId !== this.options.worldId ||
      intent.actorId !== LOCAL_ACTOR_ID ||
      !descriptor ||
      descriptor.classification !== "supported-by-arke" ||
      descriptor.scope !== intent.scope ||
      descriptor.authority !== intent.authorityKind ||
      descriptor.cardFamily !== intent.cardFamily ||
      (descriptor.scope === "production" && !intent.productionId)
    ) {
      throw new ConversationActionPreparationError("The durable intent no longer matches its registered action.");
    }
    const observed = new Set(
      intent.baseObservations
        .filter((observation) => observation.complete)
        .map((observation) => observation.requirement),
    );
    const missing = descriptor.requiredReads.find((requirement) => !observed.has(requirement));
    if (missing) {
      throw new ConversationActionPreparationError(`The action is missing a complete ${missing} observation.`);
    }
  }

  private validateDependencies(
    intent: ConversationActionPrepareIntent,
    events: readonly WorldChatEventEnvelope[],
  ): void {
    const intents = new Map<string, ConversationActionPrepareIntent>();
    for (const envelope of events) {
      const event = envelope.event;
      if (event.type === "action.prepare-intent" && !intents.has(event.intent.actionId)) {
        intents.set(event.intent.actionId, event.intent);
      }
      if (event.type === "turn.completed") {
        for (const one of event.actionPrepareIntents ?? []) {
          if (one.turnId !== event.message.turnId) continue;
          if (!intents.has(one.actionId)) intents.set(one.actionId, one);
        }
      }
    }
    const known = new Set(intents.keys());
    if (new Set(intent.dependencies).size !== intent.dependencies.length) {
      throw new ConversationActionPreparationError("An action cannot repeat the same dependency.");
    }
    for (const dependency of intent.dependencies) {
      if (dependency === intent.actionId) {
        throw new ConversationActionPreparationError("An action cannot depend on itself.");
      }
      if (!known.has(dependency)) {
        throw new ConversationActionPreparationError(`Dependency ${dependency} is not in this conversation.`);
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (actionId: string): boolean => {
      if (visiting.has(actionId)) return true;
      if (visited.has(actionId)) return false;
      visiting.add(actionId);
      for (const dependency of intents.get(actionId)?.dependencies ?? []) {
        if (visit(dependency)) return true;
      }
      visiting.delete(actionId);
      visited.add(actionId);
      return false;
    };
    if (visit(intent.actionId)) {
      throw new ConversationActionPreparationError("Conversation action dependencies contain a cycle.");
    }
  }

  private async recordPrepared(
    store: WorldChatStore,
    intent: ConversationActionPrepareIntent,
    prepared: PreparedConversationActionAuthority,
    beforeAppend?: () => void,
  ): Promise<ConversationActionCard> {
    const descriptor = findArkeAction(intent.actionKind);
    if (!descriptor || descriptor.classification !== "supported-by-arke") {
      throw new ConversationActionPreparationError("The registered action kind is no longer available.");
    }
    const shown = ConversationActionShownProjectionSchema.parse(prepared.shown);
    if (
      prepared.authority.kind !== intent.authorityKind ||
      shown.body.family !== intent.cardFamily ||
      shown.permissionReason !== descriptor.permissionReason ||
      shown.affectedTargets.length !== intent.targets.length ||
      intent.targets.some(
        (target) => !shown.affectedTargets.some((shownTarget) =>
          shownTarget.kind === target.kind && shownTarget.id === target.id),
      )
    ) {
      throw new ConversationActionPreparationError("The authority binding does not match the registered action.");
    }
    const binding = ConversationActionBindingSchema.parse({
      ...intent,
      authority: prepared.authority,
      authorityRevision: prepared.authorityRevision,
      previewDigest: conversationActionDigest(shown),
      shown,
      status: "pending",
      preparedAt: this.now(),
      ...(descriptor.support.execution.state === "blocked"
        ? { approvalBlockedReason: descriptor.support.execution.reason }
        : prepared.approvalBlockedReason
          ? { approvalBlockedReason: prepared.approvalBlockedReason }
          : {}),
    });
    beforeAppend?.();
    const appended = await store.append(
      { type: "action.prepared", binding },
      { at: binding.preparedAt, requestId: `action-prepared:${binding.actionId}` },
    );
    if (
      appended.envelope.event.type !== "action.prepared" ||
      stableJson(appended.envelope.event.binding) !== stableJson(binding)
    ) {
      throw new ConversationActionPreparationError("That action ID was already bound to different immutable content.");
    }
    return (await this.loadAction(intent.conversationId, intent.actionId))!;
  }

  private async recordPreparationFailure(
    store: WorldChatStore,
    intent: ConversationActionPrepareIntent,
    detail: string,
  ): Promise<void> {
    const safeDetail = boundedDetail(detail, "The action authority could not prepare this action.");
    const appended = await store.append(
      { type: "action.prepare-failed", actionId: intent.actionId, detail: safeDetail },
      { at: this.now(), requestId: `action-prepare-failed:${intent.actionId}` },
    );
    if (
      appended.envelope.event.type !== "action.prepare-failed" ||
      appended.envelope.event.actionId !== intent.actionId
    ) {
      throw new ConversationActionPreparationError("That action request ID was already used by another operation.");
    }
  }

  private continueApproved(
    action: ConversationActionCard,
    adapter: ConversationActionAuthorityAdapter,
    reconcileFirst: boolean,
  ): Promise<boolean> {
    return serialise(executions, this.operationKey(action.actionId), async () => {
      const current = await this.loadAction(action.conversationId, action.actionId);
      if (!current || current.status !== "approved") return false;
      if (this.options.isWorldOpen && !this.options.isWorldOpen()) return false;

      if (reconcileFirst && adapter.reconcile) {
        const reconciled = await adapter.reconcile(current).catch(() => null);
        if (reconciled) return this.appendOutcome(this.store(current.conversationId), current, reconciled);
      }

      const validation = await adapter.validate(current).catch(() => ({
        ok: false as const,
        reason: "blocked" as const,
        detail: "The action authority could not validate this action.",
      }));
      if (!validation.ok) {
        return this.appendOutcome(this.store(current.conversationId), current, {
          status: validation.reason === "stale" ? "stale" : "failed",
          detail: validation.detail,
        });
      }
      if (this.options.isWorldOpen && !this.options.isWorldOpen()) return false;

      let outcome: ConversationActionExecutionOutcome;
      try {
        outcome = await adapter.execute(current);
      } catch {
        outcome = {
          status: "failed",
          detail: reconcileFirst
            ? "The approved action could not be resumed after restart."
            : "The authority failed while executing the approved action.",
        };
      }
      return this.appendOutcome(this.store(current.conversationId), current, outcome);
    });
  }

  private async recordDecision(
    store: WorldChatStore,
    input: DecideConversationAction,
    expectedSeq: number,
  ): Promise<ConversationActionDecisionResult> {
    const decision = ConversationActionDecisionSchema.parse({
      requestId: input.requestId,
      decision: input.decision,
      actorId: LOCAL_ACTOR_ID,
      expectedConversationSeq: input.expectedConversationSeq,
      expectedStatus: input.expectedStatus,
      decidedAt: this.now(),
    });
    try {
      const appended = await store.append(
        { type: "action.decision-recorded", actionId: input.actionId, decision },
        { at: decision.decidedAt, requestId: input.requestId, expectedSeq },
      );
      const action = await this.loadAction(input.conversationId, input.actionId);
      return {
        worldId: input.worldId,
        conversationId: input.conversationId,
        actionId: input.actionId,
        requestId: input.requestId,
        disposition: "recorded",
        decision: input.decision,
        ...(action ? { status: action.status } : {}),
        deduplicated: appended.deduplicated,
      };
    } catch (error) {
      if (error instanceof ConversationSequenceError) {
        const events = (await store.read()).events;
        const duplicate = events.find((event) => event.requestId === input.requestId);
        if (
          duplicate?.event.type === "action.decision-recorded" &&
          isSameDecisionRequest(duplicate.event.actionId, duplicate.event.decision, input)
        ) {
          const action = await this.loadAction(input.conversationId, input.actionId);
          return {
            worldId: input.worldId,
            conversationId: input.conversationId,
            actionId: input.actionId,
            requestId: input.requestId,
            disposition: "recorded",
            decision: input.decision,
            ...(action ? { status: action.status } : {}),
            deduplicated: true,
          };
        }
        return {
          worldId: input.worldId,
          conversationId: input.conversationId,
          actionId: input.actionId,
          requestId: input.requestId,
          disposition: "refused",
          reason: "sequence-mismatch",
          detail: "The conversation changed. Review the latest card and try again.",
          deduplicated: false,
        };
      }
      throw error;
    }
  }

  private async appendOutcome(
    store: WorldChatStore,
    action: ConversationActionCard,
    outcome: ConversationActionExecutionOutcome,
  ): Promise<boolean> {
    const receipt = outcome.receipt ? ConversationActionReceiptSchema.parse(outcome.receipt) : undefined;
    if (outcome.status === "completed" && !receipt) {
      throw new Error(`Completed conversation action ${action.actionId} requires an authority receipt`);
    }
    const detail = outcome.detail
      ? boundedDetail(outcome.detail, "The action authority reported a status change.")
      : undefined;
    for (;;) {
      const loaded = await this.loadConversation(action.conversationId);
      const current = loaded.actions.find((one) => one.actionId === action.actionId);
      if (!current || !transitionAllowed(current.status, outcome.status)) {
        if (current?.status === "completed") await this.linkAvailableUndo(current);
        return false;
      }
      try {
        const appended = await store.append(
          {
            type: "action.status-changed",
            actionId: action.actionId,
            expectedStatus: current.status,
            status: outcome.status,
            ...(detail ? { detail } : {}),
            ...(receipt ? { receipt } : {}),
          },
          {
            at: this.now(),
            requestId: `action-status:${action.actionId}:${current.status}:${outcome.status}`,
            expectedSeq: loaded.seq,
          },
        );
        if (outcome.status === "completed") {
          const completed = await this.loadAction(action.conversationId, action.actionId);
          if (completed) await this.linkAvailableUndo(completed);
        }
        return !appended.deduplicated;
      } catch (error) {
        if (error instanceof ConversationSequenceError) continue;
        throw error;
      }
    }
  }

  private async loadConversation(conversationId: ConversationId) {
    const store = this.store(conversationId);
    const meta = await store.readMeta();
    if (!meta) throw new ConversationActionPreparationError("That conversation does not exist.");
    return foldConversation(meta.id, meta.createdAt, (await store.read()).events).view;
  }

  private async loadAction(
    conversationId: ConversationId,
    actionId: ConversationActionId,
  ): Promise<ConversationActionCard | undefined> {
    return (await this.loadConversation(conversationId)).actions.find((action) => action.actionId === actionId);
  }

  private async findActionConversation(actionId: ConversationActionId): Promise<ConversationId | null> {
    const worldPath = this.worldPath();
    const root = conversationsDir(worldPath);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return null;
    }
    const claimedBy = async (dir: string): Promise<ConversationId | null> => {
      const store = new WorldChatStore(dir);
      const meta = await store.readMeta();
      if (!meta) return null;
      const events = (await store.read()).events;
      const claimed = events.some((envelope) => {
        const event = envelope.event;
        if (event.type === "action.prepare-intent") return event.intent.actionId === actionId;
        if (event.type === "action.prepared") return event.binding.actionId === actionId;
        if (event.type === "action.prepare-failed") return event.actionId === actionId;
        return event.type === "turn.completed" &&
          (event.actionPrepareIntents ?? []).some((intent) => intent.actionId === actionId);
      });
      return claimed ? meta.id : null;
    };
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const owner = await claimedBy(conversationDir(worldPath, entry as ConversationId));
      if (owner) return owner;
    }
    let deleted: string[] = [];
    try {
      deleted = await readdir(resolve(root, ".deleted"));
    } catch {
      /* No deletion is awaiting byte reclamation. */
    }
    for (const entry of deleted) {
      const owner = await claimedBy(resolve(root, ".deleted", entry));
      if (owner) return owner;
    }
    return null;
  }
}

export interface ConversationActionRecoveryOutcome {
  prepared: number;
  reconciled: number;
  failed: number;
}

export async function recoverConversationActions(
  options: ConversationActionLifecycleOptions,
): Promise<ConversationActionRecoveryOutcome> {
  const total: ConversationActionRecoveryOutcome = { prepared: 0, reconciled: 0, failed: 0 };
  let entries: string[];
  try {
    entries = await readdir(conversationsDir(typeof options.worldPath === "function" ? options.worldPath() : options.worldPath));
  } catch {
    return total;
  }
  const lifecycle = new ConversationActionLifecycle(options);
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const recovered = await lifecycle.recoverConversation(entry as ConversationId);
    total.prepared += recovered.prepared;
    total.reconciled += recovered.reconciled;
    total.failed += recovered.failed;
  }
  return total;
}

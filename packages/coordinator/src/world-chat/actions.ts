import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
  CanonEntrySchema,
  deriveArtDirectionDescription,
  SheetSchema,
  WorldMetaSchema,
  applyBibleEdits,
  sheetDir,
  splitBible,
  WorldChatArtDirectionActionSchema,
  WorldChatArtDirectionRestoreActionSchema,
  WorldChatBibleActionSchema,
  WorldChatCanonActionSchema,
  WorldChatCanonRestoreActionSchema,
  WorldChatCanonRetireActionSchema,
  WorldChatEditorRequestActionSchema,
  WorldChatProposalActionSchema,
  WorldChatSceneActionSchema,
  WorldChatSheetActionSchema,
  WorldChatSheetRestoreActionSchema,
  WorldChatSheetRetireActionSchema,
  WorldChatWorldMetadataActionSchema,
  WorldChatPreparedActionSchema,
  type BibleEdit,
  type CandidateId,
  type CandidateGroup,
  type ConversationActionCard,
  type ConversationActionPrepareIntent,
  type ConversationActionReceipt,
  type ConversationActionTarget,
  type ConversationId,
  type ArkeReadObservation,
  type ArkeReadRequirement,
  type ModelWorldChatAction,
  type WorldChatArtDirectionAction,
  type WorldChatArtDirectionRestoreAction,
  type WorldChatCanonAction,
  type WorldChatCanonRestoreAction,
  type WorldChatCanonRetireAction,
  type WorldChatSheetAction,
  type WorldChatSheetRestoreAction,
  type WorldChatSheetRetireAction,
  type WorldChatWorldMetadataAction,
  type ModelEditorRequest,
  type ModelSceneEdit,
  type ProposalId,
  type TurnId,
  type WorldChangeCandidate,
  type WorldChatContext,
  type WorldChatCheckReceipt,
  type WorldChatPreparedAction,
} from "@arke-studio/contracts";
import type {
  ConversationActionAuthorityAdapter,
  PreparedConversationActionAuthority,
} from "../arke-actions/lifecycle.js";
import { ConversationActionLifecycle, conversationActionDigest } from "../arke-actions/lifecycle.js";
import {
  acceptDecided,
  explainAcceptRefusal,
  landed,
  type AcceptOutcome,
  type ProposalManager,
} from "../gate/proposals.js";
import {
  decideEditorRequest,
  productionOfContext,
  readEditorRequest,
  readEditorRequestByAction,
  stageEditorRequests,
  validateEditorRequest,
} from "../productions/editor-requests.js";
import { applySceneEdits, sceneOfContext } from "../productions/scene-edits.js";
import { atomicWriteFile } from "../world/atomic.js";
import { readBible, applyTurnBibleEdits } from "../world/bible.js";
import { readChanges } from "../world/change-writer.js";
import type { CommitResult } from "../world/commit.js";
import {
  WorldStateStaleError,
  type WorldStatePrecondition,
  type WorldStore,
} from "../world/store.js";
import { MarkdownFile } from "../world/text-files.js";
import { foldConversation } from "./fold.js";
import { evaluateReadiness } from "./readiness.js";
import { sendBack } from "./resolution.js";
import { conversationDir, WorldChatStore } from "./store.js";
import {
  artDirectionFence,
  bibleFence,
  canonFence,
  sheetsFence,
  timelineFence,
  worldMetadataFence,
} from "./target-reads.js";
import {
  stageWorldChatArtDirectionAction,
  stageWorldChatCanonAction,
  stageWorldChatSheetAction,
} from "./world-authoring.js";

export interface PreparedWorldChatAction {
  readonly intent: ConversationActionPrepareIntent;
  readonly payload: WorldChatPreparedAction;
}

export interface WorldChatActionTurn {
  readonly conversationId: ConversationId;
  readonly turnId: TurnId;
  readonly entryContext: WorldChatContext | undefined;
  readonly existingCandidates: readonly WorldChangeCandidate[];
  readonly existingGroups: readonly CandidateGroup[];
  readonly candidates: readonly WorldChangeCandidate[];
  readonly groups: readonly CandidateGroup[];
  readonly bibleEdits: readonly BibleEdit[];
  readonly bibleBaseVersion: number;
  readonly sceneEdits: readonly ModelSceneEdit[];
  readonly sceneBaseVersion: number | null;
  readonly editorRequests: readonly ModelEditorRequest[];
  readonly actions: readonly ModelWorldChatAction[];
  /** Present on live runs; absent only on callers created before complete target receipts. */
  readonly receipts?: readonly WorldChatCheckReceipt[];
  readonly at: string;
}

function completeObservation(
  receipts: readonly WorldChatCheckReceipt[],
  requirement: "bible" | "timeline",
  target: string,
  expectedFence?: string,
) {
  const receipt = receipts.findLast((entry) =>
    entry.tool === "target-read" &&
    (entry.status === "complete" || entry.status === "empty") &&
    entry.complete === true &&
    entry.nextCursor === null &&
    entry.target?.requirement === requirement &&
    entry.target.id === target &&
    entry.observedRevisionOrDigest !== undefined &&
    (expectedFence === undefined || entry.observedRevisionOrDigest === expectedFence));
  return receipt
    ? {
        requirement,
        target,
        revisionOrDigest: receipt.observedRevisionOrDigest!,
        complete: true as const,
        receiptId: receipt.id,
      }
    : null;
}

const WORLD_ACTION_REQUIREMENTS: Record<ModelWorldChatAction["kind"], readonly ArkeReadRequirement[]> = {
  "world-metadata": ["world-metadata", "art-direction"],
  canon: ["canon", "sheets"],
  "canon-retire": ["canon", "sheets"],
  "canon-restore": ["canon", "sheets"],
  sheet: ["sheets", "canon"],
  "sheet-retire": ["sheets", "canon"],
  "sheet-restore": ["sheets", "canon"],
  "art-direction": ["art-direction"],
  "art-direction-restore": ["art-direction"],
};

function currentWorldObservation(store: WorldStore, requirement: ArkeReadRequirement): { target: string; fence: string } | null {
  const bundle = store.getBundle();
  switch (requirement) {
    case "world-metadata": return { target: store.worldId, fence: worldMetadataFence(bundle) };
    case "canon": return { target: store.worldId, fence: canonFence(bundle) };
    case "sheets": return { target: store.worldId, fence: sheetsFence(bundle) };
    case "art-direction": return { target: "art-direction", fence: artDirectionFence(bundle) };
    default: return null;
  }
}

function worldActionObservations(
  store: WorldStore,
  receipts: readonly WorldChatCheckReceipt[],
  action: ModelWorldChatAction,
): ArkeReadObservation[] {
  const observations = action.checkReceiptIds.map((id) => {
    const receipt = receipts.find((entry) => entry.id === id);
    if (
      !receipt ||
      receipt.tool !== "target-read" ||
      (receipt.status !== "complete" && receipt.status !== "empty") ||
      receipt.complete !== true ||
      receipt.nextCursor !== null ||
      !receipt.target ||
      !receipt.observedRevisionOrDigest
    ) throw new Error("A world action requires the final receipt from a complete target read.");
    const current = currentWorldObservation(store, receipt.target.requirement);
    if (
      !current ||
      current.target !== receipt.target.id ||
      current.fence !== receipt.observedRevisionOrDigest
    ) throw new Error(`The complete ${receipt.target.requirement} read is no longer current.`);
    return {
      requirement: receipt.target.requirement,
      target: receipt.target.id,
      revisionOrDigest: receipt.observedRevisionOrDigest,
      complete: true as const,
      receiptId: receipt.id,
    };
  });
  const observed = new Set(observations.map((observation) => observation.requirement));
  const missing = WORLD_ACTION_REQUIREMENTS[action.kind].find((requirement) => !observed.has(requirement));
  if (missing) throw new Error(`A ${action.kind} action requires a complete current ${missing} read.`);
  return [...new Map(observations.map((observation) => [observation.receiptId, observation])).values()];
}

function preparedWorldPayload(worldId: string, action: ModelWorldChatAction): WorldChatPreparedAction {
  switch (action.kind) {
    case "world-metadata": return WorldChatWorldMetadataActionSchema.parse({ kind: "world-chat-world-metadata", worldId, action });
    case "canon": return WorldChatCanonActionSchema.parse({ kind: "world-chat-canon", worldId, action });
    case "canon-retire": return WorldChatCanonRetireActionSchema.parse({ kind: "world-chat-canon-retire", worldId, action });
    case "canon-restore": return WorldChatCanonRestoreActionSchema.parse({ kind: "world-chat-canon-restore", worldId, action });
    case "sheet": return WorldChatSheetActionSchema.parse({ kind: "world-chat-sheet", worldId, action });
    case "sheet-retire": return WorldChatSheetRetireActionSchema.parse({ kind: "world-chat-sheet-retire", worldId, action });
    case "sheet-restore": return WorldChatSheetRestoreActionSchema.parse({ kind: "world-chat-sheet-restore", worldId, action });
    case "art-direction": return WorldChatArtDirectionActionSchema.parse({ kind: "world-chat-art-direction", worldId, action });
    case "art-direction-restore": return WorldChatArtDirectionRestoreActionSchema.parse({ kind: "world-chat-art-direction-restore", worldId, action });
  }
}

function worldActionTargets(action: ModelWorldChatAction, fallbackId: string): ConversationActionTarget[] {
  switch (action.kind) {
    case "world-metadata": return [{ kind: "world", id: "metadata", label: "World metadata" }];
    case "canon-retire":
    case "canon-restore": return [{ kind: "canon", id: action.entryId, label: action.entryId }];
    case "canon": {
      const change = action.change;
      const id = "entryId" in change ? change.entryId : fallbackId;
      return [{ kind: "canon", id, label: "title" in change ? change.title : id }];
    }
    case "sheet-retire":
    case "sheet-restore": return [{ kind: action.sheetType, id: action.sheetId, label: action.sheetId }];
    case "sheet": {
      const change = action.change;
      if (change.operation === "relationship") {
        const targets = [
          { kind: change.from.sheetType, id: change.from.sheetId, label: change.from.sheetId },
          ...change.proseEdits.map((edit) => ({ kind: edit.sheetType, id: edit.sheetId, label: edit.sheetId })),
        ];
        return [...new Map(targets.map((target) => [`${target.kind}:${target.id}`, target])).values()];
      }
      const id = "sheetId" in change ? change.sheetId : fallbackId;
      return [{ kind: "sheetType" in change ? change.sheetType : "sheet", id, label: "name" in change ? change.name : id }];
    }
    case "art-direction":
    case "art-direction-restore": return [{ kind: "art-direction", id: "art-direction", label: "Art direction" }];
  }
}

/** Build strict, digest-bound intents. This is pure and runs before `turn.completed` is appended. */
export function prepareWorldChatActions(
  store: WorldStore,
  lifecycle: ConversationActionLifecycle,
  turn: WorldChatActionTurn,
): PreparedWorldChatAction[] {
  const prepared: PreparedWorldChatAction[] = [];
  const candidateById = new Map(turn.existingCandidates.map((candidate) => [candidate.id, candidate]));
  for (const candidate of turn.candidates) candidateById.set(candidate.id, candidate);
  const groupById = new Map(turn.existingGroups.map((group) => [group.id, group]));
  for (const group of turn.groups) groupById.set(group.id, group);

  const ready = new Set(
    evaluateReadiness([...candidateById.values()], store.getBundle()).carried.map((candidate) => candidate.id),
  );
  const changed = new Set(turn.candidates.map((candidate) => candidate.id));
  const claimed = new Set<string>();
  for (const candidate of turn.candidates) {
    if (!changed.has(candidate.id) || !ready.has(candidate.id) || candidate.status !== "live") continue;
    const group = candidate.groupId ? groupById.get(candidate.groupId) : undefined;
    const members = group?.status === "live"
      ? group.members.map((member) => candidateById.get(member.candidateId)).filter((one): one is WorldChangeCandidate => one !== undefined)
      : [candidate];
    if (members.length === 0 || members.some((member) => !ready.has(member.id))) continue;
    const key = group ? `group:${group.id}` : `candidate:${candidate.id}`;
    if (claimed.has(key)) continue;
    claimed.add(key);
    const payload = {
      kind: "world-chat-proposal" as const,
      worldId: store.worldId,
      candidate: { candidateId: candidate.id, revision: candidate.revision },
      members: members.map((member) => ({ candidateId: member.id, revision: member.revision })),
    };
    prepared.push({
      payload,
      intent: lifecycle.createIntent({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        worldId: store.worldId,
        actionKind: payload.kind,
        targets: members.map((member) => ({ kind: "world-change", id: member.id, label: member.title })),
        payload,
        baseObservations: [...new Map(
          members.flatMap((member) => (member.checks.targetReads ?? []).map((read) => [
            read.checkId,
            {
              requirement: read.target.requirement,
              target: read.target.id,
              revisionOrDigest: read.observedRevisionOrDigest,
              complete: true as const,
              receiptId: read.checkId,
            },
          ] as const)),
        ).values()],
        createdAt: turn.at,
      }),
    });
  }

  for (const [index, action] of turn.actions.entries()) {
    const payload = preparedWorldPayload(store.worldId, action);
    prepared.push({
      payload,
      intent: lifecycle.createIntent({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        worldId: store.worldId,
        actionKind: payload.kind,
        targets: worldActionTargets(action, `${turn.turnId}:${index + 1}`),
        payload,
        baseObservations: worldActionObservations(store, turn.receipts ?? [], action),
        createdAt: turn.at,
      }),
    });
  }

  if (turn.bibleEdits.length > 0) {
    const replacesWholeBible = turn.bibleEdits.some((edit) => edit.op === "replace-document");
    const read = completeObservation(turn.receipts ?? [], "bible", "bible", bibleFence(store.getBundle()));
    if (turn.receipts !== undefined && replacesWholeBible && read === null) {
      throw new Error("A whole Bible replacement requires a complete current Bible read.");
    }
    const payload = {
      kind: "world-chat-bible-edit" as const,
      worldId: store.worldId,
      baseVersion: turn.bibleBaseVersion,
      edits: [...turn.bibleEdits],
    };
    prepared.push({
      payload,
      intent: lifecycle.createIntent({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        worldId: store.worldId,
        actionKind: payload.kind,
        targets: [{ kind: "bible", id: "bible", label: "Bible" }],
        payload,
        baseObservations: read
          ? [read]
          : [{ requirement: "bible", target: "bible", revisionOrDigest: `v${turn.bibleBaseVersion}`, complete: true }],
        createdAt: turn.at,
      }),
    });
  }

  const scene = sceneOfContext(turn.entryContext);
  if (scene && turn.sceneBaseVersion !== null) {
    for (const edit of turn.sceneEdits) {
      const payload = {
        kind: "world-chat-scene-edit" as const,
        worldId: store.worldId,
        productionId: scene.productionId,
        sceneId: scene.sceneId,
        baseVersion: turn.sceneBaseVersion,
        edit,
      };
      prepared.push({
        payload,
        intent: lifecycle.createIntent({
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          worldId: store.worldId,
          productionId: scene.productionId,
          actionKind: payload.kind,
          targets: [{ kind: "scene", id: scene.sceneId, label: "Scene" }],
          payload,
          baseObservations: [{ requirement: "scenes", target: scene.sceneId, revisionOrDigest: `v${turn.sceneBaseVersion}`, complete: true }],
          createdAt: turn.at,
        }),
      });
    }
  }

  const productionId = productionOfContext(turn.entryContext);
  if (productionId) {
    const production = store.getBundle().productions.find((one) => one.meta.id === productionId);
    const read = completeObservation(turn.receipts ?? [], "timeline", productionId, timelineFence(production));
    if (turn.receipts !== undefined && turn.editorRequests.length > 0 && read === null) {
      throw new Error("A timeline request requires a complete current timeline read.");
    }
    for (const request of turn.editorRequests) {
      const payload = {
        kind: "world-chat-editor-request" as const,
        worldId: store.worldId,
        productionId,
        request,
      };
      prepared.push({
        payload,
        intent: lifecycle.createIntent({
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          worldId: store.worldId,
          productionId,
          actionKind: payload.kind,
          targets: [{ kind: "timeline", id: productionId, label: "Timeline" }],
          payload,
          baseObservations: read
            ? [read]
            : [{ requirement: "timeline", target: productionId, revisionOrDigest: timelineFence(production), complete: true }],
          createdAt: turn.at,
        }),
      });
    }
  }
  return prepared;
}

const clipped = (value: string | null, max = 20_000): string | null =>
  value === null || value.length <= max ? value : `${value.slice(0, max - 1)}…`;

async function proposalProjection(
  gate: ProposalManager,
  intent: Pick<ConversationActionPrepareIntent, "targets">,
  proposalId: string,
): Promise<PreparedConversationActionAuthority> {
  const { proposal, review, ripple } = await gate.project(proposalId);
  const fields = review.targets.flatMap((target) =>
    target.fields.map((field) => ({
      label: `${target.label}: ${field.field}`.slice(0, 200),
      before: clipped(field.before),
      after: clipped(field.proposed),
    })),
  );
  return {
    authority: { kind: "proposal-manager", id: proposal.id },
    authorityRevision: proposal.draftRevision,
    shown: {
      title: proposal.summary.slice(0, 200),
      consequence: proposal.targets.length === 1
        ? "Writes one reviewed world record."
        : `Writes ${proposal.targets.length} reviewed world records atomically.`,
      affectedTargets: [...intent.targets],
      ripples: (ripple?.items ?? []).map((item) => item.summary.slice(0, 2_000)),
      permissionReason: "authored-change",
      body: {
        family: "authored-diff",
        fields: fields.length > 0 ? fields : [{ label: "Change", before: null, after: proposal.summary.slice(0, 20_000) }],
        conflicts: (proposal.conflicts ?? []).map((conflict) => `${conflict.field} has conflicting edits.`),
        openChoices: (proposal.openChoices ?? []).map((choice) => choice.question),
      },
    },
  };
}

const preparationPath = (store: WorldStore, authority: "bible" | "scene" | "world", actionId: string): string =>
  join(store.dir, ".history", authority, "prepared", `${actionId}.json`);

async function writePreparation(store: WorldStore, authority: "bible" | "scene" | "world", actionId: string, payload: WorldChatPreparedAction): Promise<void> {
  await atomicWriteFile(preparationPath(store, authority, actionId), `${JSON.stringify(payload, null, 2)}\n`);
}

async function readPreparation(store: WorldStore, authority: "bible" | "scene" | "world", intent: ConversationActionPrepareIntent): Promise<WorldChatPreparedAction | null> {
  const raw = await readFile(preparationPath(store, authority, intent.actionId), "utf8").catch(() => null);
  if (raw === null) return null;
  const parsed = authority === "bible"
    ? WorldChatBibleActionSchema.safeParse(JSON.parse(raw))
    : authority === "scene"
      ? WorldChatSceneActionSchema.safeParse(JSON.parse(raw))
      : WorldChatPreparedActionSchema.safeParse(JSON.parse(raw));
  return parsed.success && conversationActionDigest(parsed.data) === intent.payloadDigest ? parsed.data : null;
}

async function removePreparation(store: WorldStore, authority: "bible" | "scene" | "world", actionId: string): Promise<void> {
  await rm(preparationPath(store, authority, actionId), { force: true });
}

async function committedAction(store: WorldStore, actionId: string): Promise<{ commitId: string; toVersion?: number } | null> {
  const record = (await readChanges(join(store.dir, "changes.jsonl"))).find(
    (line) => (line as Record<string, unknown>)["requestId"] === actionId,
  ) as (Record<string, unknown> & { toVersion?: number }) | undefined;
  return record && typeof record["commitId"] === "string"
    ? { commitId: record["commitId"], ...(record.toVersion !== undefined ? { toVersion: record.toVersion } : {}) }
    : null;
}

async function settledProposal(store: WorldStore, proposalId: string): Promise<{ id: string; summary: string } | null> {
  const record = (await readChanges(join(store.dir, "changes.jsonl"))).find(
    (line) => (line as Record<string, unknown>)["proposalId"] === proposalId,
  ) as Record<string, unknown> | undefined;
  if (!record) return null;
  return typeof record["commitId"] === "string"
    ? { id: record["commitId"], summary: "The proposal was accepted." }
    : record["settled"] === "already-live"
      ? { id: proposalId, summary: "The world already contained this proposal." }
      : null;
}

async function recordBoundProposalResolution(
  store: WorldStore,
  action: ConversationActionCard,
  outcome: "accepted" | "discarded",
  now: () => string,
): Promise<void> {
  const log = new WorldChatStore(conversationDir(store.dir, action.conversationId));
  if (!(await log.readMeta())) return;
  await log.append(
    {
      type: "proposal.resolved",
      proposalId: action.authority.id as ProposalId,
      outcome,
      candidateIds: action.targets.map((target) => target.id as CandidateId),
    },
    { at: now(), requestId: `conversation-action-proposal:${action.actionId}:${outcome}` },
  ).catch(() => {
    /* the proposal authority has already settled; conversation bookkeeping is best-effort */
  });
}

async function settleSaveAttempt(
  store: WorldStore,
  intent: ConversationActionPrepareIntent,
  proposalIds: readonly string[],
  now: () => string,
): Promise<void> {
  const log = new WorldChatStore(conversationDir(store.dir, intent.conversationId));
  if (!(await log.readMeta())) return;
  let open = false;
  for (const envelope of (await log.read()).events) {
    if (envelope.event.type === "save.intent-recorded" && envelope.event.requestId === intent.actionId) {
      open = true;
    }
    if (envelope.event.type === "save.settled" && envelope.event.requestId === intent.actionId) {
      open = false;
    }
  }
  if (!open) return;
  await log.append(
    { type: "save.settled", requestId: intent.actionId, proposalIds: [...proposalIds] as ProposalId[] },
    { at: now(), requestId: `conversation-action-save:${intent.actionId}` },
  );
}

async function conversationCandidates(store: WorldStore, action: ConversationActionCard): Promise<WorldChangeCandidate[]> {
  const log = new WorldChatStore(conversationDir(store.dir, action.conversationId));
  const meta = await log.readMeta();
  if (!meta) return [];
  return foldConversation(meta.id, meta.createdAt, (await log.read()).events).view.candidates.filter((candidate) =>
    action.targets.some((target) => target.id === candidate.id),
  );
}

async function editorRequestForAction(store: WorldStore, actionId: string) {
  return (await Promise.all(
    store.getBundle().productions.map(async (production) =>
      readEditorRequestByAction(store, production.meta.id, actionId).catch(() => null)),
  )).find((request) => request?.actionId === actionId) ?? null;
}

function observationsCurrent(
  store: WorldStore,
  action: Pick<ConversationActionPrepareIntent, "baseObservations">,
): { ok: true } | { ok: false; reason: "stale"; detail: string } {
  for (const observation of action.baseObservations) {
    const current = currentWorldObservation(store, observation.requirement);
    if (!current) return { ok: false, reason: "stale", detail: `The ${observation.requirement} read can no longer be verified.` };
    if (
      !observation.complete ||
      current.target !== observation.target ||
      current.fence !== observation.revisionOrDigest
    ) return { ok: false, reason: "stale", detail: `The ${observation.requirement} changed after this action was prepared.` };
  }
  return { ok: true };
}

function observationPrecondition(
  store: WorldStore,
  action: Pick<ConversationActionPrepareIntent, "baseObservations">,
): WorldStatePrecondition {
  return () => {
    const current = observationsCurrent(store, action);
    return current.ok ? null : current.detail;
  };
}

function shownValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  labels: Record<string, string> = {},
) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ label: labels[key] ?? key, before: clipped(shownValue(before[key])), after: clipped(shownValue(after[key])) }));
}

function canonView(raw: string): { label: string; fields: Record<string, unknown> } {
  const doc = MarkdownFile.parse(raw);
  const entry = CanonEntrySchema.parse({ ...doc.data, body: doc.body.trim() });
  return {
    label: `${entry.id}: ${entry.title}`,
    fields: {
      type: entry.type,
      title: entry.title,
      status: entry.status,
      links: entry.links,
      retired: entry.retired ?? false,
      statement: entry.body,
    },
  };
}

function sheetView(raw: string): { label: string; fields: Record<string, unknown> } {
  const doc = MarkdownFile.parse(raw);
  const sheet = SheetSchema.parse({ ...doc.data, sections: doc.sections() });
  return {
    label: sheet.name,
    fields: {
      name: sheet.name,
      status: sheet.status,
      role: sheet.role,
      billing: sheet.billing,
      region: sheet.region,
      canonRules: sheet.canonRules,
      links: sheet.links,
      owner: sheet.production ?? "world",
      origin: sheet.origin,
      voice: sheet.voice,
      retired: sheet.retired ?? false,
      sections: sheet.sections,
    },
  };
}

function artDirectionFields(direction: {
  description: string;
  masterLook?: string;
  audio: unknown;
  failureModes: readonly string[];
  keyArtIntent?: unknown;
}): Record<string, unknown> {
  return {
    description: direction.description,
    masterLook: direction.masterLook,
    audio: direction.audio,
    failureModes: direction.failureModes,
    keyArtIntent: direction.keyArtIntent,
  };
}

function artDirectionView(raw: string): { label: string; fields: Record<string, unknown> } {
  const direction = ArtDirectionRecordSchema.parse(JSON.parse(raw));
  return { label: `Art direction v${direction.version}`, fields: artDirectionFields(direction) };
}

async function historyContent(store: WorldStore, path: string): Promise<string> {
  const raw = await readFile(join(store.dir, ...path.split("/")), "utf8").catch(() => null);
  if (raw === null) throw new Error(`No history snapshot exists at ${path}.`);
  return raw;
}

async function metadataProjection(
  store: WorldStore,
  intent: ConversationActionPrepareIntent,
  payload: WorldChatWorldMetadataAction,
): Promise<PreparedConversationActionAuthority> {
  const before = store.getBundle().meta;
  const next: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(payload.action.changes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const after = WorldMetaSchema.parse(next);
  const fields = diffFields(before, after, { name: "Name", logline: "Logline", tone: "Tone", genre: "Genre" });
  if (fields.length === 0) throw new Error("The world metadata already has those values.");
  const ripples = store.getBundle().artDirection.derived && deriveArtDirectionDescription(before) !== deriveArtDirectionDescription(after)
    ? [`The metadata-derived art direction changes to: ${deriveArtDirectionDescription(after)}`]
    : [];
  await writePreparation(store, "world", intent.actionId, payload);
  return {
    authority: { kind: "world-store", id: intent.actionId },
    authorityRevision: 0,
    shown: {
      title: fields.length === 1 ? `Change world ${fields[0]!.label.toLowerCase()}` : "Change world metadata",
      consequence: "Updates the world's authored metadata without changing its identity or folder.",
      affectedTargets: [...intent.targets],
      ripples,
      permissionReason: "authored-change",
      body: {
        family: "authored-diff",
        fields,
        conflicts: [],
        openChoices: [],
      },
    },
  };
}

async function retirementProjection(
  store: WorldStore,
  intent: ConversationActionPrepareIntent,
  payload: WorldChatCanonRetireAction | WorldChatSheetRetireAction,
): Promise<PreparedConversationActionAuthority> {
  const bundle = store.getBundle();
  const canon = payload.kind === "world-chat-canon-retire";
  const entity = canon
    ? bundle.canon.find((entry) => entry.id === payload.action.entryId)
    : bundle.sheets.find((sheet) => sheet.id === payload.action.sheetId && sheet.type === payload.action.sheetType);
  if (!entity) throw new Error("The entity to retire is not in this world.");
  const id = entity.id;
  const version = "version" in entity
    ? entity.version
    : Math.max(entity.introducedAt, entity.settledAt ?? 0, entity.amendedAt ?? 0);
  const alreadyRetired = entity.retired === true;
  const dependents = canon
    ? [
        ...bundle.canon.filter((entry) => entry.id !== id && entry.links.includes(id)).map((entry) => entry.id),
        ...bundle.sheets.filter((sheet) => sheet.canonRules.includes(id)).map((sheet) => sheet.id),
      ]
    : [
        ...bundle.canon.filter((entry) => entry.links.includes(id)).map((entry) => entry.id),
        ...bundle.sheets.filter((sheet) => sheet.id !== id && sheet.links.includes(id)).map((sheet) => sheet.id),
      ];
  const blockers = alreadyRetired ? [`${id} is already retired.`] : [];
  await writePreparation(store, "world", intent.actionId, payload);
  return {
    authority: { kind: "world-store", id: intent.actionId },
    authorityRevision: version,
    ...(blockers.length > 0 ? { approvalBlockedReason: blockers[0] } : {}),
    shown: {
      title: `Retire ${"title" in entity ? entity.title : entity.name}`,
      consequence: "Removes this entity from active authoring and retrieval without deleting its file, identity, citations, or history.",
      affectedTargets: [...intent.targets],
      ripples: dependents.length > 0 ? [`${dependents.length} linked record${dependents.length === 1 ? " keeps" : "s keep"} resolving this retired identity.`] : [],
      permissionReason: "destructive-change",
      body: {
        family: "destructive",
        removed: [`${id} from active pickers, retrieval, and future suggestions`],
        retained: ["The entity file and stable identity", "All version history", "Existing citations and links"],
        dependentChanges: dependents.length > 0 ? [`Linked records remain unchanged: ${dependents.join(", ")}`] : ["No linked records change"],
        blockers,
        undoAvailable: true,
      },
    },
  };
}

async function restoreProjection(
  store: WorldStore,
  intent: ConversationActionPrepareIntent,
  payload: WorldChatCanonRestoreAction | WorldChatSheetRestoreAction | WorldChatArtDirectionRestoreAction,
): Promise<PreparedConversationActionAuthority> {
  let label: string;
  let version: number;
  let ripples: string[];
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  if (payload.kind === "world-chat-canon-restore") {
    const live = await readFile(join(store.dir, "canon", `${payload.action.entryId}.md`), "utf8");
    const snapshot = await historyContent(store, `.history/canon/${payload.action.entryId}/v${payload.action.version}.md`);
    const current = canonView(live);
    label = current.label;
    version = store.getBundle().meta.canonRevision;
    ripples = ["Canon advances to a new revision; linked records and future dispatches see the restored content."];
    before = current.fields;
    after = canonView(snapshot).fields;
  } else if (payload.kind === "world-chat-sheet-restore") {
    const path = `${sheetDir(payload.action.sheetType)}/${payload.action.sheetId}.md`;
    const live = await readFile(join(store.dir, ...path.split("/")), "utf8");
    const snapshot = await historyContent(store, `.history/${sheetDir(payload.action.sheetType)}/${payload.action.sheetId}/v${payload.action.version}.md`);
    const current = sheetView(live);
    label = current.label;
    version = store.getBundle().sheets.find((sheet) => sheet.id === payload.action.sheetId)!.version;
    ripples = ["Future uses see the restored sheet as a new version; accepted takes stay pinned to their recorded versions."];
    before = current.fields;
    after = sheetView(snapshot).fields;
  } else {
    const current = store.getBundle().artDirection;
    const historical = current.history.find((entry) => entry.version === payload.action.version);
    const snapshot = historical
      ? { label: `Art direction v${historical.version}`, fields: artDirectionFields(historical) }
      : artDirectionView(await historyContent(store, `.history/art-direction/v${payload.action.version}.json`));
    label = `Art direction v${current.version}`;
    version = current.version;
    ripples = ["Reference kits and future generations pick up the restored look; accepted assets remain pinned to their recorded versions."];
    before = artDirectionFields(current);
    after = snapshot.fields;
  }
  const fields = diffFields(before, after);
  await writePreparation(store, "world", intent.actionId, payload);
  return {
    authority: { kind: "world-store", id: intent.actionId },
    authorityRevision: version,
    shown: {
      title: `Restore ${label} from v${payload.action.version}`,
      consequence: "Restores the selected snapshot as a new version and retains every later version in history.",
      affectedTargets: [...intent.targets],
      ripples,
      permissionReason: "authored-change",
      body: {
        family: "authored-diff",
        fields: fields.length > 0 ? fields : [{ label: "Content", before: "Current", after: "Same in selected version" }],
        conflicts: [],
        openChoices: [],
      },
    },
  };
}

export function worldChatActionAdapters(
  store: WorldStore,
  gate: ProposalManager | null,
  now: () => string,
): ConversationActionAuthorityAdapter[] {
  const proposal: ConversationActionAuthorityAdapter = {
    actionKind: "world-chat-proposal",
    prepare: async ({ intent, payload }) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      const action = WorldChatProposalActionSchema.parse(payload);
      const staged = await saveProposalPoint(store, gate, intent, action.candidate, action.members, now);
      return proposalProjection(gate, intent, staged);
    },
    recoverPreparation: async (intent) => {
      if (!gate) return null;
      const found = (await gate.listOpen()).filter((candidate) =>
        candidate.worldChatOrigins?.some((origin) => origin.requestId === intent.actionId),
      );
      if (found.length !== 1) return null;
      await settleSaveAttempt(store, intent, [found[0]!.id], now);
      return proposalProjection(gate, intent, found[0]!.id);
    },
    abandonPreparation: async (intent) => {
      if (!gate) return;
      const found = (await gate.listOpen()).filter((candidate) =>
        candidate.worldChatOrigins?.some((origin) => origin.requestId === intent.actionId),
      );
      for (const candidate of found) await sendBack(store, gate, candidate, now);
      await settleSaveAttempt(store, intent, found.map((candidate) => candidate.id), now);
    },
    validate: async (action) => {
      if (!gate) return { ok: false, reason: "blocked", detail: "The proposal authority is unavailable." };
      const checked = await gate.validatePending(action.authority.id, action.authorityRevision);
      return checked.ok
        ? { ok: true }
        : { ok: false, reason: checked.stale ? "stale" : "blocked", detail: checked.detail };
    },
    execute: async (action) => {
      if (!gate) return { status: "failed", detail: "The proposal authority is unavailable." };
      const proposal = await gate.readManifest(action.authority.id);
      const outcome = await acceptDecided(gate, proposal.id);
      if (landed(outcome)) {
        await recordBoundProposalResolution(store, action, "accepted", now);
        const id = outcome.status === "accepted" ? outcome.result.commitId : proposal.id;
        return {
          status: "completed",
          receipt: { kind: "proposal", id, summary: outcome.status === "accepted" ? "The proposal was accepted." : "The world already contained this proposal." },
        };
      }
      return outcome.status === "stale"
        ? { status: "stale", detail: explainAcceptRefusal(outcome) }
        : { status: "failed", detail: explainAcceptRefusal(outcome) };
    },
    deny: async (action) => {
      if (!gate) return;
      const proposal = await gate.readManifest(action.authority.id).catch(() => null);
      if (!proposal) return;
      await recordBoundProposalResolution(store, action, "discarded", now);
      await gate.discard(proposal.id);
    },
    reconcile: async (action) => {
      if (!gate) return null;
      if ((await gate.listOpen()).some((proposal) => proposal.id === action.authority.id)) return null;
      const settled = await settledProposal(store, action.authority.id);
      if (settled) {
        await recordBoundProposalResolution(store, action, "accepted", now);
        return { status: "completed", receipt: { kind: "proposal", ...settled } };
      }
      const candidates = await conversationCandidates(store, action);
      if (candidates.length > 0 && candidates.every((candidate) => candidate.status === "accepted")) {
        return { status: "completed", receipt: { kind: "proposal", id: action.authority.id, summary: "The proposal was accepted." } };
      }
      if (candidates.some((candidate) => candidate.status === "discarded")) {
        return { status: "cancelled", detail: "The proposal was discarded outside this card." };
      }
      return null;
    },
  };

  const bibleProjection = async (intent: ConversationActionPrepareIntent, payload: WorldChatPreparedAction) => {
    const action = WorldChatBibleActionSchema.parse(payload);
    const current = await readBible(store.dir);
    if (current.version !== action.baseVersion) throw new Error("The Bible changed while this action was prepared.");
    let previewText = current.text;
    const fields = action.edits.map((edit) => {
      const before = edit.op === "replace-document"
        ? previewText
        : splitBible(previewText).sections.find(
            (section) => section.heading.trim().toLowerCase() === edit.heading.trim().toLowerCase(),
          )?.body ?? null;
      previewText = applyBibleEdits(previewText, [edit]).text;
      const after = edit.op === "replace-document"
        ? previewText
        : splitBible(previewText).sections.find(
            (section) => section.heading.trim().toLowerCase() === edit.heading.trim().toLowerCase(),
          )?.body ?? null;
      return {
        label: (edit.op === "replace-document" ? "Whole Bible" : edit.heading).slice(0, 200),
        before: clipped(before),
        after: clipped(after),
      };
    });
    const headings = action.edits.map((edit) => edit.op === "replace-document" ? "the whole Bible" : edit.heading);
    await writePreparation(store, "bible", intent.actionId, action);
    return {
      authority: { kind: "bible" as const, id: intent.actionId },
      authorityRevision: action.baseVersion,
      shown: {
        title: headings.length === 1 ? `Edit ${headings[0]}` : `Edit ${headings.length} Bible sections`,
        consequence: "Versions the Bible after applying the shown section edits.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change" as const,
        body: {
          family: "authored-diff" as const,
          fields,
          conflicts: [],
          openChoices: [],
        },
      },
    };
  };
  const bible: ConversationActionAuthorityAdapter = {
    actionKind: "world-chat-bible-edit",
    prepare: ({ intent, payload }) => bibleProjection(intent, WorldChatBibleActionSchema.parse(payload)),
    recoverPreparation: async (intent) => {
      const payload = await readPreparation(store, "bible", intent);
      return payload ? bibleProjection(intent, payload) : null;
    },
    abandonPreparation: (intent) => removePreparation(store, "bible", intent.actionId),
    validate: async (action) => {
      const prepared = await readPreparation(store, "bible", action);
      if (!prepared) return { ok: false, reason: "blocked", detail: "The prepared Bible edit is unavailable." };
      const current = await readBible(store.dir);
      return current.version === action.authorityRevision
        ? { ok: true }
        : { ok: false, reason: "stale", detail: "The Bible changed after this edit was prepared." };
    },
    execute: async (action) => {
      const prepared = WorldChatBibleActionSchema.parse(await readPreparation(store, "bible", action));
      const record = await applyTurnBibleEdits(store, prepared.edits, {
        source: `world-chat:${action.conversationId}`,
        baseVersion: prepared.baseVersion,
        requestId: action.actionId,
      });
      await removePreparation(store, "bible", action.actionId);
      return {
        status: "completed",
        receipt: { kind: "bible-version", id: `bible-v${record!.toVersion}`, summary: `Bible v${record!.toVersion} was written.` },
      };
    },
    deny: (action) => removePreparation(store, "bible", action.actionId),
    reconcile: async (action) => {
      const commit = await committedAction(store, action.actionId);
      return commit
        ? { status: "completed", receipt: { kind: "bible-version", id: `bible-v${commit.toVersion ?? action.authorityRevision + 1}`, summary: "The Bible edit completed." } }
        : null;
    },
  };

  const sceneProjection = async (intent: ConversationActionPrepareIntent, payload: WorldChatPreparedAction) => {
    const action = WorldChatSceneActionSchema.parse(payload);
    await applySceneEdits(store, {
      entryContext: { kind: "scene", productionId: action.productionId, sceneId: action.sceneId },
      edits: [action.edit],
      baseVersion: action.baseVersion,
      dryRun: true,
    });
    const production = store.getBundle().productions.find((one) => one.meta.id === action.productionId);
    const before = production?.scenes.find((one) => one.id === action.sceneId)?.title ?? null;
    await writePreparation(store, "scene", intent.actionId, action);
    return {
      authority: { kind: "scene-store" as const, id: intent.actionId },
      authorityRevision: action.baseVersion,
      shown: {
        title: "Rename the scene",
        consequence: "Changes the scene title and versions the scene.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change" as const,
        body: {
          family: "authored-diff" as const,
          fields: [{ label: "Title", before, after: action.edit.title }],
          conflicts: [],
          openChoices: [],
        },
      },
    };
  };
  const scene: ConversationActionAuthorityAdapter = {
    actionKind: "world-chat-scene-edit",
    prepare: ({ intent, payload }) => sceneProjection(intent, WorldChatSceneActionSchema.parse(payload)),
    recoverPreparation: async (intent) => {
      const payload = await readPreparation(store, "scene", intent);
      return payload ? sceneProjection(intent, payload) : null;
    },
    abandonPreparation: (intent) => removePreparation(store, "scene", intent.actionId),
    validate: async (action) => {
      const prepared = await readPreparation(store, "scene", action);
      if (!prepared) return { ok: false, reason: "blocked", detail: "The prepared scene edit is unavailable." };
      const input = WorldChatSceneActionSchema.parse(prepared);
      const current = store.getBundle().productions
        .find((one) => one.meta.id === input.productionId)?.scenes.find((one) => one.id === input.sceneId)?.version;
      return current === input.baseVersion
        ? { ok: true }
        : { ok: false, reason: "stale", detail: "The scene changed after this rename was prepared." };
    },
    execute: async (action) => {
      const prepared = WorldChatSceneActionSchema.parse(await readPreparation(store, "scene", action));
      await applySceneEdits(store, {
        entryContext: { kind: "scene", productionId: prepared.productionId, sceneId: prepared.sceneId },
        edits: [prepared.edit],
        baseVersion: prepared.baseVersion,
        requestId: action.actionId,
      });
      await removePreparation(store, "scene", action.actionId);
      return {
        status: "completed",
        receipt: { kind: "scene-version", id: `${prepared.sceneId}-v${prepared.baseVersion + 1}`, summary: `The scene was renamed at v${prepared.baseVersion + 1}.` },
      };
    },
    deny: (action) => removePreparation(store, "scene", action.actionId),
    reconcile: async (action) => {
      const commit = await committedAction(store, action.actionId);
      return commit
        ? { status: "completed", receipt: { kind: "scene-version", id: commit.commitId, summary: "The scene rename completed." } }
        : null;
    },
  };

  const editor: ConversationActionAuthorityAdapter = {
    actionKind: "world-chat-editor-request",
    prepare: async ({ intent, payload }) => {
      const action = WorldChatEditorRequestActionSchema.parse(payload);
      const [request] = await stageEditorRequests(store, {
        conversationId: intent.conversationId,
        actionId: intent.actionId,
        entryContext: { kind: "production", productionId: action.productionId },
        requests: [action.request],
        now: now(),
      });
      if (!request) throw new Error("The editor request was not staged.");
      return {
        authority: { kind: "timeline", id: request.id },
        authorityRevision: request.baseRevision ?? 0,
        shown: {
          title: request.summary.slice(0, 200),
          consequence: "Applies these commands to the production timeline.",
          affectedTargets: [...intent.targets],
          ripples: [],
          permissionReason: "authored-change",
          body: {
            family: "command",
            commands: request.commands.map((command) => ({ label: command.kind.replaceAll("-", " ") })),
            expectedResult: request.summary.slice(0, 4_000),
            undoAvailable: true,
          },
        },
      };
    },
    recoverPreparation: async (intent) => {
      const action = await editorRequestForAction(store, intent.actionId);
      if (!action) return null;
      return {
        authority: { kind: "timeline", id: action.id },
        authorityRevision: action.baseRevision ?? 0,
        shown: {
          title: action.summary.slice(0, 200),
          consequence: "Applies these commands to the production timeline.",
          affectedTargets: [...intent.targets],
          ripples: [],
          permissionReason: "authored-change",
          body: {
            family: "command",
            commands: action.commands.map((command) => ({ label: command.kind.replaceAll("-", " ") })),
            expectedResult: action.summary.slice(0, 4_000),
            undoAvailable: true,
          },
        },
      };
    },
    abandonPreparation: async (intent) => {
      const request = await editorRequestForAction(store, intent.actionId);
      if (!request || request.status !== "pending") return;
      await decideEditorRequest(store, {
        productionId: request.productionId,
        requestId: request.id,
        decision: "reject",
        now: now(),
      });
    },
    validate: async (action) => {
      const checked = await validateEditorRequest(store, action.productionId!, action.authority.id);
      return checked.ok
        ? { ok: true }
        : { ok: false, reason: checked.stale ? "stale" : "blocked", detail: checked.detail };
    },
    execute: async (action) => {
      const request = await decideEditorRequest(store, {
        productionId: action.productionId!,
        requestId: action.authority.id,
        decision: "accept",
        now: now(),
      });
      return {
        status: "completed",
        receipt: { kind: "editor-request", id: request.id, summary: `The timeline request completed at revision ${request.resultRevision}.` },
      };
    },
    deny: async (action) => {
      const current = await readEditorRequest(store, action.productionId!, action.authority.id);
      if (!current || current.status !== "pending") return;
      await decideEditorRequest(store, {
        productionId: action.productionId!,
        requestId: action.authority.id,
        decision: "reject",
        now: now(),
      });
    },
    reconcile: async (action) => {
      const request = await readEditorRequest(store, action.productionId!, action.authority.id);
      if (request?.status === "accepted") {
        return { status: "completed", receipt: { kind: "editor-request", id: request.id, summary: "The timeline request completed." } };
      }
      if (request?.status === "rejected") return { status: "cancelled", detail: "The editor request was rejected outside this card." };
      if (request?.status === "stale") return { status: "stale", detail: request.reason ?? "The editor request became stale." };
      return null;
    },
  };

  const proposalBacked = <T extends WorldChatCanonAction | WorldChatSheetAction | WorldChatArtDirectionAction>(
    actionKind: string,
    parse: (value: unknown) => T,
    stage: (
      intent: ConversationActionPrepareIntent,
      payload: T,
      precondition: WorldStatePrecondition,
    ) => Promise<{ id: string }>,
  ): ConversationActionAuthorityAdapter => ({
    actionKind,
    prepare: async ({ intent, payload }) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      const current = observationsCurrent(store, intent);
      if (!current.ok) throw new Error(current.detail);
      const staged = await stage(intent, parse(payload), observationPrecondition(store, intent));
      return proposalProjection(gate, intent, staged.id);
    },
    recoverPreparation: async (intent) => {
      if (!gate) return null;
      const current = observationsCurrent(store, intent);
      if (!current.ok) throw new Error(current.detail);
      const found = (await gate.listOpen()).filter((candidate) => candidate.source === `world-chat-action:${intent.actionId}`);
      return found.length === 1 ? proposalProjection(gate, intent, found[0]!.id) : null;
    },
    abandonPreparation: async (intent) => {
      if (!gate) return;
      const found = (await gate.listOpen()).filter((candidate) => candidate.source === `world-chat-action:${intent.actionId}`);
      for (const candidate of found) await gate.discard(candidate.id);
    },
    validate: async (action) => {
      if (!gate) return { ok: false, reason: "blocked", detail: "The proposal authority is unavailable." };
      const current = observationsCurrent(store, action);
      if (!current.ok) {
        await gate.discard(action.authority.id);
        return current;
      }
      const checked = await gate.validatePending(action.authority.id, action.authorityRevision);
      if (!checked.ok && checked.stale) await gate.discard(action.authority.id);
      if (!checked.ok) {
        return { ok: false, reason: checked.stale ? "stale" : "blocked", detail: checked.detail };
      }
      const currentProjection = await proposalProjection(gate, action, action.authority.id);
      if (conversationActionDigest(currentProjection.shown) !== action.previewDigest) {
        await gate.discard(action.authority.id);
        return { ok: false, reason: "stale", detail: "The proposal preview changed after this card was prepared." };
      }
      return { ok: true };
    },
    execute: async (action) => {
      if (!gate) return { status: "failed", detail: "The proposal authority is unavailable." };
      const proposal = await gate.readManifest(action.authority.id);
      const outcome = await gate.accept(proposal.id, {
        precondition: observationPrecondition(store, action),
      }).catch((error): AcceptOutcome => {
        if (error instanceof WorldStateStaleError) {
          return { status: "stale", stalePaths: [], detail: error.detail };
        }
        throw error;
      });
      if (landed(outcome)) {
        const id = outcome.status === "accepted" ? outcome.result.commitId : proposal.id;
        return {
          status: "completed",
          receipt: {
            kind: "proposal",
            id,
            summary: outcome.status === "accepted" ? "The reviewed world change was accepted." : "The world already contained this change.",
          },
        };
      }
      await gate.discard(proposal.id);
      return outcome.status === "stale" || outcome.status === "needs-reconfirm"
        ? { status: "stale", detail: explainAcceptRefusal(outcome) }
        : { status: "failed", detail: explainAcceptRefusal(outcome) };
    },
    deny: async (action) => {
      if (!gate) return;
      await gate.discard(action.authority.id).catch(() => {});
    },
    reconcile: async (action) => {
      if (!gate) return null;
      if ((await gate.listOpen()).some((candidate) => candidate.id === action.authority.id)) return null;
      const settled = await settledProposal(store, action.authority.id);
      return settled
        ? { status: "completed", receipt: { kind: "proposal", ...settled } }
        : { status: "cancelled", detail: "The proposal was discarded outside this card." };
    },
  });

  const direct = <T extends WorldChatPreparedAction>(
    actionKind: string,
    parse: (value: unknown) => T,
    project: (intent: ConversationActionPrepareIntent, payload: T) => Promise<PreparedConversationActionAuthority>,
    execute: (
      payload: T,
      action: ConversationActionCard,
      precondition: WorldStatePrecondition,
    ) => Promise<CommitResult>,
    receipt: (result: CommitResult | null) => ConversationActionReceipt,
    undo?: (action: ConversationActionCard) => { readonly kind: string; readonly id: string } | null,
  ): ConversationActionAuthorityAdapter => ({
    actionKind,
    prepare: async ({ intent, payload }) => {
      const current = observationsCurrent(store, intent);
      if (!current.ok) throw new Error(current.detail);
      return project(intent, parse(payload));
    },
    recoverPreparation: async (intent) => {
      const payload = await readPreparation(store, "world", intent);
      return payload ? project(intent, parse(payload)) : null;
    },
    abandonPreparation: (intent) => removePreparation(store, "world", intent.actionId),
    validate: async (action) => {
      const payload = await readPreparation(store, "world", action);
      if (!payload) return { ok: false, reason: "blocked", detail: "The prepared world change is unavailable." };
      try {
        parse(payload);
      } catch {
        return { ok: false, reason: "blocked", detail: "The prepared world change is invalid." };
      }
      const current = observationsCurrent(store, action);
      if (!current.ok) await removePreparation(store, "world", action.actionId);
      return current;
    },
    execute: async (action) => {
      const existing = await committedAction(store, action.actionId);
      if (existing) {
        await removePreparation(store, "world", action.actionId);
        return { status: "completed", receipt: receipt(null) };
      }
      const payload = parse(await readPreparation(store, "world", action));
      try {
        const result = await execute(payload, action, observationPrecondition(store, action));
        await removePreparation(store, "world", action.actionId);
        return { status: "completed", receipt: receipt(result) };
      } catch (error) {
        if (error instanceof WorldStateStaleError) {
          await removePreparation(store, "world", action.actionId);
          return { status: "stale", detail: error.detail };
        }
        throw error;
      }
    },
    deny: (action) => removePreparation(store, "world", action.actionId),
    reconcile: async (action) => {
      const committed = await committedAction(store, action.actionId);
      return committed ? { status: "completed", receipt: receipt(null) } : null;
    },
    ...(undo ? { undo } : {}),
  });

  const canonAction = proposalBacked(
    "world-chat-canon",
    (value) => WorldChatCanonActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatCanonAction(store, gate, intent, payload, precondition);
    },
  );
  const sheetAction = proposalBacked(
    "world-chat-sheet",
    (value) => WorldChatSheetActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatSheetAction(store, gate, intent, payload, precondition);
    },
  );
  const artDirectionAction = proposalBacked(
    "world-chat-art-direction",
    (value) => WorldChatArtDirectionActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatArtDirectionAction(store, gate, intent, payload, precondition);
    },
  );
  const worldMetadata = direct(
    "world-chat-world-metadata",
    (value) => WorldChatWorldMetadataActionSchema.parse(value),
    (intent, payload) => metadataProjection(store, intent, payload),
    (payload, action, precondition) => store.updateWorldMetadata(payload.action.changes, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "world-metadata", id: result?.commitId ?? "world-metadata", summary: "The world metadata was updated." }),
  );
  const canonRetire = direct(
    "world-chat-canon-retire",
    (value) => WorldChatCanonRetireActionSchema.parse(value),
    (intent, payload) => retirementProjection(store, intent, payload),
    (payload, action, precondition) => store.retire(`canon/${payload.action.entryId}.md`, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "canon-retirement", id: result?.commitId ?? "canon-retirement", summary: "The Canon entry was retired with its history retained." }),
    (action) => ({ kind: "canon-version", id: `${action.targets[0]!.id}:v${action.authorityRevision}` }),
  );
  const sheetRetire = direct(
    "world-chat-sheet-retire",
    (value) => WorldChatSheetRetireActionSchema.parse(value),
    (intent, payload) => retirementProjection(store, intent, payload),
    (payload, action, precondition) => store.retire(`${sheetDir(payload.action.sheetType)}/${payload.action.sheetId}.md`, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "sheet-retirement", id: result?.commitId ?? "sheet-retirement", summary: "The sheet was retired with its history retained." }),
    (action) => ({ kind: "sheet-version", id: `${action.targets[0]!.kind}:${action.targets[0]!.id}:v${action.authorityRevision}` }),
  );
  const canonRestore = direct(
    "world-chat-canon-restore",
    (value) => WorldChatCanonRestoreActionSchema.parse(value),
    (intent, payload) => restoreProjection(store, intent, payload),
    (payload, action, precondition) => store.restoreVersion(`canon/${payload.action.entryId}.md`, payload.action.version, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "canon-version", id: result?.commitId ?? "canon-version", summary: "The selected Canon snapshot was restored as a new revision." }),
  );
  const sheetRestore = direct(
    "world-chat-sheet-restore",
    (value) => WorldChatSheetRestoreActionSchema.parse(value),
    (intent, payload) => restoreProjection(store, intent, payload),
    (payload, action, precondition) => store.restoreVersion(`${sheetDir(payload.action.sheetType)}/${payload.action.sheetId}.md`, payload.action.version, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "sheet-version", id: result?.commitId ?? "sheet-version", summary: "The selected sheet snapshot was restored as a new version." }),
  );
  const artDirectionRestore = direct(
    "world-chat-art-direction-restore",
    (value) => WorldChatArtDirectionRestoreActionSchema.parse(value),
    (intent, payload) => restoreProjection(store, intent, payload),
    (payload, action, precondition) => store.restoreVersion(ART_DIRECTION_PATH, payload.action.version, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "art-direction-version", id: result?.commitId ?? "art-direction-version", summary: "The selected art direction was restored as a new version." }),
  );

  return [
    proposal,
    bible,
    scene,
    editor,
    worldMetadata,
    canonAction,
    canonRetire,
    canonRestore,
    sheetAction,
    sheetRetire,
    sheetRestore,
    artDirectionAction,
    artDirectionRestore,
  ];
}

async function saveProposalPoint(
  store: WorldStore,
  gate: ProposalManager,
  intent: ConversationActionPrepareIntent,
  candidate: { candidateId: string; revision: number },
  members: readonly { candidateId: string; revision: number }[],
  now: () => string,
): Promise<string> {
  const { savePoint } = await import("./wrapup.js");
  const staged = await savePoint({
    store,
    gate,
    conversationId: intent.conversationId,
    requestId: intent.actionId,
    candidateId: candidate.candidateId,
    expectedCandidateRevision: candidate.revision,
    expectedGroupRevisions: [...members],
    now,
  });
  if (staged.proposalIds.length !== 1) throw new Error("A conversation action must bind one proposal authority.");
  return staged.proposalIds[0]!;
}

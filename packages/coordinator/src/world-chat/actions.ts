import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  applyBibleEdits,
  splitBible,
  WorldChatBibleActionSchema,
  WorldChatEditorRequestActionSchema,
  WorldChatProposalActionSchema,
  WorldChatSceneActionSchema,
  type BibleEdit,
  type CandidateId,
  type CandidateGroup,
  type ConversationActionCard,
  type ConversationActionPrepareIntent,
  type ConversationId,
  type ModelEditorRequest,
  type ModelSceneEdit,
  type ProposalId,
  type TurnId,
  type WorldChangeCandidate,
  type WorldChatContext,
  type WorldChatPreparedAction,
} from "@arke-studio/contracts";
import type {
  ConversationActionAuthorityAdapter,
  PreparedConversationActionAuthority,
} from "../arke-actions/lifecycle.js";
import { ConversationActionLifecycle, conversationActionDigest } from "../arke-actions/lifecycle.js";
import { acceptDecided, explainAcceptRefusal, landed, type ProposalManager } from "../gate/proposals.js";
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
import type { WorldStore } from "../world/store.js";
import { foldConversation } from "./fold.js";
import { evaluateReadiness } from "./readiness.js";
import { sendBack } from "./resolution.js";
import { conversationDir, WorldChatStore } from "./store.js";

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
  readonly at: string;
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
        baseObservations: [],
        createdAt: turn.at,
      }),
    });
  }

  if (turn.bibleEdits.length > 0) {
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
        baseObservations: [{ requirement: "bible", target: "bible", revisionOrDigest: `v${turn.bibleBaseVersion}`, complete: true }],
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
    const revision = production?.timeline?.status === "ready"
      ? `v${production.timeline.timeline.revision}`
      : "unmaterialised";
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
          baseObservations: [{ requirement: "timeline", target: productionId, revisionOrDigest: revision, complete: true }],
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
  intent: ConversationActionPrepareIntent,
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

const preparationPath = (store: WorldStore, authority: "bible" | "scene", actionId: string): string =>
  join(store.dir, ".history", authority, "prepared", `${actionId}.json`);

async function writePreparation(store: WorldStore, authority: "bible" | "scene", actionId: string, payload: WorldChatPreparedAction): Promise<void> {
  await atomicWriteFile(preparationPath(store, authority, actionId), `${JSON.stringify(payload, null, 2)}\n`);
}

async function readPreparation(store: WorldStore, authority: "bible" | "scene", intent: ConversationActionPrepareIntent): Promise<WorldChatPreparedAction | null> {
  const raw = await readFile(preparationPath(store, authority, intent.actionId), "utf8").catch(() => null);
  if (raw === null) return null;
  const parsed = authority === "bible"
    ? WorldChatBibleActionSchema.safeParse(JSON.parse(raw))
    : WorldChatSceneActionSchema.safeParse(JSON.parse(raw));
  return parsed.success && conversationActionDigest(parsed.data) === intent.payloadDigest ? parsed.data : null;
}

async function removePreparation(store: WorldStore, authority: "bible" | "scene", actionId: string): Promise<void> {
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

  return [proposal, bible, scene, editor];
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

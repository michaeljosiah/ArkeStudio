import type { Job, ManifestModel, Proposal, SheetKind, SizeTier, WorldBundle } from "@arke-studio/contracts";
import type { AcceptOutcome } from "../gate/proposals.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { SentenceDraft } from "../sheets/authoring.js";

/** Host-created context, never a renderer identity assertion (SPEC-025). */
export interface EngineContext {
  actorId: string;
  /** Security partition: distinct from a world, audience, subscriber or actor. */
  scopeId: string;
  executorId: string;
  subjectId: string;
}

export type EngineAction = "read" | "propose" | "accept" | "discard" | "generate" | "media" |
  "production-create" | "chapter-create" | "chapter-save";
export interface EngineResource { worldId: string; proposalId?: string; sheetId?: string; artifactId?: string;
  productionId?: string; chapterId?: string }
export interface DeliveryContent { kind: "world" | "proposal" | "job" | "artifact" | "production" | "chapter"; id: string; sha256: string }

/** Exact output approved before the durable financial decision. */
export type EngineDeliveredJob = Job & { deliveredArtifacts: Array<{ id: string; sha256: string }> };

export interface EnginePolicy {
  /** Must recheck current authority, including revocation, on each invocation. */
  authorise(context: EngineContext, action: EngineAction, resource: EngineResource): Promise<void>;
  /** Return only the caller's view. The input is a detached copy, not mutable engine state. */
  project(context: EngineContext, bundle: WorldBundle): Promise<WorldBundle>;
  /** Refusal or unavailable checks throw. No permissive external-host default. */
  deliver(context: EngineContext, resource: EngineResource, content: DeliveryContent): Promise<void>;
  reserve(context: EngineContext, key: string, inputs: readonly EnqueueInput[]): Promise<string>;
  /** Both calls must be idempotent by key; an uncertain response is retried with that same key. */
  settle(context: EngineContext, key: string, reservation: string, jobs: readonly EngineDeliveredJob[]): Promise<void>;
  release(context: EngineContext, key: string, reservation: string): Promise<void>;
}

export interface SheetProposalInput {
  sheetType: SheetKind;
  name: string;
  sentence: string;
  production?: string;
  attendedSurface?: "sheet-list" | "production-cast";
}
export interface IllustrationInput {
  sheetId: string;
  model: ManifestModel;
  prompt: string;
  count: number;
  identityReferences: string[];
  generationKey: string;
  tier?: SizeTier;
}
export interface EngineSnapshot { revision: string; bundle: WorldBundle }
export interface EngineArtifact { id: string; contentType: string; bytes: Uint8Array }

/** The semantic surface over a private materialised world; no host absolute paths escape. */
export interface EngineWorldSession {
  /** Optional for hosts that have not adopted prose; calls refuse explicitly when absent. */
  prose?: import("./prose-contracts.js").EngineProseSession;
  snapshot(): Promise<EngineSnapshot>;
  propose(input: SheetProposalInput, expectedRevision?: string): Promise<SentenceDraft>;
  proposal(id: string): Promise<Proposal>;
  accept(id: string, options: { confirmRipples?: string; expectedDraftRevision?: number; expectedRevision?: string }): Promise<AcceptOutcome>;
  discard(id: string, expectedRevision?: string): Promise<void>;
  resolution(proposal: Proposal, outcome: "accepted" | "discarded"): Promise<void>;
  /** Check the revision and freeze all inputs under the same world transaction. */
  illustrations(input: IllustrationInput, expectedRevision?: string): Promise<EnqueueInput[]>;
  artifact(id: string): Promise<EngineArtifact>;
  /** Resolve only after authoritative storage accepted all changed state, or reject as uncertain. */
  saved(operationKey: string): Promise<{ revision: string }>;
}
export interface EngineWorldRepository {
  use<T>(worldId: string, action: (session: EngineWorldSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface EngineOperation {
  key: string;
  fingerprint: string;
  context: EngineContext;
  resource: EngineResource;
  action: Exclude<EngineAction, "read" | "media">;
  status: "started" | "completed";
  result?: unknown;
}
export interface EngineOperationStore {
  /** Atomically insert if absent; return the existing row otherwise. A returned row is durable. */
  begin(operation: EngineOperation): Promise<{ inserted: boolean; operation: EngineOperation }>;
  complete(key: string, fingerprint: string, result: unknown): Promise<void>;
  read(key: string): Promise<EngineOperation | null>;
  drain(): Promise<void>;
}
export interface EngineQueue {
  enqueue(input: EnqueueInput): Promise<Job>;
  jobs(): readonly Job[];
}
export interface EngineMutation { operationId: string; expectedRevision?: string }
export interface EngineReceipt<T> { operationKey: string; revision: string; value: T }
export type { EngineProseSession, ProseProductionInput, ProseChapterInput, ProseSaveInput,
  ProseProductionResult, ProseChapterResult, ProseSaveResult, ProseChapterRead } from "./prose-contracts.js";

/** Every confirmed admission is retained, even when the remaining batch is uncertain. */
export interface IllustrationOutcome {
  operationKey: string;
  reservation: string;
  jobIds: string[];
  failures: Array<{ index: number; reason: string }>;
  needsReconciliation: boolean;
}

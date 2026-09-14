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

export type EngineAction = "read" | "propose" | "accept" | "discard" | "generate" | "media";
export interface EngineResource { worldId: string; proposalId?: string; sheetId?: string; artifactId?: string }
export interface DeliveryContent { kind: "world" | "proposal" | "job" | "artifact"; id: string; sha256: string }

export interface EnginePolicy {
  /** Must recheck current authority, including revocation, on each invocation. */
  authorise(context: EngineContext, action: EngineAction, resource: EngineResource): Promise<void>;
  /** Return only the caller's view. The input is a detached copy, not mutable engine state. */
  project(context: EngineContext, bundle: WorldBundle): Promise<WorldBundle>;
  /** Refusal or unavailable checks throw. No permissive external-host default. */
  deliver(context: EngineContext, resource: EngineResource, content: DeliveryContent): Promise<void>;
  reserve(context: EngineContext, key: string, inputs: readonly EnqueueInput[]): Promise<string>;
  /** Both calls must be idempotent by key; an uncertain response is retried with that same key. */
  settle(context: EngineContext, key: string, reservation: string, jobs: readonly Job[]): Promise<void>;
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
  snapshot(): Promise<EngineSnapshot>;
  propose(input: SheetProposalInput, expectedRevision?: string): Promise<SentenceDraft>;
  proposal(id: string): Promise<Proposal>;
  accept(id: string, options: { confirmRipples?: string; expectedDraftRevision?: number; expectedRevision?: string }): Promise<AcceptOutcome>;
  discard(id: string, expectedRevision?: string): Promise<void>;
  resolution(proposal: Proposal, outcome: "accepted" | "discarded"): Promise<void>;
  illustrations(input: IllustrationInput): Promise<EnqueueInput[]>;
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
  action: EngineAction;
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

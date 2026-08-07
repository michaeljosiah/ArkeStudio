import type { Capability, CapabilityProbe, ClientDeclarations, ProviderId } from "@arke-studio/contracts";

/**
 * The provider client interface (SPEC-008 §2.9, R-23): submit, poll, fetch, cancel, plus the
 * declarations reconciliation selects its strategy from. Nothing outside a client knows a
 * provider's HTTP shape; nothing in a client knows about jobs or the queue.
 */

export interface SubmitRequest {
  model: string;
  capability: Capability;
  /** Coordinator-neutral parameters; each client must validate and map its provider boundary. */
  params: Record<string, unknown>;
  /** Ephemeral verified bytes, resolved immediately before submission and never journalled. */
  imageReferences?: PreparedImageReference[];
  /** Attached when the provider honours it (declared via supportsIdempotencyKey). */
  idempotencyKey?: string;
}

export interface PreparedImageReference {
  name: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  data: Uint8Array;
}

export interface SubmitResult {
  remoteId: string;
  acceptedAt: string;
  /** Synchronous providers can return final artifacts without an in-memory poll cache. */
  artifacts?: FetchedArtifact[];
}

export interface PollResult {
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  /** 0..1 where the provider reports one. */
  progress?: number;
  /** Actual charge in micro-USD, only when the provider reports real cost (reportsCost). */
  costMicroUsd?: number;
  error?: string;
}

export interface FetchedArtifact {
  /** Suggested filename, e.g. "frame.png". */
  name: string;
  contentType: string;
  data: Uint8Array;
}

/** A credential failure is a provider fault, never a work failure (R-4). */
export class ProviderAuthError extends Error {
  constructor(
    readonly provider: ProviderId,
    message: string,
  ) {
    super(message);
    this.name = "ProviderAuthError";
  }
}

/** The provider returned a response proving the paid operation was rejected, not accepted. */
export class ProviderRequestRejectedError extends Error {
  readonly submissionRejected = true;

  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestRejectedError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CommandResult {
  /** The exit status, or null when the process never produced one (spawn failure, timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * A provider driven as a subprocess rather than over HTTP. The runner is already bound to a
 * discovered command, so a client composes arguments and never learns where the binary lives —
 * the same seam `FetchLike` gives the HTTP clients, and the same reason: tests need no CLI.
 */
export type CommandRunner = (
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<CommandResult>;

export interface ProviderCallContext {
  jobId?: string;
  attempt?: number;
  model?: string;
}

export interface ProviderCallCapture {
  start(input: {
    provider: ProviderId;
    operation: string;
    context?: ProviderCallContext;
    method: string;
    endpoint: string;
    headers: Record<string, string>;
    body: unknown;
  }): Promise<string>;
  finish(id: string, input: { status: number; headers: Record<string, string>; body: unknown }): Promise<void>;
  fail(id: string, error: unknown): Promise<void>;
}

export interface VoiceCatalogueClient extends ProviderClient {
  listVoicesCatalog(key: string): Promise<
    Array<{ provider: string; voiceId: string; label: string; attributes: string[]; local: boolean; canClone: boolean }>
  >;
}

export interface ProviderClient {
  readonly id: ProviderId;
  readonly declarations: ClientDeclarations;

  /**
   * Per-capability validation (R-3, D5): free or near-free probes — a models list, a balance
   * read — never a real generation. Reports what the key unlocks, not that it authenticates.
   */
  validateKey(key: string): Promise<CapabilityProbe[]>;

  submit(key: string, request: SubmitRequest, context?: ProviderCallContext): Promise<SubmitResult>;
  poll(key: string, remoteId: string, context?: ProviderCallContext): Promise<PollResult>;
  fetchArtifacts(key: string, remoteId: string, context?: ProviderCallContext): Promise<FetchedArtifact[]>;
  cancel(key: string, remoteId: string, context?: ProviderCallContext): Promise<void>;
  lookupByKey?(key: string, idempotencyKey: string, context?: ProviderCallContext): Promise<{ remoteId: string } | null>;
  listRecent?(key: string, context?: ProviderCallContext): Promise<Array<{ remoteId: string; idempotencyKey?: string; createdAt: string }>>;
}

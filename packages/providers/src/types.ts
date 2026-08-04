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

export interface ProviderClient {
  readonly id: ProviderId;
  readonly declarations: ClientDeclarations;

  /**
   * Per-capability validation (R-3, D5): free or near-free probes — a models list, a balance
   * read — never a real generation. Reports what the key unlocks, not that it authenticates.
   */
  validateKey(key: string): Promise<CapabilityProbe[]>;

  submit(key: string, request: SubmitRequest): Promise<SubmitResult>;
  poll(key: string, remoteId: string): Promise<PollResult>;
  fetchArtifacts(key: string, remoteId: string): Promise<FetchedArtifact[]>;
  cancel(key: string, remoteId: string): Promise<void>;
}

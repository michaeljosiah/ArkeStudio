import type {
  Capability,
  CapabilityProbe,
  ClientDeclarations,
  ProviderId,
  ProviderTransportDiagnostic,
  RecipeIdentity,
} from "@arke-studio/contracts";

/**
 * The provider client interface (SPEC-008 §2.9, R-23): submit, poll, fetch, cancel, plus the
 * declarations reconciliation selects its strategy from. Nothing outside a client knows a
 * provider's HTTP shape; nothing in a client knows about jobs or the queue.
 */

export interface SubmitRequest {
  model: string;
  capability: Capability;
  /** Host cancellation for work still inside a synchronous submit. Never serialized or sent. */
  signal?: AbortSignal;
  /** Coordinator-neutral parameters; each client must validate and map its provider boundary. */
  params: Record<string, unknown>;
  /** Ephemeral verified bytes, resolved immediately before submission and never journalled. */
  imageReferences?: PreparedImageReference[];
  /**
   * The footage a continuation extends (SPEC-019 R-50), resolved immediately before submission
   * and never journalled.
   *
   * Deliberately not `params`, on exactly the grounds `audioSource` gives: params are written
   * verbatim into the durable job row, and several megabytes of clip landing there would
   * outlive the take it produced. The job records WHICH take was extended — `continuedFrom`,
   * which is durable and small — and the bytes are resolved from that at submit time.
   */
  videoSource?: PreparedVideoSource;
  /** A host-read voice reference, resolved immediately before submission and never journalled. */
  voiceReference?: PreparedVoiceReference;
  /**
   * The recording a transcription reads, resolved immediately before submission and never
   * journalled (SPEC-018 R-13, R-15). Deliberately not `params`: params are written verbatim
   * into the durable job row, and a recording that landed there would outlive the transcript it
   * produced — the transcript is the artefact, the audio is a buffer. Separate from
   * `voiceReference` because that one is a *voice* being cloned, restricted to the two formats
   * a cloning endpoint accepts; this is whatever the microphone or the file on disk produced.
   */
  audioSource?: PreparedAudioSource;
  /** Attached when the provider honours it (declared via supportsIdempotencyKey). */
  idempotencyKey?: string;
  /**
   * The recipe identity frozen onto the job at enqueue (SPEC-021 R-15). Carried to the wire
   * because freezing it is only half the guarantee: the client must refuse when the shipped
   * catalogue has moved past what this job was accepted as, rather than resolving the current
   * graph under an old job's name.
   */
  recipe?: RecipeIdentity;
}

export interface PreparedImageReference {
  name: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  data: Uint8Array;
}

/**
 * A clip being extended, and the type it is. Shaped like `PreparedImageReference` rather than
 * `PreparedAudioSource` because it does travel as a named file input on the wire — the extend
 * routes all declare a `video_url`, and a data URI needs its type spelled out to be one.
 */
export interface PreparedVideoSource {
  contentType: "video/mp4" | "video/quicktime" | "video/webm";
  data: Uint8Array;
}

export interface PreparedVoiceReference {
  /** Opaque, content-addressed upload name. It carries no world, character, or local path. */
  name: string;
  contentType: "audio/wav" | "audio/mpeg";
  data: Uint8Array;
}

/**
 * Bytes and the type they are, and nothing else. Unlike the image and voice references there is
 * no `name` here: a transcription posts the recording as the request body, so there is no
 * filename for a name to become, and a field the wire never carries is one somebody will
 * eventually fill in with a local path.
 */
export interface PreparedAudioSource {
  /** The recording's own type, as the engine must be told it — `audio/webm`, `audio/wav`, … */
  contentType: string;
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
  /**
   * What the engine is counting right now, when it counts anything (SPEC-021 D16).
   *
   * A number on its own is the thing that exclusion was written against: a graph is not a step,
   * so a bare fraction sits at nothing through a model load, sweeps to full while one node
   * samples, then waits on the rest. Carrying the stage with the count is what lets a surface
   * say `speaking · step 20 of 25` instead of implying the job is 80 per cent done.
   */
  step?: { stage: string; done: number; total: number };
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
  readonly submissionRejected = true;

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

/**
 * The provider cannot take the request right now, and nothing about the request is why — a
 * graphics card without room for the recipe, most likely, with another job's model still on it.
 * The same request is expected to succeed later, so this is SPEC-009's transient: the queue
 * backs off and retries it, bounded, and a failure it gives up on keeps a live Retry (SPEC-036
 * R-18). A rejection of the request itself is `ProviderRequestRejectedError`, and terminal.
 *
 * Found by a run of six local frames (#692): the card ran short on alternate shots, the message
 * told the user to try again, and the queue had classed the failure terminal — so no surface
 * could offer the retry the message promised. The class is declared here, where the condition
 * is witnessed, because no reading of the message can tell it from a refusal.
 */
export class ProviderBusyError extends Error {
  readonly failureClass = "transient" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProviderBusyError";
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

export type ProviderOperation =
  | "provider"
  | "validate"
  | "submit"
  | "poll"
  | "fetch-artifacts"
  | "cancel"
  | "lookup-by-key"
  | "list-recent"
  | "list-voices";

export interface ProviderTransportScope extends ProviderCallContext {
  provider: ProviderId;
  operation: ProviderOperation;
  capability?: Capability;
}

/** Host-owned operation policy. Provider clients continue to receive an ordinary FetchLike. */
export interface ProviderTransport {
  run<T>(scope: ProviderTransportScope, operation: (fetch: FetchLike) => Promise<T>): Promise<T>;
}

export interface ProviderCallCapture {
  /** Keep detached response-body capture alive through the host's final drain. */
  track(task: Promise<void>): void;
  start(input: {
    provider: ProviderId;
    operation: string;
    context?: ProviderCallContext;
    /** An HTTP verb, or "EXEC" for a provider driven as a subprocess. */
    method: string;
    endpoint: string;
    headers: Record<string, string>;
    body: unknown;
  }): Promise<string>;
  /** Response headers arrived. Persist this before a body timeout can erase that fact. */
  respond(id: string, input: { status: number; headers: Record<string, string> }): Promise<void>;
  /** `status` for HTTP, `exitCode` for a subprocess — whichever the call actually produced. */
  finish(
    id: string,
    input: { status?: number; exitCode?: number | null; headers: Record<string, string>; body: unknown },
  ): Promise<void>;
  fail(id: string, error: unknown, diagnostic?: ProviderTransportDiagnostic): Promise<void>;
}

export interface VoiceCatalogueClient extends ProviderClient {
  listVoicesCatalog(key: string): Promise<
    Array<{ provider: string; model: string; voiceId: string; label: string; attributes: string[]; local: boolean; canClone: boolean }>
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
  /** Drop source-bound optional transports while keeping the client reusable. */
  resetTransport?(): void;
  /** Release optional long-lived transports. No provider call may occur after this. */
  dispose?(): void;
  lookupByKey?(key: string, idempotencyKey: string, context?: ProviderCallContext): Promise<{ remoteId: string } | null>;
  listRecent?(key: string, context?: ProviderCallContext): Promise<Array<{ remoteId: string; idempotencyKey?: string; createdAt: string }>>;
}

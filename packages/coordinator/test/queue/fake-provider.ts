import type { ClientDeclarations } from "@arke-studio/contracts";
import type { DispatchArtifact, DispatchClient } from "../../src/queue/dispatcher.js";

/**
 * The fake provider harness (SPEC-009 T-17): able to fail at every step, declare every
 * combination of capability flags, and — crucially — hold provider-side state across a
 * simulated process kill, so reconciliation has something real to find.
 */

/** A valid tiny PNG: signature + IEND trailer. Truncation drops the trailer. */
export function pngBytes(): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const body = Array.from({ length: 64 }, () => 0x00);
  const iend = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  return Uint8Array.from([...head, ...body, ...iend]);
}

export function truncatedPngBytes(): Uint8Array {
  return pngBytes().slice(0, 40);
}

export function jpegBytes(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...Array.from({ length: 64 }, () => 0x00), 0xff, 0xd9]);
}

export function webpBytes(): Uint8Array {
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46,
    0x0c, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

interface RemoteJob {
  remoteId: string;
  idempotencyKey?: string;
  createdAt: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  costMicroUsd?: number;
}

export class FakeProvider implements DispatchClient {
  readonly declarations: ClientDeclarations;

  /** Provider-side state — survives queue "kills" because the test keeps the same instance. */
  readonly remote = new Map<string, RemoteJob>();
  submitCount = 0;
  pollCount = 0;
  cancelCount = 0;
  inFlightNow = 0;
  maxObservedConcurrent = 0;
  readonly submittedKeys: Array<string | undefined> = [];
  submittedReferenceBytes: Uint8Array[] = [];
  submittedVoiceReference: { name: string; contentType: string; data: Uint8Array } | null = null;
  inlineArtifacts: DispatchArtifact[] | null = null;

  /** Scripting hooks. */
  submitError: Error | null = null;
  submitErrorTimes = Infinity;
  /** The kill-mid-③ window: the request left, nothing ever came back. */
  submitHangs = false;
  onSubmitAccepted: ((remoteId: string) => void) | null = null;
  onFetch: (() => void) | null = null;
  artifacts: DispatchArtifact[] = [];
  pollState: RemoteJob["state"] = "succeeded";
  costMicroUsd: number | undefined = undefined;
  /** Listing behaviour for strategy B: whether entries carry idempotency keys. */
  listingCarriesKeys = true;
  listingWindowFloor: string | null = null;
  lookupError: Error | null = null;
  submissionRejected = false;

  private counter = 0;

  constructor(flags: Partial<ClientDeclarations> = {}) {
    this.declarations = {
      supportsIdempotencyKey: false,
      supportsLookupByKey: false,
      supportsListRecent: false,
      reportsCost: false,
      ...flags,
    };
  }

  async submit(
    _key: string,
    request: {
      model: string;
      params: Record<string, unknown>;
      imageReferences?: Array<{ data: Uint8Array }>;
      voiceReference?: { name: string; contentType: string; data: Uint8Array };
      idempotencyKey?: string;
    },
  ): Promise<{ remoteId: string; artifacts?: DispatchArtifact[] }> {
    this.submitCount += 1;
    this.submittedKeys.push(request.idempotencyKey);
    this.submittedReferenceBytes = (request.imageReferences ?? []).map((reference) => reference.data);
    this.submittedVoiceReference = request.voiceReference ?? null;
    this.inFlightNow += 1;
    this.maxObservedConcurrent = Math.max(this.maxObservedConcurrent, this.inFlightNow);
    try {
      await Promise.resolve(); // yield so dispose-during-submit is a real window
      if (this.submitHangs) await new Promise<never>(() => {});
      if (this.submitError && this.submitErrorTimes > 0) {
        this.submitErrorTimes -= 1;
        if (this.submissionRejected) {
          Object.assign(this.submitError, { submissionRejected: true });
        }
        throw this.submitError;
      }
      const remoteId = `rm_${++this.counter}`;
      this.remote.set(remoteId, {
        remoteId,
        ...(request.idempotencyKey !== undefined ? { idempotencyKey: request.idempotencyKey } : {}),
        createdAt: new Date().toISOString(),
        state: this.pollState,
        ...(this.costMicroUsd !== undefined ? { costMicroUsd: this.costMicroUsd } : {}),
      });
      this.onSubmitAccepted?.(remoteId);
      return { remoteId, ...(this.inlineArtifacts ? { artifacts: this.inlineArtifacts } : {}) };
    } finally {
      this.inFlightNow -= 1;
    }
  }

  async poll(_key: string, remoteId: string): Promise<{ state: RemoteJob["state"]; costMicroUsd?: number; error?: string }> {
    this.pollCount += 1;
    const job = this.remote.get(remoteId);
    if (!job) return { state: "failed", error: "unknown remote id" };
    return {
      state: job.state,
      ...(job.costMicroUsd !== undefined ? { costMicroUsd: job.costMicroUsd } : {}),
      ...(job.state === "failed" ? { error: "the provider reported failure" } : {}),
    };
  }

  async fetchArtifacts(): Promise<DispatchArtifact[]> {
    this.onFetch?.();
    return this.artifacts;
  }

  async cancel(_key: string, remoteId: string): Promise<void> {
    this.cancelCount += 1;
    const job = this.remote.get(remoteId);
    if (job) job.state = "cancelled";
  }

  async lookupByKey(_key: string, idempotencyKey: string): Promise<{ remoteId: string } | null> {
    if (this.lookupError) throw this.lookupError;
    for (const job of this.remote.values()) {
      if (job.idempotencyKey === idempotencyKey) return { remoteId: job.remoteId };
    }
    return null;
  }

  async listRecent(): Promise<Array<{ remoteId: string; idempotencyKey?: string; createdAt: string }>> {
    const all = [...this.remote.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const floor = this.listingWindowFloor;
    const windowed = floor === null ? all : all.filter((j) => j.createdAt >= floor);
    return windowed.map((j) => ({
      remoteId: j.remoteId,
      ...(this.listingCarriesKeys && j.idempotencyKey !== undefined ? { idempotencyKey: j.idempotencyKey } : {}),
      createdAt: j.createdAt,
    }));
  }
}

import {
  HarnessEventSchema,
  type Capability,
  type CreateSessionInput,
  type HarnessAdapter,
  type HarnessEvent,
  type ModelInfo,
  type PermissionAck,
  type PermissionDecision,
  type Readiness,
  type SendMessageInput,
  type SendReceipt,
  type SessionRef,
} from "@arke-studio/contracts";

/**
 * Scripted mock behind the adapter interface (SPEC-001 T-6). The coordinator is written
 * against `HarnessAdapter`; swapping this for the live OpenCode backing (SPEC-005) must not
 * change a caller. Every emitted event goes through the same schema as the real thing.
 */
export class MockHarnessAdapter implements HarnessAdapter {
  readonly id = "mock";
  private readonly caps = new Set<Capability>(["events", "models", "permissions"]);
  private sessions = 0;
  private correlations = 0;
  private readonly subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
  private disposed = false;

  capabilities(): ReadonlySet<Capability> {
    return this.caps;
  }

  readiness(): Readiness {
    return this.disposed ? { ready: false, reason: "mock disposed" } : { ready: true };
  }

  async init(): Promise<void> {
    /* nothing to probe */
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const sub of this.subscribers) {
      sub.wake?.();
      sub.wake = null;
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    const sessionId = `sess_mock_${++this.sessions}_${input.purpose}`;
    this.push({ type: "session.created", sessionId });
    return { sessionId };
  }

  async sendMessage(input: SendMessageInput): Promise<SendReceipt> {
    const correlationId = input.correlationId ?? `corr_${++this.correlations}`;
    const prompt = input.parts.map((p) => p.text).join("\n");
    this.push({
      type: "message.completed",
      sessionId: input.sessionId,
      correlationId,
      text: `[mock] considered ${prompt.length} chars and has no opinion yet`,
    });
    return { sessionId: input.sessionId, correlationId };
  }

  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    const correlationId = input.correlationId ?? `corr_${++this.correlations}`;
    queueMicrotask(() => {
      this.push({ type: "message.delta", sessionId: input.sessionId, correlationId, text: "[mock] working…" });
      this.push({ type: "message.completed", sessionId: input.sessionId, correlationId, text: "[mock] done" });
    });
    return { sessionId: input.sessionId, correlationId };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: "mock-large", provider: "mock", displayName: "Mock Large" },
      { id: "mock-small", provider: "mock", displayName: "Mock Small" },
    ];
  }

  async respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    this.push({
      type: "permission.replied",
      sessionId: "sess_mock_permissions",
      permissionId: decision.permissionId,
      decision: decision.decision,
    });
    return { permissionId: decision.permissionId, status: "confirmed" };
  }

  /** Test hook: inject an event as if the harness produced it. */
  inject(event: HarnessEvent): void {
    this.push(event);
  }

  private push(event: HarnessEvent): void {
    const parsed = HarnessEventSchema.parse(event);
    for (const sub of this.subscribers) {
      sub.queue.push(parsed);
      sub.wake?.();
      sub.wake = null;
    }
  }

  streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    // Eager registration — see OpenCodeAdapter.streamEvents for why.
    const sub: { queue: HarnessEvent[]; wake: (() => void) | null } = { queue: [], wake: null };
    this.subscribers.add(sub);
    const adapter = this;
    return {
      [Symbol.asyncIterator]() {
        return (async function* () {
          try {
            while (!adapter.disposed && !signal?.aborted) {
              const next = sub.queue.shift();
              if (next) {
                yield next;
                continue;
              }
              await new Promise<void>((resolve) => {
                const onAbort = () => resolve();
                signal?.addEventListener("abort", onAbort, { once: true });
                sub.wake = () => {
                  signal?.removeEventListener("abort", onAbort);
                  resolve();
                };
              });
            }
          } finally {
            adapter.subscribers.delete(sub);
          }
        })();
      },
    };
  }
}

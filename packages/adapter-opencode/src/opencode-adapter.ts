import {
  HarnessEventSchema,
  type HarnessCapability,
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
import { probeCapabilities } from "./capabilities.js";
import { OpenCodeHttp } from "./http.js";
import { createNormalizeState, normalizeOpenCode, type NormalizeState } from "./normalize.js";
import { parseSse } from "./sse.js";

/**
 * The live OpenCode adapter (SPEC-005). Drives the probed /api surface with legacy fallbacks,
 * normalises the SSE stream into schema-validated harness events, and exposes the usage and
 * interruption hooks the authoring service's timeout/budget enforcement needs (R-13).
 *
 * It never writes to a world, never calls commit(), and never decides what a ripple is —
 * SPEC-004 owns all of that. This class owns a foreign process's protocol, nothing more.
 */

export interface OpenCodeAdapterOptions {
  /** Resolved lazily so supervisor restarts on new ports keep working. */
  baseUrl: () => string;
}

interface TrackedSession {
  purpose: CreateSessionInput["purpose"];
  cwd?: string;
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly id = "opencode";
  private readonly http: OpenCodeHttp;
  private caps = new Set<HarnessCapability>();
  private ready: Readiness = { ready: false, reason: "not probed yet" };
  serverVersion: string | null = null;
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly normalizeState: NormalizeState = createNormalizeState();
  /** Bounded record of dropped frames — contained, never silently lost (R-14). */
  readonly deadLetters: Array<{ reason: string; at: number }> = [];
  private readonly permissionSessions = new Map<string, string>();
  private disposed = false;

  // Fan-out: each streamEvents() consumer gets its own queue — the authoring service and the
  // permission pump both listen, and one must never starve the other.
  private readonly subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
  private pumping = false;

  constructor(private readonly opts: OpenCodeAdapterOptions) {
    this.http = new OpenCodeHttp({ baseUrl: opts.baseUrl });
  }

  capabilities(): ReadonlySet<HarnessCapability> {
    return this.caps;
  }

  readiness(): Readiness {
    return this.ready;
  }

  /** Probe health and the OpenAPI document; idempotent (R-2). */
  async init(): Promise<void> {
    const result = await probeCapabilities(this.http);
    this.caps = result.capabilities;
    this.ready = result.readiness;
    this.serverVersion = result.serverVersion ?? null;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    const body: Record<string, unknown> = {
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.cwd ? { location: { directory: input.cwd.replaceAll("\\", "/") } } : {}),
    };
    let sessionId: string;
    try {
      const res = await this.http.req<{ data?: { id?: string }; id?: string }>("POST", "/api/session", body);
      sessionId = res.data?.id ?? res.id ?? "";
    } catch {
      // Legacy generation: directory travels as a query parameter.
      const res = await this.http.req<{ id?: string }>(
        "POST",
        "/session",
        {},
        input.cwd ? { directory: input.cwd } : {},
      );
      sessionId = res.id ?? "";
    }
    if (!sessionId) throw new Error("OpenCode did not return a session id");
    this.sessions.set(sessionId, { purpose: input.purpose, ...(input.cwd ? { cwd: input.cwd } : {}) });
    this.push({ type: "session.created", sessionId });
    return { sessionId };
  }

  /** Fire-and-watch (the only mode authoring uses): completion arrives on the event stream. */
  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    const correlationId = input.correlationId ?? `corr_${Date.now().toString(36)}`;
    const text = input.parts.map((p) => p.text).join("\n\n");
    const session = this.sessions.get(input.sessionId);
    const directory = session?.cwd;
    // The /api prompt call blocks until the turn completes on some versions; never await it
    // here — the receipt returns immediately and the stream reports progress (R-13, D7).
    void (async () => {
      try {
        await this.http.req(
          "POST",
          `/api/session/${input.sessionId}/prompt`,
          { prompt: { text } },
          directory ? { directory } : {},
        );
      } catch {
        try {
          await this.http.req(
            "POST",
            `/session/${input.sessionId}/prompt_async`,
            { parts: [{ type: "text", text }], messageID: correlationId },
            directory ? { directory } : {},
          );
        } catch (err) {
          this.push({
            type: "session.error",
            sessionId: input.sessionId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return { sessionId: input.sessionId, correlationId };
  }

  /** Synchronous send: resolves when this session's turn completes (or errors). */
  async sendMessage(input: SendMessageInput): Promise<SendReceipt> {
    const receipt = await this.dispatchAsync(input);
    await new Promise<void>((resolve) => {
      const check = (event: HarnessEvent): boolean =>
        (event.type === "message.completed" || event.type === "session.error" || event.type === "session.ended") &&
        "sessionId" in event &&
        event.sessionId === input.sessionId;
      const listener = (event: HarnessEvent) => {
        if (check(event)) {
          this.turnListeners.delete(listener);
          resolve();
        }
      };
      this.turnListeners.add(listener);
    });
    return receipt;
  }

  private readonly turnListeners = new Set<(event: HarnessEvent) => void>();

  /** Interrupt a running turn; the proposal keeps whatever the agent had written (R-12, R-13). */
  async interrupt(sessionId: string): Promise<void> {
    try {
      await this.http.req("POST", `/api/session/${sessionId}/interrupt`, {});
    } catch {
      await this.http.req("POST", `/session/${sessionId}/abort`, {}).catch(() => {});
    }
  }

  /** Cumulative token usage for a session, from message.updated frames — the budget input. */
  usageTokens(sessionId: string): number {
    return this.normalizeState.tokensBySession.get(sessionId) ?? 0;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await this.http.req<{ data?: Array<{ id?: string; providerID?: string; name?: string }> }>(
        "GET",
        "/api/model",
      );
      const rows = Array.isArray(res.data) ? res.data : [];
      return rows
        .filter((m) => m.id)
        .map((m) => ({
          id: m.id!,
          provider: m.providerID ?? "unknown",
          ...(m.name ? { displayName: m.name } : {}),
        }));
    } catch {
      const res = await this.http.req<{ providers?: Array<{ id: string; models?: Record<string, { name?: string }> }> }>(
        "GET",
        "/config/providers",
      );
      const out: ModelInfo[] = [];
      for (const provider of res.providers ?? []) {
        for (const [id, model] of Object.entries(provider.models ?? {})) {
          out.push({ id, provider: provider.id, ...(model.name ? { displayName: model.name } : {}) });
        }
      }
      return out;
    }
  }

  async respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    const sessionId = this.permissionSessions.get(decision.permissionId);
    const body = { response: decision.decision, reply: decision.decision };
    try {
      if (sessionId) {
        await this.http.req(
          "POST",
          `/api/session/${sessionId}/permission/${decision.permissionId}/reply`,
          body,
        );
      } else {
        await this.http.req("POST", `/permission/${decision.permissionId}/reply`, body);
      }
    } catch {
      return { permissionId: decision.permissionId, status: "stale" };
    }
    // Confirmation comes only from the replied event, never HTTP status; wait briefly.
    const confirmed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.turnListeners.delete(listener);
        resolve(false);
      }, 3_000);
      const listener = (event: HarnessEvent) => {
        if (event.type === "permission.replied" && event.permissionId === decision.permissionId) {
          clearTimeout(timer);
          this.turnListeners.delete(listener);
          resolve(true);
        }
      };
      this.turnListeners.add(listener);
    });
    return { permissionId: decision.permissionId, status: confirmed ? "confirmed" : "unconfirmed" };
  }

  // ---- the event pump ------------------------------------------------------

  private push(event: HarnessEvent): void {
    const parsed = HarnessEventSchema.parse(event);
    if (parsed.type === "permission.requested") {
      this.permissionSessions.set(parsed.permissionId, parsed.sessionId);
    }
    for (const listener of [...this.turnListeners]) listener(parsed);
    for (const sub of this.subscribers) {
      sub.queue.push(parsed);
      sub.wake?.();
      sub.wake = null;
    }
  }

  private readonly pumpAbort = new AbortController();

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const signal = this.pumpAbort.signal;
    let backoff = 500;
    while (!this.disposed && !signal.aborted) {
      try {
        const stream = await this.http.openEventStream(signal);
        backoff = 500;
        for await (const raw of parseSse(stream, signal)) {
          const outcome = normalizeOpenCode(raw, this.normalizeState);
          if (outcome.kind === "events") {
            for (const event of outcome.events) {
              // Only surface events for sessions this adapter created — the harness may be a
              // user's own installation with its own unrelated activity.
              if ("sessionId" in event && event.sessionId && !this.sessions.has(event.sessionId)) {
                continue;
              }
              this.push(event);
            }
          } else if (outcome.kind === "dead-letter") {
            this.deadLetters.push({ reason: outcome.reason, at: Date.now() });
            if (this.deadLetters.length > 100) this.deadLetters.shift();
          }
        }
      } catch {
        /* stream dropped — reconnect below */
      }
      if (this.disposed || signal.aborted) return;
      await new Promise((r) => {
        const t = setTimeout(r, backoff);
        (t as { unref?: () => void }).unref?.();
      });
      backoff = Math.min(backoff * 2, 10_000);
    }
  }

  streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    void this.pump();
    // Register eagerly, at call time — a generator body only runs on the first pull, and an
    // event arriving between dispatch and that pull must not be lost.
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

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pumpAbort.abort();
    for (const sub of this.subscribers) {
      sub.wake?.();
      sub.wake = null;
    }
  }
}

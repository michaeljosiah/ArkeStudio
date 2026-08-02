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
  /** Overridable so a test can prove the watchdog without waiting a minute and a half. */
  streamSilenceMs?: number;
  /**
   * One line per adapter-lifecycle fact — connects, stalls, resyncs, dispatch outcomes. The
   * host appends them to logs/harness.jsonl. Diagnosing "the chat is stuck" from outside the
   * process has cost days; this is the app saying what it did, when it did it.
   */
  onTrace?: (line: Record<string, unknown>) => void;
}

interface TrackedSession {
  purpose: CreateSessionInput["purpose"];
  cwd?: string;
}

/**
 * Hang up on a stream that has said nothing for this long. OpenCode heartbeats every 30s, so
 * this is three missed beats — long enough never to fire on a healthy quiet stream, short
 * enough that a dead one is noticed before a turn's wall clock expires.
 */
const STREAM_SILENCE_MS = 90_000;

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

  private trace(what: string, detail: Record<string, unknown> = {}): void {
    try {
      this.opts.onTrace?.({ at: new Date().toISOString(), what, ...detail });
    } catch {
      /* a broken trace sink must never break the adapter */
    }
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
    this.trace("session.created", { sessionId, agent: input.agent ?? null, baseUrl: this.opts.baseUrl() });
    this.push({ type: "session.created", sessionId });
    return { sessionId };
  }

  /**
   * The turn body OpenCode actually wants.
   *
   * NO client messageID, deliberately. OpenCode orders a session's messages by id, and its ids
   * are monotonic and time-sortable; a client-generated id sorts BEFORE the last assistant
   * reply, so the agent loop sees no new input and exits at step 0 — every turn after the first
   * dies in silence. The server assigns the id; our correlation id stays on this side of the
   * wire, where the receipts always used it anyway.
   */
  private turnBody(input: SendMessageInput): { parts: Array<{ type: "text"; text: string }> } {
    return { parts: input.parts.map((p) => ({ type: "text" as const, text: p.text })) };
  }

  /** Fire-and-watch (the only mode authoring uses): completion arrives on the event stream. */
  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    const correlationId = input.correlationId ?? `corr_${Date.now().toString(36)}`;
    const session = this.sessions.get(input.sessionId);
    const directory = session?.cwd;
    // prompt_async answers 204 and runs the turn; progress arrives on the stream (R-13, D7).
    void (async () => {
      try {
        await this.http.req(
          "POST",
          `/session/${input.sessionId}/prompt_async`,
          this.turnBody(input),
          directory ? { directory } : {},
        );
        this.trace("dispatch.accepted", { sessionId: input.sessionId });
      } catch (err) {
        this.trace("dispatch.failed", { sessionId: input.sessionId, error: String(err) });
        this.push({
          type: "session.error",
          sessionId: input.sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
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

  /** The last assistant message we have already reported per session, so a resync repeats nothing. */
  private readonly reportedMessage = new Map<string, string>();

  /**
   * Catch up over REST after a reconnect. For every session this adapter owns, ask what the
   * last assistant message is; if it finished and we never announced it, announce it now.
   * Missing news is worse than late news — a caller waiting on message.completed has no other
   * way to learn the turn is over.
   */
  private async resyncCompletedTurns(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      try {
        const messages = await this.http.req<
          Array<{ info?: { id?: string; role?: string; time?: { completed?: number } }; parts?: Array<{ text?: string }> }>
        >("GET", `/session/${sessionId}/message`);
        if (!Array.isArray(messages)) continue;
        const done = [...messages]
          .reverse()
          .find((m) => m.info?.role === "assistant" && typeof m.info.time?.completed === "number");
        const id = done?.info?.id;
        if (id === undefined || this.reportedMessage.get(sessionId) === id) {
          this.trace("resync.nothing-new", { sessionId });
          continue;
        }
        this.reportedMessage.set(sessionId, id);
        const text = (done?.parts ?? []).map((p) => p.text ?? "").join("");
        this.trace("resync.recovered", { sessionId, messageId: id, chars: text.length });
        if (text.trim().length > 0) this.push({ type: "message.completed", sessionId, text });
      } catch {
        /* a session we cannot read is not a reason to abandon the reconnect */
      }
    }
  }

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

  /**
   * What this harness can actually run, and nothing else.
   *
   * `/config/providers` is the right question: it answers with the providers the user is
   * authenticated for and their models — three providers and forty-one models on a real
   * machine, against 178 providers and 5,864 models in `/provider`'s full catalogue.
   *
   * `/api/model` used to be asked first, which was a mistake worth recording. It answers with
   * one provider's own gateway catalogue — 24 models, 17 of them marked deprecated — so the
   * picker showed a long list of models the user had never heard of while omitting the
   * providers they had actually signed in to. It stays as a fallback for servers with no
   * `/config/providers`, with deprecated rows dropped.
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await this.http.req<{
        providers?: Array<{ id: string; models?: Record<string, { name?: string }> }>;
        default?: Record<string, string>;
      }>("GET", "/config/providers");
      const out: ModelInfo[] = [];
      for (const provider of res.providers ?? []) {
        const preferred = res.default?.[provider.id];
        for (const [id, model] of Object.entries(provider.models ?? {})) {
          out.push({
            id,
            provider: provider.id,
            ...(model.name ? { displayName: model.name } : {}),
            // What this provider would pick if we did not: worth putting first in its group.
            ...(id === preferred ? { isDefault: true } : {}),
          });
        }
      }
      if (out.length > 0) return out;
      throw new Error("no providers configured");
    } catch {
      const res = await this.http.req<{
        data?: Array<{ id?: string; providerID?: string; name?: string; status?: string }>;
      }>("GET", "/api/model");
      const rows = Array.isArray(res.data) ? res.data : [];
      return rows
        .filter((m) => m.id && m.status !== "deprecated")
        .map((m) => ({
          id: m.id!,
          provider: m.providerID ?? "unknown",
          ...(m.name ? { displayName: m.name } : {}),
        }));
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
    // Snapshot: a listener may register or drop another while handling this event.
    for (const listener of Array.from(this.turnListeners)) listener(parsed);
    for (const sub of this.subscribers) {
      sub.queue.push(parsed);
      sub.wake?.();
      sub.wake = null;
    }
  }

  private readonly pumpAbort = new AbortController();

  /**
   * Read the harness's event stream, forever, reconnecting when it drops.
   *
   * The watchdog is the load-bearing part, and the app was deaf for hours without it.
   *
   * A stalled read is dropped on a watchdog. A half-open socket — the peer gone without a
   * FIN, which is what a restarted harness leaves behind — never errors and never yields, so
   * `for await` waits forever on a connection that will never speak again. OpenCode heartbeats
   * every 30s; three missed beats and we hang up and dial again.
   *
   * Releasing `pumping` in `finally` is hygiene rather than the fix: this loop only ends when the
   * adapter is disposed, so a leaked guard was never what kept it quiet. Measured, not assumed —
   * the recovery test still passes with the guard deliberately leaked.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const signal = this.pumpAbort.signal;
      let backoff = 500;
      while (!this.disposed && !signal.aborted) {
        // Per attempt, so a stalled stream can be hung up on without disposing the adapter.
        const attempt = new AbortController();
        const giveUp = () => attempt.abort();
        signal.addEventListener("abort", giveUp, { once: true });
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const heard = (): void => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            this.trace("stream.stalled", { silenceMs: this.opts.streamSilenceMs ?? STREAM_SILENCE_MS });
            giveUp();
          }, this.opts.streamSilenceMs ?? STREAM_SILENCE_MS);
          (watchdog as { unref?: () => void }).unref?.();
        };
        try {
          const stream = await this.http.openEventStream(attempt.signal);
          backoff = 500;
          // The channel matters as much as the port: attached to /api/event, the app is
          // "connected" and starving. One trace line here would have named today's fault.
          this.trace("stream.connected", { baseUrl: this.opts.baseUrl(), channel: stream.path });
          heard();
          // OpenCode cannot replay what we missed (no Last-Event-ID), so ask REST what happened
          // while we were not listening. Without this a turn that finished during the gap is
          // lost for good and the caller waits out its whole deadline for news that already
          // came and went. Arke's adapter resyncs on every reconnect for the same reason.
          await this.resyncCompletedTurns();
          for await (const raw of parseSse(stream.body, attempt.signal, heard)) {
            const outcome = normalizeOpenCode(raw, this.normalizeState);
            if (outcome.kind === "events") {
              for (const event of outcome.events) {
                // Remember what the stream already told us, so a later resync does not say it
                // twice. correlationId carries the message id the completion came from.
                if (event.type === "message.completed" && "sessionId" in event && event.correlationId) {
                  this.reportedMessage.set(event.sessionId, event.correlationId);
                }
                if (event.type === "message.completed" || event.type === "session.error") {
                  this.trace(`stream.${event.type}`, "sessionId" in event ? { sessionId: event.sessionId } : {});
                }
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
        } catch (err) {
          this.trace("stream.dropped", { error: String(err) });
        } finally {
          clearTimeout(watchdog);
          signal.removeEventListener("abort", giveUp);
        }
        if (this.disposed || signal.aborted) return;
        await new Promise((r) => {
          const t = setTimeout(r, backoff);
          (t as { unref?: () => void }).unref?.();
        });
        backoff = Math.min(backoff * 2, 10_000);
      }
    } finally {
      this.pumping = false;
    }
  }

  streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    void this.pump();
    // Register eagerly, at call time — a generator body only runs on the first pull, and an
    // event arriving between dispatch and that pull must not be lost.
    const sub: { queue: HarnessEvent[]; wake: (() => void) | null } = { queue: [], wake: null };
    this.subscribers.add(sub);
    const { subscribers } = this;
    const live = () => !this.disposed;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (live() && !signal?.aborted) {
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
          subscribers.delete(sub);
        }
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

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
import { parseSse } from "../sse.js";
import { OpenCodeV2Http, sameDirectory, wireDirectory } from "./http.js";
import { createNormalizeV2State, normalizeOpenCodeV2, type NormalizeV2State } from "./normalize.js";

/**
 * The live OpenCode v2 adapter (issue 327). Drives the authenticated /api surface of an
 * opencode2 standalone server and normalises its event stream into schema-validated harness
 * events. Every wire shape here was measured against 0.0.0-next-17444 — the pinned build —
 * including a full keyed turn with a held tool call and a permission round trip.
 *
 * It never writes to a world, never calls commit(), and never decides what a ripple is —
 * SPEC-004 owns all of that. This class owns a foreign process's protocol, nothing more.
 */

export interface OpenCodeV2AdapterOptions {
  /** Resolved lazily so supervisor restarts on new ports keep working. */
  baseUrl: () => string;
  /** The server password from the launch line; null until the supervisor has parsed it. */
  password: () => string | null;
  /** Overridable so a test can prove the watchdog without waiting the better part of a minute. */
  streamSilenceMs?: number;
  /** How long init() waits out the server-global warm-up before calling it unready. */
  warmupMs?: number;
  /** One line per adapter-lifecycle fact; the host appends them to logs/harness.jsonl. */
  onTrace?: (line: Record<string, unknown>) => void;
}

interface TrackedSession {
  purpose: CreateSessionInput["purpose"];
  cwd?: string;
  agent?: string;
}

/**
 * Hang up on a stream that has said nothing for this long. v2 heartbeats every 15s (measured,
 * eight beats with no jitter beyond 0.1s), so this is three missed beats — down from the v1
 * backing's 90s.
 */
const STREAM_SILENCE_MS = 45_000;

/**
 * How long init() tolerates an unreachable or unhealthy server. The expensive init is
 * server-global and happens once — >10s measured on first probe after spawn with the catalog
 * fetch on the path — so readiness patience belongs to the first probe, not to every world.
 */
const WARMUP_MS = 30_000;

/** v2 rejects client message ids outside the msg_ namespace, and ids are globally durable. */
let wireIdCounter = 0;
function freshWireId(): string {
  wireIdCounter += 1;
  return `msg_arke_${Date.now().toString(36)}_${wireIdCounter.toString(36)}`;
}

export class OpenCodeV2Adapter implements HarnessAdapter {
  readonly id = "opencode2";
  private readonly http: OpenCodeV2Http;
  private caps = new Set<HarnessCapability>();
  private ready: Readiness = { ready: false, reason: "not probed yet" };
  serverVersion: string | null = null;
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly normalizeState: NormalizeV2State = createNormalizeV2State();
  /** Bounded record of dropped frames — contained, never silently lost (R-14). */
  readonly deadLetters: Array<{ reason: string; at: number }> = [];
  private readonly permissionSessions = new Map<string, string>();
  /** Permission asks already surfaced, so a resync repeats nothing. */
  private readonly permissionsSeen = new Set<string>();
  private disposed = false;

  // Fan-out: each streamEvents() consumer gets its own queue — the authoring service and the
  // permission pump both listen, and one must never starve the other.
  private readonly subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
  private pumping = false;

  constructor(private readonly opts: OpenCodeV2AdapterOptions) {
    this.http = new OpenCodeV2Http({ baseUrl: opts.baseUrl, password: opts.password });
  }

  private trace(what: string, detail: Record<string, unknown> = {}): void {
    try {
      // The password never appears here — the trace vocabulary has no field to put it in.
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

  /**
   * Probe /api/health with warm-up patience; idempotent (R-2). The capability probe via the
   * OpenAPI document is retired for v2 — GET /doc serves the web UI now (measured) — so the
   * capability set comes from the pinned contract once health answers.
   */
  async init(): Promise<void> {
    const deadline = Date.now() + (this.opts.warmupMs ?? WARMUP_MS);
    const started = Date.now();
    let lastError = "unreachable";
    while (Date.now() < deadline) {
      try {
        const health = await this.http.req<{ healthy?: boolean; version?: string; pid?: number }>(
          "GET",
          "/api/health",
        );
        if (health?.healthy === true) {
          this.serverVersion = health.version ?? null;
          this.caps = new Set<HarnessCapability>(["events", "models", "permissions"]);
          this.ready = { ready: true };
          this.trace("init.ready", { version: this.serverVersion, warmupMs: Date.now() - started });
          return;
        }
        lastError = "health answered but not healthy";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => {
        const t = setTimeout(r, 500);
        (t as { unref?: () => void }).unref?.();
      });
    }
    this.caps = new Set();
    this.ready = { ready: false, reason: `health check failed after warm-up: ${lastError}` };
    this.trace("init.unready", { reason: this.ready.reason });
  }

  // ---- the model window (§8.5) ---------------------------------------------

  private lastKnownWindow: number | null = null;

  knownInputTokenLimit(): number | null {
    return this.lastKnownWindow;
  }

  /**
   * The window comes from the model catalog: entries carry limit { context, input?, output },
   * and `input ?? context` is the same fallback the v1 backing used. The session's own model
   * is implementation work (it arrives on session.model.selected); the scaffold budgets from
   * the default model's window, which is the model an unpinned session answers with.
   */
  async inputTokenLimit(_sessionId: string): Promise<number | null> {
    try {
      const fallback = this.lastKnownWindow;
      await this.listModels();
      return this.lastKnownWindow ?? fallback;
    } catch {
      return this.lastKnownWindow;
    }
  }

  // ---- sessions ------------------------------------------------------------

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    const location = input.cwd;
    const session = await this.http.reqData<{ id?: string; location?: { directory?: string } }>(
      "POST",
      "/api/session",
      location ? { location: { directory: wireDirectory(location) } } : {},
    );
    const sessionId = session?.id ?? "";
    if (!sessionId) throw new Error("OpenCode v2 did not return a session id");
    // The envelope assertion in reqData covers scoped GETs; session create echoes the location
    // inside data, so assert here too — a session in the wrong directory writes the wrong world.
    if (location && session?.location?.directory !== undefined && !sameDirectory(session.location.directory, location)) {
      throw new Error(
        `OpenCode v2 created the session in the wrong location: asked ${wireDirectory(location)}, got ${session.location.directory}`,
      );
    }
    // Pin the agent as session state — v2's answer to the per-prompt agent trap the v1
    // backing carried (the `build` fallback that silently ate turns). 204 on success;
    // confirmation arrives as session.agent.selected on the stream.
    if (input.agent) {
      await this.http.req("POST", `/api/session/${sessionId}/agent`, { agent: input.agent });
    }
    this.sessions.set(sessionId, {
      purpose: input.purpose,
      ...(location ? { cwd: location } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
    });
    this.trace("session.created", { sessionId, agent: input.agent ?? null, baseUrl: this.opts.baseUrl() });
    this.push({ type: "session.created", sessionId });
    return { sessionId };
  }

  /**
   * Fire-and-watch: v2's prompt is async by definition — it returns an inbox entry, and the
   * turn's progress arrives on the stream. The wire id is generated fresh per prompt in the
   * msg_ namespace (client ids are durable and globally unique — a reuse answers 409, even in
   * another session; measured). The caller's correlation id stays on this side of the wire.
   */
  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    const correlationId = input.correlationId ?? `corr_${Date.now().toString(36)}`;
    const text = input.parts.map((p) => p.text).join("\n");
    void (async () => {
      try {
        await this.http.reqData<{ id?: string }>("POST", `/api/session/${input.sessionId}/prompt`, {
          id: freshWireId(),
          text,
        });
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

  /** Interrupt a running turn; the proposal keeps whatever the agent had written (R-12). */
  async interrupt(sessionId: string): Promise<void> {
    await this.http.req("POST", `/api/session/${sessionId}/interrupt`, {});
  }

  /** Cumulative token usage for a session — v2 states running totals on usage events. */
  usageTokens(sessionId: string): number {
    return this.normalizeState.tokensBySession.get(sessionId) ?? 0;
  }

  // ---- completion and resync share one code path (§6) ----------------------

  /** The last assistant message already reported per session, so nothing repeats. */
  private readonly reportedMessage = new Map<string, string>();

  /**
   * Fetch the newest completed assistant message and report it, unless it was already
   * reported. Called when the stream says the turn succeeded (the event carries no text —
   * measured) and again on every reconnect, for every tracked session.
   *
   * The v2 message list is cursor-paginated `{ data, cursor }`, newest first, with agent and
   * model switches recorded as messages — only `type: "assistant"` rows carry a turn's text.
   */
  private async reportCompletedTurn(sessionId: string): Promise<void> {
    try {
      const messages = await this.http.reqData<
        Array<{
          id?: string;
          type?: string;
          time?: { completed?: number };
          content?: Array<{ type?: string; text?: string }>;
        }>
      >("GET", `/api/session/${sessionId}/message`);
      if (!Array.isArray(messages)) return;
      const done = messages.find((m) => m.type === "assistant" && typeof m.time?.completed === "number");
      const id = done?.id;
      if (id === undefined || this.reportedMessage.get(sessionId) === id) {
        this.trace("turn.nothing-new", { sessionId });
        return;
      }
      this.reportedMessage.set(sessionId, id);
      const text = (done?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
      this.normalizeState.textBySession.delete(sessionId);
      this.trace("turn.completed", { sessionId, messageId: id, chars: text.length });
      this.push({ type: "message.completed", sessionId, correlationId: id, text });
    } catch (err) {
      this.trace("turn.fetch-failed", { sessionId, error: String(err) });
    }
  }

  /**
   * Re-emit pending permission asks after a reconnect. Session-scoped deliberately: the
   * global GET /api/permission/request answered empty while an ask sat pending and the
   * session-scoped route returned it (measured), so the global listing is not trusted here.
   */
  private async resyncPendingPermissions(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      try {
        const pending = await this.http.reqData<
          Array<{ id?: string; action?: string; resources?: unknown[] }>
        >("GET", `/api/session/${sessionId}/permission`);
        for (const request of pending ?? []) {
          if (!request.id || this.permissionsSeen.has(request.id)) continue;
          this.permissionsSeen.add(request.id);
          const resources = (request.resources ?? []).filter((r): r is string => typeof r === "string");
          this.trace("resync.permission", { sessionId, permissionId: request.id });
          this.push({
            type: "permission.requested",
            sessionId,
            permissionId: request.id,
            actionClass: request.action ?? "an action",
            ...(resources.length > 0 ? { detail: resources.join(", ").slice(0, 300) } : {}),
          });
        }
      } catch {
        /* a session we cannot read is not a reason to abandon the reconnect */
      }
    }
  }

  // ---- permissions ---------------------------------------------------------

  async respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    const sessionId = this.permissionSessions.get(decision.permissionId);
    if (!sessionId) return { permissionId: decision.permissionId, status: "stale" };
    try {
      // The contracts' verbs are v2's verbs — once | always | reject — and the optional
      // message carries the refusal reason to the agent (issue 327 §6).
      await this.http.req("POST", `/api/session/${sessionId}/permission/${decision.permissionId}/reply`, {
        reply: decision.decision,
        ...(decision.message !== undefined ? { message: decision.message } : {}),
      });
    } catch {
      return { permissionId: decision.permissionId, status: "stale" };
    }
    // Confirmation comes only from the replied event, never HTTP status; wait briefly.
    const confirmed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.turnListeners.delete(listener);
        resolve(false);
      }, 3_000);
      (timer as { unref?: () => void }).unref?.();
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

  // ---- models --------------------------------------------------------------

  /**
   * GET /api/model, with /api/model/default marking the default row. Emptiness before an
   * integration connects is expected (measured — even the built-in agents hide then); an
   * empty list with a healthy server is a readiness reason, not an error.
   */
  async listModels(): Promise<ModelInfo[]> {
    const rows = await this.http.reqData<
      Array<{
        id?: string;
        providerID?: string;
        name?: string;
        disabled?: boolean;
        limit?: { context?: number; input?: number };
      }>
    >("GET", "/api/model");
    let defaultKey: string | null = null;
    try {
      const def = await this.http.reqData<{ id?: string; providerID?: string }>("GET", "/api/model/default");
      if (def?.id && def.providerID) defaultKey = `${def.providerID}/${def.id}`;
    } catch {
      /* a server with no resolvable default still has a catalog */
    }
    const out: ModelInfo[] = [];
    for (const row of rows ?? []) {
      if (!row.id || row.disabled === true) continue;
      const key = `${row.providerID ?? "unknown"}/${row.id}`;
      const window = row.limit?.input ?? row.limit?.context ?? null;
      if (key === defaultKey && window !== null) this.lastKnownWindow = window;
      out.push({
        id: row.id,
        provider: row.providerID ?? "unknown",
        ...(row.name ? { displayName: row.name } : {}),
        ...(key === defaultKey ? { isDefault: true } : {}),
      });
    }
    return out;
  }

  // ---- the event pump ------------------------------------------------------

  private push(event: HarnessEvent): void {
    const parsed = HarnessEventSchema.parse(event);
    if (parsed.type === "permission.requested") {
      this.permissionSessions.set(parsed.permissionId, parsed.sessionId);
      this.permissionsSeen.add(parsed.permissionId);
    }
    for (const listener of Array.from(this.turnListeners)) listener(parsed);
    for (const sub of this.subscribers) {
      sub.queue.push(parsed);
      sub.wake?.();
      sub.wake = null;
    }
  }

  private readonly pumpAbort = new AbortController();

  /**
   * Read the event stream, forever, reconnecting when it drops. The silence watchdog, the
   * per-attempt aborts, and the resync-on-reconnect all survive from the v1 backing — v2
   * still has no stream replay (`subscribe` takes no cursor) — only the numbers changed:
   * heartbeats every 15s, so the watchdog fires at three missed beats.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const signal = this.pumpAbort.signal;
      let backoff = 500;
      while (!this.disposed && !signal.aborted) {
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
          this.trace("stream.connected", { baseUrl: this.opts.baseUrl(), channel: stream.path });
          heard();
          // No replay on the wire: ask REST what happened while we were not listening —
          // completed turns and pending permission asks both (issue 327 §6).
          for (const sessionId of this.sessions.keys()) await this.reportCompletedTurn(sessionId);
          await this.resyncPendingPermissions();
          for await (const raw of parseSse(stream.body, attempt.signal, heard)) {
            const outcome = normalizeOpenCodeV2(raw, this.normalizeState);
            if (outcome.kind === "turn-succeeded") {
              if (this.sessions.has(outcome.sessionId)) await this.reportCompletedTurn(outcome.sessionId);
              continue;
            }
            if (outcome.kind === "events") {
              for (const event of outcome.events) {
                if (event.type === "session.error") {
                  this.trace("stream.session.error", "sessionId" in event ? { sessionId: event.sessionId } : {});
                }
                // Only surface events for sessions this adapter created — even a private v2
                // server multiplexes locations, so this filter earns its keep.
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
    // Register eagerly, at call time — an event arriving between dispatch and the first pull
    // must not be lost.
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

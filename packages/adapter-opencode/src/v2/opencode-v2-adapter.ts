import {
  HarnessEventSchema,
  ROSTER,
  STUDIO_ASSISTANT_LIMITS,
  type HarnessCapability,
  type CreateSessionInput,
  type HarnessAdapter,
  type HarnessEvent,
  type ModelInfo,
  type PermissionAck,
  type PermissionAssessment,
  type PermissionDecision,
  type PermissionRequest,
  type Readiness,
  type SendMessageInput,
  type SendReceipt,
  type SessionRef,
  type SessionConfigInput,
  type SessionFile,
  type PrivateSessionDestination,
  type PrivateSessionRequest,
  type PrivateSessionTransport,
  type VendorIntegration,
  type VendorOAuthAttempt,
  type VendorOAuthAttemptState,
} from "@arke-studio/contracts";
import { assessV2Permission, buildSessionConfigV2 } from "./config.js";
import { PreparedSessionPolicies, type SessionPermissionPolicy } from "../permission-policy.js";
import { parseSse, SseFrameLimitError } from "../sse.js";
import { modelEnabled, modelMetadata, providerNameOf, type WireModel } from "../model-metadata.js";
import { OpenCodeV2Http, sameDirectory, wireDirectory } from "./http.js";
import { OpenCodeError } from "../http.js";
import { OPENCODE2_PINNED_VERSION } from "../discovery.js";
import { waitForSessionModel } from "./model-readiness.js";
import { imagePrompt, sessionImageInput, qualifySessionImageInput, type SessionImageInput } from "./image-input.js";
import { createNormalizeV2State, normalizeOpenCodeV2, type NormalizeV2State } from "./normalize.js";
import { privateSessionDestination } from "./private-destination.js";
import { privateControlFiles, privateControlDirectory, privateControlProof, privateWireBody, privateBridgeTransport } from "./private-control.js";
import {
  normalizeAttempt,
  normalizeAttemptStatus,
  normalizeIntegration,
  type WireAttempt,
  type WireAttemptStatus,
  type WireIntegration,
} from "./vendor-auth.js";

/**
 * The live OpenCode v2 adapter (issue 327). Drives the authenticated /api surface of an
 * opencode2 standalone server and normalises its event stream into schema-validated harness
 * events. The supported release is 2.0.26; real-binary tests qualify launch, credential
 * persistence and a scripted local turn with tool confinement and a permission round trip.
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
  /** Local ceiling inside the caller's session-creation deadline, overridable in regressions. */
  modelReadyMs?: number;
  /** Finite per-adapter private identity budget, including failed creation/retired tombstones. */
  privateSessionLimit?: number;
  /** Deadline for observing the transient API result. Expiry leaves inference unknown;
   * requester Stop does not cancel this independent completion observation. */
  privateGenerationMs?: number;
  /** One line per adapter-lifecycle fact; the host appends them to logs/harness.jsonl. */
  onTrace?: (line: Record<string, unknown>) => void;
}

interface TrackedSession {
  private: boolean;
  privateTextBytes?: number;
  privateTextTail?: string;
  privateResponseRejected?: boolean;
  privatePermissionRequests?: number;
  privateTurn?: { dispatched: boolean; stopped: boolean; confirmed: boolean; settled: Promise<void>; complete(): void };
  ownerHttp?: OpenCodeV2Http;
  privateRequest?: PrivateSessionRequest;
  privateRoute?: { requested(): boolean; verified(): boolean; verify(signal: AbortSignal): Promise<PrivateSessionDestination | null> };
  purpose: CreateSessionInput["purpose"];
  cwd?: string;
  agent?: string;
  permissionPolicy: SessionPermissionPolicy | null;
  image: SessionImageInput;
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

/** `provider/model` as v2's session model reference. Null when no provider is named: the server decides. */
export function wireModelRef(reference: string, variant?: string): { providerID: string; id: string; variant?: string } | null {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) return null;
  return { providerID: reference.slice(0, slash), id: reference.slice(slash + 1), ...(variant !== undefined ? { variant } : {}) };
}

/** v2 rejects client message ids outside the msg_ namespace, and ids are globally durable. */
let wireIdCounter = 0;
function freshWireId(): string {
  wireIdCounter += 1;
  return `msg_arke_${Date.now().toString(36)}_${wireIdCounter.toString(36)}`;
}

export class OpenCodeV2Adapter implements HarnessAdapter {
  readonly id = "opencode2";
  readonly privateSessions = true as const;
  readonly privateDestinations = true as const;
  readonly privatePayloads = true as const;
  readonly privateTransient = true as const;
  readonly imageInput = true;
  imageInputForSession(id: string): boolean { return this.sessions.get(id)?.image.supported === true; }
  imageDestinationForSession(id: string) {
    const image = this.sessions.get(id)?.image;
    return { provider: image?.provider ?? this.id, local: image?.local === true };
  }
  private readonly http: OpenCodeV2Http;
  private caps = new Set<HarnessCapability>();
  private ready: Readiness = { ready: false, reason: "not probed yet" };
  serverVersion: string | null = null;
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly retiredPrivateIds = new Set<string>();
  private privateAdmissions = 0;
  private readonly normalizeState: NormalizeV2State = createNormalizeV2State();
  /** Bounded record of dropped frames — contained, never silently lost (R-14). */
  readonly deadLetters: Array<{ reason: string; at: number }> = [];
  /**
   * Permission id → session id, for the session-scoped reply route. Doubles as the
   * already-surfaced record the resync checks — one structure, one invariant.
   */
  private readonly permissionSessions = new Map<string, string>();
  private readonly preparedPolicies = new PreparedSessionPolicies();
  private disposed = false;
  private runtimeRequests = new AbortController();
  private runtimeRevision = 0;
  private readonly pendingTurns = new Set<string>();

  lifecycleRevision(): number { return this.runtimeRevision; }

  /** Host-confirmed process exit is stronger evidence than an SSE disconnect. End local
   * waits with an unknown outcome; never replay a prompt or claim that inference stopped. */
  runtimeExited(): void {
    this.runtimeRevision++;
    this.runtimeRequests.abort();
    this.runtimeRequests = new AbortController();
    for (const session of this.sessions.values()) if (session.privateTurn) session.privateTurn.stopped = true;
    // push() deletes settled entries and synchronously notifies listeners; preserve the
    // interrupted set so a listener cannot add a new turn to this exit's iteration.
    for (const sessionId of Array.from(this.pendingTurns)) {
      this.push({ type: "session.error", sessionId,
        message: "The writing service exited before this turn was confirmed. Its outcome is unknown. The request was not replayed." });
    }
  }

  // Fan-out: each streamEvents() consumer gets its own queue — the authoring service and the
  // permission pump both listen, and one must never starve the other.
  private readonly subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null; sessionId?: string }>();
  private pumping = false;

  constructor(private readonly opts: OpenCodeV2AdapterOptions) {
    if (opts.privateSessionLimit !== undefined && (!Number.isSafeInteger(opts.privateSessionLimit) || opts.privateSessionLimit < 1 || opts.privateSessionLimit > 8192)) throw new Error("Invalid private native session budget");
    if (opts.privateGenerationMs !== undefined && (!Number.isSafeInteger(opts.privateGenerationMs) || opts.privateGenerationMs < 1 || opts.privateGenerationMs > 900_000)) throw new Error("Invalid private native generation deadline");
    this.http = new OpenCodeV2Http({ baseUrl: opts.baseUrl, password: opts.password });
  }

  private trace(what: string, detail: Record<string, unknown> = {}): void {
    // HTTP errors can echo prompt or response bytes. Private session facts have no path to
    // the common harness trace, even when the backend supplies a verbose failure body.
    if (typeof detail.sessionId === "string" && (this.retiredPrivateIds.has(detail.sessionId) || this.sessions.get(detail.sessionId)?.private || !this.sessions.has(detail.sessionId) && !this.pendingTurns.has(detail.sessionId))) return;
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
   * Probe /api/info with warm-up patience; idempotent (R-2). Only the qualified release
   * is supported: a running older server must not pass a discovery-only gate.
   * The capability set comes from the pinned contract once authenticated server info answers.
   */
  async init(): Promise<void> {
    const deadline = Date.now() + (this.opts.warmupMs ?? WARMUP_MS);
    const started = Date.now();
    let lastError = "unreachable";
    while (Date.now() < deadline) {
      try {
        const health = await this.http.req<{ version?: string; pid?: number }>("GET", "/api/info");
        if (health?.version !== OPENCODE2_PINNED_VERSION) {
          this.caps = new Set();
          this.ready = { ready: false, reason: `OpenCode ${health?.version ?? "unknown"} is unsupported; use ${OPENCODE2_PINNED_VERSION}.` };
          return;
        }
        if (typeof health.pid === "number" && health.pid > 0) {
          this.serverVersion = health.version ?? null;
          this.caps = new Set<HarnessCapability>(["events", "models", "permissions", "auth"]);
          this.ready = { ready: true };
          this.trace("init.ready", { version: this.serverVersion, warmupMs: Date.now() - started });
          // Prime the window so the first turn budgets from the real model, not the fallback
          // floor — the same reason v1's init ended with primeInputTokenLimit (§8.5).
          void this.listModels().catch(() => null);
          return;
        }
        lastError = "server info did not contain a valid process id";
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
  /** Every catalogue row's window by `provider/id`, so a pinned session can be budgeted from its own model. */
  private readonly modelWindows = new Map<string, number>();
  /** A global row only admits the scoped verification below; it never proves destination. */
  /**
   * The pinned model's window per session, taken at creation from the catalogue as it stood
   * then. Null is a pinned model whose window the catalogue did not state: the caller's floor
   * is the right budget for it, and the default model's window is the wrong one twice over.
   */
  private readonly sessionWindows = new Map<string, number | null>();

  knownInputTokenLimit(sessionId?: string): number | null {
    if (sessionId !== undefined && this.sessionWindows.has(sessionId)) return this.sessionWindows.get(sessionId)!;
    return this.lastKnownWindow;
  }

  /**
   * The window comes from the model catalog: entries carry limit { context, input?, output },
   * and `input ?? context` is the same fallback the v1 backing used. Cached once learned —
   * the default model cannot change without the server restarting, and a catalog fetch per
   * turn is exactly the per-message cost v1's design comment forbids. The session's own model
   * is implementation work (it arrives on session.model.selected); until then this budgets
   * from the default model's window, which is the model an unpinned session answers with.
   */
  async inputTokenLimit(_sessionId: string): Promise<number | null> {
    if (this.lastKnownWindow !== null) return this.lastKnownWindow;
    try {
      await this.listModels();
    } catch {
      /* the fallback budget covers this */
    }
    return this.lastKnownWindow;
  }

  // ---- sessions ------------------------------------------------------------

  /**
   * OpenCode reads Studio's roster, tool limits and MCP registration from a config file beside
   * the work — so this is where the session's confinement actually reaches the harness (R-5).
   */
  sessionFiles(input: SessionConfigInput, directory?: string, request?: PrivateSessionRequest, transport?: PrivateSessionTransport): ReadonlyArray<SessionFile> {
    const operational = ROSTER.some(member => member.name === input.agent && member.operationalOnly);
    if (operational && !directory) throw new Error("Private native control requires its session directory.");
    if (request && (!operational || request.model !== input.model)) throw new Error("The private request does not match its prepared model.");
    return [...(operational ? privateControlFiles(request, request ? "generate" : "primary") : []), { name: "opencode.json", contents: `${JSON.stringify(buildSessionConfigV2(input, operational ? privateControlDirectory(directory!) : undefined, request ? privateWireBody(request) : undefined, transport), null, 2)}
` }];
  }

  prepareSession(input: SessionConfigInput): void {
    this.preparedPolicies.prepare(input);
  }

  abandonSessionPreparation(preparationId: string): void {
    this.preparedPolicies.abandon(preparationId);
  }

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    // The effort is part of the model reference v2 pins on the session (`POST …/model` takes
    // `{ providerID, id, variant? }`); it is read before `take` retires the preparation.
    const model = wireModelRef(this.preparedPolicies.model(input.agent, input.preparationId) ?? "",
      this.preparedPolicies.modelVariant(input.preparationId));
    const permissionPolicy = this.preparedPolicies.take(input.agent, input.preparationId);
    if (input.preparationId !== undefined && permissionPolicy === null) {
      throw new Error("session preparation is missing or was already consumed");
    }
    const privateSession = input.visibility === "private";
    const suppliedWriter = input.privateWriter;
    if (suppliedWriter && (!privateSession || !input.privateRequest || !input.cwd || !input.agent ||
      !/^[a-f0-9]{64}$/.test(suppliedWriter.identity) || [suppliedWriter.bindDirectory, suppliedWriter.bindSession, suppliedWriter.fetch,
        suppliedWriter.current, suppliedWriter.seal, suppliedWriter.busy, suppliedWriter.close].some(method => typeof method !== "function"))) throw new Error("The private writing connection could not be bound.");
    const writer = suppliedWriter ? Object.freeze({ identity: suppliedWriter.identity, bindDirectory: suppliedWriter.bindDirectory.bind(suppliedWriter),
      bindSession: suppliedWriter.bindSession.bind(suppliedWriter), fetch: suppliedWriter.fetch.bind(suppliedWriter), current: suppliedWriter.current.bind(suppliedWriter) }) : undefined;
    if (writer && (!writer.current() || !writer.bindDirectory(input.cwd!, input.agent!))) throw new Error("The private writing connection could not be bound.");
    const privateRequest = input.privateRequest ? Object.freeze({ ...input.privateRequest }) : undefined;
    const privateTransport = input.privateTransport ? privateBridgeTransport(input.privateTransport) : undefined;
    if (privateTransport && (!privateSession || !privateRequest)) throw new Error("A private bridge requires a sealed private request.");
    if (privateRequest) {
      privateWireBody(privateRequest);
      if (!privateSession || !model || privateRequest.model !== `${model.providerID}/${model.id}` || model.variant && model.variant !== "default") throw new Error("The private request does not match its prepared model or qualified variant.");
    }
    if (privateSession && (!permissionPolicy || !ROSTER.some(member => member.name === input.agent && member.operationalOnly))) {
      throw new Error("Private events require a prepared operational role.");
    }
    if (privateSession) {
      if (this.privateAdmissions >= (this.opts.privateSessionLimit ?? 8192)) throw new Error("The private native session budget requires host reconciliation.");
      this.privateAdmissions++;
    }
    const revision = this.runtimeRevision, runtime = this.runtimeRequests;
    const ownerBase = this.opts.baseUrl(), ownerPassword = this.opts.password();
    const http = privateSession ? new OpenCodeV2Http({ baseUrl: () => ownerBase, password: () => ownerPassword,
      ...(writer ? { fetch: async (url, init) => {
        if (!writer.current()) throw new Error("The original private writing connection changed.");
        const response = await writer.fetch(url, init);
        if (!writer.current()) { await response.body?.cancel(); throw new Error("The original private writing connection changed."); }
        return response;
      } } : {}) }) : this.http;
    const location = input.cwd;
    // The model is session state, pinned at creation (issue 1247). Measured against the pinned
    // build: an agent's `model` in opencode.json shows on GET /api/agent and is never consulted
    // for a turn — the runner reads only the session's own model, and a session without one
    // answers with the server default. So every choice Studio wrote into the config was being
    // read back as the default model, a cloud one, whatever the person had picked. Split at
    // the first slash, because a model id may carry its own (`openrouter/vendor/model`).
    const session = await http.reqData<{ id?: string; location?: { directory?: string } }>(
      "POST",
      "/api/session",
      {
        ...(location ? { location: { directory: wireDirectory(location) } } : {}),
        ...(model !== null ? { model } : {}),
      },
      { signal: input.signal, ...(privateSession ? { responseBytes: 64 * 1024 } : {}) },
    );
    const sessionId = session?.id ?? "";
    if (!sessionId) throw new Error("OpenCode v2 did not return a session id");
    if (privateSession && sessionId.length > 256) throw new Error("The private native session identity exceeds its bound.");
    if (writer && !writer.bindSession(sessionId)) throw new Error("The private writing connection returned an unexpected session.");
    // Never reclassify an existing World/private session or delete somebody else's session
    // as failed-creation cleanup when a malformed backend reuses its identity.
    if (this.sessions.has(sessionId) || this.retiredPrivateIds.has(sessionId)) throw new Error("OpenCode v2 returned an already owned session identity");
    let window = model !== null ? this.modelWindows.get(`${model.providerID}/${model.id}`) ?? null : undefined;
    let image = sessionImageInput(null, model?.providerID ?? this.id);
    try {
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
        await http.req("POST", `/api/session/${sessionId}/agent`, { agent: input.agent }, { signal: input.signal, ...(privateSession ? { responseBytes: 64 * 1024 } : {}) });
      }
      const row = await waitForSessionModel(http, model, location ?? session.location?.directory, input.signal, this.opts.modelReadyMs);
      if (row !== null) window = modelMetadata(row).inputTokenLimit ?? null;
      // Only a pinned selection identifies where these bytes will go. A global default or a
      // model name is not evidence for this location; failed/unknown metadata stays unreadable.
      if (model !== null) {
        try {
          const signal = AbortSignal.any([AbortSignal.timeout(writer ? 30_000 : 5_000), ...(input.signal ? [input.signal] : [])]);
          const scopedLocation = location ?? session.location?.directory;
          const envelope = await http.req<{ data: WireModel[]; location?: { directory?: string } }>("GET", "/api/model", undefined,
            { location: scopedLocation, signal, ...(privateSession ? { responseBytes: 1024 ** 2 } : {}) });
          if (scopedLocation !== undefined && !sameDirectory(envelope?.location?.directory, scopedLocation)) {
            throw new Error("OpenCode image catalog did not confirm the session location");
          }
          const rows = envelope?.data;
          const matches = Array.isArray(rows) ? rows.filter(item => item.providerID === model.providerID && item.id === model.id) : [];
          const selected = matches.length === 1 ? matches[0] : undefined;
          image = await qualifySessionImageInput(selected ?? null, model.providerID, signal);
        } catch {
          input.signal?.throwIfAborted();
        }
      }
      input.signal?.throwIfAborted();
      if (privateSession && (this.runtimeRevision !== revision || this.disposed)) throw new Error("The private writing owner changed during creation.");
    } catch (error) {
      // Nobody upstream has this id yet. A failed pin, readiness check or stop must not leave
      // an orphan. Retirement is best-effort, bounded and independent of the caller's signal.
      await http.req<void>("DELETE", `/api/session/${sessionId}`, undefined, { signal: AbortSignal.timeout(5_000) }).catch(() => {});
      throw error;
    }
    if (window !== undefined) this.sessionWindows.set(sessionId, window);
    let complete!: () => void;
    const privateTurn: TrackedSession["privateTurn"] = privateSession ? { dispatched: false, stopped: false, confirmed: false, settled: new Promise<void>(resolve => { complete = resolve; }), complete: () => { privateTurn!.confirmed = true; complete(); } } : undefined;
    let routeRequested = false, routeRefused = false, routePin: PrivateSessionDestination | undefined;
    const verifyRoute = async (callerSignal: AbortSignal): Promise<PrivateSessionDestination | null> => {
      routeRequested = true;
      if (!privateTurn || privateTurn.stopped || privateTurn.dispatched || routeRefused || !model || !location || !input.agent || this.disposed || this.runtimeRevision !== revision) return null;
      const signal = AbortSignal.any([callerSignal, runtime.signal, AbortSignal.timeout(writer ? 30_000 : 5_000)]);
      let destination: PrivateSessionDestination | null;
      try {
        destination = await privateSessionDestination(http, { sessionId, directory: location, agent: input.agent, model, request: privateRequest, transport: privateTransport }, signal, !routePin);
        signal.throwIfAborted();
      } catch (error) { routeRefused = true; throw error; }
      if (this.disposed || this.runtimeRevision !== revision || privateTurn.stopped || privateTurn.dispatched) return null;
      if (!destination || routePin && (routePin.identity !== destination.identity || routePin.local !== destination.local)) { routeRefused = true; return null; }
      routePin ??= destination; return routePin;
    };
    const tracked: TrackedSession = {
      private: privateSession,
      ...(privateRequest ? { privateRequest } : {}),
      ...(privateTurn ? { privateTurn, ownerHttp: http, privateRoute: { requested: () => routeRequested, verified: () => !!routePin && !routeRefused, verify: verifyRoute } } : {}),
      purpose: input.purpose,
      ...(location ? { cwd: location } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      permissionPolicy,
      image,
    };
    this.sessions.set(sessionId, tracked);
    let retired = false, retiring: Promise<boolean> | undefined;
    const retireCapturedState = (): boolean => {
      const current = this.sessions.get(sessionId);
      if (current !== tracked && !(this.disposed && current === undefined)) return false;
      this.retiredPrivateIds.add(sessionId); if (current === tracked) this.sessions.delete(sessionId); this.sessionWindows.delete(sessionId);
      this.normalizeState.textBySession.delete(sessionId); this.normalizeState.tokensBySession.delete(sessionId); this.reportedMessage.delete(sessionId); this.pendingTurns.delete(sessionId);
      for (const [permissionId, owner] of this.permissionSessions) if (owner === sessionId) this.permissionSessions.delete(permissionId);
      privateTurn!.stopped = true; privateTurn!.complete(); retired = true; return true;
    };
    const retire = (callerSignal: AbortSignal): Promise<boolean> => {
      if (retired) return Promise.resolve(true);
      if (retiring) return retiring;
      const work = async () => {
        if (!privateTurn || privateTurn.dispatched && !privateTurn.confirmed || this.disposed || this.runtimeRevision !== revision || this.sessions.get(sessionId) !== tracked) return false;
        privateTurn.stopped = true;
        const signal = AbortSignal.any([callerSignal, runtime.signal, AbortSignal.timeout(writer ? 30_000 : 5_000)]);
        const absent = async (path: string) => { try { await http.reqData("GET", path, undefined, { signal, responseBytes: 64 * 1024 }); return false; } catch (error) { if (error instanceof OpenCodeError && error.status === 404) return true; throw error; } };
        try {
          const path = `/api/session/${encodeURIComponent(sessionId)}`;
          if (!await absent(path)) {
            const state = await http.reqData<{ id?: string; agent?: string; model?: { providerID?: string; id?: string; variant?: string }; location?: { directory?: string } }>("GET", path, undefined, { signal, responseBytes: 64 * 1024 });
            if (state?.id !== sessionId || state.agent !== input.agent || location && !sameDirectory(state.location?.directory, location) || model && (state.model?.providerID !== model.providerID || state.model.id !== model.id || (state.model.variant ?? "default") !== (model.variant ?? "default"))) return false;
            await http.req("DELETE", path, undefined, { signal, responseBytes: 64 * 1024 });
          }
          if (!await absent(path) || !await absent(`${path}/message`)) return false;
          signal.throwIfAborted(); if (this.runtimeRevision !== revision || this.sessions.get(sessionId) !== tracked) return false;
          return retireCapturedState();
        } catch { return false; }
      };
      retiring = work().finally(() => { retiring = undefined; }); return retiring;
    };
    this.trace("session.created", { sessionId, agent: input.agent ?? null, baseUrl: this.opts.baseUrl() });
    this.push({ type: "session.created", sessionId });
    let observed = false;
    return { sessionId, ...(privateTurn ? { privateTurnSettled: privateTurn.settled,
      privateDestination: verifyRoute,
      privateRetire: retire,
      // This existing host-only capability confirms BOTH original writer and backing work
      // are gone. It must not query a dead or replacement endpoint to retire local state.
      privateOwnerStopped: () => { privateTurn.stopped = true; privateTurn.complete(); if (!retired) retireCapturedState(); }, privateEvents: (signal: AbortSignal) => {
      if (retired) throw new Error("The private operational session was retired.");
      if (observed) throw new Error("The private session observer was already used.");
      observed = true;
      return this.events(signal, sessionId);
    } } : {}) };
  }

  /**
   * Fire-and-watch: v2's prompt is async by definition — it returns an inbox entry, and the
   * turn's progress arrives on the stream. The wire id is generated fresh per prompt in the
   * msg_ namespace: replaying an existing id returns its original input, even when the text
   * changed. The caller's correlation id stays on this side of the wire.
   */
  async dispatchAsync(input: SendMessageInput, beforeDispatch?: () => void): Promise<SendReceipt> {
    if (this.disposed) throw new Error("The writing adapter is closed.");
    if (this.retiredPrivateIds.has(input.sessionId)) throw new Error("The private operational owner has been retired.");
    if (input.parts.some(part => part.type === "image") && !this.imageInputForSession(input.sessionId)) {
      throw new Error("This OpenCode session cannot inspect images. Select a model with verified image input.");
    }
    const tracked = this.sessions.get(input.sessionId), privateTurn = tracked?.privateTurn;
    if (privateTurn) {
      if (privateTurn.stopped) throw new Error("The private operational owner has been retired.");
      if (privateTurn.dispatched) throw new Error("A private operational session permits one model turn only.");
      if (tracked.privateResponseRejected) throw new Error("The private response observation was refused before dispatch.");
      if (tracked.privateRoute?.requested() && (!tracked.privateRoute.verified() || !await tracked.privateRoute.verify(this.runtimeRequests.signal))) throw new Error("The private model destination changed or could not be verified. No prompt was sent.");
      if (!tracked.privateRoute?.requested() && (!tracked.cwd || !await privateControlProof(tracked.ownerHttp!, tracked.cwd, this.runtimeRequests.signal, tracked.privateRequest, tracked.privateRequest ? "generate" : "primary"))) throw new Error("The private native retry control could not be verified. No prompt was sent.");
      if (tracked.privateRequest && (input.parts.length !== 1 || input.parts[0]?.type !== "text" || input.parts[0].text !== tracked.privateRequest.prompt)) throw new Error("The private prompt does not match its reviewed request. No prompt was sent.");
      if (tracked.privateRequest && input.correlationId !== undefined && input.correlationId.length > 256) throw new Error("The private correlation identity exceeds its bound.");
      if (privateTurn.stopped || privateTurn.dispatched || tracked.privateResponseRejected || this.disposed) throw new Error("The private operational owner changed before dispatch.");
      beforeDispatch?.();
      privateTurn.dispatched = true;
    } else beforeDispatch?.();
    // The turn's completion arrives only on the stream — make sure someone is listening even
    // if the host never called streamEvents(), or sendMessage waits on silence forever.
    void this.pump();
    const correlationId = input.correlationId ?? `corr_${Date.now().toString(36)}`;
    const prompt = imagePrompt(input.parts);
    const runtime = this.runtimeRequests;
    this.pendingTurns.add(input.sessionId);
    if (tracked?.privateRequest) {
      void this.dispatchTransient(input.sessionId, correlationId, tracked, runtime);
      return { sessionId: input.sessionId, correlationId };
    }
    void (async () => {
      try {
        await (tracked?.ownerHttp ?? this.http).reqData<{ id?: string }>("POST", `/api/session/${input.sessionId}/prompt`, {
          id: freshWireId(),
          ...prompt,
        }, { signal: runtime.signal, ...(tracked?.private ? { responseBytes: 2 * 1024 ** 2 } : {}) });
        if (tracked?.private && this.sessions.get(input.sessionId) !== tracked) return;
        this.trace("dispatch.accepted", { sessionId: input.sessionId });
      } catch (err) {
        if (runtime.signal.aborted || this.disposed || tracked?.private && this.sessions.get(input.sessionId) !== tracked) return;
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

  /** The response hook admits a complete stream before native /generate returns its text.
   * Only that guarded API result can confirm this owner. Errors, Stop acknowledgements,
   * stream notifications and cached messages cannot provide a substitute result/proof. */
  private async dispatchTransient(sessionId: string, correlationId: string, owner: TrackedSession, runtime: AbortController): Promise<void> {
    const current = () => !runtime.signal.aborted && !this.disposed && this.sessions.get(sessionId) === owner;
    const signal = AbortSignal.any([runtime.signal, AbortSignal.timeout(this.opts.privateGenerationMs ?? 300_000)]);
    try {
      const result = await owner.ownerHttp!.reqData<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/generate`, { prompt: owner.privateRequest!.prompt },
        { signal, responseBytes: 2 * 1024 ** 2 });
      if (!current()) return;
      if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 1 ||
        !("text" in result) || typeof result.text !== "string" || Buffer.byteLength(result.text) > STUDIO_ASSISTANT_LIMITS.responseBytes) {
        this.rejectPrivateResponse(sessionId); return;
      }
      // A control lost while native was awaiting its provider cannot borrow earlier approval.
      if (!owner.cwd || !await privateControlProof(owner.ownerHttp!, owner.cwd, signal, owner.privateRequest, "generate")) { this.rejectPrivateResponse(sessionId); return; }
      if (!current()) return;
      owner.privateTurn!.complete();
      if (owner.privateTurn!.stopped || owner.privateResponseRejected) { this.pendingTurns.delete(sessionId); return; }
      this.push({ type: "message.completed", sessionId, correlationId, text: result.text });
    } catch {
      if (!current() || owner.privateResponseRejected) return;
      this.push({ type: "session.error", sessionId, message: "The private transient model request could not be confirmed." });
    }
  }

  /** Synchronous send: resolves when this session's turn completes (or errors). */
  async sendMessage(input: SendMessageInput, beforeDispatch?: () => void): Promise<SendReceipt> {
    let listener!: (event: HarnessEvent) => void;
    const completed = new Promise<void>((resolve) => {
      const check = (event: HarnessEvent): boolean =>
        (event.type === "message.completed" || event.type === "session.error" || event.type === "session.ended") &&
        "sessionId" in event &&
        event.sessionId === input.sessionId;
      listener = (event: HarnessEvent) => {
        if (check(event)) {
          this.turnListeners.delete(listener);
          resolve();
        }
      };
      this.turnListeners.add(listener);
    });
    try {
      const receipt = await this.dispatchAsync(input, beforeDispatch);
      await completed;
      return receipt;
    } finally { this.turnListeners.delete(listener); }
  }

  sendMessageWithFence(input: SendMessageInput, beforeDispatch: () => void): Promise<SendReceipt> {
    return this.sendMessage(input, beforeDispatch);
  }

  private readonly turnListeners = new Set<(event: HarnessEvent) => void>();

  /** Interrupt a running turn; the proposal keeps whatever the agent had written (R-12). */
  async interrupt(sessionId: string): Promise<void> {
    if (this.disposed) throw new Error("The writing adapter is closed.");
    const owner = this.sessions.get(sessionId);
    if (owner?.privateRequest) {
      if (owner.privateTurn!.stopped) return;
      owner.privateTurn!.stopped = true;
      this.rejectPrivateResponse(sessionId);
      await owner.ownerHttp!.req("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`, {},
        { signal: AbortSignal.any([this.runtimeRequests.signal, AbortSignal.timeout(5_000)]), responseBytes: 64 * 1024 });
      return;
    }
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
   * measured) and again on every reconnect, for every tracked session. The two paths differ
   * where it matters:
   *
   * - `turn-ended`: the stream said this turn is over, so something MUST be reported or a
   *   sendMessage awaits forever. A failed or empty fetch falls back to the text accumulated
   *   from the deltas — late or duplicated news beats never.
   * - `resync`: nothing is known to have finished. Only a new, non-empty assistant message is
   *   reported; an empty completion here would declare a still-running turn over (the v1
   *   resync carried the same guard).
   *
   * The v2 message list is cursor-paginated `{ data, cursor }`, newest first, with agent and
   * model switches recorded as messages — only `type: "assistant"` rows carry a turn's text.
   * The fetch is bounded so a hung GET can never wedge the caller.
   */
  private async reportCompletedTurn(sessionId: string, mode: "turn-ended" | "resync"): Promise<void> {
    const tracked = this.sessions.get(sessionId); if (!tracked && !this.pendingTurns.has(sessionId)) return;
    const stillAdmitted = () => tracked ? this.sessions.get(sessionId) === tracked : this.pendingTurns.has(sessionId) && !this.retiredPrivateIds.has(sessionId);
    const runtime = this.runtimeRequests;
    if (tracked?.privateResponseRejected || tracked?.privateRequest) return;
    const finishWithAccumulated = (why: string): void => {
      const last = this.normalizeState.textBySession.get(sessionId);
      this.normalizeState.textBySession.delete(sessionId);
      this.trace("turn.completed-from-deltas", { sessionId, why, chars: last?.text.length ?? 0 });
      this.push({
        type: "message.completed",
        sessionId,
        ...(last ? { correlationId: last.messageId, text: last.text } : { text: "" }),
      });
    };
    try {
      const messages = await (tracked?.ownerHttp ?? this.http).reqData<
        Array<{
          id?: string;
          type?: string;
          time?: { completed?: number };
          finish?: string;
          error?: unknown;
          content?: Array<{ type?: string; text?: string }>;
        }>
      >("GET", `/api/session/${sessionId}/message`, undefined, { signal: AbortSignal.any([runtime.signal, AbortSignal.timeout(10_000)]),
        ...(tracked?.private ? { responseBytes: 4 * 1024 ** 2 } : {}) });
      if (runtime.signal.aborted || this.disposed || !stillAdmitted() || tracked?.privateResponseRejected) return;
      const newest = tracked?.private && Array.isArray(messages) ? messages.find(m => m.type === "assistant") : undefined;
      const done = tracked?.private
        ? newest && Number.isSafeInteger(newest.time?.completed) && newest.time!.completed! >= 0 ? newest : undefined
        : Array.isArray(messages) ? messages.find(m => m.type === "assistant" && typeof m.time?.completed === "number") : undefined;
      const id = done?.id;
      if (id === undefined || this.reportedMessage.get(sessionId) === id) {
        this.trace("turn.nothing-new", { sessionId });
        if (mode === "turn-ended" && id === undefined) {
          if (tracked?.private) this.rejectPrivateResponse(sessionId); else finishWithAccumulated("no completed assistant message");
        }
        return;
      }
      // Actual 2.0.26 failed rows also have time.completed, including after a missed SSE
      // failure. Only the newest, error-free normal stop is a complete private response;
      // truncation, tool requests and unknown finish shapes remain a refusal, never a reply.
      if (tracked?.private && (done?.finish !== "stop" || done.error !== undefined || typeof id !== "string" || id.length > 256 || !Array.isArray(done.content) || done.content.some(part => part?.type === "text" && typeof part.text !== "string"))) { this.rejectPrivateResponse(sessionId); return; }
      const text = (done?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
      if (tracked?.private && Buffer.byteLength(text) > STUDIO_ASSISTANT_LIMITS.responseBytes) { this.rejectPrivateResponse(sessionId); return; }
      if (mode === "resync" && text.trim().length === 0) {
        // An all-tool message, or shape drift: not worth ending a possibly-live turn over.
        this.trace("turn.resync-empty", { sessionId, messageId: id });
        return;
      }
      this.reportedMessage.set(sessionId, id);
      this.normalizeState.textBySession.delete(sessionId);
      this.trace("turn.completed", { sessionId, messageId: id, chars: text.length });
      this.push({ type: "message.completed", sessionId, correlationId: id, text });
    } catch (err) {
      if (runtime.signal.aborted || this.disposed || !stillAdmitted()) return;
      this.trace("turn.fetch-failed", { sessionId, mode, error: String(err) });
      if (tracked?.private) { this.rejectPrivateResponse(sessionId); return; }
      if (mode === "turn-ended") finishWithAccumulated("completion fetch failed");
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
        const owner = this.sessions.get(sessionId)!;
        if (owner.privateResponseRejected) continue;
        const pending = await (owner.ownerHttp ?? this.http).reqData<
          Array<{ id?: string; action?: string; resources?: unknown[] }>
        >("GET", `/api/session/${sessionId}/permission`, undefined, { signal: AbortSignal.timeout(10_000), ...(owner.private ? { responseBytes: 64 * 1024 } : {}) });
        if (this.sessions.get(sessionId) !== owner) continue;
        if (owner.private && (!Array.isArray(pending) || pending.length > 64)) { this.rejectPrivateResponse(sessionId); continue; }
        for (const request of pending ?? []) {
          if (!request.id || this.permissionSessions.has(request.id)) continue;
          const resources = owner.private ? [] : (request.resources ?? []).filter((r): r is string => typeof r === "string");
          this.trace("resync.permission", { sessionId, permissionId: request.id });
          this.push({
            type: "permission.requested",
            sessionId,
            permissionId: request.id,
            actionClass: owner.private ? "native-operational-action" : request.action ?? "an action",
            ...(resources.length > 0 ? { detail: resources.join(", ").slice(0, 300) } : {}),
          });
        }
      } catch {
        if (this.sessions.get(sessionId)?.private) this.rejectPrivateResponse(sessionId);
        /* a session we cannot read is not a reason to abandon the reconnect */
      }
    }
  }

  // ---- permissions ---------------------------------------------------------

  async respondToPermission(decision: PermissionDecision): Promise<PermissionAck> {
    const sessionId = this.permissionSessions.get(decision.permissionId);
    if (!sessionId) return { permissionId: decision.permissionId, status: "stale" };
    if (this.sessions.get(sessionId)?.private && decision.decision !== "reject") return { permissionId: decision.permissionId, status: "failed" };
    const confirmation = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.turnListeners.delete(listener);
        resolve(false);
      }, 3_000);
      (timer as { unref?: () => void }).unref?.();
      const listener = (event: HarnessEvent) => {
        if (
          event.type === "permission.replied" &&
          event.sessionId === sessionId &&
          event.permissionId === decision.permissionId &&
          event.decision === decision.decision
        ) {
          clearTimeout(timer);
          this.turnListeners.delete(listener);
          resolve(true);
        }
      };
      this.turnListeners.add(listener);
    });
    try {
      // The contracts' verbs are v2's verbs — once | always | reject — and the optional
      // message carries the refusal reason to the agent (issue 327 §6).
      const owner = this.sessions.get(sessionId);
      await (owner?.ownerHttp ?? this.http).req("POST", `/api/session/${sessionId}/permission/${decision.permissionId}/reply`, {
        // The stable API renamed the request field; its event still calls the value `reply`.
        decision: decision.decision,
        ...(decision.message !== undefined ? { message: decision.message } : {}),
      }, owner?.private ? { signal: AbortSignal.any([this.runtimeRequests.signal, AbortSignal.timeout(5_000)]), responseBytes: 64 * 1024 } : undefined);
    } catch (error) {
      const stale = error instanceof OpenCodeError && (error.status === 404 || error.status === 409);
      if (stale) this.permissionSessions.delete(decision.permissionId);
      return { permissionId: decision.permissionId, status: stale ? "stale" : "failed" };
    }
    // Confirmation comes only from the replied event, never HTTP status; wait briefly.
    const confirmed = await confirmation;
    if (confirmed) this.permissionSessions.delete(decision.permissionId);
    return { permissionId: decision.permissionId, status: confirmed ? "confirmed" : "unconfirmed" };
  }

  assessPermission(request: PermissionRequest): PermissionAssessment {
    return assessV2Permission(this.sessions.get(request.sessionId)?.permissionPolicy, request.actionClass);
  }

  // ---- models --------------------------------------------------------------

  /**
   * GET /api/model, with /api/model/default marking the default row. Emptiness before an
   * integration connects is expected (measured — even the built-in agents hide then); an
   * empty list with a healthy server is a readiness reason, not an error.
   */
  async listModels(): Promise<ModelInfo[]> {
    const rows = await this.http.reqData<WireModel[]>("GET", "/api/model", undefined, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!Array.isArray(rows)) throw new Error("OpenCode returned an invalid model catalog");
    let defaultKey: string | null = null;
    try {
      const def = await this.http.reqData<{ id?: string; providerID?: string }>("GET", "/api/model/default", undefined, {
        signal: AbortSignal.timeout(15_000),
      });
      if (def?.id && def.providerID) defaultKey = `${def.providerID}/${def.id}`;
    } catch {
      /* a server with no resolvable default still has a catalog */
    }
    const out: ModelInfo[] = [];
    this.lastKnownWindow = null;
    this.modelWindows.clear();
    for (const row of rows) {
      if (!row.id || !row.providerID || !modelEnabled(row)) continue;
      const key = `${row.providerID}/${row.id}`;
      const metadata = modelMetadata(row);
      if (metadata.inputTokenLimit !== undefined) this.modelWindows.set(key, metadata.inputTokenLimit);
      if (key === defaultKey) this.lastKnownWindow = metadata.inputTokenLimit ?? null;
      out.push({
        id: row.id,
        provider: row.providerID,
        ...(providerNameOf(row) !== undefined ? { providerName: providerNameOf(row)! } : {}),
        ...metadata,
        ...(key === defaultKey ? { isDefault: true } : {}),
      });
    }
    return out;
  }

  // ---- vendor sign-in (SPEC-030) -------------------------------------------

  /**
   * GET /api/integration, normalised at this boundary. The catalog populates asynchronously
   * after spawn (~5s measured), so an empty list from a healthy server means "not yet", and
   * the caller decides how patient to be.
   */
  async listIntegrations(): Promise<VendorIntegration[]> {
    const rows = await this.http.reqData<WireIntegration[]>("GET", "/api/integration", undefined, {
      signal: AbortSignal.timeout(15_000),
    });
    const out: VendorIntegration[] = [];
    for (const row of rows ?? []) {
      const normalized = normalizeIntegration(row);
      if (normalized !== null) out.push(normalized);
    }
    return out;
  }

  /**
   * POST connect/oauth. The harness owns the exchange from here: it binds the callback port
   * itself for a browser method and polls the vendor for a device one (measured, D18). The
   * one thing Arke does with the answer is open the URL and show the instructions verbatim.
   */
  async beginVendorOAuth(
    integrationId: string,
    methodId: string,
    answers?: Record<string, string>,
  ): Promise<VendorOAuthAttempt> {
    const attempt = await this.http.reqData<WireAttempt>(
      "POST",
      `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth`,
      { methodID: methodId, ...(answers && Object.keys(answers).length > 0 ? { answer: answers } : {}) },
      { signal: AbortSignal.timeout(30_000) },
    );
    return normalizeAttempt(attempt);
  }

  async pollVendorOAuth(integrationId: string, attemptId: string): Promise<VendorOAuthAttemptState> {
    const status = await this.http.reqData<WireAttemptStatus>(
      "GET",
      `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}`,
      undefined,
      { signal: AbortSignal.timeout(15_000) },
    );
    return normalizeAttemptStatus(status);
  }

  async cancelVendorOAuth(integrationId: string, attemptId: string): Promise<void> {
    await this.http.req<void>(
      "DELETE",
      `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}`,
      undefined,
      { signal: AbortSignal.timeout(15_000) },
    );
  }

  async completeVendorOAuth(integrationId: string, attemptId: string, code: string): Promise<void> {
    await this.http.req<void>(
      "POST",
      `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}/complete`,
      { code },
      { signal: AbortSignal.timeout(30_000) },
    );
  }

  /** POST connect/key — one call, 204, and the key is gone from this process (R-1, §2.2). */
  async connectVendorKey(integrationId: string, key: string, answers?: Record<string, string>): Promise<void> {
    await this.http.req<void>(
      "POST",
      `/api/integration/${encodeURIComponent(integrationId)}/connect/key`,
      { key, ...(answers && Object.keys(answers).length > 0 ? { answer: answers } : {}) },
      { signal: AbortSignal.timeout(30_000) },
    );
  }

  async removeVendorCredential(credentialId: string): Promise<void> {
    await this.http.req<void>("DELETE", `/api/credential/${encodeURIComponent(credentialId)}`, undefined, {
      signal: AbortSignal.timeout(15_000),
    });
  }

  // ---- the event pump ------------------------------------------------------

  private push(event: HarnessEvent): void {
    let parsed = HarnessEventSchema.parse(event);
    if ("sessionId" in parsed && parsed.sessionId && (this.retiredPrivateIds.has(parsed.sessionId) || !this.sessions.has(parsed.sessionId) && !this.pendingTurns.has(parsed.sessionId))) return;
    const privateOwner = "sessionId" in parsed && parsed.sessionId ? this.sessions.get(parsed.sessionId) : undefined;
    if (privateOwner?.privateResponseRejected && parsed.type !== "session.error") return;
    if (privateOwner?.private && parsed.type === "session.error") parsed = { type: "session.error", sessionId: parsed.sessionId!, message: "The private model request could not be completed. Submitted work was not replayed." };
    if (privateOwner?.private && parsed.type === "session.ended") parsed = { type: "session.ended", sessionId: parsed.sessionId, reason: parsed.reason, detail: "The private turn ended without a confirmed response." };
    if (privateOwner?.private && (parsed.type === "session.error" || parsed.type === "session.ended")) {
      privateOwner.privateResponseRejected = true; privateOwner.privateTextBytes = 0; privateOwner.privateTextTail = undefined;
      this.normalizeState.textBySession.delete(parsed.sessionId!);
      if (privateOwner.privateTurn && !privateOwner.privateTurn.dispatched) privateOwner.privateTurn.stopped = true;
    }
    if (privateOwner?.private) {
      const metadata = parsed.type === "message.delta" || parsed.type === "message.completed" ? { ...parsed, text: undefined } : parsed;
      if (Buffer.byteLength(JSON.stringify(metadata)) > 4096 || "correlationId" in parsed && typeof parsed.correlationId === "string" && parsed.correlationId.length > 256 || "permissionId" in parsed && parsed.permissionId.length > 256) { this.rejectPrivateResponse(parsed.sessionId!); return; }
      if (parsed.type === "permission.requested") {
        if ((privateOwner.privatePermissionRequests ?? 0) >= 64) { this.rejectPrivateResponse(parsed.sessionId); return; }
        privateOwner.privatePermissionRequests = (privateOwner.privatePermissionRequests ?? 0) + 1;
        parsed = { type: "permission.requested", sessionId: parsed.sessionId, permissionId: parsed.permissionId, actionClass: "native-operational-action" };
      }
    }
    if (parsed.type === "message.completed") {
      const turn = this.sessions.get(parsed.sessionId)?.privateTurn;
      if (turn?.dispatched) turn.complete();
    }
    if ((parsed.type === "message.completed" || parsed.type === "session.error" || parsed.type === "session.ended") && "sessionId" in parsed && parsed.sessionId) {
      this.pendingTurns.delete(parsed.sessionId);
    }
    if (parsed.type === "permission.requested") {
      this.permissionSessions.set(parsed.permissionId, parsed.sessionId);
    }
    for (const listener of Array.from(this.turnListeners)) listener(parsed);
    const privateSession = "sessionId" in parsed && parsed.sessionId ? this.sessions.get(parsed.sessionId)?.private === true : false;
    for (const sub of this.subscribers) {
      if (privateSession ? sub.sessionId !== ("sessionId" in parsed ? parsed.sessionId : undefined) : sub.sessionId !== undefined) continue;
      if (privateSession && parsed.type === "message.delta") {
        const old = sub.queue.findIndex(value => value.type === "message.delta"); if (old >= 0) sub.queue.splice(old, 1);
      }
      if (privateSession && sub.queue.length >= 64) {
        privateOwner!.privateResponseRejected = true; privateOwner!.privateTextBytes = 0; privateOwner!.privateTextTail = undefined;
        this.normalizeState.textBySession.delete(sub.sessionId!);
        sub.queue.length = 0;
        this.push({ type: "session.error", sessionId: sub.sessionId!, message: "The private model observation exceeded its event bound. Submitted work was not replayed." });
        continue;
      }
      sub.queue.push(parsed);
      sub.wake?.();
      sub.wake = null;
    }
    // Operational roles have no native tools. An unexpected permission request is refused
    // within its native owner; it must not reach the common world's permission UI/pump.
    if (privateSession && parsed.type === "permission.requested") void this.respondToPermission({ permissionId: parsed.permissionId, decision: "reject" }).catch(() => {});
  }

  private rejectPrivateResponse(sessionId: string): void {
    const owner = this.sessions.get(sessionId);
    if (!owner?.private || owner.privateResponseRejected) return;
    owner.privateResponseRejected = true; owner.privateTextBytes = 0;
    owner.privateTextTail = undefined;
    if (owner.privateTurn && !owner.privateTurn.dispatched) owner.privateTurn.stopped = true;
    this.normalizeState.textBySession.delete(sessionId);
    this.push({ type: "session.error", sessionId, message: "The private response exceeded its observation bound." });
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
        const runtime = this.runtimeRequests;
        const giveUp = () => attempt.abort();
        signal.addEventListener("abort", giveUp, { once: true });
        runtime.signal.addEventListener("abort", giveUp, { once: true });
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
          for (const sessionId of this.sessions.keys()) await this.reportCompletedTurn(sessionId, "resync");
          await this.resyncPendingPermissions();
          for await (const raw of parseSse(stream.body, attempt.signal, heard)) {
            if (runtime.signal.aborted || this.disposed) break;
            const rawSessionId = (raw as { data?: { sessionID?: unknown } })?.data?.sessionID;
            const rawType = (raw as { type?: unknown })?.type;
            if (typeof rawType === "string" && rawType.startsWith("session.") && typeof rawSessionId !== "string") continue;
            if (typeof rawSessionId === "string" && (this.retiredPrivateIds.has(rawSessionId) || !this.sessions.has(rawSessionId) && !this.pendingTurns.has(rawSessionId))) continue;
            const owner = typeof rawSessionId === "string" ? this.sessions.get(rawSessionId) : undefined;
            if (owner?.privateRequest) {
              if (rawType === "session.deleted") { if (!owner.privateTurn?.stopped) this.rejectPrivateResponse(rawSessionId as string); continue; }
              // Transient completion/text/usage belongs to its guarded API result only.
              if (!["permission.asked", "session.execution.failed", "session.execution.interrupted"].includes(String(rawType))) continue;
            }
            let normalizedRaw = raw;
            if (owner?.private && typeof rawType === "string") {
              if (owner.privateResponseRejected && rawType !== "session.execution.succeeded") continue;
              const data = (raw as { data: Record<string, unknown> }).data;
              if ([data.assistantMessageID, data.id, data.requestID].some(value => typeof value === "string" && value.length > 256)) { this.rejectPrivateResponse(rawSessionId as string); continue; }
              if (rawType === "permission.asked") normalizedRaw = { type: rawType, data: { sessionID: rawSessionId, id: data.id, action: "native-operational-action", resources: [] } };
              if (rawType.startsWith("session.tool.")) continue; // operational sessions have no native tools
              if (rawType === "session.text.delta" || rawType === "session.text.ended") {
                if (owner.privateResponseRejected) continue;
                const data = (raw as { data: { delta?: unknown; text?: unknown } }).data;
                const text = rawType === "session.text.delta" ? data.delta : data.text;
                if (typeof text === "string" && (rawType === "session.text.delta" || text.length > 0)) {
                  const append = rawType === "session.text.delta";
                  const paired = append && owner.privateTextTail && /[\uD800-\uDBFF]/.test(owner.privateTextTail) && /^[\uDC00-\uDFFF]/.test(text);
                  const bytes = Buffer.byteLength(text) + (append ? owner.privateTextBytes ?? 0 : 0) - (paired ? 2 : 0);
                  if (bytes > STUDIO_ASSISTANT_LIMITS.responseBytes) { this.rejectPrivateResponse(rawSessionId as string); continue; }
                  owner.privateTextBytes = bytes;
                  owner.privateTextTail = text.length ? text.at(-1) : owner.privateTextTail;
                }
              }
            }
            const outcome = normalizeOpenCodeV2(normalizedRaw, this.normalizeState);
            if (outcome.kind === "turn-succeeded") {
              const turn = this.sessions.get(outcome.sessionId)?.privateTurn;
              if (turn?.dispatched) turn.complete(); // positive native completion is independent of response retrieval
              // Detached, deliberately: awaiting this fetch inside the read loop would let one
              // hung GET starve event delivery for every session and every subscriber. The
              // fetch is itself time-bounded, and dedup makes late arrival harmless.
              if (this.sessions.has(outcome.sessionId) || this.pendingTurns.has(outcome.sessionId)) {
                void this.reportCompletedTurn(outcome.sessionId, "turn-ended");
              }
              continue;
            }
            if (outcome.kind === "events") {
              for (const event of outcome.events) {
                // Only surface events for sessions this adapter created — even a private v2
                // server multiplexes locations, so this filter earns its keep.
                if ("sessionId" in event && event.sessionId && !this.sessions.has(event.sessionId) && !this.pendingTurns.has(event.sessionId)) {
                  continue;
                }
                if (event.type === "session.error") this.trace("stream.session.error", { sessionId: event.sessionId });
                this.push(event);
              }
            } else if (outcome.kind === "dead-letter" && !owner?.private) {
              this.deadLetters.push({ reason: outcome.reason, at: Date.now() });
              if (this.deadLetters.length > 100) this.deadLetters.shift();
            }
          }
        } catch (err) {
          if (err instanceof SseFrameLimitError) for (const sessionId of this.pendingTurns) {
            const owner = this.sessions.get(sessionId); if (owner?.private && !owner.privateRequest) this.rejectPrivateResponse(sessionId);
          }
          this.trace("stream.dropped", { reason: err instanceof SseFrameLimitError ? "frame-limit" : "connection-lost" });
        } finally {
          clearTimeout(watchdog);
          signal.removeEventListener("abort", giveUp);
          runtime.signal.removeEventListener("abort", giveUp);
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
    return this.events(signal);
  }

  private events(signal?: AbortSignal, sessionId?: string): AsyncIterable<HarnessEvent> {
    void this.pump();
    // Register eagerly, at call time — an event arriving between dispatch and the first pull
    // must not be lost.
    const sub: { queue: HarnessEvent[]; wake: (() => void) | null; sessionId?: string } = { queue: [], wake: null, ...(sessionId ? { sessionId } : {}) };
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
    this.runtimeExited();
    this.disposed = true;
    this.sessions.clear();
    this.sessionWindows.clear();
    this.pumpAbort.abort();
    for (const sub of this.subscribers) {
      sub.wake?.();
      sub.wake = null;
    }
  }
}

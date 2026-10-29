import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { HarnessEngine, PrivateSessionRequest, PrivateSessionWriter } from "@arke-studio/contracts";
import {
  credentialEnvPatch,
  discoverPreferredHarness,
  OpenCodeV2Adapter,
  OPENCODE2_PINNED_VERSION,
  v2BasicAuth,
  privateWireBody,
  type DiscoveredHarness,
  type DiscoveryOptions,
} from "@arke-studio/adapter-opencode";
import {
  ClaudeAdapter,
  ConfinementCache,
  credentialSummary,
  makeSdkProbe,
  resolveClaudeHarness,
  sdkQuery,
  sdkModels,
  type ClaudeDiscoveryOptions,
  type RunProbeTurn,
} from "@arke-studio/adapter-claude";
import { CodexAdapter, codexCredentialEnv, discoverCodex, type CodexDiscoveryOptions, type DiscoveredCodex } from "@arke-studio/adapter-codex";
import type { CodexImageRunner } from "@arke-studio/providers";
import { ChildSupervisor, type SupervisedSpec, type SupervisorDeps } from "../supervisor.js";
import { atomicWriteFile } from "../world/atomic.js";
import { ownedChildHooks } from "./owned-child.js";
import { HarnessRuntimeChanges, type HarnessRecoveryOwner } from "./runtime-change.js";
import { ManagedStudioWriterTransport } from "./managed-writer-transport.js";
import { executableContentMatches } from "./executable-content.js";
import privateWriterPin from "./private-writer-pin.json" with { type: "json" };
import type { OllamaEngineService } from "../local-ai/ollama.js";
import type { StudioAssistantHostOptions } from "../studio-assistant/host.js";
import { ManagedStudioProviderBridge } from "../studio-assistant/managed-provider-bridge.js";

// This package owns shared desktop/dev composition, so every adapter is a runtime dependency.
// Keep concrete adapter imports here; Coordinator itself consumes the HarnessAdapter contract.
export { describeClaudeAvailability } from "@arke-studio/adapter-claude";
export { describeCodexAvailability } from "@arke-studio/adapter-codex";

/**
 * Confinement verdicts survive across assemblies, keyed on binary and version, so a user who
 * opens and closes the app pays for one probe rather than one per launch. An auto-update
 * invalidates the entry by construction.
 */
const claudeVerdicts = new ConfinementCache();

/**
 * The opencode2 launch protocol, shared by the desktop and dev hosts (issue 327 §2, §4).
 *
 * Three facts of the v2 server shape everything here, all measured against the pinned build:
 * it prints `server password <secret>` on stdout before serving and authenticates every
 * route with it (Basic, username `opencode`); it reads the user's own credential store
 * unless the profile is redirected, and stored connections OUTRANK spawn-env keys — a stale
 * personal login then fails turns with a bare `provider.auth`; and its `serve` arguments are
 * bind a private loopback port. The launch uses a redirected profile, password parsed from
 * stdout and held in memory, health probed with Basic auth.
 *
 * The password never appears in a log line, a trace, a status reason, or an error string —
 * the holder below is the only place it lives, and the accessors hand it to exactly two
 * consumers: the supervisor's health probe and the adapter's Authorization header.
 */

/** The launch line, exactly as the pinned build prints it. */
const PASSWORD_LINE = /^server password (\S+)$/;

/** Parse the password from one stdout line, or null for every other line. */
export function passwordFromLine(line: string): string | null {
  const match = PASSWORD_LINE.exec(line.trim());
  return match ? match[1]! : null;
}

/**
 * Holds the launch password across supervisor restarts: each spawn prints a fresh secret,
 * and the newest one is the only one that opens the current child.
 */
export class HarnessPasswordHolder {
  private password: string | null = null;

  /** Feed every stdout line through; non-password lines are ignored. */
  readonly onStdoutLine = (line: string): void => {
    const found = passwordFromLine(line);
    if (found !== null) this.password = found;
  };

  /** The current password, for the adapter's lazy `password()` option. */
  readonly current = (): string | null => this.password;

  /**
   * Health-probe headers: Basic auth once the password is known, bare until then — a bare
   * probe answers 401, which reads as "not yet" and keeps the probe loop patient.
   */
  readonly healthHeaders = (): Record<string, string> => {
    if (this.password === null) return {};
    return { authorization: v2BasicAuth(this.password) };
  };
}

/**
 * The redirected-profile environment (issue 327 §2): the spawned server sees an Arke-owned
 * state directory as its home, so the user's personal OpenCode logins cannot leak in and
 * shadow the credentials Arke injects. Home, config, data, state and cache travel together —
 * which one the binary reads is its business, and the measured behavior (stored connections
 * vanish, env keys win) was verified with the full set.
 */
export function v2ProfileEnv(profileDir: string): Record<string, string> {
  return {
    HOME: profileDir,
    USERPROFILE: profileDir,
    XDG_CONFIG_HOME: join(profileDir, ".config"),
    XDG_DATA_HOME: join(profileDir, ".local", "share"),
    XDG_STATE_HOME: join(profileDir, ".local", "state"),
    XDG_CACHE_HOME: join(profileDir, ".cache"),
  };
}

/**
 * This is Arke's private server even when Settings selects an existing executable. Ambient
 * OPENCODE_* controls can redirect its DB/config, suppress its password handshake, or activate
 * simulation/plugins; OTEL_* can export its logs/spans. Neither belongs to the inherited host
 * configuration. Provider keys are supplied separately by credentialEnvPatch before spawn.
 * This is launch configuration isolation, not a process sandbox or native-log erasure.
 */
export function v2LaunchEnv(profileDir: string, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined &&
      !/^(OPENCODE_|OTEL_)/i.test(entry[0]))),
    ...v2ProfileEnv(profileDir),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OTEL_SDK_DISABLED: "true",
  };
}

/** Where a host's harness profile lives, given its app root. */
export function harnessProfileDir(appRoot: string): string {
  return join(appRoot, "harness", "profile");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Remove the former Studio-generated inventory once; credentials and other provider settings stay in place. */
async function retireGeneratedOllamaModels(profileDir: string): Promise<void> {
  const path = join(profileDir, ".config", "opencode", "opencode.json");
  let config: unknown;
  try { config = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
    throw error;
  }
  if (!object(config) || !object(config.providers)) return;
  const ollama = config.providers["ollama"];
  if (!object(ollama) || ollama.name !== "Ollama" || ollama.package !== "aisdk:@ai-sdk/openai-compatible" ||
    !object(ollama.settings) || ollama.settings.apiKey !== "ollama" || !object(ollama.models)) return;
  // The removed writer used model-id names and zero-cost capability rows. User-defined models
  // with different names/options are configuration, not an inventory Studio can retire.
  if (!Object.entries(ollama.models).every(([id, row]) => object(row) && row.name === id &&
    object(row.cost) && row.cost.input === 0 && row.cost.output === 0 && object(row.capabilities) &&
    typeof row.capabilities.tools === "boolean" && Object.keys(row).every(key => ["name", "cost", "capabilities", "limit"].includes(key)))) return;
  delete ollama.models;
  await atomicWriteFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** What Settings names about the wired harness (issue 327 §9, SPEC-005 R-1). */
export interface AssembledHarnessInfo {
  generation: "v2" | "claude" | "codex";
  source: "configured" | "path" | "bundled";
  version: string | null;
  beta: boolean;
  rejectedV2Version?: string | null;
}

/** The discovery result reshaped for app state — one site, so the two hosts cannot drift. */
export function harnessInfoFrom(harness: DiscoveredHarness): AssembledHarnessInfo {
  return {
    generation: harness.generation,
    source: harness.discovery.source,
    version: harness.discovery.version,
    beta: false,
  };
}

export interface AssembleHarnessOptions {
  /** Arke's selected local runtime. Native discovery still owns the model inventory. */
  ollamaEndpoint?: () => string;
  appRoot: string;
  /** Authoritative resolved Settings/environment selection. */
  engine?: HarnessEngine;
  /** Ledger for orphan sweeps; absent in bare test hosts. */
  deps?: SupervisorDeps;
  /** Native owner seam used by lifecycle acceptance fixtures; production uses ChildSupervisor. */
  createSupervisor?: (spec: SupervisedSpec, deps: SupervisorDeps) => ChildSupervisor;
  v2?: DiscoveryOptions;
  /**
   * The bring-your-own harness, off unless asked for, and never a fallback: OpenCode is the
   * default and ships in the installer; Claude Code is a convenience for people already running
   * it. Opting in is also what pays for the confinement probe, which costs a live turn and has
   * no business running on every boot of a machine that never wanted it.
   */
  claude?: ClaudeDiscoveryOptions & {
    enabled?: boolean;
    /** Seam: the confinement probe. Defaults to the SDK-backed one, which spends a live turn. */
    runTurn?: RunProbeTurn;
    /**
     * Where verdicts live. Defaults to a module-level cache so a host that never thinks about
     * it still probes once per binary and version rather than once per assembly — but it is an
     * argument, because "how long a verification lasts" is the host's business, and a shared
     * singleton is a surprise waiting for whoever assembles twice.
     */
    cache?: ConfinementCache;
  };
  codex?: CodexDiscoveryOptions & { enabled?: boolean };
  /** The adapter's trace sink — logs/harness.jsonl at the host's root. */
  onTrace?: (line: Record<string, unknown>) => void;
}

export interface AssembledHarness {
  /** Host-only original bundled writer. No existing-install ownership or model approval. */
  createPrivateWriter?(request: PrivateSessionRequest, signal?: AbortSignal): Promise<(PrivateSessionWriter & { ownerStopped(): boolean }) | null>;
  recovery?: HarnessRecoveryOwner;
  reconfigureOllama?: (apply?: () => Promise<void>) => Promise<void>;
  harness: DiscoveredHarness | null;
  isV2: boolean;
  supervisor: ChildSupervisor | null;
  adapter: OpenCodeV2Adapter | ClaudeAdapter | CodexAdapter | null;
  harnessInfo?: AssembledHarnessInfo;
  unavailableReason?: string;
  relaunchHarness: (credentials: Record<string, string | undefined>) => Promise<void>;
  /**
   * What happened, in lines the host prints under its own prefix — states and refusals
   * stated once here so desktop and dev can never describe the same discovery differently.
   */
  logLines: string[];
}

/** Shared desktop/dev/Node composition. Only the existing bundled writer and managed,
 * local-only Ollama owner can enter this route; Settings names never attest ownership. */
export function managedStudioAssistant(wiring: AssembledHarness, service: OllamaEngineService): StudioAssistantHostOptions {
  const destination = (model: string, provider: string) => {
    if (process.platform !== "win32" || provider !== "ollama" || !model.startsWith("ollama/") || model.length <= 7 || model.length > 512 ||
      !wiring.isV2 || wiring.harness?.discovery.source !== "bundled" || !wiring.createPrivateWriter) return null;
    const writer = wiring.supervisor?.captureProcessOrigin(), owner = service.captureManagedOrigin();
    if (!writer?.current() || !owner?.current()) return null;
    return { local: true, identity: createHash("sha256").update(JSON.stringify(["managed-studio-local-v1", model, writer.identity, owner.process.identity])).digest("hex") };
  };
  return { destination, privateTransport: async (request, signal) => {
    const captured = Object.freeze({ model: request.model, system: request.system, prompt: request.prompt, outputTokenLimit: request.outputTokenLimit, ...(request.variant !== undefined ? { variant: request.variant } : {}) });
    const original = destination(captured.model, "ollama"), body = privateWireBody(captured);
    if (!original || signal.aborted) throw new Error("The managed Studio destination is unavailable.");
    const writer = await wiring.createPrivateWriter!(captured, signal);
    if (!writer) throw new Error("The bundled Studio writer could not be qualified.");
    let bridge: ManagedStudioProviderBridge;
    const current = () => !signal.aborted && writer.current() && destination(captured.model, "ollama")?.identity === original.identity;
    try {
      if (!current()) throw new Error("The managed Studio destination changed.");
      bridge = new ManagedStudioProviderBridge(service, { model: body.model, requestBody: JSON.stringify(body) });
    } catch (error) { writer.seal(); await writer.close(); throw error; }
    let route: Awaited<ReturnType<ManagedStudioProviderBridge["start"]>> | undefined;
    return {
      writer,
      async prepare(admission) {
        if (!current()) throw new Error("The managed Studio destination changed.");
        route = await bridge.start(AbortSignal.any([signal, admission]));
        if (!current()) throw new Error("The managed Studio destination changed.");
      },
      get configuration() { if (!route) throw new Error("The managed Studio route is not ready."); return { baseURL: route.baseURL, apiKey: route.apiKey }; },
      get identity() { if (!route) throw new Error("The managed Studio route is not ready."); return route.identity; },
      approve: () => current() && bridge.approve(), seal: () => bridge.seal(), stop: () => bridge.stop(),
      ownersStopped: () => writer.ownerStopped() && bridge.ownerStopped(),
    };
  } };
}

/**
 * The whole harness assembly, once (issue 327 §3–§4): discovery of the pinned v2 release, the launch protocol (password holder, redirected profile, authenticated
 * probe), the v2 adapter and session-config writer, the harnessInfo Settings
 * reads, and the credential-delivery closure. Both hosts call this; everything host-specific
 * — ledger, backstop, logging prefix, coordinator wiring — stays with the host. Extracted
 * after review found the two copies already drifting in their first week.
 */
export async function assembleHarness(opts: AssembleHarnessOptions): Promise<AssembledHarness> {
  const engine = opts.engine ?? (opts.codex?.enabled ? "codex" : opts.claude?.enabled ? "claude" : "opencode");
  // A selected bring-your-own engine has its own lifecycle. An unrelated OpenCode installation
  // must neither gate initialization nor be launched as an invisible fallback after failure.
  if (engine === "claude") {
    const availability = await resolveClaudeHarness({
      discovery: opts.claude,
      cache: opts.claude?.cache ?? claudeVerdicts,
      runTurn: opts.claude?.runTurn ?? makeSdkProbe(),
    });
    if (!availability.available) return {
      harness: null, isV2: false, supervisor: null, adapter: null,
      unavailableReason: availability.reason, relaunchHarness: async () => {},
      logLines: [`Claude Code unavailable — ${availability.reason}`],
    };
    return {
      harness: null, isV2: false, supervisor: null,
      adapter: new ClaudeAdapter({ command: availability.command, runQuery: sdkQuery, discoverModels: sdkModels,
        ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
      }),
      harnessInfo: { generation: "claude", source: availability.source, version: availability.version, beta: false },
      relaunchHarness: async () => {},
      logLines: [`Claude Code ${availability.version ?? "(unknown version)"}: ${availability.source}, ` +
        `confinement verified, authenticated by ${credentialSummary(availability.apiKeySource)}`],
    };
  }
  if (engine === "codex") {
    const discovered = await discoverCodex(opts.codex);
    if (!discovered.found) {
      const reason = discovered.reason ?? "Codex was not found on this machine.";
      return { harness: null, isV2: false, supervisor: null, adapter: null, unavailableReason: reason,
        relaunchHarness: async () => {}, logLines: [`Codex unavailable — ${reason}`] };
    }
    const found = discovered.found;
    const adapter = new CodexAdapter({ command: found.command, args: found.args, env: codexCredentialEnv({}),
      ...ownedChildHooks("codex", found.command, opts.deps, opts.onTrace),
      ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
    });
    return {
      harness: null, isV2: false, supervisor: null, adapter,
      harnessInfo: { generation: "codex", source: found.source, version: found.version, beta: false },
      // This lane uses Codex's own login. The shared environment policy removes inherited
      // media keys at launch; saving an Arke media key must not change its billing identity.
      relaunchHarness: async () => {},
      logLines: [`Codex ${found.version}: ${found.source}, private app-server with confined Arke tools`],
    };
  }
  const profileDir = harnessProfileDir(opts.appRoot);
  // Even --version initializes native paths. Discovery must not touch the personal profile.
  const launchEnv = v2LaunchEnv(profileDir);
  const discovery = await discoverPreferredHarness({ v2: { ...opts.v2, env: launchEnv } });
  const harness = discovery.found;
  if (!harness && discovery.rejectedV2) {
    const rejected = discovery.rejectedV2;
    const reason = `OpenCode ${rejected.version ?? "(unknown version)"} is installed but unsupported. Use OpenCode ${OPENCODE2_PINNED_VERSION}.`;
    return {
      harness: null, isV2: false, supervisor: null, adapter: null,
      harnessInfo: { generation: "v2", source: rejected.source, version: rejected.version, beta: false, rejectedV2Version: rejected.version },
      unavailableReason: reason, relaunchHarness: async () => {}, logLines: [reason],
    };
  }
  const isV2 = harness?.generation === "v2";
  const password = new HarnessPasswordHolder();
  if (isV2) {
    await mkdir(profileDir, { recursive: true });
    await retireGeneratedOllamaModels(profileDir);
  }
  const configureOllama = async (checkOnly = false): Promise<boolean> => {
    if (!isV2 || !opts.ollamaEndpoint) return false;
    const path = join(profileDir, ".config", "opencode", "opencode.json");
    let config: Record<string, unknown>;
    try { config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      config = {};
    }
    const providers = object(config.providers) ? config.providers : {};
    const ollama = object(providers.ollama) ? providers.ollama : {};
    const settings = object(ollama.settings) ? ollama.settings : {};
    const baseURL = `${opts.ollamaEndpoint().replace(/\/+$/, "")}/v1`;
    if (settings.baseURL === baseURL) return false;
    if (checkOnly) return true;
    await atomicWriteFile(path, JSON.stringify({ ...config, providers: { ...providers, ollama: { ...ollama, settings: { ...settings, baseURL } } } }, null, 2) + "\n");
    return true;
  };
  await configureOllama();

  const supervisor = (opts.createSupervisor ?? ((spec, deps) => new ChildSupervisor(spec, deps)))(
    {
      id: "opencode",
      command: harness?.discovery.command ?? null,
      args: ["serve", "--port", "{port}", "--hostname", "127.0.0.1"],
      // Real keys arrive via relaunchHarness before the first spawn (SPEC-005 D5); v2 also
      // gets the redirected profile so no personal OpenCode login can shadow them (§2).
      // Runtime controls, telemetry exports and profile paths also belong to this launcher.
      inheritEnv: false,
      env: launchEnv,
      healthPath: "/api/info",
      validateHealth: async response => {
        const info = await response.json() as { version?: unknown; pid?: unknown };
        return info.version === OPENCODE2_PINNED_VERSION && typeof info.pid === "number" && Number.isSafeInteger(info.pid) && info.pid > 0
          ? true : { ok: false, reason: "OpenCode did not report the supported server protocol. Review its installation." };
      },
      readyTimeoutMs: 30_000,
      healthHeaders: password.healthHeaders, onStdoutLine: password.onStdoutLine,
    },
    opts.deps ?? {},
  );

  const baseUrl = () => `http://127.0.0.1:${supervisor.port ?? 0}`;
  const runtimeChanges = new HarnessRuntimeChanges();
  const rawAdapter = harness
    ? new OpenCodeV2Adapter({
        baseUrl,
        password: password.current,
        ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
      })
    : null;
  const adapter = rawAdapter === null ? null : runtimeChanges.wrap(rawAdapter);
  let adapterGeneration = supervisor.spawnEpoch;
  supervisor.on("status", event => { if (event.status === "starting") adapterGeneration = supervisor.spawnEpoch; });
  supervisor.on("process-exit", ({ generation }: { generation: number }) => {
    if (generation === adapterGeneration) rawAdapter?.runtimeExited();
  });

  const logLines: string[] = [];
  if (harness) {
    logLines.push(
      `OpenCode ${harness.generation}: ${harness.discovery.source} (${harness.discovery.version ?? "unknown version"})`,
    );
  } else {
    logLines.push("OpenCode: not found — authoring disabled");
  }

  return {
    harness,
    isV2,
    supervisor,
    adapter,
    createPrivateWriter: async (request, signal = AbortSignal.timeout(10_000)) => {
      if (process.platform !== "win32" || !harness || harness.discovery.source !== "bundled") return null;
      const captured = Object.freeze({ model: request.model, system: request.system, prompt: request.prompt, outputTokenLimit: request.outputTokenLimit, ...(request.variant !== undefined ? { variant: request.variant } : {}) });
      const origin = supervisor.captureProcessOrigin(), secret = password.current();
      if (!origin || !secret || origin.executable !== harness.discovery.command || baseUrl() !== `http://127.0.0.1:${origin.port}`) return null;
      const current = () => origin.current() && password.current() === secret && baseUrl() === `http://127.0.0.1:${origin.port}`;
      if (privateWriterPin.version !== OPENCODE2_PINNED_VERSION || privateWriterPin.arch !== "x64" ||
        !await executableContentMatches(origin.executable, privateWriterPin, signal, current).catch(() => false) || signal.aborted || !current()) return null;
      return new ManagedStudioWriterTransport({ origin, current,
        authorization: v2BasicAuth(secret), request: captured });
    },
    ...(harness ? { recovery: { ownership: harness.discovery.source === "bundled" ? "managed" as const : "external" as const,
      componentDigest: () => createHash("sha256").update(JSON.stringify([harness.generation, harness.discovery.command, harness.discovery.version, opts.ollamaEndpoint?.()])).digest("hex"),
      reserve: (signal: AbortSignal) => runtimeChanges.reserveRecovery(signal) } } : {}),
    ...(harness ? { harnessInfo: harnessInfoFrom(harness) } : {}),
    // The PATCH form, deliberately: it names every managed variable, so a cleared key is a
    // deletion the merge honours rather than an omission it preserves.
    reconfigureOllama: async (apply) => {
      if (!apply && !(await configureOllama(true))) return;
      await runtimeChanges.run(async () => {
        await apply?.();
        if (await configureOllama() && supervisor.pid !== null) await supervisor.restart();
      });
    },
    relaunchHarness: (credentials) => supervisor.updateEnv(credentialEnvPatch(credentials)),
    logLines,
  };
}

export interface LazyCodexImageOptions {
  /** A function is read at each start, so a path chosen in Settings applies without a restart. */
  discovery?: CodexDiscoveryOptions | (() => CodexDiscoveryOptions | Promise<CodexDiscoveryOptions>);
  deps?: SupervisorDeps;
  onTrace?: (line: Record<string, unknown>) => void;
  /** How long an idle app-server lingers before it is stopped; a probe alone should not keep one. */
  idleMs?: number;
  /** Test seams: the real ones find a Codex on this machine and start its app-server. */
  discover?: (options: CodexDiscoveryOptions) => Promise<{ found: DiscoveredCodex | null; reason: string | null }>;
  createAdapter?: (found: DiscoveredCodex) => Pick<CodexAdapter, "init" | "imageStatus" | "generateImage" | "dispose">;
}

/**
 * Codex as an image provider (the `codex` client's runner), independent of which harness the user
 * chose: someone running Claude Code can still make pictures with their ChatGPT sign-in.
 *
 * Nothing starts until the first status check or image. The app-server is then the same private,
 * leashed, key-free process the Codex lane uses (`codexCredentialEnv({})` removes inherited keys,
 * so the user's own login is what answers and an Arke media key cannot change who is billed), and
 * it is stopped again after a quiet spell. A Codex that is not installed is an ordinary unavailable
 * answer, not an error, and is looked for again on the next ask.
 */
export function lazyCodexImageRunner(opts: LazyCodexImageOptions = {}): Omit<CodexImageRunner, "dispose"> & { dispose(): Promise<void> } {
  const discover = opts.discover ?? ((options: CodexDiscoveryOptions) => discoverCodex(options));
  const resolveDiscovery = async (): Promise<CodexDiscoveryOptions> => typeof opts.discovery === "function" ? opts.discovery() : (opts.discovery ?? {});
  const create = opts.createAdapter ?? ((found: DiscoveredCodex) => new CodexAdapter({ command: found.command, args: found.args, env: codexCredentialEnv({}),
    ...ownedChildHooks("codex-image", found.command, opts.deps, opts.onTrace),
    ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
  }));
  const idleMs = opts.idleMs ?? 60_000;
  type Adapter = ReturnType<typeof create>;
  let current: Promise<Adapter> | null = null;
  let currentPath = "";
  let disposed = false;
  let stopping = Promise.resolve();
  let busy = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = async () => {
    const prior = current; current = null;
    stopping = stopping.catch(() => {}).then(async () => { if (prior) await (await prior.catch(() => null))?.dispose(); });
    await stopping;
  };
  const acquire = async (): Promise<Adapter> => {
    if (disposed) throw new Error("The Codex image runner has been stopped.");
    const options = await resolveDiscovery();
    await stopping.catch(() => {});
    if (disposed) throw new Error("The Codex image runner has been stopped.");
    // A different executable was chosen: the running one answers for the old path. Replace it when
    // nothing else is using it, and otherwise let the work in flight finish on the one it started on.
    if (current && currentPath !== (options.configuredPath ?? "") && busy <= 1) await stop();
    if (disposed) throw new Error("The Codex image runner has been stopped.");
    if (!current) {
      currentPath = options.configuredPath ?? "";
      const attempt = (async () => {
        const discovered = await discover(options);
        if (disposed) throw new Error("The Codex image runner has been stopped.");
        if (!discovered.found) throw new Error(discovered.reason ?? "Codex was not found on this machine.");
        const adapter = create(discovered.found);
        try { await adapter.init(); } catch (error) { await adapter.dispose(); throw error; }
        return adapter;
      })();
      current = attempt;
      // A failed start must not be remembered: the next ask looks again.
      attempt.catch(() => { if (current === attempt) current = null; });
    }
    return current;
  };
  const use = async <T>(run: (adapter: Adapter) => Promise<T>): Promise<T> => {
    clearTimeout(timer); busy++;
    try {
      const adapter = await acquire();
      if (disposed) throw new Error("The Codex image runner has been stopped.");
      return await run(adapter);
    }
    finally {
      busy--;
      if (busy === 0 && !disposed) { timer = setTimeout(() => { void stop().catch(() => {}); }, idleMs); timer.unref?.(); }
    }
  };
  return {
    status: signal => use(adapter => adapter.imageStatus(signal)),
    generate: input => use(adapter => adapter.generateImage(input)),
    dispose: async () => { disposed = true; clearTimeout(timer); await stop(); },
  };
}

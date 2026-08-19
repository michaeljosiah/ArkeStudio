import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  credentialEnvPatch,
  discoverPreferredHarness,
  meetsV2Gate,
  OpenCodeAdapter,
  OpenCodeV2Adapter,
  v2BasicAuth,
  type DiscoveredHarness,
  type DiscoveryOptions,
} from "@arke-studio/adapter-opencode";
import {
  ClaudeAdapter,
  ConfinementCache,
  makeSdkProbe,
  resolveClaudeHarness,
  sdkQuery,
  type ClaudeDiscoveryOptions,
  type RunProbeTurn,
} from "@arke-studio/adapter-claude";
import { ChildSupervisor, type SupervisorDeps } from "../supervisor.js";

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
 * otherwise identical to v1's. So the launch is: redirected profile, password parsed from
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
 * shadow the credentials Arke injects. All four variables travel together deliberately —
 * which one the binary reads is its business, and the measured behavior (stored connections
 * vanish, env keys win) was verified with the full set.
 */
export function v2ProfileEnv(profileDir: string): Record<string, string> {
  return {
    HOME: profileDir,
    USERPROFILE: profileDir,
    XDG_CONFIG_HOME: join(profileDir, ".config"),
    XDG_DATA_HOME: join(profileDir, ".local", "share"),
  };
}

/** Where a host's harness profile lives, given its app root. */
export function harnessProfileDir(appRoot: string): string {
  return join(appRoot, "harness", "profile");
}

/** What Settings names about the wired harness (issue 327 §9, SPEC-005 R-1). */
export interface AssembledHarnessInfo {
  generation: "v2" | "v1" | "claude";
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
    beta: harness.generation === "v2",
    ...(harness.rejectedV2 ? { rejectedV2Version: harness.rejectedV2.version } : {}),
  };
}

export interface AssembleHarnessOptions {
  appRoot: string;
  /** Ledger for orphan sweeps; absent in bare test hosts. */
  deps?: SupervisorDeps;
  preferV1?: boolean;
  v1?: DiscoveryOptions;
  v2?: DiscoveryOptions & { minBuild?: number };
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
  /** The adapter's trace sink — logs/harness.jsonl at the host's root. */
  onTrace?: (line: Record<string, unknown>) => void;
}

export interface AssembledHarness {
  harness: DiscoveredHarness | null;
  isV2: boolean;
  supervisor: ChildSupervisor;
  adapter: OpenCodeAdapter | OpenCodeV2Adapter | ClaudeAdapter | null;
  harnessInfo?: AssembledHarnessInfo;
  relaunchHarness: (credentials: Record<string, string | undefined>) => Promise<void>;
  /**
   * What happened, in lines the host prints under its own prefix — states and refusals
   * stated once here so desktop and dev can never describe the same discovery differently.
   */
  logLines: string[];
}

/**
 * The whole harness assembly, once (issue 327 §3–§4): discovery with the v2-first
 * preference, the launch protocol (password holder, redirected profile, authenticated
 * probe), the generation-matched adapter and session-config writer, the harnessInfo Settings
 * reads, and the credential-delivery closure. Both hosts call this; everything host-specific
 * — ledger, backstop, logging prefix, coordinator wiring — stays with the host. Extracted
 * after review found the two copies already drifting in their first week.
 */
export async function assembleHarness(opts: AssembleHarnessOptions): Promise<AssembledHarness> {
  let claudeRefusal: string | null = null;
  const harness = await discoverPreferredHarness({
    ...(opts.preferV1 !== undefined ? { preferV1: opts.preferV1 } : {}),
    ...(opts.v1 ? { v1: opts.v1 } : {}),
    ...(opts.v2 ? { v2: opts.v2 } : {}),
  });
  const isV2 = harness?.generation === "v2";
  const password = new HarnessPasswordHolder();
  const profileDir = harnessProfileDir(opts.appRoot);
  if (isV2) await mkdir(profileDir, { recursive: true });

  const supervisor = new ChildSupervisor(
    {
      id: "opencode",
      command: harness?.discovery.command ?? null,
      args: ["serve", "--port", "{port}", "--hostname", "127.0.0.1"],
      // Real keys arrive via relaunchHarness before the first spawn (SPEC-005 D5); v2 also
      // gets the redirected profile so no personal OpenCode login can shadow them (§2).
      ...(isV2 ? { env: v2ProfileEnv(profileDir) } : {}),
      healthPath: "/api/health",
      readyTimeoutMs: 30_000,
      ...(isV2 ? { healthHeaders: password.healthHeaders, onStdoutLine: password.onStdoutLine } : {}),
    },
    opts.deps ?? {},
  );

  // The bring-your-own lane, taken only when asked for. Discovery above has already run and is
  // cheap; the supervisor exists but has not spawned, and on this path it never will.
  if (opts.claude?.enabled) {
    const availability = await resolveClaudeHarness({
      discovery: opts.claude,
      cache: opts.claude.cache ?? claudeVerdicts,
      runTurn: opts.claude.runTurn ?? makeSdkProbe(),
    });
    if (availability.available) {
      return {
        harness,
        isV2,
        supervisor,
        adapter: new ClaudeAdapter({
          command: availability.command,
          runQuery: sdkQuery,
          ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
        }),
        harnessInfo: {
          generation: "claude",
          source: availability.source,
          version: availability.version,
          beta: false,
        },
        // Nothing to relaunch and no key to deliver: Claude Code authenticates from the user's
        // own login, which is the whole reason this lane carries no credential path at all.
        relaunchHarness: async () => {},
        logLines: [`Claude Code ${availability.version ?? "(unknown version)"}: ${availability.source}, confinement verified`],
      };
    }
    // Asked for and not usable is a statement, not a silence (SPEC-005 R-4). OpenCode continues
    // below, because falling back to the harness that ships is better than authoring nothing.
    claudeRefusal = availability.reason;
  }

  const baseUrl = () => `http://127.0.0.1:${supervisor.port ?? 0}`;
  const adapter = harness
    ? isV2
      ? new OpenCodeV2Adapter({
          baseUrl,
          password: password.current,
          ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
        })
      : new OpenCodeAdapter({ baseUrl, ...(opts.onTrace ? { onTrace: opts.onTrace } : {}) })
    : null;

  const logLines: string[] = [];
  if (claudeRefusal) logLines.push(`Claude Code asked for but not used — ${claudeRefusal}`);
  if (harness) {
    logLines.push(
      `OpenCode ${harness.generation}: ${harness.discovery.source} (${harness.discovery.version ?? "unknown version"})${isV2 ? " [beta]" : ""}`,
    );
    if (harness.rejectedV2) {
      logLines.push(
        `OpenCode v2 found but too old: ${harness.rejectedV2.version ?? "unknown version"} — running v1`,
      );
    }
    // The legacy knob deserves honest treatment now that a generation preference outranks it
    // (SPEC-005 R-4: degrade with the reason stated, never silently).
    if (isV2 && opts.v1?.configuredPath) {
      logLines.push(
        "configured OpenCode path passed over — v2 preferred; set ARKE_OPENCODE_GENERATION=v1 to use it",
      );
    }
    if (
      harness.generation === "v1" &&
      harness.discovery.source === "configured" &&
      meetsV2Gate(harness.discovery.version)
    ) {
      logLines.push(
        "the configured path looks like an OpenCode v2 binary — point ARKE_OPENCODE2_CMD at it instead",
      );
    }
  } else {
    logLines.push("OpenCode: not found — authoring disabled");
  }

  return {
    harness,
    isV2,
    supervisor,
    adapter,
    ...(harness ? { harnessInfo: harnessInfoFrom(harness) } : {}),
    // The PATCH form, deliberately: it names every managed variable, so a cleared key is a
    // deletion the merge honours rather than an omission it preserves.
    relaunchHarness: (credentials) => supervisor.updateEnv(credentialEnvPatch(credentials)),
    logLines,
  };
}

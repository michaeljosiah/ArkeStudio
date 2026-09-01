import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  ComfyUiDetectedInstall,
  ComfyUiEngineStatus,
  ComfyUiSettings,
  ComfyUiStatus,
  JobEngineIdentity,
  RecipeIdentity,
  RecipeReadiness,
  RecipeReasonKind,
  RuntimeProbes,
} from "@arke-studio/contracts";
import type { ChildSupervisor, SupervisedSpec } from "../supervisor.js";

/**
 * The ComfyUI engine service (SPEC-021 §2.2, §2.5, §2.12): resolve where the engine is, keep it
 * supervised when it is Arke's to run, verify what a recipe pins before anything reaches it,
 * and combine everything into the one readiness result Settings, the picker and enqueue
 * admission all read.
 *
 * Everything the service knows about a recipe arrives as *facts* — digests, node classes,
 * file lists — never a graph. The graph lives in @arke-studio/providers and crosses into this
 * package as an already-substituted request at dispatch, which is what keeps R-1 auditable by
 * dependency direction alone.
 */

export interface ComfyUiRecipeFacts {
  id: string;
  displayName: string;
  // Mirrors ComfyUiRecipe.capability, which admits voice-tts since SPEC-022. These facts are a
  // projection of the recipe, so a narrower type here silently excludes a recipe the catalogue
  // ships.
  capability: "image" | "video" | "voice-tts";
  version: number;
  minVramMb: number;
  /** The busy check's floor — free VRAM, a different question from the card-size floor above. */
  minFreeVramMb: number;
  /** The measured system-memory floor, where the recipe states one — offloading spends RAM. */
  minMemMb?: number;
  recommendedVramMb: number;
  checkpoints: ReadonlyArray<{ file: string; sha256: string; sizeMb: number; url: string }>;
  customNodes: ReadonlyArray<{ id: string; pinnedRef: string }>;
  /** A known-incomplete immutable dependency closure. It is never treated as an empty one. */
  unavailableReason?: string;
  nodeClasses: readonly string[];
  identity: RecipeIdentity;
}

export interface EngineServiceDeps {
  appRoot: string;
  recipes: readonly ComfyUiRecipeFacts[];
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  fileExists: (path: string) => Promise<boolean>;
  /** Immediate subdirectory names, or empty when the path is not a readable directory. */
  listDirectories: (path: string) => Promise<string[]>;
  /** sha256 hex of the file's bytes, or null when unreadable. The expensive pre-flight read. */
  hashFile: (path: string, signal?: AbortSignal) => Promise<string | null>;
  /** For the extra-model-paths mapping a spawned engine needs when `modelsDir` is overridden. */
  writeTextFile: (path: string, text: string) => Promise<void>;
  /** The immutable source/content identity marker of a custom-node archive, or null when unknowable. */
  readNodeRef: (dir: string) => Promise<string | null>;
  createSupervisor: (spec: SupervisedSpec) => ChildSupervisor;
  /** Registers the synchronous process-exit backstop and returns its required unsubscribe. */
  registerSupervisorExitBackstop: (supervisor: ChildSupervisor) => () => void;
  /** Mints a per-process epoch without exposing a pid in job or renderer state. */
  createProcessEpoch: () => string;
  /**
   * Free graphics memory right now, in MB, or null where the device cannot be asked
   * (SPEC-022 §2.6). Optional: a build that cannot ask simply gates on total VRAM as before.
   */
  freeVramMb?: () => Promise<number | null>;
  /** Where well-known installs are looked for. Injectable so tests need no real home. */
  homeDir?: string;
  onStatus?: (status: ComfyUiEngineStatus) => void;
  clock?: () => string;
}

/** ComfyUI's own default port — where an already-running instance is discovered, never spawned. */
/**
 * How many times `status()` will recompute before answering with what it has (#632).
 *
 * Small on purpose: this exists to converge, not to keep trying. Each pass is cheap when the
 * engine is unreachable — every recipe short-circuits — so the cost of the cap is a possibly
 * stale reading, and the cost of no cap is a wedged core and a screen that never updates again.
 */
const STATUS_RECOMPUTE_LIMIT = 4;
const DEFAULT_PORT_URL = "http://127.0.0.1:8188";
const MANAGED_DIR = "comfyui-runtime";
const VERSION_FLOOR = "0.3.45";

interface ResolvedEngine {
  source: "user-path" | "user-url" | "managed" | "absent";
  /** Filesystem root of the install (spawned engines), or null for URL/absent. */
  root: string | null;
  /** The URL as the user entered it, for user-url. */
  url: string | null;
  /** Why this resolution cannot serve, when it cannot (a path with no interpreter). */
  problem: string | null;
}

function meetsFloor(version: string): boolean | null {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
  };
  const a = parse(version);
  const b = parse(VERSION_FLOOR);
  if (a === null || b === null) return null;
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  return true;
}

/**
 * Canonicalise only the URL components whose spelling cannot change endpoint semantics.
 * Userinfo, path, query and fragment stay byte-for-byte as entered: reverse proxies may treat
 * all of them as case-sensitive, and credentials must remain part of the opaque identity.
 */
function urlInstanceLocation(location: string): string {
  const trimmed = location.trim();
  try {
    const parsed = new URL(trimmed);
    const raw = /^([a-z][a-z\d+.-]*):\/\/([^/?#]*)(.*)$/is.exec(trimmed);
    if (raw === null) return trimmed;
    const authority = raw[2]!;
    const userinfoEnd = authority.lastIndexOf("@");
    const userinfo = userinfoEnd < 0 ? "" : authority.slice(0, userinfoEnd + 1);
    // `protocol` and `host` canonicalise scheme/host case and omit an explicit default port.
    return `${parsed.protocol}//${userinfo}${parsed.host}${raw[3]!}`;
  } catch {
    // Invalid configured values are still distinct without guessing which parts are safe.
    return trimmed;
  }
}

/** Opaque digest of the resolved location (§2.11): answers "same engine?" without saying where. */
export function engineInstanceId(source: string, location: string): string {
  const normalized =
    source === "user-url"
      ? urlInstanceLocation(location)
      : location
          .trim()
          .replace(/[\\/]+$/, "")
          .toLowerCase();
  return createHash("sha256").update(`${source}|${normalized}`, "utf8").digest("hex").slice(0, 16);
}

/**
 * The host spelling from the URL's raw authority, before WHATWG canonicalisation.
 *
 * `new URL("http://2130706433")` reports `127.0.0.1`. That is useful browser behaviour and the
 * wrong security boundary: only an address the user literally wrote as Arke's two accepted
 * loopback literals may inherit the biometric-upload promise made for this machine.
 */
function rawUrlHostname(value: string): string | null {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value.trim())?.[1];
  if (authority === undefined) return null;
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostAndPort.startsWith("[")) {
    const close = hostAndPort.indexOf("]");
    return close < 0 ? null : hostAndPort.slice(1, close);
  }
  const colon = hostAndPort.lastIndexOf(":");
  return colon < 0 ? hostAndPort : hostAndPort.slice(0, colon);
}

/** A URL engine is local only for the literal IP hosts `127.0.0.1` and `::1`. */
export function comfyUiUrlIsLoopback(value: string): boolean {
  try {
    const url = new URL(value);
    const parsed = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const raw = rawUrlHostname(value)?.toLowerCase();
    return (raw === "127.0.0.1" && parsed === "127.0.0.1") || (raw === "::1" && parsed === "::1");
  } catch {
    return false;
  }
}

const gb = (mb: number): string => `${Math.round(mb / 1024)} GB`;

/**
 * What readiness assumes dispatch can hand back by unloading the engine (SPEC-022 §2.6).
 *
 * A loaded IndexTTS measured ~6 GB resident on the reference machine, and `POST /free` returns
 * all of it. This allowance is set below that on purpose: high enough that a machine merely
 * hosting a warm model is not refused work it would do, low enough that a card with almost
 * nothing free is still told so rather than left to find out.
 */
const RECLAIMABLE_VRAM_MB = 4096;

/**
 * ComfyUI needs a few ordinary Windows process variables, not Electron's credentials and service
 * configuration. The offline switches are defence in depth: every dispatchable model is already
 * present and verified, so a node trying to download at generation time must fail instead.
 */
export function comfyUiChildEnvironment(host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "CUDA_PATH",
  ] as const;
  const env: Record<string, string> = {};
  for (const name of allowed) {
    const value = host[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  if (env["SystemRoot"] === undefined) env["SystemRoot"] = "C:\\Windows";
  env["PYTHONNOUSERSITE"] = "1";
  env["HF_HUB_OFFLINE"] = "1";
  env["TRANSFORMERS_OFFLINE"] = "1";
  env["HF_DATASETS_OFFLINE"] = "1";
  env["NO_PROXY"] = "127.0.0.1,localhost";
  return env;
}

export class ComfyUiEngineService {
  private settings: ComfyUiSettings = { enginePath: null, engineUrl: null, modelsDir: null };
  private resolved: ResolvedEngine = { source: "absent", root: null, url: null, problem: null };
  private supervisor: ChildSupervisor | null = null;
  private supervisorStatusListener: (() => void) | null = null;
  private supervisorExitBackstop: (() => void) | null = null;
  private detected: ComfyUiDetectedInstall[] = [];
  /** What the engine last reported to /system_stats — version and reachability. */
  private probed: { version: string | null; reachable: boolean; detail: string | null } = {
    version: null,
    reachable: false,
    detail: null,
  };
  /**
   * The re-probe for an engine we do not spawn (#632).
   *
   * A `user-path` or `managed` engine is supervised, and supervision carries a health interval
   * that keeps asking. A `user-url` engine had exactly one reading, taken inside
   * `applySettingsOnce`, and nothing ever took another — so a single failure was permanent. It
   * survived restarts, and neither Refresh nor re-committing the URL reliably cleared it, because
   * those take another single reading and can lose the same race with the reset above.
   *
   * A healthy engine answering in five milliseconds stayed marked unreachable for as long as the
   * app ran, with every local recipe disabled behind it. This is the interval that supervision
   * would have given it.
   */
  private urlProbeTimer: ReturnType<typeof setInterval> | null = null;
  /** Newer probes supersede older requests that are still in flight. */
  private urlProbeGeneration = 0;
  /** class_type → present, from /object_info, per engine instance. */
  private nodeClasses: Set<string> | null = null;
  /** The last pre-flight verdict per recipe (§2.5): a mismatch disables until re-verified. */
  private readonly verification = new Map<string, { ok: boolean; reason?: string; reasonKind?: RecipeReasonKind }>();
  private verificationGeneration = 0;
  /** Recipes invalidated by setup/restart and awaiting a healthy engine for verification. */
  private readonly pendingVerification = new Set<string>();
  private verificationWork: Promise<void> = Promise.resolve();
  /** Streamed checkpoint reads are cancelled when their lifecycle can no longer publish. */
  private hashAbort = new AbortController();
  /** Opaque identity replaced for every spawned process, including same-path restarts. */
  private currentProcessEpoch: string | null = null;
  private readonly subscribers = new Set<() => void>();
  private readonly readinessWaiters = new Set<(ready: boolean) => void>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly deps: EngineServiceDeps) {}

  /** Notified whenever the engine's state moves (a supervised child restarting, failing…). */
  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private invalidateVerification(
    recipeIds: readonly string[] = this.deps.recipes.map((recipe) => recipe.id),
  ): void {
    this.verificationGeneration += 1;
    for (const recipeId of recipeIds) {
      this.verification.delete(recipeId);
      this.pendingVerification.add(recipeId);
    }
  }

  private cancelHashing(): void {
    this.hashAbort.abort();
    this.hashAbort = new AbortController();
  }

  // ---- resolution (§2.2) ---------------------------------------------------

  private managedRoot(): string {
    return join(this.deps.appRoot, MANAGED_DIR);
  }

  /**
   * The portable build's shape: an embedded interpreter beside the application tree.
   *
   * Checked at the root AND one level inside it, because the upstream archive wraps everything
   * in a single top folder (`ComfyUI_windows_portable/`) and the tree installer preserves that
   * wrapper — it verifies its marker one level deep for exactly this reason. Without the same
   * allowance here, the two halves of the managed install disagree: setup writes a runtime that
   * resolution then reports as absent, so the engine can never start and the download is
   * offered again on the next launch. It also lets a user point Settings at either the folder
   * they extracted or the one inside it, which is a distinction nobody should have to know.
   */
  private async portableLayout(root: string): Promise<{ python: string; main: string; base: string } | null> {
    const at = async (base: string): Promise<{ python: string; main: string; base: string } | null> => {
      const python = join(base, "python_embeded", "python.exe");
      const main = join(base, "ComfyUI", "main.py");
      if ((await this.deps.fileExists(python)) && (await this.deps.fileExists(main))) {
        return { python, main, base };
      }
      return null;
    };
    const direct = await at(root);
    if (direct !== null) return direct;
    for (const nested of await this.deps.listDirectories(root)) {
      const inside = await at(join(root, nested));
      if (inside !== null) return inside;
    }
    return null;
  }

  private async resolve(): Promise<ResolvedEngine> {
    const { engineUrl, enginePath } = this.settings;
    // A URL is the user saying "it is already running" — never spawned, only probed (D13),
    // and it wins over a path: both set means the path is the install the URL is serving.
    if (engineUrl !== null) return { source: "user-url", root: null, url: engineUrl, problem: null };
    if (enginePath !== null) {
      const layout = await this.portableLayout(enginePath);
      if (layout !== null) {
        // The layout's own base, not what the user pointed at: with the archive's wrapper
        // folder in play those differ, and `root` is what modelsDir() and custom-node
        // verification build their paths from. One resolver, one answer (§2.4).
        return { source: "user-path", root: layout.base, url: null, problem: null };
      }
      if (await this.deps.fileExists(join(enginePath, "main.py"))) {
        return {
          source: "user-path",
          root: enginePath,
          url: null,
          problem:
            "this install has no embedded Python for Arke to launch — run it yourself and point Settings at its URL",
        };
      }
      return {
        source: "user-path",
        root: enginePath,
        url: null,
        problem: "no ComfyUI was found at this path (no main.py or portable layout)",
      };
    }
    const managed = await this.portableLayout(this.managedRoot());
    if (managed !== null) {
      return { source: "managed", root: managed.base, url: null, problem: null };
    }
    return { source: "absent", root: null, url: null, problem: null };
  }

  /** Detection offers, never installs (D10): a live default port, then well-known folders. */
  private async detectExisting(): Promise<ComfyUiDetectedInstall[]> {
    const found: ComfyUiDetectedInstall[] = [];
    const live = await this.systemStats(DEFAULT_PORT_URL);
    if (live.reachable) found.push({ location: DEFAULT_PORT_URL, version: live.version });
    const home = this.deps.homeDir ?? process.env["USERPROFILE"] ?? "";
    const candidates = [
      join(home, "ComfyUI"),
      join(home, "Documents", "ComfyUI"),
      join(home, "ComfyUI_windows_portable"),
      "C:\\ComfyUI",
      "C:\\AI\\ComfyUI",
    ].filter((p) => p.length > 3);
    for (const candidate of candidates) {
      if (
        (await this.portableLayout(candidate)) ||
        (await this.deps.fileExists(join(candidate, "main.py")))
      ) {
        found.push({ location: candidate, version: null });
      }
    }
    return found;
  }

  // ---- probing (§2.6 D14) --------------------------------------------------

  /**
   * The probe, and — when it fails — what actually happened (#632).
   *
   * This used to swallow every failure into one sentence: "the engine did not answer". That
   * sentence is read by a person deciding whether their engine is running, and it describes a
   * timeout or a refused connection. It was also what a 404 said, and a version floor, and an
   * abort. An engine answering `/system_stats` in five milliseconds was reported as silent, and
   * the only way to find out otherwise was to read the source. A failure names itself here.
   */
  private async systemStats(base: string): Promise<{ reachable: boolean; version: string | null; detail: string | null }> {
    const url = `${base.replace(/\/+$/, "")}/system_stats`;
    try {
      const res = await this.deps.fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return { reachable: false, version: null, detail: `${url} answered HTTP ${res.status}` };
      const body = (await res.json().catch(() => null)) as { system?: { comfyui_version?: unknown } } | null;
      const version = body?.system?.comfyui_version;
      return { reachable: true, version: typeof version === "string" ? version : null, detail: null };
    } catch (err) {
      const named = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { reachable: false, version: null, detail: `${url} — ${named}` };
    }
  }

  private async loadNodeClasses(base: string): Promise<Set<string> | null> {
    try {
      const res = await this.deps.fetch(`${base.replace(/\/+$/, "")}/object_info`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return body === null ? null : new Set(Object.keys(body));
    } catch {
      return null;
    }
  }

  // ---- supervision (§2.8) --------------------------------------------------

  private async startSupervision(root: string): Promise<void> {
    if (this.disposed) return;
    const layout = await this.portableLayout(root);
    if (layout === null || this.disposed) return; // resolve() already recorded the problem
    const args = ["-s", layout.main, "--port", "{port}", "--listen", "127.0.0.1", "--disable-metadata"];
    // A models override reaches a spawned engine through an extra-model-paths file — the
    // engine must actually read the folder verification hashes, or R-8's "no re-download"
    // would verify one library while the engine loads another.
    if (this.settings.modelsDir !== null) {
      const yamlPath = join(this.deps.appRoot, "comfyui-extra-model-paths.yaml");
      const dir = this.settings.modelsDir.replaceAll("\\", "/");
      await this.deps.writeTextFile(
        yamlPath,
        [
          "arke:",
          `  base_path: ${dir}`,
          "  checkpoints: checkpoints",
          "  diffusion_models: diffusion_models",
          "  text_encoders: text_encoders",
          "  vae: vae",
          "  loras: loras",
          "",
        ].join("\n"),
      );
      if (this.disposed) return;
      args.push("--extra-model-paths-config", yamlPath);
    }
    const supervisor = this.deps.createSupervisor({
      id: "comfyui",
      command: layout.python,
      args,
      healthPath: "/system_stats",
      readyTimeoutMs: 120_000, // a cold engine imports torch; a minute is not a hang
      probeIntervalMs: 1_000,
      healthIntervalMs: 15_000,
      healthFailureThreshold: 3,
      env: comfyUiChildEnvironment(),
      inheritEnv: false,
      validateHealth: async (response) => {
        const body = (await response.json().catch(() => null)) as {
          system?: { comfyui_version?: unknown };
        } | null;
        const version = body?.system?.comfyui_version;
        if (typeof version !== "string") {
          return {
            ok: false,
            reason: `the engine did not report a ComfyUI version — Arke supports ${VERSION_FLOOR} and later`,
          };
        }
        if (meetsFloor(version) !== true) {
          return {
            ok: false,
            reason: `ComfyUI ${version} is older than the ${VERSION_FLOOR} floor Arke supports`,
          };
        }
        this.probed = { version, reachable: true, detail: null };
        return { ok: true };
      },
    });
    type SpawnAwareSupervisor = ChildSupervisor & { spawnEpoch?: number };
    const observedEpoch = (): number | null => {
      const epoch = (supervisor as SpawnAwareSupervisor).spawnEpoch;
      return typeof epoch === "number" && epoch > 0 ? epoch : null;
    };
    // The first epoch belongs to the launch `start()` is about to perform. Every later
    // `starting` event from this same supervisor is an automatic replacement process at the
    // same path, whose queue and history are empty even though instanceId is unchanged.
    const createProcessEpoch = this.deps.createProcessEpoch;
    this.currentProcessEpoch = createProcessEpoch();
    let currentSupervisorEpoch = observedEpoch();
    const statusListener = () => {
      if (this.disposed) return;
      if (supervisor.status === "starting") {
        const epoch = observedEpoch();
        if (epoch !== null && epoch !== currentSupervisorEpoch) {
          currentSupervisorEpoch = epoch;
          this.currentProcessEpoch = createProcessEpoch();
        }
      } else if (supervisor.status === "failed") {
        // Fence a child that died without a replacement. Jobs bind to this tombstone epoch and
        // stay queued until a later healthy process publishes another epoch.
        this.currentProcessEpoch = createProcessEpoch();
      }
      if (supervisor.status !== "healthy") {
        this.cancelHashing();
        this.nodeClasses = null;
        this.invalidateVerification();
      }
      void this.verifyPending()
        .then(() => this.publish())
        .catch(() => {});
    };
    supervisor.on("status", statusListener);
    this.supervisor = supervisor;
    this.supervisorStatusListener = statusListener;
    this.supervisorExitBackstop = this.deps.registerSupervisorExitBackstop(supervisor);
    // Fire and observe, never await: start() resolves only after the health probe settles, and
    // a cold engine imports torch for a minute or two. Settings answers now with "starting",
    // and the status subscription publishes every transition as it happens (R-6).
    void supervisor.start().catch(() => {});
  }

  private async stopSupervision(): Promise<void> {
    const supervisor = this.supervisor;
    this.supervisor = null;
    const statusListener = this.supervisorStatusListener;
    this.supervisorStatusListener = null;
    this.supervisorExitBackstop?.();
    this.supervisorExitBackstop = null;
    if (supervisor && statusListener) supervisor.off("status", statusListener);
    if (supervisor) await supervisor.stop().catch(() => {});
    this.currentProcessEpoch = null;
  }

  // ---- the public surface --------------------------------------------------

  /**
   * Apply Settings (§2.2): re-resolve, restart supervision, re-probe, publish.
   *
   * Serialized, because it awaits four times and re-reads its own state afterwards. Two calls
   * interleaving — a user changing the path twice, or a Settings change racing start-up —
   * would let the second stop the first's supervisor before it was assigned, and the first
   * would then overwrite `this.supervisor` with a child nothing can reach: a leaked engine
   * process holding a port, invisible to stop() and to dispose().
   */
  applySettings(settings: ComfyUiSettings): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // Invalidate immediately, before the serialized stop/resolve work begins: an in-flight
    // checkpoint hash must not publish an old engine's verdict while this change waits its turn.
    this.cancelHashing();
    this.urlProbeGeneration += 1;
    this.nodeClasses = null;
    this.invalidateVerification();
    const next = this.settingsWork.then(
      () => this.applySettingsOnce(settings),
      () => this.applySettingsOnce(settings),
    );
    this.settingsWork = next.catch(() => {});
    return next;
  }

  private settingsWork: Promise<void> = Promise.resolve();

  private async applySettingsOnce(settings: ComfyUiSettings): Promise<void> {
    if (this.disposed) return;
    this.nodeClasses = null;
    this.invalidateVerification();
    this.settings = settings;
    this.stopUrlProbe();
    await this.stopSupervision();
    if (this.disposed) {
      this.resolved = { source: "absent", root: null, url: null, problem: null };
      return;
    }
    this.probed = { version: null, reachable: false, detail: null };
    this.resolved = await this.resolve();
    if (this.disposed) return;
    this.detected = this.resolved.source === "absent" ? await this.detectExisting() : [];
    if (this.disposed) return;
    if (
      (this.resolved.source === "user-path" || this.resolved.source === "managed") &&
      this.resolved.problem === null
    ) {
      await this.startSupervision(this.resolved.root!);
    }
    if (this.resolved.source === "user-url") {
      await this.probeUrlEngine();
      this.startUrlProbe();
    }
    await this.publish();
  }

  /** One reading of a URL engine, recorded. Publishes nothing — callers decide. */
  private async probeUrlEngine(): Promise<void> {
    if (this.resolved.source !== "user-url" || this.resolved.url === null) return;
    const url = this.resolved.url;
    const generation = ++this.urlProbeGeneration;
    const stats = await this.systemStats(url);
    if (
      this.disposed ||
      generation !== this.urlProbeGeneration ||
      this.resolved.source !== "user-url" ||
      this.resolved.url !== url
    )
      return;
    this.probed = {
      version: stats.version,
      reachable: stats.reachable,
      detail: stats.reachable ? null : (stats.detail ?? "the engine did not answer"),
    };
  }

  /**
   * Keep asking, and publish when the answer changes (#632). Mirrors the 15 s health interval a
   * supervised engine already gets — the point is that no single reading is final.
   */
  private startUrlProbe(): void {
    this.stopUrlProbe();
    if (this.disposed) return;
    this.urlProbeTimer = setInterval(() => {
      void (async () => {
        if (this.disposed || this.resolved.source !== "user-url") return;
        const before = { ...this.probed };
        await this.probeUrlEngine();
        const changed =
          before.reachable !== this.probed.reachable ||
          before.version !== this.probed.version ||
          before.detail !== this.probed.detail;
        if (changed) await this.publish();
      })();
    }, 15_000);
    // Never hold the process open for a poll: the app closing matters more than the next reading.
    this.urlProbeTimer.unref?.();
  }

  private stopUrlProbe(): void {
    if (this.urlProbeTimer !== null) {
      clearInterval(this.urlProbeTimer);
      this.urlProbeTimer = null;
    }
  }

  /**
   * Measure the selected engine now. For an absent selection this repeats discovery, so a
   * ComfyUI started after Arke appears as an offer without requiring an application restart.
   */
  checkNow(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const next = this.settingsWork.then(
      () => this.checkNowOnce(),
      () => this.checkNowOnce(),
    );
    this.settingsWork = next.catch(() => {});
    return next;
  }

  private async checkNowOnce(): Promise<void> {
    if (this.disposed) return;
    if (this.resolved.source === "user-url") await this.probeUrlEngine();
    else if (this.resolved.source === "absent") this.detected = await this.detectExisting();
    if (this.disposed) return;
    await this.reverify();
  }

  /** Where a dispatch reaches the engine right now, or null when nothing healthy answers. */
  baseUrl(): string | null {
    if (this.resolved.source === "user-url") {
      // Reachable is not enough: an engine below the version floor answers perfectly well,
      // and dispatching to it would discover the incompatibility as a failed generation.
      return this.probed.reachable && this.floorOk() ? this.resolved.url : null;
    }
    const supervisor = this.supervisor;
    if (supervisor && supervisor.status === "healthy" && supervisor.port !== null) {
      return `http://127.0.0.1:${supervisor.port}`;
    }
    return null;
  }

  /** The opaque instance digest of the currently resolved engine (§2.11), or null when absent. */
  instanceId(): string | null {
    const location = this.resolved.source === "user-url" ? this.resolved.url : this.resolved.root;
    if (this.resolved.source === "absent" || location === null) return null;
    return engineInstanceId(this.resolved.source, location);
  }

  engineIdentity(): JobEngineIdentity | null {
    const id = this.instanceId();
    if (id === null || this.resolved.source === "absent") return null;
    if (this.resolved.source === "user-url") {
      return {
        source: this.resolved.source,
        instanceId: id,
        locality: this.engineLocality(),
      };
    }
    if (this.currentProcessEpoch === null) return null;
    return {
      source: this.resolved.source,
      instanceId: id,
      locality: "local",
      processEpoch: this.currentProcessEpoch,
    };
  }

  /** The remote destination a renderer may explicitly approve, without URL secrets or paths. */
  voiceUploadDestination(): { token: string; label: string } | null {
    const identity = this.engineIdentity();
    if (identity?.source !== "user-url" || identity.locality !== "remote" || this.resolved.url === null)
      return null;
    try {
      // `host` is canonical ASCII host + port. It excludes userinfo, path, query and fragment.
      const label = new URL(this.resolved.url).host;
      return label.length > 0 ? { token: identity.instanceId, label } : null;
    } catch {
      return null;
    }
  }

  /** Wait for a spawned child to settle without making coordinator startup wait on it. */
  waitUntilReady(timeoutMs = 120_000): Promise<boolean> {
    if (this.baseUrl() !== null) return Promise.resolve(true);
    if (this.disposed || this.engineStatus().state !== "starting") return Promise.resolve(false);
    return new Promise((resolveReady) => {
      let timer: NodeJS.Timeout;
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        this.readinessWaiters.delete(finish);
        resolveReady(ready);
      };
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.readinessWaiters.add(finish);
    });
  }

  /** The models folder every path resolves against (§2.4) — one resolver, everywhere. */
  modelsDir(): string | null {
    if (this.settings.modelsDir !== null) return this.settings.modelsDir;
    const root = this.resolved.root;
    if (root === null) return null; // a URL engine has no folder unless the user maps one (D13)
    return join(root, "ComfyUI", "models");
  }

  /** Whether a source has been deliberately selected instead of the managed runtime. */
  async externallySelected(): Promise<boolean> {
    if (this.settings.engineUrl !== null || this.settings.enginePath !== null) return true;
    return false;
  }

  private engineLocality(): "local" | "remote" {
    return this.resolved.source === "user-url" &&
      this.resolved.url !== null &&
      !comfyUiUrlIsLoopback(this.resolved.url)
      ? "remote"
      : "local";
  }

  engineStatus(): ComfyUiEngineStatus {
    const { source, root, url, problem } = this.resolved;
    const location =
      source === "user-url"
        ? url
        : source === "user-path"
          ? root
          : source === "managed"
            ? this.managedLocation()
            : null;
    let state: ComfyUiEngineStatus["state"];
    let detail: string | null = null;
    if (source === "absent") {
      state = "absent";
    } else if (problem !== null) {
      state = "failed";
      detail = problem;
    } else if (source === "user-url") {
      state = this.probed.reachable ? (this.floorOk() ? "ready" : "incompatible") : "unreachable";
      detail = this.probed.reachable
        ? this.floorOk()
          ? null
          : this.floorDetail()
        : (this.probed.detail ?? "the engine did not answer");
    } else {
      const supervisor = this.supervisor;
      switch (supervisor?.status) {
        case "healthy":
          state = "ready";
          break;
        case "starting":
        case "unhealthy":
          state = "starting";
          detail = supervisor.reason ?? null;
          break;
        case "failed":
          state = "failed";
          detail = supervisor.reason ?? "the engine did not start";
          break;
        default:
          state = "starting";
      }
    }
    return {
      source,
      state,
      locality: this.engineLocality(),
      location,
      version: this.probed.version,
      instanceId: this.instanceId(),
      detail,
      detected: this.detected,
    };
  }

  private managedLocation(): string {
    const port = this.supervisor?.port;
    return port != null && this.supervisor?.status === "healthy" ? `127.0.0.1:${port}` : "Arke-managed";
  }

  private floorOk(): boolean {
    return this.probed.version !== null && meetsFloor(this.probed.version) === true;
  }

  private floorDetail(): string {
    return this.probed.version === null
      ? `the engine did not report a ComfyUI version — Arke supports ${VERSION_FLOOR} and later`
      : `ComfyUI ${this.probed.version} is older than the ${VERSION_FLOOR} floor Arke supports`;
  }

  // ---- pre-flight (§2.5, R-9) ---------------------------------------------

  /**
   * Verify the recipe's pinned dependencies against the resolved location, naming the file and
   * what was found in place of what was expected. Runs before every dispatch — the client
   * calls this immediately before submit — and its verdict is what readiness reports until
   * the next verification changes it.
   */
  async preflight(
    recipeId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; reasonKind?: RecipeReasonKind }> {
    const recipe = this.deps.recipes.find((r) => r.id === recipeId);
    if (!recipe) return { ok: false, reason: `"${recipeId}" is not a shipped recipe`, reasonKind: "catalogue" };
    type Verdict = { ok: true } | { ok: false; reason: string; reasonKind?: RecipeReasonKind };
    const generation = this.verificationGeneration;
    const hashSignal = this.hashAbort.signal;
    const record = (verdict: Verdict, complete = true): Verdict => {
      if (generation !== this.verificationGeneration) {
        return {
          ok: false,
          reason: "the engine changed during dependency verification; re-verification is required",
          reasonKind: "verification",
        };
      }
      this.verification.set(recipeId, verdict);
      if (complete) this.pendingVerification.delete(recipeId);
      return verdict;
    };
    if (recipe.unavailableReason !== undefined) {
      const verdict = { ok: false as const, reason: recipe.unavailableReason, reasonKind: "catalogue" as const };
      return record(verdict);
    }
    if (this.baseUrl() === null) {
      const verdict = { ok: false as const, reason: "the ComfyUI engine is not ready", reasonKind: "engine" as const };
      return record(verdict, false);
    }
    const dir = this.modelsDir();
    const engineRoot = this.resolved.root;
    // A recipe that legitimately pins no checkpoints has nothing in that folder to verify.
    // A known-incomplete closure is refused above; an empty list can never stand in for a node's
    // undeclared generation-time download.
    if (dir === null && recipe.checkpoints.length > 0) {
      const verdict = {
        ok: false as const,
        reason:
          "Arke cannot verify this engine's files — map its models folder in Settings to enable local recipes",
        reasonKind: "models-folder" as const,
      };
      return record(verdict);
    }
    for (const checkpoint of dir === null ? [] : recipe.checkpoints) {
      const path = join(dir!, checkpoint.file);
      if (!(await this.deps.fileExists(path))) {
        const verdict = {
          ok: false as const,
          reason: `${checkpoint.file} is missing from the models folder`,
          reasonKind: "files" as const,
        };
        return record(verdict);
      }
      if (generation !== this.verificationGeneration) {
        return {
          ok: false,
          reason: "the engine changed during dependency verification; re-verification is required",
          reasonKind: "verification",
        };
      }
      const found = await this.deps.hashFile(path, hashSignal);
      if (hashSignal.aborted) {
        return {
          ok: false,
          reason: "dependency verification was stopped because the engine lifecycle changed",
          reasonKind: "verification" as const,
        };
      }
      if (found === null) {
        const verdict = {
          ok: false as const,
          reason: `${checkpoint.file} could not be read for verification`,
          reasonKind: "verification" as const,
        };
        return record(verdict);
      }
      if (found.toLowerCase() !== checkpoint.sha256.toLowerCase()) {
        const verdict = {
          ok: false as const,
          reason:
            `${checkpoint.file} does not match its pinned version — ` +
            `expected sha256 ${checkpoint.sha256.slice(0, 8)}…, found sha256 ${found.slice(0, 8)}…`,
          reasonKind: "digest" as const,
        };
        return record(verdict);
      }
    }
    /*
     * Where this engine keeps its custom nodes.
     *
     * A managed install has a root and they sit under it. A URL engine has no root — but D13
     * says the models-dir mapping IS the user's assertion that this engine's files are on this
     * machine, and that it is the only unlock. `custom_nodes` is the sibling of `models` in
     * every ComfyUI layout, so the same assertion locates them. Without it there is still
     * nothing to check and the refusal stands.
     */
    const customNodesDir =
      engineRoot !== null
        ? join(engineRoot, "ComfyUI", "custom_nodes")
        : dir !== null
          ? join(dir, "..", "custom_nodes")
          : null;
    for (const node of recipe.customNodes) {
      if (customNodesDir === null) {
        const verdict = {
          ok: false as const,
          reason: `custom node ${node.id} cannot be verified on a URL engine — map its models folder in Settings (SPEC-021 D13)`,
          reasonKind: "models-folder" as const,
        };
        return record(verdict);
      }
      const nodeDir = join(customNodesDir, node.id);
      if (!(await this.deps.fileExists(nodeDir))) {
        const verdict = { ok: false as const, reason: `custom node ${node.id} is missing from the engine`, reasonKind: "node" as const };
        return record(verdict);
      }
      if (generation !== this.verificationGeneration) {
        return {
          ok: false,
          reason: "the engine changed during dependency verification; re-verification is required",
          reasonKind: "verification",
        };
      }
      const ref = await this.deps.readNodeRef(nodeDir).catch(() => null);
      if (generation !== this.verificationGeneration) {
        return {
          ok: false,
          reason: "the engine changed during dependency verification; re-verification is required",
          reasonKind: "verification",
        };
      }
      if (ref === null) {
        const verdict = {
          ok: false as const,
          reason: `custom node ${node.id} source/content identity could not be read; it is unverified`,
          reasonKind: "verification" as const,
        };
        return record(verdict);
      }
      if (ref.toLowerCase() !== node.pinnedRef.toLowerCase()) {
        const verdict = {
          ok: false as const,
          reason: `custom node ${node.id} is at ${ref.slice(0, 10)}, not the pinned ${node.pinnedRef.slice(0, 10)}`,
          reasonKind: "node" as const,
        };
        return record(verdict);
      }
    }
    return record({ ok: true });
  }

  /**
   * Invalidate and re-check dependency identity after setup. If the child is still starting, the
   * pending set is consumed by its healthy transition instead of falsely publishing readiness.
   */
  async reverify(recipeIds?: readonly string[]): Promise<void> {
    if (this.disposed) return;
    this.cancelHashing();
    this.nodeClasses = null;
    this.invalidateVerification(recipeIds);
    await this.runVerificationWork(() => this.verifyPending(true));
    await this.publish();
  }

  private runVerificationWork(work: () => Promise<void>): Promise<void> {
    const next = this.verificationWork.then(work, work);
    this.verificationWork = next.catch(() => {});
    return next;
  }

  private async verifyPending(hashDependencies = false): Promise<void> {
    if (this.disposed || this.baseUrl() === null || this.pendingVerification.size === 0) return;
    const base = this.baseUrl()!;
    const generation = this.verificationGeneration;
    const nodeClasses = await this.loadNodeClasses(base);
    if (generation !== this.verificationGeneration || base !== this.baseUrl()) return;
    this.nodeClasses = nodeClasses;
    if (hashDependencies) {
      for (const recipeId of this.pendingVerification) await this.preflight(recipeId);
    }
  }

  // ---- readiness (§2.12) ---------------------------------------------------

  /**
   * The one combined result. `probes` may be null when hardware was never measured.
   *
   * The restart is bounded (#632). Readiness is recomputed when verification is invalidated
   * underneath it, so that the answer describes one coherent moment — but the retry used to be
   * `for (;;)`, which assumes invalidation eventually stops. When it does not, this spins a core
   * at 100% and never returns, and because `refreshComfyUi` awaits it, **no `comfyui.status` is
   * ever published again**: the engine pane keeps whatever it last had, every recipe stays
   * disabled, and nothing anywhere says why. That is not a hypothetical — it is how this was
   * found, with the engine answering `/system_stats` in five milliseconds throughout.
   *
   * A stale-but-delivered answer beats a perfect one that never arrives, and the next
   * invalidation publishes again anyway.
   */
  async status(probes: RuntimeProbes | null): Promise<ComfyUiStatus> {
    for (let attempt = 0; ; attempt += 1) {
      const settled = attempt >= STATUS_RECOMPUTE_LIMIT;
      const generation = this.verificationGeneration;
      const engine = this.engineStatus();
      const base = this.baseUrl();
      if (engine.state === "ready" && base !== null && this.nodeClasses === null) {
        const nodeClasses = await this.loadNodeClasses(base);
        if (!settled && (generation !== this.verificationGeneration || base !== this.baseUrl())) continue;
        this.nodeClasses = nodeClasses;
      }
      const recipes: RecipeReadiness[] = [];
      for (const recipe of this.deps.recipes) {
        recipes.push(await this.recipeReadiness(recipe, engine, probes));
      }
      if (!settled && generation !== this.verificationGeneration) continue;
      return { engine, recipes, checkedAt: (this.deps.clock ?? (() => new Date().toISOString()))() };
    }
  }

  private async recipeReadiness(
    recipe: ComfyUiRecipeFacts,
    engine: ComfyUiEngineStatus,
    probes: RuntimeProbes | null,
  ): Promise<RecipeReadiness> {
    const base = {
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      displayName: recipe.displayName,
      capability: recipe.capability,
    } as const;
    // The reason kind is the walk saying WHICH step refused (SPEC-032 R-20, D3): the
    // diagnostics joins branch on it, and without it they would be parsing this function's
    // sentences to reconstruct what this function already knew.
    const disabled = (
      reasonKind: RecipeReasonKind,
      reason: string,
      cloudAlternative?: string,
    ): RecipeReadiness => ({
      ...base,
      state: "disabled",
      reason,
      reasonKind,
      ...(cloudAlternative !== undefined ? { cloudAlternative } : {}),
    });

    // A known-incomplete closure is a hard dependency refusal, not an empty dependency set.
    if (recipe.unavailableReason !== undefined) return disabled("catalogue", recipe.unavailableReason);

    // 1 · The engine itself.
    if (engine.state === "absent") return disabled("engine", "no ComfyUI engine is configured or installed");
    if (engine.state === "unreachable") return disabled("engine", "the engine did not answer");
    if (engine.state === "incompatible") return disabled("engine", engine.detail ?? "the engine is incompatible");
    if (engine.state === "failed") return disabled("engine", engine.detail ?? "the engine did not start");
    if (engine.state === "starting") return disabled("engine", "the engine is starting");

    // 2 · A URL engine's files are unverifiable without the explicit mapping (D13) — but only
    // where there are files to verify. Step 4 is the only one that reads the folder and it
    // already skips when there is none, so a checkpoint-less recipe was being refused here for
    // want of something it never asks for, and could not be enabled on a URL engine at all.
    if (engine.source === "user-url" && this.modelsDir() === null && recipe.checkpoints.length > 0) {
      return disabled("models-folder", "Arke cannot verify this engine's files — map its models folder to enable");
    }

    // 3 · The compatibility probe, per recipe (D14): a missing node names itself.
    if (this.nodeClasses === null) {
      return disabled("verification", "the engine's node catalogue could not be verified");
    }
    const missing = recipe.nodeClasses.filter((cls) => !this.nodeClasses!.has(cls));
    if (missing.length > 0) {
      return disabled(
        "node",
        `this engine has no ${missing[0]} node — ComfyUI ${VERSION_FLOOR} or later is required`,
      );
    }

    // 4 · Weights, at the resolved location — presence, not yet bytes (§2.5 hashes at dispatch).
    const dir = this.modelsDir();
    if (dir !== null) {
      let missing = 0;
      for (const checkpoint of recipe.checkpoints) {
        if (!(await this.deps.fileExists(join(dir, checkpoint.file)))) missing += 1;
      }
      if (missing > 0) {
        const total = recipe.checkpoints.length;
        return disabled(
          "files",
          `${missing} of ${total} model file${total === 1 ? "" : "s"} missing from the models folder`,
        );
      }
    }

    // 5 · A pin mismatch found at pre-flight disables until re-verified (§2.5).
    const verified = this.verification.get(recipe.id) ?? (await this.preflight(recipe.id));
    if (!verified.ok) {
      return disabled(verified.reasonKind ?? "verification", verified.reason ?? "verification failed");
    }

    // 6 · Hardware (§2.7): both figures when measured; unknown stays unknown and dispatches (D15).
    // Desktop probes describe this computer. Applying them to a non-loopback URL would report
    // this machine's card as if it belonged to the remote engine.
    const vram = engine.locality === "remote" ? null : (probes?.vramMb ?? null);
    if (vram === null) {
      return {
        ...base,
        state: "unknown",
        reason: `${engine.locality === "remote" ? "Remote engine" : "VRAM"} VRAM could not be measured. The ${gb(recipe.minVramMb)} floor was not checked.`,
        reasonKind: "vram",
      };
    }
    if (vram < recipe.minVramMb) {
      return disabled(
        "vram",
        `Needs ${gb(recipe.minVramMb)} VRAM. This machine has ${gb(vram)}. Cloud ${recipe.capability} still works.`,
        `Cloud ${recipe.capability} still works.`,
      );
    }
    /*
     * 6b · System memory, where the recipe measured a floor. The manifest gate only steers
     * setup: weights that already exist in a mapped models folder reach this walk without ever
     * meeting fitFor, so a 16 GB machine would enqueue the workload that measured 32 GB — and
     * memory is not VRAM's problem: /free reclaims nothing here, so there is no busy tier.
     */
    if (recipe.minMemMb !== undefined) {
      const mem = engine.locality === "remote" ? null : (probes?.memMb ?? null);
      if (mem === null) {
        return {
          ...base,
          state: "unknown",
          reason: `Memory could not be measured. The ${gb(recipe.minMemMb)} floor was not checked.`,
          reasonKind: "memory",
        };
      }
      if (mem < recipe.minMemMb) {
        return disabled(
          "memory",
          `Needs ${gb(recipe.minMemMb)} memory. This machine has ${gb(mem)}. Cloud ${recipe.capability} still works.`,
          `Cloud ${recipe.capability} still works.`,
        );
      }
    }
    /*
     * 7 · The card is big enough. Could it be free enough?
     *
     * A card clears the floor and the recipe still cannot run, because a browser or another AI
     * tool already holds a third of it. Checking only the total is what let a 10 GB machine read
     * "ready" and then page to disk for half an hour (SPEC-022 §2.6).
     *
     * But raw free memory is the wrong number to refuse on, because it counts the engine's own
     * resident model against us — and dispatch unloads that before it gives up (`POST /free`).
     * Readiness will not call `/free` itself: that discards the model cache every twenty seconds
     * to answer a status poll. So it assumes the reclaim instead, and refuses only what no amount
     * of unloading could rescue.
     *
     * The result is deliberately optimistic. Readiness is advisory and dispatch is authoritative:
     * a "ready" that later refuses in a quarter of a second costs a click, while a "disabled" on
     * a machine that would have worked costs the feature. The sentence is also a different one
     * from the too-small case above — that card will never be big enough, this one is busy —
     * even though both disable, because both mean pressing Generate buys a wait, not a take.
     *
     * The floor here is the recipe's FREE-VRAM figure, not the card-size floor above. Reusing
     * one number for both refused the configuration H3 was verified on: a streaming recipe's
     * card floor can equal the whole card while the free requirement is a fraction of it.
     */
    const free =
      engine.locality === "remote" || !this.deps.freeVramMb
        ? null
        : await this.deps.freeVramMb().catch(() => null);
    /*
     * The allowance is capped below the recipe's own free floor: a floor at or under the reclaim
     * assumption (H3's 4 GB against the 4 GB allowance) would otherwise make this inequality
     * unsatisfiable for any nonnegative reading — a slammed card advertised ready, and Generate
     * bought the dependency verification walk before dispatch refused. Half the floor is the
     * largest assumption that still leaves the busy sentence sayable.
     */
    const assumedReclaimMb =
      RECLAIMABLE_VRAM_MB < recipe.minFreeVramMb ? RECLAIMABLE_VRAM_MB : Math.floor(recipe.minFreeVramMb / 2);
    if (free !== null && free + assumedReclaimMb < recipe.minFreeVramMb) {
      return disabled(
        "vram-busy",
        `Needs ${gb(recipe.minFreeVramMb)} free. This machine has ${gb(free)} free of ${gb(vram)} — close other programs using the graphics card. Cloud ${recipe.capability} still works.`,
        `Cloud ${recipe.capability} still works.`,
      );
    }
    return { ...base, state: "ready" };
  }

  /** The identity a job freezes at enqueue (R-15), or null when the model is not a recipe. */
  identityFor(modelId: string): { recipe: RecipeIdentity; engine: JobEngineIdentity | null } | null {
    const recipe = this.deps.recipes.find((r) => r.id === modelId);
    if (!recipe) return null;
    return { recipe: recipe.identity, engine: this.engineIdentity() };
  }

  private async publish(): Promise<void> {
    if (this.disposed) return;
    const engine = this.engineStatus();
    if (this.baseUrl() !== null) {
      for (const waiter of this.readinessWaiters) waiter(true);
    } else if (engine.state !== "starting") {
      for (const waiter of this.readinessWaiters) waiter(false);
    }
    this.deps.onStatus?.(engine);
    for (const listener of this.subscribers) {
      try {
        listener();
      } catch {
        /* a broken listener must not take the engine service down */
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposed = true;
    this.stopUrlProbe();
    this.hashAbort.abort();
    this.resolved = { source: "absent", root: null, url: null, problem: null };
    for (const waiter of this.readinessWaiters) waiter(false);
    this.subscribers.clear();
    this.disposePromise = (async () => {
      // A settings pass may be between resolving a portable layout and assigning its supervisor.
      // Join that serialized pass before the final stop so no continuation can spawn afterwards.
      await this.settingsWork;
      this.resolved = { source: "absent", root: null, url: null, problem: null };
      await this.stopSupervision();
    })();
    return this.disposePromise;
  }
}

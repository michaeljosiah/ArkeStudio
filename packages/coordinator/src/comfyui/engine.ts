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
  capability: "image" | "video";
  version: number;
  minVramMb: number;
  recommendedVramMb: number;
  checkpoints: ReadonlyArray<{ file: string; sha256: string; sizeMb: number; url: string }>;
  customNodes: ReadonlyArray<{ id: string; pinnedRef: string }>;
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
  hashFile: (path: string) => Promise<string | null>;
  /** For the extra-model-paths mapping a spawned engine needs when `modelsDir` is overridden. */
  writeTextFile: (path: string, text: string) => Promise<void>;
  /** The pinned ref a custom-node checkout is at, or null when unknowable. Unused while D11 ships zero nodes. */
  readNodeRef?: (dir: string) => Promise<string | null>;
  createSupervisor: (spec: SupervisedSpec) => ChildSupervisor;
  /** Where well-known installs are looked for. Injectable so tests need no real home. */
  homeDir?: string;
  onStatus?: (status: ComfyUiEngineStatus) => void;
  clock?: () => string;
}

/** ComfyUI's own default port — where an already-running instance is discovered, never spawned. */
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

/** Opaque digest of the resolved location (§2.11): answers "same engine?" without saying where. */
export function engineInstanceId(source: string, location: string): string {
  const normalized = location.trim().replace(/[\\/]+$/, "").toLowerCase();
  return createHash("sha256").update(`${source}|${normalized}`, "utf8").digest("hex").slice(0, 16);
}

const gb = (mb: number): string => `${Math.round(mb / 1024)} GB`;

export class ComfyUiEngineService {
  private settings: ComfyUiSettings = { enginePath: null, engineUrl: null, modelsDir: null };
  private resolved: ResolvedEngine = { source: "absent", root: null, url: null, problem: null };
  private supervisor: ChildSupervisor | null = null;
  private detected: ComfyUiDetectedInstall[] = [];
  /** What the engine last reported to /system_stats — version and reachability. */
  private probed: { version: string | null; reachable: boolean; detail: string | null } = {
    version: null,
    reachable: false,
    detail: null,
  };
  /** class_type → present, from /object_info, per engine instance. */
  private nodeClasses: Set<string> | null = null;
  /** The last pre-flight verdict per recipe (§2.5): a mismatch disables until re-verified. */
  private readonly verification = new Map<string, { ok: boolean; reason?: string }>();
  private readonly subscribers = new Set<() => void>();
  private disposed = false;

  constructor(private readonly deps: EngineServiceDeps) {}

  /** Notified whenever the engine's state moves (a supervised child restarting, failing…). */
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
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
      if ((await this.portableLayout(candidate)) || (await this.deps.fileExists(join(candidate, "main.py")))) {
        found.push({ location: candidate, version: null });
      }
    }
    return found;
  }

  // ---- probing (§2.6 D14) --------------------------------------------------

  private async systemStats(base: string): Promise<{ reachable: boolean; version: string | null }> {
    try {
      const res = await this.deps.fetch(`${base.replace(/\/+$/, "")}/system_stats`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return { reachable: false, version: null };
      const body = (await res.json().catch(() => null)) as { system?: { comfyui_version?: unknown } } | null;
      const version = body?.system?.comfyui_version;
      return { reachable: true, version: typeof version === "string" ? version : null };
    } catch {
      return { reachable: false, version: null };
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
    const layout = await this.portableLayout(root);
    if (layout === null) return; // resolve() already recorded the problem
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
      args.push("--extra-model-paths-config", yamlPath);
    }
    const supervisor = this.deps.createSupervisor({
      id: "comfyui",
      command: layout.python,
      args,
      healthPath: "/system_stats",
      readyTimeoutMs: 120_000, // a cold engine imports torch; a minute is not a hang
      probeIntervalMs: 1_000,
      validateHealth: async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { system?: { comfyui_version?: unknown } }
          | null;
        const version = body?.system?.comfyui_version;
        if (typeof version !== "string") {
          return { ok: false, reason: `the engine did not report a ComfyUI version — Arke supports ${VERSION_FLOOR} and later` };
        }
        if (meetsFloor(version) !== true) {
          return { ok: false, reason: `ComfyUI ${version} is older than the ${VERSION_FLOOR} floor Arke supports` };
        }
        this.probed = { version, reachable: true, detail: null };
        return { ok: true };
      },
    });
    supervisor.on("status", () => {
      if (!this.disposed) void this.publish();
    });
    this.supervisor = supervisor;
    // Fire and observe, never await: start() resolves only after the health probe settles, and
    // a cold engine imports torch for a minute or two. Settings answers now with "starting",
    // and the status subscription publishes every transition as it happens (R-6).
    void supervisor.start().catch(() => {});
  }

  private async stopSupervision(): Promise<void> {
    const supervisor = this.supervisor;
    this.supervisor = null;
    if (supervisor) await supervisor.stop().catch(() => {});
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
    const next = this.settingsWork.then(
      () => this.applySettingsOnce(settings),
      () => this.applySettingsOnce(settings),
    );
    this.settingsWork = next.catch(() => {});
    return next;
  }

  private settingsWork: Promise<void> = Promise.resolve();

  private async applySettingsOnce(settings: ComfyUiSettings): Promise<void> {
    this.settings = settings;
    await this.stopSupervision();
    this.nodeClasses = null;
    this.verification.clear();
    this.probed = { version: null, reachable: false, detail: null };
    this.resolved = await this.resolve();
    this.detected = this.resolved.source === "absent" ? await this.detectExisting() : [];
    if ((this.resolved.source === "user-path" || this.resolved.source === "managed") && this.resolved.problem === null) {
      await this.startSupervision(this.resolved.root!);
    }
    if (this.resolved.source === "user-url") {
      const stats = await this.systemStats(this.resolved.url!);
      this.probed = {
        version: stats.version,
        reachable: stats.reachable,
        detail: stats.reachable ? null : "the engine did not answer",
      };
    }
    await this.publish();
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
    return { source: this.resolved.source, instanceId: id };
  }

  /** The models folder every path resolves against (§2.4) — one resolver, everywhere. */
  modelsDir(): string | null {
    if (this.settings.modelsDir !== null) return this.settings.modelsDir;
    const root = this.resolved.root;
    if (root === null) return null; // a URL engine has no folder unless the user maps one (D13)
    return join(root, "ComfyUI", "models");
  }

  /** Whether an engine exists without the managed install — the setup entry's detection-first check (D10). */
  async externallyPresent(): Promise<boolean> {
    if (this.settings.engineUrl !== null || this.settings.enginePath !== null) return true;
    return (await this.detectExisting()).length > 0;
  }

  engineStatus(): ComfyUiEngineStatus {
    const { source, root, url, problem } = this.resolved;
    const location =
      source === "user-url" ? url : source === "user-path" ? root : source === "managed" ? this.managedLocation() : null;
    let state: ComfyUiEngineStatus["state"];
    let detail: string | null = null;
    if (source === "absent") {
      state = "absent";
    } else if (problem !== null) {
      state = "failed";
      detail = problem;
    } else if (source === "user-url") {
      state = this.probed.reachable ? (this.floorOk() ? "ready" : "incompatible") : "unreachable";
      detail = this.probed.reachable ? (this.floorOk() ? null : this.floorDetail()) : (this.probed.detail ?? "the engine did not answer");
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
  async preflight(recipeId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const recipe = this.deps.recipes.find((r) => r.id === recipeId);
    if (!recipe) return { ok: false, reason: `"${recipeId}" is not a shipped recipe` };
    const dir = this.modelsDir();
    if (dir === null) {
      const verdict = {
        ok: false as const,
        reason: "Arke cannot verify this engine's files — map its models folder in Settings to enable local recipes",
      };
      this.verification.set(recipeId, verdict);
      return verdict;
    }
    for (const checkpoint of recipe.checkpoints) {
      const path = join(dir, checkpoint.file);
      if (!(await this.deps.fileExists(path))) {
        const verdict = { ok: false as const, reason: `${checkpoint.file} is missing from the models folder` };
        this.verification.set(recipeId, verdict);
        return verdict;
      }
      const found = await this.deps.hashFile(path);
      if (found === null) {
        const verdict = { ok: false as const, reason: `${checkpoint.file} could not be read for verification` };
        this.verification.set(recipeId, verdict);
        return verdict;
      }
      if (found.toLowerCase() !== checkpoint.sha256.toLowerCase()) {
        const verdict = {
          ok: false as const,
          reason:
            `${checkpoint.file} does not match its pinned version — ` +
            `expected sha256 ${checkpoint.sha256.slice(0, 8)}…, found sha256 ${found.slice(0, 8)}…`,
        };
        this.verification.set(recipeId, verdict);
        return verdict;
      }
    }
    const engineRoot = this.resolved.root;
    for (const node of recipe.customNodes) {
      if (engineRoot === null) {
        const verdict = {
          ok: false as const,
          reason: `custom node ${node.id} cannot be verified on a URL engine (SPEC-021 D13)`,
        };
        this.verification.set(recipeId, verdict);
        return verdict;
      }
      const nodeDir = join(engineRoot, "ComfyUI", "custom_nodes", node.id);
      if (!(await this.deps.fileExists(nodeDir))) {
        const verdict = { ok: false as const, reason: `custom node ${node.id} is missing from the engine` };
        this.verification.set(recipeId, verdict);
        return verdict;
      }
      const ref = (await this.deps.readNodeRef?.(nodeDir)) ?? null;
      if (ref !== null && ref !== node.pinnedRef) {
        const verdict = {
          ok: false as const,
          reason: `custom node ${node.id} is at ${ref.slice(0, 10)}, not the pinned ${node.pinnedRef.slice(0, 10)}`,
        };
        this.verification.set(recipeId, verdict);
        return verdict;
      }
    }
    this.verification.set(recipeId, { ok: true });
    return { ok: true };
  }

  // ---- readiness (§2.12) ---------------------------------------------------

  /** The one combined result. `probes` may be null when hardware was never measured. */
  async status(probes: RuntimeProbes | null): Promise<ComfyUiStatus> {
    const engine = this.engineStatus();
    const base = this.baseUrl();
    if (engine.state === "ready" && base !== null && this.nodeClasses === null) {
      this.nodeClasses = await this.loadNodeClasses(base);
    }
    const recipes: RecipeReadiness[] = [];
    for (const recipe of this.deps.recipes) {
      recipes.push(await this.recipeReadiness(recipe, engine, probes));
    }
    return { engine, recipes, checkedAt: (this.deps.clock ?? (() => new Date().toISOString()))() };
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
    const disabled = (reason: string, cloudAlternative?: string): RecipeReadiness => ({
      ...base,
      state: "disabled",
      reason,
      ...(cloudAlternative !== undefined ? { cloudAlternative } : {}),
    });

    // 1 · The engine itself.
    if (engine.state === "absent") return disabled("no ComfyUI engine is configured or installed");
    if (engine.state === "unreachable") return disabled("the engine did not answer");
    if (engine.state === "incompatible") return disabled(engine.detail ?? "the engine is incompatible");
    if (engine.state === "failed") return disabled(engine.detail ?? "the engine did not start");
    if (engine.state === "starting") return disabled("the engine is starting");

    // 2 · A URL engine's files are unverifiable without the explicit mapping (D13).
    if (engine.source === "user-url" && this.modelsDir() === null) {
      return disabled("Arke cannot verify this engine's files — map its models folder to enable");
    }

    // 3 · The compatibility probe, per recipe (D14): a missing node names itself.
    if (this.nodeClasses !== null) {
      const missing = recipe.nodeClasses.filter((cls) => !this.nodeClasses!.has(cls));
      if (missing.length > 0) {
        return disabled(`this engine has no ${missing[0]} node — ComfyUI ${VERSION_FLOOR} or later is required`);
      }
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
        return disabled(`${missing} of ${total} model file${total === 1 ? "" : "s"} missing from the models folder`);
      }
    }

    // 5 · A pin mismatch found at pre-flight disables until re-verified (§2.5).
    const verified = this.verification.get(recipe.id);
    if (verified !== undefined && !verified.ok) return disabled(verified.reason ?? "verification failed");

    // 6 · Hardware (§2.7): both figures when measured; unknown stays unknown and dispatches (D15).
    const vram = probes?.vramMb ?? null;
    if (vram === null) {
      return {
        ...base,
        state: "unknown",
        reason: `VRAM could not be measured. The ${gb(recipe.minVramMb)} floor was not checked.`,
      };
    }
    if (vram < recipe.minVramMb) {
      return disabled(
        `Needs ${gb(recipe.minVramMb)} VRAM. This machine has ${gb(vram)}. Cloud ${recipe.capability} still works.`,
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
    this.deps.onStatus?.(this.engineStatus());
    for (const listener of this.subscribers) {
      try {
        listener();
      } catch {
        /* a broken listener must not take the engine service down */
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopSupervision();
  }
}

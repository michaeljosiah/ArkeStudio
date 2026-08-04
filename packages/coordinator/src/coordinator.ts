import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  DomainEventSchema,
  JobSchema,
  LedgerEntrySchema,
  type ClientMessage,
  type ClientState,
  type DomainEvent,
  type HarnessAdapter,
  type HealthComponent,
  buildExportPlan,
  CutFileSchema,
  deriveCut,
  gateLocalRuntimes,
  planScene,
  previewLineFor,
  SceneSchema,
  type Job,
  type LedgerEntry,
  type ModelManifest,
  type ProviderId,
  type QueueCommand,
  type RuntimeProbes,
  type VoiceCandidate,
} from "@arke-studio/contracts";
import { AppLog } from "./app-log.js";
import { AppSettingsFile, routingFaults } from "./app-settings.js";
import { AskService } from "./canon/ask.js";
import { CredentialStore, type Cipher } from "./credentials/store.js";
import { buildDiagnosticsBundle } from "./diagnostics.js";
import {
  compileBoard,
  composeDispatches,
  createChapter,
  createProduction,
  draftSceneSkeleton,
  exportBoard,
  landBoard,
  reorderChapters,
  saveChapter,
  setPromptOverride,
} from "./productions/ops.js";
import { ProviderService, type KeyValidator } from "./providers/service.js";
import { JobQueue, type DispatchClient, type EnqueueInput } from "./queue/dispatcher.js";
import { enqueueInputs } from "./queue/acknowledge.js";
import {
  extractText,
  resolveCandidate,
  storeBatch,
  verifyCandidates,
  type RawCandidate,
} from "./artifacts/extraction.js";
import { ATTACHABLE_EXTENSIONS, fileArtifact, importFolder } from "./artifacts/filing.js";
import { attachToSandbox, sandboxAttachments } from "./artifacts/genesis-attachments.js";
import { makeAdapterExtractor } from "./artifacts/model.js";
import { recordTakesFromJob } from "./takes/arrival.js";
import { exportWorld, runExport, type ExportHandle, type FfmpegRunner } from "./takes/export.js";
import { acceptTake, rejectTake, saveAudioTracks } from "./takes/review.js";
import { previewCacheFile, VoiceService, type CloudVoiceSource, type SidecarLike } from "./voice/service.js";
import { checkPathBudget, fromPortable, toExtendedLength } from "./world/paths.js";
import { readContainedImageReferences } from "./world/reference-files.js";
import {
  characterLookRequests,
  characterSheetRequest,
  establishRequests,
  imageModelFor,
  mainPhotoRequests,
  missingTileAngles,
  tileRequest,
} from "./references/generate.js";
import { makeArtDirector, worldBrief } from "./references/art-director.js";
import {
  WORLD_IMAGE_CANDIDATE,
  WORLD_IMAGE_DIR,
  WORLD_IMAGE_FILE,
  worldImageRequest,
} from "./references/world-image.js";
import {
  acceptCharacterLook,
  acceptCharacterSheet,
  attachCharacterLook,
  compileGrid,
  designate,
  landGrid,
  lockTile,
  readKit,
  promoteCharacterLook,
  setStyleOverride,
  supersedeTile,
} from "./references/kit.js";
import {
  pendingReferenceTake,
  recordReferenceReview,
  recordReferenceTake,
  referenceReviewDecision,
} from "./references/takes.js";
import {
  acceptMainPhoto,
  mainPhotoFailureReason,
  mainPhotoLogRecord,
  type MainPhotoAcceptanceStage,
} from "./references/main-photo.js";
import { SecretRegistry } from "./redact.js";
import { detectDrift, evaluateSpend } from "./spend/analytics.js";
import { LedgerFile } from "./spend/ledger.js";
import {
  openThread,
  stageCanonAmendment,
  stageCanonEntry,
  stageThreadSettlement,
} from "./canon/authoring.js";
import { ChangeLog } from "./change-log.js";
import { AuthoringService, settlePermission } from "./harness/authoring.js";
import { GenesisService } from "./harness/genesis.js";
import { LocalSetupService, type SetupDeps } from "./setup/local-setup.js";
import { GrantStore } from "./harness/grants.js";
import { WorldQueryServer } from "./harness/world-query.js";
import { refsForCanon, refsForSheet, ripplesForCanonEntry, searchCanon } from "./index-db/queries.js";
import {
  createSheetFromSentence,
  duplicateSheet,
  stageSheetRename,
  stageSheetStatus,
  stageVoiceAssignment,
} from "./sheets/authoring.js";
import { ReadModel } from "./read-model.js";
import { ChildSupervisor, type SupervisorStatus } from "./supervisor.js";
import { Transport } from "./transport.js";
import type { WorldProvider } from "./world-provider.js";
import type { WorldStore } from "./world/store.js";

/**
 * The coordinator: the application's domain layer, embedded in the Electron main process
 * (SPEC-001 D2) — never a separately launched server. Wires the world provider, read model,
 * transport, change log, harness adapter and child supervisors into one lifecycle.
 */

export interface CoordinatorOptions {
  provider: WorldProvider;
  adapter: HarnessAdapter | null;
  changeLogPath: string;
  appVersion: string;
  /** Optional NDJSON seeds so fixtures light the Activity screens (jobs.jsonl / ledger.jsonl). */
  jobsSeedPath?: string;
  ledgerSeedPath?: string;
  /** App root for remembered grants (SPEC-005 R-16). Absent → grants are session-only. */
  appRoot?: string;
  /** Session-config builders from the adapter package, injected to keep dependencies one-way. */
  authoring?: {
    buildConfig: (input: {
      worldQueryUrl?: string;
      agents?: Record<string, { model?: string; brief?: string }>;
    }) => Record<string, unknown>;
    agentForPurpose: (purpose: "authoring" | "drafting" | "extraction" | "ask" | "art-prompt") => string;
    /**
     * The shipped roster, injected like everything else from the adapter package. The
     * coordinator needs it to show what each agent is for and to tell an edited brief from the
     * original — it never needs to know how a prompt is assembled.
     */
    roster?: ReadonlyArray<{ name: string; description: string; brief: string }>;
  };
  /** SPEC-008: credential cipher (Electron safeStorage in the desktop; a fake in tests). */
  cipher?: Cipher;
  /** SPEC-008: per-provider key validators, injected from @arke-studio/providers. */
  validators?: Partial<Record<ProviderId, KeyValidator>>;
  /** SPEC-008: the shipped model manifest. */
  manifest?: ModelManifest;
  /** SPEC-008: local runtime probing, injected so tests measure nothing. */
  probeRuntime?: () => Promise<RuntimeProbes>;
  /**
   * Fetching the local runtimes at setup: Ollama and its default model, the voice models.
   * Absent → nothing is fetched and the app behaves exactly as before.
   */
  setup?: SetupDeps;
  /**
   * Choosing files to attach. The dialog belongs to the host, and so does the path it returns:
   * the renderer asks for an attachment and learns only that artifacts now exist, never where
   * they came from — the preload's promise of "no paths" survives (SPEC-001 R-9).
   * Absent → attaching says so instead of doing nothing.
   */
  pickFiles?: (input: { accept: readonly string[] }) => Promise<readonly string[]>;
  /** SPEC-009: dispatch clients (submit/poll/fetch/cancel + declarations), per provider. */
  dispatchClients?: Record<string, DispatchClient>;
  /** SPEC-013 R-19: the local encoder for exports; absent → exports state the reason. */
  ffmpeg?: FfmpegRunner;
  /** SPEC-015: the extraction model seam; every candidate is re-verified regardless (R-13). */
  extractor?: (text: string, artifactFile: string, signal?: AbortSignal) => Promise<RawCandidate[]>;
  /** SPEC-016: update seam — check and download only; installation happens at exit (R-13). */
  updates?: { check: () => Promise<{ version: string } | null>; download: () => Promise<void> };
  /** SPEC-016 R-17: open a path in the platform file manager, injected from the desktop. */
  openPath?: (path: string) => void;
  /** SPEC-016 R-2: whether the native index binding loaded, known only to the desktop shell. */
  nativeIndex?: { ok: boolean; reason?: string };
  /** SPEC-011: the Voxa sidecar and voice catalogue sources, injected from the desktop. */
  voice?: {
    sidecar: SidecarLike | null;
    /** Poll the sidecar's degradation state; null health = not started. */
    sidecarHealth?: () => Promise<{
      state: "not-started" | "downloading" | "unavailable" | "ready";
      detail: string;
    }>;
    localPresets: VoiceCandidate[];
    cloudSources: CloudVoiceSource[];
  };
}

const SUPERVISOR_HEALTH: Record<
  SupervisorStatus,
  { status: "starting" | "healthy" | "unhealthy" | "unavailable" }
> = {
  unconfigured: { status: "unavailable" },
  starting: { status: "starting" },
  healthy: { status: "healthy" },
  unhealthy: { status: "unhealthy" },
  stopped: { status: "unavailable" },
  failed: { status: "unavailable" },
};

export class Coordinator {
  private readonly readModel: ReadModel;
  private readonly transport: Transport;
  private readonly changeLog: ChangeLog;
  private readonly supervisors = new Map<HealthComponent, ChildSupervisor>();
  private readonly worldQuery: WorldQueryServer;
  private readonly grants: GrantStore | null;
  private readonly authoring: AuthoringService | null;
  private readonly genesis: GenesisService | null;
  private readonly setup: LocalSetupService | null;
  /** actionClass per pending permission id, for remember-on-always (R-16). */
  private readonly pendingPermissions = new Map<string, string>();
  /** Genesis sandboxes whose attachments are still being carried into a new world. */
  private readonly carrying = new Map<string, Promise<void>>();
  /** Documents being read for facts right now, so the reading can be stopped (SPEC-015 §2). */
  private readonly reading = new Map<string, AbortController>();
  /** Session config builder with the user's agent settings folded in. */
  private readonly buildConfig: ((input: { worldQueryUrl?: string }) => Record<string, unknown>) | undefined;
  /** Per-agent model and brief overrides, as last read from settings. */
  private agentOverrides: Record<string, { model?: string; brief?: string }> | undefined;
  private started = false;
  /** SPEC-008: redaction registry, credential store, provider statuses, ledger, settings. */
  private readonly secrets = new SecretRegistry();
  private readonly appLog: AppLog | null;
  private readonly credentials: CredentialStore | null;
  private readonly providerService: ProviderService;
  private readonly ledger: LedgerFile | null;
  private readonly appSettings: AppSettingsFile | null;
  /** SPEC-009: the dispatch engine. Null without an app root, clients and a ledger. */
  private readonly jobQueue: JobQueue | null;
  /** SPEC-011: catalogue, matching, previews and dictation. Null without voice wiring. */
  private readonly voiceService: VoiceService | null;
  /** SPEC-013: exports in flight, cancellable by id (R-21). */
  private readonly exports = new Map<string, ExportHandle>();

  constructor(private readonly opts: CoordinatorOptions) {
    this.readModel = new ReadModel(opts.appVersion);
    this.changeLog = new ChangeLog(opts.changeLogPath);
    this.appLog = opts.appRoot ? new AppLog(join(opts.appRoot, "logs", "app.jsonl"), this.secrets) : null;
    this.credentials =
      opts.appRoot && opts.cipher
        ? new CredentialStore(join(opts.appRoot, "credentials.dat"), opts.cipher, this.secrets)
        : null;
    this.providerService = new ProviderService(this.credentials, opts.validators ?? {}, this.appLog);
    this.ledger = opts.appRoot ? new LedgerFile(join(opts.appRoot, "ledger.jsonl")) : null;
    this.appSettings = opts.appRoot ? new AppSettingsFile(join(opts.appRoot, "settings.json")) : null;
    this.jobQueue =
      opts.appRoot && opts.dispatchClients && this.ledger
        ? new JobQueue({
            journalPath: join(opts.appRoot, "queue", "jobs.jsonl"),
            clients: opts.dispatchClients,
            getKey: async (provider) =>
              this.credentials ? this.credentials.get(provider as ProviderId) : null,
            emit: (event) => this.emit(event),
            ledger: {
              has: async (jobId) => (await this.ledger!.readAll()).some((e) => e.jobId === jobId),
              append: (entry) => this.recordLedger(entry),
            },
            landInWorld: async (worldId, fn) => {
              try {
                if (this.opts.provider.withWorldStore) {
                  await this.opts.provider.withWorldStore(worldId, (store) =>
                    store.ownedWrite(() => fn(store.dir)),
                  );
                  return true;
                }
                const store = this.opts.provider.openStore?.();
                if (!store || store.worldId !== worldId) return false;
                await store.ownedWrite(() => fn(store.dir));
                return true;
              } catch {
                return false;
              }
            },
            readImageReferences: async (worldId, paths) => {
              if (this.opts.provider.withWorldStore) {
                return this.opts.provider.withWorldStore(worldId, (store) =>
                  readContainedImageReferences(store.dir, paths),
                );
              }
              const store = this.opts.provider.openStore?.();
              if (!store || store.worldId !== worldId) throw new Error("the owning world is unavailable");
              return readContainedImageReferences(store.dir, paths);
            },
            onProviderFault: (provider, message) => this.reportProviderFault(provider as ProviderId, message),
            onTerminal: (job) => this.onJobTerminal(job),
            onFinalizationFailure: (job) => {
              void this.appLog?.append({
                kind: "job.finalization-failed",
                jobId: job.id,
                worldId: job.worldId,
                targetKind: job.target.kind,
              });
            },
          })
        : null;
    this.voiceService = opts.voice
      ? new VoiceService({
          sidecar: opts.voice.sidecar,
          localPresets: opts.voice.localPresets,
          cloudSources: opts.voice.cloudSources,
          getKey: async (provider) =>
            this.credentials ? this.credentials.get(provider as ProviderId) : null,
          emit: (event) => this.emit(event),
        })
      : null;
    this.transport = new Transport({
      getSnapshot: () => this.getState(),
      onMessage: (msg) => void this.handleClientMessage(msg),
      // GET /media/<world-slug>/<world-relative-file> — read-only renderer media.
      serveFile: async (urlPath) => {
        const match = /^\/media\/([^/]+)\/(.+)$/.exec(urlPath);
        if (!match || !this.opts.provider.serveMedia) return null;
        return this.opts.provider.serveMedia(match[1]!, match[2]!);
      },
    });
    this.worldQuery = new WorldQueryServer(() => this.opts.provider.openStore?.() ?? null);
    // Every session config goes through here, so a per-agent override reaches genesis,
    // authoring, extraction and ask alike — or none of them. Read at build time rather than
    // captured, so changing a model in Settings applies to the next session, not the next run.
    const configure = opts.authoring?.buildConfig;
    this.buildConfig = configure
      ? (input) => configure({ ...input, ...(this.agentOverrides ? { agents: this.agentOverrides } : {}) })
      : undefined;
    this.grants = opts.appRoot ? new GrantStore(opts.appRoot) : null;
    this.authoring =
      opts.adapter && opts.authoring
        ? new AuthoringService(opts.adapter, (event) => this.emit(event), {
            buildConfig: this.buildConfig!,
            agentForPurpose: opts.authoring.agentForPurpose,
          })
        : null;
    this.genesis =
      opts.adapter && opts.authoring
        ? new GenesisService(opts.adapter, (event) => this.emit(event), {
            buildConfig: this.buildConfig!,
          })
        : null;
    this.setup =
      opts.setup && opts.appRoot
        ? new LocalSetupService(
            opts.setup,
            (event) => {
              // The snapshot carries it too: a window that opens mid-download still sees it.
              if (event.type === "setup.status") this.readModel.setSetup(event.setup);
              this.emit(event);
            },
            { appRoot: opts.appRoot },
          )
        : null;
    this.askService = opts.authoring
      ? new AskService(opts.adapter, {
          buildConfig: this.buildConfig!,
          scratchRoot: opts.appRoot ? `${opts.appRoot}/.ask` : `${opts.changeLogPath}.ask`,
        })
      : null;
  }

  private readonly askService: AskService | null;

  getState(): ClientState {
    return this.readModel.getState();
  }

  /** Validate, fold, log, broadcast — the one path every event takes (R-3). */
  emit(event: DomainEvent): void {
    const parsed = DomainEventSchema.parse(event);
    this.readModel.apply(parsed);
    if (parsed.type !== "health.changed") {
      // Health is transient signal, not audit; everything else lands in the log.
      void this.changeLog.append({ kind: "event", event: parsed });
    }
    this.transport.broadcast(parsed);
  }

  /** Attach a supervised child and mirror its lifecycle into component health (R-6). */
  superviseAs(component: Exclude<HealthComponent, "coordinator">, supervisor: ChildSupervisor): void {
    this.supervisors.set(component, supervisor);
    supervisor.on("status", ({ status, reason }: { status: SupervisorStatus; reason?: string }) => {
      // A healthy harness process is probed before it counts (SPEC-005 R-2): the adapter asks
      // /doc what the server can do, and an under-capable one stays unavailable with a reason.
      if (component === "harness" && status === "healthy" && this.opts.adapter?.init) {
        const adapter = this.opts.adapter;
        void adapter.init!()
          .then(() => {
            const readiness = adapter.readiness();
            this.emit({
              at: new Date().toISOString(),
              type: "health.changed",
              component,
              status: readiness.ready ? "healthy" : "unavailable",
              ...(readiness.ready
                ? {}
                : { reason: readiness.reason ?? "the harness is missing a required capability" }),
            });
          })
          .catch((err: unknown) => {
            this.emit({
              at: new Date().toISOString(),
              type: "health.changed",
              component,
              status: "unavailable",
              reason: `capability probe failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        return;
      }
      this.emit({
        at: new Date().toISOString(),
        type: "health.changed",
        component,
        status: SUPERVISOR_HEALTH[status].status,
        ...(reason !== undefined ? { reason } : {}),
      });
    });
  }

  async start(port = 0): Promise<{ port: number }> {
    if (this.started) throw new Error("coordinator already started");
    this.started = true;

    // Out-of-band writes to the open world mark it stale for every client (SPEC-002 R-23).
    this.opts.provider.onWorldStale?.((worldId) => {
      this.emit({ at: new Date().toISOString(), type: "world.stale", worldId });
    });

    await this.seed();
    await this.seedAppConfig();
    // Reconcile every non-terminal job before accepting new work (SPEC-009 R-18). The report
    // reaches clients as an event; the folded jobs seed the read model.
    if (this.jobQueue) {
      await this.jobQueue.start();
      this.readModel.seedJobs(this.jobQueue.listJobs());
    }
    this.readModel.setWorlds(await this.opts.provider.listWorlds());

    const boundPort = await this.transport.start(port);
    this.readModel.setHealth("coordinator", { status: "healthy" });

    // The harness adapter's readiness is reflected once at start; a live adapter's own events
    // refine it later (SPEC-005). With no adapter the reason is stated, not silent (R-6).
    if (this.opts.adapter === null && !this.supervisors.has("harness")) {
      this.readModel.setHealth("harness", { status: "unavailable", reason: "OpenCode is not configured" });
    } else if (this.opts.adapter !== null) {
      const readiness = this.opts.adapter.readiness();
      this.readModel.setHealth(
        "harness",
        readiness.ready
          ? { status: "healthy" }
          : { status: "unavailable", reason: readiness.reason ?? "harness not ready" },
      );
    }
    if (!this.supervisors.has("voice")) {
      this.readModel.setHealth("voice", { status: "unavailable", reason: "Voxa is not configured" });
    }

    // First-run environment verification (SPEC-016 R-2, D4): checked once, before any world
    // could be created somewhere it would break, and stated plainly rather than discovered.
    if (this.opts.appRoot) {
      const budget = checkPathBudget(this.opts.appRoot);
      let diskFreeMb: number | null = null;
      try {
        const { statfs } = await import("node:fs/promises");
        const fs = await statfs(this.opts.appRoot);
        diskFreeMb = Math.floor((fs.bavail * fs.bsize) / (1024 * 1024));
      } catch {
        diskFreeMb = null; // unknown, never presented as a failure
      }
      const envCheck = {
        pathBudgetOk: !budget.tight,
        pathBudgetDetail: budget.tight
          ? `the data folder sits ${budget.rootLength} characters deep — worst-case paths reach ${budget.worstCase}, past the classic Windows limit; move it shallower before creating worlds here`
          : null,
        diskFreeMb,
        nativeIndexOk: this.opts.nativeIndex?.ok ?? true,
        nativeIndexDetail:
          this.opts.nativeIndex?.ok === false
            ? (this.opts.nativeIndex.reason ??
              "the native index binding failed to load — search and counts degrade; authoring is unaffected")
            : null,
      };
      // Both: the snapshot so late-joining clients see it at all (the window loads after
      // start() in a packaged build), and the event so an open client updates live.
      this.readModel.setEnv(envCheck);
      this.emit({ at: new Date().toISOString(), type: "env.check", ...envCheck });
    }

    // Local runtimes arrive in the background (R-5 revised): the app is usable throughout, and
    // every component can be skipped. Detection runs first, so a second launch fetches nothing.
    void this.setup?.run();

    // The sidecar's four degradation states (SPEC-011 §2.10), polled gently; the app is fully
    // usable in every one of them (R-4).
    if (this.opts.voice?.sidecarHealth) {
      const pollSidecar = async (): Promise<void> => {
        try {
          const status = await this.opts.voice!.sidecarHealth!();
          this.emit({ at: new Date().toISOString(), type: "voice.sidecar", ...status });
        } catch {
          /* the supervisor's own health covers a dead process */
        }
      };
      void pollSidecar();
      const timer = setInterval(() => void pollSidecar(), 20_000);
      timer.unref?.();
    }

    for (const supervisor of this.supervisors.values()) {
      void supervisor.start();
    }

    // The permission backstop pump (R-16, R-17): remembered grants answer silently; the rest
    // surface in Studio's language and wait for the user.
    const adapter = this.opts.adapter;
    if (adapter && this.grants) {
      const grants = this.grants;
      void (async () => {
        try {
          for await (const event of adapter.streamEvents()) {
            if (event.type === "permission.requested") {
              this.pendingPermissions.set(event.permissionId, event.actionClass);
              await settlePermission(adapter, grants, (e) => this.emit(e), {
                permissionId: event.permissionId,
                actionClass: event.actionClass,
              });
            }
          }
        } catch {
          /* the pump dies with the adapter; readiness reporting covers it */
        }
      })();
    }

    return { port: boundPort };
  }

  async openWorld(worldId: string): Promise<void> {
    await this.opts.provider.loadWorld(worldId);
    await this.jobQueue?.retryFinalizationsForWorld(worldId);
    const bundle = this.opts.provider.openStore?.()?.getBundle() ?? (await this.opts.provider.loadWorld(worldId));
    this.readModel.setWorld(bundle);
    this.emit({ at: new Date().toISOString(), type: "world.opened", worldId });
    // The bundle itself travels as a fresh snapshot — a world is small enough to re-send (D4).
    this.transport.broadcastSnapshot();
  }

  /** Seed the SPEC-008 app-config slice: manifest, provider statuses, routing, spend, drift. */
  private async seedAppConfig(): Promise<void> {
    await this.providerService.init();
    const manifest = this.opts.manifest ?? null;
    const settings = this.appSettings ? await this.appSettings.load() : null;
    // Read once here so the first session of the run already carries the user's choices —
    // not the second, after something happened to touch settings.
    this.agentOverrides = settings?.agents;
    this.refreshAgents(settings?.agents ?? {});
    const entries = this.ledger ? await this.ledger.readAll() : [];
    this.readModel.seedAppConfig({
      manifest,
      providers: this.providerService.list(),
      ...(settings && manifest
        ? { routing: { defaults: settings.routing, faults: routingFaults(settings, manifest) } }
        : {}),
      ...(settings ? { spend: evaluateSpend(entries, settings.spend, new Date()) } : {}),
      ...(manifest ? { drift: detectDrift(entries, manifest) } : {}),
    });
  }

  /**
   * The diagnostics bundle (SPEC-008 R-6): app state through the redaction boundary — no key
   * material, no world content. Exposed for the About screen and support flows.
   */
  async diagnostics(): Promise<Record<string, unknown>> {
    return buildDiagnosticsBundle(this.getState(), this.appLog, this.secrets);
  }

  /** A credential failed mid-session: a provider fault naming the provider, never a work failure (R-4). */
  reportProviderFault(provider: ProviderId, message: string): void {
    this.providerService.markFault(provider, message);
    this.emit({
      at: new Date().toISOString(),
      type: "provider.status",
      providers: this.providerService.list(),
    });
  }

  /**
   * Terminal-job follow-ons (SPEC-010): a landed reference tile enters its kit as `generated`
   * (unreviewed — locking is the user's act, R-3); the world snapshot refreshes so the kit
   * surface sees it. Establish candidates just land; the client lists them off the job row.
   */
  private async onJobTerminal(job: Job): Promise<void> {
    if (job.status !== "succeeded") return;
    const finalize = async (store: WorldStore) => {
      if (job.target.kind === "reference-tile" && job.landedFiles?.[0] !== undefined) {
        const [sheetId, angle] = (job.target.id ?? "").split("/") as [string, never];
        const sheet = store.getBundle().sheets.find((s) => s.id === sheetId);
        if (!sheet || !angle) return;
        const withinKit = job.landedFiles[0].replace(`references/${sheetId}/`, "");
        await supersedeTile(store, sheetId, angle, { file: withinKit, sheetVersion: sheet.version }).catch(
          () => {},
        );
      }
      if (
        ["main-photo-candidate", "establish-candidate", "character-sheet", "character-look"].includes(
          job.target.kind,
        )
      ) {
        const ledgerEntry = this.ledger
          ? (await this.ledger.readAll()).find((entry) => entry.jobId === job.id)
          : undefined;
        const take = await recordReferenceTake(store, job, ledgerEntry);
        if (!take) throw new Error("reference take finalization produced no take");
      }
      if (
        (job.target.kind === "shot" || job.target.kind === "scene-pass" || job.target.kind === "voice-line") &&
        job.landedFiles?.[0] !== undefined &&
        job.productionId !== undefined
      ) {
        // SPEC-013: the landed media becomes an immutable take (plus segments for a pass).
        const ledgerEntry = this.ledger
          ? (await this.ledger.readAll()).find((e) => e.jobId === job.id)
          : undefined;
        const takes = await recordTakesFromJob(store, job, ledgerEntry?.actualMicroUsd ?? null).catch(() => []);
        for (const take of takes) {
          this.emit({
            at: new Date().toISOString(),
            type: "take.recorded",
            worldId: job.worldId,
            productionId: job.productionId,
            take,
          });
        }
      }
      if (job.target.kind === "voice-preview" && job.landedFiles?.[0] !== undefined) {
        // The audition is ready; the landed file IS the cache entry (R-10).
        const [sheetId, provider, voiceId] = (job.target.id ?? "").split("/");
        if (sheetId && provider && voiceId) {
          this.emit({
            at: new Date().toISOString(),
            type: "voice.preview",
            worldId: job.worldId,
            sheetId,
            provider,
            voiceId,
            file: job.landedFiles[0],
            error: null,
          });
        }
      }
    };
    if (this.opts.provider.withWorldStore) {
      await this.opts.provider.withWorldStore(job.worldId, finalize);
    } else {
      const store = this.opts.provider.openStore?.();
      if (!store || store.worldId !== job.worldId) return;
      await finalize(store);
    }
    if (this.opts.provider.openStore?.()?.worldId === job.worldId) {
      await this.refreshWorldSnapshot(job.worldId).catch(() => {});
    }
  }

  /**
   * Enqueue a fully-formed dispatch (SPEC-009 §1.2): callers hand over model, params and
   * estimate; the queue owns durability, reconciliation and the ledger. SPEC-012/013 compose
   * the requests; nothing renderer-side may enqueue arbitrary spend.
   */
  async enqueueJob(input: EnqueueInput): Promise<Job> {
    if (!this.jobQueue) throw new Error("dispatch is not configured (no app root or provider clients)");
    return this.jobQueue.enqueue(input);
  }

  private emitEnqueueResult(
    requestId: string,
    command: QueueCommand,
    requestedCount: number,
    acceptedJobIds: Job["id"][],
    failures: Array<{ index: number; reason: string }>,
    notQueued = false,
  ): void {
    const disposition = notQueued
      ? "not-queued"
      : acceptedJobIds.length === 0
        ? "rejected"
        : failures.length > 0
          ? "partial"
          : "accepted";
    this.emit({
      at: new Date().toISOString(),
      type: "queue.enqueue-result",
      requestId,
      command,
      disposition,
      requestedCount,
      acceptedJobIds,
      failures,
    });
  }

  private rejectEnqueue(requestId: string, command: QueueCommand, reason: string): void {
    this.emitEnqueueResult(requestId, command, 1, [], [{ index: 0, reason }]);
  }

  private async enqueueBatch(
    requestId: string,
    command: QueueCommand,
    inputs: readonly EnqueueInput[],
  ): Promise<void> {
    if (!this.jobQueue) {
      this.rejectEnqueue(
        requestId,
        command,
        "The job queue is unavailable. Try again after restarting the studio.",
      );
      return;
    }
    if (inputs.length === 0) {
      this.emitEnqueueResult(requestId, command, 0, [], [], true);
      return;
    }
    const outcome = await enqueueInputs(inputs, (input) => this.jobQueue!.enqueue(input));
    this.emitEnqueueResult(
      requestId,
      command,
      outcome.requestedCount,
      outcome.acceptedJobIds,
      outcome.failures,
    );
  }

  /**
   * Record a terminal job outcome (SPEC-008 R-16): append to the ledger, mirror to the app
   * index via the event fold, re-evaluate the rolling threshold (R-19) and drift (R-13).
   * SPEC-009's dispatcher calls this; fixtures and tests call it directly.
   */
  async recordLedger(entry: LedgerEntry): Promise<void> {
    if (this.ledger) await this.ledger.append(entry);
    this.emit({ at: new Date().toISOString(), type: "ledger.appended", entry });
    const settings = this.appSettings ? await this.appSettings.load() : null;
    if (!settings) return;
    const entries = this.ledger ? await this.ledger.readAll() : this.getState().app.ledger;
    const spend = evaluateSpend(entries, settings.spend, new Date());
    const wasAlerted = this.getState().app.spend?.alerted ?? false;
    this.emit({ at: new Date().toISOString(), type: "spend.status", spend });
    if (spend.alerted && !wasAlerted) {
      void this.appLog?.append({
        kind: "spend.alert",
        rollingMicroUsd: spend.rollingMicroUsd,
        settings: settings.spend,
      });
    }
    if (this.opts.manifest) {
      const drift = detectDrift(entries, this.opts.manifest);
      if (JSON.stringify(drift) !== JSON.stringify(this.getState().app.drift)) {
        this.emit({ at: new Date().toISOString(), type: "manifest.drift", reports: drift });
      }
    }
  }

  private async handleClientMessage(msg: ClientMessage): Promise<void> {
    switch (msg.kind) {
      case "hello":
        return; // handled inside the transport
      case "open-world":
        try {
          await this.openWorld(msg.worldId);
        } catch {
          // An unknown world id is a stale client; the next snapshot corrects it.
        }
        return;
      case "create-world": {
        const create = this.opts.provider.createWorld?.bind(this.opts.provider);
        if (!create) return;
        try {
          const { worldId } = await create({
            name: msg.name,
            ...(msg.logline !== undefined ? { logline: msg.logline } : {}),
            ...(msg.tone !== undefined ? { tone: msg.tone } : {}),
            ...(msg.genre !== undefined ? { genre: msg.genre } : {}),
          });
          this.readModel.setWorlds(await this.opts.provider.listWorlds());
          await this.openWorld(worldId);
          // After the world is open, so filing has a store to commit into. Whatever was handed
          // to the conversation is now an artifact like any other.
          const genesisId = msg.genesisId;
          if (genesisId !== undefined) {
            // Held so a discard cannot delete the sandbox out from under the copy. The screen
            // discards as soon as the world opens, which is while this is still running.
            const carry = this.carryGenesisAttachments(genesisId, worldId);
            this.carrying.set(genesisId, carry);
            await carry.finally(() => this.carrying.delete(genesisId));
          }
        } catch {
          this.transport.broadcastSnapshot(); // surface whatever state we do have
        }
        return;
      }
      case "archive-world": {
        // Anything not in this set is still going somewhere, so the world stays put.
        const TERMINAL_JOB_STATUS = new Set(["succeeded", "failed", "cancelled"]);
        const archive = this.opts.provider.archiveWorld?.bind(this.opts.provider);
        if (!archive) return;
        const summary = this.readModel.getState().worlds.find((w) => w.worldId === msg.worldId);
        const refuse = (reason: string) =>
          this.emit({
            at: new Date().toISOString(),
            type: "world.archive-refused",
            worldId: msg.worldId,
            reason,
          });
        // Work in flight keeps its world. Moving the folder under a running job turns a job
        // that would have finished into one that fails writing its result somewhere gone.
        const inFlight = this.readModel
          .getState()
          .app.jobs.filter((j) => j.worldId === msg.worldId && !TERMINAL_JOB_STATUS.has(j.status));
        if (inFlight.length > 0) {
          refuse(
            `${inFlight.length} job${inFlight.length === 1 ? " is" : "s are"} still running for this world — let them finish or cancel them first`,
          );
          return;
        }
        try {
          const { folder } = await archive(msg.worldId);
          if (this.readModel.getState().world?.meta.worldId === msg.worldId) this.readModel.setWorld(null);
          this.readModel.setWorlds(await this.opts.provider.listWorlds());
          this.emit({
            at: new Date().toISOString(),
            type: "world.archived",
            worldId: msg.worldId,
            name: summary?.name ?? "that world",
            folder: basename(folder),
          });
        } catch (err) {
          refuse(err instanceof Error ? err.message : String(err));
        }
        this.transport.broadcastSnapshot();
        return;
      }
      case "reload-world": {
        const reload = this.opts.provider.reloadWorld?.bind(this.opts.provider);
        if (!reload) return;
        try {
          this.readModel.setWorld(await reload(msg.worldId));
          this.readModel.setWorlds(await this.opts.provider.listWorlds());
        } catch {
          /* the next snapshot carries the honest state */
        }
        this.transport.broadcastSnapshot();
        return;
      }
      case "reconcile-external-edit": {
        const reconcile = this.opts.provider.reconcileExternalEdit?.bind(this.opts.provider);
        if (!reconcile) return;
        try {
          this.readModel.setWorld(await reconcile(msg.worldId, msg.path));
        } catch {
          /* refusal shows up as the edit still listed */
        }
        this.transport.broadcastSnapshot();
        return;
      }
      case "stage-sheet-edit": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        try {
          const proposal = await gate.stageSheetEdit(msg.path, msg.summary, msg.sections, "form");
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: proposal.id,
          });
        } catch {
          /* the snapshot below carries whatever state resulted */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "stage-art-direction-change": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        try {
          const proposal = await gate.stageArtDirectionChange(msg.description, msg.masterLook);
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: proposal.id,
          });
        } catch {
          /* the refreshed snapshot is authoritative */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-accept": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        try {
          const outcome = await gate.accept(
            msg.proposalId,
            msg.confirmRipples === undefined ? {} : { confirmRipples: msg.confirmRipples },
          );
          const at = new Date().toISOString();
          if (outcome.status === "accepted") {
            this.authoring?.release(msg.proposalId);
            this.emit({
              at,
              type: "proposal.resolved",
              worldId: msg.worldId,
              proposalId: msg.proposalId,
              outcome: "accepted",
            });
          } else {
            this.emit({
              at,
              type: "proposal.blocked",
              worldId: msg.worldId,
              proposalId: msg.proposalId,
              reason:
                outcome.status === "needs-reconfirm"
                  ? "needs-reconfirm"
                  : outcome.status === "no-op"
                    ? "no-op"
                    : outcome.status === "stale"
                      ? "stale"
                      : outcome.status === "pending-review"
                        ? "pending-review"
                        : outcome.status === "unresolved-conflicts"
                          ? "unresolved-conflicts"
                          : "target-retired",
              detail:
                outcome.status === "stale"
                  ? `moved since drafting: ${outcome.stalePaths.join(", ")}`
                  : outcome.status === "no-op"
                    ? "the proposal is identical to the live world — nothing to commit"
                    : outcome.status === "unresolved-conflicts"
                      ? `${outcome.count} conflicted field${outcome.count === 1 ? "" : "s"} await a choice`
                      : outcome.status === "target-retired"
                        ? `retired: ${outcome.paths.join(", ")}`
                        : undefined,
              ...(outcome.status === "needs-reconfirm" ? { authoritativeSignature: outcome.signature } : {}),
            });
          }
        } catch {
          /* surfaced only through the refreshed snapshot */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-discard": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        try {
          await gate.discard(msg.proposalId);
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.resolved",
            worldId: msg.worldId,
            proposalId: msg.proposalId,
            outcome: "discarded",
          });
          this.authoring?.release(msg.proposalId);
        } catch {
          /* snapshot below */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-rebase": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        await gate.rebase(msg.proposalId).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-resolve-conflict": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        await gate.resolveConflict(msg.proposalId, msg.path, msg.field, msg.choice).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-mark-seen": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        await gate.markSeen(msg.proposalId).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "draft-with-studio": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store || !this.authoring) return;
        try {
          // A proposalId continues that proposal's conversation — same session, same agent
          // context; without one, a fresh proposal is staged and the conversation begins.
          let proposalId = msg.proposalId ?? null;
          if (proposalId === null) {
            const proposal = await gate.stage({
              kind: "sheet-edit",
              summary: msg.summary,
              source: "chat:studio",
              targets: [{ path: msg.path }],
            });
            proposalId = proposal.id;
            this.emit({
              at: new Date().toISOString(),
              type: "proposal.staged",
              worldId: msg.worldId,
              proposalId: proposal.id,
            });
            await this.refreshWorldSnapshot(msg.worldId);
          }
          const worldQueryUrl = await this.worldQuery.start();
          // Fire and watch: progress and the final status arrive as events (R-13).
          void this.authoring
            .run(
              store,
              gate,
              {
                worldId: msg.worldId,
                proposalId,
                purpose: "authoring",
                instruction: msg.instruction,
              },
              worldQueryUrl,
            )
            .then(() => this.refreshWorldSnapshot(msg.worldId));
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "genesis-chat": {
        const failed = (detail: string) =>
          this.emit({
            at: new Date().toISOString(),
            type: "genesis.status",
            genesisId: msg.genesisId,
            status: "failed",
            detail,
          });
        if (!this.genesis || !this.opts.provider.genesisDir) {
          failed("authoring is not configured");
          return;
        }
        try {
          const dir = await this.opts.provider.genesisDir(msg.genesisId);
          // Fire and watch: turns, the draft and the final status arrive as events.
          void this.genesis.run(dir, msg.genesisId, msg.text);
        } catch (err) {
          failed(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      case "setup-skip": {
        this.setup?.skip(msg.componentId);
        return;
      }
      case "setup-retry": {
        this.setup?.retry(msg.componentId);
        return;
      }
      case "setup-cancel": {
        this.setup?.cancel();
        return;
      }
      case "genesis-discard": {
        this.genesis?.release(msg.genesisId);
        // Anything still being carried into the new world finishes first — otherwise Begin
        // races the sweep and the files handed over are the ones that vanish.
        await this.carrying.get(msg.genesisId)?.catch(() => {});
        await this.opts.provider.discardGenesis?.(msg.genesisId)?.catch(() => {});
        return;
      }
      case "authoring-cancel": {
        await this.authoring?.cancel(msg.proposalId);
        return;
      }
      case "canon-ask": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        // Fire and watch: the result arrives as one canon.answer event, refusals included.
        void (async () => {
          const worldQueryUrl =
            this.askService && this.opts.adapter ? await this.worldQuery.start() : undefined;
          const fallback: import("@arke-studio/contracts").AskResult = {
            outcome: "unavailable",
            reason: "authoring is not configured",
            searched: 0,
            closest: [],
          };
          const result = this.askService
            ? await this.askService.ask(store, msg.question, worldQueryUrl)
            : fallback;
          this.emit({
            at: new Date().toISOString(),
            type: "canon.answer",
            worldId: msg.worldId,
            askId: msg.askId,
            result,
          });
        })();
        return;
      }
      case "canon-search": {
        const index = this.opts.provider.openStore?.()?.getIndex();
        if (!index) return;
        const result = searchCanon(index.db, msg.query, { limit: 12 });
        this.emit({
          at: new Date().toISOString(),
          type: "canon.search",
          worldId: msg.worldId,
          searchId: msg.searchId,
          searched: result.searched,
          floorCleared: result.floorCleared,
          candidates: result.candidates.map((c) => ({ entryId: c.entryId, title: c.title, score: c.score })),
        });
        return;
      }
      case "canon-refs": {
        const store = this.opts.provider.openStore?.();
        const index = store?.getIndex();
        if (!store || !index) return;
        const entry = store.getBundle().canon.find((c) => c.id === msg.entryId);
        const refs = refsForCanon(index.db, msg.entryId);
        const ripples = entry
          ? ripplesForCanonEntry(index.db, { entryId: entry.id, title: entry.title, statement: entry.body })
          : [];
        this.emit({
          at: new Date().toISOString(),
          type: "canon.refs",
          worldId: msg.worldId,
          entryId: msg.entryId,
          citedBy: { sheets: refs.sheets, entries: refs.entries, productions: refs.productions },
          ripples: ripples.map((r) => ({ kind: r.kind, summary: r.summary, targets: r.targets })),
        });
        return;
      }
      case "stage-canon-entry": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        try {
          const proposal = await stageCanonEntry(store, gate, {
            entryType: msg.entryType,
            title: msg.title,
            statement: msg.statement,
          });
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: proposal.id,
          });
        } catch {
          /* the refreshed snapshot carries whatever resulted */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "stage-canon-amendment": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await stageCanonAmendment(store, gate, { entryId: msg.entryId, statement: msg.statement }).catch(
          () => {},
        );
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "open-thread": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await openThread(store, gate, {
          title: msg.title,
          question: msg.question,
          candidates: msg.candidates,
        }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "settle-thread": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await stageThreadSettlement(store, gate, {
          entryId: msg.entryId,
          resolvedType: msg.resolvedType,
          statement: msg.statement,
        }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "retire-entity": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await store.retire(msg.path, "form").catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "create-sheet-from-sentence": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        try {
          const draft = await createSheetFromSentence(store, gate, {
            sheetType: msg.sheetType,
            name: msg.name,
            sentence: msg.sentence,
          });
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: draft.proposal.id,
          });
          await this.refreshWorldSnapshot(msg.worldId);
          // Settling a sketch nobody asked to review. Beginning a world stages one of these per
          // character and per place, and every one arrived in Needs you wanting a decision that
          // had already been made by pressing Begin. A refusal here is not fatal: the proposal
          // stays staged and the author can settle it themselves.
          const settle = async () => {
            if (msg.settle !== true) return;
            const outcome = await gate.accept(draft.proposal.id).catch(() => null);
            if (outcome === null || outcome.status !== "accepted") {
              void this.appLog?.append({
                kind: "sheet.settle-refused",
                proposalId: draft.proposal.id,
                status: outcome?.status ?? "threw",
              });
            }
            await this.refreshWorldSnapshot(msg.worldId);
          };
          // When the harness is up, the sheet-editor drafts the full sketch inside the
          // proposal; without it, the skeleton with the author's sentence still stands.
          if (this.authoring && this.opts.adapter?.readiness().ready) {
            const worldQueryUrl = await this.worldQuery.start();
            void this.authoring
              .run(
                store,
                gate,
                {
                  worldId: msg.worldId,
                  proposalId: draft.proposal.id,
                  purpose: "authoring",
                  instruction: `${draft.scope}\n\nDraft the full ${msg.sheetType} sheet in ${draft.path} from this seed: "${msg.sentence}". Fill every section the file already has headings for; keep the name "${msg.name}"; leave canonRules and links as they are.`,
                },
                worldQueryUrl,
              )
              // Settled after the draft lands, so what is settled is the written sheet and not
              // the empty skeleton it started as.
              .then(() => settle())
              .then(() => this.refreshWorldSnapshot(msg.worldId));
          } else {
            await settle();
          }
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "duplicate-sheet": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await duplicateSheet(store, gate, { path: msg.path, newName: msg.newName }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "set-sheet-status": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await stageSheetStatus(store, gate, { path: msg.path, status: msg.status }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "rename-sheet": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await stageSheetRename(store, gate, { path: msg.path, name: msg.name }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "assign-voice": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await stageVoiceAssignment(store, gate, { path: msg.path, voice: msg.voice }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "sheet-refs": {
        const store = this.opts.provider.openStore?.();
        const index = store?.getIndex();
        if (!store || !index) return;
        const refs = refsForSheet(index.db, msg.sheetId);
        const incoming = index.db
          .prepare(
            "SELECT DISTINCT source_id AS id FROM citations WHERE target_id = ? AND relation = 'sheet-link' ORDER BY id",
          )
          .all(msg.sheetId) as Array<{ id: string }>;
        this.emit({
          at: new Date().toISOString(),
          type: "sheet.refs",
          worldId: msg.worldId,
          sheetId: msg.sheetId,
          tiles: refs.tiles,
          productions: refs.productions,
          artifacts: refs.artifacts,
          scenes: refs.scenes,
          takesByVersion: Object.fromEntries(
            Object.entries(refs.takesByVersion).map(([v, n]) => [String(v), n]),
          ),
          incomingLinks: incoming.map((r) => r.id),
        });
        return;
      }
      case "set-credential": {
        // Write-only (R-5, R-8): the plaintext is registered with the redaction boundary,
        // encrypted, stored under a user-only ACL, and never travels back in any frame.
        if (!this.credentials) return;
        try {
          await this.credentials.set(msg.provider, msg.key);
          this.providerService.setConfigured(msg.provider, true);
          this.emit({
            at: new Date().toISOString(),
            type: "provider.status",
            providers: this.providerService.list(),
          });
        } catch (err) {
          void this.appLog?.append({
            kind: "credential.store-failed",
            provider: msg.provider,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "clear-credential": {
        if (!this.credentials) return;
        await this.credentials.clear(msg.provider).catch(() => {});
        this.providerService.setConfigured(msg.provider, false);
        this.emit({
          at: new Date().toISOString(),
          type: "provider.status",
          providers: this.providerService.list(),
        });
        return;
      }
      case "validate-provider": {
        // Probes per capability (R-3): the emitted statuses carry what the key unlocks.
        this.emit({
          at: new Date().toISOString(),
          type: "provider.status",
          providers: this.providerService.list(),
        });
        await this.providerService.validate(msg.provider);
        this.emit({
          at: new Date().toISOString(),
          type: "provider.status",
          providers: this.providerService.list(),
        });
        return;
      }
      case "set-routing-default": {
        if (!this.appSettings || !this.opts.manifest) return;
        const result = await this.appSettings.setRoutingDefault(
          msg.capability,
          msg.modelId,
          this.opts.manifest,
        );
        if (!result.ok) {
          void this.appLog?.append({
            kind: "routing.refused",
            capability: msg.capability,
            reason: result.reason,
          });
        }
        const settings = await this.appSettings.load();
        this.emit({
          at: new Date().toISOString(),
          type: "routing.changed",
          routing: settings.routing,
          faults: routingFaults(settings, this.opts.manifest),
        });
        return;
      }
      case "set-agent-config": {
        if (!this.appSettings) return;
        const settings = await this.appSettings.setAgent(msg.agent, {
          ...(msg.model !== undefined ? { model: msg.model } : {}),
          ...(msg.brief !== undefined ? { brief: msg.brief } : {}),
        });
        this.agentOverrides = settings.agents;
        // Sessions already open keep the config they were started with; the next one picks
        // this up. Said plainly in the UI rather than pretended away.
        this.refreshAgents(settings.agents);
        this.transport.broadcastSnapshot();
        return;
      }
      case "list-harness-models": {
        const list = this.opts.adapter?.listModels;
        if (!list) return;
        const models = await list.call(this.opts.adapter).catch(() => []);
        this.readModel.setHarnessModels(
          models.map((m) => ({
            id: m.id,
            provider: m.provider,
            ...(m.displayName ? { displayName: m.displayName } : {}),
            ...(m.isDefault ? { isDefault: true } : {}),
          })),
        );
        this.transport.broadcastSnapshot();
        return;
      }
      case "set-spend-threshold": {
        if (!this.appSettings) return;
        const settings = await this.appSettings.setSpend(msg.thresholdMicroUsd, msg.periodDays);
        const entries = this.ledger ? await this.ledger.readAll() : this.getState().app.ledger;
        this.emit({
          at: new Date().toISOString(),
          type: "spend.status",
          spend: evaluateSpend(entries, settings.spend, new Date()),
        });
        return;
      }
      case "create-production": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        try {
          await createProduction(store, {
            title: msg.title,
            format: msg.format,
            ...(msg.logline !== undefined ? { logline: msg.logline } : {}),
          });
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "draft-scene": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        try {
          const draft = await draftSceneSkeleton(store, gate, {
            productionId: msg.productionId,
            brief: msg.brief,
          });
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: draft.proposalId,
          });
          await this.refreshWorldSnapshot(msg.worldId);
          if (this.authoring && this.opts.adapter?.readiness().ready) {
            const worldQueryUrl = await this.worldQuery.start();
            void this.authoring
              .run(
                store,
                gate,
                {
                  worldId: msg.worldId,
                  proposalId: draft.proposalId,
                  purpose: "authoring",
                  instruction: draft.instruction,
                },
                worldQueryUrl,
              )
              .then(() => this.refreshWorldSnapshot(msg.worldId));
          }
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "stage-scene-edit": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        try {
          const scene = SceneSchema.parse(msg.scene);
          await gate.stage({
            kind: "scene-edit",
            summary: msg.summary,
            source: "form",
            targets: [
              {
                path: `productions/${msg.productionId}/scenes/${msg.sceneFile}.json`,
                content: JSON.stringify(scene, null, 2) + "\n",
              },
            ],
          });
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "create-chapter": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await createChapter(store, msg.productionId, { title: msg.title, order: msg.order }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "save-chapter": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await saveChapter(store, msg.productionId, msg.chapterFile, msg.body).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "draft-chapter": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store || !this.authoring || !this.opts.adapter?.readiness().ready) return;
        try {
          const path = `productions/${msg.productionId}/chapters/${msg.chapterFile}.md`;
          const staged = await gate.stage({
            kind: "chapter-draft",
            summary: `Draft: ${msg.chapterFile}`,
            source: "chat:studio",
            targets: [{ path }],
          });
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: staged.id,
          });
          const worldQueryUrl = await this.worldQuery.start();
          void this.authoring
            .run(
              store,
              gate,
              {
                worldId: msg.worldId,
                proposalId: staged.id,
                purpose: "drafting",
                instruction: `Draft the chapter prose in ${path}. ${msg.instruction}. Anything the prose implies about the world — a new name, a rule, a place — must NOT be written into world files; list such facts at the end of the chapter under a "## Surfaced facts" heading for separate proposal.`,
              },
              worldQueryUrl,
            )
            .then(() => this.refreshWorldSnapshot(msg.worldId));
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "reorder-chapters": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await reorderChapters(store, msg.productionId, msg.orderedFiles).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "set-prompt-override": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await setPromptOverride(store, store.getBundle(), {
          productionId: msg.productionId,
          sceneFile: msg.sceneFile,
          shotId: msg.shotId,
          text: msg.text,
        }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "compile-scene-board":
      case "export-scene-board": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const bundle = store.getBundle();
        const production = bundle.productions.find((p) => p.meta.id === msg.productionId);
        const scene = production?.scenes.find(
          (s) => `${String(s.number).padStart(2, "0")}-${s.slug}` === msg.sceneFile,
        );
        if (!production || !scene) return;
        try {
          const png = await compileBoard(store, production, scene);
          if (msg.kind === "compile-scene-board") {
            await landBoard(store, msg.productionId, msg.sceneFile, png, () => new Date().toISOString());
          } else {
            await exportBoard(store, msg.productionId, scene, png, () => new Date().toISOString());
          }
          await this.refreshWorldSnapshot(msg.worldId);
        } catch (err) {
          void this.appLog?.append({
            kind: "board.failed",
            sceneFile: msg.sceneFile,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "dispatch-scene": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The scene could not be prepared for Activity.");
          return;
        }
        const bundle = store.getBundle();
        const production = bundle.productions.find((p) => p.meta.id === msg.productionId);
        const scene = production?.scenes.find(
          (s) => `${String(s.number).padStart(2, "0")}-${s.slug}` === msg.sceneFile,
        );
        const model = this.opts.manifest.models.find((m) => m.id === msg.modelId);
        if (!production || !scene || !model) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The scene or selected model is no longer available.");
          return;
        }
        // Recompute the plan server-side — the request the dialog showed is the one executed.
        const plan = planScene(
          {
            world: bundle.meta,
            artDirection: bundle.artDirection,
            productionId: production.meta.id,
            sheets: bundle.sheets,
            kits: bundle.referenceKits,
            scene,
            selections: production.selections,
            model,
            ...(msg.resolution !== undefined ? { resolution: msg.resolution } : {}),
          },
          msg.mode,
        );
        if (msg.mode === "whole-scene" && !plan.pack.ok) {
          void this.appLog?.append({ kind: "dispatch.refused", reason: "oversize shot", detail: plan.pack });
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "Whole-scene dispatch is unavailable because one shot exceeds the model limit.",
          );
          return;
        }
        await this.enqueueBatch(
          msg.requestId,
          msg.kind,
          composeDispatches(msg.worldId, msg.productionId, scene, plan, model, bundle),
        );
        return;
      }
      case "accept-take": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        try {
          const decision = await acceptTake(store, production, {
            takeId: msg.takeId,
            shotId: msg.shotId,
            by: "user",
          });
          this.emit({
            at: new Date().toISOString(),
            type: "review.recorded",
            worldId: msg.worldId,
            productionId: msg.productionId,
            review: decision,
          });
          this.emit({
            at: new Date().toISOString(),
            type: "selection.changed",
            worldId: msg.worldId,
            productionId: msg.productionId,
            shotId: msg.shotId,
            selection: { acceptedTakeId: msg.takeId as never },
          });
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "reject-take": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        try {
          const decision = await rejectTake(store, production, {
            takeId: msg.takeId,
            ...(msg.shotId !== undefined ? { shotId: msg.shotId } : {}),
            by: "user",
            citation: msg.citation,
          });
          this.emit({
            at: new Date().toISOString(),
            type: "review.recorded",
            worldId: msg.worldId,
            productionId: msg.productionId,
            review: decision,
          });
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "save-audio-tracks": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        try {
          const cut = CutFileSchema.parse(msg.cut);
          await saveAudioTracks(store, msg.productionId, JSON.stringify(cut, null, 2) + "\n");
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "export-cut": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        const runner = this.opts.ffmpeg;
        const emitProgress = (
          exportId: string,
          status: "running" | "done" | "cancelled" | "failed",
          percent: number,
          output: string | null,
          error: string | null,
        ) =>
          this.emit({
            at: new Date().toISOString(),
            type: "export.progress",
            worldId: msg.worldId,
            productionId: msg.productionId,
            exportId,
            status,
            percent,
            output,
            error,
          });
        if (!runner) {
          emitProgress(
            "ex_none",
            "failed",
            0,
            null,
            "export needs ffmpeg — bundled in packaged builds (SPEC-016); set ARKE_FFMPEG to use one now",
          );
          return;
        }
        const cut = deriveCut(production);
        const plan = buildExportPlan(cut, msg.preset);
        const stamp = new Date()
          .toISOString()
          .replace(/[-:TZ.]/g, "")
          .slice(0, 14);
        const handle = runExport(
          store.dir,
          plan,
          `${msg.productionId}-${msg.preset}-${stamp}.mp4`,
          runner,
          (percent) => emitProgress(handle.id, "running", percent, null, null),
        );
        this.exports.set(handle.id, handle);
        emitProgress(handle.id, "running", 0, null, null);
        void handle.done.then((result) => {
          this.exports.delete(handle.id);
          if (result.status === "done") emitProgress(handle.id, "done", 100, result.output, null);
          else if (result.status === "cancelled") emitProgress(handle.id, "cancelled", 0, null, null);
          else emitProgress(handle.id, "failed", 0, null, result.error);
        });
        return;
      }
      case "cancel-export": {
        this.exports.get(msg.exportId)?.cancel();
        return;
      }
      case "export-world": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.appRoot) return;
        const stamp = new Date()
          .toISOString()
          .replace(/[-:TZ.]/g, "")
          .slice(0, 14);
        const target = join(this.opts.appRoot, "exports", `${store.getBundle().meta.slug}-${stamp}`);
        await exportWorld(store.dir, target).catch((err) => {
          void this.appLog?.append({
            kind: "world-export.failed",
            message: err instanceof Error ? err.message : String(err),
          });
        });
        void this.appLog?.append({ kind: "world-export.done", target });
        return;
      }
      case "check-updates": {
        if (!this.opts.updates) {
          this.emit({
            at: new Date().toISOString(),
            type: "update.status",
            status: "none",
            version: null,
            detail: "updates are managed outside this build",
          });
          return;
        }
        this.emit({
          at: new Date().toISOString(),
          type: "update.status",
          status: "checking",
          version: null,
          detail: null,
        });
        try {
          const found = await this.opts.updates.check();
          this.emit({
            at: new Date().toISOString(),
            type: "update.status",
            status: found ? "available" : "none",
            version: found?.version ?? null,
            detail: found ? "downloading is your call; installing happens when you quit" : null,
          });
        } catch (err) {
          this.emit({
            at: new Date().toISOString(),
            type: "update.status",
            status: "error",
            version: null,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "download-update": {
        if (!this.opts.updates) return;
        this.emit({
          at: new Date().toISOString(),
          type: "update.status",
          status: "downloading",
          version: null,
          detail: null,
        });
        try {
          // Download only (R-13, D7): the world lock, the commit journal and running jobs are
          // never interrupted — installation waits for application exit, by construction.
          await this.opts.updates.download();
          this.emit({
            at: new Date().toISOString(),
            type: "update.status",
            status: "downloaded",
            version: null,
            detail: "installs when you quit — running work is never interrupted",
          });
        } catch (err) {
          this.emit({
            at: new Date().toISOString(),
            type: "update.status",
            status: "error",
            version: null,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "generate-diagnostics": {
        const bundle = await this.diagnostics();
        this.emit({
          at: new Date().toISOString(),
          type: "diagnostics.ready",
          bundle: JSON.stringify(bundle, null, 2),
        });
        return;
      }
      case "open-data-folder": {
        if (this.opts.appRoot) this.opts.openPath?.(this.opts.appRoot);
        return;
      }
      case "file-artifact": {
        await this.fileOne(msg.worldId, msg.sourcePath, {
          ...(msg.links !== undefined ? { links: msg.links } : {}),
          ...(msg.allowLarge !== undefined ? { allowLarge: msg.allowLarge } : {}),
          ...(msg.supersedes !== undefined ? { supersedes: msg.supersedes } : {}),
        });
        return;
      }
      case "attach-files": {
        // The dialog is the host's, and so is the path it returns. The renderer asked to attach
        // something; what it gets back is artifacts in the snapshot, never a path.
        const pick = this.opts.pickFiles;
        if (!pick) {
          this.emit({
            at: new Date().toISOString(),
            type: "artifact.notice",
            worldId: msg.worldId,
            sourcePath: "",
            outcome: "refused",
            reason: "attaching needs the desktop app — a browser session cannot open the file picker",
            sizeBytes: null,
          });
          return;
        }
        const paths = await pick({ accept: ATTACHABLE_EXTENSIONS }).catch(() => [] as readonly string[]);
        // Cancelling the dialog is an answer, not an error: nothing is said and nothing happens.
        for (const sourcePath of paths) {
          await this.fileOne(msg.worldId, sourcePath, msg.links !== undefined ? { links: msg.links } : {});
        }
        return;
      }
      case "genesis-attach-files": {
        const pick = this.opts.pickFiles;
        if (!pick) {
          this.emit({
            at: new Date().toISOString(),
            type: "genesis.attachment",
            genesisId: msg.genesisId,
            // No file was ever chosen, so there is no name to carry — the chip names the act.
            name: "attaching",
            kind: "other",
            outcome: "refused",
            reason: "this needs the desktop app — a browser session cannot open the file picker",
          });
          return;
        }
        const paths = await pick({ accept: ATTACHABLE_EXTENSIONS }).catch(() => [] as readonly string[]);
        for (const sourcePath of paths) await this.attachToGenesis(msg.genesisId, sourcePath);
        return;
      }
      case "genesis-attach": {
        await this.attachToGenesis(msg.genesisId, msg.sourcePath);
        return;
      }
      case "import-folder": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const report = await importFolder(store, msg.sourcePath).catch(() => null);
        if (report) {
          this.emit({ at: new Date().toISOString(), type: "import.report", worldId: msg.worldId, ...report });
          await this.refreshWorldSnapshot(msg.worldId);
        }
        return;
      }
      case "stop-extraction": {
        this.reading.get(msg.artifactId)?.abort();
        return;
      }
      case "extract-artifact": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const artifact = store.getBundle().artifacts.find((a) => a.id === msg.artifactId);
        if (!artifact) return;
        // Asking twice while it is already reading is a double-click, not a second reading.
        if (this.reading.has(msg.artifactId)) return;
        const control = new AbortController();
        this.reading.set(msg.artifactId, control);
        const finished = (
          outcome: "found" | "nothing" | "no-text" | "stopped" | "unavailable" | "failed",
          found: number,
          dropped: number,
          reason?: string,
        ) =>
          this.emit({
            at: new Date().toISOString(),
            type: "extraction.finished",
            worldId: msg.worldId,
            artifactId: msg.artifactId,
            file: artifact.file,
            outcome,
            found,
            dropped,
            ...(reason !== undefined ? { reason } : {}),
          });
        this.emit({
          at: new Date().toISOString(),
          type: "extraction.started",
          worldId: msg.worldId,
          artifactId: msg.artifactId,
          file: artifact.file,
        });
        try {
          const text = await extractText(store, artifact);
          if (text === null) {
            void this.appLog?.append({ kind: "extraction.no-text", artifact: artifact.file });
            finished("no-text", 0, 0, "there is no text in this one we can read");
            return;
          }
          // The seam wins; else the built-in adapter runner when the harness is up (SPEC-016).
          let extractor = this.opts.extractor ?? null;
          if (!extractor && this.opts.adapter?.readiness().ready && this.opts.authoring) {
            extractor = makeAdapterExtractor(
              this.opts.adapter,
              this.buildConfig!,
              this.opts.appRoot ? join(this.opts.appRoot, ".extract") : `${this.opts.changeLogPath}.extract`,
            );
          }
          if (!extractor) {
            // Filing already succeeded and is untouched (D1); the model wiring is stated, not silent.
            void this.appLog?.append({
              kind: "extraction.unavailable",
              artifact: artifact.file,
              reason: "extraction needs the authoring harness running — filing is complete either way",
            });
            finished(
              "unavailable",
              0,
              0,
              "reading needs the writing service running — the file is filed either way",
            );
            return;
          }
          const raw = await extractor(text, artifact.file, control.signal);
          const batch = verifyCandidates(raw, text, artifact.extraction?.decided ?? []);
          await storeBatch(store, artifact, batch);
          await this.refreshWorldSnapshot(msg.worldId);
          // Nothing found is an answer, not a failure — and it is the answer whenever the
          // document only repeats what the canon already says (R-17: decided is never re-offered).
          finished(
            batch.verified.length > 0 ? "found" : "nothing",
            batch.verified.length,
            batch.droppedCount,
          );
        } catch (err) {
          if (control.signal.aborted) {
            finished("stopped", 0, 0);
            return;
          }
          void this.appLog?.append({
            kind: "extraction.failed",
            artifact: artifact.file,
            message: err instanceof Error ? err.message : String(err),
          });
          finished("failed", 0, 0, err instanceof Error ? err.message.slice(0, 200) : String(err));
        } finally {
          this.reading.delete(msg.artifactId);
        }
        return;
      }
      case "resolve-extraction": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        const artifact = store.getBundle().artifacts.find((a) => a.id === msg.artifactId);
        if (!artifact) return;
        await resolveCandidate(store, gate, artifact, msg.candidateHash, msg.decision).catch((err) => {
          void this.appLog?.append({
            kind: "extraction.resolve-failed",
            message: err instanceof Error ? err.message : String(err),
          });
        });
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "record-review": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const review = {
          ts: new Date().toISOString(),
          takeId: msg.takeId,
          ...(msg.shotId !== undefined ? { shotId: msg.shotId } : {}),
          decision: msg.decision,
          by: "user",
          ...(msg.citation !== undefined ? { citation: msg.citation } : {}),
        };
        await store
          .gateOp(async () => {
            const path = join(store.dir, "productions", msg.productionId, "reviews.jsonl");
            const { appendFile } = await import("node:fs/promises");
            await appendFile(toExtendedLength(path), JSON.stringify(review) + "\n", "utf8");
          })
          .catch(() => {});
        this.emit({
          at: new Date().toISOString(),
          type: "review.recorded",
          worldId: msg.worldId,
          productionId: msg.productionId,
          review: review as never,
        });
        return;
      }
      case "voice-candidates": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.voiceService) return;
        const sheet = store.getBundle().sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) return;
        await this.voiceService
          .candidates(msg.worldId, store.getBundle(), sheet, this.opts.manifest ?? null)
          .catch(() => {});
        return;
      }
      case "voice-preview": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.voiceService) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Voice preview is unavailable.");
          return;
        }
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The character is no longer available.");
          return;
        }
        const line = previewLineFor(sheet, bundle.productions);
        if (msg.provider === "kokoro") {
          // Local: sidecar synthesis, no queue, no ledger, zero cost (R-2).
          try {
            const file = await this.voiceService.localPreview(store, sheet, msg.voiceId, line);
            this.emit({
              at: new Date().toISOString(),
              type: "voice.preview",
              worldId: msg.worldId,
              sheetId: msg.sheetId,
              provider: msg.provider,
              voiceId: msg.voiceId,
              file,
              error: null,
            });
            await this.refreshWorldSnapshot(msg.worldId);
          } catch (err) {
            this.emit({
              at: new Date().toISOString(),
              type: "voice.preview",
              worldId: msg.worldId,
              sheetId: msg.sheetId,
              provider: msg.provider,
              voiceId: msg.voiceId,
              file: null,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
          return;
        }
        // Cloud: cache hit replays free; a miss dispatches through the queue (R-2, R-10).
        const cached = previewCacheFile(msg.provider, msg.voiceId, line.text, "mp3");
        try {
          await readFile(toExtendedLength(join(store.dir, fromPortable(cached))));
          this.emit({
            at: new Date().toISOString(),
            type: "voice.preview",
            worldId: msg.worldId,
            sheetId: msg.sheetId,
            provider: msg.provider,
            voiceId: msg.voiceId,
            file: cached,
            error: null,
          });
          this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
          return;
        } catch {
          /* miss → enqueue */
        }
        const model = this.opts.manifest?.models.find(
          (m) => m.provider === msg.provider && m.capability === "voice-tts",
        );
        if (!model) {
          this.rejectEnqueue(msg.requestId, msg.kind, "No cloud voice model is available for this provider.");
          return;
        }
        const request = this.voiceService.cloudPreviewRequest(
          msg.worldId,
          sheet,
          msg.provider,
          msg.voiceId,
          line,
          model,
        );
        await this.enqueueBatch(msg.requestId, msg.kind, [request.input]);
        return;
      }
      case "transcribe-dictation": {
        if (!this.voiceService) return;
        await this.voiceService.dictate(
          msg.requestId,
          Uint8Array.from(Buffer.from(msg.audioBase64, "base64")),
          msg.contentType,
        );
        return;
      }
      case "generate-world-image": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "World key art is unavailable.");
          return;
        }
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
        );
        // The screen disables the button without a usable image model and says why; this is the
        // backstop for a frame that arrives anyway.
        if (!model) {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "No image model is available. Check provider settings.",
          );
          return;
        }
        const bundle = store.getBundle();
        // Ask the harness to write the prompt, and carry on without it if it cannot. A writing
        // model turns "a drowned god still sings" into light, material and lens; the plain
        // assembly is a weaker prompt, but it is a prompt, and a picture still gets made.
        let prompt: string | null = null;
        if (this.opts.adapter?.readiness().ready && this.buildConfig) {
          const director = makeArtDirector(
            this.opts.adapter,
            this.buildConfig,
            this.opts.appRoot ? join(this.opts.appRoot, ".art") : `${this.opts.changeLogPath}.art`,
          );
          // The most-cited canon first: what the world has settled about itself is what an
          // establishing image should be true to.
          const canonLines = bundle.canon
            .filter((c) => c.status !== "open")
            .slice(0, 6)
            .map((c) => c.title);
          prompt = await director(worldBrief(bundle.meta, canonLines)).catch(() => null);
          void this.appLog?.append({
            kind: prompt ? "world-image.prompt-written" : "world-image.prompt-unavailable",
            worldId: msg.worldId,
            ...(prompt ? { prompt } : {}),
          });
        }
        const request = worldImageRequest(bundle.meta, model, bundle.artDirection);
        await this.enqueueBatch(msg.requestId, msg.kind, [
          prompt
            ? {
                ...request,
                params: {
                  ...request.params,
                  prompt: `${bundle.artDirection.description}. ${prompt}`,
                },
              }
            : request,
        ]);
        return;
      }
      case "use-world-image": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const from = join(store.dir, WORLD_IMAGE_DIR, WORLD_IMAGE_CANDIDATE);
        const to = join(store.dir, WORLD_IMAGE_FILE);
        // Through gateOp so the copy rides the world's suppression envelope — our own write
        // must not come back at the user as an external edit (SPEC-011).
        await store
          .gateOp(async () => {
            await copyFile(toExtendedLength(from), toExtendedLength(to));
            await rm(toExtendedLength(from), { force: true });
          })
          .catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "discard-world-image": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await store
          .gateOp(async () =>
            rm(toExtendedLength(join(store.dir, WORLD_IMAGE_DIR, WORLD_IMAGE_CANDIDATE)), { force: true }),
          )
          .catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "establish-look": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Reference generation is unavailable.");
          return;
        }
        const sheet = store.getBundle().sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The character is no longer available.");
          return;
        }
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
        );
        if (!model) {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "No image model is available. Check provider settings.",
          );
          return;
        }
        const kit = (await readKit(store, msg.sheetId))?.kit ?? null;
        const bundle = store.getBundle();
        let requests;
        try {
          requests = establishRequests(bundle.meta, sheet, kit, model, msg.count, bundle.artDirection);
        } catch {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "This image model could not be priced for the selected output size. Nothing was queued.",
          );
          return;
        }
        await this.enqueueBatch(msg.requestId, msg.kind, requests.map((request) => request.input));
        return;
      }
      case "choose-anchor": {
        const store = this.opts.provider.openStore?.();
        let source: "upload" | "generated" = msg.selection.source === "candidate" ? "upload" : "generated";
        const report = (
          status: "accepted" | "failed",
          candidateRetained: boolean,
          reason?: string,
          stage?: MainPhotoAcceptanceStage,
        ) => {
          if (stage) {
            void this.appLog?.append(mainPhotoLogRecord(msg.worldId, msg.sheetId, stage, source));
          }
          this.emit({
            at: new Date().toISOString(),
            type: "main-photo.acceptance",
            worldId: msg.worldId,
            sheetId: msg.sheetId,
            status,
            ...(reason ? { reason } : {}),
            candidateRetained,
          });
        };
        if (!store || store.worldId !== msg.worldId) {
          report(
            "failed",
            true,
            "The main photo was not changed. Open this world and try again.",
            "candidate-validation",
          );
          return;
        }
        const sheet = store.getBundle().sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) {
          report(
            "failed",
            true,
            "The main photo was not changed because the character is unavailable.",
            "candidate-validation",
          );
          return;
        }
        let bundle = store.getBundle();
        let selection = msg.selection;
        let sourceCandidatePath: string | null = null;
        if (selection.source === "take") {
          const takeId = selection.takeId;
          const take = bundle.referenceTakes.find((candidate) => candidate.id === takeId);
          const job = take?.jobId
            ? this.jobQueue?.listJobs().find((candidate) => candidate.id === take.jobId)
            : undefined;
          sourceCandidatePath =
            (typeof take?.params["sourceCandidate"] === "string" ? take.params["sourceCandidate"] : null) ??
            job?.landedFiles?.find((path) => path.startsWith(`references/${msg.sheetId}/candidates/`)) ??
            null;
        } else {
          const candidatePath = `references/${msg.sheetId}/candidates/${selection.file}`;
          const job = this.jobQueue
            ?.listJobs()
            .find(
              (candidate) =>
                candidate.status === "succeeded" &&
                (candidate.target.kind === "main-photo-candidate" ||
                  candidate.target.kind === "establish-candidate") &&
                candidate.target.id?.startsWith(`${msg.sheetId}/`) === true &&
                candidate.landedFiles?.includes(candidatePath),
            );
          if (job) {
            source = "generated";
            const recovered = await recordReferenceTake(store, job).catch(() => null);
            if (!recovered) {
              await this.refreshWorldSnapshot(msg.worldId);
              report("failed", true, mainPhotoFailureReason("take-recording"), "take-recording");
              return;
            }
            bundle = store.getBundle();
            selection = { source: "take", takeId: recovered.id };
            sourceCandidatePath = candidatePath;
          }
        }
        const result = await acceptMainPhoto(store, sheet, bundle, selection, sourceCandidatePath);
        await this.refreshWorldSnapshot(msg.worldId);
        if (result.status === "failed") {
          report("failed", result.candidateRetained, mainPhotoFailureReason(result.stage), result.stage);
          return;
        }
        if (result.cleanupError) {
          report("accepted", true, undefined, "candidate-cleanup");
          return;
        }
        report("accepted", false);
        return;
      }
      case "import-main-photo-candidate": {
        const store = this.opts.provider.openStore?.();
        const pick = this.opts.pickFiles;
        if (!store || !pick) return;
        const [source] = await pick({ accept: [".png", ".jpg", ".jpeg", ".webp"] }).catch(() => []);
        if (!source) return;
        const extension = extname(source).toLowerCase();
        if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return;
        await store
          .gateOp(async () => {
            const name = `upload-${Date.now().toString(36)}${extension}`;
            await mkdir(toExtendedLength(join(store.dir, "references", msg.sheetId, "candidates")), {
              recursive: true,
            });
            await copyFile(
              toExtendedLength(source),
              toExtendedLength(join(store.dir, "references", msg.sheetId, "candidates", name)),
            );
          })
          .catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "generate-main-photo": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Main-photo generation is unavailable.");
          return;
        }
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((candidate) => candidate.id === msg.sheetId);
        const kit = (await readKit(store, msg.sheetId))?.kit ?? null;
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
        );
        if (!sheet || !model) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The character or image model is no longer available.");
          return;
        }
        let requests;
        try {
          requests = mainPhotoRequests(bundle.meta, bundle.artDirection, sheet, kit, model, {
            prompt: msg.prompt,
            count: msg.count,
            identityReferences: msg.identityReferences,
            generationKey: Date.now().toString(36),
          });
        } catch {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "This image model could not be priced for the selected output size. Nothing was queued.",
          );
          return;
        }
        await this.enqueueBatch(
          msg.requestId,
          msg.kind,
          requests.map((request) => request.input),
        );
        return;
      }
      case "generate-character-sheet": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Character-sheet generation is unavailable.");
          return;
        }
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((candidate) => candidate.id === msg.sheetId);
        const kit = (await readKit(store, msg.sheetId))?.kit;
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
        );
        if (!sheet || !kit || !model) {
          this.rejectEnqueue(msg.requestId, msg.kind, "An accepted main photo and image model are required.");
          return;
        }
        let request;
        try {
          request = characterSheetRequest(
            bundle.meta,
            bundle.artDirection,
            sheet,
            kit,
            model,
            Date.now().toString(36),
            msg.styleOverride,
          );
        } catch (error) {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            error instanceof Error && error.message.includes("cannot receive")
              ? `${model.displayName} cannot receive the accepted main photo. Choose a reference-capable image model before generating a character sheet. Nothing was queued.`
              : error instanceof Error && error.message.includes("could not be priced")
                ? "This image model could not be priced for the selected output size. Nothing was queued."
                : "An accepted main photo is required before generating a character sheet.",
          );
          return;
        }
        await this.enqueueBatch(msg.requestId, msg.kind, [request.input]);
        return;
      }
      case "accept-character-sheet": {
        const store = this.opts.provider.openStore?.();
        if (!store || store.worldId !== msg.worldId) return;
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((candidate) => candidate.id === msg.sheetId);
        const take = pendingReferenceTake(
          bundle.referenceTakes,
          bundle.referenceReviews,
          msg.takeId,
          msg.sheetId,
          "sheet",
        );
        if (!sheet || !take?.media) return;
        const media = `references/${msg.sheetId}/takes/${take.id}/${take.media}`;
        if (
          basename(take.media) !== take.media ||
          !(await stat(toExtendedLength(join(store.dir, media))).catch(() => null))
        )
          return;
        const review = referenceReviewDecision(store.now(), take, "accept");
        const frozen = take.params["provenance"] as
          | { sheets?: Record<string, number>; anchorFile?: string }
          | undefined;
        const sheetVersion = frozen?.sheets?.[msg.sheetId] ?? take.provenance.sheets[msg.sheetId];
        if (sheetVersion === undefined || !frozen?.anchorFile) return;
        await acceptCharacterSheet(store, sheet, {
          file: `takes/${take.id}/${take.media}`,
          takeId: take.id,
          sheetVersion,
          anchorFile: frozen.anchorFile,
          artDirectionVersion: take.provenance.artDirectionVersion ?? store.getBundle().artDirection.version,
          review,
        }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "generate-character-looks": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Character-look generation is unavailable.");
          return;
        }
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((candidate) => candidate.id === msg.sheetId);
        const kit = (await readKit(store, msg.sheetId))?.kit;
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
        );
        if (!sheet || !kit || !model) {
          this.rejectEnqueue(msg.requestId, msg.kind, "An accepted main photo and image model are required.");
          return;
        }
        let requests;
        try {
          requests = characterLookRequests(bundle.meta, bundle.artDirection, sheet, kit, model, {
            kind: msg.lookKind,
            mode: msg.mode,
            prompt: msg.prompt,
            count: msg.count,
            generationKey: Date.now().toString(36),
          });
        } catch (error) {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            error instanceof Error && error.message.includes("cannot receive")
              ? `${model.displayName} cannot receive the accepted main photo. Choose a reference-capable image model before generating character looks. Nothing was queued.`
              : error instanceof Error && error.message.includes("could not be priced")
                ? "This image model could not be priced for the selected output size. Nothing was queued."
                : "An accepted main photo is required before generating character looks.",
          );
          return;
        }
        await this.enqueueBatch(
          msg.requestId,
          msg.kind,
          requests.map((request) => request.input),
        );
        return;
      }
      case "accept-character-look": {
        const store = this.opts.provider.openStore?.();
        if (!store || store.worldId !== msg.worldId) return;
        const bundle = store.getBundle();
        const take = pendingReferenceTake(
          bundle.referenceTakes,
          bundle.referenceReviews,
          msg.takeId,
          msg.sheetId,
          "look",
        );
        if (!take?.media) return;
        const producingJob = take.jobId
          ? this.jobQueue?.listJobs().find((candidate) => candidate.id === take.jobId)
          : undefined;
        const lookKind = take.params["lookKind"] ?? producingJob?.params["lookKind"];
        const lookPrompt = take.params["lookPrompt"] ?? producingJob?.params["lookPrompt"];
        if (
          (lookKind !== "costume" && lookKind !== "pose-expression" && lookKind !== "condition-age") ||
          typeof lookPrompt !== "string" ||
          lookPrompt.trim().length === 0
        )
          return;
        const media = `references/${msg.sheetId}/takes/${take.id}/${take.media}`;
        if (
          basename(take.media) !== take.media ||
          !(await stat(toExtendedLength(join(store.dir, media))).catch(() => null))
        )
          return;
        const review = referenceReviewDecision(store.now(), take, "accept");
        await acceptCharacterLook(store, msg.sheetId, {
          id: take.id,
          file: `takes/${take.id}/${take.media}`,
          kind: lookKind,
          prompt: lookPrompt.trim(),
          ...(take.jobId ? { jobId: take.jobId } : {}),
          takeId: take.id,
          artDirectionVersion: take.provenance.artDirectionVersion ?? store.getBundle().artDirection.version,
          review,
        }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "reject-reference-take": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const take = store.getBundle().referenceTakes.find((candidate) => candidate.id === msg.takeId);
        if (!take) return;
        await recordReferenceReview(store, take, "reject", {
          field: msg.field,
          ...(msg.note ? { note: msg.note } : {}),
        }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "promote-character-look": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const sheet = store.getBundle().sheets.find((candidate) => candidate.id === msg.sheetId);
        if (!sheet) return;
        await promoteCharacterLook(store, sheet, msg.lookId).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "attach-character-look": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await attachCharacterLook(store, msg.sheetId, msg.lookId, msg.scope).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "lock-tile": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await lockTile(store, msg.sheetId, msg.angle, msg.name).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "generate-missing-tiles":
      case "regenerate-tile": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Reference generation is unavailable.");
          return;
        }
        const sheet = store.getBundle().sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The character is no longer available.");
          return;
        }
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
        );
        if (!model) {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "No image model is available. Check provider settings.",
          );
          return;
        }
        const kit = (await readKit(store, msg.sheetId))?.kit ?? null;
        let angles;
        if (msg.kind === "regenerate-tile") {
          angles = [msg.angle];
        } else {
          const missing = missingTileAngles(kit, msg.group);
          if (!missing.ok) {
            // The gate states what is outstanding (R-7, D5) — surfaced via the app log and a
            // no-op; the client shows the same gate from the shared helper before sending.
            void this.appLog?.append({
              kind: "kit.gate-refused",
              sheetId: msg.sheetId,
              reason: missing.reason,
            });
            this.rejectEnqueue(msg.requestId, msg.kind, missing.reason);
            return;
          }
          angles = missing.angles;
        }
        let requests;
        try {
          requests = angles.map((angle) => tileRequest(store.getBundle().meta, sheet, kit, model, angle).input);
        } catch {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "This image model could not be priced for the selected output size. Nothing was queued.",
          );
          return;
        }
        await this.enqueueBatch(msg.requestId, msg.kind, requests);
        return;
      }
      case "compile-grid": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const sheet = store.getBundle().sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) return;
        try {
          const result = await compileGrid(store, sheet, () => new Date().toISOString());
          await landGrid(store, sheet, result);
          await this.refreshWorldSnapshot(msg.worldId);
        } catch (err) {
          void this.appLog?.append({
            kind: "kit.compile-failed",
            sheetId: msg.sheetId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "designate-compilation": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await designate(store, msg.sheetId, msg.file).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "set-style-override": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await setStyleOverride(store, msg.sheetId, msg.style).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "cancel-job": {
        await this.jobQueue?.cancel(msg.jobId);
        return;
      }
      case "retry-job-finalization": {
        await this.jobQueue?.retryFinalization(msg.jobId);
        return;
      }
      case "resolve-held-job": {
        await this.jobQueue?.resolveHeld(msg.jobId, msg.decision);
        return;
      }
      case "queue-resume": {
        // The message IS the explicit confirmation resuming a paused provider (SPEC-009 D7).
        this.jobQueue?.resume(msg.provider);
        return;
      }
      case "detect-runtimes": {
        if (!this.opts.manifest || !this.opts.probeRuntime) return;
        try {
          const probes = await this.opts.probeRuntime();
          this.emit({
            at: new Date().toISOString(),
            type: "runtime.status",
            runtime: gateLocalRuntimes(this.opts.manifest, probes, new Date().toISOString()),
          });
        } catch {
          // Detection failure means unknown, not unavailable (D12) — nothing is emitted over
          // the last known figures, and nothing gets disabled by a broken probe.
        }
        return;
      }
      case "permission-reply": {
        const adapter = this.opts.adapter;
        if (!adapter) return;
        const actionClass = this.pendingPermissions.get(msg.permissionId);
        if (msg.decision === "always" && actionClass && this.grants) {
          await this.grants.remember(actionClass, new Date().toISOString());
        }
        this.pendingPermissions.delete(msg.permissionId);
        await adapter
          .respondToPermission?.({ permissionId: msg.permissionId, decision: msg.decision })
          .catch(() => {});
        this.emit({
          at: new Date().toISOString(),
          type: "permission.settled",
          permissionId: msg.permissionId,
          decision: msg.decision,
          remembered: false,
        });
        return;
      }
    }
  }

  /**
   * The roster as it will actually run. Both halves are published — what shipped and what the
   * user changed it to — so no screen has to guess which is in force.
   */
  private refreshAgents(overrides: Record<string, { model?: string; brief?: string }>): void {
    const roster = this.opts.authoring?.roster;
    if (!roster) return;
    this.readModel.setAgents(
      roster.map((a) => {
        const over = overrides[a.name];
        return {
          name: a.name,
          description: a.description,
          shippedBrief: a.brief,
          brief: over?.brief ?? a.brief,
          ...(over?.model ? { model: over.model } : {}),
          edited: over?.brief !== undefined && over.brief !== a.brief,
        };
      }),
    );
  }

  /** Gate operations mutate the world; every client re-syncs from a fresh snapshot. */
  /**
   * File one source into the world, and say so when it will not go. Shared by the explicit
   * file-artifact frame and by attaching from a chat, so both refuse in the same words.
   */
  /**
   * Hold a file for a conversation that has no world yet. It lands in the sandbox the agent
   * works in, so it can be read during the conversation, and is filed properly at Begin.
   */
  private async attachToGenesis(genesisId: string, sourcePath: string): Promise<void> {
    const at = new Date().toISOString();
    const dir = await this.opts.provider.genesisDir?.(genesisId).catch(() => null);
    if (!dir) {
      this.emit({
        at,
        type: "genesis.attachment",
        genesisId,
        name: basename(sourcePath),
        kind: "other",
        outcome: "refused",
        reason: "this conversation has no sandbox to hold it",
      });
      return;
    }
    const outcome = await attachToSandbox(dir, sourcePath);
    if ("reason" in outcome) {
      this.emit({
        at,
        type: "genesis.attachment",
        genesisId,
        name: basename(sourcePath),
        kind: "other",
        outcome: "refused",
        reason: outcome.reason,
      });
      return;
    }
    this.emit({
      at,
      type: "genesis.attachment",
      genesisId,
      name: outcome.name,
      kind: outcome.kind,
      outcome: "waiting",
    });
  }

  /**
   * Begin: everything the conversation was handed follows it into the world. Filed one by one
   * through the ordinary path, so each gets its sidecar, its hash and its place in the journal.
   */
  private async carryGenesisAttachments(genesisId: string, worldId: string): Promise<void> {
    const dir = await this.opts.provider.genesisDir?.(genesisId).catch(() => null);
    if (!dir) return;
    for (const sourcePath of await sandboxAttachments(dir)) {
      await this.fileOne(worldId, sourcePath, {});
    }
  }

  private async fileOne(
    worldId: string,
    sourcePath: string,
    opts: { links?: string[]; allowLarge?: boolean; supersedes?: string },
  ): Promise<void> {
    const store = this.opts.provider.openStore?.();
    if (!store) return;
    const outcome = await fileArtifact(store, { sourcePath, ...opts }).catch((err) => ({
      outcome: "refused" as const,
      reason: err instanceof Error ? err.message : String(err),
    }));
    if (outcome.outcome === "needs-consent" || outcome.outcome === "refused") {
      this.emit({
        at: new Date().toISOString(),
        type: "artifact.notice",
        worldId,
        sourcePath,
        outcome: outcome.outcome,
        reason: outcome.reason,
        sizeBytes: outcome.outcome === "needs-consent" ? outcome.sizeBytes : null,
      });
      return;
    }
    this.emit({
      at: new Date().toISOString(),
      type: "artifact.attached",
      worldId,
      artifactId: outcome.artifact.id,
      file: outcome.artifact.file,
      kind: outcome.artifact.kind,
      deduplicated: outcome.outcome === "deduplicated",
    });
    await this.refreshWorldSnapshot(worldId);
  }

  private async refreshWorldSnapshot(worldId: string): Promise<void> {
    try {
      this.readModel.setWorld(await this.opts.provider.loadWorld(worldId));
    } catch {
      /* the previous snapshot stands */
    }
    this.transport.broadcastSnapshot();
  }

  private async seed(): Promise<void> {
    if (this.opts.jobsSeedPath) {
      this.readModel.seedJobs(await readNdjson(this.opts.jobsSeedPath, (x) => JobSchema.parse(x)));
    }
    if (this.opts.ledgerSeedPath) {
      this.readModel.seedLedger(
        await readNdjson(this.opts.ledgerSeedPath, (x) => LedgerEntrySchema.parse(x)),
      );
    }
  }

  async stop(): Promise<void> {
    this.setup?.dispose();
    await Promise.all([...this.supervisors.values()].map((s) => s.stop()));
    await this.opts.adapter?.dispose?.().catch(() => {});
    await this.worldQuery.stop();
    await this.transport.stop();
    await this.opts.provider.close?.();
    await this.changeLog.drain();
  }
}

async function readNdjson<T>(path: string, parse: (x: unknown) => T): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parse(JSON.parse(l)));
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DomainEventSchema,
  JobSchema,
  LedgerEntrySchema,
  type ClientMessage,
  type ClientState,
  type DomainEvent,
  type HarnessAdapter,
  type HealthComponent,
  gateLocalRuntimes,
  type LedgerEntry,
  type ModelManifest,
  type ProviderId,
  type RuntimeProbes,
} from "@arke-studio/contracts";
import { AppLog } from "./app-log.js";
import { AppSettingsFile, routingFaults } from "./app-settings.js";
import { AskService } from "./canon/ask.js";
import { CredentialStore, type Cipher } from "./credentials/store.js";
import { buildDiagnosticsBundle } from "./diagnostics.js";
import { ProviderService, type KeyValidator } from "./providers/service.js";
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
    buildConfig: (input: { worldQueryUrl?: string }) => Record<string, unknown>;
    agentForPurpose: (purpose: "authoring" | "drafting" | "extraction" | "ask") => string;
  };
  /** SPEC-008: credential cipher (Electron safeStorage in the desktop; a fake in tests). */
  cipher?: Cipher;
  /** SPEC-008: per-provider key validators, injected from @arke-studio/providers. */
  validators?: Partial<Record<ProviderId, KeyValidator>>;
  /** SPEC-008: the shipped model manifest. */
  manifest?: ModelManifest;
  /** SPEC-008: local runtime probing, injected so tests measure nothing. */
  probeRuntime?: () => Promise<RuntimeProbes>;
}

const SUPERVISOR_HEALTH: Record<SupervisorStatus, { status: "starting" | "healthy" | "unhealthy" | "unavailable" }> = {
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
  /** actionClass per pending permission id, for remember-on-always (R-16). */
  private readonly pendingPermissions = new Map<string, string>();
  private started = false;
  /** SPEC-008: redaction registry, credential store, provider statuses, ledger, settings. */
  private readonly secrets = new SecretRegistry();
  private readonly appLog: AppLog | null;
  private readonly credentials: CredentialStore | null;
  private readonly providerService: ProviderService;
  private readonly ledger: LedgerFile | null;
  private readonly appSettings: AppSettingsFile | null;

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
    this.transport = new Transport({
      getSnapshot: () => this.getState(),
      onMessage: (msg) => void this.handleClientMessage(msg),
    });
    this.worldQuery = new WorldQueryServer(() => this.opts.provider.openStore?.() ?? null);
    this.grants = opts.appRoot ? new GrantStore(opts.appRoot) : null;
    this.authoring =
      opts.adapter && opts.authoring
        ? new AuthoringService(opts.adapter, (event) => this.emit(event), {
            buildConfig: opts.authoring.buildConfig,
            agentForPurpose: opts.authoring.agentForPurpose,
          })
        : null;
    this.askService = opts.authoring
      ? new AskService(opts.adapter, {
          buildConfig: opts.authoring.buildConfig,
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
        void adapter
          .init!()
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
    const bundle = await this.opts.provider.loadWorld(worldId);
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
    this.emit({ at: new Date().toISOString(), type: "provider.status", providers: this.providerService.list() });
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
      void this.appLog?.append({ kind: "spend.alert", rollingMicroUsd: spend.rollingMicroUsd, settings: settings.spend });
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
        } catch {
          this.transport.broadcastSnapshot(); // surface whatever state we do have
        }
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
          this.emit({ at: new Date().toISOString(), type: "proposal.staged", worldId: msg.worldId, proposalId: proposal.id });
        } catch {
          /* the snapshot below carries whatever state resulted */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-accept": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        try {
          const outcome = await gate.accept(msg.proposalId, {
            ...(msg.confirmRipples !== undefined ? { confirmRipples: msg.confirmRipples } : {}),
          });
          const at = new Date().toISOString();
          if (outcome.status === "accepted") {
            this.emit({ at, type: "proposal.resolved", worldId: msg.worldId, proposalId: msg.proposalId, outcome: "accepted" });
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
          const proposal = await gate.stage({
            kind: "sheet-edit",
            summary: msg.summary,
            source: "chat:studio",
            targets: [{ path: msg.path }],
          });
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: proposal.id,
          });
          await this.refreshWorldSnapshot(msg.worldId);
          const worldQueryUrl = await this.worldQuery.start();
          // Fire and watch: progress and the final status arrive as events (R-13).
          void this.authoring
            .run(
              store,
              gate,
              {
                worldId: msg.worldId,
                proposalId: proposal.id,
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
      case "authoring-cancel": {
        await this.authoring?.cancel(msg.proposalId);
        return;
      }
      case "canon-ask": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        // Fire and watch: the result arrives as one canon.answer event, refusals included.
        void (async () => {
          const worldQueryUrl = this.askService && this.opts.adapter ? await this.worldQuery.start() : undefined;
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
          this.emit({ at: new Date().toISOString(), type: "proposal.staged", worldId: msg.worldId, proposalId: proposal.id });
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
        await stageCanonAmendment(store, gate, { entryId: msg.entryId, statement: msg.statement }).catch(() => {});
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
              .then(() => this.refreshWorldSnapshot(msg.worldId));
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
          this.emit({ at: new Date().toISOString(), type: "provider.status", providers: this.providerService.list() });
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
        this.emit({ at: new Date().toISOString(), type: "provider.status", providers: this.providerService.list() });
        return;
      }
      case "validate-provider": {
        // Probes per capability (R-3): the emitted statuses carry what the key unlocks.
        this.emit({ at: new Date().toISOString(), type: "provider.status", providers: this.providerService.list() });
        await this.providerService.validate(msg.provider);
        this.emit({ at: new Date().toISOString(), type: "provider.status", providers: this.providerService.list() });
        return;
      }
      case "set-routing-default": {
        if (!this.appSettings || !this.opts.manifest) return;
        const result = await this.appSettings.setRoutingDefault(msg.capability, msg.modelId, this.opts.manifest);
        if (!result.ok) {
          void this.appLog?.append({ kind: "routing.refused", capability: msg.capability, reason: result.reason });
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

  /** Gate operations mutate the world; every client re-syncs from a fresh snapshot. */
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

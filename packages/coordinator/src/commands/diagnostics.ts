import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DomainEventSchema, type DomainEvent } from "@arke-studio/contracts";
import type { DiagnosticsSnapshotHolder } from "../diagnostics-snapshot.js";
import type { ProviderCallStore } from "../providers/call-store.js";
import type { AppStorageService } from "../storage/service.js";
import type { SystemResourceService } from "../system-resources.js";
import type { CataloguePreviewService } from "../voice/catalogue-preview.js";
import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

/** Diagnostics: the support bundle, provider calls, the data folder and engine logs. No world. */
export function diagnosticsCommands(ctx: CommandContext, deps: {
  snapshot: () => DiagnosticsSnapshotHolder | null;
  publishRecoveryPolicy(): void;
  storageHealth: () => AppStorageService | null | undefined;
  cataloguePreviews: () => CataloguePreviewService | null;
  systemResources: () => SystemResourceService | null | undefined;
  trackBackground(work: Promise<unknown>): void;
  diagnostics(): Promise<Record<string, unknown>>;
  providerCalls: () => ProviderCallStore | undefined;
  /** Straight to the transport: full call payloads never reach the journal. */
  broadcast(event: DomainEvent): void;
  appRoot: () => string | undefined;
  openPath: () => ((path: string) => void) | undefined;
}) {
  return {
    "refresh-diagnostics": {
      scope: "none",
      handle() {
        // Schedules only; the derivation runs on the next immediate, off this handler's path
        // (R-34), and reaches the asker as the ordinary broadcast.
        deps.snapshot()?.refresh();
        deps.publishRecoveryPolicy();
        const storageHealth = deps.storageHealth(), cataloguePreviews = deps.cataloguePreviews();
        if (storageHealth) deps.trackBackground(storageHealth.refresh());
        if (cataloguePreviews) deps.trackBackground(cataloguePreviews.refreshCleanupScope());
      },
    },
    "refresh-system-resources": {
      scope: "none",
      handle() {
        const systemResources = deps.systemResources();
        if (systemResources) deps.trackBackground(systemResources.refresh());
      },
    },
    "generate-diagnostics": {
      scope: "none",
      async handle() {
        const bundle = await deps.diagnostics();
        ctx.emit({
          at: new Date().toISOString(),
          type: "diagnostics.ready",
          bundle: JSON.stringify(bundle, null, 2),
        });
      },
    },
    "list-provider-calls": {
      scope: "none",
      async handle(msg) {
        const providerCalls = deps.providerCalls();
        const calls =
          (await (msg.jobId === null
            ? providerCalls?.listRecent()
            : providerCalls?.listForJob(msg.jobId))) ?? [];
        // Full payloads are transient: never duplicate them into coordinator.jsonl or support diagnostics.
        deps.broadcast(
          DomainEventSchema.parse({
            at: new Date().toISOString(),
            type: "provider-calls.ready",
            jobId: msg.jobId,
            calls,
          }),
        );
      },
    },
    "open-data-folder": {
      scope: "none",
      handle() {
        const appRoot = deps.appRoot();
        if (appRoot) deps.openPath()?.(appRoot);
      },
    },
    "open-engine-log": {
      scope: "none",
      handle(msg) {
        // Host-owned end to end (SPEC-028 R-4, SPEC-033 R-70): the renderer names the engine and
        // the path never leaves here. Before the engine has said anything there is no file, and
        // opening the folder it will land in is honest about that; the app's own journal is not.
        const appRoot = deps.appRoot();
        if (!appRoot) return;
        const folder = join(appRoot, "logs", "engines");
        const file = join(folder, `${msg.engine}.log`);
        if (existsSync(file)) {
          deps.openPath()?.(file);
        } else {
          try {
            mkdirSync(folder, { recursive: true });
          } catch {
            /* the open below reports the folder as missing, which is the truth */
          }
          deps.openPath()?.(folder);
        }
      },
    },
  } satisfies CommandModule;
}

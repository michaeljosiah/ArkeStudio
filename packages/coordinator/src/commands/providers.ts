import { LLM_ENV_PROVIDERS, type ProviderId, type ProviderPlans } from "@arke-studio/contracts";
import type { AppSettingsFile } from "../app-settings.js";
import type { CredentialStore } from "../credentials/store.js";
import { describeCoordinatorError } from "../errors/user-message.js";
import type { ProviderService } from "../providers/service.js";
import type { ProviderToolService } from "../providers/tool.js";
import type { JobQueue } from "../queue/dispatcher.js";
import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

/** Provider keys and tools: a key saved, cleared and validated; a provider's tool signed in to. No world. */
export function providerCommands(ctx: CommandContext, deps: {
  credentials: CredentialStore | null;
  appRoot: () => string | undefined;
  appSettings: () => AppSettingsFile | null;
  providerService: ProviderService;
  providerTools: Map<ProviderId, ProviderToolService>;
  jobQueue: () => JobQueue | null;
  reportProviderFault(provider: ProviderId, message: string, kind: "not-saved" | "not-cleared"): void;
  readCloudLlmKeys(): Promise<unknown>;
  refreshHarnessEnv(): Promise<void>;
  revalidateToolProvider(provider: ProviderId): Promise<void>;
  adoptProviderPlans(plans: ProviderPlans): void;
  log(entry: { kind: string; provider: string; message: string }): void;
}) {
  return {
    "set-credential": {
      scope: "none",
      async handle(msg) {
        // Write-only (R-5, R-8): the plaintext is registered with the redaction boundary,
        // encrypted, stored under a user-only ACL, and never travels back in any frame.
        //
        // A write that does not land says so (R-6, issue #227). This used to return early with
        // no error, no event and no log line whenever the coordinator had been built without a
        // store: Settings accepted the key, every generation surface went on reporting "no
        // provider with a key", and nothing on screen connected the two. Dropping a write the
        // user just performed, in silence, is the worst of the available behaviours — it is
        // indistinguishable from a rejected key, a typo, or a broken provider.
        if (!deps.credentials) {
          const reason = deps.appRoot()
            ? "this build has no credential storage, so the key was not saved"
            : "this session has no app root, so there is nowhere to save a key";
          // reportProviderFault logs it too — one line, not two.
          deps.reportProviderFault(msg.provider, reason, "not-saved");
          return;
        }
        try {
          await deps.credentials.set(msg.provider, msg.key);
          // A free day the old key was refused, or spent, is not the new key's (design turn 182
          // follow-up): the refusal is forgotten and the day's count starts at the key. Kept in
          // settings beside the plan, so it outlives a restart and reaches every window.
          deps.jobQueue()?.forgetFreeLimits(msg.provider);
          const appSettings = deps.appSettings();
          if (msg.provider === "google" && appSettings) {
            const at = new Date().toISOString();
            deps.adoptProviderPlans(await appSettings.updatePlans((current) => ({ ...current, googleKeySetAt: at })));
          }
          const fingerprint = deps.providerService.setConfigured(msg.provider, true);
          // Admission reads this shared state; publish invalidation before optional I/O yields.
          ctx.emit({ at: new Date().toISOString(), type: "provider.status", providers: deps.providerService.list() });
          // An LLM key change re-delivers the spawn environment, which restarts the harness
          // — the honest cost of rotation (SPEC-005 D5). Media/voice keys leave it alone.
          if ((LLM_ENV_PROVIDERS as readonly string[]).includes(msg.provider)) {
            await deps.readCloudLlmKeys();
            void deps.refreshHarnessEnv();
          }
          await fingerprint;
          ctx.emit({
            at: new Date().toISOString(),
            type: "provider.status",
            providers: deps.providerService.list(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.log({ kind: "credential.store-failed", provider: msg.provider, message });
          // The log alone left the same silence on screen: the store threw, the key was not
          // written, and Settings showed exactly what it had shown a moment earlier.
          deps.reportProviderFault(msg.provider, `the key was not saved — ${describeCoordinatorError(err)}`, "not-saved");
        }
      },
    },
    "clear-credential": {
      scope: "none",
      async handle(msg) {
        if (!deps.credentials) return;
        try {
          await deps.credentials.clear(msg.provider);
          const fingerprint = deps.providerService.setConfigured(msg.provider, false);
          ctx.emit({ at: new Date().toISOString(), type: "provider.status", providers: deps.providerService.list() });
          if ((LLM_ENV_PROVIDERS as readonly string[]).includes(msg.provider)) {
            await deps.readCloudLlmKeys();
            void deps.refreshHarnessEnv();
          }
          await fingerprint;
          ctx.emit({
            at: new Date().toISOString(),
            type: "provider.status",
            providers: deps.providerService.list(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.log({ kind: "credential.clear-failed", provider: msg.provider, message });
          deps.reportProviderFault(msg.provider, `the key was not cleared — ${describeCoordinatorError(err)}`, "not-cleared");
        }
      },
    },
    "validate-provider": {
      scope: "none",
      async handle(msg) {
        // Probes per capability (R-3): the emitted statuses carry what the key unlocks.
        ctx.emit({
          at: new Date().toISOString(),
          type: "provider.status",
          providers: deps.providerService.list(),
        });
        await deps.providerService.validate(msg.provider);
        deps.jobQueue()?.forgetUnknownPlanLimit(msg.provider);
        ctx.emit({
          at: new Date().toISOString(),
          type: "provider.status",
          providers: deps.providerService.list(),
        });
      },
    },
    "refresh-provider-tool": {
      scope: "none",
      async handle(msg) {
        const tool = deps.providerTools.get(msg.provider);
        if (!tool) return;
        await tool.refresh();
        await deps.revalidateToolProvider(msg.provider);
      },
    },
    "sign-in-provider-tool": {
      scope: "none",
      async handle(msg) {
        const tool = deps.providerTools.get(msg.provider);
        if (!tool) return;
        // The service publishes each state change through its own callback, so the browser
        // window and its outcome both reach the renderer without this awaiting anything the
        // user is still standing in front of.
        await tool.signIn();
        await deps.revalidateToolProvider(msg.provider);
      },
    },
    "select-provider-workspace": {
      scope: "none",
      async handle(msg) {
        const tool = deps.providerTools.get(msg.provider);
        if (!tool) return;
        await tool.selectWorkspace(msg.workspaceId);
      },
    },
    "cancel-provider-tool-sign-in": { scope: "none", handle(msg) { deps.providerTools.get(msg.provider)?.cancelSignIn(); } },
  } satisfies CommandModule;
}

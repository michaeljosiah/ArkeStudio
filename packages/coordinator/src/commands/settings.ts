import { modelEligible, modelForCapability, samplingProblems, type ClientState, type ModelManifest } from "@arke-studio/contracts";
import { comfyUiRecipeById } from "@arke-studio/providers";
import { routingFaults, type AppSettingsFile } from "../app-settings.js";
import type { LanguageModelSelection } from "../harness/model-catalog.js";
import type { AdapterLibrary } from "../local-ai/adapter-library.js";
import type { ReadModel } from "../read-model.js";
import { evaluateSpend, type LedgerRead } from "../spend/analytics.js";
import type { WorldStore } from "../world/store.js";
import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

/**
 * Studio settings: routing defaults and enabled models, research and image inspection, local
 * sampling, adapters, agent configuration, the harness model list and the spend threshold.
 * Application settings, but for a world's own image inspection, which is the open world's.
 */
export function settingsCommands(ctx: CommandContext, deps: {
  appSettings: () => AppSettingsFile | null;
  manifest: () => ModelManifest | undefined;
  app: () => ClientState["app"];
  seedAppConfig(config: Parameters<ReadModel["seedAppConfig"]>[0]): void;
  broadcastSnapshot(): void;
  refreshIfStillOpen(store: WorldStore): void;
  /** The family and model the next authoring session drafts for (SPEC-019 R-16). */
  routeSkills(routed: ReturnType<typeof modelForCapability>): void;
  setResearchWeb(enabled: boolean): void;
  adapterLibrary: AdapterLibrary | null;
  beginValidatedSettingChange(key: string): { current(): boolean; finish(): void };
  validateLanguageModel(modelId: string, needsImages: boolean): Promise<LanguageModelSelection>;
  /** Keeps the agent overrides and republishes the roster with them. */
  adoptAgents(agents: Record<string, { model?: string; brief?: string }>): void;
  refreshModelCatalog(): Promise<unknown>;
  spendLedgerRead(): Promise<LedgerRead>;
  setSpendAlerted(alerted: boolean): void;
  log(entry: { kind: string; capability: string; reason: string }): void;
}) {
  return {
    "set-routing-default": {
      scope: "none",
      async handle(msg) {
        const appSettings = deps.appSettings(), manifest = deps.manifest();
        if (!appSettings || !manifest) return;
        // SPEC-034 R-15a: eligibility is supplied, never re-derived beside the write. The same
        // `modelEligible` the picker filters with, from the same state the read model publishes —
        // so a default that could not run cannot be stored, whatever put the message on the wire.
        const state = deps.app();
        const chosen = manifest.models.find((m) => m.id === msg.modelId);
        const result = await appSettings.setRoutingDefault(
          msg.capability,
          msg.modelId,
          manifest,
          chosen !== undefined &&
            modelEligible(chosen, {
              providers: state.providers,
              components: state.setup?.components ?? [],
              disabled: state.models.disabled,
              recipes: state.comfyui?.recipes ?? [],
              comfyUiLocality: state.comfyui?.engine.locality,
              gated: state.runtime?.models ?? [],
            }),
        );
        if (!result.ok) {
          deps.log({
            kind: "routing.refused",
            capability: msg.capability,
            reason: result.reason,
          });
        }
        const settings = await appSettings.load();
        // The family the next authoring session drafts for follows the routed model (R-16).
        deps.routeSkills(modelForCapability(manifest, settings.routing, "video"));
        ctx.emit({
          at: new Date().toISOString(),
          type: "routing.changed",
          routing: settings.routing,
          faults: routingFaults(settings, manifest),
        });
      },
    },
    "set-research-web": {
      scope: "none",
      async handle(msg) {
        const appSettings = deps.appSettings();
        if (!appSettings) return;
        const settings = await appSettings.setResearchWeb(msg.enabled);
        // The harness half of the same switch. Without this line the toggle would move on screen
        // and in the file while every session still opened with the confinement it had at start —
        // turning research on and being refused anyway, which is the failure this setting has
        // already had once. The MCP tool asks settings per call and needs no equivalent.
        deps.setResearchWeb(settings.research.web);
        deps.seedAppConfig({ research: settings.research });
        deps.broadcastSnapshot();
      },
    },
    "set-image-inspection": {
      scope: "none",
      async handle(msg) {
        const appSettings = deps.appSettings();
        if (!appSettings) return;
        const settings = await appSettings.setImageInspection(msg.enabled, msg.provider);
        deps.seedAppConfig({ imageInspection: settings.imageInspection });
        deps.broadcastSnapshot();
      },
    },
    "set-world-image-inspection": {
      scope: "open-world",
      async handle(msg, store) {
        await store.commit({ kind: "world-image-inspection", source: "settings", files: [],
          worldFields: { cloudImageInspection: msg.enabled }, raiseSchemaVersion: 52 });
        deps.refreshIfStillOpen(store);
      },
    },
    "set-local-sampling": {
      scope: "none",
      async handle(msg) {
        const appSettings = deps.appSettings();
        if (!appSettings) return;
        // The catalogue is the authority, as it is for every recipe value: a recipe that offers
        // no sampling, or Custom values outside its bounds and allow-lists, is not stored. The
        // dialog disables Save on the same test (samplingProblems), so this is the guard only.
        const catalogue = comfyUiRecipeById(msg.recipeId)?.sampling;
        if (catalogue === undefined) return;
        const engine = deps.app().comfyui?.engine.samplerOptions;
        if (msg.sampling?.preset === "custom" && samplingProblems(msg.sampling.values!, catalogue, engine).length > 0) return;
        const settings = await appSettings.setLocalSampling(msg.recipeId, msg.sampling);
        deps.seedAppConfig({ localSampling: settings.localSampling });
        deps.broadcastSnapshot();
      },
    },
    "adapter-command": { scope: "none", async handle(msg) { await deps.adapterLibrary?.handle(msg.command).catch(() => {}); } },
    "set-model-enabled": {
      scope: "none",
      async handle(msg) {
        const appSettings = deps.appSettings(), manifest = deps.manifest();
        if (!appSettings || !manifest) return;
        const settings = await appSettings.setModelEnabled(msg.modelId, msg.enabled);
        // Faults ride along: switching a model off can strand a default, and the client shows
        // the two together rather than discovering the second on the next read.
        ctx.emit({
          at: new Date().toISOString(),
          type: "models.changed",
          models: settings.models,
          faults: routingFaults(settings, manifest),
        });
      },
    },
    "set-agent-config": {
      scope: "none",
      async handle(msg) {
        const appSettings = deps.appSettings();
        if (!appSettings) return;
        const modelChange = msg.model !== undefined
          ? deps.beginValidatedSettingChange(JSON.stringify(["agent", msg.agent, "model"])) : undefined;
        const briefChange = msg.brief !== undefined
          ? deps.beginValidatedSettingChange(JSON.stringify(["agent", msg.agent, "brief"])) : undefined;
        try {
          const selected = msg.model ? await deps.validateLanguageModel(msg.model, msg.agent === "stage-designer") : undefined;
          const applyModel = modelChange?.current();
          const applyBrief = briefChange?.current();
          if (!applyModel && !applyBrief) return;
          if (applyModel && selected?.reason) {
            ctx.emit({ at: ctx.nowIso(), type: "command.failed", command: msg.kind, requestId: null, reason: selected.reason });
            return;
          }
          const settings = await appSettings.setAgent(msg.agent, {
            ...(applyModel ? { model: selected?.sessionModel ?? msg.model } : {}),
            ...(applyBrief ? { brief: msg.brief } : {}),
          });
          // Sessions already open keep the config they were started with; the next one picks
          // this up. Said plainly in the UI rather than pretended away.
          deps.adoptAgents(settings.agents);
          deps.broadcastSnapshot();
        } finally {
          modelChange?.finish();
          briefChange?.finish();
        }
      },
    },
    "list-harness-models": { scope: "none", async handle() { await deps.refreshModelCatalog().catch(() => {}); } },
    "set-spend-threshold": {
      scope: "none",
      async handle(msg) {
        const appSettings = deps.appSettings();
        if (!appSettings) return;
        const settings = await appSettings.setSpend(msg.thresholdMicroUsd, msg.periodDays, msg.onePressMicroUsd);
        const spend = evaluateSpend(await deps.spendLedgerRead(), settings.spend, new Date());
        // A new threshold is a new crossing: the latch follows the figure this evaluation
        // actually measured, so lowering the threshold onto existing spend still alerts.
        if (!spend.ledgerUnavailable) deps.setSpendAlerted(spend.alerted);
        ctx.emit({ at: new Date().toISOString(), type: "spend.status", spend });
      },
    },
  } satisfies CommandModule;
}

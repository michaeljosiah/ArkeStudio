import { modelEligible, modelForCapability, ulid, type ClientState, type FrameRunQuote, type ModelManifest } from "@arke-studio/contracts";
import type { AppSettingsFile } from "../app-settings.js";
import { describeCoordinatorError } from "../errors/user-message.js";
import {
  abortFrameRunStart,
  advanceFrameRun,
  cancelFrameRun,
  dismissFrameRun,
  listFrameRuns,
  pauseFrameRun,
  quoteFrameRun,
  resumeFrameRun,
  retryFrameCell,
  retryFrameStep,
  startFrameRun,
  type CompileFrameRunInput,
  type FrameRunDriverDeps,
} from "../productions/frame-run.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { WorldStore } from "../world/store.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/**
 * A scene's frame runs: quoting, starting, pausing, resuming, cancelling, retrying, listing and
 * dismissing. Open world only. A quote and a start answer a world that is not open with their own
 * event, which the screen waits on by its request, so those two check the world themselves.
 */
export function frameRunCommands(ctx: CommandContext, deps: {
  manifest: () => ModelManifest | undefined;
  appSettings: () => AppSettingsFile | null;
  app: () => ClientState["app"];
  freezeLocalIdentity(input: EnqueueInput): EnqueueInput;
  /** Quotes by id, until a start consumes one. */
  quotes: Map<string, FrameRunQuote>;
  jobs: Parameters<typeof startFrameRun>[1]["jobs"];
  cancelJob(jobId: string): Promise<void>;
  driver(): FrameRunDriverDeps;
  emitFrameRun(store: WorldStore, worldId: string, productionId: string, runId: string): Promise<void>;
  log(entry: { kind: string; runId?: string; reason: string; detail?: Record<string, unknown> }): void;
}) {
  const quoteOrStart = async (msg: CommandOf<"frame-run-quote" | "frame-run-start">) => {
    let startResultEmitted = false;
    const emitStartResult = (
      result: { disposition: "accepted"; runId: string } | { disposition: "refused"; reason: string },
    ): void => {
      if (msg.kind !== "frame-run-start" || startResultEmitted) return;
      startResultEmitted = true;
      ctx.emit({
        at: new Date().toISOString(),
        type: "production.frame-run-start-result",
        requestId: msg.requestId,
        quoteId: msg.quoteId,
        worldId: msg.worldId,
        productionId: msg.productionId,
        ...result,
      });
    };
    const open = ctx.openStore() ?? null;
    const store = open?.worldId === msg.worldId ? open : null;
    const manifest = deps.manifest();
    const emitBlockedQuote = (reason: string): void => {
      if (msg.kind !== "frame-run-quote") return;
      const quote: FrameRunQuote = {
        requestId: msg.requestId,
        quoteId: ulid(),
        signature: null,
        worldId: msg.worldId,
        productionId: msg.productionId,
        sceneId: msg.sceneId,
        sceneVersion: null,
        mode: msg.mode,
        modelId: msg.modelId,
        scope: msg.scope,
        ...(msg.shotId !== undefined ? { shotId: msg.shotId } : {}),
        includedCount: 0,
        steps: [],
        estimatedMicroUsd: null,
        blockedReason: reason,
        quotedAt: new Date().toISOString(),
      };
      deps.quotes.set(quote.quoteId, quote);
      ctx.emit({ at: new Date().toISOString(), type: "production.frame-run-quote", quote });
    };
    if (!store || !manifest) {
      const reason = "The frame run cannot be quoted while its world or model catalogue is unavailable.";
      emitBlockedQuote(reason);
      emitStartResult({ disposition: "refused", reason });
      return;
    }
    const model = manifest.models.find((candidate) => candidate.id === msg.modelId);
    if (!model) {
      emitBlockedQuote("The production, scene, or selected model is no longer available.");
      emitStartResult({ disposition: "refused", reason: "The selected model is no longer available." });
      return;
    }
    try {
      const appSettings = deps.appSettings();
      const settings = appSettings ? await appSettings.load() : null;
      const app = deps.app();
      const compile = (): CompileFrameRunInput => {
        const bundle = store.getBundle();
        const production = bundle.productions.find((candidate) => candidate.meta.id === msg.productionId);
        const scene = production?.scenes.find((candidate) => candidate.id === msg.sceneId);
        if (!production || !scene) throw new Error("The production or scene is no longer available.");
        const videoModelId = production.meta.models?.video ?? modelForCapability(manifest, settings?.routing, "video")?.id;
        const videoModel = manifest.models.find((candidate) => candidate.id === videoModelId);
        const localIdentity = deps.freezeLocalIdentity({
          worldId: msg.worldId,
          productionId: msg.productionId,
          target: { kind: "shot", id: scene.id },
          capability: "image",
          provider: model.provider,
          model: model.id,
          params: {},
          estimatedMicroUsd: 0,
        });
        return {
          worldId: msg.worldId,
          productionId: msg.productionId,
          scene,
          production,
          world: bundle,
          model,
          mode: msg.mode,
          scope: msg.scope,
          ...(msg.shotId !== undefined ? { shotId: msg.shotId } : {}),
          boardCapSec: videoModel?.limits.maxDurationSec ?? 10,
          boardPanelCap: videoModel?.limits.storyboardPanels,
          eligible: modelEligible(model, {
            providers: app.providers,
            components: app.setup?.components ?? [],
            disabled: app.models.disabled,
            recipes: app.comfyui?.recipes ?? [],
            comfyUiLocality: app.comfyui?.engine.locality,
            gated: app.runtime?.models ?? [],
          }),
          ...(localIdentity.recipe !== undefined ? { recipe: localIdentity.recipe } : {}),
          ...(localIdentity.engine !== undefined ? { engine: localIdentity.engine } : {}),
          clock: () => new Date().toISOString(),
        };
      };
      if (msg.kind === "frame-run-quote") {
        const quote = await quoteFrameRun(store, {
          requestId: msg.requestId,
          quoteId: ulid(),
          worldId: msg.worldId,
          productionId: msg.productionId,
          sceneId: msg.sceneId,
          mode: msg.mode,
          modelId: msg.modelId,
          scope: msg.scope,
          ...(msg.shotId !== undefined ? { shotId: msg.shotId } : {}),
          clock: () => new Date().toISOString(),
          compile,
        });
        deps.quotes.set(quote.quoteId, quote);
        ctx.emit({ at: new Date().toISOString(), type: "production.frame-run-quote", quote });
        return;
      }
      const run = await startFrameRun(store, {
        quotedMicroUsd: msg.quotedMicroUsd,
        quoteSignature: msg.quoteSignature,
        jobs: deps.jobs,
        consumeQuote: () => {
          const quote = deps.quotes.get(msg.quoteId);
          if (quote?.requestId !== msg.requestId) return undefined;
          deps.quotes.delete(msg.quoteId);
          return quote;
        },
        compile,
      });
      try {
        const advanced = await advanceFrameRun(store, msg.productionId, run.id, deps.driver());
        if (advanced?.steps[0]?.jobId === null || advanced?.steps[0]?.jobId === undefined) {
          throw new Error("the first frame-run step was not accepted by the queue");
        }
      } catch (error) {
        const jobId = await abortFrameRunStart(
          store,
          msg.productionId,
          run.id,
          deps.jobs,
        );
        if (jobId !== null) await deps.cancelJob(jobId).catch(() => {});
        throw error;
      }
      emitStartResult({ disposition: "accepted", runId: run.id });
      await deps.emitFrameRun(store, msg.worldId, msg.productionId, run.id).catch((error) => {
        deps.log({
          kind: "frame-run.state-emit-failed",
          runId: run.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    } catch (err) {
      emitStartResult({ disposition: "refused", reason: describeCoordinatorError(err) });
      deps.log({
        kind: "frame-run.refused",
        reason: err instanceof Error ? err.message : String(err),
        detail: { productionId: msg.productionId, sceneId: msg.sceneId },
      });
    }
  };
  const retry = async (msg: CommandOf<"frame-run-retry-step" | "frame-run-retry-cell">, store: WorldStore) => {
    const driver = deps.driver();
    try {
      const getProduction = () => store.getBundle().productions.find((candidate) => candidate.meta.id === msg.productionId);
      if (msg.kind === "frame-run-retry-step") {
        await retryFrameStep(store, msg.productionId, msg.runId, msg.stepIndex, getProduction, driver.jobById);
      } else {
        await retryFrameCell(store, msg.productionId, msg.runId, msg.stepIndex, msg.shotId, getProduction, driver.jobById);
      }
      await advanceFrameRun(store, msg.productionId, msg.runId, driver);
      await deps.emitFrameRun(store, msg.worldId, msg.productionId, msg.runId);
    } catch (err) {
      await deps.emitFrameRun(store, msg.worldId, msg.productionId, msg.runId).catch(() => {});
      deps.log({
        kind: "frame-run.retry-refused",
        reason: err instanceof Error ? err.message : String(err),
        detail: { runId: msg.runId, stepIndex: msg.stepIndex },
      });
    }
  };
  return {
    "frame-run-quote": { scope: "any-world", handle: quoteOrStart },
    "frame-run-start": { scope: "any-world", handle: quoteOrStart },
    "frame-run-pause": {
      scope: "open-world",
      async handle(msg, store) {
        await pauseFrameRun(store, msg.productionId, msg.runId);
        await deps.emitFrameRun(store, msg.worldId, msg.productionId, msg.runId);
      },
    },
    "frame-run-resume": {
      scope: "open-world",
      async handle(msg, store) {
        await resumeFrameRun(store, msg.productionId, msg.runId);
        await advanceFrameRun(store, msg.productionId, msg.runId, deps.driver());
        await deps.emitFrameRun(store, msg.worldId, msg.productionId, msg.runId);
      },
    },
    "frame-run-cancel": {
      scope: "open-world",
      async handle(msg, store) {
        const driver = deps.driver();
        await cancelFrameRun(store, msg.productionId, msg.runId, {
          jobById: driver.jobById,
          cancel: async (jobId) => { await deps.cancelJob(jobId); },
        });
        await deps.emitFrameRun(store, msg.worldId, msg.productionId, msg.runId);
      },
    },
    "frame-run-retry-step": { scope: "open-world", handle: retry },
    "frame-run-retry-cell": { scope: "open-world", handle: retry },
    "frame-run-list": {
      scope: "open-world",
      async handle(msg, store) {
        for (const run of await listFrameRuns(store, msg.productionId)) {
          await advanceFrameRun(store, msg.productionId, run.id, deps.driver()).catch(() => {});
          await deps.emitFrameRun(store, msg.worldId, msg.productionId, run.id);
        }
      },
    },
    "frame-run-dismiss": {
      scope: "open-world",
      async handle(msg, store) {
        try {
          if (await dismissFrameRun(store, msg.productionId, msg.runId, deps.jobs)) {
            await deps.emitFrameRun(store, msg.worldId, msg.productionId, msg.runId);
          }
        } catch (err) {
          deps.log({
            kind: "frame-run.dismiss-refused",
            reason: err instanceof Error ? err.message : String(err),
            detail: { runId: msg.runId },
          });
        }
      },
    },
  } satisfies CommandModule;
}

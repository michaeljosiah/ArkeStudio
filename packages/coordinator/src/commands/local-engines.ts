import { join } from "node:path";
import { normalizeOllamaUrl, type ComfyUiSettings, type VoxaSettings } from "@arke-studio/contracts";
import type { AppSettingsFile } from "../app-settings.js";
import type { ComfyUiEngineService } from "../comfyui/engine.js";
import type { LocalGpu } from "../local-ai/gpu.js";
import type { OllamaEngineService } from "../local-ai/ollama.js";
import type { DispatchClient } from "../queue/dispatcher.js";
import type { LocalSetupService } from "../setup/local-setup.js";
import type { SidecarLike, VoiceService } from "../voice/service.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/** The local engines: Voxa, ComfyUI and Ollama, their runtimes and the models folder. No world. */
export function localEngineCommands(ctx: CommandContext, deps: {
  appSettings: () => AppSettingsFile | null;
  voice: () => {
    sidecar: SidecarLike | null;
    chooseExecutable?: () => Promise<string | null>;
    applySettings?: (settings: VoxaSettings) => Promise<void>;
    restart?: () => Promise<void>;
  } | undefined;
  voiceService: () => VoiceService | null;
  comfyui: () => {
    service: ComfyUiEngineService;
    choosePath?: () => Promise<string | null>;
    chooseModelsDir?: () => Promise<string | null>;
  } | undefined;
  ollama: () => {
    service: OllamaEngineService;
    reconfigureHarness?: (apply?: () => Promise<void>) => Promise<void>;
  } | undefined;
  dispatchClients: () => Record<string, DispatchClient> | undefined;
  localGpu: LocalGpu;
  runtimeStop: AbortSignal;
  setup: () => LocalSetupService | null;
  applyComfyUiPatch(patch: Partial<ComfyUiSettings>): Promise<void>;
  refreshComfyUi(): Promise<void>;
  appRoot: () => string | undefined;
  openPath: () => ((path: string) => void) | undefined;
}) {
  const useBundledVoxa = async () => {
    const appSettings = deps.appSettings(), voice = deps.voice();
    if (!appSettings || !voice?.applySettings) return;
    const settings = await appSettings.setVoxa({ executablePath: null, backend: "voxa" });
    await voice.applySettings(settings.voxa).catch(() => {});
  };
  const setOllamaEngine = async (msg: CommandOf<"set-ollama-url" | "clear-ollama-engine">) => {
    const service = deps.ollama()?.service;
    const settingsFile = deps.appSettings();
    if (!service || !settingsFile) return;
    const engineUrl = msg.kind === "clear-ollama-engine" ? null : normalizeOllamaUrl(msg.url);
    if (msg.kind === "set-ollama-url" && engineUrl === null) return;
    if ((await settingsFile.load()).ollama.engineUrl === engineUrl) return;
    if (deps.localGpu.isBusy("Ollama")) {
      ctx.emit({ at: ctx.nowIso(), type: "ollama.status", ollama: { ...service.status(), detail: "Finish or cancel local language work before changing its runtime." } });
      return;
    }
    const release = await deps.localGpu.acquire("Ollama", deps.runtimeStop);
    try {
      const apply = async () => {
        if (service.baseUrl() !== null || service.externallySelected()) await deps.dispatchClients()?.ollama?.unload?.(deps.runtimeStop);
        const previous = (await settingsFile.load()).ollama;
        const settings = await settingsFile.setOllama({ engineUrl });
        deps.runtimeStop.throwIfAborted();
        try { await service.applySettings(settings.ollama); }
        catch (error) { await settingsFile.setOllama(previous); throw error; }
        await deps.setup()?.detect();
      };
      const reconfigureHarness = deps.ollama()?.reconfigureHarness;
      if (reconfigureHarness) await reconfigureHarness(apply);
      else await apply();
    } finally { release(); }
  };
  return {
    "choose-voxa-executable": {
      scope: "none",
      async handle() {
        const appSettings = deps.appSettings(), voice = deps.voice();
        if (!appSettings || !voice?.chooseExecutable || !voice.applySettings) return;
        const executablePath = await voice.chooseExecutable().catch(() => null);
        if (executablePath === null) return;
        const settings = await appSettings.setVoxa({ executablePath, backend: "voxa" });
        await voice.applySettings(settings.voxa).catch(() => {});
      },
    },
    "clear-voxa-executable": { scope: "none", handle: useBundledVoxa },
    "use-bundled-voxa": { scope: "none", handle: useBundledVoxa },
    "restart-voxa": { scope: "none", async handle() { await deps.voice()?.restart?.().catch(() => {}); } },
    "choose-comfyui-path": {
      scope: "none",
      async handle() {
        const comfyui = deps.comfyui();
        if (!deps.appSettings() || !comfyui?.choosePath) return;
        const enginePath = await comfyui.choosePath().catch(() => null);
        if (enginePath === null) return;
        await deps.applyComfyUiPatch({ enginePath, engineUrl: null });
      },
    },
    "choose-comfyui-models-dir": {
      scope: "none",
      async handle() {
        const comfyui = deps.comfyui();
        if (!deps.appSettings() || !comfyui?.chooseModelsDir) return;
        const modelsDir = await comfyui.chooseModelsDir().catch(() => null);
        if (modelsDir === null) return;
        await deps.applyComfyUiPatch({ modelsDir });
      },
    },
    "clear-comfyui-models-dir": { scope: "none", async handle() { await deps.applyComfyUiPatch({ modelsDir: null }); } },
    "set-comfyui-url": {
      scope: "none",
      async handle(msg) {
        // A URL is user-typed data, not a filesystem path; loopback and LAN engines only would
        // be a lie — the spec allows anywhere reachable (§1.2) — but it must at least parse.
        let parsed: URL;
        try {
          parsed = new URL(msg.url);
        } catch {
          return;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        await deps.applyComfyUiPatch({ engineUrl: msg.url, enginePath: null });
      },
    },
    "clear-comfyui-engine": { scope: "none", async handle() { await deps.applyComfyUiPatch({ enginePath: null, engineUrl: null }); } },
    "set-ollama-url": { scope: "none", handle: setOllamaEngine },
    "clear-ollama-engine": { scope: "none", handle: setOllamaEngine },
    "ollama-refresh": {
      scope: "none",
      async handle() {
        const service = deps.ollama()?.service;
        if (!service) return;
        // A health check loads no model. Opening Settings must not evict ComfyUI/Ming or
        // wait behind creative work merely to read the selected service's version.
        if (service.externallySelected() || service.status().state === "ready") { await service.refresh(); return; }
        if (deps.localGpu.isBusy("Ollama")) return;
        const release = await deps.localGpu.acquire("Ollama", deps.runtimeStop);
        try { await service.refresh(); }
        finally { release(); }
      },
    },
    "ollama-update-runtime": {
      scope: "none",
      async handle() {
        const service = deps.ollama()?.service, setup = deps.setup();
        if (!service || !setup || !deps.appSettings() || deps.localGpu.isBusy("Ollama")) return;
        // A selected user service is never stopped or modified by a managed-runtime update.
        const external = service.externallySelected();
        try {
          // Setup's installation owner acquires/drains the lane and confirms stop. Taking an
          // outer lease here would reject our own busy check, then deadlock on reacquisition.
          await setup.updateTree("ollama-runtime");
        } finally { if (!external && !ctx.stopping()) await service.refresh(); }
      },
    },
    "use-detected-comfyui": {
      scope: "none",
      async handle(msg) {
        // Only a location the host itself just discovered and published (SPEC-021 D10): the
        // renderer selects among offers, it does not originate paths.
        const service = deps.comfyui()?.service;
        if (!service) return;
        const offered = service.engineStatus().detected.find((d) => d.location === msg.location);
        if (!offered) return;
        const isUrl = /^https?:\/\//i.test(offered.location);
        await deps.applyComfyUiPatch(
          isUrl
            ? { engineUrl: offered.location, enginePath: null }
            : { enginePath: offered.location, engineUrl: null },
        );
      },
    },
    "comfyui-restart": {
      scope: "none",
      async handle() {
        if (!deps.appSettings() || !deps.comfyui()) return;
        // Re-applying the settings *is* the restart: `applySettingsOnce` stops supervision,
        // resolves the selection again and starts the child, whether or not anything changed.
        await deps.applyComfyUiPatch({});
      },
    },
    "comfyui-refresh": {
      scope: "none",
      async handle() {
        const comfyui = deps.comfyui();
        if (!deps.appSettings() || !comfyui) return;
        // A manual check must measure connectivity now, not wait for the URL poll. With no
        // selected engine it also repeats default-port discovery for ComfyUI started after Arke.
        await comfyui.service.checkNow().catch(() => {});
        await deps.setup()?.detect().catch(() => {});
        await deps.refreshComfyUi();
      },
    },
    "comfyui-verify-recipe": {
      scope: "none",
      async handle(msg) {
        const service = deps.comfyui()?.service;
        if (!service) return;
        await service.reverify([msg.recipeId], true).catch(() => {});
        await deps.refreshComfyUi();
      },
    },
    "comfyui-update-runtime": {
      scope: "none",
      async handle() {
        const service = deps.comfyui()?.service, setup = deps.setup(), appSettings = deps.appSettings();
        if (!service || !setup || !appSettings) return;
        if (deps.localGpu.isBusy("ComfyUI")) throw new Error("Finish or cancel ComfyUI work before updating its runtime.");
        const release = await deps.localGpu.acquire("ComfyUI", deps.runtimeStop);
        try {
          // Only Arke's managed child is stopped; an explicitly selected URL/path keeps
          // its owner's lifecycle. Ming has already exited before the tree can move.
          const stopped = await service.stopManagedSupervision();
          try { await setup.updateTree("comfyui-runtime"); }
          finally {
            if (stopped && !ctx.stopping()) {
              const settings = await appSettings.load();
              await service.applySettings(settings.comfyui);
            }
          }
          await setup.detect();
          await deps.refreshComfyUi();
        } finally { release(); }
      },
    },
    "open-model-folder": {
      scope: "none",
      handle() {
        const appRoot = deps.appRoot();
        if (appRoot) deps.openPath()?.(join(appRoot, "models"));
      },
    },
    "test-local-voice": {
      scope: "none",
      async handle(msg) {
        const base = {
          at: new Date().toISOString(),
          type: "voice.runtime-test" as const,
          requestId: msg.requestId,
        };
        ctx.emit({ ...base, status: "testing", detail: "Testing Voxa voice synthesis", audioBase64: null });
        try {
          const sidecar = deps.voice()?.sidecar, voiceService = deps.voiceService();
          if (!sidecar || !voiceService) throw new Error("Voxa is unavailable");
          const voices = await sidecar.listVoices();
          const voice = voices[0];
          if (!voice) throw new Error("Voxa returned no compatible voices");
          // Through the voice service's lane, not straight to the engine (codex on PR 1183): a
          // test pressed while a read or a run is synthesising would otherwise be the second
          // request at once that leaves the engine unavailable for the rest of the process.
          const audio = await voiceService.synthesizeOnce({
            voiceId: voice.id,
            text: "The harbour remembers.",
          });
          if (audio.byteLength < 44) throw new Error("Voxa returned invalid audio");
          ctx.emit({
            ...base,
            status: "ready",
            detail: "Local voice is ready",
            audioBase64: Buffer.from(audio).toString("base64"),
          });
        } catch {
          ctx.emit({
            ...base,
            status: "failed",
            detail: "Local voice test failed. Check the runtime and model states below.",
            audioBase64: null,
          });
        }
      },
    },
  } satisfies CommandModule;
}

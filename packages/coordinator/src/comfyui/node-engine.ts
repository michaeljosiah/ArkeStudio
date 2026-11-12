import { randomUUID } from "node:crypto";
import { stat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMFYUI_RECIPES, comfyUiRecipeIdentity, recipeNodeClasses, type ProviderClientDeps } from "@arke-studio/providers";
import { ChildSupervisor, registerExitBackstop, type SupervisorDeps } from "../supervisor.js";
import { ComfyUiEngineService } from "./engine.js";
import { ComfyUiDigestCache } from "./digest-cache.js";
import { createComfyUiFetch } from "./node-transport.js";
import { readCustomNodeRef } from "./node-ref.js";
import { comfyUiWeightCatalogue } from "./setup.js";

/** Node hosts own the same managed engine, verified files and scoped transport as desktop. */
export function createNodeComfyUiEngine(appRoot: string, deps: SupervisorDeps = {}) {
  const scopedFetch = createComfyUiFetch((url, init) => fetch(url, init));
  const digests = new ComfyUiDigestCache(appRoot);
  const service = new ComfyUiEngineService({ appRoot,
    recipes: COMFYUI_RECIPES.map(recipe => ({
      id: recipe.id, displayName: recipe.displayName, capability: recipe.capability, version: recipe.recipeVersion,
      minEngineVersion: recipe.engine.minVersion, exercisedThroughVersion: recipe.engine.exercisedThroughVersion,
      minVramMb: recipe.hardware.minVramMb, recommendedVramMb: recipe.hardware.recommendedVramMb,
      ...(recipe.hardware.accelerator ? { accelerator: recipe.hardware.accelerator } : {}),
      ...(recipe.hardware.minMemMb !== undefined ? { minMemMb: recipe.hardware.minMemMb } : {}),
      checkpoints: recipe.requires.checkpoints, customNodes: recipe.requires.customNodes,
      ...(recipe.requires.unavailableReason ? { unavailableReason: recipe.requires.unavailableReason } : {}),
      nodeClasses: recipeNodeClasses(recipe), identity: comfyUiRecipeIdentity(recipe),
    })),
    fetch: scopedFetch,
    fileExists: async path => (await stat(path).catch(() => null)) !== null,
    listDirectories: async path => (await readdir(path, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory()).map(entry => entry.name),
    hashFile: (path, signal, force) => digests.hashFile(path, signal, force),
    writeTextFile: (path, text) => writeFile(path, text, "utf8"), readNodeRef: readCustomNodeRef,
    createSupervisor: spec => new ChildSupervisor({ ...spec, logFile: join(appRoot, "logs", "engines", `${spec.id}.log`) }, deps),
    registerSupervisorExitBackstop: registerExitBackstop, createProcessEpoch: randomUUID,
  });
  const client: NonNullable<ProviderClientDeps["comfyui"]> = {
    fetch: scopedFetch, baseUrl: model => service.baseUrl(model), allBaseUrls: () => service.baseUrls(),
    isEndpointGone: url => service.isManagedEndpointGone(url), preflight: recipe => service.preflight(recipe),
    locality: () => service.engineStatus().locality,
    openSocket: url => {
      const socket = new WebSocket(url);
      const adapter = { onMessage: null as ((data: string) => void) | null, onClose: null as (() => void) | null, close: () => socket.close() };
      socket.addEventListener("message", event => { if (typeof event.data === "string") adapter.onMessage?.(event.data); });
      socket.addEventListener("close", () => adapter.onClose?.());
      socket.addEventListener("error", () => adapter.onClose?.());
      return adapter;
    },
  };
  return { service, client, weights: comfyUiWeightCatalogue(COMFYUI_RECIPES) };
}

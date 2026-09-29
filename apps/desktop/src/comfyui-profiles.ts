import { comfyUiRecipeById } from "@arke-studio/providers";
import type { EngineServiceDeps } from "@arke-studio/coordinator";
import { execFile } from "node:child_process";

export function largestCudaDevice(output: string): string | null {
  const devices = output.trim().split(/\r?\n/).flatMap(line => {
    const [uuid, rawMemory] = line.split(",").map(value => value.trim());
    const memory = Number(rawMemory);
    return uuid && /^GPU-[0-9a-f-]+$/i.test(uuid) && Number.isFinite(memory) && memory > 0 ? [{ uuid, memory }] : [];
  });
  devices.sort((a, b) => b.memory - a.memory);
  return devices[0]?.uuid ?? null;
}

export function detectQwenCudaDevice(): Promise<string | null> {
  return new Promise(resolve => execFile("nvidia-smi", ["--query-gpu=uuid,memory.total", "--format=csv,noheader,nounits"],
    { timeout: 5_000, windowsHide: true }, (error, stdout) => resolve(error ? null : largestCudaDevice(String(stdout)))));
}

export function cudaFreeMemoryArgs(device: string | null): string[] {
  return ["--query-gpu=memory.free", "--format=csv,noheader,nounits", ...(device ? ["--id", device] : [])];
}

/** The same packaged launch profile is used by desktop composition and its GPU smoke check. */
export function qwenEngineProfile(customNodesDir: string, cudaDevice: string | null = null): { model: string; launch: NonNullable<EngineServiceDeps["launch"]> } {
  const recipe = comfyUiRecipeById("comfyui-qwen21-image")!;
  return {
    model: recipe.id,
    launch: {
      id: "comfyui-qwen21",
      args: [...(cudaDevice ? ["--cuda-device", cudaDevice] : []), "--disable-dynamic-vram", "--disable-pinned-memory", "--disable-async-offload", "--disable-cuda-malloc", "--reserve-vram", "4.5", "--disable-all-custom-nodes", "--whitelist-custom-nodes", "ArkeQwen21Runtime"],
      customNodesDir,
      nodeRefs: Object.fromEntries(recipe.requires.customNodes.map(node => [node.id, node.pinnedRef])),
    },
  };
}

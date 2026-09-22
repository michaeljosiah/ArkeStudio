import { comfyUiRecipeById } from "@arke-studio/providers";
import type { EngineServiceDeps } from "@arke-studio/coordinator";

/** The same packaged launch profile is used by desktop composition and its GPU smoke check. */
export function qwenEngineProfile(customNodesDir: string): { model: string; launch: NonNullable<EngineServiceDeps["launch"]> } {
  const recipe = comfyUiRecipeById("comfyui-qwen21-image")!;
  return {
    model: recipe.id,
    launch: {
      id: "comfyui-qwen21",
      args: ["--disable-dynamic-vram", "--disable-pinned-memory", "--disable-async-offload", "--disable-cuda-malloc", "--reserve-vram", "4.5", "--disable-all-custom-nodes", "--whitelist-custom-nodes", "ArkeQwen21Runtime"],
      customNodesDir,
      nodeRefs: Object.fromEntries(recipe.requires.customNodes.map(node => [node.id, node.pinnedRef])),
    },
  };
}

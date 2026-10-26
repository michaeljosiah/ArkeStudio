import { MING_MODELS } from "@arke-studio/contracts";
import assets from "./ming-assets.json" with { type: "json" };
import type { CatalogueEntry, DownloadFile } from "../setup/catalogue.js";

export { assets as MING_ASSETS };
const file = (row: { url: string; file: string; bytes: number; sha256: string }): DownloadFile =>
  ({ url: row.url, file: row.file, sha256: row.sha256, sizeMb: row.bytes / 1_000_000 });

/** Immutable downloads only. The worker extracts its private overlay; no pip targets ComfyUI. */
export function mingCatalogue(): CatalogueEntry[] {
  return Object.entries(MING_MODELS).flatMap(([model, info]) => {
    const variant = assets.variants[info.variant];
    const runtimeFiles = [assets.source, ...variant.wheels, ...(info.variant === "tiny" ? [assets.sdk] : [])];
    const runtimeId = `ming-runtime-${info.variant}`;
    return [
      { id: runtimeId, displayName: `${info.label} · dependencies`, purpose: "Isolated speech packages using Arke's shared Python and CUDA",
        engine: "comfyui", optional: true, requires: ["comfyui-runtime"], provides: [model], sizeMb: Math.ceil(runtimeFiles.reduce((n, row) => n + row.bytes, 0) / 1_000_000),
        installedMb: Math.ceil(runtimeFiles.reduce((n, row) => n + row.bytes, 0) / 1_000_000) + (info.variant === "tiny" ? 800 : 400),
        caveat: "Qualified on Arke-managed ComfyUI 0.38.0 · Windows x64 · NVIDIA CUDA · Python 3.13",
        spec: { kind: "files", dir: `ming/runtime/${info.variant}`, files: runtimeFiles.map(file) } },
      { id: info.component, displayName: info.label, purpose: "Reads saved voice recordings locally, including narration in parts",
        engine: "comfyui", optional: true, requires: [runtimeId], provides: [model], sizeMb: Math.ceil(variant.models.reduce((n, row) => n + row.bytes, 0) / 1_000_000),
        caveat: info.variant === "tiny" ? "7.9B total / 1.3B active · about 18 GB · experimental: some tested passages stopped early; review the words" : "Original 0.5B dense weights · about 3 GB",
        spec: { kind: "files", dir: `ming/models/${info.variant}`, files: variant.models.map(file) } },
    ] satisfies CatalogueEntry[];
  });
}

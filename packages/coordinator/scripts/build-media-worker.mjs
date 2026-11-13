import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
await build({ entryPoints: [resolve(root, "packages/coordinator/src/media/effect-raster-worker.ts")],
  outfile: resolve(root, ".dev/effect-raster-worker.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22" });

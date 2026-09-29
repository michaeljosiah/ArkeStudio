import { build } from "esbuild";
import { generateDtsBundle } from "dts-bundle-generator";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({ entryPoints: ["src/index.ts", "src/local.ts"], outdir: "dist", bundle: true,
  platform: "node", format: "esm", target: "node22", external: ["better-sqlite3", "yaml", "zod"],
  banner: { js: 'import { createRequire as __engineCreateRequire } from "node:module"; const require = __engineCreateRequire(import.meta.url);' } });
const entries = ["index", "local"];
const declarations = generateDtsBundle(entries.map(name => ({ filePath: `src/${name}.ts`,
  libraries: { inlinedLibraries: ["@arke-studio/contracts"] }, output: { noBanner: true, exportReferencedTypes: false } })),
  { preferredConfigPath: "tsconfig.json" });
for (const [index, name] of entries.entries()) await writeFile(`dist/${name}.d.ts`, declarations[index]);

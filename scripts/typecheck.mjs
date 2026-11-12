import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The repository's two TypeScript programs, checked side by side (issue 2812): every Node
// workspace as one program, and the client, whose DOM, JSX and bundler resolution make it its
// own. Checked one workspace at a time, eleven programs each re-checked the contracts source they
// import — 356 s in CI. A workspace's own `npm run typecheck -w <dir>` still checks it alone.
//
// Checked with TypeScript 7 (issue 2825), installed as `typescript-7` beside 5.9. It is native and
// about twice as fast on a Windows machine here (64 s against 136 s for the Node program, 52 s
// against 106 s for the client; the review measured about four times on ubuntu), with no error
// either compiler does not share. 5.9 stays for what still needs it: editors, the engine's
// declaration bundle (dts-bundle-generator calls TypeScript's JavaScript API, which 7 does not have)
// and a single workspace's check, whose tsconfig would need `types: ["node"]` under 7.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Found through its package.json: TypeScript 7 exports no `bin/` subpath for resolve() to reach.
const manifest = createRequire(import.meta.url).resolve("typescript-7/package.json");
const tsc = join(dirname(manifest), createRequire(import.meta.url)("typescript-7/package.json").bin.tsc);
const programs = ["tsconfig.node.json", "packages/client/tsconfig.json"];

const codes = await Promise.all(programs.map((project) => new Promise((resolve) => {
  const child = spawn(process.execPath, [tsc, "-p", join(root, project), "--noEmit"], { stdio: "inherit" });
  child.on("error", () => resolve(1));
  child.on("exit", (code, signal) => resolve(code ?? (signal === null ? 0 : 1)));
})));
process.exit(codes.some((code) => code !== 0) ? 1 : 0);

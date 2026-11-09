import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The repository's two TypeScript programs, checked side by side (issue 2812): every Node
// workspace as one program, and the client, whose DOM, JSX and bundler resolution make it its
// own. Checked one workspace at a time, eleven programs each re-checked the contracts source they
// import — 356 s in CI. A workspace's own `npm run typecheck -w <dir>` still checks it alone.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "scripts", "tsc.mjs");
const programs = ["tsconfig.node.json", "packages/client/tsconfig.json"];

const codes = await Promise.all(programs.map((project) => new Promise((resolve) => {
  const child = spawn(process.execPath, [tsc, "-p", join(root, project), "--noEmit"], { stdio: "inherit" });
  child.on("error", () => resolve(1));
  child.on("exit", (code, signal) => resolve(code ?? (signal === null ? 0 : 1)));
})));
process.exit(codes.some((code) => code !== 0) ? 1 : 0);

import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(import.meta.url), repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "arke-story-publish-"));
if (isAbsolute(relative(tmpdir(), root)) || relative(tmpdir(), root).startsWith("..")) throw new Error("Invalid smoke directory");
try {
 if (process.env.ARKE_STORY_LAYOUT_OUTPUT) await mkdir(process.env.ARKE_STORY_LAYOUT_OUTPUT, { recursive: true });
 await build({ stdin: { contents: await readFile(join(repo, "scripts/fixtures/story-publish.tsx"), "utf8"), resolveDir: join(repo, "packages/client"), loader: "tsx" }, bundle: true, outfile: join(root, "app.js"), platform: "browser", format: "iife", jsx: "automatic", loader: { ".woff": "dataurl", ".woff2": "dataurl" }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
 await writeFile(join(root, "index.html"), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script>');
 await build({ entryPoints: [join(repo, "apps/desktop/src/preload.ts")], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: join(root, "preload.cjs"), logLevel: "silent" });
 const main = (await readFile(join(repo, "scripts/fixtures/story-publish-main.txt"), "utf8")).replace("AUTH_MODULE", JSON.stringify(join(repo, "apps/desktop/src/transport-auth.ts")));
 // Bundle the authentication helper alongside the main harness.
 const source = 'import { authenticatedMediaHeaders } from ' + JSON.stringify(join(repo, "apps/desktop/src/transport-auth.ts")) + ';\n' + "(async () => {\n" + main.replace(/^import .*$/gm, "") + "\n})().catch(error => { console.error(error); app.exit(1); });";
 await build({ stdin: { contents: source, resolveDir: repo, loader: "ts" }, banner: { js: 'const assert = require("node:assert/strict"); const { app, BrowserWindow, ipcMain } = require("electron"); const { createServer } = require("node:http"); const { writeFile } = require("node:fs/promises"); const { join } = require("node:path"); setTimeout(() => app.exit(2), 60000).unref();' }, bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: join(root, "main.cjs"), logLevel: "silent" });
 const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
 const child = spawn(require("electron"), [join(root, "main.cjs")], { env, stdio: "inherit", windowsHide: true });
 const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
 if (code !== 0) throw new Error("Private Publish smoke exited " + code);
} finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }

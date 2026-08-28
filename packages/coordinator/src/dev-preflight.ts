import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The check that runs before `dev.ts`, so a broken install fails as itself.
 *
 * `packages/adapter-claude/node_modules/@anthropic-ai/claude-agent-sdk` once existed as a
 * directory holding zero entries — no `package.json`, no code. The coordinator's dev entry
 * reaches that package through `@arke-studio/adapter-claude`, so node threw
 * ERR_MODULE_NOT_FOUND at module load and the process was gone before a line of dev.ts ran.
 * None of that is what the developer saw: the launcher reported "Server started successfully",
 * the Vite client kept serving, and the app came up with an empty manifest, every capability
 * row reading `—`, and a machine header reading `not measured`. That is indistinguishable
 * from a data bug in whatever you just changed, and it cost a verification pass on #594.
 *
 * Hence a check with its own process, before the import graph. It names the package, the
 * directory and the fix, and exits non-zero — an error nobody can mistake for data.
 *
 * Two things it has to get right, both of which cost time to learn (issue 599):
 *
 * - **An empty directory is not a missing one.** `existsSync` on the directory says yes; only
 *   `existsSync` on its `package.json` says no. The junction trick that repairs a worktree's
 *   missing packages succeeds here and resolves to nothing, because the target exists.
 * - **The first `node_modules` wins.** ESM resolution walks up from the importer, and the
 *   first ancestor holding `node_modules/<name>` decides the answer — an empty directory there
 *   throws rather than falling through to a good copy further up. So this walk stops where
 *   node stops, and a root `node_modules/@anthropic-ai` holding a similarly-named `sdk` is
 *   not an answer to a question about `claude-agent-sdk`.
 */

/** One dependency that will not load, and the reason it will not. */
export interface BrokenDependency {
  /** The workspace that declares it, repo-relative and slash-separated. */
  workspace: string;
  /** The package name, exactly as it is declared and imported. */
  name: string;
  /** Where node stops looking, repo-relative — the directory to repair or delete. */
  at: string;
  /** `empty` for a directory with no `package.json`; `missing` for no directory at all. */
  why: "empty" | "missing";
}

/** Every workspace directory named by the root manifest's `workspaces` globs. */
function workspaceDirs(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const dirs: string[] = [];
  for (const pattern of manifest.workspaces ?? []) {
    // The globs this repo uses are all a single trailing `*`. Anything else needs real globbing
    // and should fail loudly here rather than quietly checking nothing — a preflight that
    // covers no workspaces is the silent failure it exists to prevent.
    if (!pattern.endsWith("/*")) throw new Error(`dev-preflight: unsupported workspace pattern "${pattern}"`);
    const parent = join(root, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(parent, entry.name);
      if (existsSync(join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Where node's ESM loader would stop looking for `name`, starting at `fromDir`, and what it
 * would find there. Stops at the first ancestor holding the package directory, whether or not
 * that directory is any good — which is the whole point. The walk ends at the repo root:
 * above it is somebody else's `node_modules`, not ours to diagnose.
 */
function locate(fromDir: string, name: string, root: string): { at: string; why: BrokenDependency["why"] | null } {
  let dir = fromDir;
  for (;;) {
    const at = join(dir, "node_modules", name);
    if (existsSync(at)) return { at, why: existsSync(join(at, "package.json")) ? null : "empty" };
    const parent = dirname(dir);
    if (dir === root || parent === dir) return { at: join(root, "node_modules", name), why: "missing" };
    dir = parent;
  }
}

/**
 * Every declared dependency of every workspace that would throw on import, in declaration
 * order. Both `dependencies` and `devDependencies`: dev is exactly the mode that uses them.
 */
export function findBrokenDependencies(root: string): BrokenDependency[] {
  const broken: BrokenDependency[] = [];
  for (const dir of workspaceDirs(root)) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) {
      const found = locate(dir, name, root);
      if (found.why === null) continue;
      broken.push({
        workspace: relative(root, dir).replaceAll("\\", "/"),
        name,
        at: relative(root, found.at).replaceAll("\\", "/"),
        why: found.why,
      });
    }
  }
  return broken;
}

/** The report, as the lines to print. Separate from printing so a test can read it. */
export function report(broken: BrokenDependency[]): string[] {
  if (broken.length === 0) return [];
  const lines = [
    `[arke-studio] preflight: ${broken.length} declared ${broken.length === 1 ? "dependency does" : "dependencies do"} not resolve.`,
    "",
  ];
  for (const dep of broken) {
    lines.push(`  ${dep.name}  (declared by ${dep.workspace})`);
    lines.push(dep.why === "empty" ? `    ${dep.at} exists and holds no package.json` : `    nothing at ${dep.at}`);
  }
  lines.push("");
  lines.push("The coordinator dies at import, before it can say so. Run `npm install` and start it again.");
  return lines;
}

// Run as a script; stay quiet when a test imports the functions above.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const broken = findBrokenDependencies(root);
  if (broken.length > 0) {
    for (const line of report(broken)) console.error(line);
    process.exit(1);
  }
}

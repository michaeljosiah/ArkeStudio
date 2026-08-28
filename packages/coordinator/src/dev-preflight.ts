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
 * directory and the fix, and it exits non-zero — an error nobody can mistake for data.
 *
 * Three things it has to get right, all of which cost time to learn (issue 599):
 *
 * - **An empty directory is not a missing one.** `existsSync` on the directory says yes; only
 *   `existsSync` on its `package.json` says no. The junction trick that repairs a worktree's
 *   missing packages succeeds here and resolves to nothing, because the target exists. That one
 *   question is the whole check — a `package.json` whose `main` points at a file npm never
 *   wrote dies the same silent death, but chasing that means reimplementing the resolver.
 * - **The first `node_modules` wins.** ESM resolution walks up from the importer, and the first
 *   ancestor holding `node_modules/<name>` decides the answer — an empty directory there throws
 *   rather than falling through to a good copy further up. (CJS `require.resolve` does fall
 *   through, which is why it would have been the wrong shortcut.) So this walk stops where node
 *   stops, and a root `node_modules/@anthropic-ai` holding a similarly-named `sdk` is not an
 *   answer to a question about `claude-agent-sdk`.
 * - **The walk does not stop at the repo.** Claude worktrees live at `.claude/worktrees/<name>`
 *   inside the repo and carry no `node_modules` of their own; every import there resolves
 *   upward into the main checkout. A walk that ended at the worktree root would call all 77 of
 *   the coordinator's dependencies missing and refuse to start the very thing it is guarding.
 *
 * It also only asks about the packages the coordinator actually loads — its own dependency
 * closure through the workspace graph. A half-installed `electron-builder` is a real problem
 * for somebody, but it is not a reason this command cannot run, and saying so would be a lie
 * of exactly the kind this file exists to stop telling.
 */

/** The workspace this preflight stands in front of. */
const START = "@arke-studio/coordinator";

/** One dependency that will not load, and the reason it will not. */
export interface BrokenDependency {
  /** The workspace that declares it, repo-relative and slash-separated. */
  workspace: string;
  /** The package name, exactly as it is declared and imported. */
  name: string;
  /** Where node stops looking — the directory to repair, or where one belongs. */
  at: string;
  /** `empty` for a directory with no `package.json`; `missing` for no directory at all. */
  why: "empty" | "missing";
}

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifestAt(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
}

/** Every workspace named by the root manifest's `workspaces` globs, by package name. */
function workspacesByName(root: string): Map<string, string> {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces?: string[] };
  const found = new Map<string, string>();
  for (const pattern of manifest.workspaces ?? []) {
    // The globs this repo uses are all a single trailing `*`. Anything else needs real globbing;
    // the caller turns the throw into a warning, because a preflight is never a reason for the
    // command in front of it not to run.
    if (!pattern.endsWith("/*")) throw new Error(`dev-preflight: unsupported workspace pattern "${pattern}"`);
    const parent = join(root, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(parent, entry.name);
      if (!existsSync(join(dir, "package.json"))) continue;
      const name = manifestAt(dir).name;
      if (name !== undefined) found.set(name, dir);
    }
  }
  return found;
}

/**
 * Where node's ESM loader would stop looking for `name`, starting at `fromDir`, and what it
 * would find there — `null` for a package that will load.
 */
function locate(fromDir: string, name: string): { at: string; why: BrokenDependency["why"] | null } {
  let dir = fromDir;
  for (;;) {
    const at = join(dir, "node_modules", name);
    if (existsSync(at)) return { at, why: existsSync(join(at, "package.json")) ? null : "empty" };
    const parent = dirname(dir);
    if (parent === dir) return { at: join(fromDir, "node_modules", name), why: "missing" };
    dir = parent;
  }
}

/**
 * The workspaces `start` loads, itself included, each with the dependency names that have to
 * resolve from it. The entry workspace runs a dev script so its devDependencies load too; the
 * ones below it are only imported, so only their dependencies do.
 */
function loadedWorkspaces(root: string, start: string): Array<{ dir: string; names: string[] }> {
  const byName = workspacesByName(root);
  const reached: Array<{ dir: string; names: string[] }> = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = byName.get(name);
    if (dir === undefined) continue;
    const pkg = manifestAt(dir);
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...(name === start ? Object.keys(pkg.devDependencies ?? {}) : []),
    ];
    reached.push({ dir, names });
    for (const dep of names) if (byName.has(dep)) queue.push(dep);
  }
  return reached;
}

/** Every dependency the coordinator loads that would throw on import, in declaration order. */
export function findBrokenDependencies(root: string, start: string = START): BrokenDependency[] {
  // A path inside the repo reads better relative; one above it — the main checkout, seen from a
  // worktree — only reads at all in full.
  const show = (path: string): string => {
    const rel = relative(root, path).replaceAll("\\", "/");
    return rel.startsWith("..") ? path.replaceAll("\\", "/") : rel;
  };
  const broken: BrokenDependency[] = [];
  for (const { dir, names } of loadedWorkspaces(root, start)) {
    for (const name of names) {
      const found = locate(dir, name);
      if (found.why === null) continue;
      broken.push({ workspace: show(dir), name, at: show(found.at), why: found.why });
    }
  }
  return broken;
}

/** The report, as the lines to print. Separate from printing so a test can read it. */
export function report(broken: BrokenDependency[]): string[] {
  if (broken.length === 0) return [];
  const lines = [
    `[arke-studio] preflight: ${broken.length} ${broken.length === 1 ? "dependency does" : "dependencies do"} not resolve.`,
    "",
  ];
  for (const dep of broken) {
    lines.push(`  ${dep.name}  (declared by ${dep.workspace})`);
    lines.push(
      dep.why === "empty" ? `    ${dep.at} exists and holds no package.json` : `    nothing at ${dep.at}, nor above it`,
    );
  }
  lines.push("");
  lines.push("The coordinator dies at import, before it can say so. Run `npm install` and start it again.");
  return lines;
}

// Run as a script; stay quiet when a test imports the functions above.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    const broken = findBrokenDependencies(root);
    if (broken.length > 0) {
      for (const line of report(broken)) console.error(line);
      // Not process.exit: stderr to a Windows console is written asynchronously, and exiting on
      // the next line can discard the report — which is the entire point of running this.
      process.exitCode = 1;
    }
  } catch (err) {
    // A preflight that cannot answer must not be the reason the coordinator will not start.
    console.warn(`[arke-studio] preflight could not run: ${err instanceof Error ? err.message : String(err)}`);
  }
}

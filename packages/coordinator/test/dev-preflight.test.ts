import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findBrokenDependencies, report } from "../src/dev-preflight.js";
import { tempDir } from "./tmp.js";

/**
 * The preflight that stands in front of the dev coordinator (issue 599).
 *
 * The case worth having a test for is the one that cost the time: a package directory that
 * exists and holds nothing. Every cheap check says that package is installed — the directory is
 * there, a junction into it succeeds, `npm ls` walks the lockfile rather than the disk — and
 * node still throws at import. So these fixtures build the broken shapes on disk rather than
 * mocking a resolver, because the disk is the only thing that disagreed.
 *
 * The other half is what it must NOT say. A guard on a dev command has to be wrong less often
 * than the failure it reports, or it becomes the failure.
 */

type Deps = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** A repo-shaped tree: root manifest with one workspace glob, and the workspaces named. */
async function repo(workspaces: Record<string, Deps>, at?: string): Promise<string> {
  const root = at ?? (await tempDir("arke-preflight-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fake-root", workspaces: ["packages/*"] }));
  for (const [name, manifest] of Object.entries(workspaces)) {
    const dir = join(root, "packages", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
  }
  return root;
}

/** An installed package: a directory with the `package.json` that makes it one. */
async function install(root: string, under: string, name: string): Promise<void> {
  const dir = join(root, under, "node_modules", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
}

describe("dev preflight", () => {
  it("passes when every declared dependency resolves", async () => {
    const root = await repo({ start: { dependencies: { left: "^1" }, devDependencies: { right: "^1" } } });
    await install(root, "packages/start", "left");
    await install(root, ".", "right");

    assert.deepEqual(findBrokenDependencies(root, "start"), []);
  });

  it("reports a package directory that exists and holds no package.json", async () => {
    const root = await repo({
      start: { dependencies: { adapter: "*" } },
      adapter: { dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.235" } },
    });
    await install(root, ".", "adapter");
    // The reported shape exactly: the directory is there, and it holds zero entries.
    await mkdir(join(root, "packages/adapter/node_modules/@anthropic-ai/claude-agent-sdk"), { recursive: true });

    assert.deepEqual(findBrokenDependencies(root, "start"), [
      {
        workspace: "packages/adapter",
        name: "@anthropic-ai/claude-agent-sdk",
        at: "packages/adapter/node_modules/@anthropic-ai/claude-agent-sdk",
        why: "empty",
      },
    ]);
  });

  it("does not fall through to a good copy further up, because node does not either", async () => {
    const root = await repo({ start: { dependencies: { pkg: "^1" } } });
    await install(root, ".", "pkg");
    await mkdir(join(root, "packages/start/node_modules/pkg"), { recursive: true });

    // ESM resolution stops at the first ancestor holding `node_modules/pkg`; an empty one there
    // throws rather than deferring to the root copy. A preflight that kept walking would call
    // this healthy and hand the developer back the silent failure.
    const broken = findBrokenDependencies(root, "start");
    assert.equal(broken.length, 1);
    assert.equal(broken[0]?.at, "packages/start/node_modules/pkg");
  });

  it("reports a dependency with no directory anywhere, and names where one belongs", async () => {
    const root = await repo({ start: { dependencies: { "absent-from-everywhere": "^1" } } });

    assert.deepEqual(findBrokenDependencies(root, "start"), [
      {
        workspace: "packages/start",
        name: "absent-from-everywhere",
        at: "packages/start/node_modules/absent-from-everywhere",
        why: "missing",
      },
    ]);
  });

  it("does not mistake a similarly-named sibling for the package asked about", async () => {
    const root = await repo({ start: { dependencies: { "@anthropic-ai/claude-agent-sdk": "^1" } } });
    // What the root actually held while the SDK was broken: a different package in the same scope.
    await install(root, ".", "@anthropic-ai/sdk");

    assert.equal(findBrokenDependencies(root, "start").length, 1);
  });

  it("resolves upward out of the repo, the way a worktree with no node_modules has to", async () => {
    // Claude worktrees live at `.claude/worktrees/<name>` inside the repo and carry no
    // node_modules; every import there resolves into the main checkout above them. A walk that
    // stopped at the worktree root called all 77 of the coordinator's dependencies missing and
    // refused to start the command it was guarding.
    const outer = await tempDir("arke-preflight-");
    await install(outer, ".", "pkg");
    const worktree = await repo({ start: { dependencies: { pkg: "^1" } } }, join(outer, ".claude/worktrees/wt"));

    assert.deepEqual(findBrokenDependencies(worktree, "start"), []);
  });

  it("asks only about the packages the coordinator loads", async () => {
    const root = await repo({
      start: { dependencies: { needed: "^1" } },
      unrelated: { dependencies: { "electron-builder": "^1" } },
    });
    await install(root, ".", "needed");

    // `unrelated` is a workspace the entry never imports. Its broken install is somebody's
    // problem, but it is not a reason this command cannot run — and "the coordinator dies at
    // import" would be a lie about it.
    assert.deepEqual(findBrokenDependencies(root, "start"), []);
  });

  it("follows the workspace graph rather than stopping at the entry", async () => {
    const root = await repo({
      start: { dependencies: { middle: "*" } },
      middle: { dependencies: { deep: "*" } },
      deep: { dependencies: { "absent-from-everywhere": "^1" } },
    });
    await install(root, ".", "middle");
    await install(root, ".", "deep");

    assert.equal(findBrokenDependencies(root, "start")[0]?.workspace, "packages/deep");
  });

  it("ignores the devDependencies of workspaces it only imports", async () => {
    const root = await repo({
      start: { dependencies: { middle: "*" } },
      middle: { devDependencies: { "a-test-only-tool": "^1" } },
    });
    await install(root, ".", "middle");

    // Nothing imports another workspace's test tooling, so a broken one cannot stop this run.
    assert.deepEqual(findBrokenDependencies(root, "start"), []);
  });

  it("survives a cycle in the workspace graph", async () => {
    const root = await repo({ start: { dependencies: { other: "*" } }, other: { dependencies: { start: "*" } } });
    await install(root, ".", "start");
    await install(root, ".", "other");

    assert.deepEqual(findBrokenDependencies(root, "start"), []);
  });

  it("refuses a workspace glob it cannot honour rather than reporting a tree it did not read", async () => {
    const root = await tempDir("arke-preflight-");
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/**/nested"] }));

    // The script turns this into a warning and starts the coordinator anyway; what matters here
    // is that it does not come back with an empty list and call the tree healthy.
    assert.throws(() => findBrokenDependencies(root, "start"), /unsupported workspace pattern/);
  });

  it("names the package, the directory and the fix", () => {
    const lines = report([
      {
        workspace: "packages/adapter-claude",
        name: "@anthropic-ai/claude-agent-sdk",
        at: "packages/adapter-claude/node_modules/@anthropic-ai/claude-agent-sdk",
        why: "empty",
      },
    ]).join("\n");

    assert.match(lines, /@anthropic-ai\/claude-agent-sdk/);
    assert.match(lines, /packages\/adapter-claude\/node_modules\/@anthropic-ai\/claude-agent-sdk/);
    assert.match(lines, /npm install/);
  });

  it("says nothing at all when there is nothing to say", () => {
    assert.deepEqual(report([]), []);
  });
});

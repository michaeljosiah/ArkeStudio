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
 */

/** A repo-shaped tree: root manifest with one workspace glob, and the workspaces named. */
async function repo(
  workspaces: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>,
): Promise<string> {
  const root = await tempDir("arke-preflight-");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fake-root", workspaces: ["packages/*"] }));
  for (const [name, manifest] of Object.entries(workspaces)) {
    const dir = join(root, "packages", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: `@fake/${name}`, ...manifest }));
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
    const root = await repo({ alpha: { dependencies: { left: "^1" }, devDependencies: { right: "^1" } } });
    await install(root, "packages/alpha", "left");
    await install(root, ".", "right");

    assert.deepEqual(findBrokenDependencies(root), []);
  });

  it("reports a package directory that exists and holds no package.json", async () => {
    const root = await repo({ "adapter-claude": { dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.235" } } });
    // The reported shape exactly: the directory is there, and it holds zero entries.
    await mkdir(join(root, "packages/adapter-claude/node_modules/@anthropic-ai/claude-agent-sdk"), { recursive: true });

    assert.deepEqual(findBrokenDependencies(root), [
      {
        workspace: "packages/adapter-claude",
        name: "@anthropic-ai/claude-agent-sdk",
        at: "packages/adapter-claude/node_modules/@anthropic-ai/claude-agent-sdk",
        why: "empty",
      },
    ]);
  });

  it("does not fall through to a good copy further up, because node does not either", async () => {
    const root = await repo({ alpha: { dependencies: { pkg: "^1" } } });
    await install(root, ".", "pkg");
    await mkdir(join(root, "packages/alpha/node_modules/pkg"), { recursive: true });

    // ESM resolution stops at the first ancestor holding `node_modules/pkg`; an empty one there
    // throws rather than deferring to the root copy. A preflight that kept walking would call
    // this healthy and hand the developer back the silent failure.
    const broken = findBrokenDependencies(root);
    assert.equal(broken.length, 1);
    assert.equal(broken[0]?.at, "packages/alpha/node_modules/pkg");
  });

  it("reports a dependency with no directory anywhere, and names where one belongs", async () => {
    const root = await repo({ alpha: { dependencies: { absent: "^1" } } });

    assert.deepEqual(findBrokenDependencies(root), [
      { workspace: "packages/alpha", name: "absent", at: "node_modules/absent", why: "missing" },
    ]);
  });

  it("does not mistake a similarly-named sibling for the package asked about", async () => {
    const root = await repo({ alpha: { dependencies: { "@anthropic-ai/claude-agent-sdk": "^1" } } });
    // What the root actually held while the SDK was broken: a different package in the same scope.
    await install(root, ".", "@anthropic-ai/sdk");

    assert.equal(findBrokenDependencies(root).length, 1);
  });

  it("refuses a workspace glob it cannot honour rather than checking nothing", async () => {
    const root = await tempDir("arke-preflight-");
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/**/nested"] }));

    assert.throws(() => findBrokenDependencies(root), /unsupported workspace pattern/);
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

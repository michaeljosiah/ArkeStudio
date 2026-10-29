import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testPlan, COORDINATOR, COORDINATOR_SHARDS, OWN_JOB_TESTS, OWN_WORKFLOW } from "./ci-test-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = ["client", "coordinator", "engine", "new-package"].map(name => ({ name: `@arke-studio/${name}`, dir: name }));

test("coordinator jobs, the workspace job and the workflows of their own cover every suite exactly once", () => {
  const selectors = Array.from({ length: COORDINATOR_SHARDS }, (_, index) => `${index + 1}/${COORDINATOR_SHARDS}`);
  const shards = selectors.map(selector => testPlan(workspaces, selector));
  assert.deepEqual(shards.map(p => p.coordinator.shard), selectors);
  assert.ok(shards.every(p => p.coordinator.name === COORDINATOR && p.others.length === 0));
  const separate = testPlan(workspaces, "workspaces");
  assert.equal(separate.coordinator, null);
  assert.deepEqual(separate.others.map(w => w.name), ["@arke-studio/client", "@arke-studio/new-package"], "a new workspace joins the job by default");
  assert.deepEqual(Object.keys(OWN_WORKFLOW), ["@arke-studio/engine"]);
});

test("the workflow runs every configured shard and Node's automatic discovery covers each file once", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const indices = Array.from({ length: COORDINATOR_SHARDS }, (_, index) => index + 1);
  assert(workflow.includes(`shard: [${indices.join(", ")}]`));
  assert(workflow.includes(`node scripts/ci-test.mjs \u0024{{ matrix.shard }}/${COORDINATOR_SHARDS}`));
  const scratch = mkdtempSync(join(tmpdir(), "arke-ci-shards-"));
  try {
    for (let index = 0; index < COORDINATOR_SHARDS + 1; index++) writeFileSync(join(scratch, `case-${index}.test.mjs`), `import { test } from 'node:test'; test('covered-${index}', () => {});\n`);
    const covered = [];
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; // Each fixture is a new runner, not a nested worker.
    for (const index of indices) {
      const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-shard=${index}/${COORDINATOR_SHARDS}`, "*.test.mjs"],
        { cwd: scratch, env, encoding: "utf8", timeout: 15_000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr || String(result.error ?? "shard failed"));
      covered.push(...Array.from(result.stdout.matchAll(/# Subtest: covered-(\d+)/g), match => Number(match[1])));
    }
    assert.deepEqual(covered.sort((a, b) => a - b), indices.map(index => index - 1).concat(COORDINATOR_SHARDS), "no discovered file is omitted or duplicated");
  } finally {
    assert(resolve(scratch).startsWith(resolve(tmpdir()) + sep) && scratch.includes("arke-ci-shards-"), "remove only this test's temporary directory");
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a workspace run by a workflow of its own is run by that workflow", () => {
  for (const [name, workflow] of Object.entries(OWN_WORKFLOW)) {
    const text = readFileSync(join(root, workflow), "utf8");
    const dir = `packages/${name.split("/")[1]}`;
    assert.match(text, new RegExp(`working-directory: ${dir}\\s+run: npm test`), `${workflow} runs ${name}'s tests`);
    assert.match(text, /push:\s+branches: \[main\]/, `${workflow} runs on every push to main`);
  }
});

test("the shards skip only tests a job of their own runs", () => {
  const shard = testPlan(workspaces, "2/4");
  assert.deepEqual(shard.coordinator.skip, OWN_JOB_TESTS.map(own => own.pattern));
  const names = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".test.ts")) for (const match of readFileSync(join(dir, entry.name), "utf8").matchAll(/\b(?:it|test|describe)\(\s*(["'`])((?:(?!\1).)*)\1/g)) names.push(match[2]);
    }
  };
  walk(join(root, "packages/coordinator/test"));
  for (const own of OWN_JOB_TESTS) {
    assert.doesNotMatch(own.pattern, /\s/, "Windows passes the pattern through cmd.exe unquoted");
    // The pattern must still name the test, and only it: a rename would quietly put the test back
    // in the shards, and a second match would quietly take another test out of them.
    assert.equal(names.filter(name => name.includes(own.pattern)).length, 1, `exactly one coordinator test is named by ${own.pattern}`);
    const file = readFileSync(join(root, "packages/coordinator", own.file), "utf8");
    assert.ok(file.includes(own.pattern), `${own.file} declares the test`);
    assert.ok(readFileSync(join(root, own.workflow), "utf8").includes(own.file), `${own.workflow} runs ${own.file}`);
  }
});

test("the default local run still includes coordinator in full and every other workspace", () => {
  const plan = testPlan(workspaces);
  assert.equal(plan.coordinator.shard, "1/1");
  assert.deepEqual(plan.coordinator.skip, []);
  assert.equal(plan.others.length + 1, workspaces.length);
});

test("invalid selectors and a missing coordinator fail instead of silently dropping coverage", () => {
  for (const selector of ["0/4", "5/4", "1/0", "1.5/4", "1/4/2", "other", "9007199254740992/9007199254740992"]) {
    assert.throws(() => testPlan(workspaces, selector));
  }
  assert.throws(() => testPlan(workspaces.filter(w => w.name !== COORDINATOR), "workspaces"));
});

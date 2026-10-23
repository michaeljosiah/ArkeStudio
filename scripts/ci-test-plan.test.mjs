import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testPlan, COORDINATOR, OWN_JOB_TESTS, OWN_WORKFLOW } from "./ci-test-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = ["client", "coordinator", "engine", "new-package"].map(name => ({ name: `@arke-studio/${name}`, dir: name }));

test("four coordinator jobs, the workspace job and the workflows of their own cover every suite exactly once", () => {
  const shards = [1, 2, 3, 4].map(i => testPlan(workspaces, `${i}/4`));
  assert.deepEqual(shards.map(p => p.coordinator.shard), ["1/4", "2/4", "3/4", "4/4"]);
  assert.ok(shards.every(p => p.coordinator.name === COORDINATOR && p.others.length === 0));
  const separate = testPlan(workspaces, "workspaces");
  assert.equal(separate.coordinator, null);
  assert.deepEqual(separate.others.map(w => w.name), ["@arke-studio/client", "@arke-studio/new-package"], "a new workspace joins the job by default");
  assert.deepEqual(Object.keys(OWN_WORKFLOW), ["@arke-studio/engine"]);
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

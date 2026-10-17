import assert from "node:assert/strict";
import { test } from "node:test";
import { testPlan, COORDINATOR } from "./ci-test-plan.mjs";

const workspaces = ["client", "coordinator", "engine", "new-package"].map(name => ({ name: `@arke-studio/${name}`, dir: name }));

test("four coordinator jobs plus the workspace job cover every suite exactly once", () => {
  const shards = [1, 2, 3, 4].map(i => testPlan(workspaces, `${i}/4`));
  assert.deepEqual(shards.map(p => p.coordinator.shard), ["1/4", "2/4", "3/4", "4/4"]);
  assert.ok(shards.every(p => p.coordinator.name === COORDINATOR && p.others.length === 0));
  const separate = testPlan(workspaces, "workspaces");
  assert.equal(separate.coordinator, null);
  assert.deepEqual(separate.others, workspaces.filter(w => w.name !== COORDINATOR));
});

test("the default local run still includes coordinator and every other workspace", () => {
  const plan = testPlan(workspaces);
  assert.equal(plan.coordinator.shard, "1/1");
  assert.equal(plan.others.length + 1, workspaces.length);
});

test("invalid selectors and a missing coordinator fail instead of silently dropping coverage", () => {
  for (const selector of ["0/4", "5/4", "1/0", "1.5/4", "1/4/2", "other", "9007199254740992/9007199254740992"]) {
    assert.throws(() => testPlan(workspaces, selector));
  }
  assert.throws(() => testPlan(workspaces.filter(w => w.name !== COORDINATOR), "workspaces"));
});

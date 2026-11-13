import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testPlan, clientFilesRead, coordinatorNeeded, COORDINATOR, COORDINATOR_SHARDS, LINUX_COORDINATOR_SHARDS, OWN_JOB_TESTS, OWN_WORKFLOW } from "./ci-test-plan.mjs";

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
  // Linux takes the first four of the eight and divides the suite by four (issue 2812).
  for (const index of indices.slice(LINUX_COORDINATOR_SHARDS)) assert(workflow.includes(`- { os: ubuntu-latest, shard: ${index} }`), `Linux skips shard ${index}`);
  const total = `\u0024{{ matrix.os == 'ubuntu-latest' && ${LINUX_COORDINATOR_SHARDS} || ${COORDINATOR_SHARDS} }}`;
  assert(workflow.includes(`node scripts/ci-test.mjs \u0024{{ matrix.shard }}/${total}`));
  const scratch = mkdtempSync(join(tmpdir(), "arke-ci-shards-"));
  try {
    for (let index = 0; index < COORDINATOR_SHARDS + 1; index++) writeFileSync(join(scratch, `case-${index}.test.mjs`), `import { test } from 'node:test'; test('covered-${index}', () => {});\n`);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; // Each fixture is a new runner, not a nested worker.
    for (const shards of [COORDINATOR_SHARDS, LINUX_COORDINATOR_SHARDS]) {
      const covered = [];
      for (let index = 1; index <= shards; index++) {
        const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-shard=${index}/${shards}`, "*.test.mjs"],
          { cwd: scratch, env, encoding: "utf8", timeout: 15_000, windowsHide: true });
        assert.equal(result.status, 0, result.stderr || String(result.error ?? "shard failed"));
        covered.push(...Array.from(result.stdout.matchAll(/# Subtest: covered-(\d+)/g), match => Number(match[1])));
      }
      assert.deepEqual(covered.sort((a, b) => a - b), Array.from({ length: COORDINATOR_SHARDS + 1 }, (_, index) => index), `no discovered file is omitted or duplicated across ${shards} shards`);
    }
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

test("a pull request inside the client skips the coordinator, unless a coordinator test reads what it changed (issue 2812)", () => {
  const read = clientFilesRead([`readFile(join(import.meta.dirname, "../../../client/src/components/activity-panel.tsx"))`, `new URL("../../client/public/manifest.webmanifest", import.meta.url)`]);
  assert.deepEqual([...read], ["packages/client/src/components/activity-panel.tsx", "packages/client/public/manifest.webmanifest"]);
  assert.equal(coordinatorNeeded(["packages/client/src/screens/home.tsx", "packages/client/test/home.test.tsx"], read), false);
  assert.equal(coordinatorNeeded(["packages/client/src/components/activity-panel.tsx"], read), true, "a file a coordinator test reads");
  assert.equal(coordinatorNeeded(["packages/client/src/screens/home.tsx", "package-lock.json"], read), true, "anything outside the client");
  assert.equal(coordinatorNeeded([], read), true, "a diff that says nothing runs everything");
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /node scripts\/ci-scope\.mjs "\$\{\{ github\.event_name \}\}"/);
});

test("the Node type-check program covers exactly what each Node workspace checks (issue 2812)", () => {
  const jsonc = (path) => JSON.parse(readFileSync(path, "utf8").split("\n").filter(line => !line.trim().startsWith("//")).join("\n"));
  const combined = jsonc(join(root, "tsconfig.node.json")).include;
  const expected = [];
  for (const parent of ["packages", "apps"]) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "client") continue;
      let config;
      try { config = jsonc(join(root, parent, entry.name, "tsconfig.json")); } catch { continue; }
      // One program shares one set of options: a workspace may only narrow `types` or map a path.
      assert.deepEqual(Object.keys(config.compilerOptions ?? {}).filter(key => key !== "types" && key !== "paths"), [], `${parent}/${entry.name} sets options the combined program would not apply`);
      expected.push(...config.include.map(pattern => `${parent}/${entry.name}/${pattern}`));
    }
  }
  assert.deepEqual([...combined].sort(), expected.sort());
  assert.deepEqual(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.typecheck, "node scripts/typecheck.mjs");
});

test("CI passed needs every other job, so none can fail beside it unnoticed (issue 2812)", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const jobs = Array.from(workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^ {2}([\w-]+):\n/gm), match => match[1]).filter(job => job !== "passed");
  const needs = /\n {2}passed:\n(?:.*\n)*? {4}needs: \[([^\]]+)\]/.exec(workflow);
  assert.ok(needs, "CI passed lists what it needs");
  assert.deepEqual(needs[1].split(",").map(job => job.trim()).sort(), jobs.sort());
  assert.match(workflow, /passed:\n {4}name: CI passed\n {4}if: always\(\)/);
});

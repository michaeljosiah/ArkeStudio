export const COORDINATOR = "@arke-studio/coordinator";

/**
 * Workspaces whose suite runs in a workflow of its own rather than in CI's other-workspaces job,
 * by the workflow that runs it. ci-test-plan.test.mjs holds each workflow to running it, so moving
 * a suite here can never leave it running nowhere. A local run still includes them.
 */
export const OWN_WORKFLOW = { "@arke-studio/engine": ".github/workflows/engine.yml" };

/**
 * Coordinator tests the shards skip by name because a job of their own runs them, with the job's
 * workflow and the test's file. A name, because node shards by file and has no file exclusion;
 * one word without spaces, because Windows passes the arguments through cmd.exe unquoted.
 */
export const OWN_JOB_TESTS = [
  { pattern: "thirteen-step", file: "test/world-chat/production-acceptance.test.ts", workflow: ".github/workflows/ci.yml" },
];

/** Keep coordinator shards and the independently growing workspace suites on separate jobs. */
export function testPlan(workspaces, selector = "1/1") {
  const coordinator = workspaces.find(w => w.name === COORDINATOR);
  if (!coordinator) throw new Error(`${COORDINATOR} must retain a test script.`);
  const others = workspaces.filter(w => w.name !== COORDINATOR);
  if (selector === "workspaces") return { label: "other workspaces", coordinator: null, others: others.filter(w => !(w.name in OWN_WORKFLOW)) };
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(selector)) throw new Error("Expected a shard like 2/4 or workspaces.");
  const [index, total] = selector.split("/").map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
    throw new Error("Expected a valid shard index and total.");
  }
  return { label: `shard ${selector}`, coordinator: { ...coordinator, shard: selector, skip: total === 1 ? [] : OWN_JOB_TESTS.map(test => test.pattern) },
    // Preserve the no-argument local command as a complete suite.
    others: total === 1 ? others : [] };
}

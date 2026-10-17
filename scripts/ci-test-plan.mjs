export const COORDINATOR = "@arke-studio/coordinator";

/** Keep coordinator shards and the independently growing workspace suites on separate jobs. */
export function testPlan(workspaces, selector = "1/1") {
  const coordinator = workspaces.find(w => w.name === COORDINATOR);
  if (!coordinator) throw new Error(`${COORDINATOR} must retain a test script.`);
  const others = workspaces.filter(w => w.name !== COORDINATOR);
  if (selector === "workspaces") return { label: "other workspaces", coordinator: null, others };
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(selector)) throw new Error("Expected a shard like 2/4 or workspaces.");
  const [index, total] = selector.split("/").map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
    throw new Error("Expected a valid shard index and total.");
  }
  return { label: `shard ${selector}`, coordinator: { ...coordinator, shard: selector },
    // Preserve the no-argument local command as a complete suite.
    others: total === 1 ? others : [] };
}

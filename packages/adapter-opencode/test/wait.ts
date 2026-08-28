/**
 * Package-local copy of packages/coordinator/test/wait.ts's until() — the canonical helper
 * and its full rationale live there, and workspaces cannot import each other's test files.
 * Keep the two in step when the contract changes.
 */
export async function until(condition: () => boolean, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms}ms waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

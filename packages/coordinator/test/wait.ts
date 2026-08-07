/**
 * Waiting for asynchronous work in tests, without guessing how long it takes.
 *
 * The pattern this replaces is `await delay(1000)` followed by an assertion. That is a race the
 * test loses on a busy machine — the filesystem watcher, the verification behind it and the
 * assertion all compete for the same CPU, and the assertion runs first. It is what made the
 * WorldStore watcher tests fail on a loaded CI runner while passing everywhere else.
 *
 * Note the asymmetry: this is only for asserting that something *does* happen. You cannot wait for
 * a non-event, so a test proving something never fires still has to spend a fixed quiet period.
 */

/**
 * Poll until `condition` holds, or fail saying what was being waited for.
 *
 * Polling costs nothing once the condition is met, so this returns as quickly as a sleep of
 * exactly the right length would have; the cap only decides how long a genuinely broken case takes
 * to report. Ten seconds because a parallel suite decoding PNGs can starve this one for whole
 * seconds at a time — the dispatcher tests found that first.
 */
export async function until(condition: () => boolean, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms}ms waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

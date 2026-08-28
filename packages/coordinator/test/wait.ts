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

/**
 * The same contract for a condition that must itself be awaited — a file read, an HTTP probe.
 * A separate function rather than a wider type on until(): handed an async condition there by
 * mistake, the loop would see a Promise, which is always truthy, and report success without
 * ever awaiting the answer.
 *
 * The deadline is a raced timer rather than a check between attempts, so the budget holds
 * even when one invocation never settles — a probe with no timeout of its own would otherwise
 * hang the file until CI's silence guard killed the shard, nameless. A rejection counts as
 * "not yet", because refusal is the natural state of a thing still coming up; the last
 * rejection rides the timeout message, so a predicate that is simply broken still names
 * itself. The poll is coarser than until()'s because each check does real I/O — against
 * budgets of tens of seconds, 100ms of detection latency is nothing.
 */
export async function untilAsync(
  condition: () => Promise<boolean>,
  what: string,
  ms = 10_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  let lastError: unknown;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      const failure = lastError instanceof Error ? lastError.message : lastError;
      reject(
        new Error(
          `timed out after ${ms}ms waiting for: ${what}${failure === undefined ? "" : ` (last error: ${String(failure)})`}`,
        ),
      );
    }, ms);
  });
  // The poll itself always resolves, so an attempt abandoned by the deadline can never
  // surface later as an unhandled rejection; the expired flag stops it re-invoking the
  // condition once the race has been lost.
  const poll = (async () => {
    while (!expired) {
      try {
        if (await condition()) return;
      } catch (err) {
        lastError = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  try {
    await Promise.race([deadline, poll]);
  } finally {
    // Left pending, a 30-60s deadline timer would hold the process open that long after
    // every green wait.
    clearTimeout(timer);
  }
}

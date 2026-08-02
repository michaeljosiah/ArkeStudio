import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The harness trace: logs/harness.jsonl under the app root, one JSON line per adapter fact.
 *
 * Synchronous appends, deliberately — trace lines are small and rare (connects, stalls,
 * dispatch outcomes, resyncs; never per-delta), and an async writer can lose the very lines
 * that explain a crash. Rolls to harness.jsonl.old at 5 MB so it cannot grow without bound;
 * one generation of history is enough to diagnose "it was working yesterday".
 */
const ROLL_BYTES = 5 * 1024 * 1024;

export function harnessTrace(root: string): (line: Record<string, unknown>) => void {
  const dir = join(root, "logs");
  const path = join(dir, "harness.jsonl");
  let ready = false;
  return (line) => {
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true });
        ready = true;
      }
      try {
        if (statSync(path).size > ROLL_BYTES) renameSync(path, `${path}.old`);
      } catch {
        /* absent file — first write creates it */
      }
      appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
    } catch {
      /* a full disk must degrade the trace, never the harness */
    }
  };
}

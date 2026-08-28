import { readFile } from "node:fs/promises";

/**
 * The NDJSON reader for seed and ledger files, stating when the file exists and could not be
 * read. A missing file is an empty read — nothing has been recorded yet — but an EACCES or a
 * transient I/O failure folded into the same empty array published a ledger that read as
 * clean (SPEC-032 R-21): the spend correlation compared two windows of nothing and found
 * nothing wrong. Every call site decides what `unavailable` means for its source.
 *
 * One reader for every consumer of the same file, deliberately: the seed and the spend
 * evaluation both read `ledger.jsonl`, and two hand-maintained copies of this logic let their
 * definitions of `unavailable` drift apart — the seeded flag and the evaluated one then
 * disagreeing about one condition, which is the R-13 split this file exists to close.
 *
 * ENOTDIR joins ENOENT as absence: a parent component that is a file means the ledger itself
 * has never existed — and Windows reports that same shape as ENOENT, so classifying ENOTDIR
 * as a failed read made the two CI platforms publish different states for one install.
 *
 * Lines that do not parse are skipped, never fatal — the ledger's tolerant-reader doctrine
 * (SPEC-008 §3.2). A crash mid-append leaves a torn final line, and the seed read runs before
 * `LedgerFile`'s repair, so a strict parse here turned that crash artifact into an app that
 * would not boot.
 */
export async function readNdjson<T>(
  path: string,
  parse: (x: unknown) => T,
): Promise<{ entries: T[]; unavailable: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { entries: [], unavailable: code !== "ENOENT" && code !== "ENOTDIR" };
  }
  const entries: T[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(parse(JSON.parse(t)));
    } catch {
      /* torn or foreign line — skipped */
    }
  }
  return { entries, unavailable: false };
}

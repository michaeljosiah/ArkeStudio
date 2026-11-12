import { createHash } from "node:crypto";

/**
 * A spend key the same input always derives, in the ULID shape the queue accepts (`JobSchema`'s
 * `idempotencyKey`). A frame run's step and a table read's line are each confirmed once and may be
 * submitted again; the same input must land on the same key so the queue sees one job, not two.
 * The table read once keyed its lines `table-read/<token>/<n>`, which the journal refused for every
 * cloud line, so no table read with a cloud voice could run (2026-10-29).
 */
export function deterministicUlid(value: string): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const digest = createHash("sha256").update(value).digest();
  return Array.from({ length: 26 }, (_, index) => alphabet[digest[index % digest.length]! % 32]).join("");
}

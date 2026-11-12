import assert from "node:assert/strict";
import { it } from "node:test";
import { artifactResultReadLimit } from "../src/artifact-result-limits.js";

it("caps each file by both its individual ceiling and the unspent aggregate response budget", () => {
  const GiB = 1024 ** 3;
  assert.equal(artifactResultReadLimit(0), GiB);
  assert.equal(artifactResultReadLimit(3 * GiB + 4), GiB - 4);
  assert.equal(artifactResultReadLimit(4 * GiB), 0);
  for (const invalid of [-1, 0.5, NaN, Infinity, 4 * GiB + 1]) assert.throws(() => artifactResultReadLimit(invalid));
});

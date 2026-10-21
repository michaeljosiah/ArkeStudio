import assert from "node:assert/strict";
import { it } from "node:test";
import { WindowsCommitSnapshotSchema, windowsCommitHeadroomBytes } from "../src/comfyui.js";

it("calculates commit headroom independently of free physical RAM, retaining unknown and zero", () => {
  const values = { committedBytes: 40, limitBytes: 50, physicalAvailableBytes: 999 };
  assert.equal(windowsCommitHeadroomBytes(values), 10);
  assert.equal(windowsCommitHeadroomBytes({ ...values, physicalAvailableBytes: 0 }), 10);
  assert.equal(windowsCommitHeadroomBytes({ ...values, committedBytes: 50 }), 0);
  assert.equal(windowsCommitHeadroomBytes({ ...values, committedBytes: 51 }), 0);
  assert.equal(windowsCommitHeadroomBytes(null), null);
});

it("carries an unavailable measurement with its source and attempt time", () => {
  const measured = { source: "windows-performance-memory", measuredAt: "2026-10-21T12:00:00.000Z", values: null };
  assert.deepEqual(WindowsCommitSnapshotSchema.parse(measured), measured);
  assert.equal(WindowsCommitSnapshotSchema.safeParse({ ...measured, measuredAt: undefined }).success, false);
});

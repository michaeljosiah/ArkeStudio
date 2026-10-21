import assert from "node:assert/strict";
import { it } from "node:test";
import { storyDownloadRequiredBytes } from "../src/story-download.js";

it("allows for download, extraction and independent installation, crediting retained bytes", () => {
  const source = { bytes: 1000, unpackedBytes: 2000 };
  assert.equal(storyDownloadRequiredBytes(source), 5000 + 64 * 1024 * 1024);
  assert.equal(storyDownloadRequiredBytes(source, 750), 4250 + 64 * 1024 * 1024);
  assert.equal(storyDownloadRequiredBytes(source, 1000), 4000 + 64 * 1024 * 1024);
});

it("refuses impossible sizes and unsafe arithmetic", () => {
  for (const source of [{ bytes: 0, unpackedBytes: 1 }, { bytes: 1, unpackedBytes: -1 }, { bytes: Number.MAX_SAFE_INTEGER, unpackedBytes: 1 }]) assert.throws(() => storyDownloadRequiredBytes(source));
  for (const retained of [-1, 101, NaN, Infinity]) assert.throws(() => storyDownloadRequiredBytes({ bytes: 100, unpackedBytes: 100 }, retained));
});

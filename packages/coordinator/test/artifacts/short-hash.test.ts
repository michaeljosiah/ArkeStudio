import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { artifactShortHash } from "../../src/artifacts/short-hash.js";

describe("artifactShortHash", () => {
  it("keeps the form every sidecar on disk carries: sha256 and the first 16 hex characters", () => {
    // SHA-256("abc") is ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad. A sidecar
    // filed years ago holds the prefix of it, and the check that a file is still the one filed
    // compares against that, so a change here would orphan every artifact already filed.
    assert.equal(artifactShortHash(Buffer.from("abc")), "sha256:ba7816bf8f01cfea");
    assert.equal(artifactShortHash(new Uint8Array([97, 98, 99])), "sha256:ba7816bf8f01cfea");
  });
});

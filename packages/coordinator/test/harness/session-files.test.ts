import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessAdapter, SessionConfigInput } from "@arke-studio/contracts";
import { writeSessionFiles } from "../../src/harness/session-files.js";
import { tempDir } from "../tmp.js";

function adapterWithFileFailure(): Pick<
  HarnessAdapter,
  "abandonSessionPreparation" | "prepareSession" | "sessionFiles"
> & { prepared: string[]; abandoned: string[] } {
  return {
    prepared: [],
    abandoned: [],
    prepareSession(input: SessionConfigInput) {
      this.prepared.push(input.preparationId!);
    },
    sessionFiles() {
      return [{ name: "invalid\0config.json", contents: "{}" }];
    },
    abandonSessionPreparation(preparationId: string) {
      this.abandoned.push(preparationId);
    },
  };
}

describe("session preparation lifetime", () => {
  it("abandons the one-use preparation when writing session files fails", async () => {
    const adapter = adapterWithFileFailure();
    await assert.rejects(writeSessionFiles(adapter, await tempDir("arke-session-files-")), /null bytes/i);
    assert.equal(adapter.prepared.length, 1);
    assert.deepEqual(adapter.abandoned, adapter.prepared);
  });
});

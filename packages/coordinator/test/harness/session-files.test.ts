import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CreateSessionInput, HarnessAdapter, SessionConfigInput } from "@arke-studio/contracts";
import { createPreparedSession, writeSessionFiles } from "../../src/harness/session-files.js";
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

  it("serializes the config write and session create for a shared directory", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstCreated = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const adapter = {
      id: "serialized",
      capabilities: () => new Set(),
      readiness: () => ({ ready: true }),
      prepareSession(input: SessionConfigInput) {
        order.push(`prepare:${input.model}`);
      },
      sessionFiles(input: SessionConfigInput) {
        return [{ name: "opencode.json", contents: input.model ?? "" }];
      },
      async createSession(input: CreateSessionInput) {
        order.push(`create:${input.title}`);
        if (input.title === "first") await firstCreated;
        return { sessionId: `session-${input.title}` };
      },
      async sendMessage() {
        throw new Error("unused");
      },
      async dispatchAsync() {
        throw new Error("unused");
      },
      streamEvents() {
        return { [Symbol.asyncIterator]: async function* () {} };
      },
    } as HarnessAdapter;
    const dir = await tempDir("arke-session-files-");

    const first = createPreparedSession(adapter, dir, { model: "first" }, { purpose: "authoring", title: "first" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = createPreparedSession(adapter, dir, { model: "second" }, { purpose: "authoring", title: "second" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(order, ["prepare:first", "create:first"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["prepare:first", "create:first", "prepare:second", "create:second"]);
  });
});

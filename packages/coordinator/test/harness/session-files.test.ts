import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CreateSessionInput, HarnessAdapter, SessionConfigInput } from "@arke-studio/contracts";
import { createPreparedSession, scopeSessionInput, writeSessionFiles } from "../../src/harness/session-files.js";
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
  it("isolates Studio roles after world/Settings enrichment and pins the same role at creation", async () => {
    for (const agent of ["studio-assistant", "diagnostic-specialist"]) {
      const input = { agent, model: "ollama/local", researchWeb: true, inferencePriority: "normal" as const,
        worldQueryUrl: "http://private-world-token.invalid", memoryDir: "PRIVATE_WORLD_NOTES", authorNotesFile: "PRIVATE_AUTHOR_NOTES",
        skillBodies: { "private-skill": "PRIVATE_WORLD_PROSE" }, skillFamily: "private-world", skillModelId: "private-world-model",
        agents: { [agent]: { model: "ollama/role" }, "world-builder": { brief: "PRIVATE_WORLD_OVERRIDE" } } };
      let prepared: SessionConfigInput | undefined, created: CreateSessionInput | undefined;
      const adapter = { prepareSession: (value: SessionConfigInput) => { prepared = value; }, sessionFiles: (value: SessionConfigInput) => {
        assert.equal(value.worldQueryUrl, undefined); assert.equal(value.memoryDir, undefined); return [];
      }, createSession: async (value: CreateSessionInput) => { created = value; return { sessionId: agent }; } } as unknown as HarnessAdapter;
      await createPreparedSession(adapter, await tempDir("arke-studio-isolation-"), input, { purpose: "ask" });
      assert.equal(created!.agent, agent); assert.equal(prepared!.inferencePriority, "background"); assert.equal(prepared!.researchWeb, false);
      assert.deepEqual(prepared!.agents, { [agent]: { model: "ollama/role" } });
      assert(!JSON.stringify(prepared).includes("PRIVATE_")); assert(!JSON.stringify(prepared).includes("private-world"));
      assert.equal(input.worldQueryUrl, "http://private-world-token.invalid", "The ordinary world's source configuration remains untouched");
    }
    const ordinary = { agent: "world-builder", memoryDir: "world-notes", researchWeb: true };
    assert.equal(scopeSessionInput(ordinary), ordinary, "Existing World/Builder sessions keep their normal scope");
  });

  it("returns the prepared model using the session choice before its named agent choice", async () => {
    const adapter = { createSession: async () => ({ sessionId: "prepared" }) } as unknown as HarnessAdapter;
    const dir = await tempDir("arke-session-model-");
    const cases: Array<[SessionConfigInput, string | undefined]> = [
      [{ model: "openai/cloud", agents: { "canon-author": { model: "ollama/local" } } }, "openai/cloud"],
      [{ agents: { "canon-author": { model: "ollama/local" } } }, "ollama/local"],
      [{ agents: { "another-agent": { model: "ollama/local" } } }, undefined],
    ];
    for (const [config, expected] of cases) {
      const session = await createPreparedSession(adapter, dir, Promise.resolve(config), { purpose: "extraction", agent: "canon-author" });
      assert.equal(session.model, expected);
    }
  });

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
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
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
        if (input.title === "first") {
          enteredFirst();
          await firstCreated;
        }
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
    await firstEntered;
    const second = createPreparedSession(adapter, dir, { model: "second" }, { purpose: "authoring", title: "second" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["prepare:first", "create:first"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["prepare:first", "create:first", "prepare:second", "create:second"]);
  });

  it("bounds a session creation that never returns and releases the directory queue", async () => {
    const adapter = {
      id: "stuck",
      capabilities: () => new Set(),
      readiness: () => ({ ready: true }),
      sessionFiles: () => [],
      createSession: ({ signal }: CreateSessionInput) =>
        new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
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

    await assert.rejects(
      createPreparedSession(adapter, dir, {}, { purpose: "authoring" }, 10),
      /session creation timed out/,
    );
  });

  it("bounds a session configuration that never settles by the same timeout (issue 1247)", async () => {
    let prepared = 0;
    const adapter = {
      id: "never-configured",
      capabilities: () => new Set(),
      readiness: () => ({ ready: true }),
      sessionFiles: () => [],
      prepareSession: () => { prepared += 1; },
      async createSession() { return { sessionId: "unexpected" }; },
      async sendMessage() { throw new Error("unused"); },
      async dispatchAsync() { throw new Error("unused"); },
      streamEvents() { return { [Symbol.asyncIterator]: async function* () {} }; },
    } as HarnessAdapter;
    const dir = await tempDir("arke-session-files-");
    await assert.rejects(
      createPreparedSession(adapter, dir, new Promise<never>(() => {}), { purpose: "authoring" }, 10),
      /session creation timed out/,
    );
    assert.equal(prepared, 0, "nothing was prepared for a configuration that never arrived");
  });

  it("ends a session creation at the caller's stop while its configuration is still being decided (issue 1247)", async () => {
    let prepared = 0;
    let created = 0;
    const adapter = {
      id: "stopped-while-configuring",
      capabilities: () => new Set(),
      readiness: () => ({ ready: true }),
      sessionFiles: () => [],
      prepareSession: () => { prepared += 1; },
      async createSession() { created += 1; return { sessionId: "unexpected" }; },
      async sendMessage() { throw new Error("unused"); },
      async dispatchAsync() { throw new Error("unused"); },
      streamEvents() { return { [Symbol.asyncIterator]: async function* () {} }; },
    } as HarnessAdapter;
    const dir = await tempDir("arke-session-files-");
    let decide!: (input: { model?: string }) => void;
    const deciding = new Promise<{ model?: string }>((resolve) => { decide = resolve; });
    const stop = new AbortController();
    const creation = createPreparedSession(adapter, dir, deciding, { purpose: "authoring" }, 5_000, stop.signal);
    stop.abort(new Error("run stopped"));
    await assert.rejects(creation, /run stopped/);
    decide({});
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(prepared, 0, "nothing was prepared for a run that had stopped");
    assert.equal(created, 0);
  });
});

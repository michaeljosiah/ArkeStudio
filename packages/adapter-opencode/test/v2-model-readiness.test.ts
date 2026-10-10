import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";
import { until } from "./wait.js";

const pending = { providerID: "github-copilot", id: "fixture-model", package: "@ai-sdk/github-copilot" };
const ready = { ...pending, package: "aisdk:@ai-sdk/anthropic", limit: { input: 123_456 } };

async function fixture(run: (stub: StubOpenCodeV2, adapter: OpenCodeV2Adapter, traces: string[]) => Promise<void>, modelReadyMs = 5_000) {
  const stub = new StubOpenCodeV2();
  await stub.start();
  const traces: string[] = [];
  const adapter = new OpenCodeV2Adapter({
    baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD, modelReadyMs,
    onTrace: line => traces.push(String(line.what)),
  });
  try { await run(stub, adapter, traces); }
  finally { await adapter.dispose(); await stub.stop(); }
}

function prepare(adapter: OpenCodeV2Adapter, cwd: string, signal?: AbortSignal) {
  adapter.prepareSession({ preparationId: cwd, model: "github-copilot/fixture-model", modelVariant: "high" });
  return adapter.createSession({ purpose: "extraction", cwd, agent: "canon-author", preparationId: cwd, signal });
}

function assertRetiredWithoutPrompt(stub: StubOpenCodeV2, traces: string[]) {
  assert.equal(stub.requests.filter(r => r.method === "DELETE").length, 1);
  assert.equal(stub.requests.some(r => r.path.endsWith("/prompt")), false);
  assert.equal(traces.includes("session.created"), false);
}

describe("Copilot per-location readiness (#1696)", () => {
  it("waits independently for Beats, Continuity and Cast despite a ready global catalogue, then submits once", async () => {
    await fixture(async (stub, adapter, traces) => {
      stub.models = [ready];
      const polls = new Map<string, number>();
      stub.modelResponse = directory => {
        if (!directory) return {};
        const count = (polls.get(directory) ?? 0) + 1;
        polls.set(directory, count);
        if (count === 1) assert.equal(traces.filter(what => what === "session.created").length, polls.size - 1);
        return { models: [count === 1 ? pending : ready] };
      };
      await adapter.listModels();
      for (const operation of ["beats", "continuity", "cast"]) {
        const cwd = `C:\\scratch\\${operation}`;
        const session = await prepare(adapter, cwd);
        assert.equal(polls.get(`C:/scratch/${operation}`), 2);
        assert.equal(adapter.knownInputTokenLimit(session.sessionId), 123_456);
        assert.deepEqual(stub.requests.findLast(r => r.path === "/api/session")?.body, {
          location: { directory: `C:/scratch/${operation}` },
          model: { providerID: "github-copilot", id: "fixture-model", variant: "high" },
        });
        await adapter.dispatchAsync({ sessionId: session.sessionId, parts: [{ type: "text", text: "Synthetic fixture" }] });
        await until(() => stub.requests.some(r => r.path === `/api/session/${session.sessionId}/prompt`), "one submitted fixture prompt");
        assert.equal(stub.requests.filter(r => r.path === `/api/session/${session.sessionId}/prompt`).length, 1);
      }
      assert.equal(traces.filter(what => what === "session.created").length, 3);
      assert.ok(stub.requests.every(r => r.authorized));
    });
  });

  it("tolerates the pinned runtime's 503 flush response and pending rows without hiding discovery choices", async () => {
    await fixture(async (stub, adapter) => {
      stub.models = [pending];
      assert.equal((await adapter.listModels())[0]?.id, pending.id);
      let polls = 0;
      stub.modelResponse = () => {
        polls++;
        if (polls === 1) return { status: 503 };
        if (polls === 2) return { models: [] };
        if (polls === 3) return { models: [{ ...ready, disabled: true }] };
        if (polls === 4) return { models: [{ ...ready, id: "another-model" }] };
        return { models: [{ ...ready, package: "aisdk:@ai-sdk/github-copilot" }] };
      };
      await prepare(adapter, "/scratch/slow");
      assert.equal(polls, 5);
      assert.equal(stub.requests.some(r => r.path.endsWith("/prompt")), false);
    });
  });

  for (const mode of ["fallback", "missing", "disabled", "hung"] as const) {
    it(`bounds ${mode} readiness and retires the unpublished session without a prompt`, async () => {
      await fixture(async (stub, adapter, traces) => {
        stub.modelResponse = () => mode === "hung" ? { hold: true } : {
          models: mode === "missing" ? [] : [mode === "disabled" ? { ...ready, enabled: false } : pending],
        };
        await assert.rejects(prepare(adapter, "/scratch/unready"), /GitHub Copilot model fixture-model is not ready.*No prompt was sent/);
        assertRetiredWithoutPrompt(stub, traces);
      }, 100);
    });
  }

  it("honours the caller's cancellation during a hung catalogue request", async () => {
    await fixture(async (stub, adapter, traces) => {
      stub.modelResponse = () => ({ hold: true });
      const stop = new AbortController();
      const creation = prepare(adapter, "/scratch/stopped", stop.signal);
      const rejected = assert.rejects(creation, /author stopped/);
      await until(() => stub.requests.some(r => r.path === "/api/model"), "scoped model request");
      stop.abort(new Error("author stopped"));
      await rejected;
      assertRetiredWithoutPrompt(stub, traces);
    });
  });

  for (const directory of [null, "/another-location"]) {
    it(`rejects ${directory === null ? "missing" : "wrong"} catalogue scope immediately`, async () => {
      await fixture(async (stub, adapter, traces) => {
        stub.modelResponse = () => ({ models: [ready], directory });
        await assert.rejects(prepare(adapter, "/scratch/scope"), /did not confirm the session location/);
        assert.equal(stub.requests.filter(r => r.path === "/api/model").length, 1);
        assertRetiredWithoutPrompt(stub, traces);
      });
    });
  }

  it("does not retry authentication failures", async () => {
    await fixture(async (stub, adapter, traces) => {
      stub.modelResponse = () => ({ status: 401 });
      await assert.rejects(prepare(adapter, "/scratch/auth"), /401/);
      assert.equal(stub.requests.filter(r => r.path === "/api/model").length, 1);
      assertRetiredWithoutPrompt(stub, traces);
    });
  });

  it("does not gate another provider on Copilot readiness", async () => {
    await fixture(async (stub, adapter) => {
      stub.modelResponse = () => ({ hold: true });
      adapter.prepareSession({ preparationId: "local", model: "ollama/fixture-model" });
      await adapter.createSession({ purpose: "extraction", cwd: "/scratch/local", agent: "canon-author", preparationId: "local" });
      assert.equal(stub.requests.some(r => r.path === "/api/model"), false);
    });
  });

  for (const useDefault of [true, false]) {
    it(`checks an unpinned Copilot ${useDefault ? "default" : "fallback"} without pinning a new choice`, async () => {
      await fixture(async (stub, adapter) => {
        stub.defaultModel = useDefault ? pending : null;
        let polls = 0;
        stub.modelResponse = () => ({ models: [
          ...(useDefault ? [{ providerID: "ollama", id: "other", package: "native-ollama" }] : []),
          ++polls === 1 ? pending : ready,
        ] });
        const session = await adapter.createSession({ purpose: "extraction", cwd: "/scratch/default", agent: "canon-author" });
        assert.equal(polls, 2);
        assert.equal(adapter.knownInputTokenLimit(session.sessionId), 123_456);
        assert.deepEqual(stub.requests.find(r => r.path === "/api/session")?.body, { location: { directory: "/scratch/default" } });
        assert.equal(stub.requests.some(r => r.path.endsWith("/model") && r.method === "POST"), false);
        assert.ok(stub.requests.filter(r => r.path.startsWith("/api/model")).every(r => r.query["location[directory]"] === "/scratch/default"));
      });
    });
  }

  it("uses the returned session location when a direct caller supplies no cwd", async () => {
    await fixture(async (stub, adapter) => {
      stub.echoLocation = "/runtime/location";
      stub.models = [ready];
      adapter.prepareSession({ preparationId: "no-cwd", model: "github-copilot/fixture-model" });
      await adapter.createSession({ purpose: "extraction", agent: "canon-author", preparationId: "no-cwd" });
      assert.equal(stub.requests.find(r => r.path === "/api/model")?.query["location[directory]"], "/runtime/location");
    });
  });
});

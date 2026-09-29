import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeAdapter, discoverClaudeModels, normalizeClaudeModels, type OpenModelQuery } from "../src/index.js";

describe("Claude's initialization-only model catalog", () => {
  it("pins resolved identities, merges default aliases, and preserves context choices", () => {
    assert.deepEqual(normalizeClaudeModels([
      { value: "default", resolvedModel: "claude-example[1m]", displayName: "Default (recommended)" },
      { value: "opus[1m]", resolvedModel: "claude-example[1m]", displayName: "Opus (1M context)" },
      { value: "claude-other[1m]", resolvedModel: "claude-other", displayName: "Other (1M context)" },
      { value: "other", resolvedModel: "claude-other", displayName: "Other" },
      { value: "future-alias", displayName: "Future" },
    ]), [
      { id: "claude-example[1m]", provider: "anthropic", displayName: "Opus (1M context)", aliases: ["default", "opus[1m]"], isDefault: true },
      { id: "claude-other[1m]", provider: "anthropic", displayName: "Other (1M context)" },
      { id: "claude-other", provider: "anthropic", displayName: "Other", aliases: ["other"] },
      { id: "future-alias", provider: "anthropic", displayName: "Future" },
    ]);
  });

  it("does not replace a named label when Default arrives last or invent capabilities", () => {
    const [model] = normalizeClaudeModels([
      { value: "named", resolvedModel: "claude-next", displayName: "Named" },
      { value: "default", resolvedModel: "claude-next", displayName: "Default" },
    ]);
    assert.equal(model?.displayName, "Named");
    assert.equal(model?.isDefault, true);
    assert.equal(model?.inputModalities, undefined);
    assert.equal(model?.inputTokenLimit, undefined);
  });

  it("closes after discovery without yielding a user message or inheriting tools", async () => {
    let next!: Promise<IteratorResult<unknown>>;
    let closed = false;
    let controller!: AbortController;
    const rows = [{ value: "default", displayName: "Default" }];
    const open: OpenModelQuery = ({ prompt, options }) => {
      assert.equal(options["pathToClaudeCodeExecutable"], "pinned-claude");
      assert.deepEqual(options["settingSources"], []);
      assert.deepEqual(options["tools"], []);
      assert.deepEqual(options["mcpServers"], {});
      assert.equal(options["persistSession"], false);
      controller = options["abortController"] as AbortController;
      next = prompt[Symbol.asyncIterator]().next();
      return { supportedModels: async () => rows, close: () => { closed = true; } };
    };
    assert.deepEqual(await discoverClaudeModels({ command: "pinned-claude" }, open), rows);
    assert.equal(closed, true);
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(await next, { value: undefined, done: true });
  });

  it("closes a failed discovery and preserves its failure", async () => {
    let closed = false;
    await assert.rejects(discoverClaudeModels({ command: "claude" }, () => ({
      supportedModels: async () => { throw new Error("login unavailable"); },
      close: () => { closed = true; },
    })), /login unavailable/);
    assert.equal(closed, true);
  });

  it("refreshes the live catalog after changes and failures without reusing stale models", async () => {
    let revision = 1; let unavailable = false; let opened = 0; let closed = 0;
    const adapter = new ClaudeAdapter({
      command: "pinned-claude",
      discoverModels: input => discoverClaudeModels(input, () => {
        opened++;
        return {
          supportedModels: async () => {
            if (unavailable) throw new Error("login unavailable");
            return [{ value: "default", resolvedModel: `claude-revision-${revision}`, displayName: "Current default" }];
          },
          close: () => { closed++; },
        };
      }),
    });
    try {
      await adapter.init();
      assert.equal((await adapter.listModels())[0]?.id, "claude-revision-1");
      revision = 2;
      assert.equal((await adapter.listModels())[0]?.id, "claude-revision-2");
      unavailable = true;
      await assert.rejects(adapter.listModels(), /login unavailable/);
      unavailable = false; revision = 3;
      assert.equal((await adapter.listModels())[0]?.id, "claude-revision-3");
      assert.equal(opened, 4, "each explicit refresh initializes current SDK metadata");
      assert.equal(closed, 4, "success and failure both release the discovery process");
    } finally { await adapter.dispose(); }
  });

  it("times out and closes even when the SDK promise ignores cancellation", async () => {
    let closed = false;
    await assert.rejects(discoverClaudeModels({ command: "claude", timeoutMs: 10 }, () => ({
      supportedModels: () => new Promise(() => {}),
      close: () => { closed = true; },
    })), /timed out/);
    assert.equal(closed, true);
  });

  it("advertises the injected catalog and cancels its child on adapter disposal", async () => {
    let opened!: () => void;
    const started = new Promise<void>((resolve) => { opened = resolve; });
    let closed = false;
    const adapter = new ClaudeAdapter({
      command: "claude",
      discoverModels: (input) => discoverClaudeModels(input, () => {
        opened();
        return { supportedModels: () => new Promise(() => {}), close: () => { closed = true; } };
      }),
    });
    assert.equal(adapter.capabilities().has("models"), true);
    const discovery = adapter.listModels();
    const rejected = assert.rejects(discovery, /cancelled/);
    await started;
    await adapter.dispose();
    await rejected;
    assert.equal(closed, true);
    const unavailable = new ClaudeAdapter({ command: "claude" });
    assert.equal(unavailable.capabilities().has("models"), false);
    await assert.rejects(unavailable.listModels(), /not configured/);
  });
});

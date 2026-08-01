import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { WorldQueryServer } from "../../src/harness/world-query.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function rpc(url: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  if (res.status === 202) return undefined;
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

describe("the read-only world-query tool (R-11, D2, D3)", () => {
  let store: WorldStore;
  let server: WorldQueryServer;
  let url: string;

  before(async () => {
    store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
    server = new WorldQueryServer(() => store);
    url = await server.start();
  });
  after(async () => {
    await server.stop();
    await store.close();
  });

  it("speaks MCP: initialize, tools/list", async () => {
    const init = (await rpc(url, "initialize", { protocolVersion: "2025-03-26" })) as {
      serverInfo: { name: string };
      capabilities: { tools: object };
    };
    assert.equal(init.serverInfo.name, "arke-world");
    const list = (await rpc(url, "tools/list")) as { tools: Array<{ name: string; inputSchema: unknown }> };
    assert.deepEqual(
      list.tools.map((t) => t.name).sort(),
      ["get_entry", "get_sheet", "list_entities", "related", "search_canon"],
    );
  });

  it("exposes no write operation and no path parameter anywhere (D2)", async () => {
    const list = (await rpc(url, "tools/list")) as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    };
    for (const tool of list.tools) {
      assert.ok(!/write|edit|delete|create|move/.test(tool.name), `${tool.name} is a read`);
      for (const param of Object.keys(tool.inputSchema.properties)) {
        assert.ok(
          !/path|file|dir|folder/i.test(param),
          `${tool.name}.${param} must not express a filesystem location`,
        );
      }
    }
  });

  it("serves ranked canon search with full statement text and the searched count (D3)", async () => {
    const result = (await rpc(url, "tools/call", {
      name: "search_canon",
      arguments: { query: "tide calling" },
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text) as {
      searched: number;
      candidates: Array<{ entryId: string; statement: string }>;
    };
    assert.equal(parsed.searched, 5);
    assert.equal(parsed.candidates[0]!.entryId, "CANON-002");
    assert.ok(parsed.candidates[0]!.statement.includes("stood in"), "full statement text (R-23)");
  });

  it("serves sheets and citations through the index, never the filesystem", async () => {
    const sheet = (await rpc(url, "tools/call", { name: "get_sheet", arguments: { id: "maren-kest" } })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(sheet.content[0]!.text) as { id: string; version: number };
    assert.equal(parsed.id, "maren-kest");
    assert.equal(parsed.version, 4);

    const related = (await rpc(url, "tools/call", { name: "related", arguments: { id: "maren-kest" } })) as {
      content: Array<{ text: string }>;
    };
    const refs = JSON.parse(related.content[0]!.text) as { tiles: number };
    assert.equal(refs.tiles, 3);
  });

  it("returns tool errors as content, not crashes", async () => {
    const result = (await rpc(url, "tools/call", { name: "get_sheet", arguments: { id: "nobody" } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /no sheet/);
  });
});

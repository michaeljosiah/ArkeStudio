import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { refsForCanon, refsForSheet, searchCanon } from "../index-db/queries.js";
import type { WorldStore } from "../world/store.js";

/**
 * The read-only world-query tool, served over MCP streamable HTTP (SPEC-005 §2.5.1, D2, D3).
 *
 * The agent's working directory is its proposal; everything else it may READ, it asks for
 * here — ranked retrieval backed by the SPEC-003 index, the same search the canon Q&A path
 * uses. There is no write operation and no path parameter anywhere in the surface, so the
 * tool cannot be steered at the filesystem.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "search_canon",
    description:
      "Lexically search the world's canon entries. Returns ranked candidates with FULL statement text so answers can quote verifiable spans, plus how many entries were searched. Below-floor results mean canon does not answer the query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms" },
        limit: { type: "number", description: "Maximum candidates (default 8)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_entry",
    description: "Fetch one canon entry by id (e.g. CANON-002): title, status, lineage, full statement.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Canon id, CANON-nnn" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sheet",
    description: "Fetch one sheet by slug (character, location or faction): frontmatter and prose sections at the current version.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Sheet slug, e.g. maren-kest" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_entities",
    description: "List world entities of a kind (character | location | faction | canon | production), with status and version.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Entity kind" },
        status: { type: "string", description: "Optional status filter" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "related",
    description: "What cites and is cited by an entity id — citations with the versions they were made at.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Sheet slug or canon id" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
] as const;

export class WorldQueryServer {
  private server: Server | null = null;
  private port = 0;

  constructor(private readonly getStore: () => WorldStore | null) {}

  url(): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/mcp` : null;
  }

  async start(): Promise<string> {
    if (this.server) return this.url()!;
    const server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        let rpc: JsonRpcRequest;
        try {
          rpc = JSON.parse(body) as JsonRpcRequest;
        } catch {
          res.writeHead(400).end();
          return;
        }
        const reply = (result: unknown) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }));
        };
        const replyError = (code: number, message: string) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } }));
        };

        switch (rpc.method) {
          case "initialize":
            reply({
              protocolVersion: (rpc.params?.["protocolVersion"] as string) ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "arke-world", version: "1.0.0" },
            });
            return;
          case "notifications/initialized":
          case "initialized":
            res.writeHead(202).end();
            return;
          case "ping":
            reply({});
            return;
          case "tools/list":
            reply({ tools: TOOLS });
            return;
          case "tools/call": {
            const name = rpc.params?.["name"] as string;
            const args = (rpc.params?.["arguments"] as Record<string, unknown>) ?? {};
            try {
              const result = this.call(name, args);
              reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
            } catch (err) {
              reply({
                content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
              });
            }
            return;
          }
          default:
            replyError(-32601, `method not found: ${rpc.method}`);
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no bound address");
    this.server = server;
    this.port = address.port;
    server.unref();
    return this.url()!;
  }

  /** Every operation is a read; nothing here can express a filesystem location (D2). */
  private call(name: string, args: Record<string, unknown>): unknown {
    const store = this.getStore();
    if (!store) throw new Error("no world is open");
    const bundle = store.getBundle();
    const index = store.getIndex();

    switch (name) {
      case "search_canon": {
        if (!index) throw new Error("the index is unavailable");
        const query = String(args["query"] ?? "");
        const limit = typeof args["limit"] === "number" ? args["limit"] : 8;
        return searchCanon(index.db, query, { limit });
      }
      case "get_entry": {
        const id = String(args["id"] ?? "");
        const entry = bundle.canon.find((c) => c.id === id);
        if (!entry) throw new Error(`no canon entry ${id}`);
        return entry;
      }
      case "get_sheet": {
        const id = String(args["id"] ?? "");
        const sheet = bundle.sheets.find((s) => s.id === id);
        if (!sheet) throw new Error(`no sheet ${id}`);
        return sheet;
      }
      case "list_entities": {
        const kind = String(args["kind"] ?? "");
        const status = args["status"] !== undefined ? String(args["status"]) : undefined;
        if (kind === "canon") {
          return bundle.canon
            .filter((c) => status === undefined || c.status === status)
            .map((c) => ({ id: c.id, title: c.title, type: c.type, status: c.status }));
        }
        if (kind === "production") {
          return bundle.productions.map((p) => ({ id: p.meta.id, title: p.meta.title, format: p.meta.format }));
        }
        return bundle.sheets
          .filter((s) => s.type === kind)
          .filter((s) => status === undefined || s.status === status)
          .map((s) => ({ id: s.id, name: s.name, status: s.status, version: s.version }));
      }
      case "related": {
        if (!index) throw new Error("the index is unavailable");
        const id = String(args["id"] ?? "");
        return /^CANON-/.test(id) ? refsForCanon(index.db, id) : refsForSheet(index.db, id);
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

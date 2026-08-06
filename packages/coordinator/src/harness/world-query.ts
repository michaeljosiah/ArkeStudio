import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { WorldChatCheckReceipt } from "@arke-studio/contracts";
import { refsForCanon, refsForSheet, searchCanon } from "../index-db/queries.js";
import { LeaseDeniedError } from "../world-chat/lease.js";
import type { WorldChatRetrieval } from "../world-chat/retrieval.js";
import type { WorldStore } from "../world/store.js";

/**
 * The read-only world-query tool, served over MCP streamable HTTP (SPEC-005 §2.5.1, D2, D3).
 *
 * The agent's working directory is its proposal; everything else it may READ, it asks for
 * here — ranked retrieval backed by the SPEC-003 index, the same search the canon Q&A path
 * uses. There is no write operation and no path parameter anywhere in the surface, so the
 * tool cannot be steered at the filesystem.
 *
 * Two surfaces are served from one port (#70 §9.1):
 *
 * - `/mcp` resolves against whichever world is open. That is right for the authoring agents,
 *   which run inside the world the user is looking at and have no life beyond it.
 * - `/mcp/<lease>` resolves against the world the lease was minted for, and refuses if that is
 *   no longer the open one. World Chat runs outlive a moment of UI state, so "whichever world
 *   is open" is not a safe question for them to be answered from.
 *
 * A path under `/mcp/` that is not a well-formed lease is rejected rather than falling back to
 * the ambient surface, because falling back is precisely the bypass the lease exists to prevent.
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

/** The World Chat surface (#70 §9.2): the five above, plus sheet search and attachment text. */
const WORLD_CHAT_TOOLS = [
  ...TOOLS,
  {
    name: "search_sheets",
    description:
      "Lexically search accepted character, location and faction sheets by name, role or region, and authored prose. Use this to find out whether an entity already exists before proposing a new one. Retired sheets are not searched.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms" },
        kind: { type: "string", description: "Optional: character | location | faction" },
        limit: { type: "number", description: "Maximum candidates (default 8, maximum 20)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_attachment_text",
    description:
      "Read a bounded range of text from a document attached to this conversation. Only attachments explicitly linked to this turn are readable, and only if they are text. Images, audio and video cannot be read.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Conversation attachment id" },
        offset: { type: "number", description: "Character offset to start from (default 0)" },
        limit: { type: "number", description: "Maximum characters to return" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
] as const;

export interface LeasedSurface {
  retrieval: WorldChatRetrieval;
  /** Every call's receipt, including the ones that failed or could not run (§9.3). */
  onReceipt: (receipt: WorldChatCheckReceipt) => void;
}

/** A minted lease token: 32 random bytes as hex. */
const LEASE_PATH = /^\/mcp\/([0-9a-f]{64})$/;

export class WorldQueryServer {
  private server: Server | null = null;
  private port = 0;

  constructor(
    private readonly getStore: () => WorldStore | null,
    private readonly leased?: LeasedSurface,
  ) {}

  url(): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/mcp` : null;
  }

  /** The URL a leased run's session configuration points at (§8.2). */
  leasedUrl(token: string): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/mcp/${token}` : null;
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

        const path = (req.url ?? "/mcp").split("?")[0] ?? "/mcp";
        let token: string | null = null;
        if (path.startsWith("/mcp/")) {
          const match = LEASE_PATH.exec(path);
          if (!match || !this.leased) {
            res.writeHead(404).end();
            return;
          }
          token = match[1]!;
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
            reply({ tools: token === null ? TOOLS : WORLD_CHAT_TOOLS });
            return;
          case "tools/call": {
            const name = rpc.params?.["name"] as string;
            const args = (rpc.params?.["arguments"] as Record<string, unknown>) ?? {};
            const asError = (err: unknown) =>
              reply({
                content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
              });

            if (token !== null) {
              const leased = this.leased!;
              void leased.retrieval
                .call(token, name, args)
                .then(({ result, receipt }) => {
                  leased.onReceipt(receipt);
                  reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
                })
                .catch((err: unknown) => {
                  // A denied lease is not a tool failure to be recorded against the run; it means
                  // this caller may not read the world at all, so nothing was observed.
                  if (!(err instanceof LeaseDeniedError)) {
                    const receipt = (err as { receipt?: WorldChatCheckReceipt }).receipt;
                    if (receipt) leased.onReceipt(receipt);
                  }
                  asError(err);
                });
              return;
            }

            try {
              const result = this.call(name, args);
              reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
            } catch (err) {
              asError(err);
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
        return id.startsWith("CANON-") ? refsForCanon(index.db, id) : refsForSheet(index.db, id);
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

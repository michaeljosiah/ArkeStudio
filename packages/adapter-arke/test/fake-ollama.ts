import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted `/api/chat` answer: streamed chunks, an HTTP refusal, or a stream that never ends. */
export type ChatScript =
  | { chunks: Record<string, unknown>[] }
  | { status: number; error: string }
  | { hang: true; chunks?: Record<string, unknown>[] }
  | { drop: true; chunks: Record<string, unknown>[] };

export interface FakeModel { name: string; capabilities?: string[]; context?: number; stall?: boolean }
// `capabilities` left out entirely models an Ollama whose show states no capability list.

/**
 * A scripted Ollama: `/api/tags` and `/api/show` from a model list, and `/api/chat` answering
 * from a queue, one script per call. Every chat request body is kept for the test to read.
 */
export class FakeOllama {
  readonly chats: Array<Record<string, unknown>> = [];
  /** `/api/generate` bodies: the only use here is an unload. */
  readonly generates: Array<Record<string, unknown>> = [];
  /** How long an unload takes to answer. */
  generateDelayMs = 0;
  /** Request order, for the tests that are about what happens before what. */
  readonly log: string[] = [];
  readonly script: ChatScript[] = [];
  models: FakeModel[] = [{ name: "gemma4:12b", capabilities: ["completion", "tools"], context: 262144 }];
  aborted = 0;
  private server: Server | null = null;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/api/tags") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: this.models.map((m) => ({ name: m.name })) })); return; }
        if (req.url === "/api/show") {
          const { model } = JSON.parse(body) as { model: string };
          const found = this.models.find((m) => m.name === model);
          if (found?.stall) return;
          if (!found) { res.writeHead(404).end(JSON.stringify({ error: "model not found" })); return; }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            capabilities: found.capabilities, model_info: { "general.architecture": "gemma4", ...(found.context ? { "gemma4.context_length": found.context } : {}) },
          }));
          return;
        }
        if (req.url === "/api/generate") {
          this.generates.push(JSON.parse(body) as Record<string, unknown>);
          this.log.push("unload:start");
          setTimeout(() => {
            this.log.push("unload:end");
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ done: true, done_reason: "unload" }));
          }, this.generateDelayMs);
          return;
        }
        if (req.url === "/api/chat") {
          this.chats.push(JSON.parse(body) as Record<string, unknown>);
          this.log.push("chat");
          const next = this.script.shift() ?? { chunks: [{ message: { role: "assistant", content: "" }, done: true }] };
          if ("status" in next) { res.writeHead(next.status, { "content-type": "application/json" }).end(JSON.stringify({ error: next.error })); return; }
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          for (const chunk of next.chunks ?? []) res.write(JSON.stringify(chunk) + "\n");
          if ("drop" in next) { setTimeout(() => res.socket?.destroy(), 20); return; }
          if ("hang" in next) { req.on("close", () => { this.aborted++; }); res.on("close", () => { this.aborted++; }); return; }
          res.end();
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

/** A reply that streams `text` in two pieces and finishes. */
export function reply(text: string, tokens = { prompt: 100, output: 10 }): ChatScript {
  const half = Math.ceil(text.length / 2);
  return { chunks: [
    { message: { role: "assistant", content: text.slice(0, half) }, done: false },
    { message: { role: "assistant", content: text.slice(half) }, done: false },
    { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: tokens.prompt, eval_count: tokens.output },
  ] };
}

/** A reply that calls one tool and finishes. */
export function callTool(name: string, args: Record<string, unknown>): ChatScript {
  return { chunks: [
    { message: { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] }, done: false },
    { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 50, eval_count: 5 },
  ] };
}

/** A reply whose text is `content` exactly, in one piece. */
export function say(content: string): ChatScript {
  return { chunks: [
    { message: { role: "assistant", content }, done: false },
    { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 20, eval_count: 5 },
  ] };
}

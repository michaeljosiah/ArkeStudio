import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { SessionFile, PrivateSessionRequest, PrivateSessionTransport } from "@arke-studio/contracts";
import { sameDirectory, type OpenCodeV2Http, type V2Envelope } from "./http.js";

const DIRECTORY = ".arke-private-control";
const ID = "arke.studio.private-control.v1";
export function privateBridgeTransport(value: PrivateSessionTransport): Readonly<PrivateSessionTransport> {
  if (typeof value.baseURL !== "string" || value.baseURL.length > 128) throw new Error("Invalid private native bridge capability.");
  const route = new URL(value.baseURL);
  if (Object.keys(value).some(key => key !== "baseURL" && key !== "apiKey") || route.protocol !== "http:" || route.hostname !== "127.0.0.1" ||
    route.pathname !== "/v1" || route.username || route.password || route.search || route.hash || value.baseURL !== route.origin + "/v1" || !/^[a-f0-9]{64}$/.test(value.apiKey)) throw new Error("Invalid private native bridge capability.");
  return Object.freeze({ baseURL: value.baseURL, apiKey: value.apiKey });
}
const SOURCE = `export default {
  id: "${ID}",
  async setup(api) {
    await api.session.hook("retry", event => { event.decision = { retry: false }; });
  }
};
`;

/** Fixed application control code, never instructions supplied by a model or Settings. */
export const PRIVATE_CONTROL_FILES: readonly SessionFile[] = Object.freeze([
  Object.freeze({ name: `${DIRECTORY}/package.json`, contents: '{"type":"module","main":"index.js","private":true}\n' }),
  Object.freeze({ name: `${DIRECTORY}/index.js`, contents: SOURCE }),
]);

export function privateWireBody(request: PrivateSessionRequest) {
  if (!request || typeof request.model !== "string" || Object.keys(request).some(key => !["model", "system", "prompt", "outputTokenLimit"].includes(key))) throw new Error("Invalid private provider request manifest.");
  const slash = request.model.indexOf("/");
  if (slash < 1 || slash === request.model.length - 1 || request.model.length > 512 || typeof request.system !== "string" || Buffer.byteLength(request.system) > 32 * 1024 ||
    typeof request.prompt !== "string" || Buffer.byteLength(request.prompt) > 192 * 1024 || !Number.isSafeInteger(request.outputTokenLimit) || request.outputTokenLimit < 1 || request.outputTokenLimit > 4096) throw new Error("Invalid private provider request manifest.");
  return { model: request.model.slice(slash + 1), messages: [{ role: "system", content: request.system }, { role: "user", content: request.prompt }],
    stream: true, stream_options: { include_usage: true }, max_completion_tokens: request.outputTokenLimit, store: false };
}

function requestDigest(request: PrivateSessionRequest): string { return createHash("sha256").update(JSON.stringify(privateWireBody(request))).digest("hex"); }

/** Fixed candidate protocol for native transient generation. Native's HTTP bridge buffers
 * upstream bytes before this hook: this bounds admission here, not that upstream allocation.
 * The SDK receives only a reconstructed, complete zero-tool stream, never raw error bodies,
 * partial text, provider metadata or an unverified finish reason. */
const TRANSIENT_RESPONSE_CONTROL = String.raw`
    await api.session.hook("http.response", async event => {
      const original = event.response, reader = original.body?.getReader();
      if (!reader) throw new Error("Private response refused");
      const chunks = []; let bytes = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 1024 * 1024 || chunks.length >= 16384) { void reader.cancel().catch(() => {}); throw new Error("Private response refused"); } chunks.push(next.value); } }
      catch { throw new Error("Private response refused"); }
      finally { reader.releaseLock(); }
      if (!transmitted || responded || event.kind !== "generate" || event.request.url !== endpoint || original.status !== 200 ||
        original.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream") throw new Error("Private response refused");
      try {
        const joined = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
        const source = new TextDecoder("utf-8", { fatal: true }).decode(joined).replace(/\r\n/g, "\n");
        const frames = source.split("\n\n"); if (frames.length > 16384 || frames.pop()?.trim()) throw 0;
        let text = "", finished = false, done = false, usage;
        for (const frame of frames) {
          const lines = frame.split("\n").filter(line => line && !line.startsWith(":")); if (!lines.length) continue;
          if (done || lines.some(line => !line.startsWith("data:"))) throw 0;
          const payload = lines.map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (payload === "[DONE]") { if (!finished) throw 0; done = true; continue; }
          const row = JSON.parse(payload);
          if (!row || row.error !== undefined || row.model !== reviewed.model || !Array.isArray(row.choices) || row.choices.length > 1) throw 0;
          if (row.usage !== undefined && row.usage !== null) {
            if (usage) throw 0;
            const input = row.usage.prompt_tokens, output = row.usage.completion_tokens;
            if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0 || output > reviewed.max_completion_tokens) throw 0;
            usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
            if (!Number.isSafeInteger(usage.total_tokens)) throw 0;
          }
          if (!row.choices.length) { if (!finished || !row.usage) throw 0; continue; }
          const choice = row.choices[0], delta = choice?.delta;
          if (finished || choice.index !== 0 || !delta || typeof delta !== "object" || Array.isArray(delta) ||
            Object.keys(delta).some(key => key !== "role" && key !== "content") ||
            delta.role !== undefined && delta.role !== "assistant" || delta.content !== undefined && delta.content !== null && typeof delta.content !== "string") throw 0;
          text += delta.content ?? "";
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (choice.finish_reason !== "stop") throw 0; finished = true; }
        }
        if (!done || !finished || new TextEncoder().encode(text).byteLength > 192 * 1024) throw 0;
        const chunk = (delta, finish_reason) => ({ id: "arke-private-response", object: "chat.completion.chunk", created: 0, model: reviewed.model,
          choices: [{ index: 0, delta, finish_reason }] });
        const body = "data: " + JSON.stringify(chunk({ content: text }, null)) + "\n\ndata: " +
          JSON.stringify({ ...chunk({}, "stop"), ...(usage ? { usage } : {}) }) + "\n\ndata: [DONE]\n\n";
        responded = true;
        event.response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      } catch { throw new Error("Private response refused"); }
    });
`;

export function privateControlFiles(request?: PrivateSessionRequest, kind: "primary" | "generate" = "primary"): readonly SessionFile[] {
  if (kind !== "primary" && kind !== "generate") throw new Error("Invalid private native request kind.");
  if (!request) { if (kind !== "primary") throw new Error("A transient control requires its reviewed manifest."); return PRIVATE_CONTROL_FILES; }
  const digest = requestDigest(request), provider = request.model.slice(0, request.model.indexOf("/"));
  const code = `export default {
  id: "${ID}.${kind === "generate" ? "transient." : ""}${digest}",
  async setup(api) {
    const body = JSON.stringify(api.options.body);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))).map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== "${digest}") throw new Error("Private request manifest mismatch");
    ${kind === "generate" ? "const reviewed = JSON.parse(body);" : ""}
    let endpoint, transmitted = false${kind === "generate" ? ", responded = false" : ""};
    await api.session.hook("retry", event => { event.decision = { retry: false }; });
    await api.session.hook("model.request", event => {
      if (event.kind !== ${JSON.stringify(kind)} || event.model.providerID !== ${JSON.stringify(provider)} || event.model.id !== ${JSON.stringify(privateWireBody(request).model)}) throw new Error("Private model request mismatch");
      const base = new URL(event.baseURL);
      if (base.username || base.password || base.search || base.hash || base.pathname.replace(/\\/$/, "") !== "/v1") throw new Error("Private transport mismatch");
      endpoint = base.origin + "/v1/chat/completions";
    });
${kind === "generate" ? TRANSIENT_RESPONSE_CONTROL : ""}
    await api.session.hook("http.request", async event => {
      const original = event.request, reader = original.body?.getReader();
      if (!reader) throw new Error("Private request body missing");
      let bytes = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 1024 * 1024) { void reader.cancel().catch(() => {}); throw new Error("Private request body exceeds its bound"); } } }
      finally { reader.releaseLock(); }
      // Consume the original before validation. A refusal cannot fall through with its body.
      if (transmitted || original.method !== "POST" || original.url !== endpoint) throw new Error("Private request refused");
      transmitted = true;
      event.request = new Request(endpoint, { method: "POST", signal: original.signal,
        headers: { "content-type": "application/json", ...(original.headers.has("authorization") ? { authorization: original.headers.get("authorization") } : {}) }, body });
    });
  }
};
`;
  return [PRIVATE_CONTROL_FILES[0]!, { name: PRIVATE_CONTROL_FILES[1]!.name, contents: code }];
}

export function privateControlDirectory(directory: string): string {
  if (!isAbsolute(directory)) throw new Error("Private native control requires an absolute session directory.");
  const path = resolve(directory, DIRECTORY).replaceAll("\\", "/");
  // Native resource policies use globs. An unqualified path cannot become a broader allow.
  if (path.length > 4096 || path.includes("\0") || [...path].some(character => "*?[]{}!".includes(character))) throw new Error("The private native control path cannot be pinned to a literal policy.");
  return path;
}

/** Native activation/source evidence for the fixed retry control. This is not an OS sandbox
 * or a proof against arbitrary external modification of the host's owned control files. */
export async function privateControlProof(http: OpenCodeV2Http, directory: string, signal: AbortSignal, request?: PrivateSessionRequest, kind: "primary" | "generate" = "primary"): Promise<string | null | undefined> {
  if (kind !== "primary" && kind !== "generate" || kind === "generate" && !request) return null;
  const source = `${privateControlDirectory(directory)}/index.js`;
  const envelope = await http.req<V2Envelope<Array<{ id?: string; source?: { type?: string; path?: string }; state?: { status?: string }; features?: { server?: boolean } }>>>(
    "GET", "/api/plugin", undefined, { location: directory, signal, responseBytes: 1024 ** 2 });
  if (!sameDirectory(envelope?.location?.directory, directory) || !Array.isArray(envelope.data) || envelope.data.length > 256) return null;
  if (envelope.data.length === 0) return undefined; // measured native location activation is asynchronous
  const external = envelope.data.filter(row => row?.source?.type !== "builtin");
  if (external.length !== 1) return null;
  const control = external[0]!;
  const id = request ? `${ID}.${kind === "generate" ? "transient." : ""}${requestDigest(request)}` : ID;
  if (!control || control.id !== id || control.source?.type !== "local" || typeof control.source.path !== "string" || !sameDirectory(control.source.path, source) || control.state?.status !== "active" || control.features?.server !== true) return null;
  return createHash("sha256").update(JSON.stringify([id, source, privateControlFiles(request, kind)])).digest("hex");
}

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { SessionFile, PrivateSessionRequest } from "@arke-studio/contracts";
import { sameDirectory, type OpenCodeV2Http, type V2Envelope } from "./http.js";

const DIRECTORY = ".arke-private-control";
const ID = "arke.studio.private-control.v1";
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

export function privateControlFiles(request?: PrivateSessionRequest): readonly SessionFile[] {
  if (!request) return PRIVATE_CONTROL_FILES;
  const digest = requestDigest(request), provider = request.model.slice(0, request.model.indexOf("/"));
  const code = `export default {
  id: "${ID}.${digest}",
  async setup(api) {
    const body = JSON.stringify(api.options.body);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))).map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== "${digest}") throw new Error("Private request manifest mismatch");
    let endpoint, transmitted = false;
    await api.session.hook("retry", event => { event.decision = { retry: false }; });
    await api.session.hook("model.request", event => {
      if (event.kind !== "primary" || event.model.providerID !== ${JSON.stringify(provider)} || event.model.id !== ${JSON.stringify(privateWireBody(request).model)}) throw new Error("Private model request mismatch");
      const base = new URL(event.baseURL);
      if (base.username || base.password || base.search || base.hash || base.pathname.replace(/\\/$/, "") !== "/v1") throw new Error("Private transport mismatch");
      endpoint = base.origin + "/v1/chat/completions";
    });
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
export async function privateControlProof(http: OpenCodeV2Http, directory: string, signal: AbortSignal, request?: PrivateSessionRequest): Promise<string | null | undefined> {
  const source = `${privateControlDirectory(directory)}/index.js`;
  const envelope = await http.req<V2Envelope<Array<{ id?: string; source?: { type?: string; path?: string }; state?: { status?: string }; features?: { server?: boolean } }>>>(
    "GET", "/api/plugin", undefined, { location: directory, signal, responseBytes: 1024 ** 2 });
  if (!sameDirectory(envelope?.location?.directory, directory) || !Array.isArray(envelope.data) || envelope.data.length > 256) return null;
  if (envelope.data.length === 0) return undefined; // measured native location activation is asynchronous
  const external = envelope.data.filter(row => row?.source?.type !== "builtin");
  if (external.length !== 1) return null;
  const control = external[0]!;
  const id = request ? `${ID}.${requestDigest(request)}` : ID;
  if (!control || control.id !== id || control.source?.type !== "local" || typeof control.source.path !== "string" || !sameDirectory(control.source.path, source) || control.state?.status !== "active" || control.features?.server !== true) return null;
  return createHash("sha256").update(JSON.stringify([id, source, privateControlFiles(request)])).digest("hex");
}

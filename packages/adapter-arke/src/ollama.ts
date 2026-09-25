import { object, type JsonObject } from "@arke-studio/confined-tools";

/**
 * The slice of Ollama's native API this harness speaks (issue 1247, Phase 2).
 *
 * Native rather than the OpenAI-compatible route on purpose: `/api/chat` takes `options.num_ctx`
 * and `keep_alive` per request, and the compatible route takes neither, so a model reached
 * through it runs at whatever context the server defaults to and may cut long world context
 * without saying so. That is most of the reason this harness exists.
 */

/** Where Ollama answers unless the host says otherwise. */
export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";

/**
 * The base URL, refused unless it is loopback. A remote runtime would carry world content off
 * the machine; that is a setting somebody chooses, never something inherited from an environment
 * variable or a default.
 */
export function loopbackBaseUrl(raw: string, allowRemote = false): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Ollama must be reached over HTTP.");
  if (url.username || url.password || url.search || url.hash) throw new Error("The Ollama address must be a plain host and port.");
  if (!allowRemote && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new Error("Ollama must run on this machine. A remote runtime is an explicit setting.");
  }
  return url.origin;
}

/** One message as `/api/chat` takes it. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Base64 images, for a model that reads them. */
  images?: string[];
  tool_calls?: ChatToolCall[];
  /** Which tool a `tool` message answers. */
  tool_name?: string;
}
export interface ChatToolCall { function: { name: string; arguments: JsonObject } }
export interface ChatTool { type: "function"; function: { name: string; description: string; parameters: JsonObject } }

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ChatTool[];
  numCtx: number;
  keepAlive?: string | number;
}

/** What one streamed `/api/chat` call produced, once it is done. */
export interface ChatResult {
  content: string;
  toolCalls: ChatToolCall[];
  /** Prompt tokens evaluated and tokens generated, as Ollama counts them. */
  promptTokens: number;
  outputTokens: number;
  doneReason: string | null;
}

export class OllamaChatError extends Error {}
export class OllamaUnreachableError extends Error {}

/**
 * Stream one chat call. `onText` receives the answer so far after every chunk that adds to it.
 *
 * The stream is NDJSON: one object per line, content arriving in pieces, tool calls arriving
 * whole on a chunk of their own, and a final object with `done: true` and the token counts. A
 * stream that ends without that final object is an error, not a short answer — the model did
 * not finish, and treating what arrived as its reply would hand the caller half a thought.
 */
export async function streamChat(
  fetchImpl: typeof fetch, baseUrl: string, request: ChatRequest, signal: AbortSignal, onText: (text: string) => void,
): Promise<ChatResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({
        model: request.model, messages: request.messages, stream: true,
        ...(request.tools.length > 0 ? { tools: request.tools } : {}),
        options: { num_ctx: request.numCtx },
        ...(request.keepAlive !== undefined ? { keep_alive: request.keepAlive } : {}),
      }),
    });
  } catch (error) {
    // A request that never reached Ollama says the runtime is gone, not that this turn went
    // wrong: the adapter reports that as readiness, which is all a health loop can see.
    if (signal.aborted) throw error;
    throw new OllamaUnreachableError("Ollama is not answering on this machine.", { cause: error });
  }
  if (!response.ok) {
    const detail = object(await response.json().catch(() => ({}))).error;
    throw new OllamaChatError(typeof detail === "string" && detail ? `Ollama refused the request: ${detail}` : `Ollama refused the request (HTTP ${response.status}).`);
  }
  if (!response.body) throw new OllamaChatError("Ollama returned no response.");
  const result: ChatResult = { content: "", toolCalls: [], promptTokens: 0, outputTokens: 0, doneReason: null };
  let done = false;
  let pending = "";
  const decoder = new TextDecoder();
  const take = (line: string) => {
    if (!line.trim()) return;
    let chunk: JsonObject;
    try { chunk = object(JSON.parse(line)); } catch { throw new OllamaChatError("Ollama returned a malformed stream."); }
    if (typeof chunk.error === "string") throw new OllamaChatError(`Ollama stopped: ${chunk.error}`);
    const message = object(chunk.message);
    if (typeof message.content === "string" && message.content) { result.content += message.content; onText(result.content); }
    if (Array.isArray(message.tool_calls)) {
      for (const raw of message.tool_calls) {
        const call = object(object(raw).function);
        if (typeof call.name !== "string" || !call.name) continue;
        result.toolCalls.push({ function: { name: call.name, arguments: argumentsOf(call.arguments) } });
      }
    }
    if (chunk.done === true) {
      done = true;
      if (typeof chunk.prompt_eval_count === "number") result.promptTokens = chunk.prompt_eval_count;
      if (typeof chunk.eval_count === "number") result.outputTokens = chunk.eval_count;
      if (typeof chunk.done_reason === "string") result.doneReason = chunk.done_reason;
    }
  };
  try {
    for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(bytes, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) { take(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
    }
  } catch (error) {
    // Ollama exiting mid-generation surfaces here, after the headers, as a transport error
    // ("terminated"): the same loss as a refused connection, so it is reported the same way.
    if (signal.aborted || error instanceof OllamaChatError) throw error;
    throw new OllamaUnreachableError("Ollama stopped answering during the reply.", { cause: error });
  }
  take(pending + decoder.decode());
  if (!done) throw new OllamaChatError("Ollama ended the reply before it finished.");
  return result;
}

/**
 * Tool arguments as an object. Ollama sends an object; some model templates put a JSON string
 * there instead, which is still the model's intent. Anything else is no arguments — the tool's
 * own check then refuses the call for what is missing, rather than this guessing at it.
 */
function argumentsOf(raw: unknown): JsonObject {
  if (typeof raw === "string") { try { return object(JSON.parse(raw)); } catch { return {}; } }
  return object(raw);
}

/** A pulled model, as the harness catalogue describes it. */
export interface PulledModel {
  id: string; contextLength?: number;
  /** Whether the model calls tools, when Ollama says; undefined when it lists no capabilities. */
  tools: boolean | undefined;
  vision: boolean;
  /** Its details could not be read at all: nothing about it — not even its window — is known. */
  assumed?: boolean;
}

/**
 * What is pulled, with what each model can do. The same reading as the coordinator's listing:
 * a model that does not complete (an embedding model) is left out; one whose details could not
 * be read is listed with tools assumed and no image input claimed.
 */
export async function listPulled(fetchImpl: typeof fetch, baseUrl: string, signal: AbortSignal, deadlineMs: number): Promise<PulledModel[]> {
  // Two different stops. The caller's signal is cancellation and ends the pass. The deadline is
  // this listing's own patience: whatever has not been inspected by then is listed as assumed,
  // so any number of stalled models costs one deadline rather than the whole catalogue.
  const cutoff = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
  const listed = await listTags(fetchImpl, baseUrl, cutoff);
  const ids = listed.flatMap((raw) => { const id = object(raw).name; return typeof id === "string" && id ? [id] : []; });
  const rows: Array<PulledModel | null> = ids.map(assumedRow);
  let next = 0;
  const worker = async () => {
    for (let at = next++; at < ids.length && !cutoff.aborted; at = next++) rows[at] = await inspect(fetchImpl, baseUrl, ids[at]!, signal, cutoff);
  };
  await Promise.all(Array.from({ length: Math.min(INSPECTION_CONCURRENCY, ids.length) }, worker));
  signal.throwIfAborted();
  return rows.filter((row): row is PulledModel => row !== null);
}

function assumedRow(id: string): PulledModel { return { id, tools: undefined, vision: false, assumed: true }; }

/** Whether Ollama answers at all: the model list, without inspecting each model. */
export async function listTags(fetchImpl: typeof fetch, baseUrl: string, signal: AbortSignal): Promise<unknown[]> {
  const tags = await fetchImpl(`${baseUrl}/api/tags`, { redirect: "error", signal });
  if (!tags.ok) throw new Error(`Ollama could not list its models (HTTP ${tags.status}).`);
  const listed = object(await tags.json()).models;
  if (!Array.isArray(listed)) throw new Error("Ollama did not return a model list.");
  return listed;
}

const INSPECTION_CONCURRENCY = 4;
const INSPECTION_TIMEOUT_MS = 5_000;

async function inspect(fetchImpl: typeof fetch, baseUrl: string, id: string, signal: AbortSignal, cutoff: AbortSignal): Promise<PulledModel | null> {
  signal.throwIfAborted();
  let details: JsonObject | null = null;
  try {
    const shown = await fetchImpl(`${baseUrl}/api/show`, {
      method: "POST", redirect: "error", signal: AbortSignal.any([cutoff, AbortSignal.timeout(INSPECTION_TIMEOUT_MS)]),
      headers: { "content-type": "application/json" }, body: JSON.stringify({ model: id }),
    });
    if (shown.ok) details = object(await shown.json());
  } catch (error) { if (signal.aborted) throw error; }
  if (details === null) return assumedRow(id);
  const capabilities = Array.isArray(details.capabilities) ? details.capabilities.filter((value): value is string => typeof value === "string") : null;
  if (capabilities && !capabilities.includes("completion")) return null;
  const info = object(details.model_info);
  const architecture = typeof info["general.architecture"] === "string" ? info["general.architecture"] : null;
  const context = architecture !== null ? info[`${architecture}.context_length`] : undefined;
  return {
    id,
    ...(typeof context === "number" && Number.isSafeInteger(context) && context > 0 ? { contextLength: context } : {}),
    // An Ollama that lists no capabilities still states the window: the model is read, only
    // what it can do is unknown.
    tools: capabilities ? capabilities.includes("tools") : undefined,
    vision: capabilities ? capabilities.includes("vision") : false,
  };
}

/**
 * Asks Ollama to release a model's memory now rather than after its idle timeout. An empty
 * generate request with `keep_alive: 0` is Ollama's documented way to unload; the model is simply
 * loaded again by the next request that names it.
 */
export async function unloadModel(fetchImpl: typeof fetch, baseUrl: string, model: string, signal: AbortSignal): Promise<void> {
  const response = await fetchImpl(`${baseUrl}/api/generate`, {
    method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model, keep_alive: 0 }),
  });
  await response.body?.cancel();
  if (!response.ok) throw new OllamaChatError(`Ollama could not unload ${model} (HTTP ${response.status}).`);
}

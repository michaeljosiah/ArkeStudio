import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ProviderId } from "@arke-studio/contracts";
import { redactComfyUiBody } from "./comfyui/redact.js";
import type {
  CommandResult,
  CommandRunner,
  FetchLike,
  ProviderCallCapture,
  ProviderCallContext,
  ProviderClient,
} from "./types.js";

interface Scope extends ProviderCallContext {
  operation: string;
}

const SAFE_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-type",
  "date",
  "retry-after",
  "x-request-id",
  "request-id",
  "openai-request-id",
]);

function safeResponseHeader(key: string): boolean {
  return SAFE_RESPONSE_HEADERS.has(key) || key.startsWith("x-ratelimit-") || key.startsWith("ratelimit-");
}

function headersOf(input?: RequestInit["headers"], request = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new Headers(input).entries()) {
    if (request ? key === "content-type" || key === "content-length" : safeResponseHeader(key)) {
      out[key] = value;
    }
  }
  return out;
}

function endpointOf(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split("?", 1)[0] ?? raw;
  }
}

function sha256(data: Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

async function requestBody(body: RequestInit["body"]): Promise<unknown> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  if (body instanceof FormData) {
    return {
      multipart: await Promise.all(
        [...body.entries()].map(async ([name, value]) =>
          typeof value === "string"
            ? { name, value }
            : {
                name,
                file: value.name,
                contentType: value.type,
                sizeBytes: value.size,
                sha256: sha256(new Uint8Array(await value.arrayBuffer())),
              },
        ),
      ),
    };
  }
  if (body instanceof Blob) {
    const bytes = new Uint8Array(await body.arrayBuffer());
    return { binary: true, contentType: body.type, sizeBytes: body.size, sha256: sha256(bytes) };
  }
  if (body instanceof ArrayBuffer) {
    const bytes = new Uint8Array(body);
    return { binary: true, sizeBytes: body.byteLength, sha256: sha256(bytes) };
  }
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { binary: true, sizeBytes: body.byteLength, sha256: sha256(bytes) };
  }
  return { bodyType: body.constructor?.name ?? "unknown" };
}

function summarizeMedia(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => summarizeMedia(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([name, item]) => [name, summarizeMedia(item, name)]),
    );
  }
  if (
    typeof value === "string" &&
    (/(?:b64|base64)/i.test(key) || (/(?:audio|image|video)/i.test(key) && value.length > 4096))
  ) {
    const bytes = new Uint8Array(Buffer.from(value, "base64"));
    return {
      binary: true,
      encodedCharacters: value.length,
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
    };
  }
  return value;
}

async function responseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const length = Number(response.headers.get("content-length"));
  if (!contentType.includes("json") && !contentType.startsWith("text/")) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      binary: true,
      contentType: contentType || "application/octet-stream",
      sizeBytes: bytes.byteLength || (Number.isFinite(length) ? length : null),
      sha256: sha256(bytes),
    };
  }
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return summarizeMedia(JSON.parse(text));
  } catch {
    return text;
  }
}

/**
 * The subcommand path a CLI was invoked with, stopping at the first flag: "generate create
 * text2image_soul_v2", "account status". Values are left out of the endpoint because they
 * belong in the body — the same split a URL and its request payload already have.
 */
function commandPath(args: readonly string[]): string {
  const end = args.findIndex((arg) => arg.startsWith("-"));
  const path = (end === -1 ? args : args.slice(0, end)).join(" ");
  return path.length > 0 ? path : "(no arguments)";
}

/**
 * What a subprocess said, structured where it can be. JSON is parsed so the record carries a
 * walkable object — the store's sanitiser strips signed query strings and registered secrets
 * as it descends, and it cannot descend into a single opaque string.
 */
function commandResponseBody(result: CommandResult): unknown {
  const stdout = result.stdout.trim();
  let parsed: unknown = stdout.length > 0 ? stdout : null;
  if (stdout.length > 0) {
    try {
      parsed = summarizeMedia(JSON.parse(stdout));
    } catch {
      /* not JSON: the text is the honest record of what came back */
    }
  }
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? { stdout: parsed, stderr } : { stdout: parsed };
}

/** Stands in for a runner the provider does not have, so a miswiring fails loudly. */
const noRunner: CommandRunner = async () => {
  throw new Error("this provider is not driven as a subprocess");
};

export function captureProviderClient(
  provider: ProviderId,
  factory: (fetch: FetchLike, run: CommandRunner) => ProviderClient,
  fetchImpl: FetchLike,
  capture?: ProviderCallCapture,
  runImpl: CommandRunner = noRunner,
): ProviderClient {
  if (!capture) return factory(fetchImpl, runImpl);
  const scope = new AsyncLocalStorage<Scope>();
  // Graph confidentiality (SPEC-021 §2.10): a ComfyUI /prompt request IS the recipe's graph,
  // and history/queue responses can carry it back. What persists is a summary — digest, node
  // count, byte count — because payload history is displayed and copied in Activity, and R-1
  // says no graph reaches a user or a stored file. Other providers pass through untouched.
  const redact = (direction: "request" | "response", endpoint: string, body: unknown): unknown =>
    provider === "comfyui" ? redactComfyUiBody(direction, endpoint, body) : body;
  const observedFetch: FetchLike = async (url, init) => {
    const current = scope.getStore() ?? { operation: "provider" };
    const endpoint = endpointOf(url);
    const id = await capture.start({
      provider,
      operation: current.operation,
      context: current,
      method: init?.method?.toUpperCase() ?? "GET",
      endpoint,
      headers: headersOf(init?.headers, true),
      body: redact("request", endpoint, await requestBody(init?.body)),
    });
    try {
      const response = await fetchImpl(url, init);
      const clone = response.clone();
      void responseBody(clone)
        .then((body) =>
          capture.finish(id, {
            status: response.status,
            headers: headersOf(response.headers),
            body: redact("response", endpoint, body),
          }),
        )
        .catch((error) => capture.fail(id, error));
      return response;
    } catch (error) {
      await capture.fail(id, error);
      throw error;
    }
  };
  /**
   * The same instrumentation for a provider we drive as a CLI (issue 137). Without this the
   * payload history simply has no rows for Higgsfield: submit and poll leave no trace, and the
   * only calls that would appear are the artifact downloads at the end.
   */
  const observedRun: CommandRunner = async (args, options) => {
    const current = scope.getStore() ?? { operation: "provider" };
    const id = await capture.start({
      provider,
      operation: current.operation,
      context: current,
      method: "EXEC",
      endpoint: commandPath(args),
      headers: {},
      body: { args: [...args] },
    });
    try {
      const result = await runImpl(args, options);
      // A process that never produced an exit status did not reject anything — it failed to
      // run, which is the transport failure `fail` records.
      if (result.code === null) {
        await capture.fail(id, new Error(result.stderr.trim() || "the process produced no exit status"));
        return result;
      }
      void capture
        .finish(id, { exitCode: result.code, headers: {}, body: commandResponseBody(result) })
        .catch(() => {});
      return result;
    } catch (error) {
      await capture.fail(id, error);
      throw error;
    }
  };
  const client = factory(observedFetch, observedRun);
  const run = <T>(operation: string, context: ProviderCallContext | undefined, fn: () => Promise<T>) =>
    scope.run({ operation, ...context }, fn);
  const wrapped = {
    id: client.id,
    declarations: client.declarations,
    validateKey: (key) => run("validate", undefined, () => client.validateKey(key)),
    submit: (key, request, context) => run("submit", context, () => client.submit(key, request, context)),
    poll: (key, remoteId, context) => run("poll", context, () => client.poll(key, remoteId, context)),
    fetchArtifacts: (key, remoteId, context) =>
      run("fetch-artifacts", context, () => client.fetchArtifacts(key, remoteId, context)),
    cancel: (key, remoteId, context) => run("cancel", context, () => client.cancel(key, remoteId, context)),
    ...(client.resetTransport ? { resetTransport: () => client.resetTransport!() } : {}),
    ...(client.dispose ? { dispose: () => client.dispose!() } : {}),
    ...(client.lookupByKey
      ? {
          lookupByKey: (key: string, idempotencyKey: string, context?: ProviderCallContext) =>
            run("lookup-by-key", context, () => client.lookupByKey!(key, idempotencyKey, context)),
        }
      : {}),
    ...(client.listRecent
      ? {
          listRecent: (key: string, context?: ProviderCallContext) =>
            run("list-recent", context, () => client.listRecent!(key, context)),
        }
      : {}),
  } as ProviderClient & { listVoicesCatalog?: (key: string) => Promise<unknown> };
  const catalogue = (client as ProviderClient & { listVoicesCatalog?: (key: string) => Promise<unknown> })
    .listVoicesCatalog;
  if (catalogue)
    wrapped.listVoicesCatalog = (key) => run("list-voices", undefined, () => catalogue.call(client, key));
  return wrapped;
}

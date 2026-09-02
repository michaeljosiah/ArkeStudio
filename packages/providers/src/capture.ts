import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Capability, ProviderId } from "@arke-studio/contracts";
import { redactComfyUiBody } from "./comfyui/redact.js";
import {
  diagnoseProviderTransportError,
  providerResponseTransportError,
  ProviderTransportError,
} from "./transport.js";
import type {
  CommandResult,
  CommandRunner,
  FetchLike,
  ProviderCallCapture,
  ProviderCallContext,
  ProviderClient,
  ProviderOperation,
  ProviderTransport,
} from "./types.js";

interface Scope extends ProviderCallContext {
  operation: ProviderOperation;
  capability?: Capability;
  operationSettled: boolean;
  settleResponses: Set<(error?: unknown) => void>;
}

const RESPONSE_CAPTURE_MS = 5_000;
const CAPTURE_DEADLINE = Symbol("capture-deadline");

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

async function responseBytes(response: Response): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<typeof CAPTURE_DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(CAPTURE_DEADLINE), RESPONSE_CAPTURE_MS);
    timer.unref?.();
  });
  try {
    for (;;) {
      const read = await Promise.race([reader.read(), deadline]);
      if (read === CAPTURE_DEADLINE) {
        void reader.cancel().catch(() => {});
        return null;
      }
      if (read.done) break;
      chunks.push(read.value);
      size += read.value.byteLength;
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* cancellation can retain the lock until the pending read rejects */
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface CapturedResponseBody {
  body: unknown;
  complete: boolean;
}

async function responseBody(response: Response): Promise<CapturedResponseBody> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const length = Number(response.headers.get("content-length"));
  const bytes = await responseBytes(response);
  if (bytes === null) {
    return {
      body: { truncated: true, reason: "provider response capture exceeded 5 seconds" },
      complete: false,
    };
  }
  if (!contentType.includes("json") && !contentType.startsWith("text/")) {
    return {
      body: {
        binary: true,
        contentType: contentType || "application/octet-stream",
        sizeBytes: bytes.byteLength || (Number.isFinite(length) ? length : null),
        sha256: sha256(bytes),
      },
      complete: true,
    };
  }
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return { body: null, complete: true };
  try {
    return { body: summarizeMedia(JSON.parse(text)), complete: true };
  } catch {
    return { body: text, complete: true };
  }
}

const BODY_READ_METHODS = new Set<PropertyKey>(["arrayBuffer", "blob", "bytes", "formData", "json", "text"]);

function observeResponseBody(response: Response, succeeded: () => void, failed: (error: unknown) => void): Response {
  return new Proxy(response, {
    get(target, property) {
      if (property === "clone") return () => observeResponseBody(target.clone(), succeeded, failed);
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (BODY_READ_METHODS.has(property)) {
        return (...args: unknown[]) => {
          try {
            return Promise.resolve(Reflect.apply(value, target, args)).then(
              (result) => {
                succeeded();
                return result;
              },
              (error) => {
                failed(error);
                throw error;
              },
            );
          } catch (error) {
            failed(error);
            throw error;
          }
        };
      }
      return value.bind(target);
    },
  });
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
  transport?: ProviderTransport,
  transportOperation?: (operation: ProviderOperation) => boolean,
): ProviderClient {
  const scope = new AsyncLocalStorage<Scope>();
  const activeFetch = new AsyncLocalStorage<FetchLike>();
  // Graph confidentiality (SPEC-021 §2.10): a ComfyUI /prompt request IS the recipe's graph,
  // and history/queue responses can carry it back. What persists is a summary — digest, node
  // count, byte count — because payload history is displayed and copied in Activity, and R-1
  // says no graph reaches a user or a stored file. Other providers pass through untouched.
  const redact = (direction: "request" | "response", endpoint: string, body: unknown): unknown =>
    provider === "comfyui" ? redactComfyUiBody(direction, endpoint, body) : body;
  const observedFetch: FetchLike = async (url, init) => {
    const request = activeFetch.getStore() ?? fetchImpl;
    if (!capture) return request(url, init);
    const current = scope.getStore() ?? {
      operation: "provider",
      operationSettled: false,
      settleResponses: new Set<(error?: unknown) => void>(),
    };
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
      const response = await request(url, init);
      const clone = response.clone();
      const responded = capture.respond(id, { status: response.status, headers: headersOf(response.headers) }).catch(() => {});
      let finalized = false;
      let captureTimedOut = false;
      let originalBodySucceeded = false;
      const track = (task: Promise<void>): Promise<void> => {
        capture.track?.(task);
        return task;
      };
      const finish = (body: unknown): Promise<void> => {
        if (finalized) return Promise.resolve();
        finalized = true;
        current.settleResponses.delete(settle);
        return track(
          responded.then(() =>
            capture.finish(id, {
              status: response.status,
              headers: headersOf(response.headers),
              body: redact("response", endpoint, body),
            }).catch(() => {}),
          ),
        );
      };
      const fail = (error: unknown): Promise<void> => {
        if (finalized) return Promise.resolve();
        finalized = true;
        current.settleResponses.delete(settle);
        const failure = providerResponseTransportError(response, error);
        return track(
          responded.then(() =>
            capture
              .fail(id, failure ?? error, failure?.diagnostic ?? diagnoseProviderTransportError(error))
              .catch(() => {}),
          ),
        );
      };
      const truncatedBody = { truncated: true, reason: "provider response capture exceeded 5 seconds" };
      const settle = (operationError?: unknown) => {
        if (!captureTimedOut) return;
        if (operationError instanceof ProviderTransportError) void fail(operationError);
        else if (current.operationSettled || originalBodySucceeded) void finish(truncatedBody);
      };
      current.settleResponses.add(settle);
      const bodyCapture = responseBody(clone).then(
        (captured) => {
          if (captured.complete) return finish(captured.body);
          captureTimedOut = true;
          settle();
        },
        (error) => fail(error),
      );
      capture.track?.(bodyCapture);
      return observeResponseBody(
        response,
        () => {
          originalBodySucceeded = true;
          settle();
        },
        (error) => void fail(error),
      );
    } catch (error) {
      await capture.fail(id, error, diagnoseProviderTransportError(error)).catch(() => {});
      throw error;
    }
  };
  /**
   * The same instrumentation for a provider we drive as a CLI (issue 137). Without this the
   * payload history simply has no rows for Higgsfield: submit and poll leave no trace, and the
   * only calls that would appear are the artifact downloads at the end.
   */
  const observedRun: CommandRunner = async (args, options) => {
    if (!capture) return runImpl(args, options);
    const current = scope.getStore() ?? {
      operation: "provider",
      operationSettled: false,
      settleResponses: new Set<(error?: unknown) => void>(),
    };
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
      const finish = capture
        .finish(id, { exitCode: result.code, headers: {}, body: commandResponseBody(result) })
        .catch(() => {});
      capture.track?.(finish);
      return result;
    } catch (error) {
      await capture.fail(id, error);
      throw error;
    }
  };
  const client = factory(observedFetch, observedRun);
  const run = <T>(
    operation: ProviderOperation,
    context: (ProviderCallContext & { capability?: Capability }) | undefined,
    fn: () => Promise<T>,
  ) => {
    const current = {
      operation,
      ...context,
      operationSettled: false,
      settleResponses: new Set<(error?: unknown) => void>(),
    } as Scope;
    const invoke = (fetch: FetchLike) => activeFetch.run(fetch, () => scope.run(current, fn));
    const executed = transport && (transportOperation?.(operation) ?? true)
      ? transport.run(
          {
            provider,
            operation,
            ...(current.jobId !== undefined ? { jobId: current.jobId } : {}),
            ...(current.attempt !== undefined ? { attempt: current.attempt } : {}),
            ...(current.model !== undefined ? { model: current.model } : {}),
            ...(current.capability !== undefined ? { capability: current.capability } : {}),
          },
          invoke,
        )
      : invoke(fetchImpl);
    return executed.then(
      (value) => {
        current.operationSettled = true;
        for (const settle of current.settleResponses) settle();
        return value;
      },
      (error) => {
        current.operationSettled = true;
        for (const settle of current.settleResponses) settle(error);
        throw error;
      },
    );
  };
  const wrapped = {
    id: client.id,
    declarations: client.declarations,
    validateKey: (key) => run("validate", undefined, () => client.validateKey(key)),
    submit: (key, request, context) =>
      run("submit", { ...context, model: request.model, capability: request.capability }, () =>
        client.submit(key, request, context),
      ),
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

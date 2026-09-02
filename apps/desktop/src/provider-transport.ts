import type { ProviderTransportPolicy } from "@arke-studio/contracts";
import {
  ProviderTransportError,
  PROVIDER_RESPONSE_ERROR,
  type FetchLike,
  type ProviderTransport,
  type ProviderTransportScope,
} from "@arke-studio/providers";
import { Agent } from "undici";

export type ProviderHttpProfile = "validation" | "control" | "enqueue" | "synchronous" | "artifact";
export type ProviderHttpDeadlines = Readonly<
  Record<ProviderHttpProfile, Omit<ProviderTransportPolicy, "implementation" | "runtime" | "proxyMode">>
>;

export const PROVIDER_HTTP_DEADLINES: ProviderHttpDeadlines = {
  validation: { connectMs: 10_000, headersMs: 10_000, bodyMs: 10_000, operationMs: 15_000 },
  control: { connectMs: 10_000, headersMs: 30_000, bodyMs: 30_000, operationMs: 60_000 },
  enqueue: { connectMs: 10_000, headersMs: 60_000, bodyMs: 30_000, operationMs: 120_000 },
  synchronous: { connectMs: 10_000, headersMs: 9 * 60_000, bodyMs: 2 * 60_000, operationMs: 10 * 60_000 },
  artifact: { connectMs: 10_000, headersMs: 30_000, bodyMs: 2 * 60_000, operationMs: 15 * 60_000 },
};

export function providerHttpProfile(scope: ProviderTransportScope): ProviderHttpProfile {
  if (scope.operation === "validate") return "validation";
  if (scope.operation === "fetch-artifacts") return "artifact";
  if (scope.operation === "submit") return scope.provider === "fal" ? "enqueue" : "synchronous";
  return "control";
}

interface CloseableDispatcher {
  close(): Promise<void>;
}

function combineSignals(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const combined = new AbortController();
  const abortFrom = (source: AbortSignal) => combined.abort(source.reason);
  const fromA = () => abortFrom(a);
  const fromB = () => abortFrom(b);
  if (a.aborted) abortFrom(a);
  else if (b.aborted) abortFrom(b);
  else {
    a.addEventListener("abort", fromA, { once: true });
    b.addEventListener("abort", fromB, { once: true });
  }
  return {
    signal: combined.signal,
    dispose: () => {
      a.removeEventListener("abort", fromA);
      b.removeEventListener("abort", fromB);
    },
  };
}

const BODY_READ_METHODS = new Set<PropertyKey>(["arrayBuffer", "blob", "bytes", "formData", "json", "text"]);

function wrapResponse(response: Response, failed: (error: unknown, status: number) => ProviderTransportError): Response {
  return new Proxy(response, {
    get(target, property) {
      if (property === "clone") return () => wrapResponse(target.clone(), failed);
      if (property === PROVIDER_RESPONSE_ERROR) return (error: unknown) => failed(error, target.status);
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (BODY_READ_METHODS.has(property)) {
        return (...args: unknown[]) =>
          Promise.resolve(Reflect.apply(value, target, args)).catch((error) => {
            throw failed(error, target.status);
          });
      }
      return value.bind(target);
    },
  });
}

export interface CloudProviderTransportOptions {
  fetch?: FetchLike;
  runtime?: string;
  dispatcher?: (policy: ProviderTransportPolicy) => CloseableDispatcher;
  deadlines?: ProviderHttpDeadlines;
}

/**
 * Node/Undici cloud transport. Proxy mode is deliberately direct: Chromium PAC/system proxy and
 * HTTP_PROXY are not consulted. That preserves today's route while making it a reviewed policy.
 */
export class CloudProviderTransport implements ProviderTransport {
  private readonly fetchImpl: FetchLike;
  private readonly runtime: string;
  private readonly createDispatcher: (policy: ProviderTransportPolicy) => CloseableDispatcher;
  private readonly deadlines: ProviderHttpDeadlines;
  private readonly dispatchers = new Map<ProviderHttpProfile, CloseableDispatcher>();
  private closed = false;

  constructor(options: CloudProviderTransportOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.runtime = options.runtime ?? process.version;
    this.deadlines = options.deadlines ?? PROVIDER_HTTP_DEADLINES;
    this.createDispatcher =
      options.dispatcher ??
      ((policy) =>
        new Agent({
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 250,
          connect: { timeout: policy.connectMs },
          headersTimeout: policy.headersMs,
          bodyTimeout: policy.bodyMs,
        }));
  }

  private policy(profile: ProviderHttpProfile): ProviderTransportPolicy {
    return {
      implementation: "node-undici",
      runtime: this.runtime,
      proxyMode: "direct",
      ...this.deadlines[profile],
    };
  }

  private dispatcher(profile: ProviderHttpProfile, policy: ProviderTransportPolicy): CloseableDispatcher {
    if (this.closed) throw new Error("provider transport is closed");
    const existing = this.dispatchers.get(profile);
    if (existing) return existing;
    const created = this.createDispatcher(policy);
    this.dispatchers.set(profile, created);
    return created;
  }

  async run<T>(scope: ProviderTransportScope, operation: (fetch: FetchLike) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("provider transport is closed");
    const profile = providerHttpProfile(scope);
    const policy = this.policy(profile);
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rejectDeadline: (error: ProviderTransportError) => void = () => {};
    const deadlineResult = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const signalDisposers: Array<() => void> = [];
    const startDeadline = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        const cause = Object.assign(new Error(`provider operation timed out after ${policy.operationMs} ms`), {
          name: "TimeoutError",
          code: "ARKE_PROVIDER_OPERATION_TIMEOUT",
        });
        const failure = new ProviderTransportError(cause, {
          category: "configured-deadline",
          code: "ARKE_PROVIDER_OPERATION_TIMEOUT",
          deadline: { kind: "operation", ms: policy.operationMs },
          policy,
        });
        deadline.abort(failure);
        rejectDeadline(failure);
      }, policy.operationMs);
      // Refed on purpose, and cleared in `finally`: this timer is what guarantees `run` settles.
      // Unref'd, it never fires once the operation awaits nothing but the clock, because the loop
      // drains first — node 22's test runner then cancels the whole file at beforeExit, which
      // node 24 hides behind a keep-alive of its own (the issue 95 flake). It holds the process
      // open only while an operation is genuinely in flight, which is exactly when it should.
      // ArtifactModel keeps its deadline refed for the same reason.
    };
    const failure = (error: unknown, callerSignal: AbortSignal | undefined, responseStatus?: number) => {
      if (callerSignal?.aborted) {
        return new ProviderTransportError(error, {
          category: "caller-abort",
          policy,
          ...(responseStatus !== undefined ? { responseStatus } : {}),
        });
      }
      if (deadline.signal.aborted) {
        return new ProviderTransportError(error, {
          category: "configured-deadline",
          code: "ARKE_PROVIDER_OPERATION_TIMEOUT",
          deadline: { kind: "operation", ms: policy.operationMs },
          policy,
          ...(responseStatus !== undefined ? { responseStatus } : {}),
        });
      }
      return new ProviderTransportError(error, {
        policy,
        ...(responseStatus !== undefined ? { responseStatus } : {}),
      });
    };
    const scopedFetch: FetchLike = async (url, init) => {
      const callerSignal = init?.signal ?? undefined;
      const combined = callerSignal ? combineSignals(callerSignal, deadline.signal) : null;
      if (combined) signalDisposers.push(combined.dispose);
      const signal = combined?.signal ?? deadline.signal;
      const callerResult = callerSignal
        ? new Promise<never>((_resolve, reject) => {
            const abort = () => reject(failure(callerSignal.reason, callerSignal));
            if (callerSignal.aborted) abort();
            else {
              callerSignal.addEventListener("abort", abort, { once: true });
              signalDisposers.push(() => callerSignal.removeEventListener("abort", abort));
            }
          })
        : null;
      try {
        const request = this.fetchImpl(url, {
          ...init,
          signal,
          dispatcher: this.dispatcher(profile, policy),
        } as RequestInit);
        const response = await (callerResult ? Promise.race([request, callerResult]) : request);
        return wrapResponse(response, (error, status) => failure(error, callerSignal, status));
      } catch (error) {
        if (error instanceof ProviderTransportError) throw error;
        if (callerSignal?.aborted) throw failure(error, callerSignal);
        if (deadline.signal.aborted) {
          const reason = deadline.signal.reason;
          if (reason instanceof ProviderTransportError) throw reason;
        }
        throw failure(error, callerSignal);
      }
    };
    startDeadline();
    try {
      return await Promise.race([operation(scopedFetch), deadlineResult]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      for (const dispose of signalDisposers) dispose();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const dispatchers = [...this.dispatchers.values()];
    this.dispatchers.clear();
    await Promise.all(dispatchers.map((dispatcher) => dispatcher.close()));
  }
}

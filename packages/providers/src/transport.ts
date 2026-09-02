import type {
  ProviderDeadlineKind,
  ProviderTransportCategory,
  ProviderTransportCause,
  ProviderTransportDiagnostic,
  ProviderTransportPolicy,
} from "@arke-studio/contracts";

const MAX_CAUSES = 8;
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "SocketError",
]);
const SAFE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_PRX",
  "ARKE_PROVIDER_OPERATION_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "ERR_PROXY_CONNECTION_FAILED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "INVALID_CA",
]);
const SAFE_SYSCALLS = new Set(["connect", "getaddrinfo", "read", "write"]);

const SAFE_MESSAGE: Record<ProviderTransportCategory, string> = {
  dns: "DNS lookup failed",
  "connect-timeout": "connection deadline reached",
  tls: "TLS negotiation or certificate validation failed",
  "connection-reset": "the connection closed before the response completed",
  "headers-timeout": "response-header deadline reached",
  "body-timeout": "response-body inactivity deadline reached",
  "caller-abort": "the caller stopped waiting",
  "configured-deadline": "the configured operation deadline reached",
  proxy: "the configured proxy transport failed",
  "unknown-transport": "the transport failed before a complete response was received",
};

export interface ProviderTransportDiagnosticOptions {
  category?: ProviderTransportCategory;
  code?: string;
  deadline?: { kind: ProviderDeadlineKind; ms: number };
  policy?: ProviderTransportPolicy;
  responseStatus?: number;
}

/** Internal seam carried by wrapped responses so detached capture retains host policy. */
export const PROVIDER_RESPONSE_ERROR = Symbol("provider-response-error");

function safeName(value: unknown): string {
  return typeof value === "string" && SAFE_ERROR_NAMES.has(value) ? value : "Error";
}

function safeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return SAFE_CODES.has(value) ? value : null;
}

function safeSyscall(value: unknown): string | null {
  return typeof value === "string" && SAFE_SYSCALLS.has(value) ? value : null;
}

function causeChain(error: unknown): ProviderTransportCause[] {
  const causes: ProviderTransportCause[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && causes.length < MAX_CAUSES) {
    const node = pending.shift();
    if (typeof node !== "object" || node === null || seen.has(node)) continue;
    seen.add(node);
    causes.push({
      name: safeName((node as { name?: unknown }).name),
      code: safeCode((node as { code?: unknown }).code),
      syscall: safeSyscall((node as { syscall?: unknown }).syscall),
    });
    const members = (node as { errors?: unknown }).errors;
    if (Array.isArray(members)) pending.push(...members);
    pending.push((node as { cause?: unknown }).cause);
  }
  return causes;
}

function categoryOf(causes: readonly ProviderTransportCause[]): ProviderTransportCategory {
  for (const cause of causes) {
    const code = cause.code ?? "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || cause.syscall === "getaddrinfo") return "dns";
    if (code === "UND_ERR_CONNECT_TIMEOUT") return "connect-timeout";
    if (code === "UND_ERR_HEADERS_TIMEOUT") return "headers-timeout";
    if (code === "UND_ERR_BODY_TIMEOUT") return "body-timeout";
    if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" || code === "UND_ERR_SOCKET") {
      return "connection-reset";
    }
    if (
      code.startsWith("CERT_") ||
      code.startsWith("ERR_TLS_") ||
      code.startsWith("ERR_SSL_") ||
      code.startsWith("UNABLE_TO_") ||
      code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
      code === "SELF_SIGNED_CERT_IN_CHAIN" ||
      code === "INVALID_CA"
    ) {
      return "tls";
    }
    if (code.includes("PROXY") || code === "UND_ERR_PRX") return "proxy";
    if (cause.name === "AbortError") return "caller-abort";
    if (cause.name === "TimeoutError") return "configured-deadline";
  }
  return "unknown-transport";
}

function deadlineFor(
  category: ProviderTransportCategory,
  policy: ProviderTransportPolicy | undefined,
): { kind: ProviderDeadlineKind; ms: number } | null {
  if (!policy) return null;
  if (category === "connect-timeout") return { kind: "connect", ms: policy.connectMs };
  if (category === "headers-timeout") return { kind: "headers", ms: policy.headersMs };
  if (category === "body-timeout") return { kind: "body", ms: policy.bodyMs };
  return null;
}

export function diagnoseProviderTransportError(
  error: unknown,
  options: ProviderTransportDiagnosticOptions = {},
): ProviderTransportDiagnostic {
  if (error instanceof ProviderTransportError && Object.keys(options).length === 0) return error.diagnostic;
  const causes = causeChain(error);
  const category = options.category ?? categoryOf(causes);
  const primary = causes.find((cause) => cause.code !== null || cause.syscall !== null) ?? causes[0];
  return {
    category,
    code: safeCode(options.code) ?? primary?.code ?? null,
    syscall: primary?.syscall ?? null,
    errorName: causes[0]?.name ?? "Error",
    safeMessage: SAFE_MESSAGE[category],
    causes,
    deadline: options.deadline ?? deadlineFor(category, options.policy),
    policy: options.policy ?? null,
  };
}

/** Keeps the raw error in memory for queue classification and only exposes its safe diagnosis. */
export class ProviderTransportError extends Error {
  readonly diagnostic: ProviderTransportDiagnostic;
  readonly failureClass: "offline" | "transient" | "terminal" | "provider-fault";
  readonly responseStatus: number | null;
  readonly submissionRejected?: true;

  constructor(error: unknown, options: ProviderTransportDiagnosticOptions = {}) {
    const diagnostic = diagnoseProviderTransportError(error, options);
    super(`${diagnostic.safeMessage}${diagnostic.code ? ` (${diagnostic.code})` : ""}`, { cause: error });
    this.name = "ProviderTransportError";
    this.diagnostic = diagnostic;
    this.responseStatus = options.responseStatus ?? null;
    this.failureClass =
      this.responseStatus === 401 || this.responseStatus === 402 || this.responseStatus === 403
        ? "provider-fault"
        : this.responseStatus !== null && this.responseStatus >= 400 && this.responseStatus < 500 && this.responseStatus !== 429
          ? "terminal"
          : diagnostic.category === "dns" || diagnostic.category === "proxy" || diagnostic.category === "unknown-transport"
            ? "offline"
            : diagnostic.category === "tls"
              ? "terminal"
              : "transient";
    // A 4xx is the provider declining this request. A 5xx only witnesses the response: the
    // server may have accepted paid work before its response path failed.
    if (this.responseStatus !== null && this.responseStatus >= 400 && this.responseStatus < 500) {
      this.submissionRejected = true;
    }
  }
}

export function providerResponseTransportError(response: Response, error: unknown): ProviderTransportError | null {
  const create = (response as Response & {
    [PROVIDER_RESPONSE_ERROR]?: (cause: unknown) => ProviderTransportError;
  })[PROVIDER_RESPONSE_ERROR];
  return create?.(error) ?? null;
}

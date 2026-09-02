import type { ProviderId } from "./provider.js";

export type ProviderTransportCategory =
  | "dns"
  | "connect-timeout"
  | "tls"
  | "connection-reset"
  | "headers-timeout"
  | "body-timeout"
  | "caller-abort"
  | "configured-deadline"
  | "proxy"
  | "unknown-transport";

export type ProviderDeadlineKind = "connect" | "headers" | "body" | "operation";

export interface ProviderTransportCause {
  name: string;
  code: string | null;
  syscall: string | null;
}

export interface ProviderTransportPolicy {
  implementation: "node-undici";
  runtime: string;
  proxyMode: "direct";
  connectMs: number;
  headersMs: number;
  bodyMs: number;
  operationMs: number;
}

/** The only transport-error fields allowed to cross into durable support diagnostics. */
export interface ProviderTransportDiagnostic {
  category: ProviderTransportCategory;
  code: string | null;
  syscall: string | null;
  errorName: string;
  safeMessage: string;
  causes: ProviderTransportCause[];
  deadline: { kind: ProviderDeadlineKind; ms: number } | null;
  policy: ProviderTransportPolicy | null;
}

export interface ProviderTransportFailureRecord extends Record<string, unknown> {
  kind: "provider.transport-failed";
  provider: ProviderId;
  operation: string;
  method: string;
  category: ProviderTransportCategory;
  code: string | null;
  syscall: string | null;
  elapsedMs: number;
  outcomeWitnessed: boolean;
  error: {
    name: string;
    message: string;
    causes: ProviderTransportCause[];
  };
  deadline: { kind: ProviderDeadlineKind; ms: number } | null;
  policy: ProviderTransportPolicy | null;
}

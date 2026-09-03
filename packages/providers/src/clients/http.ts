import type { ProviderId } from "@arke-studio/contracts";
import { ProviderAuthError, type FetchLike } from "../types.js";

function responseReason(body: unknown): string | null {
  if (typeof body === "string") return body.trim() || null;
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const error = record["error"];
  const nestedMessage =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>)["message"] : error;
  const reason = [record["detail"], record["message"], nestedMessage].find(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  return typeof reason === "string" ? reason.trim() : null;
}

/** Shared HTTP plumbing: JSON in/out, auth failures mapped to provider faults (R-4). */
export async function jsonRequest(
  fetchImpl: FetchLike,
  provider: ProviderId,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, init);
  // A 403 can be a valid credential behind a billing lockout; its body is what distinguishes it.
  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (res.status === 401 || res.status === 403) {
    const reason = responseReason(body);
    throw new ProviderAuthError(
      provider,
      reason === null
        ? `${provider}: the credential was rejected (HTTP ${res.status})`
        : `${provider}: ${reason} (HTTP ${res.status})`,
    );
  }
  return { status: res.status, body };
}

/** A probe that treats network unreachability as its own honest answer, not an invalid key. */
export async function tryProbe<T>(
  probe: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; auth: boolean; message: string }> {
  try {
    return { ok: true, value: await probe() };
  } catch (err) {
    if (err instanceof ProviderAuthError) return { ok: false, auth: true, message: err.message };
    return { ok: false, auth: false, message: err instanceof Error ? err.message : String(err) };
  }
}

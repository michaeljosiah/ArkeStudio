import type { ProviderId } from "@arke-studio/contracts";
import { ProviderAuthError, type FetchLike } from "../types.js";

/** Shared HTTP plumbing: JSON in/out, auth failures mapped to provider faults (R-4). */
export async function jsonRequest(
  fetchImpl: FetchLike,
  provider: ProviderId,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, init);
  if (res.status === 401 || res.status === 403) {
    throw new ProviderAuthError(provider, `${provider}: the credential was rejected (HTTP ${res.status})`);
  }
  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
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

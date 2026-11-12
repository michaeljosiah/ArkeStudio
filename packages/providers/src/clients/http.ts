import type { ProviderId } from "@arke-studio/contracts";
import { ProviderAuthError, ProviderBusyError, ProviderRequestRejectedError, type FetchLike } from "../types.js";
import { readArtifactBody } from "./artifact-body.js";

export function responseReason(body: unknown): string | null {
  if (typeof body === "string") return body.trim() || null;
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const error = record["error"];
  const nestedMessage =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>)["message"] : error;
  if (Array.isArray(record["detail"])) {
    const messages = record["detail"].flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      return typeof value.msg === "string" ? [value.msg] : [];
    });
    if (messages.length) return messages.join("; ");
  }
  // ElevenLabs nests its words one deeper: `{ detail: { status, message } }`.
  const detail = record["detail"];
  const detailMessage = typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>)["message"] : detail;
  const reason = [detailMessage, record["message"], nestedMessage].find(
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
  maximumBytes?: number,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, init);
  // A 403 can be a valid credential behind a billing lockout; its body is what distinguishes it.
  let body: unknown = null;
  const text = maximumBytes === undefined ? await res.text() : new TextDecoder().decode(await readArtifactBody(res, maximumBytes, init.signal ?? undefined));
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

/**
 * What a refused call's status alone decides (#2824; SPEC-008 R-4, R-24), once a vendor's own rules
 * have had their say: a 401 is the credential; a 429 proves nothing was taken, so it is busy and
 * witnessed and the queue may retry it; a 5xx proves nothing either way about paid work, so it is a
 * plain error the queue holds for the person; anything else is a rejection of the request. 402 and
 * 403 are deliberately absent: each vendor means something different by them, and a 403 read as
 * a rejected key sends the person to replace a key that works. The words stay each vendor's.
 */
export function classifyRefusal(provider: ProviderId, status: number, says: { auth: string; busy: string; failed: string; rejected?: string }): Error {
  if (status === 401) return new ProviderAuthError(provider, says.auth);
  if (status === 429) return new ProviderBusyError(says.busy, { witnessed: true });
  if (status >= 500) return new Error(says.failed);
  return new ProviderRequestRejectedError(says.rejected ?? says.failed);
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

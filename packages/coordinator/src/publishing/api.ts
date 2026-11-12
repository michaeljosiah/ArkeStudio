import { z } from "zod";
import type { AonikConfiguration } from "./config.js";
import { AonikAccount, CreatorSignInRequired } from "./account.js";
export type CreatorAccount = Pick<AonikAccount, "actorKey" | "bearer" | "current" | "onChange">;

const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const AonikReceiptSchema = z.object({ id: uuid, clientRequestId: uuid, channelKey: z.string(), status: z.string(), createdAt: z.string(), version: z.string(),
  revision: z.object({ id: uuid, number: z.number().int().positive(), title: z.string(), worldId: z.string(), edition: z.string(), declaredPackageBytes: z.number().int().positive(), declaredPackageSha256: sha }).passthrough(),
}).passthrough();
export type AonikReceipt = z.infer<typeof AonikReceiptSchema>;
export const AonikUploadSchema = z.object({ id: uuid, revisionId: uuid, status: z.string(), partSizeBytes: z.number().int().min(1).max(33554432), totalParts: z.number().int().min(1).max(100000),
  receivedBytes: z.number().int().nonnegative(), expiresAt: z.string(), missingParts: z.array(z.number().int().positive()).max(100000),
}).passthrough();
export type AonikUpload = z.infer<typeof AonikUploadSchema>;
export class PublishingRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const messages: Record<string, string> = {
  "no-party": "Your creator account needs a linked creator profile in AONIK.",
  "submit-forbidden": "Your account does not have permission to submit to this channel.",
  "channel-unavailable": "This submission channel is unavailable.",
  "channel-not-configured": "The publishing channel needs configuration before submissions can begin.",
  "request-conflict": "This request identity already belongs to different edition details. Prepare a new submission.",
  "revision-operation-conflict": "This revision request already names different details. Prepare a new revision.",
  "review-version-changed": "The current revision changed. Refresh it before confirming a replacement.",
  "revision-not-replaceable": "The current publication operation must finish before this edition can be replaced.",
  "namespace-owned": "This world identifier belongs to another creator in this channel.",
  "quota-exceeded": "The private publishing storage allowance has been reached.",
};

/** Fixed-origin host transport. No bearer, redirect or arbitrary URL comes from a renderer. */
export class AonikPublishingApi {
  constructor(readonly configuration: AonikConfiguration, private readonly account: CreatorAccount, private readonly fetcher: typeof fetch = fetch) {}
  async request(path: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: unknown, signal?: AbortSignal, hash?: string): Promise<unknown> {
    if (!path.startsWith("/publishing/") || path.includes("..") || path.includes("\\") || path.includes("#")) throw new PublishingRefusal("invalid-route", "Invalid publishing request.");
    const owner = this.account.actorKey(); if (!owner) throw new CreatorSignInRequired();
    const perform = async (refresh: boolean) => {
      const token = await this.account.bearer(refresh);
      if (this.account.actorKey() !== owner || signal?.aborted) throw new CreatorSignInRequired();
      const binary = body instanceof Uint8Array;
      return this.fetcher(this.configuration.apiBaseUrl + path, { method, redirect: "error", credentials: "omit",
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]),
        headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": this.configuration.tenantId, "Cache-Control": "no-store",
          ...(body !== undefined ? { "Content-Type": binary ? "application/octet-stream" : "application/json" } : {}),
          ...(binary ? { "Content-Length": String(body.byteLength), "X-Part-Sha256": hash! } : {}) },
        ...(body !== undefined ? { body: binary ? Buffer.from(body) : JSON.stringify(body) } : {}) });
    };
    let response: Response;
    try { response = await perform(false); if (response.status === 401) response = await perform(true); }
    catch (error) { if (error instanceof CreatorSignInRequired) throw error; throw new PublishingRefusal("offline", "The publishing service could not be reached. The saved request can be resumed."); }
    if (this.account.actorKey() !== owner || signal?.aborted) throw new CreatorSignInRequired();
    const text = await boundedResponse(response, 2097152);
    let data: unknown = null; try { if (text) data = JSON.parse(text); } catch { throw new PublishingRefusal("invalid-response", "The publishing service returned an unreadable response."); }
    if (!response.ok) {
      const code = data && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code : `http-${response.status}`;
      throw new PublishingRefusal(code, messages[code] ?? (response.status === 401 ? "Sign in again before continuing this submission." : response.status === 403 ? "This creator account cannot perform that action." : response.status === 409 ? "The submission changed. Refresh its receipt before continuing." : response.status === 429 ? "The service is busy. Resume this saved request later." : "The publishing service could not confirm this request. Refresh or resume the saved receipt."));
    }
    return data;
  }
  async catalogue(signal: AbortSignal): Promise<unknown> {
    try {
      const response = await this.fetcher(`${this.configuration.apiBaseUrl}/publishing/channels/${this.configuration.channelKey}/catalogue.json`, { redirect: "error", credentials: "omit", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) throw new Error("Catalogue unavailable");
      return JSON.parse(await boundedResponse(response, 1048576));
    } catch { throw new PublishingRefusal("base-unavailable", "AONIK's published base cannot be checked. Resume the part after the catalogue is available."); }
  }
}

export async function boundedResponse(response: Response, maximum: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > maximum) throw new PublishingRefusal("response-too-large", "The publishing response exceeds its limit."); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

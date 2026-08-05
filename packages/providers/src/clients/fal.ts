import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import { jsonRequest, tryProbe } from "./http.js";
// Generated beside the manifest rows, from the same fetch, so a model can never be offered
// with no route behind it — the failure that used to read "no endpoint mapping" at dispatch,
// long after the estimate had been shown and accepted.
import {
  FAL_EDIT_ENDPOINTS as EDIT_ENDPOINTS,
  FAL_ENDPOINTS as ENDPOINTS,
  FAL_MODELS,
} from "../fal-catalogue.generated.js";
import type {
  FetchedArtifact,
  FetchLike,
  PollResult,
  PreparedImageReference,
  ProviderClient,
  SubmitRequest,
  SubmitResult,
} from "../types.js";

/**
 * Our own ceiling, not fal's. fal accepts data URIs for any file input, which keeps a reference
 * on the same request as the prompt and avoids depending on a second service to hold bytes we
 * already hold. The cost is body size, so refuse early and legibly rather than let a several-
 * megabyte request time out somewhere in the middle. Reference tiles and portraits sit far
 * under this; anything over it is a sign something unintended got attached.
 */
const MAX_INLINE_REFERENCE_BYTES = 8 * 1024 * 1024;

/**
 * Seconds → the word this route wants for that length, from the manifest rows generated beside
 * the endpoints. Every fal video route takes `duration` as a string out of a fixed list, and the
 * lists disagree: seedance and kling say "5", veo says "5s". We carried `durationSec` as a
 * number and sent it under that name, which is a field none of them declares — so every video
 * dispatch ran at the provider's default length while the estimate was computed from the seconds
 * the scene had planned.
 */
const DURATIONS = new Map(
  FAL_MODELS.filter((model) => model.limits.durations !== undefined).map((model) => [
    model.id,
    model.limits.durations!,
  ]),
);

/** The duration field as this route wants it, or nothing when the row declares no lengths. */
function durationParam(model: string, params: Record<string, unknown>): Record<string, string> {
  const seconds = params["durationSec"];
  if (typeof seconds !== "number") return {};
  const wire = DURATIONS.get(model)?.[String(Math.round(seconds))];
  // The coordinator snaps to a declared length before dispatch, so a miss here means the job was
  // planned against a different manifest than the one shipped. Sending the raw number under a
  // name the route does not know is what this replaced; sending nothing at least runs.
  return wire === undefined ? {} : { duration: wire };
}

/** fal takes file inputs as URLs; a data URI is a URL that needs nobody's storage. */
function dataUri(reference: PreparedImageReference): string {
  return `data:${reference.contentType};base64,${Buffer.from(reference.data).toString("base64")}`;
}

function extensionFor(contentType: string): string {
  const type = contentType.toLowerCase().split(";", 1)[0];
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/png") return "png";
  if (type === "video/mp4") return "mp4";
  return "bin";
}

/**
 * FAL — gateway: many models, one key (R-1). Queue API: submit to a model endpoint, poll the
 * request id under that endpoint, fetch the completed payload.
 *
 * Declarations (T-9, established from the queue API surface): no idempotency keys, no lookup
 * by key, no listing of recent requests → an interrupted submission reconciles by asking the
 * user (§2.9). No cost figure in any response → ledger actuals are manifest-derived (R-17).
 */

export class FalClient implements ProviderClient {
  readonly id = "fal" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = "https://queue.fal.run",
  ) {}

  private headers(key: string): Record<string, string> {
    return { Authorization: `Key ${key}`, "Content-Type": "application/json" };
  }

  /**
   * One free probe covers the gateway: a status read of a nonexistent request authenticates
   * without generating. One key unlocks image and video together (R-1).
   */
  async validateKey(key: string): Promise<CapabilityProbe[]> {
    const url = `${this.baseUrl}/fal-ai/flux-pro/requests/00000000-0000-0000-0000-000000000000/status`;
    const probe = await tryProbe(() => jsonRequest(this.fetchImpl, this.id, url, { headers: this.headers(key) }));
    if (!probe.ok) {
      const reason = probe.auth ? "FAL rejected this key" : `FAL could not be reached: ${probe.message}`;
      return [
        { capability: "image", available: false, reason },
        { capability: "video", available: false, reason },
      ];
    }
    // Any non-auth status (404 for the bogus id) means the key authenticated the gateway.
    return [
      { capability: "image", available: true },
      { capability: "video", available: true },
    ];
  }

  /**
   * A model is one row in the manifest and two routes on fal: the text route, and — for models
   * that declare they accept references — an `/edit` sibling that takes `image_urls`. Which one
   * a job lands on is decided by whether it carries references, so the studio offers one model
   * rather than two halves of one.
   */
  private endpointFor(model: string, withReferences: boolean): string {
    const endpoint = withReferences ? EDIT_ENDPOINTS[model] : ENDPOINTS[model];
    if (!endpoint) {
      throw new Error(
        withReferences
          ? `fal: ${model} has no reference-image route`
          : `fal: no endpoint mapping for model "${model}"`,
      );
    }
    return endpoint;
  }

  async submit(key: string, request: SubmitRequest): Promise<SubmitResult> {
    const durable = request.params["references"];
    const withReferences = Array.isArray(durable) && durable.length > 0;
    const prepared = request.imageReferences ?? [];
    // Route first: a model with no `/edit` sibling cannot take references at all, and saying so
    // is more use than complaining about the bytes for a request that could never have gone.
    const endpoint = this.endpointFor(request.model, withReferences);
    // The durable list is what the job promised; the prepared list is what actually resolved to
    // bytes. A mismatch means a reference went missing between planning and dispatch, and
    // submitting the remainder would quietly generate against a smaller set than was priced.
    if (withReferences && prepared.length !== durable.length) {
      throw new Error("fal: not every image reference was prepared");
    }
    const inlineBytes = prepared.reduce((total, reference) => total + reference.data.byteLength, 0);
    if (withReferences && inlineBytes > MAX_INLINE_REFERENCE_BYTES) {
      throw new Error(
        `fal: ${prepared.length} reference images total ${Math.round(inlineBytes / 1024 / 1024)}MB, over the inline limit`,
      );
    }
    const imageUrls = withReferences ? prepared.map(dataUri) : [];
    const internal = new Set([
      "references",
      "referenceRoles",
      "artDirection",
      "provenance",
      "lookKind",
      "lookPrompt",
      "shotPlan",
      // Ours, not fal's: the length goes as `duration`, in this route's own vocabulary.
      "durationSec",
      // Ours, not fal's: the length goes as `duration`, in this route's own vocabulary.
    ]);
    const { output, ...params } = Object.fromEntries(
      Object.entries(request.params).filter(([key]) => !internal.has(key)),
    );
    const size = output as { width?: unknown; height?: unknown; aspect?: unknown; resolution?: unknown } | undefined;
    const imageOutput =
      request.capability === "image" &&
      typeof size?.width === "number" &&
      typeof size.height === "number"
        ? request.model.startsWith("nano-banana-")
          ? {
              ...(typeof size.aspect === "string" ? { aspect_ratio: size.aspect } : {}),
              ...(typeof size.resolution === "string" ? { resolution: size.resolution } : {}),
            }
          : { image_size: { width: size.width, height: size.height } }
        : {};
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/${endpoint}`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify({
        ...params,
        ...durationParam(request.model, request.params),
        ...imageOutput,
        ...(imageUrls.length > 0 ? { image_urls: imageUrls } : {}),
      }),
    });
    const requestId = (body as { request_id?: string } | null)?.request_id;
    if (status >= 400 || !requestId) throw new Error(`fal: submit failed (HTTP ${status})`);
    // The remote id carries its endpoint — polling is endpoint-scoped on FAL.
    return { remoteId: `${endpoint}::${requestId}`, acceptedAt: new Date().toISOString() };
  }

  private split(remoteId: string): { endpoint: string; requestId: string } {
    const i = remoteId.lastIndexOf("::");
    return { endpoint: remoteId.slice(0, i), requestId: remoteId.slice(i + 2) };
  }

  async poll(key: string, remoteId: string): Promise<PollResult> {
    const { endpoint, requestId } = this.split(remoteId);
    const { status, body } = await jsonRequest(
      this.fetchImpl,
      this.id,
      `${this.baseUrl}/${endpoint}/requests/${requestId}/status`,
      { headers: this.headers(key) },
    );
    if (status >= 400) return { state: "failed", error: `fal: status read failed (HTTP ${status})` };
    const remote = (body as { status?: string } | null)?.status ?? "UNKNOWN";
    if (remote === "COMPLETED") return { state: "succeeded" };
    if (remote === "IN_PROGRESS") return { state: "running" };
    if (remote === "IN_QUEUE") return { state: "queued" };
    return { state: "failed", error: `fal: unexpected status "${remote}"` };
  }

  async fetchArtifacts(key: string, remoteId: string): Promise<FetchedArtifact[]> {
    const { endpoint, requestId } = this.split(remoteId);
    const { status, body } = await jsonRequest(
      this.fetchImpl,
      this.id,
      `${this.baseUrl}/${endpoint}/requests/${requestId}`,
      { headers: this.headers(key) },
    );
    if (status >= 400) throw new Error(`fal: result fetch failed (HTTP ${status})`);
    const out: FetchedArtifact[] = [];
    const payload = body as { images?: Array<{ url?: string; content_type?: string }>; video?: { url?: string } } | null;
    const urls: Array<{ url: string; contentType: string }> = [];
    for (const img of payload?.images ?? []) {
      if (img.url) urls.push({ url: img.url, contentType: img.content_type ?? "application/octet-stream" });
    }
    if (payload?.video?.url) urls.push({ url: payload.video.url, contentType: "video/mp4" });
    for (const [i, item] of urls.entries()) {
      const res = await this.fetchImpl(item.url);
      const data = new Uint8Array(await res.arrayBuffer());
      const ext = extensionFor(item.contentType);
      out.push({ name: `output-${i + 1}.${ext}`, contentType: item.contentType, data });
    }
    return out;
  }

  async cancel(key: string, remoteId: string): Promise<void> {
    const { endpoint, requestId } = this.split(remoteId);
    await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/${endpoint}/requests/${requestId}/cancel`, {
      method: "PUT",
      headers: this.headers(key),
    });
  }
}

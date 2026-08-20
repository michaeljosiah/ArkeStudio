import { PROVIDERS, type CapabilityProbe, type ClientDeclarations } from "@arke-studio/contracts";
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

/** Model id → what its reference route calls the image array. Absent means `image_urls`. */
const REFERENCES_FIELD = new Map(
  FAL_MODELS.filter((model) => model.limits.referencesField !== undefined).map((model) => [
    model.id,
    model.limits.referencesField!,
  ]),
);

/** Model id → whether this route's `duration` is a number. Absent means the string it always was. */
const DURATION_IS_NUMBER = new Set(
  FAL_MODELS.filter((model) => model.limits.durationWire === "number").map((model) => model.id),
);

/** The duration field as this route wants it, or nothing when the row declares no lengths. */
function durationParam(model: string, params: Record<string, unknown>): Record<string, string | number> {
  const seconds = params["durationSec"];
  if (typeof seconds !== "number") return {};
  const declared = DURATIONS.get(model);
  // A model with no declared lengths never asks for one — the provider's default is the honest
  // answer there, and the estimate was computed the same way.
  if (declared === undefined) return {};
  const wire = declared[String(seconds)];
  if (wire === undefined) {
    // Refused, not dropped. Sending nothing is exactly the bug this replaced: the provider's
    // default length runs while the estimate was computed from the seconds the job carries.
    // A miss means the job was planned against a different manifest than the one shipped —
    // a job journalled before an upgrade, most likely, still holding an unsnapped length.
    throw new Error(
      `fal: ${model} cannot be asked for ${seconds}s — it offers ${Object.keys(declared).join(", ")}s`,
    );
  }
  // The route's own type: a number enum rejects the quoted form, and coercion is not a
  // promise any of these schemas makes.
  return { duration: DURATION_IS_NUMBER.has(model) ? Number(wire) : wire };
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
  if (type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return "wav";
  if (type === "audio/mpeg" || type === "audio/mp3") return "mp3";
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
   * without generating. One key unlocks every capability fal serves together (R-1) — the gateway
   * authenticates once and routes per model, so probing per capability would be three identical
   * requests answering one question.
   */
  async validateKey(key: string): Promise<CapabilityProbe[]> {
    const url = `${this.baseUrl}/fal-ai/flux-pro/requests/00000000-0000-0000-0000-000000000000/status`;
    const probe = await tryProbe(() => jsonRequest(this.fetchImpl, this.id, url, { headers: this.headers(key) }));
    // Every capability the provider table says fal serves, answered from the one probe. Listing
    // them here as well would be a second place to update, and the failure mode of forgetting is
    // silent: deriveCapabilityAvailability reads a missing probe as "not available", so a
    // capability fal genuinely unlocks would read as locked with a valid key in the box.
    const capabilities = PROVIDERS[this.id].capabilities;
    if (!probe.ok) {
      const reason = probe.auth ? "FAL rejected this key" : `FAL could not be reached: ${probe.message}`;
      return capabilities.map((capability) => ({ capability, available: false, reason }));
    }
    // Any non-auth status (404 for the bogus id) means the key authenticated the gateway.
    return capabilities.map((capability) => ({ capability, available: true }));
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
    // A task mode is a ROUTE on this provider (SPEC-019 T-1): a dispatch that planned one sends
    // its endpoint in `route`, resolved from the manifest's own mode spec via routeFor. Route
    // first either way: a model with no `/edit` sibling cannot take references at all, and
    // saying so is more use than complaining about the bytes for a request that could never
    // have gone.
    const routeOverride = typeof request.params["route"] === "string" ? (request.params["route"] as string) : null;
    const endpoint = routeOverride ?? this.endpointFor(request.model, withReferences);
    const taskMode = typeof request.params["taskMode"] === "string" ? (request.params["taskMode"] as string) : null;
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
    // The frame task modes name their images differently per route, read from the routes' own
    // schemas: image-to-video takes `image_url` (start, required) and `end_image_url`;
    // reference-to-video takes `image_urls`. The counts are structural — a first-and-last
    // dispatch that arrives with one image was mis-planned, and refusing beats animating the
    // wrong thing.
    const referencesField = REFERENCES_FIELD.get(request.model) ?? "image_urls";
    let imagePayload: Record<string, unknown> = imageUrls.length > 0 ? { [referencesField]: imageUrls } : {};
    if (taskMode === "first-frame" || taskMode === "first-and-last-frame") {
      const wanted = taskMode === "first-frame" ? 1 : 2;
      if (imageUrls.length !== wanted) {
        throw new Error(`fal: ${taskMode} needs ${wanted} frame image${wanted === 1 ? "" : "s"}, got ${imageUrls.length}`);
      }
      imagePayload = {
        image_url: imageUrls[0],
        ...(taskMode === "first-and-last-frame" ? { end_image_url: imageUrls[1] } : {}),
      };
    } else if (taskMode === "keyframe-sequence") {
      if (imageUrls.length === 0) throw new Error("fal: keyframe-sequence needs at least one frame image");
      // Seedance's reference route says `image_urls`; minimax's and wan's say
      // `reference_image_urls`. The planner sends the route's own word for it.
      const field = typeof request.params["framesField"] === "string" ? (request.params["framesField"] as string) : "image_urls";
      imagePayload = { [field]: imageUrls };
    }
    const internal = new Set([
      "references",
      "referenceRoles",
      "artDirection",
      "provenance",
      "lookKind",
      "lookPrompt",
      "shotPlan",
      // Ours, not fal's: the mode already chose the endpoint and the image field names.
      "taskMode",
      "route",
      "framesField",
      // Ours, not fal's: the durable identity of a boundary frame (issue 154) — the picture
      // itself already travelled as the mode's image field.
      "startFrame",
      "frameArtifact",
      // Ours, not fal's: the routes that offer the choice spell it `generate_audio`.
      "sound",
      // Ours, not fal's: the length goes as `duration`, in this route's own vocabulary.
      "durationSec",
      // Ours, not fal's: the video routes spell the shape `aspect_ratio` (issue 389). Passed
      // through bare it was a field no route ever declared, which fal silently ignored — the
      // chosen ratio never reached the model at all.
      "aspect",
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
        ...(typeof request.params["sound"] === "boolean" ? { generate_audio: request.params["sound"] } : {}),
        ...durationParam(request.model, request.params),
        // The shape, in the video routes' own vocabulary (issue 389). Image requests carry
        // theirs inside `output` above; a mode that locks the ratio never sends one here,
        // because the planner already dropped it.
        ...(request.capability === "video" && typeof request.params["aspect"] === "string"
          ? { aspect_ratio: request.params["aspect"] }
          : {}),
        ...imageOutput,
        ...imagePayload,
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

  /**
   * The queue is keyed on the APP, not the route.
   *
   * A job is submitted to the full path — `fal-ai/wan/v2.7/text-to-video` — but its status,
   * result and cancel live under the first two segments alone: `fal-ai/wan/requests/<id>/…`.
   * fal's per-endpoint OpenAPI templates the full path for all four, and the server answers
   * 405 to it; the two-segment form answers 401 unauthenticated, which is a path that exists.
   *
   * This was invisible while every route we shipped had exactly two segments. Every video
   * model has more, so every video job submitted, was charged, and then failed on the first
   * status read with its result still sitting in the queue — the worst shape a bug can take,
   * because the money leaves and nothing comes back.
   */
  private queueApp(endpoint: string): string {
    return endpoint.split("/").slice(0, 2).join("/");
  }

  async poll(key: string, remoteId: string): Promise<PollResult> {
    const { endpoint, requestId } = this.split(remoteId);
    const { status, body } = await jsonRequest(
      this.fetchImpl,
      this.id,
      `${this.baseUrl}/${this.queueApp(endpoint)}/requests/${requestId}/status`,
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
      `${this.baseUrl}/${this.queueApp(endpoint)}/requests/${requestId}`,
      { headers: this.headers(key) },
    );
    if (status >= 400) throw new Error(`fal: result fetch failed (HTTP ${status})`);
    const out: FetchedArtifact[] = [];
    const payload = body as {
      images?: Array<{ url?: string; content_type?: string }>;
      video?: { url?: string };
      audio?: { url?: string; content_type?: string };
    } | null;
    const urls: Array<{ url: string; contentType: string }> = [];
    for (const img of payload?.images ?? []) {
      if (img.url) urls.push({ url: img.url, contentType: img.content_type ?? "application/octet-stream" });
    }
    if (payload?.video?.url) urls.push({ url: payload.video.url, contentType: "video/mp4" });
    // Audio results (minimax/music-3 §Music3Output: `audio`, a File, 44.1 kHz 16-bit stereo
    // WAV). Without this a music job submits, is charged, polls COMPLETED and hands back
    // nothing — the money-leaves-and-nothing-comes-back shape `queueApp` above was written
    // about. The route declares its content type, so it is read rather than assumed.
    if (payload?.audio?.url) {
      urls.push({ url: payload.audio.url, contentType: payload.audio.content_type ?? "audio/wav" });
    }
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
    await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/${this.queueApp(endpoint)}/requests/${requestId}/cancel`, {
      method: "PUT",
      headers: this.headers(key),
    });
  }
}

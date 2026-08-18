import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import {
  callerParamNames,
  comfyUiRecipeById,
  comfyUiRecipeIdentity,
  SDXL_BUCKETS,
  substituteRecipeParams,
  WAN_DIMENSIONS,
  WAN_FRAMES_BY_SECONDS,
  wanFramesForSeconds,
  type ComfyUiRecipe,
  type RecipeParamValues,
} from "../comfyui/recipes.js";
import { scrubPaths } from "../comfyui/redact.js";
import { jsonRequest } from "./http.js";
import type {
  FetchedArtifact,
  FetchLike,
  PollResult,
  ProviderCallContext,
  ProviderClient,
  SubmitRequest,
  SubmitResult,
} from "../types.js";
import { ProviderRequestRejectedError } from "../types.js";

/** Where the engine is listening right now, or null when none is configured and healthy. */
export type EngineBaseUrl = () => string | null;

/**
 * The last check before the wire (§2.5): pinned checkpoints and nodes verified against the
 * resolved location, immediately before submission. Injected — hashing files is the engine
 * service's business, and the client refuses to dispatch without an answer.
 */
export type ComfyUiPreflight = (
  recipeId: string,
) => Promise<{ ok: true } | { ok: false; reason: string }>;

/**
 * The oldest engine the shipped recipes run on (D14): the release that introduced the core
 * node set the video recipe stands on. An engine that answers with less is incompatible with
 * its version named, never generically unavailable.
 */
export const COMFYUI_VERSION_FLOOR = "0.3.45";

/** "0.33.1" ≥ "0.3.45"? Numeric segment compare; anything unparseable compares as unknown. */
export function meetsVersionFloor(version: string, floor: string = COMFYUI_VERSION_FLOOR): boolean | null {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
  };
  const a = parse(version);
  const b = parse(floor);
  if (a === null || b === null) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

/**
 * The dispatch keys that are the coordinator's, not parameters of any recipe.
 *
 * This is deliberately generous, because the surfaces that build a dispatch do not all speak
 * one vocabulary. The bench pre-converts a length through `dispatchDuration` and sends the
 * route's own word — `duration` — while the production planner sends the neutral `durationSec`;
 * both also send `resolution`, which for a recipe is a fact of the row rather than a control.
 * FAL never noticed because its client spreads unknown params straight onto the wire. This
 * client is an allow-list, so anything a real dispatch can carry has to be named here or it
 * becomes a terminal failure for work the picker openly offered.
 */
const INTERNAL_PARAMS = new Set([
  "references",
  "referenceRoles",
  "artDirection",
  "provenance",
  "lookKind",
  "lookPrompt",
  "shotPlan",
  "taskMode",
  "route",
  "framesField",
  "sound",
  "output",
  "aspect_ratio",
  "durationSec",
  /** The bench's pre-converted wire length; read alongside `durationSec` in valuesFor. */
  "duration",
  /** A recipe has exactly one output size, declared on its row — never a param of the graph. */
  "resolution",
  "seed",
  "prompt",
  "text",
]);

interface QueueEntryish {
  0?: unknown;
  1?: unknown;
}

/**
 * ComfyUI — the local recipe engine (SPEC-021 §2.6). `key` is unused throughout, as for Ollama
 * (R-18): the engine authenticates nothing, and the base URL is resolved per call because the
 * managed engine's port is assigned at launch (the same reason Kokoro's is).
 *
 * All-false declarations (D12): a spawned engine's queue dies with Arke and recovery requeues;
 * a surviving URL engine's ambiguous window is the user's honest decision, priced as GPU time.
 */
export class ComfyUiClient implements ProviderClient {
  readonly id = "comfyui" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: EngineBaseUrl,
    private readonly preflight: ComfyUiPreflight,
  ) {}

  private require(): string {
    const base = this.baseUrl();
    if (base === null) {
      throw new Error("comfyui: no engine is running — point Settings at an install, or download the managed one");
    }
    return base;
  }

  /**
   * The compatibility probe (D14): `/system_stats` must answer with a version at or above the
   * floor. What it cannot prove — files, nodes — is readiness's business, not this probe's.
   */
  async validateKey(): Promise<CapabilityProbe[]> {
    const capabilities = ["image", "video"] as const;
    const base = this.baseUrl();
    if (base === null) {
      return capabilities.map((capability) => ({
        capability,
        available: false,
        reason: "no ComfyUI engine is configured or running",
      }));
    }
    let body: unknown;
    try {
      const answer = await jsonRequest(this.fetchImpl, this.id, `${base}/system_stats`, {});
      if (answer.status >= 400) {
        return capabilities.map((capability) => ({
          capability,
          available: false,
          reason: `the engine answered HTTP ${answer.status} to /system_stats`,
        }));
      }
      body = answer.body;
    } catch (err) {
      return capabilities.map((capability) => ({
        capability,
        available: false,
        reason: `the engine could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
    const version = (body as { system?: { comfyui_version?: unknown } } | null)?.system?.comfyui_version;
    if (typeof version !== "string" || version.length === 0) {
      return capabilities.map((capability) => ({
        capability,
        available: false,
        reason: `the engine did not report a ComfyUI version — Arke supports ${COMFYUI_VERSION_FLOOR} and later`,
      }));
    }
    const meets = meetsVersionFloor(version);
    if (meets !== true) {
      return capabilities.map((capability) => ({
        capability,
        available: false,
        reason: `ComfyUI ${version} is older than the ${COMFYUI_VERSION_FLOOR} floor Arke supports`,
      }));
    }
    return capabilities.map((capability) => ({ capability, available: true }));
  }

  /** Neutral params → this recipe's own values, refusing anything the recipe does not declare. */
  private valuesFor(recipe: ComfyUiRecipe, request: SubmitRequest): RecipeParamValues {
    const params = request.params;
    const allowed = callerParamNames(recipe);
    for (const key of Object.keys(params)) {
      if (INTERNAL_PARAMS.has(key)) continue;
      if (!allowed.has(key)) {
        throw new Error(`comfyui: "${key}" is not a parameter of ${recipe.displayName}`);
      }
    }
    const prompt = typeof params["prompt"] === "string" ? params["prompt"] : undefined;
    if (prompt === undefined || prompt.length === 0) {
      throw new Error(`comfyui: ${recipe.displayName} needs a prompt`);
    }
    const seed = params["seed"];
    const values: RecipeParamValues = {
      prompt,
      ...(typeof seed === "number" && Number.isInteger(seed) ? { seed } : {}),
    };
    if (recipe.capability === "image") {
      // The output spec's shape decides the bucket; the bucket decides the pixels. Snapping,
      // not scaling: an off-bucket SDXL size generates worse, and the tier already priced at 1K.
      const output = params["output"] as { width?: unknown; height?: unknown; aspect?: unknown } | undefined;
      const aspect =
        typeof output?.aspect === "string" && output.aspect in SDXL_BUCKETS
          ? output.aspect
          : nearestBucket(
              typeof output?.width === "number" ? output.width : 1024,
              typeof output?.height === "number" ? output.height : 1024,
            );
      const bucket = SDXL_BUCKETS[aspect]!;
      values["width"] = bucket.width;
      values["height"] = bucket.height;
      return values;
    }
    // Video: seconds arrive as the manifest row's own wire numbers (durationWire "number"),
    // and the engine's frame count is derived — 4k+1, the latent's own arithmetic.
    const rawAspect = params["aspect"] ?? params["aspect_ratio"];
    const aspect = typeof rawAspect === "string" && rawAspect in WAN_DIMENSIONS ? rawAspect : "16:9";
    // Either vocabulary: `durationSec` from the production planner, `duration` from the bench,
    // which has already snapped the request through dispatchDuration. Reading only one of them
    // would leave the other silently defaulting — the estimate and the take would record the
    // length the user picked while the engine rendered a different one.
    const rawSeconds = params["durationSec"] ?? params["duration"];
    const seconds = typeof rawSeconds === "number" ? rawSeconds : Number(rawSeconds);
    if (rawSeconds !== undefined && !Number.isFinite(seconds)) {
      throw new Error(`comfyui: ${recipe.displayName} was asked for a length that is not a number`);
    }
    const asked = rawSeconds === undefined ? 5 : seconds;
    const frames = wanFramesForSeconds(asked);
    if (frames === null) {
      const offered = Object.keys(WAN_FRAMES_BY_SECONDS).join(", ");
      throw new Error(`comfyui: ${recipe.displayName} cannot be asked for ${asked}s — it offers ${offered}s`);
    }
    const size = WAN_DIMENSIONS[aspect]!;
    values["durationSec"] = asked;
    values["aspect"] = aspect;
    values["length"] = frames;
    values["width"] = size.width;
    values["height"] = size.height;
    return values;
  }

  async submit(_key: string, request: SubmitRequest, _context?: ProviderCallContext): Promise<SubmitResult> {
    const recipe = comfyUiRecipeById(request.model);
    if (!recipe) throw new Error(`comfyui: "${request.model}" is not a shipped recipe`);
    // The freeze is only half the guarantee (R-15). A job journalled before an app update
    // carries the identity it was planned, priced and accepted as; this build ships whatever
    // the catalogue now holds. Running the current graph under the old job's name is exactly
    // the silent substitution §2.11 exists to prevent — so a moved catalogue refuses, and
    // says which version the job was made with.
    const frozen = request.recipe;
    if (frozen !== undefined) {
      const current = comfyUiRecipeIdentity(recipe);
      if (
        frozen.version !== current.version ||
        frozen.templateDigest !== current.templateDigest ||
        frozen.dependencyDigest !== current.dependencyDigest
      ) {
        throw new ProviderRequestRejectedError(
          `comfyui: this job was made with ${recipe.displayName} v${frozen.version}, and this build ships v${current.version} — it was refused rather than run against a different graph`,
        );
      }
    }
    // R-10 said no references before commit; this is the backstop for a mis-planned dispatch.
    const durable = request.params["references"];
    if ((Array.isArray(durable) && durable.length > 0) || (request.imageReferences?.length ?? 0) > 0) {
      throw new ProviderRequestRejectedError(`comfyui: ${recipe.displayName} takes no reference images`);
    }
    const values = this.valuesFor(recipe, request);
    // The last check before the wire (§2.5, R-16): a checkpoint replaced since the picker
    // rendered is refused here, before any request reaches the engine.
    const verified = await this.preflight(recipe.id);
    if (!verified.ok) throw new ProviderRequestRejectedError(verified.reason);
    const graph = substituteRecipeParams(recipe, values);
    const base = this.require();
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: "arke-studio" }),
    });
    const promptId = (body as { prompt_id?: string } | null)?.prompt_id;
    if (status >= 400 || !promptId) {
      const errors = (body as { node_errors?: Record<string, unknown> } | null)?.node_errors;
      // A count, never node ids: this message becomes job.error and reaches the renderer, and
      // R-1 says no node id is shown to a user.
      const named =
        errors && Object.keys(errors).length > 0 ? ` (${Object.keys(errors).length} node(s) reported invalid)` : "";
      // A 4xx from /prompt proves the engine rejected the graph before queueing anything.
      throw new ProviderRequestRejectedError(`comfyui: the engine rejected the prompt (HTTP ${status})${named}`);
    }
    return { remoteId: promptId, acceptedAt: new Date().toISOString() };
  }

  /**
   * `/queue` answers the live states — including position, which v1 deliberately does not
   * project as progress (§1.2) — and `/history/{id}` answers the terminal ones. An id neither
   * knows is an engine that restarted: its queue was in-memory, and the honest state is failed
   * with that said.
   */
  async poll(_key: string, remoteId: string, _context?: ProviderCallContext): Promise<PollResult> {
    const base = this.require();
    const queue = await jsonRequest(this.fetchImpl, this.id, `${base}/queue`, {});
    if (queue.status < 400) {
      const body = queue.body as { queue_running?: QueueEntryish[]; queue_pending?: QueueEntryish[] } | null;
      const inList = (list: QueueEntryish[] | undefined): boolean =>
        Array.isArray(list) && list.some((entry) => Array.isArray(entry) && entry[1] === remoteId);
      if (inList(body?.queue_running)) return { state: "running" };
      if (inList(body?.queue_pending)) return { state: "queued" };
    }
    const history = await jsonRequest(this.fetchImpl, this.id, `${base}/history/${remoteId}`, {});
    if (history.status >= 400) {
      throw new Error(`comfyui: the engine answered HTTP ${history.status} to /history`);
    }
    const entry = (history.body as Record<string, unknown> | null)?.[remoteId] as
      | { status?: { status_str?: string; completed?: boolean; messages?: unknown[] } }
      | undefined;
    if (!entry) {
      return {
        state: "failed",
        error: "comfyui: the engine no longer knows this prompt — it may have been restarted",
      };
    }
    const status = entry.status;
    if (status?.status_str === "error") {
      return { state: "failed", error: historyError(status.messages) ?? "comfyui: the engine reported an execution error" };
    }
    if (status?.completed === true) return { state: "succeeded" };
    // Present in history but not completed: the engine is finalising. Keep polling.
    return { state: "running" };
  }

  /**
   * Only the recipe's declared output node is fetched (§2.6) — never every file the history
   * names, because "whatever else the graph touched" is exactly the surface R-1 closed.
   */
  async fetchArtifacts(_key: string, remoteId: string, context?: ProviderCallContext): Promise<FetchedArtifact[]> {
    const model = context?.model;
    const recipe = model !== undefined ? comfyUiRecipeById(model) : null;
    if (!recipe) {
      throw new Error("comfyui: cannot select the authoritative output without the recipe id");
    }
    const base = this.require();
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${base}/history/${remoteId}`, {});
    if (status >= 400) throw new Error(`comfyui: the engine answered HTTP ${status} to /history`);
    const entry = (body as Record<string, unknown> | null)?.[remoteId] as
      | { outputs?: Record<string, Record<string, unknown>> }
      | undefined;
    const outputs = entry?.outputs?.[recipe.outputNode];
    if (!outputs) {
      throw new Error(`comfyui: the history entry has no outputs for node ${recipe.outputNode}`);
    }
    const files: Array<{ filename: string; subfolder: string; type: string }> = [];
    for (const value of Object.values(outputs)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (
          item !== null &&
          typeof item === "object" &&
          typeof (item as { filename?: unknown }).filename === "string"
        ) {
          const file = item as { filename: string; subfolder?: string; type?: string };
          files.push({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
        }
      }
    }
    if (files.length === 0) throw new Error("comfyui: the output node produced no files");
    const artifacts: FetchedArtifact[] = [];
    for (const [index, file] of files.entries()) {
      const url =
        `${base}/view?filename=${encodeURIComponent(file.filename)}` +
        `&subfolder=${encodeURIComponent(file.subfolder)}&type=${encodeURIComponent(file.type)}`;
      const res = await this.fetchImpl(url, {});
      if (res.status >= 400) throw new Error(`comfyui: fetching "${file.filename}" answered HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      const ext = (file.filename.split(".").pop() ?? "bin").toLowerCase();
      const contentType =
        ext === "png" ? "image/png"
        : ext === "webp" ? "image/webp"
        : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "mp4" ? "video/mp4"
        : ext === "webm" ? "video/webm"
        // Audio, because a voice recipe's output node saves a wav (SPEC-022). Naming the type
        // is not cosmetic: `verifyArtifact` dispatches on it, and an unnamed type falls through
        // to "a non-empty body is the best check available" — so a truncated download or an
        // error page would have been filed as a take and played as silence, which is the exact
        // failure the Kokoro client's own RIFF check exists to prevent.
        : ext === "wav" ? "audio/wav"
        : ext === "mp3" ? "audio/mpeg"
        : ext === "flac" ? "audio/flac"
        : "application/octet-stream";
      artifacts.push({ name: `output-${index + 1}.${ext}`, contentType, data });
    }
    return artifacts;
  }

  /**
   * Targeted, never a bare interrupt (R-17): a pending prompt is deleted by id; the running
   * prompt is interrupted only when it is provably this one; anything else — somebody else's
   * work on a shared engine, or a prompt already terminal — is left exactly alone.
   */
  async cancel(_key: string, remoteId: string, _context?: ProviderCallContext): Promise<void> {
    const base = this.require();
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${base}/queue`, {});
    if (status >= 400) throw new Error(`comfyui: the engine answered HTTP ${status} to /queue`);
    const parsed = body as { queue_running?: QueueEntryish[]; queue_pending?: QueueEntryish[] } | null;
    const pending = (parsed?.queue_pending ?? []).some((e) => Array.isArray(e) && e[1] === remoteId);
    if (pending) {
      await jsonRequest(this.fetchImpl, this.id, `${base}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [remoteId] }),
      });
      return;
    }
    const runningOurs = (parsed?.queue_running ?? []).some((e) => Array.isArray(e) && e[1] === remoteId);
    if (runningOurs) {
      await jsonRequest(this.fetchImpl, this.id, `${base}/interrupt`, { method: "POST" });
    }
    // Neither pending nor ours-running: terminal, or another user's work. Nothing to touch.
  }
}

/**
 * The first human-readable execution error the history's message log carries, if any.
 *
 * The engine's own message only — never the node type, which is graph content (R-1) — and with
 * filesystem paths reduced to basenames. This string becomes `job.error`, which is journalled
 * on the job row and rendered in Activity, and the engine quotes the paths it resolved: a
 * missing checkpoint reports the whole models path (SPEC-001 R-9, SPEC-021 §2.11). The
 * filename is the actionable half and it survives.
 */
function historyError(messages: unknown[] | undefined): string | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== "execution_error") continue;
    const detail = message[1] as { exception_message?: unknown } | undefined;
    if (detail && typeof detail.exception_message === "string") {
      return `comfyui: ${scrubPaths(detail.exception_message).slice(0, 500)}`;
    }
  }
  return null;
}

/** The SDXL bucket whose shape is closest — shape first, the same tie the size snapper breaks. */
function nearestBucket(width: number, height: number): string {
  const ratio = width / height;
  let best = "1:1";
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const [aspect, size] of Object.entries(SDXL_BUCKETS)) {
    const delta = Math.abs(size.width / size.height - ratio);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = aspect;
    }
  }
  return best;
}

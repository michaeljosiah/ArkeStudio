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
 * What a recipe is doing while it counts, by capability.
 *
 * The engine only ever says which node is stepping, and a node id is both meaningless to a
 * reader and forbidden to show (R-1). The capability is the honest, stable answer: it is what
 * the user asked for.
 */
const STAGE_WORDS: Record<ComfyUiRecipe["capability"], string> = {
  image: "drawing",
  video: "rendering",
  "voice-tts": "speaking",
};

/** The little of a WebSocket this needs: frames in, and a close to reopen on. */
export interface ProgressSocket {
  onMessage: ((data: string) => void) | null;
  onClose: (() => void) | null;
  close(): void;
}

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
  /*
   * Everything a voice dispatch carries, taken from a real job rather than guessed.
   *
   * `voiceId` is the job's own subject and `speakerFile` is a path on THIS machine that only
   * becomes a graph value once uploaded. The rest — the correlation id, what the line is for,
   * whose sheet it came from and how long it is — are the coordinator's bookkeeping, the exact
   * analogue of `provenance` on an image job. Only `text` and `seed` are controls of the recipe.
   */
  "voiceId",
  "speakerFile",
  "requestId",
  "purpose",
  "sheetId",
  "sheetVersion",
  "characterCount",
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
    /**
     * Reads a speaker clip off this machine, for the one recipe whose input is a file the app
     * owns. Optional because every other recipe is text-to-something and never touches the disk;
     * a voice dispatch without it refuses by name rather than uploading nothing.
     */
    private readonly readClip?: (path: string) => Promise<Uint8Array>,
    /**
     * Opens the engine's progress socket (SPEC-021 D16). Injected so the tests can drive it, and
     * optional because progress is the one thing a dispatch works perfectly well without.
     */
    private readonly openSocket?: (url: string) => ProgressSocket,
    /**
     * How much of the graphics card is free RIGHT NOW, in MB, or null where that cannot be asked
     * (SPEC-022 §2.6).
     *
     * Deliberately not ComfyUI's own `/system_stats`: it reports what torch has allocated, so it
     * answered "8.86 GB free" on a card with 6.77 GB actually free — it cannot see the browser or
     * the game holding the other 3 GB. Asking the device is the only honest answer, and the
     * device is the host's to ask.
     */
    private readonly freeVramMb?: () => Promise<number | null>,
  ) {}

  /** Latest step count per prompt, fed by the engine's socket and read by `poll`. */
  private readonly steps = new Map<string, { done: number; total: number }>();
  /** What each live prompt is doing, so a count can be named without naming a node (R-1). */
  private readonly stages = new Map<string, string>();
  private socket: ProgressSocket | null = null;

  /**
   * Listen to the engine say what it is doing.
   *
   * ComfyUI reports progress only on its WebSocket — there is no HTTP equivalent — and it
   * broadcasts to every client, tagging each message with the prompt it belongs to. So one
   * socket serves every job, opened the first time anything is polled and reopened if it drops.
   * Failing to open it is not a dispatch failure: the job runs, and `poll` simply has no figure.
   */
  private listen(base: string): void {
    if (this.socket || !this.openSocket) return;
    try {
      const socket = this.openSocket(`${base.replace(/^http/, "ws")}/ws?clientId=arke-studio`);
      this.socket = socket;
      socket.onClose = () => {
        this.socket = null;
      };
      socket.onMessage = (raw: string) => {
        try {
          const msg = JSON.parse(raw) as { type?: string; data?: Record<string, unknown> };
          const data = msg.data ?? {};
          const promptId = typeof data["prompt_id"] === "string" ? data["prompt_id"] : null;
          if (!promptId) return;
          if (msg.type === "progress") {
            const done = Number(data["value"]);
            const total = Number(data["max"]);
            if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return;
            // `data.node` is deliberately ignored: it is a node id, and R-1 keeps node ids away
            // from anything a user reads. What the prompt is doing was recorded at submit.
            this.steps.set(promptId, { done, total });
          } else if (msg.type === "execution_success" || msg.type === "execution_error") {
            this.steps.delete(promptId);
            this.stages.delete(promptId);
          }
        } catch {
          /* a frame we do not understand is not a reason to stop listening */
        }
      };
    } catch {
      this.socket = null;
    }
  }

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
    const seedParam = params["seed"];
    const seedValue: RecipeParamValues =
      typeof seedParam === "number" && Number.isInteger(seedParam) ? { seed: seedParam } : {};
    if (recipe.capability === "voice-tts") {
      // A line to speak, never a prompt describing a performance (SPEC-011 turn 70) — so this
      // recipe has no `prompt` at all, and asking it for one refused every dispatch before the
      // words were even looked at.
      const text = typeof params["text"] === "string" ? params["text"] : undefined;
      if (text === undefined || text.length === 0) {
        throw new Error(`comfyui: ${recipe.displayName} needs a line to speak`);
      }
      const clip = params["speakerFile"];
      if (typeof clip !== "string" || clip.length === 0) {
        throw new Error(`comfyui: ${recipe.displayName} needs the voice's own recording`);
      }
      // Still the path on this machine. `submit` uploads it and swaps in the engine's own
      // filename, because `LoadAudio.audio` is a dropdown over the engine's input directory and
      // a path from here means nothing on the other side of the wire.
      return { ...seedValue, text, speakerFile: clip };
    }
    const prompt = typeof params["prompt"] === "string" ? params["prompt"] : undefined;
    if (prompt === undefined || prompt.length === 0) {
      throw new Error(`comfyui: ${recipe.displayName} needs a prompt`);
    }
    const values: RecipeParamValues = { prompt, ...seedValue };
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

  /**
   * Put a speaker clip where the engine can name it, and answer with that name.
   *
   * `LoadAudio.audio` is a COMBO over the engine's own `input/` directory, not a path input, so
   * a clip this machine owns has to cross the wire before the graph can reference it. ComfyUI's
   * upload endpoint is `/upload/image` for audio too — the name is the engine's, not a mistake.
   *
   * `overwrite` keeps the directory from filling with `harbour-glass (1).wav` on every preview:
   * the clip is content the app owns and a re-upload of the same voice is the same bytes.
   */
  private async uploadClip(base: string, clipPath: string): Promise<string> {
    if (!this.readClip) {
      throw new Error("comfyui: this build cannot read a voice recording from disk");
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.readClip(clipPath);
    } catch {
      // The path is the app's own and R-1 keeps node ids out of user-facing errors; a path is
      // the same kind of detail, so this names the clip rather than where it lives.
      throw new ProviderRequestRejectedError("comfyui: that voice's recording could not be read");
    }
    // Both separators: the clip path is this machine's, and on Windows that is backslashes —
    // splitting on "/" alone uploads the whole path as the filename.
    const name = clipPath.split(/[\\/]/).pop() ?? "voice.wav";
    const form = new FormData();
    // Copied into a plain ArrayBuffer: a Uint8Array view can sit on a larger pooled buffer, and
    // handing Blob the view's buffer would upload whatever else is in it.
    const body = bytes.slice().buffer as ArrayBuffer;
    form.append("image", new Blob([body], { type: "audio/wav" }), name);
    form.append("overwrite", "true");
    const response = await this.fetchImpl(`${base}/upload/image`, { method: "POST", body: form });
    if (!response.ok) {
      throw new ProviderRequestRejectedError(
        `comfyui: the engine would not accept the voice recording (HTTP ${response.status})`,
      );
    }
    const answered = (await response.json()) as { name?: string; subfolder?: string } | null;
    const uploaded = answered?.name;
    if (typeof uploaded !== "string" || uploaded.length === 0) {
      throw new ProviderRequestRejectedError("comfyui: the engine did not say where it put the voice recording");
    }
    // A subfolder is part of the name the dropdown shows, so it is part of what LoadAudio takes.
    return answered?.subfolder ? `${answered.subfolder}/${uploaded}` : uploaded;
  }

  /**
   * Make room, or say plainly that there is none (SPEC-022 §2.6).
   *
   * The start-up probe reads the card's TOTAL size from the registry, so a machine passes the
   * floor and then runs out anyway because something else already had the card. This is the same
   * question asked at the moment it matters, of the device rather than of the engine.
   *
   * When it is short, the engine is asked to put down whatever it is still holding — a video
   * model from an earlier job, most likely — and the card is measured again. That is worth doing
   * only when short: `/free` throws away the model cache, so calling it before every dispatch
   * would buy a cold start on every line.
   */
  private async ensureRoomOnTheCard(base: string, recipe: ComfyUiRecipe): Promise<void> {
    const need = recipe.hardware.minVramMb;
    if (!this.freeVramMb || need <= 0) return;
    const first = await this.freeVramMb().catch(() => null);
    // Unknown stays unknown and dispatches (SPEC-021 D15): a card this build cannot measure is
    // not a card this build may refuse.
    if (first === null || first >= need) return;
    await this.fetchImpl(`${base}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }).catch(() => undefined);
    const after = await this.freeVramMb().catch(() => null);
    if (after === null || after >= need) return;
    const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;
    throw new ProviderRequestRejectedError(
      `comfyui: ${recipe.displayName} needs ${gb(need)} of free graphics memory and this machine has ${gb(after)} free. ` +
        `The engine has already put down what it was holding — close other programs using the graphics card, then try again.`,
    );
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
    const base = this.require();
    await this.ensureRoomOnTheCard(base, recipe);
    // The clip becomes a name the engine knows. Done after preflight so a job that was going to
    // be refused never puts a file on the engine, and before the graph is built because the
    // uploaded name IS the graph value.
    if (recipe.capability === "voice-tts") {
      values["speakerFile"] = await this.uploadClip(base, String(values["speakerFile"]));
    }
    const graph = substituteRecipeParams(recipe, values);
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
    // What this prompt is doing, in the recipe's own words. Recorded here because `poll` knows
    // only a prompt id, and the alternative — the node id the socket sends — is exactly what R-1
    // keeps away from a user.
    this.stages.set(promptId, STAGE_WORDS[recipe.capability]);
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
    this.listen(base);
    const queue = await jsonRequest(this.fetchImpl, this.id, `${base}/queue`, {});
    if (queue.status < 400) {
      const body = queue.body as { queue_running?: QueueEntryish[]; queue_pending?: QueueEntryish[] } | null;
      const inList = (list: QueueEntryish[] | undefined): boolean =>
        Array.isArray(list) && list.some((entry) => Array.isArray(entry) && entry[1] === remoteId);
      if (inList(body?.queue_running)) {
        const counted = this.steps.get(remoteId);
        const stage = this.stages.get(remoteId);
        // A fraction as well as the count: `progress` is the field the contract already had, and
        // it is finally true here because it is a node's own steps rather than queue position.
        return counted && stage
          ? { state: "running", step: { stage, ...counted }, progress: counted.done / counted.total }
          : { state: "running" };
      }
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

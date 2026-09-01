import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import {
  callerParamNames,
  comfyUiRecipeById,
  comfyUiRecipeIdentity,
  SDXL_BUCKETS,
  substituteRecipeParams,
  VIDEO_DERIVATIONS,
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
import { ProviderBusyError, ProviderRequestRejectedError } from "../types.js";

/** Where the engine is listening right now, or null when none is configured and healthy. */
export type EngineBaseUrl = () => string | null;
export type EngineLocality = () => "local" | "remote";

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

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

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
   * `voiceId` is the job's own subject and `voiceReference` only marks that the queue must attach
   * ephemeral host-read bytes. The rest — the correlation id, what the line is for,
   * whose sheet it came from and how long it is — are the coordinator's bookkeeping, the exact
   * analogue of `provenance` on an image job. Only `text` and `seed` are controls of the recipe.
   */
  "voiceId",
  "voiceReference",
  "requestId",
  "purpose",
  "sheetId",
  "sheetVersion",
  "characterCount",
  "audioFormat",
  "references",
  "referenceRoles",
  "artDirection",
  "provenance",
  "lookKind",
  "lookPrompt",
  "shotPlan",
  "continuedFrom",
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
/**
 * How long the card is given to empty after `/free`, and how often it is asked (SPEC-022 §2.6).
 *
 * The engine answers `/free` before it has done anything: the route sets two flags on its prompt
 * queue, and the worker thread unloads when it next wakes — after the response, and only once any
 * prompt it is executing has finished — with CUDA handing the memory back after that. A card
 * measured the instant the response lands is the card as it was, so the one re-measurement this
 * used to make was nearly always short, and #692's run refused alternate shots on a card each
 * success had left full for the next. Two seconds covers an idle engine putting a video model
 * down; a card still short after that has something else on it, and refusing is the honest answer.
 * The window is elapsed time with the probe's own duration counted, not a number of polls: the
 * desktop's probe is an nvidia-smi run with a five-second timeout, and eight slow readings would
 * have stretched two seconds into most of a minute with the job sitting in `submitting`.
 */
const UNLOAD_POLL_MS = 250;
const UNLOAD_WINDOW_MS = 2000;

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
    /** The device probe belongs to this computer and is invalid for a remote URL engine. */
    private readonly engineLocality: EngineLocality = () => "local",
    /** How the card is waited on after `/free`, and what time it is — injected so the tests need no real clock. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  /** Latest step count per prompt, fed by the engine's socket and read by `poll`. */
  private readonly steps = new Map<string, { done: number; total: number }>();
  /** What each live prompt is doing, so a count can be named without naming a node (R-1). */
  private readonly stages = new Map<string, string>();
  private socket: ProgressSocket | null = null;
  private socketBase: string | null = null;
  private disposed = false;

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.socketBase = null;
    if (socket) {
      socket.onMessage = null;
      socket.onClose = null;
      try {
        socket.close();
      } catch {
        /* progress is optional; a half-open socket must not fail lifecycle work */
      }
    }
    this.steps.clear();
    this.stages.clear();
  }

  /**
   * Listen to the engine say what it is doing.
   *
   * ComfyUI reports progress only on its WebSocket — there is no HTTP equivalent — and it
   * broadcasts to every client, tagging each message with the prompt it belongs to. So one
   * socket serves every job, opened the first time anything is polled and reopened if it drops.
   * Failing to open it is not a dispatch failure: the job runs, and `poll` simply has no figure.
   */
  private listen(base: string): void {
    if (this.disposed || !this.openSocket) return;
    if (this.socket && this.socketBase === base) return;
    if (this.socket) this.closeSocket();
    try {
      const socket = this.openSocket(`${base.replace(/^http/, "ws")}/ws?clientId=arke-studio`);
      this.socket = socket;
      this.socketBase = base;
      socket.onClose = () => {
        if (this.socket === socket) {
          this.socket = null;
          this.socketBase = null;
        }
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
      this.socketBase = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.closeSocket();
  }

  resetTransport(): void {
    this.closeSocket();
  }

  /**
   * The engine origin, with any trailing slash taken off (#631).
   *
   * Every request below joins `${base}/path`, and the base is whatever a person typed into
   * Settings — `http://127.0.0.1:8188/` is the form the field's own placeholder suggests. Joined
   * unchanged that yields `//system_stats`, which ComfyUI answers 404 to while serving
   * `/system_stats` a 200. The engine was healthy and every local recipe sat disabled behind
   * "the engine did not answer", which is the one thing that had not happened.
   *
   * `coordinator/comfyui/engine.ts` has always stripped it for the probe it owns. This is the
   * same rule on the client's side of the boundary, applied once so the eleven joins below
   * cannot disagree about it.
   */
  private static origin(base: string): string {
    return base.replace(/\/+$/, "");
  }

  private require(): string {
    const base = this.baseUrl();
    if (base === null) {
      throw new Error("comfyui: no engine is running — point Settings at an install, or download the managed one");
    }
    return ComfyUiClient.origin(base);
  }

  /**
   * The compatibility probe (D14): `/system_stats` must answer with a version at or above the
   * floor. What it cannot prove — files, nodes — is readiness's business, not this probe's.
   */
  async validateKey(): Promise<CapabilityProbe[]> {
    const capabilities = ["image", "video", "voice-tts"] as const;
    // Not `require()`: this one answers rather than throws when nothing is configured, so it
    // reads the base itself — and therefore has to normalise it itself.
    const raw = this.baseUrl();
    const base = raw === null ? null : ComfyUiClient.origin(raw);
    if (base === null) {
      return capabilities.map((capability) => ({
        capability,
        available: false,
        reason: "no ComfyUI engine is configured or running",
      }));
    }
    let body: unknown;
    try {
      // Bounded for the same reason as Ollama's: validation is polled (issue 462).
      const answer = await jsonRequest(this.fetchImpl, this.id, `${base}/system_stats`, {
        signal: AbortSignal.timeout(3_000),
      });
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
      const clip = request.voiceReference;
      if (!clip) {
        throw new Error(`comfyui: ${recipe.displayName} needs the voice's own recording`);
      }
      // A placeholder only. `submit` uploads the ephemeral bytes and swaps in the engine's own
      // filename before graph substitution; no host path exists at this layer.
      return { ...seedValue, text, speakerFile: clip.name };
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
    // and the engine's frame count is derived per recipe — Wan's 4k+1 against H3's 17k+5, each
    // latent's own arithmetic, looked up rather than hardcoded now that there are two.
    const derivation = VIDEO_DERIVATIONS[recipe.id];
    if (derivation === undefined) {
      throw new Error(`comfyui: ${recipe.displayName} has no video derivation tables`);
    }
    const rawAspect = params["aspect"] ?? params["aspect_ratio"];
    const aspect = typeof rawAspect === "string" && rawAspect in derivation.dimensions ? rawAspect : "16:9";
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
    const frames = derivation.framesBySeconds[String(asked)] ?? null;
    if (frames === null) {
      const offered = Object.keys(derivation.framesBySeconds).join(", ");
      throw new Error(`comfyui: ${recipe.displayName} cannot be asked for ${asked}s — it offers ${offered}s`);
    }
    const size = derivation.dimensions[aspect]!;
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
   * The name is content-addressed before it reaches this client, so two worlds cannot overwrite
   * each other's reference clips and repeated use of identical bytes remains stable.
   */
  private async uploadClip(
    base: string,
    clip: NonNullable<SubmitRequest["voiceReference"]>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!/^[0-9a-f]{64}\.(wav|mp3)$/.test(clip.name)) {
      throw new ProviderRequestRejectedError("comfyui: the voice recording has no safe content-addressed name");
    }
    const form = new FormData();
    // Copied into a plain ArrayBuffer: a Uint8Array view can sit on a larger pooled buffer, and
    // handing Blob the view's buffer would upload whatever else is in it.
    const body = clip.data.slice().buffer as ArrayBuffer;
    form.append("image", new Blob([body], { type: clip.contentType }), clip.name);
    form.append("overwrite", "true");
    const response = await this.fetchImpl(`${base}/upload/image`, {
      method: "POST",
      redirect: "manual",
      body: form,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (isRedirect(response.status)) {
      throw new ProviderRequestRejectedError(
        `comfyui: the engine redirected the voice recording upload (HTTP ${response.status}); Arke refused to send it to another destination`,
      );
    }
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
   * model from an earlier job, most likely — and the card is measured again, for a couple of
   * seconds: the engine says yes before it has put anything down (see UNLOAD_POLL_MS). Asking is
   * worth doing only when short: `/free` throws away the model cache, so calling it before every
   * dispatch would buy a cold start on every line.
   *
   * Still short is a busy card, not a refused request: nothing about the job is wrong, and the
   * same job goes through once the card is free. It is thrown as the transient it is, so the
   * queue backs off and tries again while the engine finishes putting things down, and a user
   * told to close other programs "then try again" has a Retry to press when it gives up (#692).
   */
  private async ensureRoomOnTheCard(base: string, recipe: ComfyUiRecipe): Promise<void> {
    // The free-VRAM floor, not the card-size floor: a streaming recipe (H3) legitimately needs
    // the whole card to exist and only a fraction of it free at dispatch.
    const need = recipe.hardware.minFreeVramMb;
    if (this.engineLocality() === "remote" || !this.freeVramMb || need <= 0) return;
    const first = await this.freeVramMb().catch(() => null);
    // Unknown stays unknown and dispatches (SPEC-021 D15): a card this build cannot measure is
    // not a card this build may refuse.
    if (first === null || first >= need) return;
    await this.fetchImpl(`${base}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }).catch(() => undefined);
    // Asked again over a short window rather than once, because the engine has said yes before
    // it has done anything. Unknown mid-window dispatches exactly as unknown at the start does:
    // the probe failing is not the card filling up.
    const deadline = this.now() + UNLOAD_WINDOW_MS;
    let after = await this.freeVramMb().catch(() => null);
    while (after !== null && after < need && this.now() < deadline) {
      await this.sleep(UNLOAD_POLL_MS);
      after = await this.freeVramMb().catch(() => null);
    }
    if (after === null || after >= need) return;
    const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;
    throw new ProviderBusyError(
      `comfyui: ${recipe.displayName} needs ${gb(need)} of free graphics memory and this machine has ${gb(after)} free. ` +
        `The engine has already put down what it was holding — close other programs using the graphics card, then try again.`,
    );
  }

  async submit(_key: string, request: SubmitRequest, _context?: ProviderCallContext): Promise<SubmitResult> {
    if (this.disposed) throw new Error("comfyui: the provider client is disposed");
    const recipe = comfyUiRecipeById(request.model);
    if (!recipe) throw new Error(`comfyui: "${request.model}" is not a shipped recipe`);
    if (recipe.capability === "voice-tts" && request.params["audioFormat"] !== "flac") {
      throw new ProviderRequestRejectedError("comfyui: the cloned-voice recipe output format must be FLAC");
    }
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
      values["speakerFile"] = await this.uploadClip(base, request.voiceReference!, request.signal);
    }
    const graph = substituteRecipeParams(recipe, values);
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${base}/prompt`, {
      method: "POST",
      redirect: "manual",
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: "arke-studio" }),
    });
    if (isRedirect(status)) {
      throw new ProviderRequestRejectedError(
        `comfyui: the engine redirected prompt submission (HTTP ${status}); Arke refused to send it to another destination`,
      );
    }
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
    if (this.disposed) throw new Error("comfyui: the provider client is disposed");
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
    if (this.disposed) throw new Error("comfyui: the provider client is disposed");
    const model = context?.model;
    const recipe = model !== undefined ? comfyUiRecipeById(model) : null;
    if (!recipe) {
      throw new Error("comfyui: cannot select the authoritative output without the recipe id");
    }
    const base = this.require();
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${base}/history/${remoteId}`, {
      redirect: "manual",
    });
    if (isRedirect(status)) {
      throw new Error(
        `comfyui: the engine redirected output history (HTTP ${status}); Arke refused to follow it`,
      );
    }
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
      const res = await this.fetchImpl(url, { redirect: "manual" });
      if (isRedirect(res.status)) {
        throw new Error(
          `comfyui: the engine redirected the download for "${file.filename}" (HTTP ${res.status}); Arke refused to follow it`,
        );
      }
      if (res.status >= 400) throw new Error(`comfyui: fetching "${file.filename}" answered HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      const ext = (file.filename.split(".").pop() ?? "bin").toLowerCase();
      const contentType =
        ext === "png" ? "image/png"
        : ext === "webp" ? "image/webp"
        : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "mp4" ? "video/mp4"
        : ext === "webm" ? "video/webm"
        // Voice recipes can return WAV, MP3, or FLAC (SPEC-022). Naming the type is not cosmetic:
        // `verifyArtifact` dispatches on it, and an unnamed type falls through
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
    if (this.disposed) return;
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

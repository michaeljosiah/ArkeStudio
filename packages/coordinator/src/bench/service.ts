import { readdir } from "node:fs/promises";
import {
  admitReference,
  aspectSupport,
  benchSessionSummary,
  deliveryParams,
  benchSourceKey,
  benchTokenFor,
  dispatchDuration,
  estimateMicroUsd,
  imageOutputFor,
  keyframeAddable,
  keyframePlan,
  modeSpec,
  mappedReferenceKinds,
  modeCapability,
  MUSIC_DURATION_SEC,
  newId,
  pricedDuration,
  routeFor,
  sizeParamsFor,
  validateReferences,
  type ArtifactSidecar,
  type BenchReferenceSource,
  type BenchReferenceToken,
  type BenchRequestSnapshot,
  type BenchReservedTake,
  type BenchSession,
  type BenchSessionSummary,
  type BenchTake,
  type Capability,
  type Delivery,
  type ManifestModel,
  type ModelManifest,
  type MultimediaReference,
  type ReferenceKind,
  type SessionId,
  type TaskMode,
  type WorldBundle,
} from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { BenchStore, sessionDir, sessionMediaDir, sessionsDir } from "./store.js";

/**
 * The bench's commands (issue 305 §6): everything between a client message and the session log.
 *
 * Two disciplines run through all of it. Allocation — tokens and take numbers — happens HERE,
 * inside the session's serialized writer, never in the renderer: two clients racing the same
 * session cannot both claim "Image 3". And validation happens twice by design: the composer asks
 * these same functions to draw its controls, and dispatch asks them again immediately before
 * enqueue, because renderer state is not an authority (§9).
 */

// ---------------------------------------------------------------------------
// Discovery — session rows for the world bundle, never the takes
// ---------------------------------------------------------------------------

export async function discoverBenchSessions(worldDir: string): Promise<BenchSessionSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(toExtendedLength(sessionsDir(worldDir)));
  } catch {
    return []; // no sessions yet is the ordinary case, not a problem
  }
  const summaries: BenchSessionSummary[] = [];
  for (const entry of entries) {
    const store = new BenchStore(sessionDir(worldDir, entry as SessionId));
    const session = await store.fold().catch(() => null);
    if (session) summaries.push(benchSessionSummary(session));
  }
  // Most recently touched first: "Generate resumes the world's most recently updated session".
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}

// ---------------------------------------------------------------------------
// Open or create
// ---------------------------------------------------------------------------

export interface OpenedBench {
  store: BenchStore;
  session: BenchSession;
}

/**
 * By id from a durable URL, or with none — which resumes the most recently updated session and
 * creates one only when the world has none. Creation seeds the composer with the routed image
 * model so the fold's empty baseline never reaches a screen.
 */
export async function openBenchSession(
  worldDir: string,
  now: () => string,
  options: {
    sessionId?: SessionId | undefined;
    /** The routed default for a fresh session, resolved by the caller from settings+manifest. */
    defaultModel?: { provider: string; model: string } | undefined;
    /** Force a new session even where others exist — the clear-the-bench gesture. */
    fresh?: boolean | undefined;
  } = {},
): Promise<OpenedBench | null> {
  if (options.sessionId !== undefined) {
    const store = new BenchStore(sessionDir(worldDir, options.sessionId));
    const session = await store.fold();
    return session === null ? null : { store, session };
  }
  if (options.fresh !== true) {
    const summaries = await discoverBenchSessions(worldDir);
    const latest = summaries[0];
    if (latest) {
      const store = new BenchStore(sessionDir(worldDir, latest.id));
      const session = await store.fold();
      if (session) return { store, session };
    }
  }
  const id = newId("sess") as SessionId;
  const store = new BenchStore(sessionDir(worldDir, id));
  const at = now();
  await store.create(id, at);
  await store.append(
    {
      type: "composer-set",
      mode: "image",
      provider: options.defaultModel?.provider ?? "",
      model: options.defaultModel?.model ?? "",
      params: { kind: "image", count: 1 },
      brief: "",
    },
    { at },
  );
  const session = await store.fold();
  return session === null ? null : { store, session };
}

// ---------------------------------------------------------------------------
// References — resolution and allocation
// ---------------------------------------------------------------------------

export interface ResolvedSource {
  source: BenchReferenceSource;
  kind: ReferenceKind;
  /** Seconds for audio/video; null when measurement failed or has not happened. */
  durationSec: number | null;
  /** World-relative path to the bytes, for dispatch. */
  path: string;
}

/** What refused an attach, in the words the tile shows. */
export type BenchRefusal = { refused: string };

/**
 * An artifact reference: kind from the sidecar, duration from its measurement. A document —
 * or anything else that is not image, audio or video — is refused with the spec's words, and
 * a board counts as an image only because its bytes ARE an image (kindForFile said so when it
 * was filed; a "board" sidecar kind is a PNG contact sheet).
 */
export function resolveArtifactSource(artifact: ArtifactSidecar): ResolvedSource | BenchRefusal {
  const kind: ReferenceKind | null =
    artifact.kind === "image" || artifact.kind === "board"
      ? "image"
      : artifact.kind === "audio"
        ? "audio"
        : artifact.kind === "video"
          ? "video"
          : null;
  if (kind === null) {
    return { refused: artifact.kind === "document" ? "a document cannot be sent" : "this file cannot be sent" };
  }
  return {
    source: { source: "artifact", artifactId: artifact.id, hash: artifact.hash },
    kind,
    durationSec: kind === "image" ? 0 : (artifact.mediaInfo?.durationSec ?? null),
    path: `artifacts/${artifact.file}`,
  };
}

/** A session take as a reference: its landed media, by take id. */
export function resolveTakeSource(session: BenchSession, takeId: string): ResolvedSource | BenchRefusal {
  const take = session.takes.find((t) => t.id === takeId);
  if (!take || !take.media) return { refused: "that take has no media yet" };
  // What the take actually IS, by the mode that made it. Read as "video or else image" this
  // sent a spoken take to a picture model as though it were a still.
  const kind: ReferenceKind =
    take.request.mode === "video" ? "video" : take.request.mode === "voice" ? "audio" : "image";
  return {
    source: { source: "take", takeId: take.id, hash: take.media.hash },
    kind,
    durationSec: kind === "image" ? 0 : (take.media.info?.durationSec ?? null),
    path: `${sessionMediaDir(session.id, take.id)}/${take.media.file}`,
  };
}

/** The active set as budget items, durations resolved the same way dispatch will resolve them. */
export function activeReferenceItems(
  session: BenchSession,
  bundle: WorldBundle,
): Array<MultimediaReference & { token: string }> {
  const items: Array<MultimediaReference & { token: string }> = [];
  for (const token of session.composer.activeTokens) {
    const entry = session.tokenRegistry.find((e) => e.token === token);
    if (!entry) continue;
    const resolved = resolveTokenEntry(entry, session, bundle);
    items.push({
      token,
      kind: entry.kind,
      durationSec: "refused" in resolved ? null : resolved.durationSec,
    });
  }
  return items;
}

/**
 * What a bare path says about itself, which is only its extension.
 *
 * Pictures only. A character's references are pictures, and a path alone cannot tell you a
 * clip's duration — the reference budget is spent in seconds, so admitting a video whose length
 * is unknown would mean admitting it against a budget nobody can compute. Artifacts carry a
 * measured `mediaInfo` and takes carry theirs; a loose file carries nothing.
 */
export function worldFileKind(path: string): ReferenceKind | null {
  return /\.(png|jpg|jpeg|webp)$/i.test(path) ? "image" : null;
}

/**
 * Reads the bytes a world-relative path names, having first confined it to the world.
 *
 * Injected because this file is otherwise pure and testable without a disk, and because
 * confinement is the host's business: the schema settles the shape of a path
 * (`WorldFilePathSchema`), and this settles that the resolved path is really inside the world.
 * Two gates, because one of them is a regular expression and the other is the filesystem.
 */
export interface WorldFileReader {
  read(path: string): Promise<{ hash: string } | BenchRefusal>;
}

/** A world file already attached: the path was checked when it was picked, and it is immutable. */
export function resolveWorldFileSource(source: BenchReferenceSource & { source: "world-file" }): ResolvedSource | BenchRefusal {
  const kind = worldFileKind(source.path);
  if (kind === null) return { refused: "only a picture can be attached from the world" };
  return { source, kind, durationSec: 0, path: source.path };
}

export function resolveTokenEntry(
  entry: BenchReferenceToken,
  session: BenchSession,
  bundle: WorldBundle,
): ResolvedSource | BenchRefusal {
  const source = entry.source;
  if (source.source === "artifact") {
    const artifact = bundle.artifacts.find((a) => a.id === source.artifactId);
    return artifact ? resolveArtifactSource(artifact) : { refused: "that artifact is no longer in the world" };
  }
  if (source.source === "world-file") return resolveWorldFileSource(source);
  return resolveTakeSource(session, source.takeId);
}

export type AddReferenceOutcome =
  | { outcome: "added" | "restored" | "replaced"; token: string }
  | { outcome: "already-active"; token: string }
  | { outcome: "refused"; reason: string };

/**
 * Attach one source, allocating its token coordinator-side (§6). The registry is consulted
 * first: the same source re-added restores its old name — "Image 2" means the same bytes for
 * the session's whole life — and only a source the session has never seen takes a new number.
 */
export async function addBenchReference(
  opened: OpenedBench,
  bundle: WorldBundle,
  model: ManifestModel | null,
  input: {
    source:
      | { source: "artifact"; artifactId: string }
      | { source: "take"; takeId: string }
      | { source: "world-file"; path: string };
    replace?: string | undefined;
    /** Present when the pick may name a world file; the host reads and confines it. */
    worldFile?: WorldFileReader | undefined;
    /** Which lane the pick lands in. Absent is the reference lane (issue 305 §3). */
    lane?: "reference" | "keyframe" | undefined;
    requestId: string;
    at: string;
  },
): Promise<AddReferenceOutcome> {
  const { store, session } = opened;
  const lane = input.lane ?? "reference";
  const wanted = input.source;
  let resolved: ResolvedSource | BenchRefusal;
  if (wanted.source === "artifact") {
    const artifact = bundle.artifacts.find((a) => a.id === wanted.artifactId);
    resolved = artifact ? resolveArtifactSource(artifact) : { refused: "that artifact is no longer in the world" };
  } else if (wanted.source === "world-file") {
    // The bytes decide the hash, not the client: the path is a request to read a file, and what
    // is recorded is what was actually found there.
    const kind = worldFileKind(wanted.path);
    if (kind === null) {
      resolved = { refused: "only a picture can be attached from the world" };
    } else if (input.worldFile === undefined) {
      resolved = { refused: "this world's files cannot be read just now" };
    } else {
      const read = await input.worldFile.read(wanted.path);
      resolved = "refused" in read
        ? read
        : { source: { source: "world-file", path: wanted.path, hash: read.hash as never }, kind, durationSec: 0, path: wanted.path };
    }
  } else {
    resolved = resolveTakeSource(session, wanted.takeId);
  }
  if ("refused" in resolved) return { outcome: "refused", reason: resolved.refused };
  if (lane === "keyframe" && resolved.kind !== "image") {
    return { outcome: "refused", reason: "only an image can ride as a keyframe" };
  }

  const key = benchSourceKey(resolved.source);
  const existing = session.tokenRegistry.find((e) => benchSourceKey(e.source) === key);
  const laneTokens = lane === "keyframe" ? session.composer.keyframeTokens : session.composer.activeTokens;
  if (existing && laneTokens.includes(existing.token)) {
    // "The same bench source is never active twice or assigned two tokens" (§4).
    return { outcome: "already-active", token: existing.token };
  }

  // The model gates admission. No model chosen yet admits nothing — the composer cannot
  // offer capacity it cannot state.
  if (model === null) return { outcome: "refused", reason: "choose a model first" };

  if (lane === "keyframe") {
    // Frames are not budgeted references — the lane's ceiling is the frame task modes' own,
    // and the plan that admits the pick is the plan dispatch will re-run (issue 305 §3).
    if (!keyframeAddable(model, session.composer.keyframeTokens.length)) {
      const plan = keyframePlan(model, session.composer.keyframeTokens.length + 1);
      return { outcome: "refused", reason: plan.ok ? "the keyframe lane is full" : plan.reason };
    }
  } else {
    const carried = activeReferenceItems(session, bundle).filter((item) => item.token !== input.replace);
    const verdict = admitReference({ kind: resolved.kind, durationSec: resolved.durationSec }, carried, model);
    if (!verdict.ok) {
      // At the image ceiling the caller may name which active token gives way; with a valid
      // `replace` the swap is one atomic event, so the set is never over the ceiling.
      const replacing = input.replace !== undefined && session.composer.activeTokens.includes(input.replace);
      if (!(verdict.binding === "images" && replacing)) {
        return { outcome: "refused", reason: verdict.reason };
      }
    }
  }

  const laneField = lane === "keyframe" ? ({ lane: "keyframe" } as const) : {};
  if (existing) {
    await store.append(
      { type: "reference-restored", token: existing.token, ...laneField },
      { at: input.at, requestId: input.requestId },
    );
    return { outcome: "restored", token: existing.token };
  }
  const n = session.nextToken[resolved.kind] ?? 1;
  const entry: BenchReferenceToken = {
    token: benchTokenFor(resolved.kind, n),
    kind: resolved.kind,
    source: resolved.source,
  };
  if (lane === "reference" && input.replace !== undefined && session.composer.activeTokens.includes(input.replace)) {
    await store.append(
      { type: "reference-replaced", removed: input.replace, entry },
      { at: input.at, requestId: input.requestId },
    );
    return { outcome: "replaced", token: entry.token };
  }
  await store.append({ type: "reference-added", entry, ...laneField }, { at: input.at, requestId: input.requestId });
  return { outcome: "added", token: entry.token };
}

// ---------------------------------------------------------------------------
// Dispatch — validate everything, reserve, then enqueue
// ---------------------------------------------------------------------------

export interface BenchEnqueueInput {
  worldId: string;
  target: { kind: "bench-take"; id: string };
  capability: Capability;
  provider: string;
  model: string;
  params: Record<string, unknown>;
  estimatedMicroUsd: number;
  landing: { dir: string; name?: string };
}

export type BenchDispatchPlan =
  | { ok: false; reason: string }
  | { ok: true; reserved: BenchReservedTake[]; inputs: BenchEnqueueInput[] };

/**
 * The gate before enqueue (§9): capability, prompt, duration, duplicate, output and
 * unverified-model validation, repeated here whatever the renderer said. Returns the reserved
 * takes and the jobs they authorize; the caller appends the reservation (fsync) BEFORE enqueue.
 */
export function planBenchDispatch(
  session: BenchSession,
  bundle: WorldBundle,
  manifest: ModelManifest | null,
  options: {
    worldId: string;
    requestId: string;
    at: string;
    /** Re-run: dispatch this take's immutable snapshot instead of the live composer. */
    fromTake?: BenchTake | undefined;
    /**
     * The shipped version of a local recipe, when the chosen model is one (SPEC-021 R-13, R-15).
     * Injected because the recipe catalogue lives in @arke-studio/providers, which this package
     * does not depend on — the coordinator resolves it from the engine service and hands it in.
     * A re-run keeps the version the take was made with rather than taking today's.
     */
    recipeVersionOf?: (modelId: string) => number | undefined;
  },
): BenchDispatchPlan {
  const composer = options.fromTake
    ? {
        mode: options.fromTake.request.mode,
        provider: options.fromTake.request.provider,
        model: options.fromTake.request.model,
        params: options.fromTake.request.params,
        brief: options.fromTake.request.brief,
        activeTokens: options.fromTake.request.references.map((r) => r.token),
      }
    : session.composer;
  const model = manifest?.models.find((m) => m.id === composer.model && m.provider === composer.provider) ?? null;
  if (!model) return { ok: false, reason: "No model is chosen, or the chosen model is no longer in the manifest." };
  // Through the map, not compared: `voice` dispatches against `voice-tts` (design 70).
  if (model.capability !== modeCapability(composer.mode)) {
    return { ok: false, reason: `${model.displayName} is a ${model.capability} model; this is a ${composer.mode} request.` };
  }
  if (composer.brief.trim().length === 0) return { ok: false, reason: "An empty brief is not a brief." };

  // The prompt cap is the model's, where one is published; over it refuses, nothing truncates.
  const cap = model.limits.maxPromptChars;
  if (cap !== undefined && composer.brief.length > cap) {
    return { ok: false, reason: `The brief is ${composer.brief.length} characters; ${model.displayName} takes ${cap}.` };
  }

  // References: resolve the snapshot's own set (re-run) or the live active set, then validate
  // kinds, durations and ceilings as one whole.
  // A lane the mode has no use for rides along, ignored — the rule the keyframe lane already
  // follows for an image request. Found live: a session that had carried a reference for a shot
  // refused a spoken line over it, and voice mode hides the very lane that could have removed
  // it, so the refusal named something the user had no way to act on (design 70).
  const references: BenchReferenceToken[] = options.fromTake
    ? options.fromTake.request.references
    : composer.mode === "voice"
      ? []
      : session.composer.activeTokens
          .map((token) => session.tokenRegistry.find((e) => e.token === token))
          .filter((e): e is BenchReferenceToken => e !== undefined);
  const resolvedRefs: Array<{ entry: BenchReferenceToken; resolved: ResolvedSource }> = [];
  for (const entry of references) {
    const resolved = resolveTokenEntry(entry, session, bundle);
    if ("refused" in resolved) return { ok: false, reason: `${entry.token}: ${resolved.refused}` };
    resolvedRefs.push({ entry, resolved });
  }
  const verdict = validateReferences(
    resolvedRefs.map(({ resolved }) => ({ kind: resolved.kind, durationSec: resolved.durationSec })),
    model,
  );
  if (!verdict.ok) {
    const offending = resolvedRefs[verdict.index]?.entry.token ?? "a reference";
    return { ok: false, reason: `${offending}: ${verdict.refusal.reason}` };
  }
  // A kind the provider's transport does not map is refused before enqueue, not dropped after.
  const mapped = new Set(mappedReferenceKinds(model.provider));
  for (const { entry, resolved } of resolvedRefs) {
    if (!mapped.has(resolved.kind)) {
      return { ok: false, reason: `${entry.token}: ${model.provider} cannot carry ${resolved.kind} references yet` };
    }
  }
  const referencePaths = resolvedRefs.map(({ resolved }) => resolved.path);

  const params = composer.params;
  if (params.kind !== composer.mode) return { ok: false, reason: "The controls do not match the mode." };

  // The Keyframe lane (issue 305 §3): resolve the snapshot's own frames (re-run) or the live
  // lane, derive the task mode from the count, and honor the model's route for that mode —
  // declaring a task-mode route without sending to it is not support.
  const keyframes: BenchReferenceToken[] = options.fromTake
    ? options.fromTake.request.keyframes
    : composer.mode === "video"
      ? session.composer.keyframeTokens
          .map((token) => session.tokenRegistry.find((e) => e.token === token))
          .filter((e): e is BenchReferenceToken => e !== undefined)
      : []; // an image request never claimed frames — the lane rides along, ignored, not refused
  let frame: { mode: TaskMode; route: string | null; framesField: string | undefined; paths: string[] } | null = null;
  if (keyframes.length > 0) {
    if (composer.mode !== "video") return { ok: false, reason: "Keyframes ride video, not image." };
    if (references.length > 0) {
      // One request, one meaning: the frame routes take frames, not style references, and
      // sending both down one array would silently change what each image is for.
      return { ok: false, reason: "References and keyframes cannot ride one request yet — remove one set." };
    }
    const plan = keyframePlan(model, keyframes.length);
    if (!plan.ok) return { ok: false, reason: plan.reason };
    const paths: string[] = [];
    for (const entry of keyframes) {
      const resolved = resolveTokenEntry(entry, session, bundle);
      if ("refused" in resolved) return { ok: false, reason: `${entry.token}: ${resolved.refused}` };
      if (resolved.kind !== "image") return { ok: false, reason: `${entry.token}: only an image can ride as a keyframe` };
      paths.push(resolved.path);
    }
    frame = {
      mode: plan.mode,
      route: routeFor(model, plan.mode),
      framesField: modeSpec(model, plan.mode)?.framesField,
      paths,
    };
  }

  // A re-run dispatches the take's own snapshot (R-15): the version it was made with is what
  // that take means, so it is carried forward rather than re-resolved against today's catalogue.
  const recipeVersion = options.fromTake?.request.recipeVersion ?? options.recipeVersionOf?.(model.id);
  const snapshotBase: Omit<BenchRequestSnapshot, "params"> = {
    mode: composer.mode,
    brief: composer.brief,
    references,
    keyframes,
    provider: model.provider,
    model: model.id,
    ...(recipeVersion !== undefined ? { recipeVersion } : {}),
  };

  // A delivery this provider cannot express refuses here rather than being dropped on the way
  // out: a take that silently ignores the direction is a take the user has to listen to before
  // discovering the direction never applied (SPEC-011 R-15).
  let voiceSettings: Record<string, number> | null = null;
  if (params.kind === "voice" && params.delivery !== undefined) {
    const mapped = deliveryParams(model.provider, params.delivery as Delivery);
    if (!mapped.ok) return { ok: false, reason: mapped.reason };
    voiceSettings = mapped.params;
  }
  if (params.kind === "voice" && params.voiceId === undefined) {
    return { ok: false, reason: "No voice is chosen — pick one to read this." };
  }
  // minimax-music-3 requires prompt AND lyrics. Refused here with the missing half named,
  // rather than sent and 422'd: the brief is already guarded above, and words nobody wrote
  // are not something to discover from a provider error.
  if (params.kind === "music" && params.lyrics.trim().length === 0) {
    return { ok: false, reason: "There are no lyrics yet — write them, or ask for a draft." };
  }

  const reserved: BenchReservedTake[] = [];
  const inputs: BenchEnqueueInput[] = [];
  const count = params.kind === "video" ? 1 : options.fromTake ? 1 : params.count;

  for (let index = 0; index < count; index++) {
    const takeId = newId("tk");
    const n = session.nextTake + index;
    const snapshot: BenchRequestSnapshot = {
      ...snapshotBase,
      params: params.kind === "video" ? { ...params } : { ...params, count: 1 },
    };
    reserved.push({
      id: takeId as BenchReservedTake["id"],
      n,
      requestId: count === 1 ? options.requestId : `${options.requestId}/${index}`,
      request: snapshot,
      createdAt: options.at,
    });

    if (params.kind === "image") {
      const output = imageOutputFor(model, {
        landscape: true,
        ...(params.tier !== undefined ? { tier: params.tier } : {}),
        ...(params.aspect !== undefined ? { aspect: params.aspect } : {}),
      });
      inputs.push({
        worldId: options.worldId,
        target: { kind: "bench-take", id: `${session.id}/${takeId}` },
        capability: "image",
        provider: model.provider,
        model: model.id,
        params: {
          prompt: composer.brief,
          output,
          ...(referencePaths.length > 0 ? { references: referencePaths } : {}),
        },
        estimatedMicroUsd: estimateMicroUsd(model, {
          images: 1,
          megapixels: (output.width * output.height) / 1_000_000,
          referenceImages: referencePaths.length,
          ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
        }),
        landing: { dir: sessionMediaDir(session.id, takeId) },
      });
    } else if (params.kind === "video") {
      const requestedSec = params.durationSec ?? 0;
      // The route this job lands on is the one whose ceiling applies: references send it to a
      // different endpoint, and wan's makes 10s where its text route makes 15.
      const withReferences = referencePaths.length > 0;
      const choice =
        requestedSec > 0
          ? dispatchDuration(model, requestedSec, { withReferences })
          : { kind: "provider-default" as const };
      if (choice.kind === "over-cap") {
        return {
          ok: false,
          reason: choice.becauseReferences
            ? `${model.displayName} runs at most ${choice.longest}s with references — remove them, or shorten the shot.`
            : `${model.displayName} runs at most ${choice.longest}s.`,
        };
      }
      inputs.push({
        worldId: options.worldId,
        target: { kind: "bench-take", id: `${session.id}/${takeId}` },
        capability: "video",
        provider: model.provider,
        model: model.id,
        params: {
          prompt: composer.brief,
          ...(choice.kind === "asked" ? { duration: choice.wire } : {}),
          // A frame mode sends the size fields its route leaves unlocked (SPEC-019 R-33);
          // plain generation sends what was chosen. The frames travel as `references` so the
          // dispatcher's existing byte preparation carries them; `taskMode` tells the client
          // which wire fields they become, and `route` is the mode's own endpoint.
          ...(frame !== null
            ? {
                ...sizeParamsFor(model, frame.mode, {
                  ...(params.resolution !== undefined ? { resolution: params.resolution } : {}),
                  // Gated like sound below (issue 389): a preset's shape carried across models
                  // must not put a ratio on a route that never offered it — fal now maps
                  // `aspect` onto the wire, so an unvetted value stopped being harmless.
                  ...(params.aspect !== undefined && aspectSupport(model, params.aspect).ok
                    ? { aspect: params.aspect }
                    : {}),
                }),
                taskMode: frame.mode,
                ...(frame.route !== null ? { route: frame.route } : {}),
                ...(frame.framesField !== undefined ? { framesField: frame.framesField } : {}),
                references: frame.paths,
              }
            : {
                ...(params.resolution !== undefined ? { resolution: params.resolution } : {}),
                ...(params.aspect !== undefined && aspectSupport(model, params.aspect).ok
                  ? { aspect: params.aspect }
                  : {}),
                ...(referencePaths.length > 0 ? { references: referencePaths } : {}),
              }),
          // Only where the route publishes the choice. A preset carries the params it was saved
          // with, so a silent shot saved against seedance can be applied to a model that has no
          // audio switch — and putting a field on the wire that the route never declared is how
          // a job gets accepted, billed, and refused on its result.
          ...(params.sound !== undefined && model.limits.soundChoice === true ? { sound: params.sound } : {}),
        },
        estimatedMicroUsd: estimateMicroUsd(model, {
          // Priced at the length that will actually be asked for, on the route it will be asked
          // of — the estimate and the dispatch read the same function for that reason.
          durationSec:
            requestedSec > 0 ? pricedDuration(model, requestedSec, { withReferences }) : (model.limits.maxDurationSec ?? 5),
          ...(params.resolution !== undefined ? { resolution: params.resolution } : {}),
        }),
        landing: { dir: sessionMediaDir(session.id, takeId) },
      });
    } else if (params.kind === "voice") {
      // A spoken line (design 70). The brief IS the words, so it goes as `text` rather than a
      // prompt, and the price is exact: the characters are already typed, so nothing here is an
      // upper bound the way a duration or a megapixel count is.
      inputs.push({
        worldId: options.worldId,
        target: { kind: "bench-take", id: `${session.id}/${takeId}` },
        capability: "voice-tts",
        provider: model.provider,
        model: model.id,
        params: {
          text: composer.brief,
          ...(params.voiceId !== undefined ? { voiceId: params.voiceId } : {}),
          // The delivery is sent in the provider's own vocabulary, or not at all — a row that
          // cannot express one says so rather than having a neighbour's settings guessed at.
          ...(voiceSettings !== null ? { voiceSettings } : {}),
          // No container choice: the elevenlabs client caches what it is handed as mp3, so a
          // format control here would change nothing on the wire — and design 70's own rule is
          // that a control which changes nothing is a control that lies.
        },
        estimatedMicroUsd: estimateMicroUsd(model, { characters: composer.brief.length }),
        landing: { dir: sessionMediaDir(session.id, takeId) },
      });
    } else {
      // A song (design turn 73). The route asks for two things and neither can be derived from
      // the other: the STYLE rides as `prompt` — it is a description, which is what a brief has
      // always been here — and the LYRICS as their own field, because they are the words that
      // get sung rather than a description of them.
      inputs.push({
        worldId: options.worldId,
        target: { kind: "bench-take", id: `${session.id}/${takeId}` },
        capability: "music",
        provider: model.provider,
        model: model.id,
        params: {
          prompt: composer.brief,
          lyrics: params.lyrics,
          // Sent explicitly at the route's own default rather than left off. The fal client
          // refuses a length a model does not declare, and its comment is the reason this is
          // here at all: a request that runs at the provider's default while the estimate was
          // computed from a number is the bug that machinery exists to prevent.
          durationSec: MUSIC_DURATION_SEC,
        },
        // A ceiling, not a quote — the route calls `duration` an upper bound and stops when the
        // song is done. The take states the length that was actually made, measured from the
        // file, and the ledger records what was actually charged.
        estimatedMicroUsd: estimateMicroUsd(model, { durationSec: MUSIC_DURATION_SEC }),
        landing: { dir: sessionMediaDir(session.id, takeId) },
      });
    }
  }
  return { ok: true, reserved, inputs };
}

// ---------------------------------------------------------------------------
// Recovery (§6) — both crash windows, idempotent
// ---------------------------------------------------------------------------

export interface BenchRecoveryJobFacts {
  jobId: string;
  /** target.id: "<sessionId>/<takeId>". */
  targetId: string;
  status: "queued" | "submitting" | "running" | "succeeded" | "failed" | "cancelled" | "needs-reconciliation";
  error: string | null;
}

/**
 * Join the session log with the job journal after a restart. Window one: a reserved take with
 * no job — the crash fell between fsync and enqueue, nothing was spent, and the take is failed
 * with words that say so. Window two: a job whose id or terminal state never reached the log —
 * appended now. Success completion is deliberately NOT replayed here; the queue's replayable
 * finalization owns landing media, and doing it twice would race it.
 */
export async function recoverBenchSession(
  opened: OpenedBench,
  jobs: readonly BenchRecoveryJobFacts[],
  now: () => string,
): Promise<boolean> {
  const { store, session } = opened;
  const byTake = new Map<string, BenchRecoveryJobFacts>();
  for (const job of jobs) {
    const takeId = job.targetId.split("/")[1];
    if (takeId !== undefined && job.targetId.startsWith(`${session.id}/`)) byTake.set(takeId, job);
  }
  let touched = false;
  for (const take of session.takes) {
    const job = byTake.get(take.id);
    if (take.status === "allocating") {
      if (!job) {
        await store.append(
          { type: "take-status", takeId: take.id, status: "failed", error: "the app closed before this take was sent — nothing was spent" },
          { at: now() },
        );
        touched = true;
        continue;
      }
      await store.append({ type: "take-job", takeId: take.id, jobId: job.jobId as never }, { at: now() });
      touched = true;
    }
    if (job && take.status !== job.status && job.status !== "succeeded") {
      // Terminal failures and live statuses catch up; success waits for finalization, which
      // records media and cost with it.
      await store.append(
        { type: "take-status", takeId: take.id, status: job.status, ...(job.error !== null ? { error: job.error } : {}) },
        { at: now() },
      );
      touched = true;
    }
  }
  return touched;
}

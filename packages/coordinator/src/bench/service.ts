import { readdir } from "node:fs/promises";
import {
  admitReference,
  benchSessionSummary,
  benchSourceKey,
  benchTokenFor,
  dispatchDuration,
  estimateMicroUsd,
  imageOutputFor,
  mappedReferenceKinds,
  newId,
  parseBenchToken,
  pricedDuration,
  validateReferences,
  type ArtifactSidecar,
  type BenchReferenceSource,
  type BenchReferenceToken,
  type BenchRequestSnapshot,
  type BenchReservedTake,
  type BenchSession,
  type BenchSessionSummary,
  type BenchTake,
  type ManifestModel,
  type ModelManifest,
  type MultimediaReference,
  type ReferenceKind,
  type SessionId,
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
  const kind: ReferenceKind = take.request.mode === "video" ? "video" : "image";
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
    source: { source: "artifact"; artifactId: string } | { source: "take"; takeId: string };
    replace?: string | undefined;
    requestId: string;
    at: string;
  },
): Promise<AddReferenceOutcome> {
  const { store, session } = opened;
  const wanted = input.source;
  let resolved: ResolvedSource | BenchRefusal;
  if (wanted.source === "artifact") {
    const artifact = bundle.artifacts.find((a) => a.id === wanted.artifactId);
    resolved = artifact ? resolveArtifactSource(artifact) : { refused: "that artifact is no longer in the world" };
  } else {
    resolved = resolveTakeSource(session, wanted.takeId);
  }
  if ("refused" in resolved) return { outcome: "refused", reason: resolved.refused };

  const key = benchSourceKey(resolved.source);
  const existing = session.tokenRegistry.find((e) => benchSourceKey(e.source) === key);
  if (existing && session.composer.activeTokens.includes(existing.token)) {
    // "The same bench source is never active twice or assigned two tokens" (§4).
    return { outcome: "already-active", token: existing.token };
  }

  // The model gates admission. No model chosen yet admits nothing — the composer cannot
  // offer capacity it cannot state.
  if (model === null) return { outcome: "refused", reason: "choose a model first" };

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

  if (existing) {
    await store.append({ type: "reference-restored", token: existing.token }, { at: input.at, requestId: input.requestId });
    return { outcome: "restored", token: existing.token };
  }
  const n = session.nextToken[resolved.kind] ?? 1;
  const entry: BenchReferenceToken = {
    token: benchTokenFor(resolved.kind, n),
    kind: resolved.kind,
    source: resolved.source,
  };
  if (input.replace !== undefined && session.composer.activeTokens.includes(input.replace)) {
    await store.append(
      { type: "reference-replaced", removed: input.replace, entry },
      { at: input.at, requestId: input.requestId },
    );
    return { outcome: "replaced", token: entry.token };
  }
  await store.append({ type: "reference-added", entry }, { at: input.at, requestId: input.requestId });
  return { outcome: "added", token: entry.token };
}

// ---------------------------------------------------------------------------
// Dispatch — validate everything, reserve, then enqueue
// ---------------------------------------------------------------------------

export interface BenchEnqueueInput {
  worldId: string;
  target: { kind: "bench-take"; id: string };
  capability: "image" | "video";
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
  if (model.capability !== composer.mode) {
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
  const references: BenchReferenceToken[] = options.fromTake
    ? options.fromTake.request.references
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

  const snapshotBase: Omit<BenchRequestSnapshot, "params"> = {
    mode: composer.mode,
    brief: composer.brief,
    references,
    provider: model.provider,
    model: model.id,
  };

  const reserved: BenchReservedTake[] = [];
  const inputs: BenchEnqueueInput[] = [];
  const count = params.kind === "image" ? (options.fromTake ? 1 : params.count) : 1;

  for (let index = 0; index < count; index++) {
    const takeId = newId("tk");
    const n = session.nextTake + index;
    const snapshot: BenchRequestSnapshot = {
      ...snapshotBase,
      params: params.kind === "image" ? { ...params, count: 1 } : { ...params },
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
    } else {
      const requestedSec = params.durationSec ?? 0;
      const choice = requestedSec > 0 ? dispatchDuration(model, requestedSec) : { kind: "provider-default" as const };
      if (choice.kind === "over-cap") {
        return { ok: false, reason: `${model.displayName} runs at most ${choice.longest}s.` };
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
          ...(params.resolution !== undefined ? { resolution: params.resolution } : {}),
          ...(params.aspect !== undefined ? { aspect: params.aspect } : {}),
          ...(params.sound !== undefined ? { sound: params.sound } : {}),
          ...(referencePaths.length > 0 ? { references: referencePaths } : {}),
        },
        estimatedMicroUsd: estimateMicroUsd(model, {
          durationSec: requestedSec > 0 ? pricedDuration(model, requestedSec) : (model.limits.maxDurationSec ?? 5),
          ...(params.resolution !== undefined ? { resolution: params.resolution } : {}),
        }),
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

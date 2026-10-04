import { benchLineLanguage, benchVoiceDirection, directionSaysAnything, quoteSpeech, recogniseDirection, speechInputFits } from "@arke-studio/contracts";
import { createHash } from "node:crypto";
import { compileLine, type CompiledLine } from "../voice/direction.js";
import { stageArtifactProblem } from "../productions/stage-playblast.js";
import { planCastCharacterAudio, planSubjectCharacterAudio, characterAudioInstructions, referencePrompt, referenceInputProblem, type FrozenPerformanceAudio } from "@arke-studio/contracts";
import { castNameFor, referenceRouteModel, referenceSheetId, referenceRouteRefusal, referenceSubjectLines, whoFor, REFERENCE_ROUTE } from "@arke-studio/contracts";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_SHOT_SEC,
  admitReference,
  aspectSupport,
  benchDeleteRefusal,
  benchSessionSummary,
  benchUpscalePlan,
  UPSCALE_SIZE,
  benchSourceKey,
  benchTokenFor,
  bindingPreamble,
  briefForProvider,
  dispatchDuration,
  durationLimitsFor,
  estimateMicroUsd,
  imageOutputFor,
  keyframeAddable,
  keyframePlan,
  modeSpec,
  mappedReferenceKinds,
  modeCapability,
  MUSIC_DURATION_SEC,
  newId,
  orderedShots,
  pricedDuration,
  routeFor,
  sizeParamsFor,
  unresolvedBenchMentions,
  validateReferences,
  voiceFormatForModel,
  type ArtifactSidecar,
  type BenchReferenceSource,
  type BenchReferenceToken,
  type BenchComposer,
  type BenchRequestSnapshot,
  type BenchReservedTake,
  type BenchSession,
  type BenchSessionSummary,
  type BenchSubject,
  type BenchMode,
  type BenchTake,
  type BoundReference,
  type Capability,
  type ManifestModel,
  type ModelManifest,
  type MultimediaReference,
  type ReferenceKind,
  type SessionId,
  type TaskMode,
  type Provenance,
  type WorldBundle,
  voiceSourceFor,
} from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { BenchStore, sessionDir, sessionMediaDir, sessionsDir } from "./store.js";
import { boardSubjectIsCurrent } from "./subject.js";

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

/** Create or rejoin the exact subject session a correlated open command names. */
export async function openSubjectBenchSession(
  worldDir: string,
  sessionId: SessionId,
  at: string,
  prefill: {
    subject: BenchSubject;
    title: string;
    composer: BenchComposer;
    references: BenchReferenceToken[];
  },
): Promise<OpenedBench> {
  const store = new BenchStore(sessionDir(worldDir, sessionId));
  // The event can safely exist without metadata: discovery ignores it, and a retry deduplicates
  // it before creating the header. Writing the header first left a discoverable board session in
  // the fold's image baseline if the process stopped between these two durable writes.
  await store.append(
    {
      type: "subject-prefill-set",
      subject: prefill.subject,
      title: prefill.title,
      composer: prefill.composer,
      references: prefill.references,
    },
    { at, requestId: `subject-prefill:${sessionId}` },
  );
  await store.create(sessionId, at, prefill.subject);
  const session = await store.fold();
  if (session === null || session.subject === undefined) throw new Error("the subject bench session could not be created");
  return { store, session };
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
    /** Create an exact, fresh session with these reviewed words when sessionId does not exist. */
    initial?: { mode: Extract<BenchMode, "image" | "video">; brief: string; title?: string } | undefined;
  } = {},
): Promise<OpenedBench | null> {
  if (options.sessionId !== undefined) {
    const store = new BenchStore(sessionDir(worldDir, options.sessionId));
    const session = await store.fold();
    if (options.initial !== undefined) return createBenchSession(store, options.sessionId, now(), options);
    return session === null ? null : { store, session };
  }
  if (options.fresh !== true) {
    const summaries = await discoverBenchSessions(worldDir);
    // The id-less Artifacts route is the subjectless Bench. A production-bound session is
    // reopened only by its durable id or by another scene handoff, never by Generate elsewhere.
    const latest = summaries.find((summary) => summary.subject === undefined);
    if (latest) {
      const store = new BenchStore(sessionDir(worldDir, latest.id));
      const session = await store.fold();
      if (session) return { store, session };
    }
  }
  const id = newId("sess") as SessionId;
  const store = new BenchStore(sessionDir(worldDir, id));
  return createBenchSession(store, id, now(), options);
}

async function createBenchSession(
  store: BenchStore,
  id: SessionId,
  at: string,
  options: {
    defaultModel?: { provider: string; model: string } | undefined;
    initial?: { mode: Extract<BenchMode, "image" | "video">; brief: string; title?: string } | undefined;
  },
): Promise<OpenedBench | null> {
  const mode = options.initial?.mode ?? "image";
  await store.create(id, at);
  const initialized = new Set((await store.read()).flatMap((event) => event.requestId ? [event.requestId] : []));
  const composerRequestId = `initial-composer:${id}`;
  const titleRequestId = `initial-title:${id}`;
  if (!initialized.has(composerRequestId)) {
    await store.append(
      {
        type: "composer-set",
        mode,
        provider: options.defaultModel?.provider ?? "",
        model: options.defaultModel?.model ?? "",
        params: mode === "image" ? { kind: "image", count: 1 } : { kind: "video" },
        brief: options.initial?.brief ?? "",
      },
      { at, requestId: composerRequestId },
    );
  }
  if (options.initial?.title && !initialized.has(titleRequestId)) {
    await store.append(
      { type: "title-set", title: options.initial.title.slice(0, 200) },
      { at, requestId: titleRequestId },
    );
  }
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
  if (!take && (session.deletedTakes ?? []).some((gone) => gone.id === takeId)) return { refused: "that take was deleted" };
  if (!take || !take.media) return { refused: "that take has no media yet" };
  // What the take actually IS, by the mode that made it. Read as "video or else image" this
  // sent a spoken take to a picture model as though it were a still.
  const kind: ReferenceKind =
    take.request.mode === "video" ? "video" : take.request.mode === "voice" || take.request.mode === "music" ? "audio" : "image";
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
    const problem = artifact ? stageArtifactProblem(bundle,artifact) : null;
    if(problem) return {refused:problem};
    return artifact ? resolveArtifactSource(artifact) : { refused: "that artifact is no longer in the world" };
  }
  if (source.source === "world-file") {
    // Cross-session takes carry their measured kind and duration; loose picked files remain images.
    if (entry.kind !== "image" && entry.durationSec && (entry.kind === "video" ? /\.(mp4|m4v|mov|webm)$/i : /\.(wav|mp3)$/i).test(source.path)) {
      return { source, kind: entry.kind, durationSec: entry.durationSec, path: source.path };
    }
    return resolveWorldFileSource(source);
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

  if (resolved.kind === "video" && model.limits.referenceSyntax === "seedance" && !/\.(mp4|m4v|mov)$/i.test(resolved.path)) {
    return { outcome: "refused", reason: "Seedance video references must be MP4 or MOV." };
  }

  if (lane === "keyframe") {
    // Frames are not budgeted references — the lane's ceiling is the frame task modes' own,
    // and the plan that admits the pick is the plan dispatch will re-run (issue 305 §3).
    if (!keyframeAddable(model, session.composer.keyframeTokens.length)) {
      const plan = keyframePlan(model, session.composer.keyframeTokens.length + 1);
      return { outcome: "refused", reason: plan.ok ? "the keyframe lane is full" : plan.reason };
    }
  } else {
    const carried = activeReferenceItems(session, bundle).filter((item) => item.token !== input.replace);
    // The Reference lane of a row with a reference route admits against that route's budget
    // (design turn 179), not the row's one first frame.
    const verdict = admitReference({ kind: resolved.kind, durationSec: resolved.durationSec }, carried, referenceRouteModel(model));
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
  recipe?: import("@arke-studio/contracts").RecipeIdentity;
  worldId: string;
  target: { kind: "bench-take"; id: string };
  capability: Capability;
  provider: string;
  model: string;
  params: Record<string, unknown>;
  voiceReference?: boolean;
  voiceUploadConfirmedFor?: string;
  estimatedMicroUsd: number;
  landing: { dir: string; name?: string };
}

export type BenchDispatchPlan =
  | { ok: false; reason: string }
  | { ok: true; reserved: BenchReservedTake[]; inputs: BenchEnqueueInput[] };

function productionProvenanceFor(
  session: BenchSession,
  bundle: WorldBundle,
  references: readonly BenchReferenceToken[],
  fromTake: BenchTake | undefined,
): Provenance | undefined {
  if (session.subject === undefined) return undefined;
  if (fromTake?.request.productionProvenance !== undefined) return fromTake.request.productionProvenance;
  const sheets: Record<string, number> = { ...(session.subject.kind === "production" ? {} : session.subject.promptSheetVersions) };
  for (const reference of references) {
    if (reference.sheetId === undefined) continue;
    const version = reference.sheetVersion ?? bundle.sheets.find((sheet) => sheet.id === reference.sheetId)?.version;
    if (version !== undefined) sheets[reference.sheetId] = version;
  }
  return {
    canonRevision: bundle.meta.canonRevision,
    sheets,
    artDirectionVersion: bundle.artDirection.version,
  };
}

function productionFilingFor(
  session: BenchSession,
  bundle: WorldBundle,
  mode: BenchSession["composer"]["mode"],
): { ok: true; make: (coveredDurationSec?: number) => NonNullable<BenchRequestSnapshot["filing"]> } | { ok: false; reason: string } {
  const subject = session.subject;
  if (subject === undefined) return { ok: false, reason: "this session has no production subject" };
  if (subject.kind === "production") return { ok: false, reason: "Production music files as an artifact, without a shot selection." };
  const production = bundle.productions.find((candidate) => candidate.meta.id === subject.productionId);
  const scene = production?.scenes.find((candidate) => candidate.id === subject.sceneId);
  if (production === undefined || scene === undefined) {
    return { ok: false, reason: "The production subject is no longer available." };
  }
  const shots = orderedShots(scene);
  if (subject.kind === "shot") {
    const shot = shots.find((candidate) => candidate.id === subject.shotId);
    if (shot === undefined) {
      return { ok: false, reason: "The subject shot is no longer in this scene." };
    }
    if (mode === "image") {
      return {
        ok: true,
        make: () => ({
          kind: "shot",
          productionId: subject.productionId,
          sceneId: subject.sceneId,
          shotId: subject.shotId,
          productionTakeId: newId("tk"),
          frameArtifactId: newId("ar"),
        }),
      };
    }
    // The clip files as a board of one: a parent pass covering the shot and its one segment
    // child selected on the shot, so the cut, the boundary chain and Variants see exactly what a
    // board's members get (SPEC-036 R-24, R-36).
    if ((shot.durationSec ?? DEFAULT_SHOT_SEC) !== subject.durationSec) {
      return { ok: false, reason: "The shot timing changed in this scene. Rebuild the session." };
    }
    return {
      ok: true,
      make: (coveredDurationSec) => ({
        kind: "board",
        productionId: subject.productionId,
        sceneId: subject.sceneId,
        productionTakeId: newId("tk"),
        members: [
          {
            shotId: subject.shotId,
            number: subject.shotNumber,
            startSec: 0,
            endSec: Math.max(subject.durationSec, coveredDurationSec ?? 0),
            takeId: newId("tk"),
          },
        ],
      }),
    };
  }
  const memberIds = subject.members.map((member) => member.shotId);
  const first = shots.findIndex((shot) => shot.id === memberIds[0]);
  const current = first < 0 ? [] : shots.slice(first, first + memberIds.length);
  if (current.map((shot) => shot.id).join("\n") !== memberIds.join("\n")) {
    return { ok: false, reason: "The board members are no longer contiguous in this scene. Rebuild the session." };
  }
  if (
    current.some(
      (shot, index) => (shot.durationSec ?? 4) !== subject.members[index]?.durationSec,
    )
  ) {
    return { ok: false, reason: "The board timing changed in this scene. Rebuild the session." };
  }
  if (!boardSubjectIsCurrent(bundle, subject)) {
    return { ok: false, reason: "The board boundaries changed in this scene. Rebuild the session." };
  }
  return {
    ok: true,
    make: (coveredDurationSec) => {
      let cursor = 0;
      const members = subject.members.map((member) => {
        const startSec = cursor;
        cursor += member.durationSec;
        return {
          shotId: member.shotId,
          number: member.number,
          startSec,
          endSec: cursor,
          takeId: newId("tk"),
        };
      });
      // Discrete provider durations round up. The ordinary pass compiler gives that paid tail
      // to the final member; filing must use the same boundary or part of the clip and charge has
      // no shot that can review it.
      if (coveredDurationSec !== undefined && coveredDurationSec > cursor && members.length > 0) {
        members[members.length - 1]!.endSec = coveredDurationSec;
      }
      return {
        kind: "board",
        productionId: subject.productionId,
        sceneId: subject.sceneId,
        productionTakeId: newId("tk"),
        members,
      };
    },
  };
}

function filingMatchesCurrentSubject(
  filing: BenchRequestSnapshot["filing"],
  subject: NonNullable<BenchSession["subject"]>,
  coveredDurationSec?: number,
): boolean {
  if (subject.kind === "production") return false;
  if (filing === undefined || filing.productionId !== subject.productionId || filing.sceneId !== subject.sceneId) {
    return false;
  }
  if (subject.kind === "shot") {
    // A shot's clip files as a board of one (R-36), and that board is the shot's own filing —
    // a rerun of it is a rerun of the shot, not a take of some older timing.
    if (filing.kind === "shot") return filing.shotId === subject.shotId;
    return filing.members.length === 1 && filing.members[0]!.shotId === subject.shotId;
  }
  if (filing.kind !== "board" || filing.members.length !== subject.members.length) {
    return false;
  }
  let cursor = 0;
  return filing.members.every((member, index) => {
    const current = subject.members[index]!;
    const startSec = cursor;
    cursor += current.durationSec;
    const endSec = index === subject.members.length - 1 ? Math.max(cursor, coveredDurationSec ?? cursor) : cursor;
    return (
      member.shotId === current.shotId &&
      member.number === current.number &&
      member.startSec === startSec &&
      member.endSec === endSec
    );
  });
}

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
    /** Present on a dispatch press; absent for a read-only planning request. */
    speechAuthorisation?: { confirmedMicroUsd?: number };
    /** Re-run: dispatch this take's immutable snapshot instead of the live composer. */
    fromTake?: BenchTake | undefined;
    /** The scene cast's reads, resolved by the caller (SPEC-044 R-29): the plan card and the Bench say the same. */
    performanceReferences?: readonly FrozenPerformanceAudio[] | undefined;
    /**
     * The shipped version of a local recipe, when the chosen model is one (SPEC-021 R-13, R-15).
     * Injected because the recipe catalogue lives in @arke-studio/providers, which this package
     * does not depend on — the coordinator resolves it from the engine service and hands it in.
     * A re-run keeps the version the take was made with rather than taking today's.
     */
    recipeVersionOf?: (modelId: string, route?: "reference") => number | undefined;
    /** The identity of the graph that will run: the route's when one rides, adapters on top. */
    adapterRecipeFor?: (modelId: string, selections: unknown, route?: "reference") => import("@arke-studio/contracts").RecipeIdentity;
    /**
     * A local take's seed and sampling, frozen here rather than at enqueue so the take can say
     * what was sent (design turn 177): the job keeps both, because the enqueue freeze leaves a
     * caller's values alone. A re-run passes the take it repeats, whose sampling it keeps; the
     * seed is always fresh. Injected for the same reason `recipeVersionOf` is.
     */
    localFreeze?: (
      modelId: string,
      rerunOf?: { sampling?: import("@arke-studio/contracts").JobSampling },
    ) => { seed?: number; sampling?: import("@arke-studio/contracts").JobSampling };
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
  // An upscaler makes a take bigger and nothing from a brief (design turn 178); a re-run of an
  // upscale goes back through Upscale, never through here.
  if (model.upscale !== undefined) return { ok: false, reason: `${model.displayName} upscales a take — choose it from the take's tools.` };
  const params = composer.params;
  // Through the map, not compared: `voice` dispatches against `voice-tts` (design 70).
  if (model.capability !== modeCapability(composer.mode)) {
    return { ok: false, reason: `${model.displayName} is a ${model.capability} model; this is a ${composer.mode} request.` };
  }
  if (params.kind !== composer.mode) return { ok: false, reason: "The controls do not match the mode." };
  if (session.subject?.kind === "shot") {
    // A shot makes its frame, or — opened from the Stage — its clip, which files like a board of
    // one: the same length, aspect and sound rules a board is held to (SPEC-036 R-36).
    if (composer.mode === "video" && params.kind === "video") {
      if (params.durationSec !== session.subject.durationSec) {
        return { ok: false, reason: `This shot must keep its ${session.subject.durationSec}s authored duration.` };
      }
      if (params.sound !== true) return { ok: false, reason: "A shot clip must keep sound on." };
    } else if (composer.mode !== "image" || params.kind !== "image") {
      return { ok: false, reason: "A shot subject makes an image, or a clip of its own length." };
    }
    if (params.aspect !== session.subject.aspect) {
      return { ok: false, reason: `This shot must use the production aspect ${session.subject.aspect}.` };
    }
  }
  if (session.subject?.kind === "board") {
    if (composer.mode !== "video" || params.kind !== "video") {
      return { ok: false, reason: "A board subject must generate video." };
    }
    if (params.aspect !== session.subject.aspect) {
      return { ok: false, reason: `This board must use the production aspect ${session.subject.aspect}.` };
    }
    if (params.durationSec !== session.subject.durationSec) {
      return { ok: false, reason: `This board must keep its ${session.subject.durationSec}s authored duration.` };
    }
    if (params.sound !== true) return { ok: false, reason: "A board subject must keep sound on." };
  }
  if (session.subject?.kind === "production" && (composer.mode !== "music" || !bundle.productions.some(p => p.meta.id === session.subject!.productionId))) return { ok: false, reason: "This production audio Bench requires music mode and its owning production." };
  if (session.subject !== undefined && session.subject.kind !== "production" && !aspectSupport(model, session.subject.aspect).ok) {
    return { ok: false, reason: `${model.displayName} cannot make the production aspect ${session.subject.aspect}.` };
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
  //
  // A song is the same shape and had been left out of it (raised on review, issue 476). Music
  // arrived a turn later, hides the reference lane exactly as voice does, and its snapshot
  // refuses references outright — so a session that had carried a picture refused every song
  // over one the author could no longer see, let alone remove. Both modes that make a sound.
  const references: BenchReferenceToken[] = options.fromTake
    ? options.fromTake.request.references
    : composer.mode === "voice" || composer.mode === "music"
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
  // The Reference lane's pictures on a row with a reference route travel that route (design turn
  // 179), and are budgeted, cited and checked as the route reads them. A row without one says so
  // in one clause rather than taking the picture as something else.
  const pictureCount = resolvedRefs.filter(({ resolved }) => resolved.kind === "image").length;
  const routeRefusal = composer.mode === "video" ? referenceRouteRefusal(model, pictureCount) : null;
  if (routeRefusal !== null) return { ok: false, reason: routeRefusal };
  const onReferenceRoute = composer.mode === "video" && model.referenceRoute !== undefined && pictureCount > 0;
  const laneModel = onReferenceRoute ? referenceRouteModel(model) : model;
  const verdict = validateReferences(
    resolvedRefs.map(({ resolved }) => ({ kind: resolved.kind, durationSec: resolved.durationSec })),
    laneModel,
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
  // Pictures and clips travel in two lists (issue 852): the dispatcher reads each under its own
  // checks and the client puts each in its own wire field, so a clip in the picture list would
  // be refused at dispatch as a picture that is not one.
  const referencePaths = resolvedRefs.filter(({ resolved }) => resolved.kind === "image").map(({ resolved }) => resolved.path);
  const videoPaths = resolvedRefs.filter(({ resolved }) => resolved.kind === "video").map(({ resolved }) => resolved.path);
  const mediaReferences = !onReferenceRoute && (model.limits.referenceSyntax === "minimax-h3" || model.limits.referenceSyntax === "seedance") ? resolvedRefs.filter(({ resolved }) => resolved.kind !== "image").map(({ resolved }) => ({
    kind: resolved.kind, file: resolved.path, hash: resolved.source.hash, durationSec: resolved.durationSec,
  })) : [];
  const standaloneAudioCount = mediaReferences.filter(ref => ref.kind === "audio").length;

  const filingPlan = session.subject === undefined || session.subject.kind === "production" ? null : productionFilingFor(session, bundle, composer.mode);
  if (filingPlan !== null && !filingPlan.ok) return filingPlan;

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
  const taskMode = frame?.mode ?? "generate";

  // Mentions (issue 476): a brief may cite an attached reference by name — "@Image 1". What it
  // cites has to still be riding. A stale mention is refused with the name in it rather than
  // sent on as prose, because the prompt would then tell the model to look at a picture that
  // never arrived, and the take would be paid for before anyone could see that it had.
  const lost = unresolvedBenchMentions(composer.brief, [
    ...references.map((entry) => entry.token),
    ...keyframes.map((entry) => entry.token),
  ]);
  if (lost.length > 0) {
    const named = lost.map((token) => `@${token}`).join(", ");
    return {
      ok: false,
      reason:
        lost.length === 1
          ? `The brief cites ${named}, which is not attached. Attach it again, or take the mention out.`
          : `The brief cites ${named}, which are not attached. Attach them again, or take the mentions out.`,
    };
  }

  // The citations validated above name session tokens; the provider is handed a dense array and
  // counts from one. `briefForProvider` renames them to the places the bytes actually occupy, so
  // the words the model reads and the pictures it is given cannot drift apart once a reference
  // has been removed or restored in another order (raised on review, issue 476). The snapshot
  // keeps the author's own words, which is what makes a re-run reproduce this same arithmetic.
  const body = briefForProvider(composer.brief, frame !== null ? keyframes : references);
  let imageIndex = 0;
  const bound: BoundReference[] = [];
  for (const { entry, resolved } of resolvedRefs) {
    if (entry.kind !== "image") continue;
    imageIndex += 1;
    if (entry.productionBinding === undefined || entry.sheetId === undefined) continue;
    const first = bound.find((candidate) => candidate.sheetId === entry.sheetId);
    bound.push({
      index: imageIndex,
      sheetId: entry.sheetId,
      subject: entry.productionBinding.subject,
      file: resolved.path,
      kind: "image",
      rolePhrase: entry.productionBinding.rolePhrase,
      mode: entry.productionBinding.mode,
      sameSubjectAs: first?.index ?? null,
    });
  }
  // Who each picture is, and the bytes it was (design turn 179). A Cast picture is its character;
  // any other says what the author typed, or the default. A re-run says what the take said — a
  // character renamed since does not rename the person in an old take — and sends the hashes the
  // take recorded, which the client holds the bytes to before anything is uploaded.
  let referenceRoute: BenchRequestSnapshot["referenceRoute"];
  if (onReferenceRoute) {
    const recorded = options.fromTake?.request.referenceRoute;
    if (options.fromTake !== undefined && recorded === undefined) {
      return { ok: false, reason: `This take was made with another version of ${model.displayName}. Generate a current take instead.` };
    }
    const pictures: NonNullable<BenchRequestSnapshot["referenceRoute"]>["pictures"] = [];
    for (const { entry, resolved } of resolvedRefs) {
      if (resolved.kind !== "image") continue;
      if (resolved.source.hash !== entry.source.hash) {
        return {
          ok: false,
          reason: options.fromTake
            ? `${entry.token} has changed since this take. Generate a current take instead.`
            : `${entry.token} has changed since it was attached. Attach it again.`,
        };
      }
      const typed = params.kind === "video" ? params.who?.[entry.token] : undefined;
      const who = recorded?.pictures.find((picture) => picture.token === entry.token)?.who ?? whoFor(castNameFor(entry, bundle), typed);
      pictures.push({ token: entry.token, file: resolved.path.split("/").pop() ?? resolved.path, hash: entry.source.hash, who });
    }
    referenceRoute = { route: REFERENCE_ROUTE, prompt: "", pictures };
  }
  const preamble = session.subject === undefined || frame !== null || onReferenceRoute ? null : bindingPreamble(bound);
  // A scene or shot Bench voices the subject's speakers; a world Bench voices the characters its
  // Cast pictures are (planCastCharacterAudio). A re-run sends what its take sent either way.
  const imageCount = frame?.paths.length ?? referencePaths.length;
  const castSheetIds = resolvedRefs.flatMap(({ entry, resolved }) => {
    const sheetId = resolved.kind === "image" ? referenceSheetId(entry, bundle.artifacts) : undefined;
    return sheetId === undefined ? [] : [sheetId];
  });
  const resolvedAudio = params.kind !== "video" ? undefined
    : options.fromTake ? options.fromTake.request.audioReferences
    : session.subject && session.subject.kind !== "production" ? planSubjectCharacterAudio({
      world: bundle, subject: session.subject, model, imageCount, videoCount: videoPaths.length,
      taskMode, disabled: params.audioReferencesDisabled,
      ...(options.performanceReferences?.length ? { performanceReferences: options.performanceReferences } : {}) })
    : planCastCharacterAudio({ sheetIds: castSheetIds, sheets: bundle.sheets, kits: bundle.referenceKits, model, imageCount,
      videoCount: videoPaths.length, taskMode, disabled: params.audioReferencesDisabled });
  const audioReferences = resolvedAudio && (resolvedAudio.disabled || resolvedAudio.references.length || resolvedAudio.problems.length) ? resolvedAudio : undefined;
  if (audioReferences?.problems.length) return { ok: false, reason: audioReferences.problems.join(" ") };
  const referenceProblem = referenceInputProblem(model, { references: referencePaths, videoReferences: videoPaths, referenceMedia: mediaReferences, audioReferences });
  if (referenceProblem) return { ok: false, reason: referenceProblem };
  const motionBindings = model.limits.referenceSyntax === "seedance"
    ? videoPaths.map((_, index) => `Use @Video${index + 1} as a motion reference.`).join("\n") : "";
  // On the reference route Arke writes one subject line per picture and translates the brief's
  // citations; nothing else in the brief is rewritten (design turn 179).
  const wirePrompt = referenceRoute !== undefined
    ? [...referenceSubjectLines(referenceRoute.pictures.map((picture) => picture.who)), referencePrompt(body, laneModel)].join("\n")
    : [motionBindings || null, preamble ? referencePrompt(preamble, model, videoPaths.length, 0, true) : null,
      referencePrompt(body, model, videoPaths.length),
      audioReferences ? referencePrompt(characterAudioInstructions(audioReferences), model, videoPaths.length, standaloneAudioCount) : null].filter(Boolean).join("\n\n");
  if (referenceRoute !== undefined) referenceRoute.prompt = wirePrompt;
  // The cap was held against the brief, which is what the author can shorten; the words that
  // travel can be longer, because naming a reference the way this model reads it grows the
  // mention ("@Image 1" becomes "Picture 1", or H3's "<Picture 1>") and a subject's preamble
  // rides ahead of it. Over the cap here, the take would be reserved and then refused by the
  // recipe's own limit (raised on review, issue 1083).
  if (cap !== undefined && wirePrompt.length > cap) {
    return {
      ok: false,
      reason: `With its references named, the prompt is ${wirePrompt.length} characters; ${model.displayName} takes ${cap}.`,
    };
  }

  // A re-run dispatches the take's own snapshot (R-15): the version it was made with is what
  // that take means, so it is carried forward rather than re-resolved against today's catalogue.
  // When the catalogue no longer holds that version, nothing can run it: dispatching would run
  // today's recipe and file the take under the old number, the provenance lie R-13 exists to
  // prevent (raised on review, issue 1083 — Krea 2's picture labels changed what the recipe
  // sends without touching its graph). Refused by name, the way older timing is below.
  const route = referenceRoute !== undefined ? REFERENCE_ROUTE : undefined;
  const current = options.recipeVersionOf?.(model.id, route);
  const frozen = options.fromTake?.request.recipeVersion;
  if (frozen !== undefined && current !== undefined && current !== frozen) {
    return {
      ok: false,
      reason: `This take was made with another version of ${model.displayName}. Generate a current take instead.`,
    };
  }
  const recipeVersion = frozen ?? current;
  let adapterRecipe: import("@arke-studio/contracts").RecipeIdentity | undefined;
  // A route alone is frozen again at enqueue from the catalogue, so a caller without the seam —
  // a quote, a test — still gets the right identity on the job. Adapters need it here.
  if (params.kind === "video" && (params.adapters?.length || (route !== undefined && options.adapterRecipeFor))) {
    try {
      if (model.provider !== "comfyui" || !options.adapterRecipeFor) throw new Error("Adapter recipes are unavailable for this provider.");
      const currentRecipe = options.adapterRecipeFor(model.id, params.adapters ?? [], route);
      const savedRecipe = options.fromTake?.request.recipe;
      if (savedRecipe && (savedRecipe.templateDigest !== currentRecipe.templateDigest || savedRecipe.dependencyDigest !== currentRecipe.dependencyDigest ||
        savedRecipe.version !== currentRecipe.version || savedRecipe.route !== currentRecipe.route ||
        JSON.stringify(savedRecipe.adapters) !== JSON.stringify(currentRecipe.adapters))) {
        throw new Error("This take's adapter recipe has changed. Review a new request before dispatching.");
      }
      adapterRecipe = savedRecipe ?? currentRecipe;
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "Adapter recipe could not be resolved." }; }
  }
  const snapshotBase: Omit<BenchRequestSnapshot, "params"> = {
    ...(audioReferences ? { audioReferences } : {}),
    mode: composer.mode,
    brief: composer.brief,
    references,
    keyframes,
    provider: model.provider,
    model: model.id,
    ...(session.subject?.kind === "production" ? { productionAudio: { productionId: session.subject.productionId, role: session.subject.role } } : {}),
    ...(recipeVersion !== undefined ? { recipeVersion } : {}),
    ...(adapterRecipe ? { recipe: adapterRecipe } : {}),
    ...(referenceRoute !== undefined ? { referenceRoute } : {}),
    ...(session.subject !== undefined
      ? {
          productionProvenance: productionProvenanceFor(
            session,
            bundle,
            [...references, ...keyframes],
            options.fromTake,
          )!,
        }
      : {}),
  };

  // The line's direction (design turn 181), compiled by the one compiler every speech surface
  // shares (SPEC-049 R-28): the reader's tags in the words, its sentence beside them, its
  // numbers — and the job names no delivery, so no client adds a second tag of its own. What
  // this reader cannot take is held and named on the take, never spoken and never refused: the
  // composer has already shown it struck under Sent as. A tag still typed in the words is the
  // one thing refused — it would be read aloud (R-22), and the composer turns it into a marker.
  // The line's language: a cloned voice's recording language (issue 1163), otherwise the
  // catalogue voice's own — without it an English library voice on a paren reader (Breeze) had
  // every sound and pause held. The same language goes to the job, where only Breeze reads it.
  const voiceLanguage = params.kind === "voice" && params.voiceId !== undefined ? (() => {
    const source = voiceSourceFor(bundle.clonedVoices, model.provider, model.id, params.voiceId!);
    return source.kind === "cloned" ? source.voice.language : benchLineLanguage(params.voiceLanguage);
  })() : undefined;
  let directed: CompiledLine | null = null;
  // The words the line says: the brief, less any reader's tag it still held.
  let voiceWords = composer.brief;
  if (params.kind === "voice") {
    // A line written before design turn 181 — a take run again, a draft never edited since — may
    // hold a reader's tags in its words, which every other reader would speak. They are read as
    // the markers they name, as the composer reads them; a line that holds both a direction and
    // tags is the composer's to settle, and refused.
    const typed = recogniseDirection(composer.brief);
    const stated = benchVoiceDirection(params);
    if (typed.cues.length > 0 && params.direction !== undefined) {
      return { ok: false, reason: "A tag is in the words · it would be read aloud. Open the line to make it a marker." };
    }
    voiceWords = typed.cues.length > 0 ? typed.raw : composer.brief;
    const direction = typed.cues.length > 0 ? { ...(stated ?? { speed: 1 }), cues: typed.cues } : stated;
    if (directionSaysAnything(direction)) {
      const compiled = compileLine(voiceWords, direction, model, voiceLanguage, "hold");
      if (!compiled.ok) return { ok: false, reason: compiled.reason };
      directed = compiled.line;
    }
  }
  if (params.kind === "voice") {
    if (!speechInputFits(directed?.text ?? composer.brief, model.limits, directed?.instructions)) {
      return { ok: false, reason: "The line and its direction exceed this model's request limit. Shorten it or use an audiobook read in parts." };
    }
  }
  if (params.kind === "voice" && params.voiceId === undefined) {
    return { ok: false, reason: "No voice is chosen — pick one to read this." };
  }
  if (params.kind === "voice" && (params.voiceProvider ?? model.provider) !== model.provider) {
    return { ok: false, reason: "The chosen voice belongs to another provider — pick it again." };
  }
  if (params.kind === "voice" && (params.voiceModel ?? model.id) !== model.id) {
    return { ok: false, reason: "The chosen voice belongs to another speech model — pick it again." };
  }
  const voiceSource =
    params.kind === "voice" && params.voiceId !== undefined
      ? voiceSourceFor(bundle.clonedVoices, model.provider, model.id, params.voiceId)
      : { kind: "catalogue" as const };
  if (voiceSource.kind === "missing-clone") {
    return { ok: false, reason: "That cloned voice is no longer in this world — choose another voice." };
  }
  // minimax-music-3 requires prompt AND lyrics. Refused here with the missing half named,
  // rather than sent and 422'd: the brief is already guarded above, and words nobody wrote
  // are not something to discover from a provider error.
  if (params.kind === "music" && params.lyrics.trim().length === 0) {
    return { ok: false, reason: "There are no lyrics yet — write them, or ask for a draft." };
  }

  const videoDuration =
    params.kind === "video" && (params.durationSec ?? 0) > 0
      ? dispatchDuration(model, params.durationSec!, {
          taskMode,
          // A clip alone lands on the reference route too (issue 852), whose ceiling can be shorter.
          withReferences: referencePaths.length > 0 || videoPaths.length > 0,
        })
      : params.kind === "video"
        ? { kind: "provider-default" as const }
         : null;
  // A board and a shot's clip are both filed as covering an authored length, so neither can
  // ride a provider that picks its own.
  const timed = session.subject?.kind === "board" || (session.subject?.kind === "shot" && params.kind === "video");
  if (timed && videoDuration?.kind === "provider-default") {
    return {
      ok: false,
      reason: `${model.displayName} does not offer a fixed duration for this ${session.subject?.kind === "board" ? "board" : "shot"}.`,
    };
  }
  if (videoDuration?.kind === "over-cap") {
    return {
      ok: false,
      reason: videoDuration.becauseReferences
        ? `${model.displayName} runs at most ${videoDuration.longest}s with references — remove them, or shorten the shot.`
        : `${model.displayName} runs at most ${videoDuration.longest}s.`,
    };
  }
  if (
    options.fromTake !== undefined &&
    session.subject !== undefined &&
    session.subject.kind !== "production" &&
    !filingMatchesCurrentSubject(
      options.fromTake.request.filing,
      session.subject,
      videoDuration?.kind === "asked" ? videoDuration.seconds : undefined,
    )
  ) {
    return {
      ok: false,
      reason: "This take belongs to older production timing. Generate a current take instead.",
    };
  }

  const reserved: BenchReservedTake[] = [];
  const inputs: BenchEnqueueInput[] = [];
  const count = params.kind === "video" ? 1 : options.fromTake ? 1 : params.count;

  for (let index = 0; index < count; index++) {
    const takeId = newId("tk");
    const n = session.nextTake + index;
    const local = model.provider === "comfyui" && (params.kind === "image" || params.kind === "video")
      ? options.localFreeze?.(model.id, options.fromTake ? (options.fromTake.request.sampling ? { sampling: options.fromTake.request.sampling } : {}) : undefined) ?? {}
      : {};
    const localParams = {
      ...(local.seed !== undefined ? { seed: local.seed } : {}),
      ...(local.sampling !== undefined ? { sampling: local.sampling } : {}),
    };
    const snapshot: BenchRequestSnapshot = {
      ...snapshotBase,
      // What the reader was sent (design turn 181): the take says what went and what was held.
      ...(directed !== null
        ? {
            speech: {
              text: directed.text,
              ...(directed.instructions !== undefined ? { style: directed.instructions } : {}),
              providerTextHash: `sha256:${createHash("sha256").update(directed.text).digest("hex")}`,
              directionHash: directed.directionHash,
              held: directed.held.map((held) => ({ control: held.control, reason: held.reason })),
            },
          }
        : {}),
      ...(local.seed !== undefined ? { requestedSeed: local.seed } : {}),
      ...(local.sampling !== undefined ? { sampling: local.sampling } : {}),
      params: params.kind === "video" ? { ...params } : { ...params, count: 1 },
      ...(filingPlan?.ok
        ? { filing: filingPlan.make(videoDuration?.kind === "asked" ? videoDuration.seconds : undefined) }
        : {}),
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
          prompt: wirePrompt,
          output,
          ...(referencePaths.length > 0 ? { references: referencePaths } : {}),
          ...localParams,
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
      // The route this job lands on is the one whose ceiling applies: task modes select their
      // sibling route directly, while ordinary references select the reference endpoint.
      // A clip rides only on the reference route (issue 852): the frame routes declare no video
      // field, so a keyframe lane and a clip together is refused here, where the tile can act.
      if (frame !== null && videoPaths.length > 0) {
        return { ok: false, reason: "a clip cannot ride beside a keyframe — the frame route takes no video" };
      }
      const withReferences = referencePaths.length > 0 || videoPaths.length > 0;
      const choice = videoDuration!;
      inputs.push({
        worldId: options.worldId,
        target: { kind: "bench-take", id: `${session.id}/${takeId}` },
        capability: "video",
        provider: model.provider,
        model: model.id,
        params: {
          prompt: wirePrompt,
          ...(audioReferences ? { audioReferences } : {}),
          ...(params.adapters?.length ? { adapters: params.adapters } : {}),
          ...(mediaReferences.length ? { referenceMedia: mediaReferences } : {}),
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
                ...(videoPaths.length > 0 ? { videoReferences: videoPaths } : {}),
                ...(referenceRoute !== undefined
                  ? { recipeRoute: referenceRoute.route, referenceHashes: referenceRoute.pictures.map((picture) => picture.hash) }
                  : {}),
              }),
          // Only where the route publishes the choice. A preset carries the params it was saved
          // with, so a silent shot saved against seedance can be applied to a model that has no
          // audio switch — and putting a field on the wire that the route never declared is how
          // a job gets accepted, billed, and refused on its result.
          ...(params.sound !== undefined && model.limits.soundChoice === true ? { sound: params.sound } : {}),
          ...localParams,
        },
        estimatedMicroUsd: estimateMicroUsd(model, {
          // Priced at the length that will actually be asked for, on the route it will be asked
          // of — the estimate and the dispatch read the same function for that reason.
          durationSec:
            requestedSec > 0
              ? pricedDuration(model, requestedSec, { taskMode, withReferences })
              : (durationLimitsFor(model, taskMode).maxDurationSec ?? 5),
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
          text: directed?.text ?? composer.brief,
          audioFormat: voiceFormatForModel(model),
          ...(params.voiceId !== undefined ? { voiceId: params.voiceId } : {}),
          // The direction as the compiler wrote it for this reader (design turn 181): the words
          // with its tags in, its numbers, its sentence, and the hash that marks the text as
          // compiled — never the delivery's name, which a client would turn into a second tag.
          ...(directed !== null ? { authoredText: voiceWords, voiceSettings: directed.voiceSettings, directionHash: directed.directionHash, ...(directed.instructions !== undefined ? { instructions: directed.instructions } : {}) } : {}),
          // The line's language (a clone's recording language, issue 1163, or the catalogue
          // voice's own): the reader routes and tags by it, and the estimate counts its tags.
          ...(voiceLanguage !== undefined ? { language: voiceLanguage } : {}),
          // No container control: the concrete model declares its format and every downstream
          // layer consumes that same value.
        },
        // The compiled text is priced: its tags are in it, so no delivery is named to count twice.
        // A token reader's estimate counts its sentence too; the authorisation stays on the
        // dispatcher's quote as its cap, never the figure the composer asked (SPEC-049 R-6).
        estimatedMicroUsd: quoteSpeech(model, directed?.text ?? composer.brief, { at: options.at, language: voiceLanguage,
          ...(directed?.instructions !== undefined ? { instructions: directed.instructions } : {}) }).expectedMicroUsd,
        landing: { dir: sessionMediaDir(session.id, takeId) },
        ...(voiceSource.kind === "cloned" ? { voiceReference: true } : {}),
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
  if (model.capability === "voice-tts" && model.pricing.kind === "perToken" && options.speechAuthorisation !== undefined) {
    const confirmed = options.speechAuthorisation.confirmedMicroUsd;
    // The composer's estimate, against these words' now (SPEC-049 R-6): by the authored words
    // alone, as estimateSpeechMicroUsd says why. Not the compiled text: a pre-turn-181 brief's
    // typed `[pause]` compiles to `<short pause>` here while the composer priced it as typed,
    // and the take was refused until the brief was edited (review of PR 1477). The authored
    // words are what the composer's figure always covers; a rate rise still refuses.
    const total = inputs.reduce((sum, input) => sum + quoteSpeech(model, String(input.params.authoredText ?? input.params.text ?? ""), { at: options.at }).expectedMicroUsd, 0);
    // A $0 read — a free plan's (design turn 182) — has nothing to authorise.
    if (total > 0 && (confirmed === undefined || total > confirmed)) {
      return { ok: false, reason: "The speech price needs confirmation. Review the current price in the composer and press Generate." };
    }
  }
  return { ok: true, reserved, inputs: adapterRecipe ? inputs.map(input => ({ ...input, recipe: adapterRecipe })) : inputs };
}

// ---------------------------------------------------------------------------
// Upscale (design turn 178) — a new take beside its source, never an edit of it
// ---------------------------------------------------------------------------

/**
 * Plan one upscale of a finished video take: the reservation and the one job it authorizes, or
 * the clause that refuses it. The caller has already asked whether the engine can run it (the
 * recipe's readiness), because that is the engine's fact, not the session's.
 *
 * The source is sent by its world-relative path with the hash its take recorded, and the client
 * refuses bytes that no longer match. The frame comes from the file's own measurement through
 * `benchUpscalePlan`, the same function that decided to offer Upscale at all, so a take the
 * screen offered is a take this admits. Local only, by construction: the only upscaler is a
 * local recipe, and no cloud route is offered for any take, adult-classified or not.
 */
export function planBenchUpscale(
  session: BenchSession,
  manifest: ModelManifest | null,
  options: {
    worldId: string;
    requestId: string;
    takeId: string;
    at: string;
    recipeVersionOf?: (modelId: string) => number | undefined;
    seed?: number | undefined;
  },
): BenchDispatchPlan {
  // A production session files a take onto its shot or board, and an upscale has no filing of
  // its own yet: offered there, it would make a take Accept can never file.
  if (session.subject !== undefined) return { ok: false, reason: "Upscale from the world bench" };
  const source = session.takes.find((take) => take.id === options.takeId);
  if (source === undefined) return { ok: false, reason: "That take is no longer in this session" };
  const plan = benchUpscalePlan(source);
  if (plan === null || source.media === undefined) return { ok: false, reason: "This take is not a video below 1080p" };
  const model = manifest?.models.find((candidate) => candidate.upscale !== undefined && candidate.provider === "comfyui") ?? null;
  if (model === null) return { ok: false, reason: "No upscaler is installed" };
  const takeId = newId("tk");
  const recipeVersion = options.recipeVersionOf?.(model.id);
  const snapshot: BenchRequestSnapshot = {
    mode: "video",
    brief: "",
    references: [],
    keyframes: [],
    provider: model.provider,
    model: model.id,
    ...(recipeVersion !== undefined ? { recipeVersion } : {}),
    // The source's adapters ride on the record, not the job: whether a take may be shown with
    // adult content off is read from its params, and a 1080p copy of an adapter take is that
    // take. The upscaler itself takes no adapter.
    params: {
      kind: "video",
      aspect: plan.aspect,
      resolution: UPSCALE_SIZE,
      ...(source.request.params.kind === "video" && source.request.params.adapters?.length ? { adapters: source.request.params.adapters } : {}),
    },
    ...(options.seed !== undefined ? { requestedSeed: options.seed } : {}),
    upscale: {
      sourceTakeId: source.id,
      sourceN: source.n,
      sourceHash: source.media.hash,
      size: UPSCALE_SIZE,
      aspect: plan.aspect,
      from: plan.from,
      to: plan.to,
      crop: plan.crop,
    },
  };
  return {
    ok: true,
    reserved: [{ id: takeId as BenchReservedTake["id"], n: session.nextTake, requestId: options.requestId, request: snapshot, createdAt: options.at }],
    inputs: [
      {
        worldId: options.worldId,
        target: { kind: "bench-take", id: `${session.id}/${takeId}` },
        capability: "video",
        provider: model.provider,
        model: model.id,
        params: {
          size: UPSCALE_SIZE,
          aspect: plan.aspect,
          videoReferences: [`${sessionMediaDir(session.id, source.id)}/${source.media.file}`],
          sourceHash: source.media.hash,
          ...(source.media.info?.durationSec !== undefined ? { sourceDurationSec: source.media.info.durationSec } : {}),
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
        },
        // Free is the price; the measured rate is the cost, stated beside the press.
        estimatedMicroUsd: 0,
        landing: { dir: sessionMediaDir(session.id, takeId) },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Delete (design turn 180) — the take leaves the session, its files leave the disk
// ---------------------------------------------------------------------------

/** Every file under a take's media folder, by its path within the folder, with its size. */
export async function benchTakeFiles(
  worldDir: string,
  sessionId: SessionId,
  takeId: string,
  /** The take's own file, listed first because it is the one the confirm is about. */
  first?: string,
): Promise<Array<{ name: string; bytes: number }>> {
  const root = join(worldDir, sessionMediaDir(sessionId, takeId));
  const found: Array<{ name: string; bytes: number }> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(toExtendedLength(dir), { withFileTypes: true });
    } catch {
      return; // a failed take may never have had a folder
    }
    for (const entry of entries) {
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), name);
      else if (entry.isFile()) found.push({ name, bytes: (await stat(toExtendedLength(join(dir, entry.name)))).size });
    }
  };
  await walk(root, "");
  return found.sort((a, b) => Number(b.name === first) - Number(a.name === first) || a.name.localeCompare(b.name));
}

export type DeleteBenchTakeOutcome = { deleted: true } | { deleted: false; reason: string };

/**
 * Delete one take (design turn 180; SPEC-021 R-37). The refusal rules are `benchDeleteRefusal`'s, asked again
 * here whatever the screen showed. The `take-deleted` record is appended (fsynced) before any file
 * goes, so the only crash window leaves a deleted take with files still on disk — which
 * `sweepDeletedBenchMedia` finishes on the next open — and never a take whose bytes are missing.
 */
export async function deleteBenchTake(
  opened: OpenedBench,
  worldDir: string,
  takeId: string,
  options: { requestId: string; at: string },
): Promise<DeleteBenchTakeOutcome> {
  const take = opened.session.takes.find((candidate) => candidate.id === takeId);
  if (take === undefined) {
    // A resent command after its first press landed: the take is already gone, which is success.
    return (opened.session.deletedTakes ?? []).some((gone) => gone.id === takeId)
      ? { deleted: true }
      : { deleted: false, reason: "That take is no longer in this session" };
  }
  const refusal = benchDeleteRefusal(take);
  if (refusal !== null) return { deleted: false, reason: refusal.reason };
  await opened.store.append({ type: "take-deleted", takeId: take.id }, { at: options.at, requestId: options.requestId });
  // Once the record has landed the take IS deleted, whatever the disk says next. A folder Windows
  // will not let go of yet — the player still streaming the clip — is finished by the sweep on
  // the next open, rather than reported as a delete that did not happen while the take has
  // already left the wall.
  await removeBenchTakeMedia(worldDir, opened.session.id, take.id).catch(() => {});
  return { deleted: true };
}

async function removeBenchTakeMedia(worldDir: string, sessionId: SessionId, takeId: string): Promise<void> {
  await rm(toExtendedLength(join(worldDir, sessionMediaDir(sessionId, takeId))), {
    recursive: true,
    force: true,
    maxRetries: 3,
  });
}

/**
 * Finish any delete a crash interrupted: a take the log says is deleted keeps no folder. Cheap
 * when there is nothing to do — `force` makes a missing folder a no-op — so it runs on every open.
 */
export async function sweepDeletedBenchMedia(worldDir: string, session: BenchSession): Promise<void> {
  for (const gone of session.deletedTakes ?? []) {
    await removeBenchTakeMedia(worldDir, session.id, gone.id).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Recovery (§6) — both crash windows, idempotent
// ---------------------------------------------------------------------------

/** Durable local-admission marker: only reservations never passed to enqueue receive it. */
export const BENCH_UNATTEMPTED_ADMISSION = "Not attempted: admission stopped before this take; no provider was called.";

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
    }
    if (job && take.jobId !== job.jobId) {
      // A quote marks admission uncertain before enqueue, so missing bindings can also be
      // recovered from that state without classifying an absent row as unspent.
      await store.append({ type: "take-job", takeId: take.id, jobId: job.jobId as never }, { at: now() });
      touched = true;
    }
    const status = job?.status === "succeeded" ? "running" : job?.status;
    if (job && take.status !== "succeeded" && (job.status !== "succeeded" || take.status === "needs-reconciliation") && (take.status !== status || take.error !== (job.error ?? undefined))) {
      // Provider success waits for finalization to record media and cost. A resolved queue
      // binding clears the admission marker without downgrading a finalized take.
      await store.append(
        { type: "take-status", takeId: take.id, status: status!, error: job.error },
        { at: now() },
      );
      touched = true;
    }
  }
  return touched;
}

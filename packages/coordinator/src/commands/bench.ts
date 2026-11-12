import { BENCH_DELETE_FILED, benchDeleteRefusal, type BenchSession, type BenchTake, characterAudioRoute, type ClientState, type ClonedVoice, type ConversationId, directionSchemaVersion, engineFloorClause, type Job, type ModelManifest, needsExpressiveDirection, type QueueCommand, rebuildBenchPrefill, type RecipeIdentity, type SessionId, voiceSourceFor } from "@arke-studio/contracts";
import type { AppSettingsFile } from "../app-settings.js";
import { ATTACHABLE_EXTENSIONS, ATTACHABLE_IMAGE_EXTENSIONS } from "../artifacts/filing.js";
import { readCharacterAudioInputs, resolveSubjectCastVoices } from "../audio/reference-inputs.js";
import { applyBenchCharacterImage } from "../bench/character-kit.js";
import { enhancerBrief } from "../bench/enhancer.js";
import { existingBenchSubjectFiling, fileBenchSubjectTake } from "../bench/filing.js";
import { draftLyrics, LYRICS_MAX_CHARS } from "../bench/lyricist.js";
import { recordBenchOutcome } from "../bench/outcome.js";
import { addBenchReference, type BenchRecoveryJobFacts, benchTakeFiles, deleteBenchTake, type OpenedBench, openSubjectBenchSession, planBenchDispatch, planBenchUpscale, recoverBenchSession } from "../bench/service.js";
import { prepareBenchSubject, subjectRoutedBrief, subjectSessionReferenceRouting } from "../bench/subject.js";
import { worldFileReader } from "../bench/world-file-reader.js";
import { describeCoordinatorError } from "../errors/user-message.js";
import { measureDurationSec, type MediaProbe } from "../media/probe.js";
import { openSavedPicture, savedPicture } from "../productions/audiobook-picture-reuse.js";
import { enqueueInputs } from "../queue/acknowledge.js";
import type { EnqueueInput, JobQueue } from "../queue/dispatcher.js";
import { localTakeFreeze } from "../queue/local-sampling.js";
import { randomLocalSeed } from "../queue/local-seed.js";
import type { makeArtDirector } from "../references/art-director.js";
import type { BoundaryFrameMaker } from "../takes/boundary.js";
import { clipFor } from "../voice/library.js";
import { AUDIOBOOK_NOTE_SCHEMA_VERSION } from "../world/commit.js";
import type { WorldStatePrecondition, WorldStore } from "../world/store.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/**
 * The Bench (issue 305): opening a session, plain or for a production's subject, its title,
 * composer and references, dispatching, rerunning and upscaling takes, keeping, accepting,
 * discarding and deleting them, enhancing a brief, drafting lyrics and the composer's presets.
 * A command that answers with its own event — a subject opened, a dispatch's enqueue result, an
 * acceptance, a deletion, a take's files, an enhanced brief or drafted words — checks the world
 * itself, because the page waits on that answer by its request. Closing and the presets are no
 * world's; the rest act on the open world only. The session being opened stays with the
 * coordinator, because World Chat opens the Bench too.
 */
export function benchCommands(ctx: CommandContext, deps: {
  manifest: ModelManifest | undefined;
  mediaProbe: MediaProbe | undefined;
  pickFiles: ((input: { accept: readonly string[] }) => Promise<readonly string[]>) | undefined;
  boundaryFrameMaker: BoundaryFrameMaker | undefined;
  appSettings: () => AppSettingsFile | null;
  jobQueue: () => JobQueue | null;
  app: () => ClientState["app"];
  /** An answer from one roster agent, or null while the writing harness is not running. */
  ask: (options: Parameters<typeof makeArtDirector>[3]) => ((brief: string) => Promise<string | null>) | null;
  log(entry: Record<string, unknown>): void;
  /** The session the Bench is opening, compared by identity so a later open supersedes it. */
  benchOpening(): { worldId: string; sessionId: SessionId | undefined } | null;
  setBenchOpening(opening: { worldId: string; sessionId: SessionId | undefined } | null): void;
  setBench(bench: null): void;
  broadcastSnapshot(): void;
  stillOpen(store: WorldStore): boolean;
  refreshIfStillOpen(store: WorldStore): void;
  benchFor(worldId: string, sessionId: SessionId): Promise<OpenedBench | null>;
  refreshBench(worldId: string, sessionId: SessionId): Promise<void>;
  openBenchWorkspace(store: WorldStore, sessionId?: SessionId, fresh?: boolean, initial?: { mode: "image"; brief: string; aspect: string }): Promise<void>;
  benchSheetName(worldId: string): (sheetId: string) => string;
  benchJobFacts(worldId: string): BenchRecoveryJobFacts[];
  recoverBenchSubjectFilings(store: WorldStore, opened: OpenedBench): Promise<boolean>;
  backfillBenchPosters(store: WorldStore, session: BenchSession): Promise<void>;
  discoverBenchRows(store: WorldStore): Promise<void>;
  fileBenchTake(store: WorldStore, bench: OpenedBench, take: BenchTake, requestId?: string, precondition?: WorldStatePrecondition, production?: string): Promise<{ id: string; file: string }>;
  fileOne(worldId: string, sourcePath: string, opts: { links?: string[]; allowLarge?: boolean; supersedes?: string; production?: string | null }): Promise<string | null>;
  refreshConversationOutcome(store: WorldStore, conversationId: ConversationId): Promise<void>;
  characterSheetJobRunning(worldId: string, sheetId: string): boolean;
  rejectEnqueue(requestId: string, command: QueueCommand, reason: string): void;
  emitEnqueueResult(requestId: string, command: QueueCommand, requestedCount: number, acceptedJobIds: Job["id"][], failures: Array<{ index: number; reason: string }>, notQueued?: boolean): void;
  recipeVersionOf(modelId: string, route?: "reference"): number | undefined;
  adapterRecipeIdentity(model: string, selections: unknown, route?: "reference"): RecipeIdentity;
  freezeLocalIdentity(input: EnqueueInput): EnqueueInput;
  requireSpeechInputsAvailable(inputs: readonly EnqueueInput[]): Promise<void>;
  requireVoiceUploadConfirmation(input: { worldId: string; requestId: string; command: QueueCommand; voiceUploadConfirmedFor?: string; reader?: { store: WorldStore; provider: string; voice: ClonedVoice } }): Promise<boolean>;
  enqueueWithSpeechChecks(input: EnqueueInput, checks: Map<string, Promise<void>>): Promise<Job>;
}) {
  const benchOpen = async (msg: CommandOf<"bench-open">, store: WorldStore): Promise<void> => {
    await deps.openBenchWorkspace(store, msg.sessionId);
  };

  const benchOpenSubject = async (msg: CommandOf<"bench-open-subject">): Promise<void> => {
    const answer = (sessionId: SessionId | null, reason?: string) =>
      ctx.emit({
        at: ctx.nowIso(),
        type: "bench.subject-opened",
        worldId: msg.worldId,
        requestId: msg.requestId,
        sessionId,
        ...(reason !== undefined ? { reason } : {}),
      });
    const store = ctx.openStore();
    if (!store || store.worldId !== msg.worldId) return answer(null, "That world is not open.");
    const opening = { worldId: store.worldId, sessionId: undefined as SessionId | undefined };
    deps.setBenchOpening(opening);
    try {
      const settings = await deps.appSettings()?.load() ?? null;
      const reader = worldFileReader(store.dir);
      const prepared = await prepareBenchSubject(store.getBundle(), {
        productionId: msg.productionId,
        sceneId: msg.sceneId,
        subject: msg.subject,
        ...(msg.mode !== undefined ? { mode: msg.mode } : {}),
        settings,
        manifest: deps.manifest ?? null,
        sources: {
          read: reader.read,
          durationSec: (path) =>
            measureDurationSec(store, path, deps.mediaProbe ?? null, { signal: store.closingSignal }),
        },
      });
      if (!prepared.ok) return answer(null, prepared.reason);
      const sessionId = `sess_${msg.requestId}` as SessionId;
      const opened = await openSubjectBenchSession(
        store.dir,
        sessionId,
        ctx.nowIso(),
        prepared.prefill,
      );
      await recoverBenchSession(opened, deps.benchJobFacts(store.worldId), () => ctx.nowIso());
      await deps.recoverBenchSubjectFilings(store, opened);
      const session = (await opened.store.fold()) ?? opened.session;
      await deps.backfillBenchPosters(store, session);
      if (deps.benchOpening() !== opening || !deps.stillOpen(store) || ctx.stopping()) return answer(sessionId);
      opening.sessionId = sessionId;
      await deps.discoverBenchRows(store);
      if (deps.benchOpening() !== opening || !deps.stillOpen(store) || ctx.stopping()) return answer(sessionId);
      await deps.refreshBench(store.worldId, sessionId);
      answer(sessionId);
    } catch (error) {
      answer(null, describeCoordinatorError(error));
    }
  };

  const benchRebuildSubject = async (msg: CommandOf<"bench-rebuild-subject">): Promise<void> => {
    const answer = (sessionId: SessionId | null, reason?: string) =>
      ctx.emit({
        at: ctx.nowIso(),
        type: "bench.subject-opened",
        worldId: msg.worldId,
        requestId: msg.requestId,
        sessionId,
        ...(reason !== undefined ? { reason } : {}),
      });
    const store = ctx.openStore();
    if (!store || store.worldId !== msg.worldId) {
      answer(null, "That subject session is no longer available.");
      return;
    }
    try {
      const bench = await deps.benchFor(msg.worldId, msg.sessionId);
      if (!bench || bench.session.subject === undefined) {
        answer(null, "That subject session is no longer available.");
        return;
      }
      const subject = bench.session.subject;
      if (subject.kind === "production") { answer(null, "Production audio uses the music composer; it has no shot prefill to rebuild."); return; }
      const settings = await deps.appSettings()?.load() ?? null;
      const reader = worldFileReader(store.dir);
      const prepared = await prepareBenchSubject(store.getBundle(), {
        productionId: subject.productionId,
        sceneId: subject.sceneId,
        subject:
          subject.kind === "shot"
            ? { kind: "shot", shotId: subject.shotId }
            : { kind: "board", memberShotIds: subject.members.map((member) => member.shotId) },
        // A shot session the Stage opened for the clip rebuilds as the clip, playblast and beats
        // included; without this a Rebuild would quietly hand it back an image composer.
        ...(subject.kind === "shot" && bench.session.composer.mode === "video" ? { mode: "video" as const } : {}),
        ...(bench.session.composer.params.kind === "video" && bench.session.composer.params.follow !== undefined
          ? { follow: bench.session.composer.params.follow } : {}),
        settings,
        manifest: deps.manifest ?? null,
        sources: {
          read: reader.read,
          durationSec: (path) =>
            measureDurationSec(store, path, deps.mediaProbe ?? null, { signal: store.closingSignal }),
        },
      });
      if (!prepared.ok) return answer(null, prepared.reason);
      await bench.store.append(
        session => rebuildBenchPrefill(session, { type: "subject-prefill-set", ...prepared.prefill }),
        { at: ctx.nowIso(), requestId: msg.requestId },
      );
      await deps.refreshBench(msg.worldId, msg.sessionId);
      answer(msg.sessionId);
    } catch (error) {
      answer(null, describeCoordinatorError(error));
    }
  };

  const benchNewSession = async (msg: CommandOf<"bench-new-session">, store: WorldStore): Promise<void> => {
    if (msg.picture !== undefined) {
      try {
        const saved = await savedPicture(store, msg.picture.source, msg.picture.prompt);
        const opened = await openSavedPicture(store, saved, () => ctx.nowIso());
        await deps.openBenchWorkspace(store, opened.session.id);
      } catch (error) {
        ctx.emit({ type: "command.failed", at: ctx.nowIso(), command: msg.kind, requestId: null, reason: describeCoordinatorError(error) });
      }
    } else {
      // Make cover (238c, SPEC-060 R-5): a music cover is square, so its session is made at
      // 1:1 with the album's words before the Bench shows it, and the picture is made that
      // shape rather than cut to it.
      await deps.openBenchWorkspace(store, undefined, true, msg.image === undefined ? undefined : { mode: "image", brief: msg.image.brief, aspect: msg.image.aspect });
    }
  };

  const benchClose = (): void => {
    deps.setBenchOpening(null);
    deps.setBench(null);
    deps.broadcastSnapshot();
  };

  const benchSetTitle = async (msg: CommandOf<"bench-set-title">): Promise<void> => {
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    if (!bench) return;
    await bench.store.append(
      { type: "title-set", title: msg.title },
      { at: ctx.nowIso(), requestId: msg.requestId },
    );
    await deps.refreshBench(msg.worldId, msg.sessionId);
  };

  const benchCompose = async (msg: CommandOf<"bench-compose">, store: WorldStore): Promise<void> => {
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    if (!bench) return;
    const model = deps.manifest?.models.find(
      (candidate) => candidate.provider === msg.provider && candidate.id === msg.model,
    ) ?? null;
    const subjectRouting = subjectSessionReferenceRouting(bench.session, model);
    // The brief's References and follow lines follow the route (issue 1817).
    const brief = subjectRouting === undefined ? msg.brief : subjectRoutedBrief(bench.session, subjectRouting.activeTokens, { brief: msg.brief, params: msg.params }, deps.benchSheetName(msg.worldId));
    // A line's direction (design turn 181) is a field the Bench session log of a build
    // before it cannot parse, and that build drops the line and would number its next event
    // over it: the world is raised first, as the audiobook's direction raises it.
    if (msg.params.kind === "voice" && msg.params.direction !== undefined) {
      await store.ensureSchemaVersion(needsExpressiveDirection(msg.params.direction) ? directionSchemaVersion(msg.params.direction) : AUDIOBOOK_NOTE_SCHEMA_VERSION, "voice-direction");
    }
    await bench.store.append(
      {
        type: "composer-set",
        mode: msg.mode,
        provider: msg.provider,
        model: msg.model,
        params: msg.params,
        brief,
        ...(subjectRouting !== undefined ? { subjectRouting } : {}),
      },
      { at: ctx.nowIso(), requestId: msg.requestId },
    );
    await deps.refreshBench(msg.worldId, msg.sessionId);
  };

  const benchAddReference = async (msg: CommandOf<"bench-add-reference">, store: WorldStore): Promise<void> => {
    const manifest = deps.manifest ?? null;
    // In order, re-folding between picks so each allocation and admission sees the pick
    // before it — the same shape bench-upload-references attaches with. The batch arrives
    // as ONE message because token numbering lives outside the append queue: two handlers
    // folding the same log would hand two sources one token, and an append-only log has
    // no way to take that back.
    for (const [index, pick] of msg.picks.entries()) {
      const bench = await deps.benchFor(msg.worldId, msg.sessionId);
      if (!bench) break;
      const model =
        manifest?.models.find(
          (m) => m.id === bench.session.composer.model && m.provider === bench.session.composer.provider,
        ) ?? null;
      const outcome = await addBenchReference(bench, store.getBundle(), model, {
        source: pick.source,
        replace: pick.replace,
        lane: msg.lane,
        worldFile: worldFileReader(store.dir),
        requestId: `${msg.requestId}/${index}`,
        at: ctx.nowIso(),
      });
      // The tile predicted this refusal with the same shared functions; landing here means
      // a racing client. The refreshed workspace shows what held — recorded, not silent.
      if (outcome.outcome === "refused") {
        deps.log({
          kind: "bench.reference-refused",
          worldId: msg.worldId,
          reason: outcome.reason,
        });
      }
    }
    await deps.refreshBench(msg.worldId, msg.sessionId);
  };

  const benchRemoveReference = async (msg: CommandOf<"bench-remove-reference">): Promise<void> => {
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    if (!bench) return;
    const lane = msg.lane ?? "reference";
    const held =
      lane === "keyframe"
        ? bench.session.composer.keyframeTokens.includes(msg.token)
        : bench.session.composer.activeTokens.includes(msg.token);
    if (held) {
      await bench.store.append(
        { type: "reference-removed", token: msg.token, ...(lane === "keyframe" ? { lane } : {}) },
        { at: ctx.nowIso(), requestId: msg.requestId },
      );
    }
    await deps.refreshBench(msg.worldId, msg.sessionId);
  };

  const benchUploadReferences = async (msg: CommandOf<"bench-upload-references">, store: WorldStore): Promise<void> => {
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    const pick = deps.pickFiles;
    if (!bench || !pick) return;
    const lane = msg.lane ?? "reference";
    const paths = await pick({
      accept: lane === "keyframe" ? [...ATTACHABLE_IMAGE_EXTENSIONS] : [...ATTACHABLE_EXTENSIONS],
    }).catch(() => [] as readonly string[]);
    const artifactIds: Array<string | null> = [];
    for (const sourcePath of paths) {
      artifactIds.push(
        await deps.fileOne(msg.worldId, sourcePath, { allowLarge: msg.allowLarge ?? false }),
      );
    }
    // The answer carries ordered ids whatever happens next: filing survives a cancelled
    // picker, and attaching is a separate act the budget may refuse per item.
    ctx.emit({
      at: ctx.nowIso(),
      type: "artifact.filed-batch",
      worldId: msg.worldId,
      requestId: msg.requestId,
      artifactIds,
    });
    const manifest = deps.manifest ?? null;
    for (const [index, artifactId] of artifactIds.entries()) {
      if (artifactId === null) continue;
      const fresh = await deps.benchFor(msg.worldId, msg.sessionId);
      if (!fresh) break;
      const model =
        manifest?.models.find(
          (m) => m.id === fresh.session.composer.model && m.provider === fresh.session.composer.provider,
        ) ?? null;
      const outcome = await addBenchReference(fresh, store.getBundle(), model, {
        source: { source: "artifact", artifactId },
        lane: msg.lane,
        requestId: `${msg.requestId}/attach/${index}`,
        at: ctx.nowIso(),
      });
      // Filed but not attached is a real outcome — recorded, never swallowed.
      if (outcome.outcome === "refused") {
        deps.log({
          kind: "bench.reference-refused",
          worldId: msg.worldId,
          reason: outcome.reason,
        });
      }
    }
    await deps.refreshBench(msg.worldId, msg.sessionId);
  };

  const benchDispatch = async (msg: CommandOf<"bench-dispatch" | "bench-rerun">): Promise<void> => {
    const store = ctx.openStore();
    let bench = await deps.benchFor(msg.worldId, msg.sessionId);
    if (!store || !bench) {
      deps.rejectEnqueue(
        msg.requestId,
        msg.kind,
        "The bench is unavailable. Reopen the world and try again.",
      );
      return;
    }
    if (msg.kind === "bench-dispatch") {
      const currentSession = bench.session;
      const model = deps.manifest?.models.find(
        (candidate) =>
          candidate.provider === msg.composer.provider && candidate.id === msg.composer.model,
      ) ?? null;
      const subjectRouting = subjectSessionReferenceRouting(currentSession, model);
      const brief = subjectRouting === undefined ? msg.composer.brief : subjectRoutedBrief(currentSession, subjectRouting.activeTokens, msg.composer, deps.benchSheetName(msg.worldId));
      const composer = {
        ...msg.composer,
        brief,
        activeTokens: subjectRouting?.activeTokens ?? currentSession.composer.activeTokens,
        keyframeTokens: subjectRouting?.keyframeTokens ?? currentSession.composer.keyframeTokens,
      };
      try {
        await bench.store.append(
          {
            type: "composer-set",
            ...msg.composer,
            brief,
            ...(subjectRouting !== undefined ? { subjectRouting } : {}),
          },
          { at: ctx.nowIso(), requestId: `${msg.requestId}/compose` },
        );
        // Plan from the exact event just persisted. A later handler may append another draft
        // before this command reserves, but it cannot change what this press authorizes.
        bench = { store: bench.store, session: { ...currentSession, composer } };
      } catch (error) {
        deps.rejectEnqueue(
          msg.requestId,
          msg.kind,
          describeCoordinatorError(error),
        );
        return;
      }
    }
    const fromTake =
      msg.kind === "bench-rerun" ? bench.session.takes.find((t) => t.id === msg.takeId) : undefined;
    if (msg.kind === "bench-rerun" && !fromTake) {
      deps.rejectEnqueue(msg.requestId, msg.kind, "That take is no longer in this session.");
      return;
    }
    // The subject's scene cast rides here as it does on the plan card (SPEC-044 R-29) — for
    // a video dispatch that wants audio; a still, a rerun or a disabled box resolves nothing,
    // because resolving acknowledges an upload. The record-level clauses are the Bench's own
    // to show; what only the bytes or the ledger refused is refused here, in the same words,
    // with the Bench's checkbox as the way past it.
    const benchParams = bench.session.composer.params;
    // A route that takes no audio takes no read (SPEC-044 R-31; codex round 4): nothing is
    // resolved, so a read that could not clear refuses nothing, as the planned-scene arm holds.
    const benchModel = deps.manifest?.models.find((candidate) => candidate.id === bench.session.composer.model);
    const benchRoute = benchModel === undefined ? null : characterAudioRoute(benchModel);
    const castVoices = bench.session.subject && bench.session.subject.kind !== "production" && benchParams.kind === "video" && !benchParams.audioReferencesDisabled && fromTake === undefined && benchRoute !== null
      ? await resolveSubjectCastVoices(store, bench.session.subject, msg.requestId, benchRoute.local === true)
      : { references: [], notSent: [], refused: [] };
    if (castVoices.refused.length > 0) {
      deps.rejectEnqueue(msg.requestId, msg.kind, castVoices.refused.map((entry) => `${entry.name}: voice not sent · ${entry.reason}`).join(" · "));
      return;
    }
    const plan = planBenchDispatch(bench.session, store.getBundle(), deps.manifest ?? null, {
      speechAuthorisation: { confirmedMicroUsd: msg.kind === "bench-dispatch" ? msg.confirmedSpeechMicroUsd : undefined },
      worldId: msg.worldId,
      requestId: msg.requestId,
      performanceReferences: castVoices.references,
      at: ctx.nowIso(),
      fromTake,
      // A bench take of a local recipe records which version made it (R-13), and the
      // filed-artifact sidecar inherits it from this same snapshot.
      recipeVersionOf: (modelId, route) => deps.recipeVersionOf(modelId, route),
      adapterRecipeFor: (modelId, selections, route) => deps.adapterRecipeIdentity(modelId, selections, route),
      localFreeze: (modelId, rerunOf) =>
        localTakeFreeze(modelId, rerunOf, (recipeId) => deps.app().localSampling?.choices[recipeId], randomLocalSeed),
    });
    if (!plan.ok) {
      deps.rejectEnqueue(msg.requestId, msg.kind, plan.reason);
      return;
    }
    try { await deps.requireSpeechInputsAvailable(plan.inputs); }
    catch (error) {
      deps.rejectEnqueue(msg.requestId, msg.kind, describeCoordinatorError(error));
      return;
    }
    // Each cloned read asks about its hosted vendor (SPEC-046 R-16) before it is queued.
    for (const planned of plan.inputs) {
      if (planned.voiceReference !== true) continue;
      const voiceId = typeof planned.params["voiceId"] === "string" ? planned.params["voiceId"] : "";
      const source = voiceSourceFor(store.getBundle().clonedVoices, planned.provider, planned.model, voiceId);
      if (
        await deps.requireVoiceUploadConfirmation({
          worldId: msg.worldId,
          requestId: msg.requestId,
          command: msg.kind,
          ...(msg.voiceUploadConfirmedFor !== undefined
            ? { voiceUploadConfirmedFor: msg.voiceUploadConfirmedFor }
            : {}),
          ...(source.kind === "cloned" ? { reader: { store, provider: planned.provider, voice: source.voice } } : {}),
        })
      )
        return;
    }
    const voiceUploadConfirmedFor =
      "voiceUploadConfirmedFor" in msg ? msg.voiceUploadConfirmedFor : undefined;
    for (const input of plan.inputs) {
      if (input.voiceReference === true && voiceUploadConfirmedFor !== undefined) {
        input.voiceUploadConfirmedFor = voiceUploadConfirmedFor;
      }
    }
    for (const input of plan.inputs) {
      if (input.voiceReference !== true) continue;
      const voiceId = input.params["voiceId"];
      const source =
        typeof voiceId === "string"
          ? voiceSourceFor(store.getBundle().clonedVoices, input.provider, input.model, voiceId)
          : { kind: "missing-clone" as const };
      if (source.kind !== "cloned" || !(await clipFor(store, source.voice))) {
        deps.rejectEnqueue(
          msg.requestId,
          msg.kind,
          "That voice's recording is missing or unsafe — re-clone it, or choose another voice.",
        );
        return;
      }
    }
    // The reservation is fsynced BEFORE any job exists — the record that authorizes spend.
    // A resent command finds its requestId already in the log and must not enqueue twice.
    const reservation = await bench.store.append(
      { type: "takes-reserved", takes: plan.reserved },
      { at: ctx.nowIso(), requestId: msg.requestId },
    );
    if (reservation.deduplicated) {
      deps.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
      await deps.refreshBench(msg.worldId, msg.sessionId);
      return;
    }
    const speechChecks = new Map<string, Promise<void>>();
    const outcome = await enqueueInputs(plan.inputs, async (input) => {
      if (!deps.jobQueue()) throw new Error("the job queue is unavailable");
      if (input.params.audioReferences !== undefined) await readCharacterAudioInputs(store, input, true);
      return deps.enqueueWithSpeechChecks(input, speechChecks);
    });
    // Jobs join their reserved takes in order: a failure keeps its number and says why.
    const failed = new Map(outcome.failures.map((f) => [f.index, f.reason]));
    let accepted = 0;
    for (const [index, reserved] of plan.reserved.entries()) {
      const reason = failed.get(index);
      if (reason !== undefined) {
        await bench.store.append(
          { type: "take-status", takeId: reserved.id, status: "failed", error: reason },
          { at: ctx.nowIso() },
        );
        continue;
      }
      const jobId = outcome.acceptedJobIds[accepted++];
      if (jobId !== undefined) {
        await bench.store.append({ type: "take-job", takeId: reserved.id, jobId }, { at: ctx.nowIso() });
      }
    }
    deps.emitEnqueueResult(
      msg.requestId,
      msg.kind,
      outcome.requestedCount,
      outcome.acceptedJobIds,
      outcome.failures,
    );
    await deps.refreshBench(msg.worldId, msg.sessionId);
  };

  const benchUpscale = async (msg: CommandOf<"bench-upscale">): Promise<void> => {
    // An upscale reserves a take number like any dispatch, so it holds the same per-session
    // key: two presses racing one session cannot both claim the next number (design 178).
    const store = ctx.openStore();
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    if (!store || !bench) {
      deps.rejectEnqueue(msg.requestId, msg.kind, "The bench is unavailable. Reopen the world and try again.");
      return;
    }
    const upscaler = deps.manifest?.models.find((model) => model.upscale !== undefined) ?? null;
    // The engine's answer first, in the clause the tile shows: an engine below the floor is
    // refused as `Needs ComfyUI 0.38`, never with a sentence the screen does not use.
    if (upscaler !== null && deps.app().models.disabled.includes(upscaler.id)) {
      deps.rejectEnqueue(msg.requestId, msg.kind, "Turned off in AI models");
      return;
    }
    const readiness = upscaler === null ? undefined : deps.app().comfyui?.recipes.find((recipe) => recipe.recipeId === upscaler.id);
    if (upscaler !== null && readiness !== undefined && readiness.state === "disabled") {
      deps.rejectEnqueue(
        msg.requestId,
        msg.kind,
        readiness.reasonKind === "engine" && upscaler.upscale !== undefined
          ? engineFloorClause(upscaler.upscale.minEngineVersion)
          : (readiness.reason ?? "The upscaler is not ready on this machine"),
      );
      return;
    }
    const freeze = upscaler === null ? {} : localTakeFreeze(upscaler.id, undefined, () => undefined, randomLocalSeed);
    const plan = planBenchUpscale(bench.session, deps.manifest ?? null, {
      worldId: msg.worldId,
      requestId: msg.requestId,
      takeId: msg.takeId,
      at: ctx.nowIso(),
      recipeVersionOf: (modelId) => deps.recipeVersionOf(modelId),
      seed: freeze.seed,
    });
    if (!plan.ok) {
      deps.rejectEnqueue(msg.requestId, msg.kind, plan.reason);
      return;
    }
    const reservation = await bench.store.append(
      { type: "takes-reserved", takes: plan.reserved },
      { at: ctx.nowIso(), requestId: msg.requestId },
    );
    if (reservation.deduplicated) {
      deps.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
      await deps.refreshBench(msg.worldId, msg.sessionId);
      return;
    }
    const outcome = await enqueueInputs(plan.inputs, async (input) => {
      const queue = deps.jobQueue();
      if (!queue) throw new Error("the job queue is unavailable");
      return queue.enqueue(deps.freezeLocalIdentity(input));
    });
    const reserved = plan.reserved[0]!;
    const failure = outcome.failures[0];
    if (failure !== undefined) {
      await bench.store.append(
        { type: "take-status", takeId: reserved.id, status: "failed", error: failure.reason },
        { at: ctx.nowIso() },
      );
    } else if (outcome.acceptedJobIds[0] !== undefined) {
      await bench.store.append({ type: "take-job", takeId: reserved.id, jobId: outcome.acceptedJobIds[0] }, { at: ctx.nowIso() });
    }
    deps.emitEnqueueResult(msg.requestId, msg.kind, outcome.requestedCount, outcome.acceptedJobIds, outcome.failures);
    await deps.refreshBench(msg.worldId, msg.sessionId);
  };

  const benchKeep = async (msg: CommandOf<"bench-keep">, store: WorldStore): Promise<void> => {
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    if (!bench) return;
    if (bench.session.subject !== undefined && bench.session.subject.kind !== "production") return;
    const take = bench.session.takes.find((t) => t.id === msg.takeId);
    if (!take || !take.media) return;
    // Idempotent by take id: a filed take answers with the artifact it already made.
    if (take.disposition === "filed" && take.keptArtifactId !== undefined) {
      await deps.refreshBench(msg.worldId, msg.sessionId);
      return;
    }
    try {
      await deps.fileBenchTake(store, bench, take, msg.requestId);
    } catch (err) {
      deps.log({
        kind: "bench.keep-failed",
        worldId: msg.worldId,
        takeId: take.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Keeping changed the world's artifacts, so the whole snapshot refreshes, not just the bench.
    await ctx.refreshWorldSnapshot(msg.worldId);
    await deps.refreshBench(msg.worldId, msg.sessionId);
  };

  const benchUseReference = async (msg: CommandOf<"bench-use-reference">): Promise<void> => {
    const answer = (accepted: boolean, reason?: string) => ctx.emit({ at: ctx.nowIso(), type: "bench.reference-used",
      worldId: msg.worldId, sessionId: msg.sessionId, takeId: msg.takeId, requestId: msg.requestId, accepted, ...(reason ? { reason } : {}) });
    const store = ctx.openStore();
    if (!store || store.worldId !== msg.worldId) { answer(false, "That world is no longer open."); return; }
    try {
      const bench = await deps.benchFor(msg.worldId, msg.sessionId);
      const take = bench?.session.takes.find(take => take.id === msg.takeId);
      if (!bench || !take) throw new Error("That Bench image is unavailable.");
      await applyBenchCharacterImage(store, bench.session, take, msg.sheetId, msg.image, msg.requestId, () =>
        !deps.stillOpen(store) || ctx.stopping() ? "That world is no longer open." :
        msg.image === "character-sheet" && deps.characterSheetJobRunning(msg.worldId, msg.sheetId)
          ? "A character sheet is still being generated. Wait for it or settle it in Activity." : null);
      deps.refreshIfStillOpen(store);
      answer(true);
    } catch (error) { answer(false, describeCoordinatorError(error)); }
  };

  const benchAccept = async (msg: CommandOf<"bench-accept">): Promise<void> => {
    const answer = (accepted: boolean, reason?: string) =>
      ctx.emit({
        at: ctx.nowIso(),
        type: "bench.subject-accepted",
        worldId: msg.worldId,
        sessionId: msg.sessionId,
        takeId: msg.takeId,
        requestId: msg.requestId,
        accepted,
        ...(reason !== undefined ? { reason } : {}),
      });
    const store = ctx.openStore();
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    if (!store || !bench || bench.session.subject === undefined) {
      answer(false, "That subject session is no longer available.");
      return;
    }
    const take = bench.session.takes.find((candidate) => candidate.id === msg.takeId);
    if (!take || take.disposition === "discarded") {
      answer(false, "That take is no longer available to accept.");
      return;
    }
    try {
      const filed = await fileBenchSubjectTake(
        store,
        bench.session,
        take,
        deps.boundaryFrameMaker !== undefined ? { toPng: deps.boundaryFrameMaker } : {},
      );
      if (filed.boundaryFrame !== undefined && !filed.boundaryFrame.ok) {
        deps.log({
          kind: "boundary-frame.unavailable",
          reason: filed.boundaryFrame.reason,
          detail: { takeId: filed.productionTakeIds.at(-1) },
        });
      }
      await bench.store.append(
        {
          type: "take-subject-filed",
          takeId: take.id,
          productionTakeIds: filed.productionTakeIds as never,
          ...(filed.artifactId !== undefined ? { artifactId: filed.artifactId as never } : {}),
        },
        { at: ctx.nowIso(), requestId: msg.requestId },
      );
      // Production and Bench state are now truthful even if narration has a separate I/O
      // failure. Opening the session retries this idempotent append from the filed ids.
      const conversationId = await recordBenchOutcome(store, bench.session, take, filed).catch((error) => {
        deps.log({
          kind: "bench.outcome-failed",
          worldId: msg.worldId,
          takeId: msg.takeId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (conversationId !== null) await deps.refreshConversationOutcome(store, conversationId);
      await ctx.refreshWorldSnapshot(msg.worldId);
      await deps.refreshBench(msg.worldId, msg.sessionId);
      answer(true);
    } catch (error) {
      // appLog keeps the raw diagnostic; `answer`'s refusal gets the translated sentence —
      // same split as the dispatch-refused handler above.
      deps.log({
        kind: "bench.accept-failed",
        worldId: msg.worldId,
        takeId: msg.takeId,
        error: error instanceof Error ? error.message : String(error),
      });
      const filed = existingBenchSubjectFiling(store, bench.session, take);
      if (filed !== null) {
        // The production commit is the acceptance boundary. Repair the secondary session
        // record when possible, but never report failure after the requested selection landed.
        await bench.store.append(
          {
            type: "take-subject-filed",
            takeId: take.id,
            productionTakeIds: filed.productionTakeIds as never,
            ...(filed.artifactId !== undefined ? { artifactId: filed.artifactId as never } : {}),
          },
          { at: ctx.nowIso(), requestId: msg.requestId },
        ).catch(() => {});
        const conversationId = await recordBenchOutcome(store, bench.session, take, filed).catch(() => null);
        if (conversationId !== null) await deps.refreshConversationOutcome(store, conversationId);
        await ctx.refreshWorldSnapshot(msg.worldId);
        await deps.refreshBench(msg.worldId, msg.sessionId);
        answer(true);
        return;
      }
      await ctx.refreshWorldSnapshot(msg.worldId);
      await deps.refreshBench(msg.worldId, msg.sessionId);
      answer(false, describeCoordinatorError(error));
    }
  };

  const benchDiscard = async (msg: CommandOf<"bench-discard">, store: WorldStore): Promise<void> => {
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    if (!bench) return;
    const take = bench.session.takes.find((candidate) => candidate.id === msg.takeId);
    const filed = take ? existingBenchSubjectFiling(store, bench.session, take) : null;
    if (take?.disposition === "open" && filed !== null) {
      await bench.store.append(
        {
          type: "take-subject-filed",
          takeId: take.id,
          productionTakeIds: filed.productionTakeIds as never,
          ...(filed.artifactId !== undefined ? { artifactId: filed.artifactId as never } : {}),
        },
        { at: ctx.nowIso(), requestId: `subject-filing-recovered:${bench.session.id}/${take.id}` },
      );
      await recordBenchOutcome(store, bench.session, take, filed).catch(() => {});
    } else if (take?.disposition === "open") {
      await bench.store.append(
        { type: "take-discarded", takeId: msg.takeId },
        { at: ctx.nowIso(), requestId: msg.requestId },
      );
    }
    await deps.refreshBench(msg.worldId, msg.sessionId);
  };

  const takeFiles = async (msg: CommandOf<"bench-take-files">): Promise<void> => {
    const answer = (files: Array<{ name: string; bytes: number }>, reason?: string) =>
      ctx.emit({
        at: ctx.nowIso(),
        type: "bench.take-files",
        worldId: msg.worldId,
        sessionId: msg.sessionId,
        takeId: msg.takeId,
        requestId: msg.requestId,
        files,
        ...(reason !== undefined ? { reason } : {}),
      });
    const store = ctx.openStore();
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    const take = bench?.session.takes.find((candidate) => candidate.id === msg.takeId);
    if (!store || !bench || !take) {
      answer([], "That take is no longer in this session");
      return;
    }
    const refusal = benchDeleteRefusal(take);
    if (refusal !== null) {
      answer([], refusal.reason);
      return;
    }
    // Always answered: a confirm left waiting holds Delete disabled until another take is chosen.
    try {
      answer(await benchTakeFiles(store.dir, bench.session.id, take.id, take.media?.file));
    } catch (error) {
      answer([], describeCoordinatorError(error));
    }
  };

  const benchDelete = async (msg: CommandOf<"bench-delete">): Promise<void> => {
    const answer = (deleted: boolean, reason?: string) =>
      ctx.emit({
        at: ctx.nowIso(),
        type: "bench.take-deleted",
        worldId: msg.worldId,
        sessionId: msg.sessionId,
        takeId: msg.takeId,
        requestId: msg.requestId,
        deleted,
        ...(reason !== undefined ? { reason } : {}),
      });
    const store = ctx.openStore();
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    if (!store || !bench) {
      answer(false, "That session is no longer available");
      return;
    }
    const take = bench.session.takes.find((candidate) => candidate.id === msg.takeId);
    // A subject take whose production filing landed but whose session record did not is
    // filed, whatever the log says yet; the record is repaired first, exactly as Not this
    // does, and the delete is then refused like any filed take.
    const filed = take?.disposition === "open" ? existingBenchSubjectFiling(store, bench.session, take) : null;
    if (take !== undefined && filed !== null) {
      await bench.store.append(
        {
          type: "take-subject-filed",
          takeId: take.id,
          productionTakeIds: filed.productionTakeIds as never,
          ...(filed.artifactId !== undefined ? { artifactId: filed.artifactId as never } : {}),
        },
        { at: ctx.nowIso(), requestId: `subject-filing-recovered:${bench.session.id}/${take.id}` },
      );
      await recordBenchOutcome(store, bench.session, take, filed).catch(() => {});
      await deps.refreshBench(msg.worldId, msg.sessionId);
      answer(false, BENCH_DELETE_FILED);
      return;
    }
    try {
      const outcome = await deleteBenchTake(bench, store.dir, msg.takeId, { requestId: msg.requestId, at: ctx.nowIso() });
      deps.log({
        kind: outcome.deleted ? "bench.take-deleted" : "bench.take-delete-refused",
        worldId: msg.worldId,
        takeId: msg.takeId,
        ...(outcome.deleted ? {} : { reason: outcome.reason }),
      });
      await deps.refreshBench(msg.worldId, msg.sessionId);
      answer(outcome.deleted, outcome.deleted ? undefined : outcome.reason);
    } catch (error) {
      deps.log({
        kind: "bench.take-delete-failed",
        worldId: msg.worldId,
        takeId: msg.takeId,
        error: error instanceof Error ? error.message : String(error),
      });
      await deps.refreshBench(msg.worldId, msg.sessionId);
      answer(false, describeCoordinatorError(error));
    }
  };

  const benchClearView = async (msg: CommandOf<"bench-clear-view">): Promise<void> => {
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    if (!bench) return;
    await bench.store.append(
      { type: "take-cleared", takeId: msg.takeId },
      { at: ctx.nowIso(), requestId: msg.requestId },
    );
    await deps.refreshBench(msg.worldId, msg.sessionId);
  };

  const benchEnhanceBrief = async (msg: CommandOf<"bench-enhance-brief">): Promise<void> => {
    // The same art-director machinery the world image trusts (references/art-director.ts):
    // one harness turn, JSON or nothing — and the answer is an EVENT, because the words
    // land in the composer only by the author's hand.
    const answer = (prompt: string | null, reason?: string) =>
      ctx.emit({
        at: ctx.nowIso(),
        type: "bench.brief-enhanced",
        worldId: msg.worldId,
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        prompt,
        ...(reason !== undefined ? { reason } : {}),
      });
    const store = ctx.openStore();
    if (!store || store.worldId !== msg.worldId) return answer(null, "that world is not open");
    const model =
      deps.manifest?.models.find((m) => m.id === msg.model && m.provider === msg.provider) ?? null;
    if (!model) return answer(null, "that model is no longer offered");
    const director = deps.ask({ agent: "prompt-enhancer", maxChars: model.limits.maxPromptChars ?? 4000 });
    if (!director) return answer(null, "the writing harness is not running");
    const prompt = await director(enhancerBrief(store.getBundle(), model, msg.brief)).catch(() => null);
    deps.log({
      kind: prompt ? "bench.brief-enhanced" : "bench.brief-enhance-unavailable",
      worldId: msg.worldId,
    });
    return answer(prompt, prompt === null ? "the art director had no answer this time" : undefined);
  };

  const benchDraftLyrics = async (msg: CommandOf<"bench-draft-lyrics">): Promise<void> => {
    // The same one-turn harness call the enhancer makes, and the same discipline: the
    // answer is an EVENT, because a draft reaches the song only when the author presses
    // Use these words (design turn 73). Nothing here writes into the composer.
    const answer = (lyrics: string | null, reason?: string) =>
      ctx.emit({
        at: ctx.nowIso(),
        type: "bench.lyrics-drafted",
        worldId: msg.worldId,
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        lyrics,
        ...(reason !== undefined ? { reason } : {}),
      });
    const store = ctx.openStore();
    if (!store || store.worldId !== msg.worldId) return answer(null, "that world is not open");
    const lyricist = deps.ask({ agent: "lyricist", answerKey: "lyrics", maxChars: LYRICS_MAX_CHARS });
    if (!lyricist) return answer(null, "the writing harness is not running");
    const drafted = await draftLyrics(lyricist,
      {
        description: msg.description,
        ...(msg.style !== undefined ? { style: msg.style } : {}),
      },
    );
    deps.log({
      kind: drafted.lyrics ? "bench.lyrics-drafted" : "bench.lyrics-unavailable",
      worldId: msg.worldId,
      ...(drafted.reason ? { reason: drafted.reason } : {}),
    });
    return answer(drafted.lyrics, drafted.reason);
  };

  const benchPresetSave = async (msg: CommandOf<"bench-preset-save">): Promise<void> => {
    const appSettings = deps.appSettings();
    if (!appSettings || !deps.manifest) return;
    const outcome = await appSettings.savePreset(
      {
        name: msg.name,
        mode: msg.mode,
        provider: msg.provider,
        model: msg.model,
        params: msg.params,
        ...(msg.brief !== undefined ? { brief: msg.brief } : {}),
      },
      deps.manifest,
      ctx.nowIso(),
    );
    // The composer can only offer models the manifest carries, so landing here means a
    // racing manifest change — recorded, not silent.
    if (!outcome.ok) {
      deps.log({ kind: "bench.preset-refused", reason: outcome.reason });
      return;
    }
    ctx.emit({ at: ctx.nowIso(), type: "presets.changed", presets: outcome.settings.presets });
  };

  const benchPresetDelete = async (msg: CommandOf<"bench-preset-delete">): Promise<void> => {
    const appSettings = deps.appSettings();
    if (!appSettings) return;
    const settings = await appSettings.deletePreset(msg.presetId);
    ctx.emit({ at: ctx.nowIso(), type: "presets.changed", presets: settings.presets });
  };

  const benchSelectTake = async (msg: CommandOf<"bench-select-take">): Promise<void> => {
    const bench = await deps.benchFor(msg.worldId, msg.sessionId);
    if (!bench) return;
    if (bench.session.takes.some((t) => t.id === msg.takeId)) {
      await bench.store.append(
        { type: "take-selected", takeId: msg.takeId },
        { at: ctx.nowIso(), requestId: msg.requestId },
      );
    }
    await deps.refreshBench(msg.worldId, msg.sessionId);
  };

  return {
    "bench-open": { scope: "open-world", handle: benchOpen },
    "bench-open-subject": { scope: "any-world", handle: benchOpenSubject },
    "bench-rebuild-subject": { scope: "any-world", handle: benchRebuildSubject },
    "bench-new-session": { scope: "open-world", handle: benchNewSession },
    "bench-close": { scope: "none", handle: benchClose },
    "bench-set-title": { scope: "open-world", handle: benchSetTitle },
    "bench-compose": { scope: "open-world", handle: benchCompose },
    "bench-add-reference": { scope: "open-world", handle: benchAddReference },
    "bench-remove-reference": { scope: "open-world", handle: benchRemoveReference },
    "bench-upload-references": { scope: "open-world", handle: benchUploadReferences },
    "bench-dispatch": { scope: "any-world", handle: benchDispatch },
    "bench-rerun": { scope: "any-world", handle: benchDispatch },
    "bench-upscale": { scope: "any-world", handle: benchUpscale },
    "bench-keep": { scope: "open-world", handle: benchKeep },
    "bench-use-reference": { scope: "any-world", handle: benchUseReference },
    "bench-accept": { scope: "any-world", handle: benchAccept },
    "bench-discard": { scope: "open-world", handle: benchDiscard },
    "bench-take-files": { scope: "any-world", handle: takeFiles },
    "bench-delete": { scope: "any-world", handle: benchDelete },
    "bench-clear-view": { scope: "open-world", handle: benchClearView },
    "bench-enhance-brief": { scope: "any-world", handle: benchEnhanceBrief },
    "bench-draft-lyrics": { scope: "any-world", handle: benchDraftLyrics },
    "bench-preset-save": { scope: "none", handle: benchPresetSave },
    "bench-preset-delete": { scope: "none", handle: benchPresetDelete },
    "bench-select-take": { scope: "open-world", handle: benchSelectTake },
  } satisfies CommandModule;
}

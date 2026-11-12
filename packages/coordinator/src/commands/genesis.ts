import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ClientState, ModelInfo, ModelManifest, QueueCommand } from "@arke-studio/contracts";
import type { AppSettingsFile } from "../app-settings.js";
import { ATTACHABLE_EXTENSIONS } from "../artifacts/filing.js";
import { describeCoordinatorError } from "../errors/user-message.js";
import { foldBlueprint } from "../harness/blueprint.js";
import type { GenesisService } from "../harness/genesis.js";
import { genesisControlDir, loadGenesisConversation } from "../harness/genesis-conversation.js";
import { decideGenesisImage, genesisImageRequest, reviewGenesisImages } from "../harness/genesis-images.js";
import { recoverGenesisImports, resolveGenesisImport, reviewGenesisImports } from "../harness/genesis-imports.js";
import { leaveGenesisFinding, reviewGenesisReadiness } from "../harness/genesis-readiness.js";
import { decideGenesisContent, reviewGenesisContent } from "../harness/genesis-review.js";
import { decideGenesisVoice, generateLocalGenesisVoice, genesisVoiceRequest, hasUsableGenesisAudition, reviewGenesisVoices } from "../harness/genesis-voices.js";
import { selectHarnessModel } from "../harness/model-catalog.js";
import type { EnqueueInput, JobQueue } from "../queue/dispatcher.js";
import { imageModelFor } from "../references/generate.js";
import type { VoiceService } from "../voice/service.js";
import { atomicWriteFile } from "../world/atomic.js";
import type { FoundingBuildService } from "../world/founding-build.js";
import type { WorldProvider } from "../world-provider.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/**
 * The founding conversation before its world exists: its chat turns, the readiness, voice, image,
 * import and content reviews and their decisions, listing and loading drafts, attaching files and
 * discarding a draft. Nothing here needs an open world; loading a draft that has begun opens its
 * world. A decision in flight is held in `genesisDeciding`, shared with the founding build.
 */
export function genesisCommands(ctx: CommandContext, deps: {
  provider: WorldProvider;
  manifest: ModelManifest | undefined;
  pickFiles: ((input: { accept: readonly string[] }) => Promise<readonly string[]>) | undefined;
  genesis: () => GenesisService | null;
  foundingBuild: () => FoundingBuildService | null;
  /** Genesis ids with a decision in flight. */
  genesisDeciding: Set<string>;
  /** Files still being carried into a begun world, by genesis id. */
  carrying: Map<string, Promise<void>>;
  /** Local reads in flight, by key, so a stop can abort them. */
  reading: Map<string, AbortController>;
  jobQueue: () => JobQueue | null;
  voiceService: () => VoiceService | null;
  appSettings: () => AppSettingsFile | null;
  app: () => ClientState["app"];
  harnessModels: () => Promise<ModelInfo[]>;
  genesisVoiceCatalogue: () => ReturnType<VoiceService["catalogue"]>;
  enqueueBatch(requestId: string, command: QueueCommand, inputs: readonly EnqueueInput[]): Promise<unknown>;
  rejectEnqueue(requestId: string, command: QueueCommand, reason: string): void;
  trackBackground(work: Promise<unknown>): void;
  openWorld(worldId: string): Promise<void>;
  completeGenesisFormHandoff(genesisId: string, worldId: string): Promise<void>;
  attachToGenesis(genesisId: string, sourcePath: string): Promise<void>;
}) {
  const genesisReadiness = async (msg: CommandOf<"genesis-readiness" | "genesis-readiness-leave">): Promise<void> => {
    let held = false;
    try {
      if (!deps.provider.genesisDir) throw new Error("Founding conversations are unavailable.");
      if (deps.genesis()?.isRunning(msg.genesisId) || deps.foundingBuild()?.isBeginning(msg.genesisId) || deps.genesisDeciding.has(msg.genesisId)) throw new Error("Wait for the current draft operation before reviewing.");
      deps.genesisDeciding.add(msg.genesisId); held = true;
      const dir = await deps.provider.genesisDir(msg.genesisId);
      const loaded = await loadGenesisConversation(dir, msg.genesisId);
      if (loaded.worldId || loaded.founding) throw new Error("Continue repairs in the world's conversation.");
      const inputs = { jobs: (deps.jobQueue()?.listJobs() ?? []).filter(job => job.worldId === msg.genesisId),
        catalogue: await deps.genesisVoiceCatalogue(), models: deps.manifest?.models ?? [] };
      const review = msg.kind === "genesis-readiness-leave" ? await leaveGenesisFinding(dir, inputs, msg.digest, msg.findingId) : await reviewGenesisReadiness(dir, inputs);
      await atomicWriteFile(join(dir, "readiness-review.json"), JSON.stringify(review, null, 2));
      ctx.emit({ type: "genesis.readiness", at: new Date().toISOString(), genesisId: msg.genesisId, review });
    } catch (error) {
      ctx.emit({ type: "genesis.review-error", at: new Date().toISOString(), genesisId: msg.genesisId, area: "readiness", detail: describeCoordinatorError(error) });
    } finally { if (held) deps.genesisDeciding.delete(msg.genesisId); }
  };

  const genesisVoices = async (msg: CommandOf<"genesis-voices" | "genesis-voice-generate" | "genesis-voice-decide">): Promise<void> => {
    let held = false;
    const reading = msg.kind === "genesis-voices";
    if (reading && (deps.genesis()?.isRunning(msg.genesisId) || deps.foundingBuild()?.isBeginning(msg.genesisId))) return;
    try {
      if (!deps.provider.genesisDir) throw new Error("Founding conversations are unavailable.");
      if (deps.genesis()?.isRunning(msg.genesisId) || deps.foundingBuild()?.isBeginning(msg.genesisId) || (!reading && deps.genesisDeciding.has(msg.genesisId))) throw new Error("Another draft operation is running. Try again shortly.");
      if (!reading) { deps.genesisDeciding.add(msg.genesisId); held = true; }
      const dir = await deps.provider.genesisDir(msg.genesisId);
      const loaded = await loadGenesisConversation(dir, msg.genesisId);
      if (loaded.worldId || loaded.founding) throw new Error("Continue voice work in the founded world's conversation.");
      const blueprint = await foldBlueprint(dir);
      const catalogue = await deps.genesisVoiceCatalogue();
      const jobs = () => (deps.jobQueue()?.listJobs() ?? []).filter(job => job.worldId === msg.genesisId);
      let voices = await reviewGenesisVoices(dir, blueprint, jobs(), catalogue, deps.manifest?.models ?? []);
      if (msg.kind === "genesis-voice-generate") {
        if (!deps.voiceService()) throw new Error("Voice audition is unavailable.");
        const plan = voices.plans.find(plan => plan.intent.id === msg.intentId && plan.digest === msg.digest);
        if (!plan) throw new Error("The audition proposal changed. Review its current text, voice and cost.");
        if (!await hasUsableGenesisAudition(dir, voices.candidates, plan.digest) && !jobs().some(job => job.idempotencyKey === msg.requestId)) {
          if (jobs().some(job => job.params["purpose"] === "genesis-voice" && job.target.id === plan.intent.target && !["succeeded", "failed", "cancelled"].includes(job.status))) throw new Error("An audition for this character is already running.");
          if (plan.voice.provider === "kokoro" && plan.voice.model === "kokoro-82m") {
            const control = new AbortController(), key = "genesis:" + msg.genesisId;
            deps.reading.set(key, control);
            try {
              const work = generateLocalGenesisVoice(dir, plan, msg.requestId, () => deps.voiceService()!.synthesizePerformance(plan.voice.voiceId, plan.text, {}, control.signal));
              deps.trackBackground(work);
              await work;
            } finally { if (deps.reading.get(key) === control) deps.reading.delete(key); }
          } else await deps.enqueueBatch(msg.requestId, msg.kind, [genesisVoiceRequest(msg.genesisId, plan, msg.requestId)]);
        }
        voices = await reviewGenesisVoices(dir, blueprint, jobs(), catalogue, deps.manifest?.models ?? []);
      } else if (msg.kind === "genesis-voice-decide") {
        await decideGenesisVoice(dir, blueprint, catalogue, msg);
        voices = await reviewGenesisVoices(dir, blueprint, jobs(), catalogue, deps.manifest?.models ?? []);
      }
      ctx.emit({ type: "genesis.voices", at: new Date().toISOString(), genesisId: msg.genesisId, voices });
    } catch (error) {
      const reason = describeCoordinatorError(error);
      ctx.emit({ type: "genesis.review-error", at: new Date().toISOString(), genesisId: msg.genesisId, area: "voices", detail: reason });
      if (!reading) ctx.emit({ type: "command.failed", at: new Date().toISOString(), command: msg.kind, requestId: msg.requestId, reason });
    } finally { if (held) deps.genesisDeciding.delete(msg.genesisId); }
  };

  const genesisImages = async (msg: CommandOf<"genesis-images" | "genesis-image-generate" | "genesis-image-decide">): Promise<void> => {
    const reading = msg.kind === "genesis-images";
    if (!deps.provider.genesisDir || deps.genesis()?.isRunning(msg.genesisId) || deps.foundingBuild()?.isBeginning(msg.genesisId) || (!reading && deps.genesisDeciding.has(msg.genesisId))) {
      if (!reading) {
        const reason = "Another draft operation is running. Review the image and try again shortly.";
        ctx.emit({ type: "command.failed", at: new Date().toISOString(), command: msg.kind, requestId: msg.requestId, reason });
        ctx.emit({ type: "genesis.image-error", at: new Date().toISOString(), genesisId: msg.genesisId, detail: reason });
      }
      return;
    }
    if (!reading) deps.genesisDeciding.add(msg.genesisId);
    try {
      const dir = await deps.provider.genesisDir(msg.genesisId);
      const loadedDraft = await loadGenesisConversation(dir, msg.genesisId);
      if (loadedDraft.worldId || loadedDraft.founding) throw new Error("Continue image work in the founded world's conversation.");
      const blueprint = await foldBlueprint(dir);
      const jobs = (deps.jobQueue()?.listJobs() ?? []).filter(job => job.worldId === msg.genesisId);
      const model = deps.manifest ? imageModelFor(await deps.appSettings()?.load() ?? null,
        deps.manifest, undefined, "models" in msg ? msg.models : undefined) : null;
      let images = await reviewGenesisImages(dir, blueprint, jobs, model);
      if (msg.kind === "genesis-image-generate") {
        if (!jobs.some(job => job.idempotencyKey === msg.requestId)) {
          const plan = images.plans.find(plan => plan.intent.id === msg.intentId && plan.digest === msg.digest);
          if (!plan) throw new Error("The generation proposal changed. Review the current prompt and cost.");
          if (jobs.some(job => job.target.kind === "genesis-image" && job.target.id === plan.intent.target && !["succeeded", "failed", "cancelled"].includes(job.status))) throw new Error("An image for this character or location is already in progress.");
          await deps.enqueueBatch(msg.requestId, msg.kind, [genesisImageRequest(msg.genesisId, plan, msg.requestId)]);
        }
      } else if (msg.kind === "genesis-image-decide") {
        images = await decideGenesisImage(dir, blueprint, msg);
      }
      ctx.emit({ type: "genesis.images", at: new Date().toISOString(), genesisId: msg.genesisId, images });
    } catch (err) {
      ctx.emit({ type: "genesis.image-error", at: new Date().toISOString(), genesisId: msg.genesisId, detail: describeCoordinatorError(err) });
      if (msg.kind === "genesis-image-generate") deps.rejectEnqueue(msg.requestId, msg.kind, describeCoordinatorError(err));
    } finally { if (!reading) deps.genesisDeciding.delete(msg.genesisId); }
  };

  const genesisImports = async (msg: CommandOf<"genesis-imports" | "genesis-import-resolve">): Promise<void> => {
    if (!deps.provider.genesisDir) return;
    let held = false;
    const reading = msg.kind === "genesis-imports";
    if (reading && (deps.genesis()?.isRunning(msg.genesisId) || deps.foundingBuild()?.isBeginning(msg.genesisId))) return;
    try {
      if (deps.genesis()?.isRunning(msg.genesisId) || deps.foundingBuild()?.isBeginning(msg.genesisId) || (!reading && deps.genesisDeciding.has(msg.genesisId)))
        throw new Error("Another draft operation is still running. Try again shortly.");
      if (!reading) { deps.genesisDeciding.add(msg.genesisId); held = true; }
      const dir = await deps.provider.genesisDir(msg.genesisId);
      const loaded = await loadGenesisConversation(dir, msg.genesisId);
      if (loaded.worldId || loaded.founding) throw new Error("This world has begun. Continue imports in its world conversation.");
      const imports = msg.kind === "genesis-import-resolve" ? await resolveGenesisImport(dir, msg.resolution) : await reviewGenesisImports(dir);
      ctx.emit({ type: "genesis.imports", at: new Date().toISOString(), genesisId: msg.genesisId, imports });
      if (msg.kind === "genesis-import-resolve") {
        ctx.emit(await loadGenesisConversation(dir, msg.genesisId));
        ctx.emit({ type: "genesis.review", at: new Date().toISOString(), genesisId: msg.genesisId, review: await reviewGenesisContent(dir) });
      }
    } catch (err) {
      ctx.emit({ type: "genesis.import-error", at: new Date().toISOString(), genesisId: msg.genesisId, detail: describeCoordinatorError(err) });
    } finally { if (held) deps.genesisDeciding.delete(msg.genesisId); }
  };

  const genesisProposeWorld = async (msg: CommandOf<"genesis-propose-world">): Promise<void> => {
    if (!deps.provider.genesisDir || deps.genesis()?.isRunning(msg.genesisId) || deps.foundingBuild()?.isBeginning(msg.genesisId) || deps.genesisDeciding.has(msg.genesisId)) return;
    deps.genesisDeciding.add(msg.genesisId);
    try {
      const dir = await deps.provider.genesisDir(msg.genesisId);
      const loadedDraft = await loadGenesisConversation(dir, msg.genesisId);
      if (loadedDraft.worldId || loadedDraft.founding) throw new Error("This world has already begun.");
      // Directory sheets own their content; a legacy form array cannot overwrite them.
      for (const kind of ["characters", "locations"] as const) {
        for (const entity of msg.draft[kind]) {
          const existing = loadedDraft.blueprint[kind].find(one => one.name.toLowerCase() === entity.name.toLowerCase());
          if (existing && existing.line !== entity.line && await stat(join(dir, "draft", kind, `${existing.slug}.json`)).then(() => true, () => false)) {
            throw new Error(`${existing.name} has a drafted sheet. Ask in the conversation to change its text, then approve the updated sheet.`);
          }
        }
      }
      const previous: Record<string, unknown> = await readFile(join(dir, "draft.json"), "utf8").then(raw => JSON.parse(raw) as Record<string, unknown>)
        .catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return {}; throw err; });
      const combine = (old: unknown, added: Array<{ name: string; line: string }>) =>
        [...new Map([...(Array.isArray(old) ? old as Array<{ name: string; line: string }> : []), ...added].map(entity => [entity.name.toLowerCase(), entity])).values()];
      await atomicWriteFile(join(dir, "draft.json"), JSON.stringify({ ...previous, ...msg.draft,
        characters: combine(previous["characters"], msg.draft.characters), locations: combine(previous["locations"], msg.draft.locations),
      }, null, 2) + "\n");
      ctx.emit(await loadGenesisConversation(dir, msg.genesisId));
    } catch (err) {
      ctx.emit({ type: "genesis.status", at: new Date().toISOString(), genesisId: msg.genesisId, status: "failed", detail: describeCoordinatorError(err) });
    } finally { deps.genesisDeciding.delete(msg.genesisId); }
  };

  const genesisReview = async (msg: CommandOf<"genesis-review" | "genesis-decide">): Promise<void> => {
    if (!deps.provider.genesisDir) return;
    if (deps.genesis()?.isRunning(msg.genesisId) || deps.foundingBuild()?.isBeginning(msg.genesisId) || deps.genesisDeciding.has(msg.genesisId)) {
      ctx.emit({ type: "genesis.review-error", at: new Date().toISOString(), genesisId: msg.genesisId, area: "content",
        ...(msg.requestId ? { requestId: msg.requestId } : {}), detail: "The conversation is still working. Review again when this turn ends." });
      return;
    }
    const deciding = msg.kind === "genesis-decide";
    if (deciding) deps.genesisDeciding.add(msg.genesisId);
    try {
      const dir = await deps.provider.genesisDir(msg.genesisId);
      const loadedDraft = await loadGenesisConversation(dir, msg.genesisId);
      if (loadedDraft.worldId || loadedDraft.founding) return;
      const review = msg.kind === "genesis-decide"
        ? await decideGenesisContent(dir, msg.choices, msg.decision, msg.requestId)
        : await reviewGenesisContent(dir);
      ctx.emit({ type: "genesis.review", at: new Date().toISOString(), genesisId: msg.genesisId, ...(msg.requestId ? { requestId: msg.requestId } : {}), review });
    } catch (err) {
      ctx.emit({ type: "genesis.review-error", at: new Date().toISOString(), genesisId: msg.genesisId, area: "content", ...(msg.requestId ? { requestId: msg.requestId } : {}), detail: describeCoordinatorError(err) });
    } finally { if (deciding) deps.genesisDeciding.delete(msg.genesisId); }
  };

  const genesisList = async (msg: CommandOf<"genesis-list" | "genesis-load">): Promise<void> => {
    if (!deps.provider.genesisDir) return;
    const ids = msg.kind === "genesis-load" ? [msg.genesisId] : await deps.provider.listGenesisIds?.() ?? [];
    for (const id of ids) {
      try {
        const dir = await deps.provider.genesisDir(id);
        if (msg.kind === "genesis-list") {
          const completed = await readFile(join(genesisControlDir(dir), "completed.json"), "utf8")
            .catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
          if (completed !== null) continue;
        }
        let loaded = await loadGenesisConversation(dir, id);
        if (msg.kind === "genesis-load" && loaded.worldId) await deps.openWorld(loaded.worldId);
        if (loaded.worldId && loaded.formHandoff === "pending") {
          const worldId = loaded.worldId;
          const carry = deps.carrying.get(id) ?? deps.completeGenesisFormHandoff(id, worldId);
          deps.carrying.set(id, carry);
          await carry.finally(() => deps.carrying.delete(id));
          loaded = await loadGenesisConversation(dir, id);
        }
        if (deps.genesis()?.isRunning(id)) { loaded.status = "running"; delete loaded.detail; }
        ctx.emit(loaded);
      } catch (err) {
        ctx.emit({ type: "genesis.status", at: new Date().toISOString(), genesisId: id, status: "failed", detail: describeCoordinatorError(err) });
      }
    }
  };

  const genesisChat = async (msg: CommandOf<"genesis-chat">): Promise<void> => {
    const result = (accepted: boolean, detail?: string) => {
      if (msg.requestId) ctx.emit({ type: "genesis.chat-result", at: ctx.nowIso(), genesisId: msg.genesisId, requestId: msg.requestId, accepted, ...(detail ? { detail } : {}) });
    };
    if (deps.genesis()?.isRunning(msg.genesisId)) { result(false, "Another turn is running. Your message is still here; send it when that turn ends."); return; }
    const failed = (detail: string) => {
      result(false, detail);
      ctx.emit({
        at: new Date().toISOString(),
        type: "genesis.status",
        genesisId: msg.genesisId,
        status: "failed",
        detail,
      });
    };
    if (!deps.genesis() || !deps.provider.genesisDir) {
      failed("authoring is not configured");
      return;
    }
    try {
      if (deps.foundingBuild()?.isBeginning(msg.genesisId) || deps.genesisDeciding.has(msg.genesisId)) { failed("A decision is being saved. Try again shortly."); return; }
      let modelId = msg.modelId;
      if (modelId !== undefined) {
        const models = await deps.harnessModels();
        const selection = selectHarnessModel(modelId, models, deps.app(), false, true);
        if (selection.reason) { failed(selection.reason); return; }
        modelId = selection.sessionModel;
      }
      const dir = await deps.provider.genesisDir(msg.genesisId);
      const draft = await loadGenesisConversation(dir, msg.genesisId, deps.genesis()!.isRunning(msg.genesisId));
      if (draft.worldId) { failed("This world has begun. Continue in its world conversation."); return; }
      if (deps.foundingBuild()?.isBeginning(msg.genesisId) || deps.genesisDeciding.has(msg.genesisId)) { failed("A decision is being saved. Try again shortly."); return; }
      if (draft.founding) { failed("World creation has started. Press Begin again to recover it."); return; }
      await recoverGenesisImports(dir);
      await atomicWriteFile(join(dir, "voice-catalogue.json"), JSON.stringify(await deps.voiceService()?.catalogue() ?? [], null, 2));
      ctx.emit(draft);
      result(true);
      // Fire and watch: turns, the draft and the final status arrive as events.
      deps.trackBackground(deps.genesis()!.run(dir, msg.genesisId, msg.text, modelId).catch(err => failed(describeCoordinatorError(err))));
    } catch (err) {
      failed(describeCoordinatorError(err));
    }
  };

  const genesisDiscard = async (msg: CommandOf<"genesis-discard">): Promise<void> => {
    if (deps.genesis()?.isRunning(msg.genesisId) || deps.foundingBuild()?.isBeginning(msg.genesisId) || deps.genesisDeciding.has(msg.genesisId)) return;
    if (deps.provider.genesisDir) {
      const draft = await loadGenesisConversation(await deps.provider.genesisDir(msg.genesisId), msg.genesisId);
      if (draft.worldId || draft.founding) return;
    }
    deps.genesis()?.release(msg.genesisId);
    // A conversation-scoped job still in flight is cancelled with its conversation
    // (SPEC-031 row 16): the queue then discards a late delivery rather than landing it
    // into a sandbox this sweep is about to remove — and would otherwise re-create.
    // The ledger keeps whatever the cancellation cost; that is the correct record.
    for (const job of deps.jobQueue()?.listJobs() ?? []) {
      if (
        job.worldId === msg.genesisId &&
        (job.status === "queued" || job.status === "submitting" || job.status === "running")
      ) {
        await deps.jobQueue()?.cancel(job.id).catch(() => {});
      }
    }
    // Anything still being carried into the new world finishes first — otherwise Begin
    // races the sweep and the files handed over are the ones that vanish.
    await deps.carrying.get(msg.genesisId)?.catch(() => {});
    try {
      await deps.provider.discardGenesis?.(msg.genesisId);
    } catch (err) {
      ctx.emit({ type: "genesis.status", at: new Date().toISOString(), genesisId: msg.genesisId, status: "failed", detail: describeCoordinatorError(err) });
      return;
    }
    ctx.emit({ type: "genesis.discarded", at: new Date().toISOString(), genesisId: msg.genesisId });
  };

  const genesisAttachFiles = async (msg: CommandOf<"genesis-attach-files">): Promise<void> => {
    const pick = deps.pickFiles;
    if (!pick) {
      ctx.emit({
        at: new Date().toISOString(),
        type: "genesis.attachment",
        genesisId: msg.genesisId,
        // No file was ever chosen, so there is no name to carry — the chip names the act.
        name: "attaching",
        kind: "other",
        outcome: "refused",
        reason: "this needs the desktop app — a browser session cannot open the file picker",
      });
      return;
    }
    const paths = await pick({ accept: ATTACHABLE_EXTENSIONS }).catch(() => [] as readonly string[]);
    for (const sourcePath of paths) await deps.attachToGenesis(msg.genesisId, sourcePath);
  };

  const genesisAttach = async (msg: CommandOf<"genesis-attach">): Promise<void> => {
    await deps.attachToGenesis(msg.genesisId, msg.sourcePath);
  };

  return {
    "genesis-readiness": { scope: "none", handle: genesisReadiness },
    "genesis-readiness-leave": { scope: "none", handle: genesisReadiness },
    "genesis-voices": { scope: "none", handle: genesisVoices },
    "genesis-voice-generate": { scope: "none", handle: genesisVoices },
    "genesis-voice-decide": { scope: "none", handle: genesisVoices },
    "genesis-images": { scope: "none", handle: genesisImages },
    "genesis-image-generate": { scope: "none", handle: genesisImages },
    "genesis-image-decide": { scope: "none", handle: genesisImages },
    "genesis-imports": { scope: "none", handle: genesisImports },
    "genesis-import-resolve": { scope: "none", handle: genesisImports },
    "genesis-propose-world": { scope: "none", handle: genesisProposeWorld },
    "genesis-review": { scope: "none", handle: genesisReview },
    "genesis-decide": { scope: "none", handle: genesisReview },
    "genesis-list": { scope: "none", handle: genesisList },
    "genesis-load": { scope: "none", handle: genesisList },
    "genesis-chat": { scope: "none", handle: genesisChat },
    "genesis-discard": { scope: "none", handle: genesisDiscard },
    "genesis-attach-files": { scope: "none", handle: genesisAttachFiles },
    "genesis-attach": { scope: "none", handle: genesisAttach },
  } satisfies CommandModule;
}

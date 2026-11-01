import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  BenchSessionMetaSchema, BenchEventEnvelopeSchema, foldBenchSession, editShot, orderedShots, productionShape, promptFor, assemblePrompt,
  PromptOverrideSnapshotSchema, ShotPromptHistorySchema, PromptInspectionSchema, referenceAudioMediaPath, referenceAudioAsset,
  type PromptTarget, type ShotPromptHistory, type PromptInspection, type BenchSession, type BenchTake,
  type BenchRequestSnapshot, type WorldBundle, type Job,
} from "@arke-studio/contracts";
import { readContainedMediaBytes } from "../world/reference-files.js";
import { sha256 } from "../world/text-files.js";
import { parseSceneRecord } from "./scene-record.js";
import { planBenchDispatch, resolveTokenEntry, type BenchEnqueueInput } from "../bench/service.js";
import type { WorldStore } from "../world/store.js";
import { compileFrameRunEvidence, type CompileFrameRunInput } from "./frame-run.js";

const text = async (dir: string, path: string, max = 4 * 1024 * 1024) => new TextDecoder("utf-8", { fatal: true })
  .decode(await readContainedMediaBytes(dir, path, undefined, max)).replace(/^\uFEFF/, "");

export function promptOwner(world: WorldBundle, target: PromptTarget) {
  const production = world.productions.find(p => p.meta.id === target.productionId);
  const scene = production?.scenes.find(s => s.id === target.sceneId);
  const stem = production?.sceneFiles[target.sceneId];
  if (!production || !scene || !stem || /[/\\]/.test(stem) || stem === "." || stem === "..") throw Error("The owning scene is no longer available.");
  if (!orderedShots(scene).some(s => s.id === target.shotId)) throw Error("The shot is no longer in this scene.");
  return { production, scene, path: `productions/${production.meta.id}/scenes/${stem}.json`,
    history: `.history/productions/${production.meta.id}/scenes/${stem}` };
}

/** Existing scene versions are the only prompt-history authority (SPEC-029 R-38). */
export async function readShotPromptHistory(store: WorldStore, target: PromptTarget): Promise<ShotPromptHistory> {
  const world = store.getBundle(), owner = promptOwner(world, target);
  const raw = await text(store.dir, owner.path), scene = parseSceneRecord(raw);
  if (scene.id !== target.sceneId) throw Error("The scene identity changed. Reopen the shot.");
  const shot = orderedShots(scene).find(s => s.id === target.shotId);
  if (!shot) throw Error("The shot is no longer in this scene.");
  const current = shot.promptOverride ? PromptOverrideSnapshotSchema.parse(shot.promptOverride) : null;
  const entries: ShotPromptHistory["entries"] = [{ version: scene.version, hash: sha256(raw), prompt: current, unavailable: false }];
  let partial = false, names: string[] = [];
  try { names = await readdir(join(store.dir, owner.history)); } catch { partial = true; }
  const versions = names.filter(n => /^v[1-9]\d*\.json$/.test(n)).map(n => Number(n.slice(1, -5)))
    .filter(n => Number.isSafeInteger(n) && n < scene.version).sort((a, b) => b - a);
  if (versions.length > 100) partial = true;
  let previousVersion = scene.version, previous: typeof current | undefined = current, budget = 2 * 1024 * 1024;
  for (const version of versions.slice(0, 100)) {
    if (version !== previousVersion - 1) partial = true;
    previousVersion = version;
    try {
      const value = await text(store.dir, `${owner.history}/v${version}.json`, Math.max(1, budget));
      budget -= Buffer.byteLength(value);
      const historical = parseSceneRecord(value);
      if (historical.id !== scene.id || historical.version !== version) throw Error("Historical identity mismatch");
      const historicalShot = orderedShots(historical).find(s => s.id === target.shotId);
      if (!historicalShot) { partial = true; break; }
      const prompt = historicalShot.promptOverride ? PromptOverrideSnapshotSchema.parse(historicalShot.promptOverride) : null;
      if (!isDeepStrictEqual(previous, prompt)) entries.push({ version, hash: sha256(value), prompt, unavailable: false });
      previous = prompt;
    } catch { partial = true; entries.push({ version, unavailable: true }); previous = undefined; }
    if (budget <= 0) { partial = true; break; }
  }
  if (previousVersion > 1) partial = true;
  const assembledBody = assemblePrompt(world.meta, world.sheets, scene, shot, owner.production.meta.styleOverride?.trim() || world.artDirection.description, undefined, target.capability);
  return ShotPromptHistorySchema.parse({ assembledBody, assembledHash: sha256(assembledBody), target, currentVersion: scene.version, currentHash: sha256(raw), currentOverride: current, partial, entries,
    currentBody: promptFor(world.meta, world.sheets, scene, shot, owner.production.meta.styleOverride?.trim() || world.artDirection.description, undefined, target.capability).text });
}

/** A direct semantic edit under the same owner/gate as every scene command. No history rewrite. */
export async function restoreShotPrompt(store: WorldStore, target: PromptTarget, input: {
  assembledHash: string; baseVersion: number; baseHash: string; sourceVersion: number; sourceHash: string; requestId: string;
}): Promise<number> {
  let version = 0;
  await store.gateOp(async () => {
    const world = store.getBundle(), owner = promptOwner(world, target);
    if (world.proposals.some(p => p.proposal.targets.some(t => t.path === owner.path))) throw Error("A scene draft is open. Decide it before restoring a prompt.");
    const raw = await text(store.dir, owner.path), scene = parseSceneRecord(raw);
    if (scene.id !== target.sceneId || scene.version !== input.baseVersion || sha256(raw) !== input.baseHash) throw Error("The scene changed. Read the current prompt again before restoring.");
    const shot = orderedShots(scene).find(s => s.id === target.shotId);
    if (!shot) throw Error("The shot is no longer in this scene.");
    const inferred = productionShape(owner.production.meta).dispatchCapability === "video" ? "video" : "image";
    if (shot.promptOverride && (shot.promptOverride.capability ?? inferred) !== target.capability) throw Error("A prompt for the other capability is saved. Restore from that context instead.");
    if (input.sourceVersion >= scene.version) throw Error("Choose an earlier retained version.");
    const historicalRaw = await text(store.dir, `${owner.history}/v${input.sourceVersion}.json`);
    if (sha256(historicalRaw) !== input.sourceHash) throw Error("The historical version changed or is unavailable. Read history again.");
    const historical = parseSceneRecord(historicalRaw);
    const oldShot = orderedShots(historical).find(s => s.id === target.shotId);
    if (historical.id !== scene.id || historical.version !== input.sourceVersion || !oldShot) throw Error("That version does not contain this shot.");
    const override = oldShot.promptOverride ? PromptOverrideSnapshotSchema.parse(oldShot.promptOverride) : undefined;
    if (override && (override.capability ?? inferred) !== target.capability) throw Error("This historical prompt belongs to the other capability.");
    if (!override && sha256(assemblePrompt(world.meta, world.sheets, scene, shot, owner.production.meta.styleOverride?.trim() || world.artDirection.description, undefined, target.capability)) !== input.assembledHash) throw Error("The sources changed. Review today’s assembled prompt again.");
    if (isDeepStrictEqual(shot.promptOverride, override)) throw Error("This prompt is already current. Nothing was saved.");
    const after = editShot(scene, { shotId: target.shotId, change: { promptOverride: override } });
    const committed = await store.commitUnserialised({ kind: "scene-command", source: "restore-shot-prompt", requestId: input.requestId,
      files: [{ path: owner.path, action: "replace", content: JSON.stringify(after, null, 2) + "\n", baseHash: sha256(raw) }] });
    version = committed.versions[owner.path]!;
  });
  return version;
}

/** BenchStore.fold repairs torn tails; inspection must only read. Corrupt evidence is refused. */
export async function readPromptBench(store: WorldStore, sessionId: string): Promise<BenchSession> {
  const dir = `.sessions/${sessionId}`;
  const meta = BenchSessionMetaSchema.parse(JSON.parse(await text(store.dir, `${dir}/session.json`)));
  if (meta.id !== sessionId) throw Error("The generator identity changed.");
  let raw = "";
  try { raw = await text(store.dir, `${dir}/events.jsonl`, 16 * 1024 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("The generator history could not be read. Reopen it before inspecting."); }
  const events = raw.split("\n").filter(line => line.trim()).map(line => BenchEventEnvelopeSchema.parse(JSON.parse(line)));
  if (events.some((row, index) => row.seq !== index + 1)) throw Error("The generator history is incomplete.");
  return foldBenchSession(meta, events);
}

function fileAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2000 && !value.startsWith("/") && !/[\\:]/.test(value) && !value.includes(String.fromCharCode(0)) && !value.split("/").some(p => p === ".." || p === "." || p === "");
}

/** A bounded display of compiler output, never the provider object or its credentials. */
export function promptInspection(input: Pick<BenchEnqueueInput, "params" | "model" | "provider" | "capability">, snapshot: BenchRequestSnapshot,
  session: BenchSession, world: WorldBundle, source: PromptInspection["source"], identity: string, quantity: number): PromptInspection {
  if (!["image", "video"].includes(input.capability) || typeof input.params.prompt !== "string") throw Error("No recorded image/video request is available.");
  const refs: PromptInspection["references"] = [];
  const tokens = [...snapshot.references, ...snapshot.keyframes];
  const known = tokens.map(entry => ({ entry, resolved: resolveTokenEntry(entry, session, world) }));
  const add = (field: string, files: unknown, kind: string, frame = false) => {
    if (!Array.isArray(files)) return;
    files.forEach((file, index) => {
      if (!fileAddress(file)) throw Error("The retained reference address cannot be safely displayed.");
      const match = known.find(item => !("refused" in item.resolved) && item.resolved.path === file)?.entry
        ?? (frame ? snapshot.keyframes : snapshot.references.filter(ref => ref.kind === kind))[index];
      const lane = frame && input.params.taskMode === "first-and-last-frame" ? index === 0 ? "Start frame" : "End frame" : frame && input.params.taskMode === "first-frame" ? "Start frame" : field;
      refs.push({ field: lane, index: refs.filter(ref => ref.field === lane && ref.sent).length + 1, subject: match?.label ?? `Recorded ${kind} ${index + 1}`, role: match?.productionBinding?.rolePhrase ?? match?.subjectRole ?? kind,
        file, ...(match ? { hash: match.source.hash, ...(match.sheetVersion ? { sheetVersion: match.sheetVersion } : {}) } : {}), sent: true });
    });
  };
  const frameMode = typeof input.params.taskMode === "string" && snapshot.keyframes.length > 0;
  add(frameMode ? `Frames · ${String(input.params.taskMode)}` : "Images", input.params.references, "image", frameMode);
  add("Video", input.params.videoReferences, "video");
  if (Array.isArray(input.params.referenceMedia)) for (const media of input.params.referenceMedia) {
    if (typeof media === "object" && media !== null && "file" in media && "kind" in media && !refs.some(ref => ref.sent && ref.file === media.file)) {
      add(media.kind === "audio" ? "Audio" : "Video", [media.file], String(media.kind));
    }
  }
  const audio = snapshot.audioReferences;
  if (audio) for (const ref of audio.references) {
    const file = referenceAudioMediaPath(ref);
    if (!fileAddress(file)) throw Error("The recorded audio address is unavailable.");
    refs.push({ field: "Audio", index: refs.filter(r => r.field === "Audio").length + 1, subject: ref.characterName,
      role: ref.intent, file, hash: referenceAudioAsset(ref).provenance.outputHash, sent: true });
  }
  if (source !== "frozen-request") for (const entry of session.tokenRegistry) if (!tokens.some(t => t.token === entry.token)) {
    refs.push({ field: entry.kind, subject: entry.label ?? entry.token, role: entry.subjectRole ?? entry.kind, sent: false,
      reason: "Not selected for this compiled request. No more specific omission reason was recorded." });
  }
  const controls: PromptInspection["controls"] = [];
  for (const [key, label] of [["duration", "Duration"], ["aspect", "Aspect"], ["resolution", "Resolution"], ["sound", "Sound"], ["taskMode", "Mode"]]) {
    const value = input.params[key!];
    if (["string", "number", "boolean"].includes(typeof value)) controls.push({ label: label!, value: String(value) });
  }
  const output = input.params.output as { width?: number; height?: number } | undefined;
  if (output?.width && output.height) controls.push({ label: "Size", value: `${output.width} × ${output.height}` });
  return PromptInspectionSchema.parse({ source, identity, capability: input.capability, provider: input.provider, model: input.model,
    prompt: input.params.prompt, quantity, controls, references: refs, notices: source === "frozen-request"
      ? ["Recorded compiler request; current model availability and source bytes may differ."]
      : ["Prepared preview only. Generate compiles again from its then-current inputs; random seeds are chosen at generation.",
        "The full compiler prompt is shown. Separate layers are unavailable on this route."] });
}

/** Prove the recorded source bytes still match before calling a preview current. No upload. */
export async function verifyPromptReferences(store: WorldStore, value: PromptInspection): Promise<void> {
  let budget = 128 * 1024 * 1024;
  for (const ref of value.references.filter(ref => ref.sent && ref.file)) {
    const bytes = await readContainedMediaBytes(store.dir, ref.file!, store.closingSignal, Math.min(budget, 50 * 1024 * 1024));
    budget -= bytes.length;
    if (ref.hash && !sha256(bytes).startsWith(ref.hash)) throw Error("A reference changed since it was attached. Refresh its source in the generator.");
    if (budget <= 0) throw Error("The request exceeds the preview's reference verification limit.");
  }
}

export function compilePromptInspection(session: BenchSession, world: WorldBundle, manifest: Parameters<typeof planBenchDispatch>[2],
  options: Parameters<typeof planBenchDispatch>[3], source: PromptInspection["source"], identity: string): PromptInspection {
  const plan = planBenchDispatch(session, world, manifest, options);
  if (!plan.ok) throw Error(plan.reason);
  const input = plan.inputs[0], snapshot = plan.reserved[0]?.request;
  if (!input || !snapshot) throw Error("No request could be compiled.");
  return promptInspection(input, snapshot, session, world, source, identity, plan.inputs.length);
}

export function frozenPromptInspection(job: Job | undefined, take: BenchTake, session: BenchSession, world: WorldBundle): PromptInspection {
  if (!job || job.id !== take.jobId || job.worldId !== world.meta.worldId || job.target.kind !== "bench-take" || job.target.id !== `${session.id}/${take.id}`) {
    throw Error("The original compiled job is not retained here. Its saved brief cannot be presented as the original request.");
  }
  return promptInspection(job, take.request, session, world, "frozen-request", job.id, 1);
}

/** The shot page makes frames through FrameRun, so its preview uses that exact compiler. */
export async function framePromptInspection(input: CompileFrameRunInput): Promise<PromptInspection> {
  const { run, passes } = await compileFrameRunEvidence(input), step = run.steps[0];
  if (!step) throw Error("No frame request could be compiled.");
  const pass = passes.find(candidate => candidate.target.id === step.dispatch.target.id);
  const value: PromptInspection = { source: "saved-shot", identity: `${input.scene.id} v${input.scene.version}`,
    capability: "image", provider: input.model.provider, model: input.model.id, prompt: String(step.dispatch.params.prompt), quantity: 1,
    controls: [{ label: "Aspect", value: step.dispatch.output.aspect }, { label: "Size", value: `${step.dispatch.output.width} × ${step.dispatch.output.height}` }],
    references: step.request.references.map((ref, index) => {
      const compiled = pass?.references.find(candidate => candidate.file === ref.path);
      return { field: "Images", index: index + 1, subject: compiled?.subject ?? input.world.sheets.find(s => s.id === ref.sheetId)?.name ?? ref.sheetId,
        role: compiled?.role ?? "Image reference", file: ref.path, sheetVersion: ref.version, sent: true };
    }),
    notices: ["Prepared preview of a per-shot frame run. Generate compiles again from its then-current inputs.", "The full compiler prompt is shown; no separate layer data is retained."] };
  for (const ref of step.request.droppedReferences) value.references.push({ field: "Images", subject: ref.path, role: "Image reference", sent: false, reason: ref.reason });
  for (const ref of pass?.dropped ?? []) value.references.push({ field: "Images", subject: input.world.sheets.find(sheet => sheet.id === ref.sheetId)?.name ?? ref.sheetId,
    role: ref.role, sent: false, reason: ref.reason });
  return PromptInspectionSchema.parse(value);
}

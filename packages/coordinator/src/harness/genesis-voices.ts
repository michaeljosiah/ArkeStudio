import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  GenesisVoicesSchema, GenesisVoicePlanSchema, estimateMicroUsd, billableCharacters,
  normalizeSpeechText, voiceFormatForModel, voiceTargetKey, genesisSheetIds,
  type GenesisBlueprint, type GenesisVoiceCandidate, type GenesisVoicePlan, type GenesisVoices,
  type Job, type ManifestModel, type VoiceCandidate,
} from "@arke-studio/contracts";
import { atomicWriteFile, serializeFileMutation } from "../world/atomic.js";
import { conversationActionDigest } from "../arke-actions/digest.js";
import { cachedVoiceAudioLooksRight } from "../voice/service.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { WorldStore } from "../world/store.js";
import { applyVoiceAssignment } from "../sheets/authoring.js";
import { genesisControlDir, genesisConversation } from "./genesis-conversation.js";

const pathFor = (dir: string) => join(genesisControlDir(dir), "voices.json");
const hash = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const save = (dir: string, state: GenesisVoices) => atomicWriteFile(pathFor(dir), JSON.stringify(state) + "\n");
export async function savedGenesisVoices(dir: string): Promise<GenesisVoices> {
  const state = await readFile(pathFor(dir), "utf8").then(raw => GenesisVoicesSchema.parse(JSON.parse(raw)))
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error;
      return GenesisVoicesSchema.parse({ catalogue: [], plans: [], candidates: [], selections: [], rejected: [], problems: [], attempts: {} }); });
  const log = await (await genesisConversation(dir)).read();
  if (log.problems.length) throw new Error("The voice decision history needs repair.");
  state.selections = []; state.rejected = [];
  for (const { event } of log.events) {
    if (event.type !== "founding.voice-decision") continue;
    if (event.decision === "unassign") state.selections = state.selections.filter(one => one.plan.intent.target !== event.target);
    else if (event.candidate && event.decision === "approve") {
      state.selections = [...state.selections.filter(one => one.plan.intent.target !== event.target), event.candidate];
      state.rejected = state.rejected.filter(id => id !== event.candidate!.id);
    } else if (event.candidate) state.rejected.push(event.candidate.id);
  }
  return state;
}
function available(plan: GenesisVoicePlan, catalogue: readonly VoiceCandidate[]) {
  const candidate = catalogue.find(one => voiceTargetKey(one) === voiceTargetKey(plan.voice));
  if (!candidate || candidate.unavailableReason || candidate.readsClone) throw new Error(candidate?.unavailableReason ?? "This voice is unavailable in this founding conversation. Choose another or remove its assignment.");
  return candidate;
}
function target(blueprint: GenesisBlueprint, key: string) {
  const character = blueprint.characters.find(character => "character:" + character.slug === key);
  if (!character) throw new Error("The audition's character is no longer in the approved draft.");
  return character;
}
async function freeze(dir: string, id: string, plan: GenesisVoicePlan, bytes: Uint8Array, jobId?: string): Promise<GenesisVoiceCandidate> {
  if (bytes.length > 50 * 1024 * 1024 || !cachedVoiceAudioLooksRight(bytes, plan.format)) throw new Error("The audition did not produce valid audio.");
  const digest = hash(bytes), file = `media/${digest.slice(7)}.${plan.format}`;
  await atomicWriteFile(join(genesisControlDir(dir), file), bytes);
  return { id, plan, file, hash: digest, createdAt: new Date().toISOString(), ...(jobId ? { jobId } : {}) };
}
async function verify(dir: string, candidate: GenesisVoiceCandidate) {
  const path = join(genesisControlDir(dir), candidate.file);
  const info = await stat(path);
  if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error("The audition needs repair.");
  const bytes = await readFile(path);
  if (hash(bytes) !== candidate.hash || !cachedVoiceAudioLooksRight(bytes, candidate.plan.format)) throw new Error("The audition changed. Audition again before selecting.");
}
export async function reviewGenesisVoices(dir: string, blueprint: GenesisBlueprint, jobs: readonly Job[], catalogue: VoiceCandidate[], models: readonly ManifestModel[]): Promise<GenesisVoices> {
  return serializeFileMutation(pathFor(dir), async () => {
    const state = await savedGenesisVoices(dir);
    state.catalogue = catalogue; state.plans = []; state.problems = [];
    for (const intent of blueprint.voices ?? []) {
      try {
        const character = target(blueprint, intent.target);
        const voice = catalogue.find(one => voiceTargetKey(one) === voiceTargetKey(intent.voice));
        if (!voice || voice.unavailableReason || voice.readsClone) throw new Error(voice?.unavailableReason ?? "Choose a catalogue voice available before founding.");
        const model = models.find(model => model.provider === voice.provider && model.id === voice.model && model.capability === "voice-tts");
        const local = voice.provider === "kokoro" && voice.model === "kokoro-82m";
        if (!local && !model) throw new Error("The selected voice model is unavailable.");
        const text = normalizeSpeechText(intent.text);
        if (!text.trim()) throw new Error("The audition needs spoken text.");
        const plan = { intent, title: character.name, voice, text, format: local ? "wav" as const : voiceFormatForModel(model!),
          estimatedMicroUsd: local ? 0 : estimateMicroUsd(model!, { characters: billableCharacters(model!, text) }),
          transfer: voice.local ? "Runs on this device." : `The audition text is sent to ${voice.provider}. No recording is uploaded.` };
        state.plans.push({ ...plan, digest: conversationActionDigest(plan) });
      } catch (error) { state.problems.push(error instanceof Error ? error.message : "The voice proposal needs revision."); }
    }
    for (const job of jobs) {
      if (job.params["purpose"] !== "genesis-voice" || job.status !== "succeeded" || state.candidates.some(one => one.jobId === job.id)) continue;
      try {
        const plan = GenesisVoicePlanSchema.parse(job.params["foundingVoicePlan"]);
        const file = job.landedFiles?.[0];
        if (!file || !/^auditions\/[0-9A-HJKMNP-TV-Z]{26}\.(wav|mp3|flac)$/.test(file)) throw new Error("The audition output is unavailable.");
        const info = await stat(join(dir, file));
        if (info.size > 50 * 1024 * 1024) throw new Error("The audition is too large.");
        state.candidates.push(await freeze(dir, job.id, plan, await readFile(join(dir, file)), job.id));
      } catch { state.problems.push("A completed audition could not be preserved. Generate another or leave its voice unassigned."); }
    }
    for (const selected of state.selections) {
      try { target(blueprint, selected.plan.intent.target); available(selected.plan, catalogue); await verify(dir, selected); }
      catch (error) { state.problems.push(error instanceof Error ? error.message : "A selected voice needs attention."); }
    }
    await save(dir, state);
    return state;
  });
}
export function genesisVoiceRequest(genesisId: string, plan: GenesisVoicePlan, requestId: string): EnqueueInput {
  return { worldId: genesisId, idempotencyKey: requestId, target: { kind: "voice-preview", id: plan.intent.target }, capability: "voice-tts",
    provider: plan.voice.provider, model: plan.voice.model, estimatedMicroUsd: plan.estimatedMicroUsd,
    params: { purpose: "genesis-voice", voiceId: plan.voice.voiceId, text: plan.text, audioFormat: plan.format, foundingVoicePlan: plan },
    landing: { dir: "auditions", name: requestId + "." + plan.format } };
}
export async function generateLocalGenesisVoice(dir: string, plan: GenesisVoicePlan, requestId: string, synthesize: () => Promise<Uint8Array>): Promise<void> {
  await serializeFileMutation(pathFor(dir), async () => {
    const state = await savedGenesisVoices(dir);
    if (state.candidates.some(one => one.plan.digest === plan.digest)) return;
    if (state.attempts[requestId]) {
      if (state.attempts[requestId]!.status === "completed") return;
      throw new Error("This audition was interrupted or failed. Request another audition; it will not be repeated automatically.");
    }
    state.attempts[requestId] = { digest: plan.digest, status: "running" };
    await save(dir, state);
    try {
      const candidate = await freeze(dir, requestId, plan, await synthesize());
      state.candidates.push(candidate); state.attempts[requestId]!.status = "completed";
      await save(dir, state);
    } catch (error) {
      state.attempts[requestId]!.status = "failed"; await save(dir, state); throw error;
    }
  });
}
export async function decideGenesisVoice(dir: string, blueprint: GenesisBlueprint, catalogue: VoiceCandidate[], input: {
  requestId: string; target: string; decision: "approve" | "reject" | "unassign"; candidateId?: string; hash?: string;
}): Promise<GenesisVoices> {
  return serializeFileMutation(pathFor(dir), async () => {
    const state = await savedGenesisVoices(dir);
    const candidate = state.candidates.find(one => one.id === input.candidateId);
    if (input.decision !== "unassign") {
      if (!candidate || candidate.hash !== input.hash || candidate.plan.intent.target !== input.target) throw new Error("Review the current audition for this character.");
      if (input.decision === "approve") { target(blueprint, input.target); available(candidate.plan, catalogue); await verify(dir, candidate); }
    }
    await (await genesisConversation(dir)).append({ type: "founding.voice-decision", target: input.target, decision: input.decision,
      ...(candidate ? { candidate } : {}) }, { at: new Date().toISOString(), requestId: input.requestId });
    return savedGenesisVoices(dir);
  });
}
export async function reviewedGenesisVoices(dir: string, blueprint: GenesisBlueprint, jobs: readonly Job[], catalogue: VoiceCandidate[], models: readonly ManifestModel[] = []): Promise<GenesisBlueprint> {
  if (jobs.some(job => job.params["purpose"] === "genesis-voice" && !["succeeded", "failed", "cancelled"].includes(job.status))) throw new Error("Let voice auditions finish or cancel them before founding.");
  const state = await savedGenesisVoices(dir);
  for (const selection of state.selections) {
    target(blueprint, selection.plan.intent.target); available(selection.plan, catalogue); await verify(dir, selection);
    const voice = selection.plan.voice;
    if (!(voice.provider === "kokoro" && voice.model === "kokoro-82m") &&
      !models.some(model => model.provider === voice.provider && model.id === voice.model && model.capability === "voice-tts"))
      throw new Error("The selected voice model is unavailable. Choose another or remove the assignment.");
  }
  return { ...blueprint, ...(state.selections.length ? { selectedVoices: state.selections } : {}) };
}
export async function installGenesisVoice(store: WorldStore, blueprint: GenesisBlueprint, candidate: GenesisVoiceCandidate): Promise<void> {
  const id = genesisSheetIds(blueprint).get(candidate.plan.intent.target);
  const sheet = store.getBundle().sheets.find(sheet => sheet.id === id);
  if (!sheet) throw new Error("The approved character has not been saved.");
  const voice = candidate.plan.voice;
  if (sheet.voice?.provider === voice.provider && sheet.voice.model === voice.model && sheet.voice.voiceId === voice.voiceId) return;
  await applyVoiceAssignment(store, { path: `characters/${id}.md`, voice },
    { source: "founding", requestId: "founding-voice:" + candidate.plan.intent.target });
}

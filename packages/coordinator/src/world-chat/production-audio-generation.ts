import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRODUCTION_AUDIO_CHAT_SCHEMA_VERSION, estimateMicroUsd, legacyVoiceModel, normalizeSpeechText, orderedShots, voiceSourceFor,
  PerformanceGenerationQuoteSchema, VoiceSampleReviewSchema,
  type AppSettings, type ArkeGenerationBody, type ManifestModel, type ModelManifest, type ProviderStatus,
} from "@arke-studio/contracts";
import { characterSpeakingRequest, prepareCharacterSample, resumeCharacterSample } from "../audio/character-sample.js";
import { compilePerformanceGeneration, performanceGenerationJob, retainPerformanceGenerationQuote } from "../audio/performance-generation.js";
import { performanceTarget } from "../audio/performances.js";
import { audioHash } from "../audio/qc.js";
import { resolveAudioSource } from "../audio/storage.js";
import { planTableRead, type TableReadNarrator } from "../audio/table-read.js";
import type { AudioMediaTools } from "../audio/media-tools.js";
import { inspectBenchVoiceInputs } from "../bench/chat-voice.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { voiceLineRequest } from "../voice/service.js";
import { atomicWriteFile } from "../world/atomic.js";
import type { WorldStore } from "../world/store.js";
import type { GenerationQuoteSource } from "./generation-quotes.js";

/** One approval owns one stable local preparation or performance, including after restart. */
export function productionAudioOperationId(actionId: string): string {
  const hex = createHash("sha256").update(`production-audio/${actionId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function jobKey(actionId: string, index: number): string {
  if (index === 0) return actionId.slice(4);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let entropy = BigInt(`0x${createHash("sha256").update(`${actionId}/${index}`).digest("hex").slice(0, 20)}`);
  let encoded = "";
  for (let i = 0; i < 16; i++) { encoded = alphabet[Number(entropy & 31n)] + encoded; entropy >>= 5n; }
  return actionId.slice(4, 14) + encoded;
}

export function productionAudioGenerationSource(store: WorldStore, ports: {
  manifest: ModelManifest | null;
  settings(): Promise<AppSettings | null>;
  providers(): readonly ProviderStatus[];
  jobs(): readonly import("@arke-studio/contracts").Job[];
  reader(model: ManifestModel, voiceId: string): Promise<void>;
  narrator(productionId: string): Promise<TableReadNarrator | null>;
  freeze(input: EnqueueInput): EnqueueInput;
  tools: AudioMediaTools | null;
  confirmUploads(inputs: readonly EnqueueInput[], actionId: string): Promise<void>;
}): GenerationQuoteSource {
  const deliveryPath = (id: string) => join(store.dir, ".history", "world", "prepared", `${id}.audio-delivery.json`);
  const readDelivery = async (id: string) => {
    const raw = await readFile(deliveryPath(id), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    return raw === null ? null : VoiceSampleReviewSchema.parse(JSON.parse(raw));
  };
  return {
    compile: async (action, actionId, at) => {
      if (action.kind !== "production-audio-generation") throw new Error("The production audio request is unavailable.");
      const production = store.getBundle().productions.find(p => p.meta.id === action.productionId);
      if (!production) throw new Error("This production is no longer available.");
      const request = action.request;
      const settings = await ports.settings();
      const modelForVoice = (voice: NonNullable<import("@arke-studio/contracts").Sheet["voice"]>, named?: string) => {
        const id = voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId, store.getBundle().clonedVoices);
        if (!id || (named !== undefined && named !== id)) throw new Error("Choose the character's assigned speech model.");
        const model = ports.manifest?.models.find(m => m.id === id && m.provider === voice.provider && m.capability === "voice-tts");
        if (!model || settings?.models.disabled.includes(model.id)) throw new Error("The assigned speech model is unavailable or disabled.");
        return model;
      };
      let inputs: EnqueueInput[] = [];
      let authority: unknown;
      let materialization: unknown;
      let purpose: string = request.operation;
      let output = "Unselected audio candidates; review and placement require separate decisions";
      let medium: ArkeGenerationBody["medium"] = "audio";
      let prompt = "";
      const exclusions: string[] = [];
      const references: ArkeGenerationBody["references"] = [];
      if (request.operation === "voice-line") {
        const scene = production.scenes.find(s => orderedShots(s).some(shot => shot.id === request.shotId));
        const shot = scene && orderedShots(scene).find(s => s.id === request.shotId);
        const sheet = store.getBundle().sheets.find(s => s.id === shot?.audio?.speaker && !s.retired);
        if (!shot?.audio?.line || !sheet?.voice) throw new Error("This shot needs a spoken line and a character with an assigned voice.");
        const model = modelForVoice(sheet.voice, request.modelId ?? production.meta.models?.["voice-tts"]);
        await ports.reader(model, sheet.voice.voiceId);
        const source = voiceSourceFor(store.getBundle().clonedVoices, model.provider, model.id, sheet.voice.voiceId);
        if (source.kind === "missing-clone") throw new Error("The assigned cloned voice is unavailable.");
        inputs = [voiceLineRequest({ at, confirmedSpeechMicroUsd: Number.MAX_SAFE_INTEGER, worldId: store.worldId,
          productionId: action.productionId, shotId: shot.id, sheet, text: shot.audio.line, model,
          ...(request.delivery ? { delivery: request.delivery } : {}),
          ...(source.kind === "cloned" ? { voiceReference: true, language: source.voice.language } : {}) })];
        authority = { scene, sheet, model };
        references.push({ id: sheet.id, role: `Speaker: ${sheet.name}` });
        purpose = `Voice line: ${shot.title}`;
      } else if (request.operation === "performance") {
        const line = performanceTarget(store, { productionId: action.productionId, ...request });
        if (!line.sheet.voice) throw new Error("Assign the speaking character a voice first.");
        const model = modelForVoice(line.sheet.voice);
        await ports.reader(model, line.sheet.voice.voiceId);
        const source = voiceSourceFor(store.getBundle().clonedVoices, model.provider, model.id, line.sheet.voice.voiceId);
        if (source.kind === "missing-clone") throw new Error("The assigned cloned voice is unavailable.");
        const quote = compilePerformanceGeneration(store, model, { kind: "prepare-performance-generation", requestId: actionId.slice(4),
          worldId: store.worldId, productionId: action.productionId, sceneId: request.sceneId, shotId: request.shotId,
          ...(request.blockId ? { blockId: request.blockId } : {}), expectedSceneVersion: line.target.sceneVersion,
          expectedVoiceId: line.sheet.voice.voiceId, modelId: model.id,
          cadencePlan: { schemaVersion: 1, sourceTextHash: audioHash(Buffer.from(normalizeSpeechText(line.text))),
            speed: 1, cues: [], ...request.direction } }, { operationId: productionAudioOperationId(actionId), createdAt: at });
        inputs = [performanceGenerationJob(store, quote, actionId.slice(4), { voiceReference: source.kind === "cloned" })];
        authority = { quote, model };
        references.push({ id: line.sheet.id, role: `Speaker: ${line.sheet.name}` });
        materialization = quote;
        purpose = "Generate a performance";
      } else if (request.operation === "table-read") {
        if (!ports.manifest) throw new Error("The voice catalogue is unavailable.");
        const planned = await planTableRead(store, action.productionId, request.sceneId, ports.manifest, ports.jobs(), ports.providers(),
          async (model, voiceId) => { try { if (settings?.models.disabled.includes(model.id)) return "The assigned speech model is disabled."; await ports.reader(model, voiceId); return null; } catch (error) { return error instanceof Error ? error.message : "This reader is unavailable."; } }, await ports.narrator(action.productionId));
        inputs = planned.queued;
        if (!inputs.length) {
          const unavailable = planned.plan.items.filter(item => item.route === "unavailable" || item.route === "generating");
          throw new Error(unavailable.length ? `This table read has no available new preparation: ${unavailable.map(item => `${item.lineId}: ${item.reason ?? item.route}`).join("; ")}`
            : "This table read has no new lines to prepare. Existing audio is already available in Rehearsal.");
        }
        exclusions.push(...planned.plan.items.filter(item => item.route === "unavailable" || item.route === "generating").map(item => `${item.lineId}: ${item.reason ?? item.route}`));
        authority = planned.plan;
        purpose = "Prepare the scene table read";
        output = "Derived rehearsal audio; performance selections remain unchanged";
      } else if (request.operation === "voice-sample") {
        const model = ports.manifest?.models.find(m => m.id === request.modelId && m.capability === "video");
        if (!model || settings?.models.disabled.includes(model.id)) throw new Error("The speaking video model is unavailable or disabled.");
        const runtime = ports.providers().find(provider => provider.id === model.provider);
        if (!runtime?.configured || runtime.fault !== null || runtime.validation !== "valid" || !runtime.probes.some(probe => probe.capability === "video" && probe.available)) throw new Error("Validate the speaking-video provider in Settings before preparation.");
        const resolution = model.limits.resolutions?.[0] ?? "720p";
        inputs = [characterSpeakingRequest(store, model, { kind: "generate-character-voice-sample", worldId: store.worldId,
          requestId: actionId.slice(4), ...request, confirmedMicroUsd: estimateMicroUsd(model, { durationSec: request.durationSec, resolution }) })];
        inputs[0]!.productionId = action.productionId;
        authority = { model, sheet: store.getBundle().sheets.find(s => s.id === request.sheetId), kit: store.getBundle().referenceKits.find(k => k.sheetId === request.sheetId) };
        references.push({ id: request.sheetId, role: "Accepted character photo; sent to the speaking-video provider" });
        purpose = "Generate a character speaking sample";
        medium = "video";
        output = "Unassigned speaking video; sample preparation, audition and rights are separate human decisions";
      } else {
        if (!ports.tools) throw new Error("Local audio preparation is unavailable.");
        const resolved = await resolveAudioSource(store, request.source);
        const sheet = store.getBundle().sheets.find(s => s.id === request.sheetId && s.type === "character" && !s.retired);
        if (!sheet) throw new Error("The sample's character is unavailable.");
        authority = { source: resolved.source, sheet, kit: store.getBundle().referenceKits.find(k => k.sheetId === sheet.id) ?? null };
        references.push({ id: request.sheetId, role: "Character sample source" });
        purpose = `Prepare ${sheet.name}'s voice sample`;
        prompt = "Convert the named source to a retained mono PCM sample and report audio quality.";
        output = "A prepared sample for human audition, quality acknowledgement and rights; no voice assignment";
      }
      inputs = inputs.map((input, index) => ports.freeze({ ...input, idempotencyKey: jobKey(actionId, index) }));
      const voice = await inspectBenchVoiceInputs(store, inputs);
      for (const consent of voice.consents) if (consent.token) inputs[consent.index]!.voiceUploadConfirmedFor = consent.token;
      prompt ||= inputs.map((input, index) => `${inputs.length > 1 ? `${index + 1}. ` : ""}${[input.params.prompt ?? input.params.text, input.params.instructions].filter(Boolean).join("\n")}`).join("\n\n");
      const body: ArkeGenerationBody = { family: "generation", medium, purpose, prompt, references: [...references, ...voice.references], exclusions,
        options: [{ label: "Production", value: action.productionId }, ...inputs.map(input => ({ label: `Voice and route: ${input.target.id}`,
          value: JSON.stringify({ provider: input.provider, model: input.model, voice: input.params.voiceId ?? null,
            settings: input.params.voiceSettings ?? null, script: input.params.referenceScript ?? null,
            duration: input.params.durationSec ?? null, estimatedMicroUsd: input.estimatedMicroUsd }) }))],
        provider: [...new Set(inputs.map(input => input.provider))].join(", ") || "Local media tools",
        model: [...new Set(inputs.map(input => input.model))].join(", ") || "PCM preparation", quantity: Math.max(1, inputs.length), output, cost: "Pending quote",
        privacy: [...(inputs.length ? ["The shown text and referenced media go to the configured provider runtimes."] : ["Source preparation runs on this device."]), ...voice.privacy],
        cancellationSupported: inputs.length > 0 };
      return { inputs, body, authority: { source: authority, voicePins: voice.pins, voicePrivacy: voice.privacy }, materialization };
    },
    beforeDispatch: async (action, id, inputs, materialization) => {
      if (action.kind !== "production-audio-generation") throw new Error("The production audio request is unavailable.");
      await store.ensureSchemaVersion(PRODUCTION_AUDIO_CHAT_SCHEMA_VERSION, "production-chat-audio");
      await ports.confirmUploads(inputs, id);
      if (action.request.operation === "performance") await retainPerformanceGenerationQuote(store, PerformanceGenerationQuoteSchema.parse(materialization));
      if (action.request.operation === "prepare-voice-sample" && !await readDelivery(id)) {
        if (!ports.tools) throw new Error("Local audio preparation is unavailable.");
        const review = await prepareCharacterSample(store, ports.tools, { kind: "prepare-character-voice-sample", worldId: store.worldId,
          requestId: id.slice(4), ...action.request }, { operationId: productionAudioOperationId(id) });
        await store.ownedWrite(() => atomicWriteFile(deliveryPath(id), JSON.stringify(review)));
      }
    },
    reconcile: async (card, action) => {
      if (action.kind !== "production-audio-generation" || action.request.operation !== "prepare-voice-sample") return undefined;
      let review = await readDelivery(card.actionId);
      if (!review) {
        review = await resumeCharacterSample(store, action.request.sheetId, productionAudioOperationId(card.actionId)).catch(() => null);
        if (!review) return { status: "running", detail: "Local sample preparation needs reconciliation; it was not repeated." };
        await store.ownedWrite(() => atomicWriteFile(deliveryPath(card.actionId), JSON.stringify(review)));
      }
      return { status: "completed", receipt: { kind: "voice-sample-preparation", id: review.operationId,
        summary: "Sample prepared; audition, quality and rights remain human decisions." } };
    },
  };
}

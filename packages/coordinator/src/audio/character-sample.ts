import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CharacterVoiceSampleSchema, ReferenceKitSchema, SlugSchema, VoiceSampleReviewSchema,
  estimateMicroUsd, supportsCharacterSpeakingVideo, type ClientMessage, type ManifestModel, type VoiceSampleReview } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { readKit } from "../references/kit.js";
import { sha256 } from "../world/text-files.js";
import { appendAudioRights } from "./rights.js";
import { acceptPreparedAudio, audioWorldPath, prepareAudio, resolveAudioSource, type PreparedAudioCandidate } from "./storage.js";
import type { AudioMediaTools } from "./media-tools.js";

type Prepare = Extract<ClientMessage, { kind: "prepare-character-voice-sample" }>;
type Accept = Extract<ClientMessage, { kind: "accept-character-voice-sample" }>;
const contextPath = (operation: string) => `.staging/audio/${operation}/character.json`;
function character(store: WorldStore, id: string) {
  SlugSchema.parse(id);
  const sheet = store.getBundle().sheets.find(s => s.id === id && s.type === "character");
  if (!sheet) throw new Error("Choose a current character.");
  return sheet;
}

export async function prepareCharacterSample(store: WorldStore, tools: AudioMediaTools, request: Prepare): Promise<VoiceSampleReview> {
  character(store, request.sheetId);
  if (request.source.kind === "legacy-character-sample" && request.source.sheetId !== request.sheetId) throw new Error("audio-candidate-invalid");
  const base = await readKit(store, request.sheetId);
  const candidate = await prepareAudio(store, tools, request.source);
  const resolved = await resolveAudioSource(store, request.source);
  const review = VoiceSampleReviewSchema.parse({ operationId: candidate.operationId, sheetId: request.sheetId,
    sourceFile: resolved.file, preparedFile: candidate.stagedFile, provenance: candidate.provenance });
  await store.ownedWrite(async () => {
    await writeFile(await audioWorldPath(store.dir, contextPath(candidate.operationId), true), JSON.stringify({
      worldId: store.worldId, sheetId: request.sheetId, baseHash: base ? sha256(base.raw) : null, candidate,
    }), { flag: "wx" });
  });
  return review;
}

export async function resumeCharacterSample(store: WorldStore, sheetId: string, operationId: string): Promise<VoiceSampleReview> {
  character(store, sheetId);
  const context = JSON.parse(await readFile(await audioWorldPath(store.dir, contextPath(operationId)), "utf8")) as {
    worldId: string; sheetId: string; candidate: PreparedAudioCandidate;
  };
  if (context.worldId !== store.worldId || context.sheetId !== sheetId || context.candidate.operationId !== operationId) throw new Error("audio-candidate-invalid");
  const source = await resolveAudioSource(store, context.candidate.request);
  if (JSON.stringify(source.source) !== JSON.stringify(context.candidate.provenance.source)) throw new Error("audio-source-changed");
  await audioWorldPath(store.dir, context.candidate.stagedFile);
  return VoiceSampleReviewSchema.parse({ operationId, sheetId, sourceFile: source.file,
    preparedFile: context.candidate.stagedFile, provenance: context.candidate.provenance });
}

export async function acceptCharacterSample(store: WorldStore, request: Accept): Promise<void> {
  character(store, request.sheetId);
  const assigned = (await readKit(store, request.sheetId))?.kit.designatedVoiceSample;
  if (assigned && "schemaVersion" in assigned && assigned.operationId === request.operationId) return;
  const context = JSON.parse(await readFile(await audioWorldPath(store.dir, contextPath(request.operationId)), "utf8")) as {
    worldId: string; sheetId: string; baseHash: string | null; candidate: PreparedAudioCandidate;
  };
  if (context.worldId !== store.worldId || context.sheetId !== request.sheetId || context.candidate.operationId !== request.operationId) {
    throw new Error("This sample belongs to a different character.");
  }
  const report = context.candidate.provenance.qualityReport;
  const warnings = Object.values(report.checks).filter(c => c.outcome === "warning").map(c => c.code);
  if (Object.values(report.checks).some(c => c.outcome === "hard-incompatibility") || warnings.some(w => !request.warningCodes.includes(w))) {
    throw new Error("Review and acknowledge the audio warnings before assigning.");
  }
  if (!request.singleSpeaker || !request.noMusic) throw new Error("Confirm one speaker and no music for this voice reference.");
  const hash = context.candidate.provenance.outputHash, at = new Date().toISOString();
  const acknowledgementId = request.rightsBasis ? randomUUID() : undefined;
  if (request.rightsBasis && acknowledgementId) await appendAudioRights(store, { schemaVersion: 1, action: "acknowledge",
    id: acknowledgementId, audioHash: hash, basis: request.rightsBasis, scopes: ["cloud-reference-upload"], statementVersion: 1, at });
  await acceptPreparedAudio(store, context.candidate, `references/${request.sheetId}/voice`, (file, provenance) => {
    const current = store.getBundle().referenceKits.find(k => k.sheetId === request.sheetId);
    const kit = ReferenceKitSchema.parse(current ?? { sheetId: request.sheetId, tiles: [] });
    kit.designatedVoiceSample = CharacterVoiceSampleSchema.parse({ schemaVersion: 1, operationId: request.operationId,
      file: file.slice(`references/${request.sheetId}/`.length), provenance, designatedAt: at, warningCodes: warnings,
      attestations: ["single-speaker", "no-music"].map(kind => ({ kind, audioHash: hash, statementVersion: 1, acknowledgedAt: at })),
      ...(acknowledgementId ? { acknowledgementId } : {}) });
    return { kind: "character-voice-sample", source: "user", requestId: request.requestId, files: [{
      path: `references/${request.sheetId}/kit.json`, action: context.baseHash === null ? "create" : "replace",
      baseHash: context.baseHash, content: JSON.stringify(kit, null, 2) + "\n",
    }] };
  });
}

export async function clearCharacterSample(store: WorldStore, sheetId: string, expectedHash: string): Promise<void> {
  character(store, sheetId);
  await store.gateOp(async () => {
    const base = await readKit(store, sheetId), sample = base?.kit.designatedVoiceSample;
    if (!base || !sample || ("schemaVersion" in sample ? sample.provenance.outputHash : sample.file) !== expectedHash) {
      throw new Error("The assigned sample changed. Reload before clearing it.");
    }
    delete base.kit.designatedVoiceSample;
    await store.commitUnserialised({ kind: "character-voice-sample", source: "user", files: [{
      path: `references/${sheetId}/kit.json`, action: "replace", baseHash: sha256(base.raw), content: JSON.stringify(base.kit, null, 2) + "\n",
    }] });
  });
}

export async function withdrawCharacterSample(store: WorldStore, sheetId: string, expectedHash: string): Promise<void> {
  const sample = (await readKit(store, sheetId))?.kit.designatedVoiceSample;
  if (!sample || !("schemaVersion" in sample) || sample.provenance.outputHash !== expectedHash || !sample.acknowledgementId) {
    throw new Error("No matching cloud authorization is assigned.");
  }
  await appendAudioRights(store, { schemaVersion: 1, action: "withdraw", acknowledgementId: sample.acknowledgementId,
    audioHash: expectedHash, at: new Date().toISOString() });
}

export function characterSpeakingRequest(store: WorldStore, model: ManifestModel,
  request: Extract<ClientMessage, { kind: "generate-character-voice-sample" }>): EnqueueInput {
  const sheet = character(store, request.sheetId);
  const kit = store.getBundle().referenceKits.find(k => k.sheetId === sheet.id);
  const photo = kit?.mainPhoto?.file ?? kit?.anchor;
  if (!supportsCharacterSpeakingVideo(model) || !photo || !model.limits.durations?.[String(request.durationSec)]) {
    throw new Error("Choose a supported speech-video model, duration and accepted character photo.");
  }
  const resolution = model.limits.resolutions?.[0] ?? "720p";
  /*
   * Portrait where the route offers it (issue 863). A speaking sample is one face to camera, and
   * a character's accepted photo is always a portrait — `imageOutputFor` never draws a main photo
   * landscape. The landscape default this used to hardcode was harmless while every route carried
   * the photo as one *reference* among nine, and stopped being harmless the moment a route bound
   * it as the actual first frame: cover-cropping a 1024×1280 headshot into 864×480 takes the
   * middle band and cuts the top of the head off, which is not a sample of anybody.
   */
  const aspect = model.limits.aspects?.includes("9:16") === true ? "9:16" : "16:9";
  const estimatedMicroUsd = estimateMicroUsd(model, { durationSec: request.durationSec, resolution });
  if (estimatedMicroUsd !== request.confirmedMicroUsd) throw new Error("The estimate changed. Review the current price before generating.");
  const bundle = store.getBundle();
  return { worldId: store.worldId, target: { kind: "character-voice-sample", id: `${sheet.id}/${request.requestId}` },
    capability: "video", provider: model.provider, model: model.id, estimatedMicroUsd,
    params: { prompt: `${sheet.name}, the character in @Image1, speaks naturally to camera. A clean isolated voice, one speaker, no music. Speak exactly this reference script:\n${request.script}`,
      referenceScript: request.script, characterName: sheet.name, references: [`references/${sheet.id}/${photo}`],
      durationSec: request.durationSec, resolution, aspect,
      // Asked for only where a switch exists (the bench's own rule): a route that always makes
      // sound has nothing to turn on, and a param it never reads would sit in the durable job
      // row implying it did.
      ...(model.limits.soundChoice === true ? { generate_audio: true } : {}),
      provenance: { canonRevision: bundle.meta.canonRevision, sheets: { [sheet.id]: sheet.version } } },
    landing: { dir: `references/${sheet.id}/incoming`, name: `voice-sample-${request.requestId}.mp4` } };
}

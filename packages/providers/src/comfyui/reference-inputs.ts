import { createHash } from "node:crypto";
import { CharacterAudioPlanSchema, characterAudioRoute, referenceAudioAsset, ReferenceMediaBindingsSchema } from "@arke-studio/contracts";
import type { SubmitRequest } from "../types.js";
import { ProviderRequestRejectedError } from "../types.js";
import type { ComfyUiRecipe } from "./recipes.js";

/** Validate every kind before the first upload. Local audio clearance does not authorize a
 * remote engine, and a prepared frame tensor's timing must never be inferred from its suffix. */
export function multimediaInputs(recipe: ComfyUiRecipe, request: SubmitRequest, locality: "local" | "remote") {
  const videos = request.videoReferences ?? [], standalone = request.mediaAudioReferences ?? [], voices = request.audioReferences ?? [];
  const fail = (message: string): never => { throw new ProviderRequestRejectedError(`comfyui: ${message}`); };
  if (request.videoSource) fail("this recipe does not extend video");
  if (videos.length > (recipe.referenceVideos?.length ?? 0)) fail("this recipe cannot carry these video references");
  if (standalone.length + voices.length > (recipe.referenceAudio?.length ?? 0)) fail("this recipe cannot carry these audio references");
  const plan = request.params.audioReferences === undefined ? null : CharacterAudioPlanSchema.parse(request.params.audioReferences);
  if (plan?.problems.length || (plan?.disabled && (voices.length || plan.references.length)) || voices.length !== (plan?.references.length ?? 0)) fail("audio references do not match the reviewed plan");
  const videoPaths = request.params.videoReferences;
  if (!recipe.referenceVideos && !recipe.referenceAudio) {
    if (Array.isArray(videoPaths) && videoPaths.length) fail("this recipe takes no video references");
    if (request.params.referenceMedia !== undefined) fail("this recipe takes no standalone media references");
    return { videos, audio: [] };
  }
  const expectedVideos = (Array.isArray(videoPaths) ? videoPaths.length : 0) + (request.params.continuedFrom ? 1 : 0);
  if (videos.length !== expectedVideos) fail("a reviewed video reference did not arrive");
  if (locality !== "local" && (videos.length || standalone.length || voices.length)) fail("audio and video references require a local engine; local review does not authorize remote upload");
  if (request.params.taskMode !== undefined && !["generate", "keyframe-sequence"].includes(String(request.params.taskMode))) fail("reference guidance is not a frame or continuation route");
  if (!(request.imageReferences?.length || videos.length || standalone.length || voices.length)) fail("reference-to-video needs at least one reference");
  if (request.params.sound === false || request.params.generate_audio === false) fail("this recipe always generates audio");
  if (videos.some(video => video.referenceVideo24fps !== true || video.contentType !== "video/mp4" || !Number.isFinite(video.durationSec) || video.durationSec! < 2 || video.durationSec! > 5.2)) fail("video references need verified 24 fps preparation and 2–5 second clips");
  if (videos.reduce((sum, video) => sum + video.durationSec!, 0) > 15) fail("video references exceed fifteen seconds");
  const bindings = ReferenceMediaBindingsSchema.safeParse(request.params.referenceMedia ?? []);
  if (!bindings.success) fail("invalid reviewed media bindings");
  const audioBindings = bindings.data!.filter(ref => ref.kind === "audio");
  if (standalone.length !== audioBindings.length) fail("a reviewed standalone audio reference did not arrive");
  for (const [index, clip] of standalone.entries()) {
    const hash = createHash("sha256").update(clip.data).digest("hex");
    if (typeof audioBindings[index]?.hash !== "string" || audioBindings[index]!.hash.replace(/^sha256:/, "") !== hash) fail("standalone audio changed since review");
  }
  if (voices.length) {
    const route = characterAudioRoute({ provider: "comfyui", id: recipe.id });
    if (!route || plan?.route !== route.endpoint || plan.references.some(ref => ref.intent !== "voice-reference")) fail("unsupported character audio route or intent");
    for (const [index, clip] of voices.entries()) {
      const frozen = plan!.references[index]!;
      if (frozen.label !== `@Audio${index + 1}` || referenceAudioAsset(frozen).provenance.outputHash !== `sha256:${createHash("sha256").update(clip.data).digest("hex")}`) fail("character audio changed since review");
    }
  }
  const audio = [...standalone, ...voices.map((clip, index) => ({ ...clip, durationSec: referenceAudioAsset(plan!.references[index]!).provenance.outputTechnical.durationSec ?? Infinity }))];
  if (audio.some(clip => !["audio/wav", "audio/mpeg"].includes(clip.contentType) || !clip.data.length || clip.data.length > 15_000_000 || !Number.isFinite(clip.durationSec) || clip.durationSec <= 0 || clip.durationSec > 5.2)) fail("audio references must be WAV or MP3, at most 15 MB and five seconds each");
  if (audio.reduce((sum, clip) => sum + clip.durationSec, 0) > 15) fail("audio references exceed fifteen seconds");
  return { videos, audio };
}

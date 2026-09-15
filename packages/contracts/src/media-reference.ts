import { z } from "zod";
import type { ManifestModel } from "./manifest.js";
import { CharacterAudioPlanSchema, referenceAudioAsset } from "./audio-reference.js";

/** A reviewed media selection is durable; decoded or normalized bytes never are.
 * Existing artifact sidecars use a 16-digit SHA-256 prefix; newer files keep the full digest. */
export const ReferenceMediaBindingsSchema = z.array(z.object({
  kind: z.enum(["video", "audio"]), file: z.string().min(1),
  hash: z.string().regex(/^(sha256:)?(?:[a-f0-9]{16}|[a-f0-9]{64})$/), durationSec: z.number().positive(),
}).strict()).max(6);
export type ReferenceMediaBindings = z.infer<typeof ReferenceMediaBindingsSchema>;

/** Bench review and queue admission budget all audio together before a job becomes durable. */
export function referenceInputProblem(model: ManifestModel, params: Record<string, unknown>): string | null {
  if (model.limits.referenceSyntax !== "minimax-h3" && model.limits.referenceSyntax !== "seedance") return null;
  const media = ReferenceMediaBindingsSchema.safeParse(params.referenceMedia ?? []);
  const voices = CharacterAudioPlanSchema.safeParse(params.audioReferences ?? { version: 1, route: null, disabled: true, references: [], problems: [] });
  if (!media.success) return "Invalid reviewed media references.";
  if (params.audioReferences !== undefined && !voices.success) return "Invalid reviewed character audio.";
  const audio = media.data.filter(ref => ref.kind === "audio").map(ref => ref.durationSec);
  if (voices.success && !voices.data.disabled) audio.push(...voices.data.references.map(ref => referenceAudioAsset(ref).provenance.outputTechnical.durationSec ?? Infinity));
  const images = Array.isArray(params.references) ? params.references.length : 0;
  const videos = (Array.isArray(params.videoReferences) ? params.videoReferences.length : 0) + (params.continuedFrom ? 1 : 0);
  if (model.limits.referenceSyntax === "seedance") {
    if (audio.length && images + videos === 0) return "Seedance audio references need an image or video reference.";
    if (images + videos + audio.length > (model.limits.maxCombinedReferences ?? Infinity)) return "Too many combined references.";
    if (videos > (model.accepts.referenceVideos ?? 0)) return "Too many video references.";
    const duration = media.data.filter(ref => ref.kind === "video").reduce((sum, ref) => sum + ref.durationSec, 0);
    if (videos && (duration < (model.limits.minReferenceVideoSec ?? 0) || duration > (model.limits.maxReferenceVideoSec ?? Infinity)))
      return "Video references exceed the route's combined duration limits.";
  }
  if (model.limits.referenceSyntax === "minimax-h3" && images + videos + audio.length === 0) return "H3 Reference Video needs at least one image, video or audio reference.";
  if (audio.length > (model.accepts.referenceAudio ?? 0)) return "Standalone audio and character voices exceed the route's audio reference budget.";
  if (audio.reduce((sum, duration) => sum + duration, 0) > (model.limits.maxReferenceAudioSec ?? 0)) return "Standalone audio and character voices together exceed the route duration limit. Trim a reference before dispatch.";
  return null;
}

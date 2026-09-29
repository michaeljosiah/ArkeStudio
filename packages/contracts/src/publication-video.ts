import { z } from "zod";
import { ExportPresetSchema } from "./cut.js";
import { PublicationTextTrackSchema, type PublicationTextTrack } from "./publication.js";
import { buildRenderPlan, type RenderPlan, type RenderPlanInput, type RenderCue } from "./render-plan.js";
import { LanguageTagSchema } from "./subtitles.js";

const Name = z.string().trim().min(1).max(512);
export const VideoPublicationRequestSchema = z.object({
  productionId: Name,
  id: z.string().regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  edition: Name,
  title: Name,
  language: LanguageTagSchema,
  preset: ExportPresetSchema,
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("production") }).strict(),
    z.object({ kind: z.literal("episode"), episodeId: Name }).strict(),
  ]),
  timelineRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  textTracks: z.array(PublicationTextTrackSchema.omit({ asset: true, language: true }).extend({ trackId: Name }).strict()).max(64),
}).strict().superRefine((request, ctx) => {
  if (new Set(request.textTracks.map(track => track.trackId)).size !== request.textTracks.length) {
    ctx.addIssue({ code: "custom", path: ["textTracks"], message: "choose each subtitle track only once" });
  }
  if (request.textTracks.filter(track => track.default).length > 1) {
    ctx.addIssue({ code: "custom", path: ["textTracks"], message: "at most one text track may be default" });
  }
});
export type VideoPublicationRequest = z.infer<typeof VideoPublicationRequestSchema>;
export interface VideoPublicationPlan {
  render: RenderPlan;
  textTracks: Array<{ track: PublicationTextTrack; cues: RenderCue[] }>;
  /** Distinct world-relative inputs, sorted independently of their render order. */
  media: string[];
}

/** SPEC-048 R-9, R-19..R-23: clean picture and every sidecar use the existing projection. */
export function buildVideoPublicationPlan(
  input: Omit<RenderPlanInput, "scope" | "preset" | "subtitles">,
  request: VideoPublicationRequest,
): { ok: true; plan: VideoPublicationPlan } | { ok: false; reason: string } {
  const revision = input.timeline?.status === "ready" ? input.timeline.timeline.revision : null;
  if (request.timelineRevision !== revision) return { ok: false, reason: "The timeline revision changed; prepare the publication again." };
  if (input.production.meta.format !== "video") return { ok: false, reason: "This compiler supports video productions only." };
  if (input.production.routing !== null) return { ok: false, reason: "Interactive routing needs an interactive publication profile." };
  const renderInput = { ...input, scope: request.scope, preset: request.preset };
  const projected = buildRenderPlan(renderInput);
  if (!projected.ok) return projected;
  const render = projected.plan;
  if (!render.items.length || !Number.isFinite(render.totalSec) || render.totalSec <= 0) {
    return { ok: false, reason: "There is no picture to publish in this range." };
  }
  const missing = render.items.find(item => item.type === "slate");
  if (missing?.type === "slate") return { ok: false, reason: `Missing picture: ${missing.label}. Select usable footage before publishing.` };
  if (render.unmeasuredAudio?.length) return { ok: false, reason: `Unmeasured audio: ${render.unmeasuredAudio.map(item => item.label).join(", ")}. Measure or mute it before publishing.` };
  const textTracks: VideoPublicationPlan["textTracks"] = [];
  if (request.textTracks.length && input.timeline?.status !== "ready") return { ok: false, reason: "Selectable text tracks need a saved timeline." };
  for (const [index, choice] of request.textTracks.entries()) {
    // Asking the shared planner once per track also applies its episode clipping/rebasing.
    // There is no second cue clock, and the movie above never receives burn-in instructions.
    const selected = buildRenderPlan({ ...renderInput, subtitles: { trackId: choice.trackId, mode: "sidecar", sidecar: "vtt" } });
    if (!selected.ok) return selected;
    const subtitles = selected.plan.subtitles;
    if (!subtitles) return { ok: false, reason: `Subtitle track ${choice.trackId} did not resolve.` };
    for (const cue of subtitles.cues) {
      if (!Number.isFinite(cue.startSec) || !Number.isFinite(cue.endSec) || cue.startSec < 0 ||
        cue.endSec <= cue.startSec || cue.endSec > render.totalSec + 0.000001) {
        return { ok: false, reason: `Subtitle cue ${cue.id} is outside the delivered movie.` };
      }
      // A blank line ends a WebVTT cue. Refuse rather than silently dropping the remaining
      // author text, or interpreting it as another block after the shared serializer runs.
      if (cue.text.includes("\0") || /\r|^[ \t]*\n|\n[ \t]*\n/.test(cue.text)) return { ok: false, reason: `Subtitle cue ${cue.id} contains a blank line or unsupported control character.` };
    }
    textTracks.push({ track: {
      asset: `text-${index}`, kind: choice.kind, language: subtitles.language, label: choice.label, default: choice.default,
    }, cues: subtitles.cues });
  }
  const media = [...new Set([
    ...render.items.flatMap(item => item.type === "clip" ? [item.path] : []),
    ...render.overlays.map(item => item.path), ...render.audio.map(item => item.path),
  ])].sort();
  return { ok: true, plan: { render, textTracks, media } };
}

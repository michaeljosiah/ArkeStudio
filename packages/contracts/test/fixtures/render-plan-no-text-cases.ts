import {
  applyTimelineCommands,
  buildFfmpegArgs,
  buildRenderPlan,
  defaultEffectClip,
  seedEmptyPictureTimeline,
  seedStoryPictureTimeline,
  type ArtifactSidecar,
  type EffectAlphaInput,
  type ExportPreset,
  type ProductionBundle,
  type ProductionTimeline,
  type RenderArtifact,
  type RenderPlanInput,
  type Scene,
  type TimelineClip,
  type TimelineClipCommand,
} from "../../src/index.js";

/**
 * Timelines that hold no text, as inputs to `buildRenderPlan` (SPEC-065 R-40).
 *
 * A timeline with no text has to plan and encode exactly as it did before text existed, and
 * "exactly" is only checkable against something written down before the planner changed. These
 * are the inputs; `render-plan-no-text.json` beside this file is what they planned as, and what
 * FFmpeg was asked for, on the code as it stood before a text source was added. Between them
 * they reach each thing the planner branches on today: a take, a still, a slate and a hole on
 * the base; a second Picture track; a fade, a blend with opacity and a move; a crossfade; effects
 * on the composition, on a track and on one clip; typed sound; burned-in subtitles; the old cut's
 * overlays; and every delivery preset.
 *
 * One thing in the recording has been changed since, by hand and not by recording again: every
 * sound's chain gained the step that brings it to 48 kHz in two channels, when the export began
 * to mix at that whatever its first sound is (SPEC-038 R-51). It changes how a film's sound is
 * mixed with or without text, so it says nothing about R-40; everything else is as recorded.
 *
 * Nothing here may gain text. A case that needs it belongs in the text tests, where its plan is
 * expected to differ; a case added here later has no recording from before the change, so it
 * proves nothing about R-40.
 */
export interface RenderPlanNoTextCase {
  name: string;
  args: RenderPlanInput;
  /**
   * The effect plates an export of this plan is handed. A plan that goes through the compositor
   * refuses to encode without the list, empty or not, so the cases that reach it carry one as
   * the coordinator would build it: one row per composition effect group, one per picture.
   */
  effectAlpha?: readonly EffectAlphaInput[];
}

export interface RenderPlanNoTextRecord {
  name: string;
  plan: unknown;
  ffmpegArgs: string[];
}

/** Where the recorded FFmpeg arguments say the world, the output and the slate font are. */
export const NO_TEXT_EXPORT_PATHS = { worldDir: "/w", outFile: "/out.mp4", slateFont: "/font.ttf" } as const;

const AT = "2026-09-01T12:00:00Z";
const HASH = `sha256:${"a".repeat(64)}`;
const TAKE = "tk_01J8E0000000000000000000T1";
const LINE = "tk_01J8E0000000000000000000T2";
const PLATE = "ar_01J8G0000000000000000000A1";
const INSERT = "ar_01J8G0000000000000000000A2";
const BELLS = "ar_01J8G0000000000000000000A3";
const NOTES = "ar_01J8G0000000000000000000A4";
const DUSK = "ar_01J8G0000000000000000000A5";
const WIND = "ar_01J8G0000000000000000000A6";

/** The catalogue `render-plan.test.ts` plans against: nothing in it has been measured. */
const unmeasured: RenderArtifact[] = [
  { id: PLATE, file: "plate.png", kind: "image" },
  { id: INSERT, file: "insert.mp4", kind: "video", mediaInfo: { hasAudio: true, durationSec: 9 } },
  { id: BELLS, file: "bells.wav", kind: "audio" },
  { id: NOTES, file: "notes.md", kind: "document" },
];

/**
 * The same files measured, with a second still and a second sound. The compositor places a
 * picture by its measured size and refuses one without, so a case with a fade, a move or an
 * effect can only be encoded from this catalogue.
 */
const measured: RenderArtifact[] = [
  { id: PLATE, file: "plate.png", kind: "image", mediaInfo: { hasAudio: false, width: 1920, height: 1080 } },
  { id: INSERT, file: "insert.mp4", kind: "video", mediaInfo: { hasAudio: true, durationSec: 9, width: 1280, height: 720 } },
  { id: BELLS, file: "bells.wav", kind: "audio", mediaInfo: { hasAudio: true, durationSec: 30 } },
  { id: NOTES, file: "notes.md", kind: "document" },
  { id: DUSK, file: "dusk.png", kind: "image", mediaInfo: { hasAudio: false, width: 1080, height: 1920 } },
  { id: WIND, file: "wind.wav", kind: "audio", mediaInfo: { hasAudio: true, durationSec: 20 } },
];

/** A crossfade is only offered between two stills, which the editor reads from the sidecars. */
const stills: ArtifactSidecar[] = [
  { id: PLATE, kind: "image", file: "plate.png", hash: HASH, origin: { by: "user" }, links: [], created: AT },
  { id: DUSK, kind: "image", file: "dusk.png", hash: HASH, origin: { by: "user" }, links: [], created: AT },
];

function scene(id: string, order: number, shots: Array<{ id: string; durationSec?: number }>): Scene {
  return {
    id,
    number: order,
    order,
    slug: id.replace(/^sc_/, ""),
    title: id,
    status: "accepted",
    version: 1,
    shots: shots.map((shot, index) => ({
      id: shot.id,
      number: index + 1,
      title: shot.id,
      description: `Story beat ${shot.id}`,
      ...(shot.durationSec === undefined ? {} : { durationSec: shot.durationSec }),
    })),
  };
}

/** The production `render-plan.test.ts` builds, with its three overlays from the old cut. */
function production(over: Partial<ProductionBundle> = {}): ProductionBundle {
  return {
    rehearsals: [],
    performances: [],
    performanceReview: { reviews: [], selections: {}, reviewHash: null, selectionHash: null },
    meta: {
      id: "bell-watch",
      format: "video",
      title: "Bell Watch",
      status: "in-progress",
      frameRate: 25,
      failureModes: [],
      created: AT,
      updated: AT,
    },
    story: null,
    season: null,
    routing: null,
    treatment: null,
    chapters: [],
    scenes: [scene("sc_one", 1, [{ id: "sh_1", durationSec: 2 }, { id: "sh_2", durationSec: 1.5 }, { id: "sh_3" }])],
    sceneFiles: {},
    episodes: [],
    episodeFiles: {},
    takes: [
      {
        id: TAKE,
        jobId: "jb_01J8E0000000000000000000J1",
        coversShots: ["sh_1"],
        kind: "clip",
        provider: "fal",
        model: "seedance-2.0",
        provenance: { canonRevision: 1, sheets: {} },
        prompt: "a shot",
        references: [],
        params: {},
        cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
        dispatchedAt: AT,
        media: "clip.mp4",
      },
    ],
    reviews: [],
    selections: { sh_1: { acceptedTakeId: TAKE, trimInSec: 0 } },
    spine: null,
    cut: {
      audio: [],
      overlays: [
        { id: "ov_01J8G0000000000000000000B1", artifactId: PLATE, startSec: 1, endSec: 3, lane: 1, audio: "keep" },
        { id: "ov_01J8G0000000000000000000B2", artifactId: INSERT, startSec: 2.5, endSec: 4, lane: 0, audio: "keep" },
        { id: "ov_01J8G0000000000000000000B3", artifactId: NOTES, startSec: 0, endSec: 9, lane: 2, audio: "keep" },
      ],
    },
    editorRequests: [],
    takeMediaInfo: {},
    ...over,
  };
}

/**
 * The same production once its takes have been probed and its old overlays are gone: a second
 * take that is only a spoken line, and a size for the picture take so the compositor can place it.
 */
function probed(): ProductionBundle {
  const value = production({ cut: { audio: [], overlays: [] } });
  value.takes.push({ ...value.takes[0]!, id: LINE, jobId: "jb_01J8E0000000000000000000J2", coversShots: [], prompt: "a line", media: "line.wav" });
  value.takeMediaInfo = {
    [TAKE]: { sourceHash: HASH, probedAt: AT, mediaInfo: { durationSec: 6, hasAudio: true, width: 1920, height: 1080 } },
    [LINE]: { sourceHash: HASH, probedAt: AT, mediaInfo: { durationSec: 4, hasAudio: true } },
  };
  return value;
}

const artifactClip = (id: TimelineClip["id"], artifactId: string, label: string, startFrame: number, durationFrames: number): TimelineClip =>
  ({ id, startFrame, durationFrames, sourceInFrames: 0, source: { kind: "artifact", artifactId, label } });

/** Three kinds of sound on their own tracks, with one clip lowered and the mix moved off its defaults. */
const sound: TimelineClipCommand[] = [
  { kind: "add-track", trackId: "tr_dialogue", trackKind: "dialogue", name: "Dialogue", defaultRole: "dialogue" },
  { kind: "place", trackId: "tr_dialogue", clip: { id: "cl_line", startFrame: 25, durationFrames: 50, sourceInFrames: 25, source: { kind: "take", takeId: LINE, label: "The line" } } },
  { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music", defaultRole: "music" },
  { kind: "place", trackId: "tr_music", clip: artifactClip("cl_bells", BELLS, "Bells", 0, 200) },
  { kind: "set-clip-gain", clipId: "cl_bells", gainDb: -6 },
  { kind: "add-track", trackId: "tr_ambience", trackKind: "ambience", name: "Ambience" },
  { kind: "place", trackId: "tr_ambience", clip: { ...artifactClip("cl_wind", WIND, "Wind", 50, 125), sourceInFrames: 75 } },
  { kind: "set-clip-role", clipId: "cl_wind", role: "ambience" },
  { kind: "set-mix", mix: { duckingDb: -12, releaseMs: 250 } },
];

/**
 * The base of the larger cases: the story's three shots (a take and two slates), a hole, then
 * two stills that touch. Frames 0–50 are the take, 50–88 and 88–188 slates, 188–200 the hole.
 */
function storyThenStills(value: ProductionBundle): ProductionTimeline {
  return applyTimelineCommands(seedStoryPictureTimeline(value), [
    { kind: "place", trackId: "tr_picture", clip: artifactClip("cl_plate", PLATE, "Plate", 200, 75) },
    { kind: "place", trackId: "tr_picture", clip: artifactClip("cl_dusk", DUSK, "Dusk", 275, 75) },
  ]);
}

/** Cuts only: nothing that would send the film through the compositor. */
function stackedCut(value: ProductionBundle): ProductionTimeline {
  return applyTimelineCommands(storyThenStills(value), [
    { kind: "add-track", trackId: "tr_inserts", trackKind: "picture", name: "Inserts" },
    { kind: "place", trackId: "tr_inserts", clip: artifactClip("cl_card", DUSK, "Dusk card", 25, 50) },
    { kind: "place", trackId: "tr_inserts", clip: { ...artifactClip("cl_insert", INSERT, "Insert", 100, 60), sourceInFrames: 25 } },
    { kind: "set-clip-audio", clipId: "cl_insert", audio: "mute" },
    ...sound,
  ]);
}

/** A still on the second Picture track, dressed every way a picture can be today. */
function dressedStill(value: ProductionBundle): ProductionTimeline {
  const placed = applyTimelineCommands(storyThenStills(value), [
    { kind: "add-track", trackId: "tr_inserts", trackKind: "picture", name: "Inserts" },
    { kind: "place", trackId: "tr_inserts", clip: artifactClip("cl_card", DUSK, "Dusk card", 25, 100) },
    ...sound,
  ]);
  return applyTimelineCommands(placed, [
    { kind: "picture-fade", clipId: "cl_card", inFrames: 12, outFrames: 20 },
    { kind: "picture-appearance", clipId: "cl_card", patch: { blendMode: "screen", opacity: .5 } },
    { kind: "picture-motion", clipId: "cl_card", motion: { kind: "push-in", amount: .08 } },
  ], { effectAuthority: "human" });
}

/** Two touching stills and the blend between them, and nothing else. */
function crossfade(value: ProductionBundle): ProductionTimeline {
  const placed = applyTimelineCommands(seedEmptyPictureTimeline(value), [
    { kind: "place", trackId: "tr_picture", clip: artifactClip("cl_plate", PLATE, "Plate", 0, 75) },
    { kind: "place", trackId: "tr_picture", clip: artifactClip("cl_dusk", DUSK, "Dusk", 75, 75) },
  ]);
  return applyTimelineCommands(placed, [
    { kind: "transition-set", trackId: "tr_picture", leftClipId: "cl_plate", rightClipId: "cl_dusk", durationFrames: 24 },
  ], { effectAuthority: "human", sources: { production: value, artifacts: stills } });
}

/** The fixture of "freezes the entire picture stack" in `render-plan.test.ts`, with a track effect added. */
function effectCut(value: ProductionBundle): ProductionTimeline {
  return applyTimelineCommands(seedEmptyPictureTimeline(value), [
    { kind: "place", trackId: "tr_picture", clip: artifactClip("cl_base", PLATE, "Plate", 0, 100) },
    { kind: "add-track", trackId: "tr_insert", trackKind: "picture", name: "Insert" },
    { kind: "place", trackId: "tr_insert", clip: { ...artifactClip("cl_insert", INSERT, "Insert", 25, 50), sourceInFrames: 25 } },
    { kind: "add-track", trackId: "tr_effects", trackKind: "effect", name: "Effects" },
    { kind: "effect-create", trackId: "tr_effects", effect: defaultEffectClip({ id: "cl_whole", lineageId: "ef_whole", startFrame: 0, durationFrames: 500, seed: 71 }) },
    { kind: "effect-create", trackId: "tr_effects", effect: defaultEffectClip({ id: "cl_local", lineageId: "ef_local", startFrame: 0, durationFrames: 500, seed: 72, target: { kind: "visual-clip", clipId: "cl_base" } }) },
    { kind: "effect-create", trackId: "tr_effects", effect: defaultEffectClip({ id: "cl_track", lineageId: "ef_track", startFrame: 10, durationFrames: 60, seed: 73, preset: "air-particles", target: { kind: "picture-track", trackId: "tr_insert" } }) },
  ], { effectAuthority: "human" });
}

/** Every one of the above in one film, with subtitles, so each preset is asked for all of it. */
function everything(value: ProductionBundle): ProductionTimeline {
  const dressed = applyTimelineCommands(dressedStill(value), [
    { kind: "transition-set", trackId: "tr_picture", leftClipId: "cl_plate", rightClipId: "cl_dusk", durationFrames: 24 },
  ], { effectAuthority: "human", sources: { production: value, artifacts: stills } });
  return applyTimelineCommands(dressed, [
    { kind: "add-track", trackId: "tr_effects", trackKind: "effect", name: "Effects" },
    { kind: "effect-create", trackId: "tr_effects", effect: defaultEffectClip({ id: "cl_whole", lineageId: "ef_whole", startFrame: 0, durationFrames: 350, seed: 71 }) },
    { kind: "effect-create", trackId: "tr_effects", effect: defaultEffectClip({ id: "cl_local", lineageId: "ef_local", startFrame: 200, durationFrames: 75, seed: 72, target: { kind: "visual-clip", clipId: "cl_plate" } }) },
    { kind: "effect-create", trackId: "tr_effects", effect: defaultEffectClip({ id: "cl_track", lineageId: "ef_track", startFrame: 25, durationFrames: 100, seed: 73, preset: "air-particles", target: { kind: "picture-track", trackId: "tr_inserts" } }) },
    { kind: "add-subtitle-track", trackId: "tr_subs-en", name: "English", language: "en" },
    { kind: "add-cue", trackId: "tr_subs-en", cue: { id: "cu_1", text: "The bells again.", startFrame: 30, endFrame: 70 } },
    { kind: "add-cue", trackId: "tr_subs-en", cue: { id: "cu_2", text: "Listen.", startFrame: 210, endFrame: 250 } },
  ], { effectAuthority: "human" });
}

const ready = (timeline: ProductionTimeline) => ({ status: "ready" as const, timeline });
const whole = { kind: "production" as const };

/** The plain cut of "agrees with the FFmpeg graph" in `render-plan.test.ts`, old overlays and all. */
function plainCut(): RenderPlanNoTextCase {
  const value = production();
  const edited = applyTimelineCommands(seedStoryPictureTimeline(value), [
    { kind: "move-adjacent", clipId: "cl_sh-3", direction: "earlier" },
    { kind: "move-adjacent", clipId: "cl_sh-3", direction: "earlier" },
    { kind: "delete", clipId: "cl_sh-2" },
    { kind: "trim", clipId: "cl_sh-1", edge: "start", deltaFrames: 5 },
  ]);
  return { name: "plain cut, review-cut", args: { production: value, artifacts: unmeasured, timeline: ready(edited), scope: whole, preset: "review-cut" } };
}

/** The faded cut of "a move or an edge fade alone" in `render-plan.test.ts`. */
function fadedCut(): RenderPlanNoTextCase {
  const value = probed();
  const placed = applyTimelineCommands(seedEmptyPictureTimeline(value), [
    { kind: "place", trackId: "tr_picture", clip: artifactClip("cl_plate", PLATE, "Plate", 0, 72) },
    { kind: "place", trackId: "tr_picture", clip: artifactClip("cl_insert", INSERT, "Insert", 72, 48) },
  ]);
  const faded = applyTimelineCommands(placed, [{ kind: "picture-fade", clipId: "cl_insert", outFrames: 12 }], { effectAuthority: "human" });
  return { name: "faded cut, vertical-master", args: { production: value, artifacts: measured, timeline: ready(faded), scope: whole, preset: "vertical-master" }, effectAlpha: [] };
}

/**
 * One plate for the composition's effects and one for each picture an effect is matted to, at
 * the frames the effect runs. The paths name nothing on disk: the arguments only quote them.
 */
const effectCutPlates: EffectAlphaInput[] = [
  { path: "/cache/effects/composition.mov", startFrame: 0, endFrame: 100 },
  { pictureClipId: "cl_base", path: "/cache/effects/cl_base.mov", startFrame: 0, endFrame: 100 },
  { blendMode: "screen", pictureClipId: "cl_insert", path: "/cache/effects/cl_insert.mov", startFrame: 25, endFrame: 70 },
];
const everythingPlates: EffectAlphaInput[] = [
  { path: "/cache/effects/composition.mov", startFrame: 0, endFrame: 350 },
  { pictureClipId: "cl_plate", path: "/cache/effects/cl_plate.mov", startFrame: 200, endFrame: 275 },
  { blendMode: "screen", pictureClipId: "cl_card", path: "/cache/effects/cl_card.mov", startFrame: 25, endFrame: 125 },
];
const burned = { trackId: "tr_subs-en", mode: "burn-in" as const };

function everythingAt(preset: ExportPreset): RenderPlanNoTextCase {
  const value = probed();
  return {
    name: `everything, ${preset}`,
    args: { production: value, artifacts: measured, timeline: ready(everything(value)), scope: whole, preset, subtitles: burned },
    effectAlpha: everythingPlates,
  };
}

/** One episode is the whole film's plan cut to its frames, which is a second path through the planner. */
function everythingInOneEpisode(): RenderPlanNoTextCase {
  const value = probed();
  value.episodes = [{ id: "ep_one", version: 1, order: 1, title: "One", scenes: ["sc_one"] }];
  return {
    name: "everything, one episode, master",
    args: { production: value, artifacts: measured, timeline: ready(everything(value)), scope: { kind: "episode", episodeId: "ep_one" }, preset: "master", subtitles: burned },
    effectAlpha: everythingPlates,
  };
}

function build(): RenderPlanNoTextCase[] {
  const stacked = probed(), dressed = probed(), blended = probed(), effects = probed();
  return [
    plainCut(),
    { name: "no timeline yet, master", args: { production: production(), artifacts: unmeasured, timeline: { status: "absent" }, scope: whole, preset: "master" } },
    { name: "stacked cut with sound, master", args: { production: stacked, artifacts: measured, timeline: ready(stackedCut(stacked)), scope: whole, preset: "master" } },
    fadedCut(),
    { name: "dressed still, social-excerpt", args: { production: dressed, artifacts: measured, timeline: ready(dressedStill(dressed)), scope: whole, preset: "social-excerpt" }, effectAlpha: [] },
    { name: "crossfade, master", args: { production: blended, artifacts: measured, timeline: ready(crossfade(blended)), scope: whole, preset: "master" }, effectAlpha: [] },
    { name: "effect cut, review-cut", args: { production: effects, artifacts: measured, timeline: ready(effectCut(effects)), scope: whole, preset: "review-cut" }, effectAlpha: effectCutPlates },
    everythingAt("review-cut"),
    everythingAt("master"),
    everythingAt("vertical-master"),
    everythingAt("social-excerpt"),
    everythingInOneEpisode(),
  ];
}

export const RENDER_PLAN_NO_TEXT_CASES: readonly RenderPlanNoTextCase[] = build();

/**
 * Plan one case and ask for its FFmpeg arguments, as the recording did. The plan goes through
 * JSON so an absent field and an undefined one compare the same, which is how the file holds it.
 */
export function replayNoTextCase(entry: RenderPlanNoTextCase): RenderPlanNoTextRecord {
  const result = buildRenderPlan(entry.args);
  if (!result.ok) throw new Error(`${entry.name} no longer plans: ${result.reason}`);
  const { worldDir, outFile, slateFont } = NO_TEXT_EXPORT_PATHS;
  const ffmpegArgs = entry.effectAlpha === undefined
    ? buildFfmpegArgs(result.plan, worldDir, outFile, slateFont)
    : buildFfmpegArgs(result.plan, worldDir, outFile, slateFont, entry.effectAlpha);
  const plan: unknown = JSON.parse(JSON.stringify(result.plan));
  return { name: entry.name, plan, ffmpegArgs };
}

/** Keys in one order whatever order the planner wrote them in, so the file only moves when a value does. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, inner]) => [key, sorted(inner)]));
}

/** The whole recording as the file holds it: two-space indent, LF, one trailing newline. */
export function renderPlanNoTextRecording(cases: readonly RenderPlanNoTextCase[] = RENDER_PLAN_NO_TEXT_CASES): string {
  return `${JSON.stringify(sorted(cases.map(replayNoTextCase)), null, 2)}\n`;
}

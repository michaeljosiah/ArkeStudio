import { z } from "zod";

/**
 * Where a micro drama will be watched (design turn 205, SPEC-052 R-6..R-10). It comes first because it
 * sets the rest: the global apps' paywall earns little in Nigeria, where the vertical drama that broke
 * out was free (docs/research/african-short-drama.md). Every number a preset fills stays the author's.
 */
export const TARGET_AUDIENCES = ["nigeria-free-vertical", "global-app", "east-africa", "south-africa", "francophone", "custom"] as const;
export const TargetAudienceSchema = z.enum(TARGET_AUDIENCES);
export type TargetAudience = z.infer<typeof TargetAudienceSchema>;

export const TARGET_RELEASES = ["daily", "twice-weekly", "weekly", "all-at-once"] as const;
export const TargetReleaseSchema = z.enum(TARGET_RELEASES);
export type TargetRelease = z.infer<typeof TargetReleaseSchema>;

/**
 * The Target beside a season's defaults: the audience, the episodes before a paywall (`all` when
 * nothing is paid for), the release cadence, the dialogue's languages, and the length an episode is
 * aimed at. The count and the length's range are the season defaults (`episodeCount`,
 * `episodeSecondsMin`, `episodeSecondsMax`), so nothing is said twice.
 */
export const ProductionTargetSchema = z
  .object({
    audience: TargetAudienceSchema,
    free: z.union([z.literal("all"), z.number().int().min(0).max(500)]),
    release: TargetReleaseSchema,
    language: z.object({ dialogue: z.array(z.string().trim().min(1).max(40)).max(6), subtitles: z.boolean() }).strict(),
    /** The length an episode is aimed at, inside the defaults' range: "about 90 s". */
    episodeSeconds: z.number().positive().max(3600),
    /** The episodes of the whole adaptation; a season holds at most fifty, its `episodeCount` (R-10). */
    episodes: z.number().int().min(1).max(500),
  })
  .strict();
export type ProductionTarget = z.infer<typeof ProductionTargetSchema>;

export interface TargetPreset {
  label: string;
  episodes: { min: number; max: number; target: number };
  seconds: { min: number; max: number; target: number };
  free: number | "all";
  release: TargetRelease;
  language: { dialogue: string[]; subtitles: boolean };
}

/**
 * The presets (SPEC-052 R-7), from docs/research. About 90 seconds is the default the owner set
 * (D2) and moves with the preset; the free counts for the global apps and South Africa are the
 * global norm, since no African figure was published.
 */
export const TARGET_PRESETS: Record<Exclude<TargetAudience, "custom">, TargetPreset> = {
  "nigeria-free-vertical": { label: "Nigeria · free vertical", episodes: { min: 40, max: 60, target: 50 }, seconds: { min: 60, max: 90, target: 90 }, free: "all", release: "daily", language: { dialogue: ["English", "Pidgin"], subtitles: true } },
  "global-app": { label: "Global app", episodes: { min: 60, max: 100, target: 80 }, seconds: { min: 60, max: 120, target: 90 }, free: 8, release: "all-at-once", language: { dialogue: ["English"], subtitles: false } },
  "east-africa": { label: "East Africa", episodes: { min: 30, max: 60, target: 45 }, seconds: { min: 120, max: 180, target: 150 }, free: "all", release: "daily", language: { dialogue: ["English", "Swahili"], subtitles: true } },
  "south-africa": { label: "South Africa", episodes: { min: 50, max: 70, target: 60 }, seconds: { min: 60, max: 180, target: 120 }, free: 8, release: "daily", language: { dialogue: ["English"], subtitles: false } },
  francophone: { label: "Francophone", episodes: { min: 5, max: 12, target: 10 }, seconds: { min: 180, max: 360, target: 270 }, free: "all", release: "weekly", language: { dialogue: ["French"], subtitles: false } },
};

export const TARGET_AUDIENCE_LABEL: Record<TargetAudience, string> = {
  ...Object.fromEntries(Object.entries(TARGET_PRESETS).map(([key, preset]) => [key, preset.label])) as Record<Exclude<TargetAudience, "custom">, string>,
  custom: "Custom",
};
export const TARGET_RELEASE_LABEL: Record<TargetRelease, string> = { daily: "daily", "twice-weekly": "twice a week", weekly: "weekly", "all-at-once": "all at once" };

/** A season holds at most 50 episodes (SPEC-052 R-10); the rest is planned as further seasons. */
export const SEASON_EPISODE_MAX = 50;

/** The Target and the season defaults a preset fills (R-6), the hook window left as the defaults have it. */
export function presetTarget(audience: Exclude<TargetAudience, "custom">): {
  target: ProductionTarget;
  defaults: { episodeCount: number; episodeSecondsMin: number; episodeSecondsMax: number };
} {
  const preset = TARGET_PRESETS[audience];
  return {
    target: { audience, free: preset.free, release: preset.release, language: { dialogue: [...preset.language.dialogue], subtitles: preset.language.subtitles }, episodeSeconds: preset.seconds.target, episodes: preset.episodes.target },
    defaults: { episodeCount: Math.min(preset.episodes.target, SEASON_EPISODE_MAX), episodeSecondsMin: preset.seconds.min, episodeSecondsMax: preset.seconds.max },
  };
}

/** How a preset reads in its menu: `40–60 × 60–90 s · free`. */
export function presetLine(audience: Exclude<TargetAudience, "custom">): string {
  const preset = TARGET_PRESETS[audience];
  // Minutes only when both ends are whole minutes of two or more; otherwise both in seconds.
  const minutes = preset.seconds.min >= 120 && preset.seconds.min % 60 === 0 && preset.seconds.max % 60 === 0;
  const range = minutes ? `${preset.seconds.min / 60}–${preset.seconds.max / 60} min` : `${preset.seconds.min}–${preset.seconds.max} s`;
  return `${preset.episodes.min}–${preset.episodes.max} × ${range} · ${preset.free === "all" ? "free" : `${preset.free} free`}`;
}

/**
 * What each row comes to, at its end (R-9): seasons, total minutes, the paywall, the weeks of
 * release, and whether it is subtitled.
 */
export function targetEnds(target: ProductionTarget): { seasons: string; minutes: string; free: string; weeks: string; language: string } {
  const count = Math.max(1, Math.round(target.episodes));
  const seasons = Math.ceil(count / SEASON_EPISODE_MAX);
  const perWeek = target.release === "daily" ? 7 : target.release === "twice-weekly" ? 2 : target.release === "weekly" ? 1 : null;
  const weeks = perWeek === null ? null : Math.ceil(count / perWeek);
  return {
    seasons: `${seasons} season${seasons === 1 ? "" : "s"}`,
    minutes: `${Math.round((count * target.episodeSeconds) / 60)} min`,
    free: target.free === "all" ? "no paywall" : target.free === 0 ? "all paid" : "then paid",
    weeks: weeks === null ? "one drop" : `${weeks} week${weeks === 1 ? "" : "s"}`,
    language: target.language.subtitles ? "subtitled" : "",
  };
}

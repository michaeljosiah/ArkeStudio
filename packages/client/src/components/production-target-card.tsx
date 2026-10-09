import {
  SEASON_EPISODE_MAX, TARGET_AUDIENCE_LABEL, TARGET_PRESETS, TARGET_RELEASES, TARGET_RELEASE_LABEL, presetLine, presetTarget, targetEnds,
  type ProductionSetupDraft, type ProductionTarget, type TargetAudience, type TargetRelease,
} from "@arke-studio/contracts";

type Defaults = NonNullable<ProductionSetupDraft["defaults"]>;
type Update = (fields: { target?: ProductionTarget | null; defaults?: Defaults | null }) => void;

const PRESET_KEYS = Object.keys(TARGET_PRESETS) as Array<Exclude<TargetAudience, "custom">>;
const FREE_CHOICES = [0, 3, 5, 8, 10, 15, 20];

/**
 * The Target (design turn 205, SPEC-052 R-6..R-9): where a micro drama will be watched, first,
 * because it sets the rest; then each number it filled, the author's to change, with what it comes
 * to at the row's end. A preset sets the season defaults too, so the count and length are said once.
 */
export function ProductionTargetCard({ draft, update, disabled }: { draft: ProductionSetupDraft; update: Update; disabled: boolean }) {
  const target = draft.target;
  const defaults = draft.defaults ?? {};
  const ends = target ? targetEnds(target) : null;
  const choose = (audience: TargetAudience) => {
    if (audience === "custom") {
      if (target) update({ target: { ...target, audience } });
      return;
    }
    const preset = presetTarget(audience);
    update({ target: preset.target, defaults: { ...defaults, ...preset.defaults } });
  };
  const set = (patch: Partial<ProductionTarget>) => target && update({ target: { ...target, ...patch } });
  return (
    <section className="fy-production-target" aria-label="Target">
      <h3>Target</h3>
      <div className="fy-production-target__row">
        <label htmlFor="target-audience">Audience</label>
        <select id="target-audience" disabled={disabled} value={target?.audience ?? ""} onChange={event => choose(event.target.value as TargetAudience)}>
          {!target && <option value="" disabled>Choose where it will be watched</option>}
          {PRESET_KEYS.map(key => <option key={key} value={key}>{TARGET_AUDIENCE_LABEL[key]} · {presetLine(key)}</option>)}
          <option value="custom" disabled={!target}>Custom</option>
        </select>
      </div>
      {target && <>
        <div className="fy-production-target__row">
          <label htmlFor="target-episodes">Episodes</label>
          <input id="target-episodes" type="number" min={1} max={500} disabled={disabled} key={`episodes-${draft.revision}`} defaultValue={target.episodes}
            onBlur={event => {
              const value = Math.round(Number(event.target.value));
              // The whole adaptation's count; the first season holds at most fifty of them (R-10).
              if (value >= 1 && value !== target.episodes) update({ target: { ...target, episodes: value }, defaults: { ...defaults, episodeCount: Math.min(value, SEASON_EPISODE_MAX) } });
            }} />
          <span className="fy-production-target__end">{ends?.seasons}</span>
        </div>
        <div className="fy-production-target__row">
          <label htmlFor="target-length">Length · s</label>
          <input id="target-length" type="number" min={5} max={3600} disabled={disabled} key={`length-${draft.revision}`} defaultValue={target.episodeSeconds}
            onBlur={event => {
              const value = Number(event.target.value);
              if (!(value > 0) || value === target.episodeSeconds) return;
              // The aim stays inside the range the defaults hold, which widens to take it.
              update({ target: { ...target, episodeSeconds: value }, defaults: {
                ...defaults, episodeSecondsMin: Math.min(defaults.episodeSecondsMin ?? value, value), episodeSecondsMax: Math.max(defaults.episodeSecondsMax ?? value, value),
              } });
            }} />
          <span className="fy-production-target__end">{ends?.minutes}</span>
        </div>
        <div className="fy-production-target__row">
          <label htmlFor="target-free">Free</label>
          <select id="target-free" disabled={disabled} value={String(target.free)} onChange={event => set({ free: event.target.value === "all" ? "all" : Number(event.target.value) })}>
            <option value="all">All</option>
            {[...new Set([...FREE_CHOICES, ...(typeof target.free === "number" ? [target.free] : [])])].sort((a, b) => a - b).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <span className="fy-production-target__end">{ends?.free}</span>
        </div>
        <div className="fy-production-target__row">
          <label htmlFor="target-release">Release</label>
          <select id="target-release" disabled={disabled} value={target.release} onChange={event => set({ release: event.target.value as TargetRelease })}>
            {TARGET_RELEASES.map(release => <option key={release} value={release}>{TARGET_RELEASE_LABEL[release]}</option>)}
          </select>
          <span className="fy-production-target__end">{ends?.weeks}</span>
        </div>
        <div className="fy-production-target__row">
          <label htmlFor="target-language">Language</label>
          <input id="target-language" disabled={disabled} key={`language-${draft.revision}`} defaultValue={target.language.dialogue.join(", ")}
            onBlur={event => {
              const dialogue = event.target.value.split(",").map(part => part.trim()).filter(Boolean).slice(0, 6);
              if (dialogue.join(",") !== target.language.dialogue.join(",")) set({ language: { ...target.language, dialogue } });
            }} />
          <label className="fy-production-target__check">
            <input type="checkbox" disabled={disabled} checked={target.language.subtitles} onChange={event => set({ language: { ...target.language, subtitles: event.target.checked } })} />
            Subtitles
          </label>
        </div>
      </>}
    </section>
  );
}

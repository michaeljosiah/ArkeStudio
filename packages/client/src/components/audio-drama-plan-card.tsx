import { useEffect, useState } from "react";
import { DEFAULT_AUDIO_DRAMA_PLAN, type AudioDramaPlan } from "@arke-studio/contracts";
import { Lock } from "./icons.js";
import { Button } from "./ui.js";

/** How the narrator answer reads back: the words the author chose between, not the stored value. */
export const NARRATOR_LABEL: Record<NonNullable<AudioDramaPlan["narrator"]>, string> = {
  narrated: "Where the ear needs one",
  "in-the-room": "In the room",
};

export function pilotChapters(chapters: readonly number[]): string {
  if (chapters.length === 0) return "";
  // "chapters 1 and 2", never "chapter 1, 2" (issue 1883).
  return chapters.length === 1 ? `chapter ${chapters[0]}` : `chapters ${chapters.slice(0, -1).join(", ")} and ${chapters.at(-1)}`;
}

/** The pilot asked for as the author would ask it (issue 1883): Arke's guidance names the action. */
export function pilotAsk(pilot: { title: string; chapters: readonly number[] }): string {
  return `Draft the pilot scene, “${pilot.title}”${pilot.chapters.length ? `, from ${pilotChapters(pilot.chapters)},` : ""} as episode 1's script.`;
}

/**
 * An audio drama's plan in setup (design turn 230c, SPEC-057 R-7): one thing to accept or change,
 * never a list of steps. Arke proposes it after reading the story; Change edits the numbers and the
 * narrator in place, and anything larger — another pilot, another secret — is said to Arke.
 *
 * Every edit replaces the plan whole, because that is how the draft holds it: a field sent alone
 * would wipe the rest.
 */
export function AudioDramaPlanCard({ plan, disabled, onChange, editRequest = 0 }: {
  plan: AudioDramaPlan;
  disabled: boolean;
  onChange: (plan: AudioDramaPlan) => void;
  /** Raised by Change the plan under Arke's reply (230c): the card opens to edit. */
  editRequest?: number;
}) {
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (editRequest > 0) setEditing(true); }, [editRequest]);
  const untouched = plan.episodes === DEFAULT_AUDIO_DRAMA_PLAN.episodes && plan.minutes === DEFAULT_AUDIO_DRAMA_PLAN.minutes &&
    !plan.narrator && !plan.pilot && plan.keptFromListener.length === 0;
  // A number left empty or out of range keeps what was there; the schema's limits are the only ones.
  const commit = (field: "episodes" | "minutes", raw: string, max: number) => {
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 1 && value <= max && value !== plan[field]) onChange({ ...plan, [field]: value });
  };
  return (
    <section className="fy-ad-plan" aria-label="The plan">
      <header><h3>The plan</h3>{untouched && <small>default</small>}</header>
      {editing ? (
        <div className="fy-ad-plan__fields">
          <label>Episodes<input type="number" min={1} max={200} defaultValue={plan.episodes} disabled={disabled}
            onBlur={event => commit("episodes", event.target.value, 200)} /></label>
          <label>Minutes each<input type="number" min={1} max={180} defaultValue={plan.minutes} disabled={disabled}
            onBlur={event => commit("minutes", event.target.value, 180)} /></label>
          <label>Narrator<select value={plan.narrator ?? ""} disabled={disabled} onChange={event => {
            const { narrator: _old, ...rest } = plan;
            onChange(event.target.value ? { ...rest, narrator: event.target.value as NonNullable<AudioDramaPlan["narrator"]> } : rest);
          }}>
            <option value="">Not decided</option>
            <option value="narrated">{NARRATOR_LABEL.narrated}</option>
            <option value="in-the-room">{NARRATOR_LABEL["in-the-room"]}</option>
          </select></label>
        </div>
      ) : (
        <dl className="fy-ad-plan__kv">
          <dt>Episodes</dt><dd>{plan.episodes}, about {plan.minutes} minutes each</dd>
          <dt>Narrator</dt><dd>{plan.narrator ? NARRATOR_LABEL[plan.narrator] : "Not decided"}</dd>
          <dt>Pilot</dt><dd>{plan.pilot ? [plan.pilot.title, pilotChapters(plan.pilot.chapters)].filter(Boolean).join(" · ") : "Not chosen"}</dd>
        </dl>
      )}
      {plan.keptFromListener.length > 0 && (
        <div className="fy-ad-plan__kept">
          <span>Kept from the listener</span>
          {plan.keptFromListener.map((kept, index) => (
            <div key={`${index}:${kept.fact}`} className="fy-ad-plan__secret">
              <Lock size={13} />
              <span>{kept.fact}</span>
              {editing ? (
                <>
                  <label className="fy-ad-plan__until">until ep<input type="number" min={1} max={200} defaultValue={kept.revealEpisode} disabled={disabled}
                    aria-label={`Reveal episode for ${kept.fact}`}
                    onBlur={event => {
                      const value = Number(event.target.value);
                      if (!Number.isInteger(value) || value < 1 || value > 200 || value === kept.revealEpisode) return;
                      onChange({ ...plan, keptFromListener: plan.keptFromListener.map((item, at) => at === index ? { ...item, revealEpisode: value } : item) });
                    }} /></label>
                  <Button variant="ghost" size="sm" disabled={disabled} aria-label={`Stop keeping ${kept.fact}`}
                    onClick={() => onChange({ ...plan, keptFromListener: plan.keptFromListener.filter((_, at) => at !== index) })}>Remove</Button>
                </>
              ) : <small>until ep {kept.revealEpisode}</small>}
            </div>
          ))}
        </div>
      )}
      <div><Button size="sm" disabled={disabled} onClick={() => setEditing(open => !open)}>{editing ? "Done" : "Change"}</Button></div>
    </section>
  );
}

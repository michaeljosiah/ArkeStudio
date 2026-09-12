import { useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from "react";
import {
  DEFAULT_SHOT_SEC,
  assemblePrompt,
  overrideStaleAgainst,
  productionShape,
  promptFor,
  propSlug,
  resolveCast,
  resolvePropStates,
  shotCoverage,
  shotSpeakers,
  withoutMention,
  type ClientMessage,
  type ProductionBundle,
  type SceneRecord,
  type Shot,
  type ShotFraming,
  type WorldBundle,
} from "@arke-studio/contracts";
import { BenchBrief } from "../../components/bench-brief.js";
import { Checkbox, Select } from "../../components/ui.js";
import { Archive, FileText, ImageMark, LinkMark, Minus, Plus, Speaker, StickyNote, Timer, VideoMark, X } from "../../components/icons.js";
import { characterPortraitPath, locationPortraitPath, Portrait } from "../../components/portrait.js";
import { mentionNames, scriptWords } from "./mentions.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];
type EditShot = Extract<Command, { kind: "edit-shot" }>;

/** The camera vocabulary (turn 97, 14d). Display words, owned by SPEC-012 — the schema stays strings. */
export const CAMERA_FIELDS: Array<{ key: Exclude<keyof ShotFraming, "grade">; label: string; options: string[] }> = [
  { key: "size", label: "size", options: ["Extreme wide", "Wide", "Full", "Medium", "Medium close-up", "Close-up", "Extreme close-up", "Over the shoulder", "Two shot"] },
  { key: "angle", label: "angle", options: ["Eye level", "Low angle", "High angle", "Overhead", "Dutch tilt", "Ground level"] },
  { key: "lens", label: "lens", options: ["18mm", "24mm", "35mm", "50mm", "85mm", "135mm"] },
  { key: "focus", label: "focus", options: ["Deep focus", "Shallow", "Very shallow", "Rack focus"] },
  { key: "movement", label: "movement", options: ["Static", "Slow push-in", "Pull back", "Pan left", "Pan right", "Tilt up", "Tilt down", "Tracking, lateral", "Dolly, follow", "Crane up", "Orbit", "Handheld"] },
  { key: "pace", label: "pace", options: ["Very slow", "Slow", "Steady", "Brisk"] },
  { key: "lighting", label: "lighting", options: ["Blue hour", "Practical lantern", "Moonlight", "Overcast", "Firelight", "Backlit silhouette", "Hard noon", "Soft window"] },
  { key: "timeOfDay", label: "time", options: ["Dawn", "Day", "Dusk", "Night"] },
];

/**
 * The shot's fields as one column of cards (design turn 145, 145b/145c): Script, Frame prompt,
 * Notes, Camera, Timing, Continuity, Sound, Props — in that order and no other. Every editor
 * saves where it stands, through the one scene writer; a refused write leaves the person's
 * words in the box to blur again rather than putting the old value back over them.
 */
export function ShotFields({
  world,
  production,
  scene,
  shot,
  previous,
  digests,
  locked,
  refusalVersion,
  onCommand,
  onOpenCharacter,
}: {
  world: WorldBundle;
  production: ProductionBundle;
  scene: SceneRecord;
  shot: Shot;
  /** The shot before this one in the scene, for the two continuity switches. */
  previous: Shot | null;
  digests: ReadonlyMap<string, string>;
  locked: boolean;
  refusalVersion: number;
  onCommand: (command: Command) => boolean;
  onOpenCharacter: (sheetId: string, trigger: HTMLElement) => void;
}) {
  const sheets = world.sheets;
  const slug = world.meta.slug;
  const edit = (change: EditShot["change"], clear?: NonNullable<EditShot["clear"]>) =>
    onCommand({ kind: "edit-shot", shotId: shot.id, change, ...(clear === undefined ? {} : { clear }) });
  const mentionOptions = sheets.map((sheet) => ({
    token: sheet.id,
    kind: "image" as const,
    name: sheet.name,
    meta: `${sheet.type} · v${sheet.version}`,
    imagePath: sheet.type === "location" ? locationPortraitPath(world, sheet.id) : characterPortraitPath(world, sheet.id),
  }));

  // ---- Script -------------------------------------------------------------------------------
  const [scriptDraft, setScriptDraft] = useState(shot.description);
  const [scriptFocused, setScriptFocused] = useState(false);
  const names = useMemo(() => mentionNames(sheets, world.props), [sheets, world.props]);
  useEffect(() => { setScriptDraft(shot.description); }, [shot.description]);
  const commitScript = (next: string) => {
    if (locked || next === shot.description) return;
    if (!edit({ description: next })) setScriptDraft(shot.description);
  };

  // ---- Frame prompt -------------------------------------------------------------------------
  const style = production.meta.styleOverride?.trim() || world.artDirection.description;
  const capability = productionShape(production.meta).dispatchCapability === "image" ? "image" : "video";
  const assembledPrompt = assemblePrompt(world.meta, sheets, scene, shot, style, undefined, capability);
  const currentPrompt = promptFor(world.meta, sheets, scene, shot, style, undefined, capability);
  const durableOverride = shot.promptOverride?.text ?? null;
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [promptWhole, setPromptWhole] = useState(false);
  const promptDirty = useRef(false);
  /** A prompt write the blur admitted and the durable override has not yet matched. */
  const promptWrite = useRef<{ expected: string | null; refusalVersion: number } | null>(null);
  const pendingRebuildVersion = useRef<number | null>(null);
  const promptValue = promptDraft ?? currentPrompt.text;
  useEffect(() => {
    // The write landed: the durable prompt is the draft, so the draft can go.
    if (promptWrite.current !== null && durableOverride === promptWrite.current.expected) {
      promptWrite.current = null;
      if (!promptDirty.current) setPromptDraft(null);
    }
    if (durableOverride === null) pendingRebuildVersion.current = null;
  }, [durableOverride]);
  useEffect(() => {
    // A refusal answers the write in flight: the draft is the person's again, to send once more.
    if (promptWrite.current !== null && promptWrite.current.refusalVersion !== refusalVersion) {
      promptWrite.current = null;
      promptDirty.current = true;
    }
    if (pendingRebuildVersion.current !== null && pendingRebuildVersion.current !== refusalVersion) {
      pendingRebuildVersion.current = null;
      promptDirty.current = false;
      setPromptDraft(null);
    }
  }, [refusalVersion]);
  const commitPrompt = (value: string) => {
    const next = value.trim();
    promptDirty.current = false;
    if (next === currentPrompt.text.trim()) {
      setPromptDraft(null);
      return;
    }
    const replacement = next === "" || next === assembledPrompt.trim() ? null : next;
    if (!onCommand({ kind: "set-prompt-override", shotId: shot.id, text: replacement, capability })) {
      promptDirty.current = true;
      setPromptDraft(value);
      return;
    }
    promptWrite.current = { expected: replacement, refusalVersion };
    setPromptDraft(value);
  };
  // Rebuild drops whatever was typed and reads the prompt off the current script again. Only a
  // durable override needs a command; a local draft is just let go.
  const canRebuild = durableOverride !== null || promptDraft !== null;
  const rebuildPrompt = () => {
    promptDirty.current = false;
    if (durableOverride === null) {
      setPromptDraft(null);
      return;
    }
    if (onCommand({ kind: "set-prompt-override", shotId: shot.id, text: null })) {
      pendingRebuildVersion.current = refusalVersion;
      promptWrite.current = { expected: null, refusalVersion };
      setPromptDraft(assembledPrompt);
    } else {
      setPromptDraft(null);
    }
  };
  const coverage = shotCoverage(shot, digests);
  const stale = overrideStaleAgainst(shot, [...sheets]);
  const refs = resolveCast(shot.description, [...sheets]).cast;
  // What a cited character brings to this shot (SPEC-044 R-22): voice where they speak in it,
  // by the same resolution the planner and the dialog use; look where the shot cites them.
  const speakers = shotSpeakers(scene, [shot]).speakers;

  // ---- Notes ---------------------------------------------------------------------------------
  const [notesDraft, setNotesDraft] = useState(shot.notes ?? "");
  /** The note last written and not yet durable, so a second blur does not write it twice. */
  const notesSent = useRef<string | null>(null);
  // One line until written in, then as tall as the note: measured on mount and on every change,
  // not only while typing, or a saved note of three lines opens clipped to one.
  const notesBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = notesBox.current;
    if (box === null || typeof box.scrollHeight !== "number") return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [notesDraft]);
  useEffect(() => {
    notesSent.current = null;
    setNotesDraft(shot.notes ?? "");
  }, [shot.notes]);
  useEffect(() => { notesSent.current = null; }, [refusalVersion]);
  const commitNotes = (value: string) => {
    const next = value.trim();
    if (locked || next === (shot.notes ?? "") || next === notesSent.current) return;
    const accepted = next === "" ? edit({}, ["notes"]) : edit({ notes: next });
    if (accepted) notesSent.current = next;
  };

  // ---- Camera --------------------------------------------------------------------------------
  const framingSet = (key: keyof ShotFraming, value: string | undefined) => {
    const framing = { ...shot.framing };
    if (value === undefined) delete framing[key];
    else framing[key] = value;
    if (Object.keys(framing).length > 0) edit({ framing });
    else edit({}, ["framing"]);
  };

  // ---- Timing --------------------------------------------------------------------------------
  const durationSec = shot.durationSec ?? DEFAULT_SHOT_SEC;
  const beats = shot.beats ?? [];
  const setBeats = (next: Shot["beats"]) => (next !== undefined && next.length > 0 ? edit({ beats: next }) : edit({}, ["beats"]));

  // ---- Continuity ----------------------------------------------------------------------------
  /*
   * One place that knows when `continuity` collapses to nothing. Written inline, each control
   * has to remember the other two, and the one that forgets deletes an authored field when its
   * own is cleared — which is exactly what happened to `audio` once (review 2026-08-22).
   */
  const continuitySet = (change: Partial<NonNullable<Shot["continuity"]>>) => {
    const merged: Record<string, unknown> = { ...shot.continuity, ...change };
    for (const [key, value] of Object.entries(merged)) if (value === undefined || value === false) delete merged[key];
    if (Object.keys(merged).length > 0) edit({ continuity: merged as NonNullable<Shot["continuity"]> });
    else edit({}, ["continuity"]);
  };

  // ---- Sound ---------------------------------------------------------------------------------
  const audioSet = (key: "line" | "ambience" | "effects", value: string) => {
    const next = value.trim();
    if (next === (shot.audio?.[key] ?? "")) return;
    const audio: Record<string, unknown> = { kind: shot.audio?.kind ?? "sfx", ...shot.audio };
    if (next === "") delete audio[key];
    else audio[key] = next;
    // The kind survives a cleared field: it is the one required field, and emptying the last box
    // once deleted an authored `silence` outright. Only a shot that never had audio collapses.
    const has = audio.line || audio.ambience || audio.effects || audio.speaker;
    if (has || shot.audio?.kind !== undefined) edit({ audio: audio as NonNullable<Shot["audio"]> });
    else edit({}, ["audio"]);
  };

  // ---- Props ---------------------------------------------------------------------------------
  const cited = resolvePropStates(shot, world.props);
  const uncited = world.props.filter((prop) => !cited.some((entry) => entry.propId === prop.id));
  const [citing, setCiting] = useState(false);

  const disabled = locked;
  return (
    <div className="fy-shot__fields" data-testid="shot-fields">
      <Section icon={<FileText size={15} />} name="Script">
        <div
          className="fy-shot__script fy-swrow__scripteditor"
          title="Write what happens · type @ to name anything in the world"
          onFocus={() => setScriptFocused(true)}
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            setScriptFocused(false);
            commitScript(event.currentTarget.querySelector("textarea")?.value ?? scriptDraft);
          }}
        >
          <BenchBrief
            value={scriptDraft}
            onChange={setScriptDraft}
            options={mentionOptions}
            worldSlug={slug}
            underlay={scriptWords(scriptDraft, names, scriptFocused ? "edit" : "read")}
            label={`Script for shot ${shot.number}`}
            placeholder="What happens in this shot…"
            disabled={disabled}
          />
        </div>
      </Section>

      <Section
        icon={<ImageMark size={15} />}
        name="Frame prompt"
        // The whole card is the prompt's blur boundary, so moving to Rebuild or View full prompt
        // commits nothing: Rebuild drops the draft, and a write on the way to it would land first.
        onBlur={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          if (!promptDirty.current) return;
          commitPrompt(event.currentTarget.querySelector("textarea")?.value ?? promptValue);
        }}
        head={
          <>
            {shot.promptOverride === undefined ? null : <span className="fy-shot__tag">Authored</span>}
            {coverage === "changed" ? <span className="fy-shot__tag" data-tone="warning">script changed</span> : null}
            <span className="fy-shot__spacer" />
            <button type="button" className="fy-shot__link" aria-pressed={promptWhole} onClick={() => setPromptWhole((whole) => !whole)}>
              {promptWhole ? "Show less" : "View full prompt"}
            </button>
            <button type="button" className="fy-shot__link" title="Rebuild from the script, references and camera" disabled={disabled || !canRebuild} onClick={rebuildPrompt}>
              Rebuild
            </button>
          </>
        }
      >
        <div className="fy-shot__prompt" data-whole={promptWhole ? "true" : undefined}>
          <BenchBrief
            value={promptValue}
            onChange={(value) => { promptDirty.current = true; setPromptDraft(value); }}
            options={mentionOptions}
            worldSlug={slug}
            underlay={promptValue}
            label={`Frame prompt for shot ${shot.number}`}
            disabled={disabled}
          />
        </div>
        {stale.length === 0 ? null : (
          <p className="fy-shot__stale" role="status">
            The world moved under this prompt: {stale.map((entry) => `${entry.sheetId} v${entry.from} → v${entry.to}`).join(" · ")}
          </p>
        )}
        {refs.length === 0 ? null : (
          <div className="fy-shot__refs">
            {refs.map((entry) => {
              const title = `${entry.sheet.type} · v${entry.sheet.version}`;
              const inner = (
                <>
                  <span className="fy-shot__refthumb">
                    <Portrait
                      worldSlug={slug}
                      path={entry.sheet.type === "location" ? locationPortraitPath(world, entry.sheet.id) : characterPortraitPath(world, entry.sheet.id)}
                      label=""
                      radius={99}
                    />
                  </span>
                  {entry.sheet.name}
                  {entry.sheet.type === "character" ? (
                    <span className="fy-shot__refwords">{speakers.includes(entry.sheet.id) ? "voice · look" : "look"}</span>
                  ) : null}
                </>
              );
              return entry.sheet.type === "character" ? (
                <button key={entry.sheet.id} type="button" className="fy-shot__ref fy-shot__ref--door" title={title} aria-haspopup="dialog" onClick={(event) => onOpenCharacter(entry.sheet.id, event.currentTarget)}>
                  {inner}
                </button>
              ) : (
                <span key={entry.sheet.id} className="fy-shot__ref" title={title}>{inner}</span>
              );
            })}
          </div>
        )}
      </Section>

      {/* One line until written in (turn 143 by way of 145): the line is the card. */}
      <section className="fy-shot__section fy-shot__section--notes">
        <span className="fy-shot__sectionicon"><StickyNote size={15} /></span>
        <span className="fy-shot__sectionname">Notes</span>
        <textarea
          ref={notesBox}
          className="fy-shot__notes"
          aria-label={`Notes for shot ${shot.number}`}
          placeholder="Add notes about this shot…"
          value={notesDraft}
          disabled={disabled}
          rows={1}
          onChange={(event) => setNotesDraft(event.target.value)}
          onBlur={(event) => commitNotes(event.currentTarget.value)}
        />
      </section>

      {/* Turn 97's nine as 145b draws them. 14d's intent line is not carried: the record keeps the
          field and the prompt still reads it, but a control the turn does not draw is not a control. */}
      <Section icon={<VideoMark size={15} />} name="Camera">
        <div className="fy-shot__camera">
          {CAMERA_FIELDS.map((field) => {
            const own = shot.framing?.[field.key];
            const inherited = scene.defaults?.[field.key];
            return (
              <label key={field.key} className="fy-shot__field" data-own={own === undefined ? undefined : "true"}>
                <span>{field.label}{own === undefined ? null : <i className="fy-shot__dot" title="overrides the scene" aria-label="overrides the scene" />}</span>
                <Select
                  label={`Shot ${field.label}`}
                  className="fy-shot__select"
                  wrapClassName="fy-shot__selectwrap"
                  value={own ?? ""}
                  disabled={disabled}
                  onChange={(event) => framingSet(field.key, event.target.value === "" ? undefined : event.target.value)}
                >
                  <option value="">{inherited !== undefined ? `${inherited} · from scene` : "from scene"}</option>
                  {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                </Select>
              </label>
            );
          })}
          <label className="fy-shot__field" data-own={shot.framing?.grade === undefined ? undefined : "true"}>
            <span>grade{shot.framing?.grade === undefined ? null : <i className="fy-shot__dot" title="overrides the scene" aria-label="overrides the scene" />}</span>
            <input
              key={shot.framing?.grade ?? ""}
              aria-label="Shot grade"
              defaultValue={shot.framing?.grade ?? ""}
              placeholder={scene.defaults?.grade === undefined ? "from scene" : `${scene.defaults.grade} · from scene`}
              disabled={disabled}
              onBlur={(event) => {
                const next = event.currentTarget.value.trim();
                if (next === (shot.framing?.grade ?? "")) return;
                framingSet("grade", next === "" ? undefined : next);
              }}
            />
          </label>
        </div>
      </Section>

      <Section
        icon={<Timer size={15} />}
        name="Timing"
        head={
          <>
            <span className="fy-shot__spacer" />
            <button type="button" className="fy-shot__link fy-shot__add" disabled={disabled} onClick={() => setBeats([...beats, { span: `${Math.round(durationSec)}s`, text: "What happens" }])}>
              <Plus size={12} />Add beat
            </button>
          </>
        }
      >
        <div className="fy-shot__row">
          <span className="fy-shot__rowlabel">duration</span>
          <span className="fy-shot__stepper">
            <button type="button" aria-label="Shorter" disabled={disabled || durationSec <= 0.5} onClick={() => edit({ durationSec: Math.max(0.5, Math.round((durationSec - 0.5) * 2) / 2) })}><Minus size={11} /></button>
            <span>{formatSeconds(durationSec)}</span>
            <button type="button" aria-label="Longer" disabled={disabled || durationSec >= 15} onClick={() => edit({ durationSec: Math.min(15, Math.round((durationSec + 0.5) * 2) / 2) })}><Plus size={11} /></button>
          </span>
        </div>
        {/* Keyed by list shape as well as index: the inputs are uncontrolled, so after a splice
            React's index reuse would leave a deleted beat's text on screen. */}
        {beats.map((beat, index) => (
          <div key={`${beats.length}:${index}:${beat.span}:${beat.text}`} className="fy-shot__row fy-shot__beat">
            <input
              className="fy-shot__beatspan"
              aria-label={`Beat ${index + 1} span`}
              defaultValue={beat.span}
              disabled={disabled}
              onBlur={(event) => {
                const next = event.currentTarget.value.trim();
                if (next === "" || next === beat.span) return;
                const copy = [...beats];
                copy[index] = { ...beat, span: next };
                setBeats(copy);
              }}
            />
            <input
              className="fy-shot__beattext"
              aria-label={`Beat ${index + 1}`}
              defaultValue={beat.text}
              disabled={disabled}
              onBlur={(event) => {
                const next = event.currentTarget.value.trim();
                if (next === beat.text) return;
                const copy = [...beats];
                if (next === "") copy.splice(index, 1);
                else copy[index] = { ...beat, text: next };
                setBeats(copy);
              }}
            />
            <button type="button" className="fy-shot__remove" aria-label={`Remove beat ${index + 1}`} disabled={disabled} onClick={() => setBeats(beats.filter((_, at) => at !== index))}><Minus size={11} /></button>
          </div>
        ))}
      </Section>

      <Section icon={<LinkMark size={15} />} name="Continuity">
        <Checkbox
          className="fy-shot__check"
          label={previous === null ? "Opens on the previous shot’s last frame" : `Opens on shot ${previous.number}’s last frame`}
          disabled={disabled || previous === null}
          checked={shot.continuity?.openOnPrevious ?? false}
          onChange={(event) => continuitySet({ openOnPrevious: event.target.checked || undefined })}
        />
        {/* SPEC-019 R-50: the stronger neighbour of the box above — a frame keeps the
            composition and loses the motion and the audio under it. */}
        <Checkbox
          className="fy-shot__check"
          label={previous === null ? "Continues the previous shot" : `Continues shot ${previous.number}`}
          disabled={disabled || previous === null}
          checked={shot.continuity?.continuesPrevious ?? false}
          onChange={(event) => continuitySet({ continuesPrevious: event.target.checked || undefined })}
        />
        <div className="fy-shot__row">
          <span className="fy-shot__rowlabel">keep out</span>
          <input
            key={shot.continuity?.keepOut ?? ""}
            className="fy-shot__input"
            aria-label="Keep out of frame"
            defaultValue={shot.continuity?.keepOut ?? ""}
            placeholder="Modern boats, text, lens flare"
            disabled={disabled}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim();
              if (next === (shot.continuity?.keepOut ?? "")) return;
              continuitySet({ keepOut: next === "" ? undefined : next });
            }}
          />
        </div>
      </Section>

      <Section icon={<Speaker size={15} />} name="Sound">
        {([["line", "dialogue", "None · the shot is silent"], ["ambience", "ambience", "The bed under the line"], ["effects", "effects", "The hits beside it"]] as const).map(([key, label, placeholder]) => (
          <div key={key} className="fy-shot__row">
            <span className="fy-shot__rowlabel">{label}</span>
            <input
              key={shot.audio?.[key] ?? ""}
              className="fy-shot__input"
              aria-label={`Sound · ${label}`}
              defaultValue={shot.audio?.[key] ?? ""}
              placeholder={placeholder}
              disabled={disabled}
              onBlur={(event) => audioSet(key, event.currentTarget.value)}
            />
          </div>
        ))}
      </Section>

      <Section
        icon={<Archive size={15} />}
        name="Props"
        head={
          <>
            <span className="fy-shot__spacer" />
            {citing ? (
              <Select
                label="Cite a prop"
                className="fy-shot__select"
                wrapClassName="fy-shot__cite"
                autoFocus
                defaultValue=""
                disabled={disabled}
                onChange={(event) => {
                  const prop = world.props.find((candidate) => candidate.id === event.target.value);
                  // Citing is a mention: the script is the reference list, for props as for sheets.
                  if (prop !== undefined) edit({ description: `${shot.description.replace(/\s*$/, "")} @${propSlug(prop.name)}`.trim() });
                  setCiting(false);
                }}
                onBlur={() => setCiting(false)}
              >
                <option value="" disabled>Pick a prop…</option>
                {uncited.map((prop) => <option key={prop.id} value={prop.id}>{prop.name}</option>)}
              </Select>
            ) : (
              <button type="button" className="fy-shot__link fy-shot__add" disabled={disabled || uncited.length === 0} onClick={() => setCiting(true)}>
                <Plus size={12} />Cite a prop
              </button>
            )}
          </>
        }
      >
        {cited.map((entry) => {
          const prop = world.props.find((candidate) => candidate.id === entry.propId)!;
          return (
            <div key={entry.propId} className="fy-shot__row">
              <span className="fy-shot__prop"><Archive size={13} />{entry.propName}</span>
              <Select
                label={`${entry.propName} state for this shot`}
                className="fy-shot__select"
                wrapClassName="fy-shot__propstate"
                value={entry.stateId ?? ""}
                disabled={disabled}
                onChange={(event) => {
                  const stateId = event.target.value;
                  const others = (shot.propStates ?? []).filter((candidate) => candidate.propId !== entry.propId);
                  const next = stateId === "" ? others : [...others, { propId: entry.propId, stateId }];
                  edit({ propStates: next });
                }}
              >
                <option value="">unresolved</option>
                {prop.states.map((state) => <option key={state.id} value={state.id}>{state.name}{state.reference ? "" : " · no reference"}</option>)}
              </Select>
              <button
                type="button"
                className="fy-shot__remove"
                aria-label={`Remove ${entry.propName}`}
                disabled={disabled}
                onClick={() => {
                  const cleaned = withoutMention(shot.description, propSlug(prop.name));
                  const others = (shot.propStates ?? []).filter((candidate) => candidate.propId !== entry.propId);
                  edit({ description: cleaned, propStates: others });
                }}
              ><X size={11} /></button>
            </div>
          );
        })}
      </Section>
    </div>
  );
}

function Section({ icon, name, head, children, onBlur }: { icon: ReactNode; name: string; head?: ReactNode; children: ReactNode; onBlur?: (event: FocusEvent<HTMLElement>) => void }) {
  return (
    <section className="fy-shot__section" aria-label={name} onBlur={onBlur}>
      <div className="fy-shot__sectionhead">
        <span className="fy-shot__sectionicon">{icon}</span>
        <span className="fy-shot__sectionname">{name}</span>
        {head}
      </div>
      <div className="fy-shot__sectionbody">{children}</div>
    </section>
  );
}

function formatSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

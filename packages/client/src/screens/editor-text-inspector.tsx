import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  namedTextPlace,
  patchTextLook,
  TEXT_DEFAULT_LOOK,
  TEXT_PART_DEFAULTS,
  TEXT_PLACES,
  TEXT_TYPEFACE_IDS,
  TEXT_TYPEFACES,
  textTypefaceFile,
  textTypefacePatch,
  textWords,
  transitionStill,
  type ArtifactSidecar,
  type FrameRate,
  type ProductionTimeline,
  type SourceLengthFrames,
  type TextDraftResult,
  type TextLook,
  type TextLookNumber,
  type TextLookPatch,
  type TextSource,
  type TextTypefaceId,
  type TimelineClip,
  type TimelineClipId,
  type TimelineCommand,
  type TimelineTrack,
} from "@arke-studio/contracts";
import { cx } from "../components/ui.js";
import { Check, ChevronDown } from "../components/icons.js";
import {
  fillColours, fillWithColour, fillWithCount, lookNumber, MIXED, numberPatch, parsePercent, percentProblem, percentRange,
  percentShown, sameOf, textLookCommands, type Mixed,
} from "../lib/editor-text-fields.js";
import type { TextDraftApi } from "../lib/editor-text-draft.js";
import { textTypefaceFamily, useTextTypefaces } from "../lib/text-typefaces.js";
import { PictureClipTiming } from "./editor-timeline.js";
import { PictureMotionInspector } from "./editor-picture-motion.js";
import { PictureAppearanceInspector } from "./editor-picture-appearance.js";
import { useCutLayout } from "./editor-responsive.js";

/**
 * A selected title's words and look (SPEC-065 R-31, R-32), in turn 277's order and with its labels
 * (rule 7): TEXT and the first line, Words, Type, Place, Fill, Edge, Shadow, Rule and Backing, then
 * the rows a still picture shows. With several titles selected the look alone, headed by the count,
 * and a change reaches every one of them in one revision (rule 14). Typing draws a draft in the
 * Viewer and writes nothing; a field writes one revision when it commits.
 */

/** What the Cut lends the text Inspector beyond what every Inspector is handed. */
export interface TextInspectorContext {
  draft: TextDraftApi;
  /** Bumped by Add text: the placed clip's Words field takes focus with its words selected. */
  focusWords: { clipId: string; serial: number } | null;
  /** A commit the coordinator refused anyway (a race), shown under the field that sent it. */
  commitRefusal: { field: string; reason: string } | null;
  /** Sends a text commit and says which field sent it. */
  onText: (commands: TimelineCommand[], label: string, field: string) => void;
  /** On a phone the typeface list takes the sheet, with a way back (277k). */
  typefaceList: boolean;
  onTypefaceList: (open: boolean) => void;
}

interface Held { clip: TimelineClip & { source: TextSource }; track: TimelineTrack }

/** How long a commit waits on the painter's check before it goes anyway and lets the command's own check refuse. */
const CHECK_MS = 2000;
const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];

const faceName = (id: Mixed<TextTypefaceId>): string => (id === MIXED ? "Mixed" : TEXT_TYPEFACES[id].name);
const lower = (colour: string): string => colour.toLowerCase();
/** What a colour input holds while the titles' colours differ: any colour, since the hatching covers it. */
const ANY_COLOUR = fillColours(TEXT_DEFAULT_LOOK.fill)[0]!;
type TextPart = "edge" | "shadow" | "rule";

/** A part switched on: the first selected title's that has it, so they come to match (rule 14), else the default. */
function partOn(key: TextPart, looks: readonly TextLook[]): TextLookPatch {
  switch (key) {
    case "edge": return { edge: { ...(looks.find(look => look.edge)?.edge ?? TEXT_PART_DEFAULTS.edge) } };
    case "shadow": return { shadow: { ...(looks.find(look => look.shadow)?.shadow ?? TEXT_PART_DEFAULTS.shadow) } };
    case "rule": return { rule: { ...(looks.find(look => look.rule)?.rule ?? TEXT_PART_DEFAULTS.rule) } };
  }
}
/** A part switched off is removed (R-25: null removes it). */
const partOff = (key: TextPart): TextLookPatch => (key === "edge" ? { edge: null } : key === "shadow" ? { shadow: null } : { rule: null });

function Refusal({ id, reason }: { id: string; reason: string | null | undefined }) {
  return reason ? <p id={id} className="tx-refusal" role="alert">{reason}</p> : null;
}

/**
 * A field typed in and then removed commits as one left by blur does. Pressing another clip
 * selects it on pointerdown, before the browser moves focus, so the Inspector is re-keyed and the
 * focused field removed while it is still dirty; React delivers no blur to a field it has removed,
 * and the typed words were lost with no revision, no refusal and nothing to Undo. `leave` is read
 * at unmount, so it is the last render's, with the value typed and the selection it was typed for.
 */
function useLeaveCommits(leave: () => void) {
  const latest = useRef(leave);
  latest.current = leave;
  useEffect(() => () => latest.current(), []);
}

/** What a refused control carries: outlined, and described by its clause (rule 13). */
function invalidBy(id: string, reason: string | null) {
  return reason ? { "aria-invalid": true, "aria-describedby": id } : {};
}

function Section({ name, children, part }: { name: string; children?: ReactNode; part?: { on: boolean; mixed: boolean; disabled: boolean; onToggle: () => void; refusal: string | null } }) {
  const id = useId();
  return <section className="tx-section" aria-label={name}>
    <h3 className={part ? "tx-h" : undefined}>{name}{part && <span className="tx-h__end">
      {part.mixed && <span className="tx-mixedtag">Mixed</span>}
      <button type="button" className={cx("tx-switch", part.refusal && "bad")} role="switch" aria-checked={part.on} aria-label={name} disabled={part.disabled} onClick={part.onToggle}
        {...invalidBy(id, part.refusal)} />
    </span>}</h3>
    {/* A switch refused is said under its heading, before the part's fields. */}
    {part && <Refusal id={id} reason={part.refusal} />}
    {children}
  </section>;
}

/**
 * One number as a per cent (rule 8). Typing drafts, Enter or leaving commits, Escape gives the
 * held value back. A value out of range is refused under the field in one clause and is never
 * clamped; a value the screen cannot tell from the one held sends nothing.
 */
function TextNumber({ label, name, field, value, disabled, resetToken, onDraft, onCommit, chip, slider = false, refusal }: {
  label: string; name?: string; field: TextLookNumber; value: Mixed<number>; disabled: boolean; resetToken: unknown;
  onDraft: (value: number | null) => void; onCommit: (value: number) => void; chip?: string | null; slider?: boolean; refusal?: string | null;
}) {
  const id = useId();
  const held = value === MIXED ? null : percentShown(value);
  const shown = held === null ? "" : String(held);
  const range = percentRange(field);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const [sliding, setSliding] = useState<number | null>(null);
  const dirty = useRef(false), slide = useRef<number | null>(null);
  useEffect(() => { if (!dirty.current) setText(shown); }, [shown]);
  useLayoutEffect(() => { dirty.current = false; slide.current = null; setText(shown); setError(null); setSliding(null); }, [resetToken]);
  const revert = () => { dirty.current = false; setText(shown); setError(null); onDraft(null); };
  const commit = () => {
    if (!dirty.current || disabled) return;
    if (text.trim() === "") { revert(); return; }
    const typed = parsePercent(text);
    const problem = typed === null ? percentProblem(field, Number.POSITIVE_INFINITY) : percentProblem(field, typed);
    if (typed === null || problem !== null) { setError(problem); onDraft(null); return; }
    dirty.current = false; setError(null);
    if (typed === held) { onDraft(null); return; }
    onCommit(typed / 100);
  };
  const finishSlide = (cancel = false) => {
    const next = slide.current;
    slide.current = null; setSliding(null);
    if (next === null) return;
    if (cancel || next === held) onDraft(null);
    else onCommit(next / 100);
  };
  useLeaveCommits(() => { if (slide.current !== null) finishSlide(); else commit(); });
  const shownError = error ?? refusal ?? null;
  return <div className={cx("tx-number", slider && "tx-number--slider")}>
    <label className="tx-f" htmlFor={id}>
      <span className="tx-f__label">{label}{chip && <span className="tx-drawn">{chip}</span>}</span>
      <span className="tx-input">
        <input id={id} aria-label={name ?? label} value={sliding !== null ? String(sliding) : text} placeholder={held === null ? "Mixed" : undefined}
          inputMode="decimal" spellCheck={false} disabled={disabled} aria-invalid={shownError ? true : undefined} aria-describedby={shownError ? `${id}-refusal` : undefined}
          onFocus={event => event.currentTarget.select()}
          onInput={event => {
            const next = event.currentTarget.value;
            dirty.current = true; setText(next); setError(null);
            const typed = parsePercent(next);
            onDraft(typed !== null && percentProblem(field, typed) === null && typed !== held ? typed / 100 : null);
          }}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commit(); }
            else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); revert(); }
          }} />
        <span className="tx-unit" aria-hidden="true">%</span>
      </span>
    </label>
    {slider && <input type="range" className={cx("tx-slider", held === null && sliding === null && "tx-mixed")} aria-label={`${label} slider`}
      min={range.min} max={range.max} step={0.1} value={sliding ?? held ?? range.min} aria-valuetext={held === null && sliding === null ? "Mixed" : undefined} disabled={disabled}
      onPointerDown={event => { try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* A released pointer cannot be captured. */ } }}
      onInput={event => { const next = Number(event.currentTarget.value); slide.current = next; setSliding(next); onDraft(next / 100); }}
      onPointerUp={() => finishSlide()} onPointerCancel={() => finishSlide(true)} onBlur={() => finishSlide()}
      onKeyUp={event => { if (ARROWS.includes(event.key)) finishSlide(); }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishSlide(true); } }} />}
    <Refusal id={`${id}-refusal`} reason={shownError} />
  </div>;
}

/**
 * A colour, drawn as the turn's flat swatch with the picker effects already use (rule 16). Moving
 * through the picker drafts; the picker closing (the input's own `change`) commits. A colour the
 * titles do not share is hatched.
 */
function TextSwatch({ label, value, fallback, disabled, onDraft, onCommit, refusal, refusalId }: {
  label: string; value: Mixed<string>; fallback: string; disabled: boolean; onDraft: (colour: string | null) => void; onCommit: (colour: string) => void;
  /** A refusal of this colour, said by the row the swatch sits in, under it. */
  refusal: string | null; refusalId: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const shown = value === MIXED ? fallback : value;
  const latest = useRef({ shown, mixed: value === MIXED, onDraft, onCommit });
  latest.current = { shown, mixed: value === MIXED, onDraft, onCommit };
  useEffect(() => {
    const input = ref.current;
    if (input === null) return;
    const change = () => {
      const next = lower(input.value), now = latest.current;
      setMoving(null);
      if (!now.mixed && next === lower(now.shown)) now.onDraft(null);
      else now.onCommit(next);
    };
    input.addEventListener("change", change);
    return () => input.removeEventListener("change", change);
  }, []);
  return <span className={cx("tx-swatch", refusal && "bad")} data-mixed={value === MIXED && moving === null ? "true" : undefined}>
    <input ref={ref} type="color" aria-label={label} value={moving ?? shown} disabled={disabled} {...invalidBy(refusalId, refusal)}
      onInput={event => { const next = lower(event.currentTarget.value); setMoving(next); onDraft(next); }} />
  </span>;
}

/** A checkbox that shows a dash where the titles differ (rule 14). */
function TextCheck({ label, value, disabled, onChange, refusal }: { label: string; value: Mixed<boolean>; disabled: boolean; onChange: (checked: boolean) => void; refusal?: string | null }) {
  const ref = useRef<HTMLInputElement>(null), id = useId();
  useEffect(() => { if (ref.current) ref.current.indeterminate = value === MIXED; }, [value]);
  return <span className="tx-checkwrap">
    <label className={cx("tx-check", disabled && "tx-off")}>
      <input ref={ref} type="checkbox" checked={value === true} disabled={disabled} aria-invalid={refusal ? true : undefined} aria-describedby={refusal ? `${id}-refusal` : undefined}
        onChange={event => onChange(event.currentTarget.checked)} />{label}
    </label>
    <Refusal id={`${id}-refusal`} reason={refusal} />
  </span>;
}

function Segments<T extends string>({ label, options, value, disabled, onChoose, refusal }: {
  label: string; options: readonly (readonly [T, string, boolean?])[]; value: Mixed<T>; disabled: boolean; onChoose: (value: T) => void; refusal: string | null;
}) {
  const id = useId();
  return <>
    <div className={cx("tx-seg", refusal && "bad")} role="radiogroup" aria-label={label} {...invalidBy(id, refusal)}>
      {options.map(([option, text, off]) => <button key={option} type="button" role="radio" aria-checked={value === option} className={cx(value === option && "on")}
        disabled={disabled || off === true} onClick={() => { if (value !== option) onChoose(option); }}>{text}</button>)}
    </div>
    <Refusal id={id} reason={refusal} />
  </>;
}

/** A select of the look's (Place, Fill, Backing), with its refusal under it. */
function TextSelect({ label, value, disabled, onChange, refusal, children }: {
  label: string; value: string; disabled: boolean; onChange: (value: string) => void; refusal: string | null; children: ReactNode;
}) {
  const id = useId();
  return <>
    <select className={cx("tx-select", refusal && "bad")} aria-label={label} value={value} disabled={disabled} {...invalidBy(id, refusal)}
      onChange={event => onChange(event.currentTarget.value)}>{children}</select>
    <Refusal id={id} reason={refusal} />
  </>;
}

/** The six faces, each name drawn in its own face once its file has come (rule 10), the current one checked. */
function FaceOptions({ current, ready, className, onChoose, onEscape }: {
  current: Mixed<TextTypefaceId>; ready: ReadonlySet<TextTypefaceId>; className: string; onChoose: (id: TextTypefaceId) => void; onEscape?: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    (list.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.current?.querySelector<HTMLElement>("[role=option]"))?.focus({ preventScroll: true });
  }, []);
  return <div ref={list} className={className} role="listbox" aria-label="Typeface"
    onKeyDown={event => {
      const options = [...(list.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
      const at = options.findIndex(option => option === document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); event.stopPropagation();
        options[(at + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
      } else if (event.key === "Escape" && onEscape) { event.preventDefault(); event.stopPropagation(); onEscape(); }
    }}>
    {TEXT_TYPEFACE_IDS.map(id => <button key={id} type="button" role="option" aria-selected={current === id} className="tx-option"
      style={ready.has(id) ? { fontFamily: `"${textTypefaceFamily(id)}", var(--font-sans)` } : undefined} onClick={() => onChoose(id)}>
      <span>{TEXT_TYPEFACES[id].name}</span>{current === id && <Check size={16} />}
    </button>)}
  </div>;
}

export function TextInspector({ clips, timeline, artifacts, frameRate, disabled, appearanceDisabled, appearanceRevision, appearanceScopeLabel, onCommands, onScrub, sourceLength, playheadFrame, text }: {
  clips: readonly Held[];
  timeline: ProductionTimeline | null;
  artifacts: readonly ArtifactSidecar[];
  frameRate: FrameRate;
  disabled: boolean;
  appearanceDisabled: boolean;
  appearanceRevision?: string;
  appearanceScopeLabel?: string;
  onCommands: (commands: TimelineCommand[], label?: string) => void;
  onScrub: (frame: number) => void;
  sourceLength: SourceLengthFrames;
  playheadFrame: number;
  text: TextInspectorContext;
}) {
  const { phone } = useCutLayout();
  const { draft, onText } = text;
  const single = clips.length === 1 ? clips[0]! : null;
  const looks = clips.map(({ clip }) => clip.source.look);
  const resetToken = timeline?.revision;
  const [refusal, setRefusal] = useState<{ field: string; reason: string } | null>(null);
  const [drafting, setDrafting] = useState<{ field: string; clipId: string; look?: TextLookPatch } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const faceButton = useRef<HTMLButtonElement>(null);
  const ids = clips.map(({ clip }) => clip.id).join(" ");
  const faceRefusalId = useId(), swatchRefusalId = useId();
  // A refusal belongs to the selection and the record it was made against.
  useEffect(() => { setRefusal(null); setDrafting(null); setMenuOpen(false); }, [ids, resetToken]);
  const ready = useTextTypefaces(menuOpen || text.typefaceList);

  // A value typed for several titles drafts the one under the playhead, when there is exactly one:
  // otherwise nothing on screen shows it (rule 14).
  const under = clips.filter(({ clip }) => playheadFrame >= clip.startFrame && playheadFrame < clip.startFrame + clip.durationFrames);
  const drafted = single ?? (under.length === 1 ? under[0]! : null);
  const preview = (field: string, edit: ((look: TextLook) => TextLookPatch) | null) => {
    if (edit === null || drafted === null) {
      if (drafting?.field === field) { setDrafting(null); draft.want(null); }
      return;
    }
    const look = edit(drafted.clip.source.look);
    setDrafting({ field, clipId: drafted.clip.id, look });
    draft.want({ clipId: drafted.clip.id, look });
  };
  /** One change to the look, as one batch: one revision, one Undo (R-25). `check` asks the painter first. */
  const commit = async (field: string, label: string, edit: (look: TextLook) => TextLookPatch, check = false) => {
    const commands = textLookCommands(clips.map(({ clip }) => ({ id: clip.id, look: clip.source.look })), edit);
    if (commands.length === 0) { setDrafting(null); draft.want(null); return; }
    if (check) {
      const results = await draft.measure(clips.map(({ clip }) => ({ text: clip.source.text, look: patchTextLook(clip.source.look, edit(clip.source.look)) })), CHECK_MS);
      const refused = results?.find((result): result is Extract<TextDraftResult, { ok: false }> => !result.ok);
      // Refused: nothing is sent, and the Viewer keeps the stored look (rule 13).
      if (refused) { setRefusal({ field, reason: refused.reason }); setDrafting(null); draft.want(null); return; }
    }
    setRefusal(null); setDrafting(null);
    draft.hold(); draft.want(null);
    onText(commands, label, field);
  };

  // What shows under which field: a check's refusal, a commit refused anyway, the draft being typed,
  // then a refusal of what is stored, under the field the coordinator names.
  const storedRefusal = clips.map(({ clip }) => draft.stored.get(clip.id)).find((result): result is Extract<TextDraftResult, { ok: false }> => result !== undefined && !result.ok);
  const typingRefusal = drafting !== null && draft.result !== null && !draft.result.ok ? { field: drafting.field, reason: draft.result.reason } : null;
  const refusalUnder = (field: string): string | null => {
    if (refusal?.field === field) return refusal.reason;
    if (text.commitRefusal?.field === field) return text.commitRefusal.reason;
    if (typingRefusal?.field === field) return typingRefusal.reason;
    if (storedRefusal && (storedRefusal.field === "typeface" ? "typeface" : "words") === field && refusal === null) return storedRefusal.reason;
    return null;
  };

  // The size Fit draws at (R-10, rule 9): the draft's while one is typed, else the stored look's.
  const drawnChip = (() => {
    const sizes = clips.map(({ clip }) => {
      // Typed words are drafted for the one title shown, and a look for the title it was typed for.
      const typing = draft.result?.ok && (drafting !== null ? drafting.clipId === clip.id : single !== null) ? draft.result : null;
      const look = typing && drafting?.look ? patchTextLook(clip.source.look, drafting.look) : clip.source.look;
      const drawn = typing?.ok ? typing.drawnSize : (() => { const stored = draft.stored.get(clip.id); return stored?.ok ? stored.drawnSize : null; })();
      return drawn === null ? null : { size: Number((look.size * 100).toFixed(1)), drawn: Number((drawn * 100).toFixed(1)) };
    });
    const first = sizes[0];
    if (!first || sizes.some(entry => entry === null || entry.size !== first.size || entry.drawn !== first.drawn) || first.drawn >= first.size) return null;
    return `drawn ${first.drawn} %`;
  })();

  const typeface = sameOf(looks.map(look => look.typeface));
  const weight = sameOf(looks.map(look => look.weight));
  const italic = sameOf(looks.map(look => look.italic));
  const capitals = sameOf(looks.map(look => look.capitals));
  const noBold = looks.some(look => !textTypefaceFile(look.typeface, "bold", look.italic).ok);
  const noItalic = looks.some(look => !textTypefaceFile(look.typeface, look.weight, true).ok);
  const placeAt = sameOf(looks.map(look => ({ x: look.x, y: look.y, align: look.align })));
  const placeName = placeAt === MIXED ? "Mixed" : namedTextPlace(placeAt) ?? "Custom";
  const align = sameOf(looks.map(look => look.align));
  const count = sameOf(looks.map(look => fillColours(look.fill).length));
  const number = (field: TextLookNumber): Mixed<number> => {
    const values = looks.map(look => lookNumber(look, field));
    return values.some(value => value === undefined) ? MIXED : sameOf(values.map(value => value ?? 0));
  };
  const numberField = (field: TextLookNumber, label: string, name?: string, extra: { slider?: boolean; chip?: string | null } = {}) =>
    <TextNumber key={field} field={field} label={label} name={name} value={number(field)} disabled={disabled} resetToken={`${ids}/${resetToken}`}
      refusal={refusalUnder(field)} {...extra}
      onDraft={value => preview(field, value === null ? null : look => numberPatch(look, field, value))}
      onCommit={value => void commit(field, `Change text ${(name ?? label).toLowerCase()}`, look => numberPatch(look, field, value))} />;
  const swatchId = (label: string) => `${swatchRefusalId}-${label.replace(/\s+/g, "-")}`;
  const swatch = (label: string, colourOf: (look: TextLook) => string | undefined, edit: (look: TextLook, colour: string) => TextLookPatch) => {
    const colours = looks.map(colourOf);
    const value = colours.some(colour => colour === undefined) ? MIXED : sameOf(colours.map(colour => lower(colour ?? "")));
    return <TextSwatch key={label} label={label} value={value} fallback={colours.find(colour => colour !== undefined) ?? ANY_COLOUR} disabled={disabled}
      refusal={refusalUnder(label)} refusalId={swatchId(label)}
      onDraft={colour => preview(label, colour === null ? null : look => edit(look, colour))}
      onCommit={colour => void commit(label, `Change text ${label.toLowerCase()}`, look => edit(look, colour))} />;
  };
  /** A swatch's refusal, under the row it sits in: a row is too narrow to say it beside the swatch. */
  const swatchRefusal = (...labels: string[]) => {
    const label = labels.find(candidate => refusalUnder(candidate) !== null);
    return label === undefined ? null : <Refusal id={swatchId(label)} reason={refusalUnder(label)} />;
  };
  /** An optional part (rule 7): on for every title, off for every one, or Mixed where some have it. */
  const part = (key: TextPart) => {
    const has = looks.map(look => look[key] !== undefined);
    const on = has.every(Boolean), mixed = !on && has.some(Boolean);
    const patch = on ? partOff(key) : partOn(key, looks);
    return { on, mixed, disabled, refusal: refusalUnder(key), onToggle: () => void commit(key, on ? `Remove text ${key}` : `Add text ${key}`, () => patch) };
  };

  const chooseFace = async (id: TextTypefaceId) => {
    setMenuOpen(false); text.onTypefaceList(false);
    queueMicrotask(() => faceButton.current?.focus());
    if (typeface === id) return;
    const patch = textTypefacePatch(id, looks);
    await commit("typeface", "Change typeface", () => patch, true);
  };

  if (phone && text.typefaceList) {
    return <div className="fy-cutinspect tx-inspector tx-inspector--list">
      <FaceOptions current={typeface} ready={ready} className="tx-list" onChoose={id => void chooseFace(id)} />
    </div>;
  }

  const backing = sameOf(looks.map(look => look.backing?.kind ?? "none"));
  const everyBacking = looks.every(look => look.backing !== undefined);
  const lookSections = <>
    <Section name="Type">
      {/* The menu closes when the focus leaves it and its button, which a press anywhere else does. */}
      <div className="tx-field tx-type" onBlur={event => {
        const next = event.relatedTarget;
        if (menuOpen && !(next instanceof Node && event.currentTarget.contains(next))) setMenuOpen(false);
      }}>
        <span className="tx-field__label" aria-hidden="true">Typeface</span>
        <button ref={faceButton} type="button" className={cx("tx-face", refusalUnder("typeface") && "bad")} aria-label="Typeface" aria-haspopup="listbox" aria-expanded={menuOpen}
          aria-invalid={refusalUnder("typeface") ? true : undefined} aria-describedby={refusalUnder("typeface") ? faceRefusalId : undefined} disabled={disabled}
          style={typeface !== MIXED && ready.has(typeface) ? { fontFamily: `"${textTypefaceFamily(typeface)}", var(--font-sans)` } : undefined}
          onClick={() => { if (phone) text.onTypefaceList(true); else setMenuOpen(open => !open); }}>
          <span>{faceName(typeface)}</span><ChevronDown size={14} />
        </button>
        {menuOpen && !phone && <FaceOptions current={typeface} ready={ready} className="tx-menu" onChoose={id => void chooseFace(id)}
          onEscape={() => { setMenuOpen(false); faceButton.current?.focus(); }} />}
        <Refusal id={faceRefusalId} reason={refusalUnder("typeface")} />
      </div>
      <Segments label="Weight" value={weight} disabled={disabled} options={[["regular", "Regular"], ["bold", "Bold", noBold]]} refusal={refusalUnder("weight")}
        onChoose={value => void commit("weight", "Change text weight", () => ({ weight: value }))} />
      <div className="tx-checks">
        <TextCheck label="Italic" value={italic} disabled={disabled || noItalic} refusal={refusalUnder("italic")}
          onChange={checked => void commit("italic", "Change text italic", () => ({ italic: checked }), true)} />
        <TextCheck label="Capitals" value={capitals} disabled={disabled} refusal={refusalUnder("capitals")}
          onChange={checked => void commit("capitals", "Change text capitals", () => ({ capitals: checked }), true)} />
      </div>
      {numberField("size", "Size", undefined, { slider: true, chip: drawnChip })}
      <div className="tx-row">{numberField("tracking", "Tracking")}{numberField("leading", "Line", "Line distance")}</div>
    </Section>
    <Section name="Place">
      <TextSelect label="Place" value={placeName} disabled={disabled} refusal={refusalUnder("place")}
        onChange={value => {
          const place = TEXT_PLACES.find(candidate => candidate.name === value);
          if (place) void commit("place", "Change text place", () => ({ x: place.x, y: place.y, align: place.align }));
        }}>
        {placeName === "Mixed" && <option value="Mixed" disabled>Mixed</option>}
        {TEXT_PLACES.map(place => <option key={place.name} value={place.name}>{place.name}</option>)}
        {/* Custom is what Place reads once X, Y or the alignment is changed by hand, and is listed only then (rule 11). */}
        {placeName === "Custom" && <option value="Custom" disabled>Custom</option>}
      </TextSelect>
      <Segments label="Align" value={align} disabled={disabled} options={[["left", "Left"], ["center", "Centre"], ["right", "Right"]]} refusal={refusalUnder("align")}
        onChoose={value => void commit("align", "Change text alignment", () => ({ align: value }))} />
      <div className="tx-row">{numberField("x", "X")}{numberField("y", "Y")}{numberField("room", "Max width")}</div>
    </Section>
    <Section name="Fill">
      <TextSelect label="Fill" value={count === MIXED ? "Mixed" : String(count)} disabled={disabled} refusal={refusalUnder("fill")}
        onChange={value => {
          const next = Number(value);
          if (next >= 1 && next <= 4) void commit("fill", "Change text fill", look => ({ fill: fillWithCount(look.fill, next) }));
        }}>
        {count === MIXED && <option value="Mixed" disabled>Mixed</option>}
        {["One colour", "Two colours", "Three colours", "Four colours"].map((name, index) => <option key={name} value={String(index + 1)}>{name}</option>)}
      </TextSelect>
      {count !== MIXED && <>
        <div className="tx-swatches">
          {Array.from({ length: count }, (_, index) => swatch(`Colour ${index + 1}`, look => fillColours(look.fill)[index], (look, colour) => ({ fill: fillWithColour(look.fill, index, colour) })))}
        </div>
        {swatchRefusal(...Array.from({ length: count }, (_, index) => `Colour ${index + 1}`))}
      </>}
    </Section>
    <Section name="Edge" part={part("edge")}>
      {looks.every(look => look.edge) && <>
        <div className="tx-row tx-row--swatch">
          {swatch("Edge colour", look => look.edge?.color, (look, colour) => (look.edge ? { edge: { ...look.edge, color: colour } } : {}))}
          {numberField("edge.width", "Width", "Edge width")}
        </div>
        {swatchRefusal("Edge colour")}
      </>}
    </Section>
    <Section name="Shadow" part={part("shadow")}>
      {looks.every(look => look.shadow) && <>
        <div className="tx-row tx-row--swatch">
          {swatch("Shadow colour", look => look.shadow?.color, (look, colour) => (look.shadow ? { shadow: { ...look.shadow, color: colour } } : {}))}
          {numberField("shadow.opacity", "Opacity", "Shadow opacity")}{numberField("shadow.blur", "Softness", "Shadow softness")}
        </div>
        {swatchRefusal("Shadow colour")}
        <div className="tx-row">{numberField("shadow.dx", "X", "Shadow offset X")}{numberField("shadow.dy", "Y", "Shadow offset Y")}</div>
      </>}
    </Section>
    <Section name="Rule" part={part("rule")}>
      {looks.every(look => look.rule) && <>
        <div className="tx-row">{numberField("rule.length", "Length", "Rule length")}{numberField("rule.weight", "Thickness", "Rule thickness")}{numberField("rule.gap", "Distance", "Rule distance")}</div>
        <div className="tx-checkline">
          <TextCheck label="Faded ends" value={sameOf(looks.map(look => look.rule?.soft ?? false))} disabled={disabled} refusal={refusalUnder("rule.soft")}
            onChange={checked => void commit("rule.soft", "Change text rule", look => (look.rule ? { rule: { ...look.rule, soft: checked } } : {}))} />
        </div>
      </>}
    </Section>
    <Section name="Backing">
      <TextSelect label="Backing" value={backing === MIXED ? "Mixed" : backing} disabled={disabled} refusal={refusalUnder("backing")}
        onChange={kind => {
          if (kind === "none") void commit("backing", "Remove text backing", () => ({ backing: null }));
          else if (kind === "shade" || kind === "box") {
            // A backing held keeps its colour and opacity; a new one starts from the defaults.
            void commit("backing", "Change text backing", look => ({ backing: look.backing ? { ...look.backing, kind } : { ...TEXT_PART_DEFAULTS[kind] } }));
          }
        }}>
        {backing === MIXED && <option value="Mixed" disabled>Mixed</option>}
        <option value="none">None</option><option value="shade">Shade</option><option value="box">Box</option>
      </TextSelect>
      {everyBacking && <>
        <div className="tx-row tx-row--swatch">
          {swatch("Backing colour", look => look.backing?.color, (look, colour) => (look.backing ? { backing: { ...look.backing, color: colour } } : {}))}
          {numberField("backing.opacity", "Opacity", "Backing opacity")}
        </div>
        {swatchRefusal("Backing colour")}
      </>}
    </Section>
  </>;

  if (single === null) {
    return <div className="fy-cutinspect tx-inspector" data-text-clips={clips.length}>
      <div className="fy-cutinspect__eyebrow">TEXT</div>
      <h2>{`${clips.length} clips`}</h2>
      {lookSections}
    </div>;
  }
  const { clip, track } = single;
  return <div className="fy-cutinspect tx-inspector">
    <div className="fy-cutinspect__eyebrow">TEXT</div>
    <h2>{clip.source.label}</h2>
    <WordsField clip={clip} disabled={disabled} draft={draft} focusWords={text.focusWords} resetToken={resetToken} refusal={refusalUnder("words")}
      localRefusal={drafting === null ? draft.localRefusal : null} result={drafting === null ? draft.result : null}
      onRefuse={reason => setRefusal(reason === null ? null : { field: "words", reason })}
      onCommit={typed => onText([{ kind: "text-set", clipIds: [clip.id], text: typed }], "Change text", "words")} />
    {lookSections}
    <PictureClipTiming clip={clip} clips={track.clips} frameRate={frameRate} disabled={disabled} onCommands={onCommands} onScrub={onScrub} sourceLength={sourceLength} timeline={timeline} sourceTimes={false} sourceIn={false} />
    <PictureMotionInspector key={`motion-${clip.id}`} clip={clip} still={transitionStill(clip, artifacts)} frameRate={frameRate} disabled={disabled} onCommands={onCommands} resetToken={resetToken} />
    <PictureAppearanceInspector key={clip.id} clip={clip} frameRate={frameRate} disabled={appearanceDisabled} onCommands={onCommands} resetToken={appearanceRevision ?? resetToken}
      scopeLabel={appearanceScopeLabel} opacityLabel="Opacity" hint={false} />
  </div>;
}

/**
 * The words, as typed (R-4, R-5): Enter is a new line, since a line ends where the author ends it.
 * Every keystroke drafts and none writes (R-32). Leaving the field or Ctrl+Enter commits, once the
 * painter has drawn the words; words it cannot draw are refused under the field in its own words
 * (rule 13) and nothing is sent. Escape gives the stored words back.
 */
function WordsField({ clip, disabled, draft, focusWords, resetToken, refusal, localRefusal, result, onRefuse, onCommit }: {
  clip: TimelineClip & { source: TextSource };
  disabled: boolean;
  draft: TextDraftApi;
  focusWords: { clipId: string; serial: number } | null;
  resetToken: number | undefined;
  refusal: string | null;
  localRefusal: string | null;
  result: TextDraftResult | null;
  onRefuse: (reason: string | null) => void;
  onCommit: (typed: string) => void;
}) {
  const id = useId();
  const stored = clip.source.text;
  const [typed, setTyped] = useState(stored);
  const dirty = useRef(false), area = useRef<HTMLTextAreaElement>(null);
  const clipId: TimelineClipId = clip.id;
  useEffect(() => { if (!dirty.current) setTyped(stored); }, [stored]);
  useLayoutEffect(() => { dirty.current = false; setTyped(stored); }, [clipId, resetToken]);
  // Add text: the placed clip arrives with its words selected, so typing replaces them (R-29).
  const serial = focusWords?.clipId === clipId ? focusWords.serial : null;
  useEffect(() => {
    if (serial === null || area.current === null) return;
    area.current.focus(); area.current.select();
  }, [serial]);
  const revert = () => { dirty.current = false; setTyped(stored); draft.want(null); onRefuse(null); };
  // A commit waiting on the painter's check is not made twice by a blur or an unmount that follows it.
  const checking = useRef(false);
  const commit = async () => {
    if (!dirty.current || disabled || checking.current) return;
    const words = textWords(typed);
    if (!words.ok) { onRefuse(words.reason); return; }
    if (words.text === stored) { dirty.current = false; draft.want(null); onRefuse(null); return; }
    // The draft's own answer for these words when it has come; otherwise the painter is asked once
    // more, briefly. No answer at all still commits: the command's own check refuses what it must.
    let verdict = result;
    if (verdict === null) {
      checking.current = true;
      try { verdict = (await draft.measure([{ text: typed, look: clip.source.look }], CHECK_MS))?.[0] ?? null; }
      finally { checking.current = false; }
    }
    if (verdict !== null && !verdict.ok) { onRefuse(verdict.reason); return; }
    dirty.current = false; onRefuse(null);
    draft.hold(); draft.want(null);
    onCommit(typed);
  };
  useLeaveCommits(() => { draft.setWordsFocus(null); void commit(); });
  const shown = refusal ?? localRefusal ?? (result !== null && !result.ok ? result.reason : null);
  return <section className="tx-section" aria-label="Words">
    <h3><label htmlFor={id}>Words</label></h3>
    <textarea ref={area} id={id} className={cx("tx-words", shown && "bad")} aria-label="Words" rows={3} value={typed} disabled={disabled} spellCheck={false}
      aria-invalid={shown ? true : undefined} aria-describedby={shown ? `${id}-refusal` : undefined}
      onFocus={() => draft.setWordsFocus(clipId)}
      onInput={event => {
        const next = event.currentTarget.value;
        dirty.current = true; setTyped(next); onRefuse(null);
        draft.want(next === stored ? null : { clipId, text: next });
      }}
      onBlur={() => { draft.setWordsFocus(null); void commit(); }}
      onKeyDown={event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); void commit(); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); revert(); }
      }} />
    <Refusal id={`${id}-refusal`} reason={shown} />
  </section>;
}

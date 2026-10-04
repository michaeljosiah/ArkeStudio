import { useState, type ReactNode } from "react";
import {
  AUDIOBOOK_DELIVERIES,
  CADENCE_NOTE_MAX,
  CADENCE_PHRASE_MAX,
  ONE_REQUEST_HOLD,
  SOUNDS,
  cadenceSupport,
  cueStart,
  isPointCue,
  markerMode,
  type CadenceCue,
  type CadencePlan,
  type DeliveryMarker,
  type HeldControl,
  type ManifestModel,
  type VoiceDirectionInput,
} from "@arke-studio/contracts";

/**
 * One voice direction for every speech surface (design turn 181): the markers on the words, the
 * menu that places them and what a reader is sent, shared by the audiobook's blocks and the
 * Bench's line so the two cannot drift. The direction itself — the plan, the compiler, what a
 * reader can take — is the contract's (`cadence.ts`); this is only how it is drawn and written.
 */

/** A plan for the view alone: the window holds no digest of the words, and none is checked here. */
export const VIEW_HASH = `sha256:${"0".repeat(64)}`;
export function viewPlan(input: VoiceDirectionInput): CadencePlan {
  return { schemaVersion: 1, sourceTextHash: VIEW_HASH, ...(input.delivery !== undefined ? { delivery: input.delivery } : {}), speed: input.speed, cues: input.cues, ...(input.note !== undefined ? { note: input.note } : {}) };
}

/** A marker's word on the page (R-42): `[whispered]`, `[pause]`, `[breath]`, `[emphasis]`, `[sighs]`. */
export function markerLabel(cue: CadenceCue): string {
  if (cue.kind === "delivery") return `[${[cue.delivery, cue.phrase].filter((part) => part !== undefined).join(" · ")}]`;
  if (cue.kind === "sound") return `[${cue.sound}]`;
  if (cue.kind === "pause") return cue.length === "long" ? "[long pause]" : "[pause]";
  return `[${cue.kind}]`;
}

/**
 * A cue in the panel's words: `pause · long · after works,`. The words are the block's, verbatim
 * (turn 165): a line's own quotation marks are already in them, so wrapping them in ours printed
 * `““Whoever cut the tenth key,””` (issue 1324 §3). The plate beside it says what the marker is.
 */
export function cueLabel(text: string, cue: CadencePlan["cues"][number]): string {
  const after = (at: number) => `after ${text.slice(Math.max(0, at - 12), at).replace(/^\S*\s/, "").trim()}`;
  if (cue.kind === "pause") return `pause · ${cue.length} · ${after(cue.at)}`;
  if (cue.kind === "breath") return `${cue.action} · before ${text.slice(cue.at, cue.at + 12).replace(/\s\S*$/, "").trim()}`;
  if (cue.kind === "delivery") return cue.span.text;
  if (cue.kind === "sound") return `${cue.sound} · ${after(cue.at)}`;
  return `emphasis · ${cue.level} · ${cue.span.text}`;
}

/**
 * What is held, as the line under Sent as says it (design turn 181): `cold · note · emphasis ·
 * sighs`, each named by what it is, in the plan's order.
 */
export function heldWords(plan: Pick<CadencePlan, "delivery" | "cues">, held: readonly HeldControl[]): string[] {
  return held.map((control) => {
    if (control.control === "delivery") return plan.delivery ?? "delivery";
    if (control.control === "note") return "note";
    if (control.control === "speed") return "speed";
    const cue = control.cueIndex === undefined ? undefined : plan.cues[control.cueIndex];
    if (cue === undefined) return control.control;
    if (cue.kind === "sound") return cue.sound;
    if (cue.kind === "delivery") return cue.delivery ?? cue.phrase ?? "marker";
    if (cue.kind === "pause") return cue.length === "long" ? "long pause" : "pause";
    return cue.kind;
  });
}

/**
 * Where each character of the normalised words sits in the text as written (R-42): a cue's
 * offsets are the normalised words', while the page shows the prose as written, wraps and all,
 * so a selection keeps meaning the words the person chose. One entry past the end.
 */
export function normalisedToRaw(raw: string): number[] {
  const map: number[] = [];
  let index = 0;
  while (index < raw.length && /\s/.test(raw[index]!)) index += 1;
  let space = -1;
  for (; index < raw.length; index += 1) {
    if (/\s/.test(raw[index]!)) {
      if (space < 0) space = index;
      continue;
    }
    if (space >= 0) map.push(space);
    space = -1;
    map.push(index);
  }
  map.push(space >= 0 ? space : raw.length);
  return map;
}

/** The normalised offset of a place in the text as written: a caret or a selection's edge. */
export function rawToNormalised(raw: string, at: number): number {
  const map = normalisedToRaw(raw);
  let found = map.length - 1;
  for (let index = 0; index < map.length; index += 1) {
    if (map[index]! >= at) {
      found = index;
      break;
    }
  }
  return found;
}

/** Where a sentence that begins at `from` ends, for a delivery marker placed at a caret (R-42). */
export function sentenceEnd(text: string, from: number): number {
  const rest = text.slice(from);
  const end = rest.search(/[.!?…]["'”’)\]]*(\s|$)/);
  if (end < 0) return text.length;
  const match = rest.slice(end).match(/^[.!?…]["'”’)\]]*/);
  return from + end + (match?.[0].length ?? 1);
}

/**
 * Where a turn begins in a block's words (design turn 190): a block read by one voice is a
 * paragraph of several speakers' turns. The break holds no text, so a selection's offsets still
 * count the words alone; the stylesheet draws the rule and the speaker's name from its data.
 */
export interface TurnBreak { at: number; label: string; tone: string; /** The full name, where `label` is a short one (design turn 194, rule 12b). */ full?: string }

/**
 * The words with their markers in place (R-42): each its word in brackets on a plate — drawn by
 * the stylesheet from `data-mk`, so the plate is no text of the page and a selection's offsets
 * still count the words alone — a delivery filled, a cue dashed, a sound outlined in italic
 * (design turn 181), a delivery marker's span underlined, a held control struck (R-47). A press
 * on a plate opens the menu to change or remove it.
 */
export function DirectedText({ raw, cues, held, onPlate, turns = [] }: { raw: string; cues: readonly CadenceCue[]; held: ReadonlySet<number>; onPlate?: (index: number) => void; turns?: readonly TurnBreak[] }) {
  if (cues.length === 0 && turns.length === 0) return <>{raw}</>;
  const map = normalisedToRaw(raw);
  // Where each later turn of a block begins, in the normalised words the cues use.
  const turnAt = turns.map((turn) => ({ ...turn, at: rawToNormalised(raw, turn.at) }));
  const at = (normalised: number) => map[Math.min(Math.max(normalised, 0), map.length - 1)]!;
  const cuts = new Set<number>([0, map.length - 1]);
  for (const turn of turnAt) cuts.add(turn.at);
  for (const cue of cues) {
    cuts.add(cueStart(cue));
    if (cue.kind === "emphasis" || cue.kind === "delivery") cuts.add(cue.span.to);
  }
  const edges = [...cuts].filter((edge) => edge >= 0 && edge <= map.length - 1).sort((a, b) => a - b);
  const plate = (cue: CadenceCue, index: number) => (
    <span
      key={`mk${index}`}
      className={`fy-ab__mk${cue.kind === "delivery" ? "" : cue.kind === "sound" ? " fy-ab__mk--sound" : " fy-ab__mk--cue"}${held.has(index) ? " fy-ab__mk--held" : ""}`}
      data-mk={markerLabel(cue)}
      role="button"
      tabIndex={-1}
      aria-label={`${markerLabel(cue)}${held.has(index) ? " · held" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onPlate?.(index);
      }}
    />
  );
  const out: ReactNode[] = [];
  // Words before the first edge the normalisation trimmed — leading space — stay as written.
  if (at(0) > 0) out.push(raw.slice(0, at(0)));
  for (let index = 0; index < edges.length; index += 1) {
    const from = edges[index]!;
    for (const turn of turnAt) {
      if (turn.at === from) out.push(<span key={`turn${from}`} className={`fy-ab__turn fy-voice--${turn.tone}`} data-who={turn.label} aria-hidden="true" />);
    }
    cues.forEach((cue, cueIndex) => {
      if (cueStart(cue) === from) out.push(plate(cue, cueIndex));
    });
    const to = edges[index + 1];
    if (to === undefined) break;
    const words = raw.slice(at(from), at(to));
    if (words === "") continue;
    const marked = cues.some((cue) => cue.kind === "delivery" && cue.span.from <= from && cue.span.to >= to);
    const stressed = cues.some((cue) => cue.kind === "emphasis" && cue.span.from <= from && cue.span.to >= to);
    out.push(
      marked || stressed ? (
        <span key={`w${from}`} className={`${marked ? "fy-ab__mks" : ""}${stressed ? `${marked ? " " : ""}fy-ab__emph` : ""}`}>
          {words}
        </span>
      ) : (
        words
      ),
    );
  }
  if (at(map.length - 1) < raw.length) out.push(raw.slice(at(map.length - 1)));
  return <>{out}</>;
}

/** Where the marker menu is open: the words or caret it was opened at, and the marker pressed when one was. */
export interface MarkerAt {
  key: string;
  span: { from: number; to: number };
  edit?: number;
  /** One group alone, for a press that names it: the block panel's `+ Sound` (design turn 181e). */
  only?: "sound";
}

/**
 * The marker menu (design turns 155f, 165b and 181b, SPEC-047 R-42): a search, the six
 * deliveries, the cues, the sounds, a marker's phrase and — on the Bench — the note. What the
 * reader cannot do is struck with the reason as its hint, never accepted to be flagged later;
 * a reader that makes no sound has the group struck with one clause under it. From a caret a
 * delivery marker runs to the end of the sentence and a cue or a sound sits at the caret; an
 * emphasis needs words. `oneRequest` is a surface that joins no parts (the Bench): a delivery
 * marker the reader could only make in parts is struck there too.
 */
export function MarkerMenu({ text, base, language, at, model, oneRequest = false, only = at.only, onApply, onClose, onNote }: {
  /** The words, normalised as cues are placed. */
  text: string;
  base: VoiceDirectionInput;
  language?: string;
  at: MarkerAt;
  model: ManifestModel | null;
  oneRequest?: boolean;
  /** One group alone, for a press that names it: the block panel's `+ Sound` (design turn 181e). */
  only?: "sound";
  onApply: (cues: CadenceCue[] | null) => void;
  onClose: () => void;
  /** The note, where the surface has one beside the words (the Bench): the menu's last item. */
  onNote?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const editing = at.edit === undefined ? undefined : base.cues[at.edit];
  const caret = at.span.from === at.span.to;
  const span = editing !== undefined && (editing.kind === "delivery" || editing.kind === "emphasis") ? editing.span : { from: at.span.from, to: caret ? sentenceEnd(text, at.span.from) : at.span.to, text: "" };
  const words = { from: span.from, to: span.to, text: text.slice(span.from, span.to) };
  const support = model === null ? null : cadenceSupport(model, language);
  const match = (label: string) => label.toLowerCase().includes(query.trim().toLowerCase());
  // A marker placed replaces what it would break (R-40): another marker over the same words,
  // an emphasis across its edge, the same cue or sound at the same place; the cue being changed
  // is replaced by its new self.
  const place = (cue: CadenceCue) => {
    const others = base.cues.filter((other, index) => {
      if (index === at.edit) return false;
      if (cue.kind === "delivery" && (other.kind === "delivery" || other.kind === "emphasis")) {
        const overlaps = other.span.from < cue.span.to && other.span.to > cue.span.from;
        if (!overlaps) return true;
        return other.kind === "emphasis" && other.span.from >= cue.span.from && other.span.to <= cue.span.to;
      }
      if (cue.kind === "emphasis" && other.kind === "emphasis") return !(other.span.from < cue.span.to && other.span.to > cue.span.from);
      if (cue.kind === "sound" && other.kind === "sound") return !(other.at === cue.at && other.sound === cue.sound);
      if (isPointCue(cue) && other.kind === cue.kind) return other.at !== cue.at;
      return true;
    });
    onApply([...others, cue].sort((a, b) => cueStart(a) - cueStart(b)));
  };
  const struck = (reason: string | null) => (reason === null ? null : `${model?.displayName ?? "this reader"} ${reason}`);
  const deliveryReason = (delivery: DeliveryMarker["delivery"]) => {
    if (model === null) return "no reader";
    if (words.text.trim() === "") return "no words";
    const mode = markerMode({ kind: "delivery", span: words, ...(delivery !== undefined ? { delivery } : {}), ...(delivery === undefined ? { phrase: "x" } : {}) }, viewPlan(base), model, language, text.length);
    if (mode.mode === "unsupported") return mode.reason;
    return oneRequest && mode.mode === "parts" ? ONE_REQUEST_HOLD : null;
  };
  const chip = (key: string, label: string, reason: string | null, on: boolean, press: () => void, sound = false) =>
    match(label) ? (
      <button
        key={key}
        type="button"
        className={`fy-ab__mchip${sound ? " fy-ab__mchip--sound" : ""}${on ? " fy-ab__mchip--on" : ""}${reason !== null ? " fy-ab__mchip--struck" : ""}`}
        disabled={reason !== null}
        title={struck(reason) ?? label}
        onClick={press}
      >
        {label}
      </button>
    ) : null;
  const cueReason = (kind: "pause" | "breath" | "emphasis") => {
    if (support === null) return "no reader";
    if (kind === "emphasis" && caret && editing === undefined) return "select words";
    return support[kind].status === "unsupported" ? (support[kind].reason ?? `no ${kind}`) : null;
  };
  // A point marker changed from its plate stays where it is; from a caret, a new one sits there.
  const point = editing !== undefined && isPointCue(editing) ? editing.at : caret ? at.span.from : undefined;
  const soundReasons = SOUNDS.map((sound) => (support === null ? "no reader" : support.sounds[sound].status === "unsupported" ? (support.sounds[sound].reason ?? "no sounds") : null));
  const noSounds = soundReasons.every((reason) => reason !== null);
  const soundChips = SOUNDS.map((sound, index) =>
    chip(`s:${sound}`, sound, soundReasons[index]!, editing?.kind === "sound" && editing.sound === sound, () => place({ kind: "sound", at: point ?? span.to, sound }), true),
  );
  return (
    <div className="fy-ab__menu fy-ab__menu--marker" role="menu" aria-label="Marker" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.key === "Escape" && onClose()}>
      <input className="fy-ab__menu-search" placeholder={only === "sound" ? "Sound" : "Marker"} aria-label={only === "sound" ? "Sound" : "Marker"} value={query} autoFocus onChange={(event) => setQuery(event.target.value)} />
      {only !== "sound" && (
        <>
          <div className="fy-ab__menu-eb">Delivery</div>
          <div className="fy-ab__mgrid">
            {AUDIOBOOK_DELIVERIES.map((delivery) =>
              chip(`d:${delivery}`, delivery, deliveryReason(delivery), editing?.kind === "delivery" && editing.delivery === delivery, () =>
                place({ kind: "delivery", span: words, delivery, ...(editing?.kind === "delivery" && editing.phrase !== undefined ? { phrase: editing.phrase } : {}) }),
              ),
            )}
          </div>
          <div className="fy-ab__menu-eb">Cue</div>
          <div className="fy-ab__mgrid">
            {chip("c:short", "pause · short", cueReason("pause"), editing?.kind === "pause" && editing.length === "short", () => place({ kind: "pause", at: point ?? span.to, length: "short" }))}
            {chip("c:long", "pause · long", cueReason("pause"), editing?.kind === "pause" && editing.length === "long", () => place({ kind: "pause", at: point ?? span.to, length: "long" }))}
            {chip("c:breath", "breath", cueReason("breath"), editing?.kind === "breath", () => place({ kind: "breath", at: point ?? span.from, action: "inhale" }))}
            {chip("c:emphasis", "emphasis", cueReason("emphasis"), editing?.kind === "emphasis", () => place({ kind: "emphasis", span: words, level: "moderate" }))}
          </div>
        </>
      )}
      {soundChips.some((node) => node !== null) && (
        <>
          <div className="fy-ab__menu-eb">Sound</div>
          <div className="fy-ab__mgrid" aria-label="Sound">{soundChips}</div>
          {noSounds && model !== null && <p className="fy-ab__menu-why fy-mono">{`${model.displayName} · ${soundReasons[0]}`}</p>}
        </>
      )}
      {only !== "sound" && <div className="fy-ab__menu-sep" />}
      {only === "sound" ? null : phrase === null ? (
        (() => {
          const reason = deliveryReason(undefined);
          return (
            <button type="button" role="menuitem" className="fy-ab__menu-opt" disabled={reason !== null} title={struck(reason) ?? "Phrase"} onClick={() => setPhrase(editing?.kind === "delivery" ? (editing.phrase ?? "") : "")}>
              <span className={`fy-ab__menu-label${reason !== null ? " fy-ab__mchip--struck" : ""}`}>Phrase…</span>
              <span className="fy-ab__menu-meta">{CADENCE_PHRASE_MAX}</span>
            </button>
          );
        })()
      ) : (
        <input
          className="fy-ab__menu-search fy-mono"
          aria-label="Phrase"
          maxLength={CADENCE_PHRASE_MAX}
          value={phrase}
          autoFocus
          onChange={(event) => setPhrase(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const trimmed = phrase.trim();
            if (trimmed === "") return;
            place({ kind: "delivery", span: words, phrase: trimmed.slice(0, CADENCE_PHRASE_MAX), ...(editing?.kind === "delivery" && editing.delivery !== undefined ? { delivery: editing.delivery } : {}) });
          }}
        />
      )}
      {onNote !== undefined && only !== "sound" && (
        <button type="button" role="menuitem" className="fy-ab__menu-opt" onClick={onNote}>
          <span className="fy-ab__menu-label">Note…</span>
          <span className="fy-ab__menu-meta">{CADENCE_NOTE_MAX}</span>
        </button>
      )}
      {editing !== undefined && (
        <button type="button" role="menuitem" className="fy-ab__menu-opt" onClick={() => onApply(base.cues.filter((_, index) => index !== at.edit))}>
          <span className="fy-ab__menu-label">Remove</span>
        </button>
      )}
    </div>
  );
}

/**
 * What the reader is sent, exactly (design turn 181): the style, the text, and what is held —
 * mono on the secondary fill, labels and data only.
 */
export function SentAs({ style, text, held, reader }: { style?: string; text: string; held: readonly string[]; reader?: string }) {
  return (
    <div className="fy-vd__sent fy-mono" data-testid="sent-as">
      <span className="fy-vd__sent-k">Sent as</span>
      {style !== undefined && (
        <span className="fy-vd__sent-row">
          <span className="fy-vd__sent-k">style</span> {style}
        </span>
      )}
      <span className="fy-vd__sent-row">
        <span className="fy-vd__sent-k">text</span> {text}
      </span>
      {held.length > 0 && (
        <span className="fy-vd__sent-row fy-vd__sent-held">
          <span className="fy-vd__sent-k">Held</span> {held.join(" · ")}
          {reader !== undefined ? ` — ${reader}` : ""}
        </span>
      )}
    </div>
  );
}

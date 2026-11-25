import {
  applyLookPreset,
  LOOK_CHECK_MAX,
  LOOK_CHECKS_MAX,
  LOOK_PRESET_NAMES,
  LOOK_PRESETS,
  LOOK_WORDS_MAX,
  type ProductionLook,
} from "@arke-studio/contracts";
import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Input, Select } from "../components/ui.js";
import { Plus } from "../components/icons.js";
import { setProductionLook, subscribeCommandFailures } from "../lib/store.js";

/**
 * The production's look (design turns 287 and 288a): a card in Production settings, after Clips and
 * before Models, drawn as the Models card is. A preset fills the choices and nothing else; each part
 * is a choice and a few words; the production's own checks are lines. Every change writes the look
 * whole (`set-production-look`), so what is written is what the card shows.
 *
 * A screen labels; it never explains: no caption under a row, and the words fields carry their
 * part's name only as an accessible label.
 */
type Part = "camera" | "light" | "lens" | "grade" | "cutting" | "sound" | "performance";

const INSERTS = [0.5, 1, 1.5, 2] as const;

export function ProductionLookCard({ look, worldId, prodId }: {
  look: ProductionLook | undefined;
  worldId: string | undefined;
  prodId: string | undefined;
}) {
  /*
   * The look as last written, not as last received. Each change is the whole look, and the app's
   * answer arrives after a round trip: composed from the received look, a preset pressed just after
   * leaving a words field would write the old words back over the new (codex on PR 3302). And the
   * answers can arrive late, out of step with the writes: typing seven words fields on Gold on Gold
   * (0.5.133) kept two, because each late answer to an earlier write replaced the newer one. So an
   * answer that is one of this card's own writes is an echo: the newest means the app has caught up,
   * an older one is late and is not shown. A look the card did not write (Arke's card, another
   * window) is taken as it comes.
   */
  const [shown, setShown] = useState<ProductionLook>(look ?? {});
  const latest = useRef<ProductionLook>(look ?? {});
  const echoes = useRef<string[]>([]);
  const received = canonical(look ?? {});
  useEffect(() => {
    const sent = echoes.current;
    if (sent.includes(received)) {
      if (received === sent[sent.length - 1]) echoes.current = [];
      return;
    }
    echoes.current = [];
    latest.current = look ?? {};
    setShown(look ?? {});
    // `received` stands for `look`: a new object with the same look is not a new look.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [received]);
  /*
   * A refused write changes nothing in the world, so its snapshot carries the look as it was, which
   * reads the same as before and runs nothing above: the card would go on showing what was refused
   * (codex on PR 3304). A refusal of this command puts the card back to the look as received.
   */
  const saved = useRef(look);
  saved.current = look;
  useEffect(() => subscribeCommandFailures((failure) => {
    if (failure.command !== "set-production-look") return;
    echoes.current = [];
    latest.current = saved.current ?? {};
    setShown(saved.current ?? {});
  }), []);
  const write = (next: ProductionLook) => {
    latest.current = next;
    setShown(next);
    echoes.current = [...echoes.current, canonical(next)];
    if (worldId && prodId) setProductionLook(worldId, prodId, Object.keys(next).length > 0 ? next : null);
  };
  const current = shown;
  // A choice changed after a preset is the person's own: the preset no longer describes the look.
  const choose = <K extends Part>(part: K, change: Partial<NonNullable<ProductionLook[K]>>) => {
    const { preset: _preset, ...rest } = latest.current;
    write({ ...rest, [part]: { ...latest.current[part], ...change } });
  };
  const words = <K extends Part>(part: K, value: string) => {
    const kept = { ...latest.current[part] } as Record<string, unknown>;
    const trimmed = value.trim();
    if (trimmed) kept.words = trimmed;
    else delete kept.words;
    write({ ...latest.current, [part]: kept });
  };
  return (
    <section className="fy-models fy-look" aria-label="Look">
      <div className="fy-models__head"><h3>Look</h3></div>
      <Row name="Preset">
        <span className="fy-takechips">
          {LOOK_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`fy-takechip${current.preset === preset ? " fy-takechip--on" : ""}`}
              aria-pressed={current.preset === preset}
              onClick={() => write(applyLookPreset(latest.current, preset))}
            >
              {LOOK_PRESET_NAMES[preset]}
            </button>
          ))}
        </span>
      </Row>
      <Row name="Camera">
        <Seg label="Camera" values={["handheld", "steady", "locked", "shaky"]} names={["Handheld", "Steady", "Locked", "Shaky"]}
          value={current.camera?.kind} onChange={(kind) => choose("camera", { kind })} />
        <Seg label="Camera strength" values={["gentle", "strong"]} names={["Gentle", "Strong"]}
          value={current.camera?.strength} onChange={(strength) => choose("camera", { strength })} />
        <Checkbox label="Push in on a beat" checked={current.camera?.pushOnBeat === true}
          onChange={(e) => choose("camera", { pushOnBeat: e.target.checked })} />
        <Words part="Camera" value={current.camera?.words} onCommit={(value) => words("camera", value)} />
      </Row>
      <Row name="Light">
        <Seg label="Light" values={["low", "high"]} names={["Low key", "High key"]}
          value={current.light?.key} onChange={(key) => choose("light", { key })} />
        <Words part="Light" wide value={current.light?.words} onCommit={(value) => words("light", value)} />
      </Row>
      <Row name="Lens and focus">
        <Seg label="Lens" values={["wide", "normal", "long"]} names={["Wide", "Normal", "Long"]}
          value={current.lens?.length} onChange={(length) => choose("lens", { length })} />
        <Seg label="Focus" values={["shallow", "deep"]} names={["Shallow", "Deep"]}
          value={current.lens?.focus} onChange={(focus) => choose("lens", { focus })} />
        <Words part="Lens and focus" value={current.lens?.words} onCommit={(value) => words("lens", value)} />
      </Row>
      <Row name="Grade">
        <Words part="Grade" wide value={current.grade?.words} onCommit={(value) => words("grade", value)} />
      </Row>
      <Row name="Cutting">
        <Checkbox label="Split cuts" checked={current.cutting?.splitCuts === true}
          onChange={(e) => choose("cutting", { splitCuts: e.target.checked })} />
        <Select label="Inserts" value={String(current.cutting?.insertSec ?? "")}
          onChange={(e) => e.target.value && choose("cutting", { insertSec: Number(e.target.value) })}>
          {current.cutting?.insertSec === undefined && <option value="">Inserts</option>}
          {/* A length a preset or Arke wrote that the list does not hold (Thriller's 0.8 s) is still shown as it is. */}
          {[...new Set([...INSERTS, ...(current.cutting?.insertSec !== undefined ? [current.cutting.insertSec] : [])])]
            .sort((a, b) => a - b)
            .map((sec) => <option key={sec} value={sec}>{`Inserts ${sec} s`}</option>)}
        </Select>
        <Words part="Cutting" value={current.cutting?.words} onCommit={(value) => words("cutting", value)} />
      </Row>
      <Row name="Sound">
        <Checkbox label="One room tone a place" checked={current.sound?.roomTonePerPlace === true}
          onChange={(e) => choose("sound", { roomTonePerPlace: e.target.checked })} />
        <Checkbox label="Keep the model’s clear effects" checked={current.sound?.keepModelEffects === true}
          onChange={(e) => choose("sound", { keepModelEffects: e.target.checked })} />
        <Words part="Sound" value={current.sound?.words} onCommit={(value) => words("sound", value)} />
      </Row>
      <Row name="Performance">
        <Seg label="Performance" values={["naturalistic", "heightened", "deadpan"]} names={["Naturalistic", "Heightened", "Deadpan"]}
          value={current.performance?.style} onChange={(style) => choose("performance", { style })} />
        <Words part="Performance" value={current.performance?.words} onCommit={(value) => words("performance", value)} />
      </Row>
      <Row name="Own checks">
        <OwnChecks checks={current.checks ?? []} onChange={(checks) => {
          const { checks: _checks, ...rest } = latest.current;
          write(checks.length > 0 ? { ...rest, checks } : rest);
        }} />
      </Row>
    </section>
  );
}

/** A look as text with its keys in order, so the same look written and read back compares equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)))
      : inner);
}

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return <div className="fy-models__row"><span className="fy-models__what">{name}</span>{children}</div>;
}

/** The app's segmented control (fy-seg), one choice of a few. */
function Seg<V extends string>({ label, values, names, value, onChange }: {
  label: string;
  values: readonly V[];
  names: readonly string[];
  value: V | undefined;
  onChange: (value: V) => void;
}) {
  return (
    <span className="fy-seg" role="group" aria-label={label}>
      {values.map((option, i) => (
        <button key={option} type="button" className={`fy-seg__item${value === option ? " fy-seg__item--active" : ""}`}
          aria-pressed={value === option} onClick={() => value !== option && onChange(option)}>
          {names[i]}
        </button>
      ))}
    </span>
  );
}

/** A part's few words: written when the field is left or Enter is pressed, never on each key. */
function Words({ part, value, wide = false, onCommit }: {
  part: string;
  value: string | undefined;
  wide?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  // Read from the field itself when it is left: what is in the box is what is written.
  const commit = (typed: string) => { if (typed.trim() !== (value ?? "")) onCommit(typed); };
  return (
    <Input className={`fy-look__words${wide ? " fy-look__words--wide" : ""}`} aria-label={`${part} words`} value={draft}
      maxLength={LOOK_WORDS_MAX} onChange={(e) => setDraft(e.target.value)} onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => { if (e.key === "Enter") commit(e.currentTarget.value); }} />
  );
}

/** The production's own checks: a line each, emptied to remove, and Add for one more. */
function OwnChecks({ checks, onChange }: { checks: readonly string[]; onChange: (checks: string[]) => void }) {
  const [lines, setLines] = useState<string[]>([...checks]);
  // By content, not by identity: an empty list is a new array on every draw, and resetting on it
  // took away the line Add had just put there (0.5.133).
  const said = JSON.stringify(checks);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setLines([...checks]), [said]);
  const commit = (next: string[]) => {
    const kept = next.map((line) => line.trim()).filter(Boolean);
    if (JSON.stringify(kept) !== JSON.stringify(checks)) onChange(kept);
  };
  return (
    <span className="fy-look__lines">
      {lines.map((line, i) => {
        const withTyped = (typed: string) => lines.map((old, j) => (j === i ? typed : old));
        return (
          <Input key={i} className="fy-look__line" aria-label="Own check" value={line} maxLength={LOOK_CHECK_MAX}
            onChange={(e) => setLines(withTyped(e.target.value))}
            onBlur={(e) => commit(withTyped(e.currentTarget.value))}
            onKeyDown={(e) => { if (e.key === "Enter") commit(withTyped(e.currentTarget.value)); }} />
        );
      })}
      {lines.length < LOOK_CHECKS_MAX && (
        <Button variant="ghost" size="sm" onClick={() => setLines([...lines, ""])}><Plus size={14} />Add</Button>
      )}
    </span>
  );
}

import { useState, type ReactNode } from "react";
import { STAGE_KIT_KINDS, STAGE_KIT_LABELS, type StageKit } from "@arke-studio/contracts";
import { Plus, X } from "../../components/icons.js";
import { Row, Stepper, Value } from "./stage-inspector.js";

/**
 * The set kit on the Stage (issue 1819, design turn 229e): Add set opens the kit, and a kit
 * item's form says what it is and, for a room, which sides are open and where its doors and
 * windows are. Everything else — place, size, turn, group — is the set form it always was.
 */

export type AddSetChoice = StageKit["kind"] | "box" | "cylinder" | "sphere";
const PRIMITIVES: ReadonlyArray<[AddSetChoice, string]> = [["box", "Box"], ["cylinder", "Cylinder"], ["sphere", "Sphere"]];
const SIDES = ["front", "back", "left", "right"] as const;

export function AddSetMenu({ disabled, onPick }: { disabled: boolean; onPick: (choice: AddSetChoice) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="fy-swstage__kitanchor">
      <button type="button" className="fy-swstage__add" disabled={disabled} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
        <Plus size={12} />Add set
      </button>
      {open ? (
        <>
          <div className="fy-swstage__platescrim" onClick={() => setOpen(false)} />
          <div className="fy-swstage__kitmenu" role="menu" aria-label="Add set" data-testid="stage-kit-menu">
            {STAGE_KIT_KINDS.map((kind) => (
              <button key={kind} type="button" role="menuitem" onClick={() => { setOpen(false); onPick(kind); }}>
                <span className="fy-swstage__mark" data-kind="set" aria-hidden="true" />{STAGE_KIT_LABELS[kind]}
                {/* A room is the only kit that is more than one thing (229e): its walls and their openings.
                    A lamp says what else it brings, a light (229e rule 7). */}
                {kind === "room" ? <em>walls · openings</em> : kind === "lamp" ? <em>with light</em> : null}
              </button>
            ))}
            <hr />
            {PRIMITIVES.map(([choice, label]) => (
              <button key={choice} type="button" role="menuitem" onClick={() => { setOpen(false); onPick(choice); }}>
                <span className="fy-swstage__mark" data-kind="set" aria-hidden="true" />{label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </span>
  );
}

/** A kit item's own rows, under the set's name. */
/** A kit item's rows; its size sits under the kit, as 229e orders the form. */
export function KitRows({ kit, name, disabled, onChange, size }: { kit: StageKit; name: string; disabled: boolean; onChange: (next: StageKit) => void; size?: ReactNode }) {
  const toggleSide = (side: (typeof SIDES)[number]) => {
    const open = new Set(kit.open ?? []);
    if (open.has(side)) open.delete(side); else open.add(side);
    const { open: _open, ...rest } = kit;
    onChange(open.size === 0 ? rest : { ...rest, open: SIDES.filter((candidate) => open.has(candidate)) });
  };
  const openings = kit.openings ?? [];
  const setOpenings = (next: NonNullable<StageKit["openings"]>) => {
    const { openings: _openings, ...rest } = kit;
    onChange(next.length === 0 ? rest : { ...rest, openings: next });
  };
  return (
    <>
      <Row label="kit">
        <select className="fy-swstage__select" aria-label={`${name} kit`} value={kit.kind} disabled={disabled}
          onChange={(event) => onChange({ kind: event.target.value as StageKit["kind"] })}>
          {STAGE_KIT_KINDS.map((kind) => <option key={kind} value={kind}>{STAGE_KIT_LABELS[kind]}</option>)}
        </select>
      </Row>
      {size}
      {kit.kind === "room" ? (
        <>
          <Row label="open">
            <span className="fy-swstage__chips" role="group" aria-label={`${name} open sides`}>
              {SIDES.map((side) => {
                const on = kit.open?.includes(side) ?? false;
                return <button key={side} type="button" aria-pressed={on} data-on={on ? "true" : undefined} disabled={disabled} onClick={() => toggleSide(side)}>{side[0]!.toUpperCase() + side.slice(1)}</button>;
              })}
            </span>
          </Row>
          <Row label="ceiling">
            <span className="fy-swstage__chips" role="radiogroup" aria-label={`${name} ceiling`}>
              {([["Off", false], ["On", true]] as const).map(([label, on]) => (
                <button key={label} type="button" role="radio" aria-checked={(kit.ceiling ?? false) === on} data-on={(kit.ceiling ?? false) === on ? "true" : undefined} disabled={disabled}
                  onClick={() => { const { ceiling: _ceiling, ...rest } = kit; onChange(on ? { ...rest, ceiling: true } : rest); }}>{label}</button>
              ))}
            </span>
          </Row>
          <Row label="openings" top>
            <span className="fy-swstage__openings" data-testid="stage-kit-openings">
              {openings.length === 0 ? <Value muted>none</Value> : openings.map((opening, index) => (
                <span key={index} className="fy-swstage__opening">
                  <span>{opening.kind} · {opening.wall} wall</span>
                  <span className="fy-swstage__quiet">{opening.w.toFixed(1)} × {opening.h.toFixed(1)}</span>
                  <button type="button" aria-label={`Remove ${opening.kind} on the ${opening.wall} wall`} disabled={disabled} onClick={() => setOpenings(openings.filter((_, at) => at !== index))}><X size={10} /></button>
                </span>
              ))}
              <button type="button" className="fy-swstage__add" disabled={disabled || openings.length >= 12}
                onClick={() => setOpenings([...openings, { wall: "back", kind: "door", at: 0, w: 1, h: 2.2 }])}>
                <Plus size={12} />Opening
              </button>
            </span>
          </Row>
        </>
      ) : null}
      {kit.kind === "table" ? (
        <Stepper label="seats" value={kit.seats ?? 0} step={1} min={0} max={12} decimals={0} disabled={disabled}
          onCommit={(value) => { const { seats: _seats, ...rest } = kit; onChange(value === undefined || value === 0 ? rest : { ...rest, seats: value }); }} />
      ) : null}
      {kit.kind === "stairs" ? (
        <Stepper label="steps" value={kit.steps} placeholder="auto" step={1} min={2} max={40} decimals={0} disabled={disabled} clearable
          onCommit={(value) => { const { steps: _steps, ...rest } = kit; onChange(value === undefined ? rest : { ...rest, steps: value }); }} />
      ) : null}
    </>
  );
}

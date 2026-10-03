import { useEffect, useRef, useState } from "react";
import { findHarnessModel, harnessModelReference, type ClientState } from "@arke-studio/contracts";
import { ChevronDown } from "./icons.js";
import { harnessModelLabel, harnessModelUnavailableReason } from "./harness-models.js";
import { cx } from "./ui.js";

/**
 * The chat's model, in the composer's own row beside attach and voice (design turn 190e). It named
 * a row of its own above the composer, with a scope word (THIS TURN, CHAT AGENT, DEFAULT), two
 * links and a count of models; here it is the model's name and, opened, the models, then the one
 * press that makes the choice the production's. A dot says the choice is this chat's alone.
 *
 * One chip for every conversation composer, so what it offers follows what the conversation can
 * keep: a production's chats can remember a choice for every chat in the production; the founding
 * chat and production setup have nowhere to remember one, so they pass neither press and the chip
 * only picks for this chat; World Chat takes its model from Settings and the coordinator refuses
 * a named one outside a production, so it passes `readOnly` and the chip says which model answers.
 */
export function ModelChip({
  state,
  value,
  set,
  onPick,
  onRemember,
  onClear,
  disabled,
  needsTools = false,
  unsetLabel = "Use the saved choice",
  readOnly = false,
}: {
  state: ClientState | null;
  /** The model in force: this chat's, the agent's, the production's, else the harness's own. */
  value: string | undefined;
  /** The choice is this chat's, not the production's. */
  set: boolean;
  onPick: (id: string | undefined) => void;
  /** Present when the choice can be made the production's. */
  onRemember?: () => void;
  /** Present when the production has a remembered choice to let go of. */
  onClear?: () => void;
  disabled?: boolean;
  /** The conversation uses tools: a model that cannot is shown, and cannot be picked. */
  needsTools?: boolean;
  /** What letting go of this chat's choice is called, where "saved" would name nothing. */
  unsetLabel?: string;
  /** The model is named, not chosen here: no menu, no chevron, and nothing at all when it has no name to give. */
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const models = state?.app.harnessModels ?? [];
  const manifest = state?.app.manifest?.models;
  const current = value ? findHarnessModel(value, models, manifest) : models.find((model) => model.isDefault);
  const label = current ? harnessModelLabel(state, current) : (value ?? "Model");
  // A catalogue still loading, or a harness that is not running, offers nothing to pick yet.
  const checking = state?.app.health.harness.status !== "healthy" || state?.app.harnessModelStatus?.status !== "ready";
  const ordered = [...models].sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false));
  const reference = current ? harnessModelReference(current) : value;
  if (readOnly) {
    if (current === undefined && value === undefined) return null;
    return (
      <span className="fy-mchip">
        <span className="fy-mchip__btn fy-mchip__btn--fixed" aria-label="Language model" title="Chosen in Settings">
          <span className="fy-mchip__name">{label}</span>
        </span>
      </span>
    );
  }
  const choose = (id: string | undefined) => {
    onPick(id);
    setOpen(false);
  };
  return (
    <span className="fy-mchip" ref={root}>
      <button
        type="button"
        className={cx("fy-mchip__btn", set && "fy-mchip__btn--set")}
        aria-label="Language model"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="fy-mchip__name">{label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="fy-mchip__menu" role="menu" aria-label="Language model">
          {set && (
            <button type="button" role="menuitem" className="fy-mchip__item fy-mchip__item--quiet" onClick={() => choose(undefined)}>
              {unsetLabel}
            </button>
          )}
          {value !== undefined && (current === undefined || harnessModelReference(current) !== value) && (
            <button type="button" role="menuitemradio" aria-checked className="fy-mchip__item fy-mchip__item--on" disabled data-model={value}>
              <span>{current ? harnessModelLabel(state, current) : value}</span>
              <span className="fy-mchip__why">{current ? "saved" : "unavailable"}</span>
            </button>
          )}
          {ordered.map((model) => {
            const id = harnessModelReference(model);
            const reason = checking ? undefined : harnessModelUnavailableReason(state, model, false, needsTools);
            return (
              <button
                key={id}
                data-model={id}
                type="button"
                role="menuitemradio"
                aria-checked={id === reference}
                className={cx("fy-mchip__item", id === reference && "fy-mchip__item--on")}
                disabled={checking || reason !== undefined}
                onClick={() => choose(id)}
              >
                <span>{harnessModelLabel(state, model)}</span>
                {reason !== undefined && <span className="fy-mchip__why">{reason}</span>}
              </button>
            );
          })}
          {(onRemember !== undefined || onClear !== undefined) && <hr className="fy-mchip__rule" />}
          {onRemember !== undefined && (
            <button type="button" role="menuitem" className="fy-mchip__item fy-mchip__item--quiet" onClick={() => { onRemember(); setOpen(false); }}>
              Every chat in this production
            </button>
          )}
          {onClear !== undefined && (
            <button type="button" role="menuitem" className="fy-mchip__item fy-mchip__item--quiet" onClick={() => { onClear(); setOpen(false); }}>
              Clear the production&rsquo;s choice
            </button>
          )}
        </div>
      )}
    </span>
  );
}

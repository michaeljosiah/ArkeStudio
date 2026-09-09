import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Check as CheckMark, ChevronDown } from "./icons.js";

/**
 * The SpecOne component layer, reimplemented as React against the token contract
 * (SPEC-001 §2.10, D5). No hard-coded values — every colour, radius, shadow and duration is
 * a token reference in ui.css.
 */

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
type ButtonSize = "sm" | "default" | "lg" | "icon";

export function Button({
  variant = "secondary",
  size = "default",
  className,
  type = "button",
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** For the callers that have to put focus back on this button — a dialog returning it, say. */
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("ui-btn", `ui-btn--${variant}`, `ui-btn--${size}`, className)}
      {...rest}
    />
  );
}

/**
 * A verb drawn as its glyph, with the word on its tooltip and its accessible name (issue 1010).
 *
 * The tooltip is the platform's `title` and not the timeline's drawn `.fy-tip` bubble, which was
 * tried first and reverted: `.fy-tip` is an absolutely positioned pseudo-element, so it is cut
 * off by any ancestor that clips — the put-away World Chat rail is 48px wide with
 * `overflow: hidden`, and its two icon-only controls would have had no discoverable name at all.
 * A control that appears anywhere cannot rely on nothing above it clipping. `.fy-tip` stays
 * where its container is known: the cut's toolbar.
 */
export function IconButton({
  label,
  hint,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  /**
   * What the press costs or leaves behind, for the tooltip only. The accessible name stays the
   * verb; this is where a consequence the text button used to carry in its own `title` goes, so
   * dropping the word does not drop what the word was standing next to.
   */
  hint?: string;
}) {
  return (
    <button
      className={cx("ui-iconbtn", className)}
      aria-label={label}
      title={hint === undefined ? label : `${label} — ${hint}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("ui-input", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("ui-input", "ui-textarea", className)} {...rest} />;
}

/**
 * A `<select>` wearing the house control rather than the platform's (issue 1010, U2).
 *
 * The element stays a real `<select>` — the operating system's list is the one part of it worth
 * keeping, and a hand-built menu would lose keyboard type-ahead and the native touch sheet. What
 * is replaced is the closed state: `appearance: none` strips the platform button, and the
 * chevron beside it is the same one every other disclosure in the app draws.
 *
 * `label` is the accessible name, because these sit beside a caption rather than a `<label for>`.
 */
export function Select({
  label,
  className,
  wrapClassName,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; wrapClassName?: string }) {
  return (
    <span className={cx("ui-select", wrapClassName)}>
      <select className={cx("ui-select__control", className)} aria-label={label} {...rest}>
        {children}
      </select>
      <ChevronDown size={12} />
    </span>
  );
}

/**
 * The same trade for a checkbox: a real input, drawn by us and never by the platform.
 */
export function Checkbox({
  label,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode }) {
  return (
    <label className={cx("ui-check", className)}>
      <span className="ui-check__box">
        <input type="checkbox" {...rest} />
        <CheckMark size={11} />
      </span>
      <span className="ui-check__label">{label}</span>
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx("ui-switch", checked && "ui-switch--on")}
      onClick={() => onChange?.(!checked)}
    >
      <span className="ui-switch__thumb" />
    </button>
  );
}

export function Tabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: ReadonlyArray<{ id: string; label: string }>;
  active: string;
  onSelect: (id: string) => void;
}) {
  const id = useId();
  return (
    <div className="ui-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`${id}-${t.id}`}
          role="tab"
          aria-selected={t.id === active}
          className={cx("ui-tab", t.id === active && "ui-tab--active")}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Uncontrolled convenience over Tabs for screens whose tab choice is pure view state. */
export function TabPanels({
  tabs,
  initial,
}: {
  tabs: ReadonlyArray<{ id: string; label: string; content: ReactNode }>;
  initial?: string;
}) {
  const [active, setActive] = useState(initial ?? tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <div>
      <Tabs tabs={tabs} active={current?.id ?? ""} onSelect={setActive} />
      <div className="ui-tabpanel" role="tabpanel">
        {current?.content}
      </div>
    </div>
  );
}

export function Card({
  className,
  children,
  onClick,
}: {
  className?: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  if (onClick) {
    return (
      <button type="button" className={cx("ui-card", "ui-card--clickable", className)} onClick={onClick}>
        {children}
      </button>
    );
  }
  return <div className={cx("ui-card", className)}>{children}</div>;
}

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "outline";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={cx("ui-badge", `ui-badge--${tone}`)}>{children}</span>;
}

export type StatusDotTone = "ok" | "warn" | "danger" | "muted" | "busy";

export function StatusDot({ tone, label }: { tone: StatusDotTone; label?: string }) {
  return (
    <span className="ui-statusdot">
      <span className={cx("ui-statusdot__dot", `ui-statusdot__dot--${tone}`)} aria-hidden />
      {label && <span className="ui-statusdot__label">{label}</span>}
    </span>
  );
}

export function Callout({
  tone = "neutral",
  title,
  children,
}: {
  tone?: "neutral" | "warning" | "danger" | "success";
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("ui-callout", `ui-callout--${tone}`)} role={tone === "danger" ? "alert" : "note"}>
      {title && <div className="ui-callout__title">{title}</div>}
      <div className="ui-callout__body">{children}</div>
    </div>
  );
}

export function Avatar({ name, image }: { name: string; image?: string }) {
  const short = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return image ? (
    <img className="ui-avatar" src={image} alt={name} />
  ) : (
    <span className="ui-avatar ui-avatar--initials" aria-hidden>
      {short}
    </span>
  );
}

/** One chat turn from the agent — used by the gate's chat surfaces from SPEC-004 on. */
export function AgentMessage({ author, children }: { author: "agent" | "you"; children: ReactNode }) {
  return (
    <div className={cx("ui-agentmsg", author === "you" && "ui-agentmsg--you")}>
      <span className="ui-agentmsg__author">{author === "agent" ? "Studio" : "You"}</span>
      <div className="ui-agentmsg__body">{children}</div>
    </div>
  );
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

import type { ReactNode } from "react";
import { cx } from "../components/ui.js";

/**
 * The pieces the runtime-facing settings screens are drawn from. They were private to shell.tsx
 * while Local runtime was one screen; Local AI and Engines both draw rows the same way, and two
 * copies of a status dot is how two screens start looking like two products.
 */

/** The three tones a runtime state comes in. Anything unmeasured is idle, never a fault (D12). */
export type RuntimeTone = "ok" | "warn" | "idle";

export const TONE_CLASS: Record<RuntimeTone, string> = {
  ok: "fy-set__dot--ok",
  warn: "fy-set__dot--warn",
  idle: "",
};

/** A dot leading the word it qualifies — the pairing every runtime row states its state with. */
export function RuntimeStatus({ tone, children }: { tone: RuntimeTone; children: ReactNode }) {
  return (
    <span className="fy-set__status">
      <span className={cx("fy-set__dot", TONE_CLASS[tone])} />
      <span className="fy-set__state">{children}</span>
    </span>
  );
}

/**
 * The head every runtime detail opens with: what this is, what it does, and where it stands.
 * The same three-part head 40a gives a provider, because the rail is the heading either way.
 */
export function RuntimeHead({
  title,
  caps,
  tone,
  state,
}: {
  title: string;
  caps: string;
  tone: RuntimeTone;
  state: string;
}) {
  return (
    <div className="fy-rt__head">
      <span className="fy-rt__title">{title}</span>
      <span className="fy-rt__caps">{caps}</span>
      <span style={{ flex: 1 }} />
      <RuntimeStatus tone={tone}>{state}</RuntimeStatus>
    </div>
  );
}

/** A labelled band inside a detail, with whatever acts on the band as a whole on its right. */
export function RuntimeSection({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="fy-rt__sechead">
      <div className="fy-rt__eyebrow">{label}</div>
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}

/** A download size as the catalogue states it. One spelling: the same figure on every row. */
export function sizeMb(mbytes: number): string {
  return mbytes >= 1024 ? `${(mbytes / 1024).toFixed(1)} GB` : `${mbytes} MB`;
}

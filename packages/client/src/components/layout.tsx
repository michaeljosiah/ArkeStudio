import type { ReactNode } from "react";
import { useStore } from "../lib/store.js";
import { Callout } from "./ui.js";

/** Screen wrapper: every §2.9 screen renders exactly one, keyed by its registry id. */
export function Screen({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="lay-screen" data-screen={id}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  meta,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="lay-pagehead">
      <div>
        <h1 className="lay-pagehead__title">{title}</h1>
        {meta && <div className="lay-pagehead__meta">{meta}</div>}
      </div>
      {actions && <div className="lay-pagehead__actions">{actions}</div>}
    </header>
  );
}

export function Section({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="lay-section">
      {(title || aside) && (
        <div className="lay-section__head">
          {title && <h2 className="lay-section__title">{title}</h2>}
          {aside && <div className="lay-section__aside">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="lay-empty">
      <div className="lay-empty__title">{title}</div>
      {hint && <div className="lay-empty__hint">{hint}</div>}
      {action && <div className="lay-empty__action">{action}</div>}
    </div>
  );
}

export function StatRow({ stats }: { stats: Array<{ label: string; value: ReactNode }> }) {
  return (
    <div className="lay-stats">
      {stats.map((s) => (
        <div key={s.label} className="lay-stats__item">
          <div className="lay-stats__value">{s.value}</div>
          <div className="lay-stats__label">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="lay-cardgrid">{children}</div>;
}

export function KeyValue({ rows }: { rows: Array<{ k: string; v: ReactNode }> }) {
  return (
    <dl className="lay-kv">
      {rows.map((r) => (
        <div key={r.k} className="lay-kv__row">
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Degraded-mode presentation (SPEC-001 R-6, T-14): the feature is visible, disabled, and the
 * reason is stated — never a silent absence.
 */
export function DegradedBanner({ component }: { component: "harness" | "voice" }) {
  const { state } = useStore();
  const health = state?.app.health[component];
  if (!health || health.status === "healthy") return null;
  const what = component === "harness" ? "Authoring" : "Local voice";
  const via = component === "harness" ? "OpenCode" : "Voxa";
  return (
    <Callout tone="warning" title={`${what} is unavailable`}>
      {health.reason ?? `${via} is not running.`} Browsing and everything already in the world keep
      working; this screen's actions are disabled until {via} is back.
    </Callout>
  );
}

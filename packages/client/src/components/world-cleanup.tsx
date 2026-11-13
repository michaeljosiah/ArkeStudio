import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  CLEANUP_CLASS_LABELS, CLEANUP_HOLD_DAYS, cleanupAction, formatMicroUsd, storageByteLabel as bytes,
  type CleanupAction, type CleanupClass, type CleanupHeldPlan, type CleanupItem, type CleanupPlan, type CleanupProblem,
  type CleanupRefusal, type CleanupRun, type CleanupStatus, type WorldCleanupOp,
} from "@arke-studio/contracts";
import { PageSheet } from "./page-sheet.js";
import { Button, Switch } from "./ui.js";
import { ChevronDown, ChevronRight, TriangleAlert } from "./icons.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { useWorld } from "../lib/store.js";
import { askWorldCleanup, cleanupDate, cleanupMoment, cleanupTotals, holdEnd } from "../lib/world-cleanup.js";

/**
 * Clean up (SPEC-066, design turn 278): a plan the coordinator computes, read and ticked here,
 * then run under the world's ownership. The sheet holds no file identity: it sends item ids back,
 * and a refusal leaves the plan readable with Clean up… off (R-3, R-4). Running is the desktop
 * Studio's alone (R-2), so a paired browser gets no way in.
 */

const count = (value: number): string => value.toLocaleString("en-GB");
const REFUSALS: Record<CleanupRefusal, string> = {
  "read-only": "Read-only world", "outside-edits": "Outside edits · Adopt first", "opened-elsewhere": "Opened elsewhere",
  unsettled: "Unsettled run", running: "Running",
};
const STOPPED: Record<NonNullable<CleanupRun["stopped"]>, string> = {
  stopped: "Stopped", "outside-edits": "Stopped · Outside edits", "opened-elsewhere": "Stopped · Opened elsewhere",
  "world-closed": "Stopped · World closed", failed: "Stopped · Failed",
};
const PROBLEMS: Record<CleanupProblem["kind"], string> = {
  "missing-media": "File gone", "former-shapes": "No audio", "header-only": "Empty audio", "no-sidecar": "No record",
  changed: "Changed", stray: "Stray file", "last-copy": "Last copy", "kept-back": "May hold lost narration",
};
const VERBS: Record<CleanupAction, string> = { link: "linked", clear: "cleared", hold: "held" };
const ACTIONS: Record<CleanupAction, string> = { link: "Link", clear: "Clear", hold: "Hold" };
const HELD_STATES: Record<Exclude<CleanupHeldPlan["state"], "held" | "ended">, string> = { elsewhere: "Held elsewhere", unsettled: "Unsettled run" };
/** A long class shows its first rows; N more opens the rest in place (rule 7). */
const FIRST_ROWS = 50;

const reason = (text: string) => <span className="fy-cleanup-reason"><TriangleAlert size={12} /><span>{text}</span></span>;
const until = (at: string | number) => `Until ${cleanupDate(at)}`;

/** The way in: after Files in Arke folders, whenever a world is open in the desktop Studio (rule 2). */
export function WorldCleanupButton() {
  const world = useWorld();
  const [open, setOpen] = useState(false);
  if (!world || isRemoteSession()) return null;
  return <>
    <button type="button" className="fy-studio-button" onClick={() => setOpen(true)}>Clean up world</button>
    <WorldCleanupSheet key={world.meta.worldId} open={open} onClose={() => setOpen(false)} worldId={world.meta.worldId} worldName={world.meta.name} />
  </>;
}

type Page = { kind: "main" } | { kind: "confirm" } | { kind: "empty"; held: CleanupHeldPlan };

export function WorldCleanupSheet({ open, onClose, worldId, worldName }: { open: boolean; onClose: () => void; worldId: string; worldName: string }) {
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const [status, setStatus] = useState<CleanupStatus | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [tab, setTab] = useState<"plan" | "held">("plan");
  const [page, setPage] = useState<Page>({ kind: "main" });
  const [trouble, setTrouble] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setNow] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function ask(request: WorldCleanupOp): Promise<boolean> {
    setBusy(true);
    const answer = await askWorldCleanup(worldId, request);
    if (!live.current) return false;
    setBusy(false);
    if (!answer.ok) { setTrouble(answer.reason); return false; }
    setTrouble(answer.note ?? null);
    setStatus(answer.status);
    if (request.op === "plan") {
      setPlan(answer.plan ?? null);
      setTicked(new Set(answer.plan?.items.filter(item => item.ticked).map(item => item.id)));
    }
    return true;
  }

  // Opening computes a plan and writes nothing (rule 4); a run under way shows itself again.
  useEffect(() => {
    if (!open) return;
    setPage({ kind: "main" }); setTab("plan"); setTrouble(null);
    void ask({ op: "plan" });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // A run reports by polling: closing the sheet stops the polling, never the run (rule 14).
  const running = open && status?.running === true;
  useEffect(() => {
    if (!running) return;
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      timer = setTimeout(() => {
        void askWorldCleanup(worldId, { op: "status" }).then(answer => {
          if (!current) return;
          if (answer.ok) setStatus(answer.status);
          next();
        });
      }, 1_000);
    };
    next();
    return () => { current = false; clearTimeout(timer); };
  }, [running, worldId]);

  // A plan more than 30 minutes old reads Plan again (R-13): redraw the foot when it turns.
  useEffect(() => {
    if (!plan) return;
    const wait = Date.parse(plan.expiresAt) - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(timer);
  }, [plan]);

  const now = Date.now();
  const held = status?.held ?? [];
  const showHeld = tab === "held" && held.length > 0;
  const run = status?.run ?? null;
  const totals = cleanupTotals(plan?.items ?? [], ticked, now);
  const expired = plan !== null && Date.parse(plan.expiresAt) <= now;
  const blocked = status?.refusal ?? null;
  const back = () => setPage({ kind: "main" });

  async function startRun() {
    if (!plan) return;
    if (await ask({ op: "run", planId: plan.id, items: plan.items.filter(item => ticked.has(item.id)).map(item => item.id) })) setPage({ kind: "main" });
  }
  async function emptyNow(target: CleanupHeldPlan) {
    if (await ask({ op: "empty", planId: target.planId })) setPage({ kind: "main" });
  }
  async function done() {
    if (await ask({ op: "dismiss" })) await ask({ op: "plan" });
  }
  async function putBack() {
    if (await ask({ op: "put-back" })) await ask({ op: "plan" });
  }

  let body: ReactNode, footer: ReactNode;
  if (page.kind === "confirm" && plan) {
    body = <>
      <Totals rows={[["Now", bytes(totals.now)], ["After hold", bytes(totals.after), totals.until === null ? undefined : until(totals.until)]]} />
      <ConfirmLines items={plan.items} ticked={ticked} now={now} />
      {trouble && <p className="fy-cleanup-trouble" role="status">{reason(trouble)}</p>}
    </>;
    footer = <><span>{count(totals.count)} items</span><div className="fy-cleanup-acts">
      <Button variant="outline" onClick={back}>Back</Button>
      <Button variant="primary" disabled={busy || blocked !== null || totals.count === 0} onClick={() => void startRun()}>Clean up</Button>
    </div></>;
  } else if (page.kind === "empty") {
    body = <>
      <dl className="fy-cleanup-drive"><dt>Plan of {cleanupDate(page.held.madeAt)}</dt><dd>{heldSummary(page.held)}</dd><dt>Size</dt><dd>{bytes(page.held.bytes)}</dd></dl>
      <p className="fy-cleanup-final"><TriangleAlert size={16} />Can’t be undone</p>
      {trouble && <p className="fy-cleanup-trouble" role="status">{reason(trouble)}</p>}
    </>;
    footer = <><span>{heldState(page.held)}</span><div className="fy-cleanup-acts">
      <Button variant="outline" onClick={back}>Keep</Button>
      <Button variant="destructive" disabled={busy} onClick={() => void emptyNow(page.held)}>Empty now</Button>
    </div></>;
  } else {
    const tabs = held.length > 0 && <div className="fy-cleanup-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={!showHeld} onClick={() => setTab("plan")}>Plan</button>
      <button type="button" role="tab" aria-selected={showHeld} onClick={() => setTab("held")}>Held <span>{held.length}</span></button>
    </div>;
    const troubleLine = trouble && <p className="fy-cleanup-trouble" role="status">{reason(trouble)}</p>;
    if (showHeld) {
      body = <>{tabs}<Totals rows={[["Held", bytes(held.reduce((sum, row) => sum + row.bytes, 0))]]} />{troubleLine}
        {held.map(row => <HeldCard key={row.planId} held={row} busy={busy}
          onRestore={items => void ask(items ? { op: "restore", planId: row.planId, items } : { op: "restore", planId: row.planId })}
          onEmpty={() => setPage({ kind: "empty", held: row })} />)}</>;
    } else if (run && run.endedAt === null) {
      body = <>{tabs}<RunView run={run} />{troubleLine}</>;
      footer = <><span>Running</span><Button variant="outline" disabled={busy} onClick={() => void ask({ op: "stop" })}>Stop</Button></>;
    } else if (run) {
      body = <>{tabs}<ResultView run={run} />{troubleLine}</>;
      footer = <><span>{cleanupMoment(run.endedAt ?? run.startedAt)}</span><Button variant="primary" disabled={busy} onClick={() => void done()}>Done</Button></>;
    } else {
      body = <>{tabs}
        {blocked && <p className="fy-cleanup-trouble" role="status">{reason(REFUSALS[blocked])}</p>}
        {troubleLine}
        {plan ? <PlanView plan={plan} ticked={ticked} setTicked={setTicked} totals={totals} now={now} busy={busy} onPutBack={() => void putBack()} />
          : busy && <p className="fy-cleanup-meta">Planning…</p>}
        {status && <div className="fy-cleanup-auto"><span>Clear old mixes on their own</span>
          <Switch label="Clear old mixes on their own" checked={status.autoMixes} disabled={busy} onChange={on => void ask({ op: "auto-mixes", on })} /></div>}
      </>;
      if (plan) footer = <><span>{count(totals.count)} items</span>{expired
        ? <Button variant="primary" disabled={busy} onClick={() => void ask({ op: "plan" })}>Plan again</Button>
        : <Button variant="primary" disabled={busy || blocked !== null || totals.count === 0} onClick={() => setPage({ kind: "confirm" })}>Clean up…</Button>}</>;
    }
  }

  return <PageSheet open={open} onClose={onClose} title="Clean up" subtitle={worldName} className="fy-world-cleanup"
    onBack={page.kind === "main" ? undefined : back} resetKey={`${page.kind}:${tab}`} footer={footer}>
    {body}
  </PageSheet>;
}

function Totals({ rows, right }: { rows: readonly (readonly [string, string, string?])[]; right?: string }) {
  return <div className="fy-cleanup-totals">
    {rows.map(([label, value, note]) => <div key={label}><span>{label}</span><b>{value}</b>{note && <i>{note}</i>}</div>)}
    {right && <span className="fy-cleanup-made">{right}</span>}
  </div>;
}

/** A tick that can be ticked in part: the class's tick shows a dash then (rule 6). */
function Tick({ label, state, onChange, disabled }: { label: string; state: boolean | "mixed"; onChange: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (ref.current) ref.current.indeterminate = state === "mixed"; }, [state]);
  return <input ref={ref} type="checkbox" className="fy-cleanup-tick" aria-label={label} checked={state === true}
    aria-checked={state === "mixed" ? "mixed" : undefined} disabled={disabled} onChange={onChange} />;
}

function PlanView({ plan, ticked, setTicked, totals, now, busy, onPutBack }: {
  plan: CleanupPlan; ticked: ReadonlySet<string>; setTicked: (next: ReadonlySet<string>) => void;
  totals: ReturnType<typeof cleanupTotals>; now: number; busy: boolean; onPutBack: () => void;
}) {
  const [opened, setOpened] = useState<ReadonlySet<CleanupClass>>(() => new Set());
  const [full, setFull] = useState<ReadonlySet<CleanupClass>>(() => new Set());
  const byClass = new Map<CleanupClass, CleanupItem[]>();
  for (const item of plan.items) byClass.set(item.class, [...byClass.get(item.class) ?? [], item]);
  const flip = (ids: readonly string[], on: boolean) => {
    const next = new Set(ticked);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    setTicked(next);
  };
  const toggle = <T,>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => { const next = new Set(set); if (!next.delete(value)) next.add(value); return next; };
  const problemCount = plan.problems.reduce((sum, row) => sum + row.count, 0);
  return <>
    <Totals rows={[["Now", bytes(totals.now)], ["After hold", bytes(totals.after), totals.until === null ? undefined : until(totals.until)]]}
      right={`Plan · ${new Date(plan.madeAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`} />
    <div className="fy-cleanup-row fy-cleanup-colhead" aria-hidden="true"><span /><span /><span>Items</span><span>Now</span><span>After hold</span><span /></div>
    {plan.classes.map(row => {
      const name = CLEANUP_CLASS_LABELS[row.class];
      if (row.state === "stopped") return <div className="fy-cleanup-row fy-cleanup-class" key={row.class}>
        <span /><div className="fy-cleanup-name"><b>{name}</b>{reason(row.stoppedBy ?? "Stopped")}</div>
        <span /><span className="fy-cleanup-size fy-cleanup-none">—</span><span className="fy-cleanup-size fy-cleanup-none">—</span><span />
      </div>;
      const items = byClass.get(row.class) ?? [];
      const on = items.filter(item => ticked.has(item.id)).length;
      const state = on === 0 ? false : on === items.length ? true : "mixed";
      const hold = cleanupAction(row.class) === "hold", isOpen = opened.has(row.class);
      const end = holdEnd(CLEANUP_HOLD_DAYS[row.class], now);
      const shown = full.has(row.class) ? items : items.slice(0, FIRST_ROWS);
      return <Fragment key={row.class}>
        <div className={`fy-cleanup-row fy-cleanup-class${isOpen ? " open" : ""}`}>
          <Tick label={name} state={state} disabled={items.length === 0} onChange={() => flip(items.map(item => item.id), state !== true)} />
          <div className="fy-cleanup-name"><b>{name}</b><span>{consequence(row.class, items, end)}</span></div>
          <span className="fy-cleanup-count">{state === "mixed" ? `${count(on)} of ${count(row.items)}` : count(row.items)}</span>
          {hold ? <span className="fy-cleanup-size fy-cleanup-none">—</span> : <span className="fy-cleanup-size">{bytes(row.bytes)}</span>}
          <span className="fy-cleanup-size">{bytes(row.bytes)}{hold && <i>{until(end)}</i>}</span>
          <button type="button" className="fy-cleanup-open" aria-label={`${isOpen ? "Hide" : "Show"} ${name}`} aria-expanded={isOpen}
            disabled={items.length === 0} onClick={() => setOpened(toggle(opened, row.class))}>{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
        </div>
        {isOpen && <div className="fy-cleanup-items">
          {groups(row.class, shown).map(([group, rows]) => <Fragment key={group ?? ""}>
            {group !== null && <div className="fy-cleanup-group">{group}</div>}
            {rows.map(item => <div className="fy-cleanup-row fy-cleanup-item" key={item.id}>
              <Tick label={item.label} state={ticked.has(item.id)} onChange={() => flip([item.id], !ticked.has(item.id))} />
              <div className="fy-cleanup-name"><b>{item.label}</b>{itemMeta(item) && <span>{itemMeta(item)}</span>}</div>
              <span />
              {hold ? <span className="fy-cleanup-size fy-cleanup-none">—</span> : <span className="fy-cleanup-size">{bytes(item.bytes)}</span>}
              <span className="fy-cleanup-size">{bytes(item.bytes)}{hold && <i>{until(end)}</i>}</span><span />
            </div>)}
          </Fragment>)}
          {items.length > shown.length && <button type="button" className="fy-cleanup-more" onClick={() => setFull(toggle(full, row.class))}>{count(items.length - shown.length)} more</button>}
        </div>}
      </Fragment>;
    })}
    {plan.problems.length > 0 && <section className="fy-cleanup-problems" aria-label="Problems">
      <h3>Problems <span className="fy-cleanup-badge">{count(problemCount)}</span></h3>
      {plan.problems.map((row, index) => <div className="fy-cleanup-row fy-cleanup-problem" key={`${row.kind}:${index}`}>
        <div className="fy-cleanup-name"><b>{row.label}</b><span>{PROBLEMS[row.kind]}</span></div>
        <span className="fy-cleanup-count">{count(row.count)}</span>
        <span className={`fy-cleanup-size${row.bytes === null ? " fy-cleanup-none" : ""}`}>{row.bytes === null ? "—" : bytes(row.bytes)}</span>
        <span className="fy-cleanup-act">{row.putBack && <button type="button" className="fy-studio-button" disabled={busy} onClick={onPutBack}>Put back on shelf</button>}</span>
      </div>)}
    </section>}
    {plan.retiredWithoutMedia > 0 && <p className="fy-cleanup-meta">Retired, no file · {count(plan.retiredWithoutMedia)}</p>}
  </>;
}

function consequence(cls: CleanupClass, items: readonly CleanupItem[], end: number): string {
  const action = cleanupAction(cls);
  if (action === "link") return "Same files · one copy · Explorer sizes stay";
  if (action === "clear") return "Made again when played";
  const back = `Back until ${cleanupDate(end)}`;
  if (cls === "old-exports") return `${back} · marked in Made`;
  const cost = items.reduce((sum, item) => sum + (item.costMicroUsd ?? 0), 0);
  return cls === "audiobook-takes" && cost > 0 ? `${back} · ${formatMicroUsd(cost)} to read again` : back;
}

function itemMeta(item: CleanupItem): string {
  if (item.covers) return `Newer: ${item.covers}`;
  if (item.costMicroUsd) return `${formatMicroUsd(item.costMicroUsd)} to read again`;
  return "";
}

/** Unused artifacts group under the production that owns them, then World (rule 8). */
function groups(cls: CleanupClass, items: readonly CleanupItem[]): [string | null, CleanupItem[]][] {
  if (cls !== "unused-artifacts") return [[null, [...items]]];
  const out = new Map<string, CleanupItem[]>();
  for (const item of items) out.set(item.group ?? "World", [...out.get(item.group ?? "World") ?? [], item]);
  return [...out];
}

function ConfirmLines({ items, ticked, now }: { items: readonly CleanupItem[]; ticked: ReadonlySet<string>; now: number }) {
  const lines = (["link", "clear", "hold"] as const).map(action => {
    const rows = items.filter(item => ticked.has(item.id) && cleanupAction(item.class) === action);
    const days = Math.max(0, ...rows.map(item => CLEANUP_HOLD_DAYS[item.class]));
    const classes = [...new Set(rows.map(item => CLEANUP_CLASS_LABELS[item.class]))].join(" · ");
    return { action, rows, classes, bytes: rows.reduce((sum, item) => sum + item.bytes, 0), when: action === "hold" ? until(holdEnd(days, now)) : "Now" };
  }).filter(line => line.rows.length > 0);
  return <div className="fy-cleanup-confirm">{lines.map(line => <div className="fy-cleanup-line" key={line.action}>
    <b>{ACTIONS[line.action]}</b><span>{count(line.rows.length)} · {line.classes}</span>
    <span className="fy-cleanup-size">{bytes(line.bytes)}</span><span className="fy-cleanup-when">{line.when}</span>
  </div>)}</div>;
}

function classLine(row: CleanupRun["classes"][number]): string {
  return [`${count(row.done)} ${VERBS[cleanupAction(row.class)]}`, row.skipped ? `${count(row.skipped)} skipped` : "", row.failed ? `${count(row.failed)} failed` : ""].filter(Boolean).join(" · ");
}

function RunView({ run }: { run: CleanupRun }) {
  const share = run.total ? Math.min(100, run.done / run.total * 100) : 0;
  return <>
    <Totals rows={[["Cleared so far", bytes(run.cleared)], ["Items", `${count(run.done)} of ${count(run.total)}`]]} />
    <div className="fy-cleanup-bar" role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done}><i style={{ width: `${share}%` }} /></div>
    {run.classes.map(row => <div className="fy-cleanup-line fy-cleanup-line--two" key={row.class}><b>{CLEANUP_CLASS_LABELS[row.class]}</b><span>{classLine(row)}</span></div>)}
  </>;
}

function ResultView({ run }: { run: CleanupRun }) {
  const gained = run.availableBefore !== null && run.availableAfter !== null ? Math.max(0, run.availableAfter - run.availableBefore) : null;
  return <>
    {run.stopped && <p className="fy-cleanup-trouble" role="status">{reason(STOPPED[run.stopped])}</p>}
    <Totals rows={[["Cleared", bytes(run.cleared)], ["Held", bytes(run.held), run.holdUntil ? until(run.holdUntil) : undefined]]} />
    <dl className="fy-cleanup-drive">
      <dt>Available before</dt><dd>{bytes(run.availableBefore)}</dd>
      <dt>Available after</dt><dd>{bytes(run.availableAfter)}</dd>
      <dt>Drive gained</dt><dd>{bytes(gained)}</dd>
    </dl>
    {run.classes.map(row => <div className="fy-cleanup-line fy-cleanup-line--two" key={row.class}><b>{CLEANUP_CLASS_LABELS[row.class]}</b>
      <span className="fy-cleanup-result">{run.stopped && !row.done && !row.skipped && !row.failed ? "Not run" : classLine(row)}{row.reasons.map(text => <Fragment key={text}>{reason(text)}</Fragment>)}</span>
    </div>)}
  </>;
}

function heldSummary(held: CleanupHeldPlan): string {
  const tally = new Map<CleanupClass, number>();
  for (const item of held.items) tally.set(item.class, (tally.get(item.class) ?? 0) + 1);
  return [...tally].map(([cls, n]) => `${count(n)} ${CLEANUP_CLASS_LABELS[cls].toLowerCase()}`).join(" · ");
}

function heldState(held: CleanupHeldPlan): string {
  if (held.state === "held") return until(held.holdUntil);
  if (held.state === "ended") return `Ended ${cleanupDate(held.holdUntil)} · Goes after ${cleanupMoment(held.goesAfter)}`;
  return HELD_STATES[held.state];
}

function HeldCard({ held, busy, onRestore, onEmpty }: { held: CleanupHeldPlan; busy: boolean; onRestore: (items?: string[]) => void; onEmpty: () => void }) {
  const [open, setOpen] = useState(false);
  // An unsettled plan waits for recovery, and one held elsewhere is left alone (rules 17, 19).
  const off = busy || held.state === "unsettled" || held.state === "elsewhere";
  const name = `Plan of ${cleanupDate(held.madeAt)}`;
  return <div className="fy-cleanup-held">
    <div className="fy-cleanup-held-head">
      <div className="fy-cleanup-name"><b>{name}</b><span>{heldSummary(held)}</span></div>
      <span className="fy-cleanup-tag">{heldState(held)}</span>
      <span className="fy-cleanup-size">{bytes(held.bytes)}</span>
      <button type="button" className="fy-cleanup-open" aria-label={`${open ? "Hide" : "Show"} ${name}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
    </div>
    {open && <div className="fy-cleanup-held-items">{held.items.map(item => <div className="fy-cleanup-row fy-cleanup-held-item" key={item.id}>
      <div className="fy-cleanup-name"><b>{item.label}</b>{item.blocked ? reason(item.blocked) : <span>{CLEANUP_CLASS_LABELS[item.class]}</span>}</div>
      <span className="fy-cleanup-size">{bytes(item.bytes)}</span>
      <span className="fy-cleanup-act"><button type="button" className="fy-studio-button" disabled={off || item.blocked !== undefined} onClick={() => onRestore([item.id])}>Restore</button></span>
    </div>)}</div>}
    <div className="fy-cleanup-acts fy-cleanup-held-acts">
      <button type="button" className="fy-studio-button" disabled={off} onClick={() => onRestore()}>Restore all</button>
      <button type="button" className="fy-studio-button fy-cleanup-danger" disabled={off} onClick={onEmpty}>Empty now</button>
    </div>
  </div>;
}

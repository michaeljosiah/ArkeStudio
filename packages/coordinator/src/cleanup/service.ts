import { lstat, statfs } from "node:fs/promises";
import { join } from "node:path";
import {
  CLEANUP_CLASSES, CLEANUP_HOLD_DAYS, ulid,
  type AudiobookReader, type CleanupClass, type CleanupHeldPlan, type CleanupRefusal, type CleanupRun, type CleanupStatus,
  type WorldCleanupAnswer, type WorldCleanupCommand,
} from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { Ledger, readLedger, unsettled, type LedgerItem, type LedgerLine } from "./ledger.js";
import { computePlan, namedSince, type Planned } from "./plan.js";
import { heldPath, recoverIntent, removeHeld, restoreItem, runItem, type RunContext } from "./run.js";

export interface WorldCleanupDeps {
  openStore(): WorldStore | undefined;
  appRoot(): string | null;
  now?(): number;
  benchChanged(worldId: string, sessionId: string): Promise<void>;
  /** Keep's own path, for Put back on shelf (R-44). */
  keep(worldId: string, sessionId: string, takeId: string): Promise<void>;
  /** One order per take with Keep, Not this and Delete (R-4). */
  serialiseTake<T>(key: string, work: () => Promise<T>): Promise<T>;
  playNarrator?(store: WorldStore, productionId: string, chapterId: string): Promise<AudiobookReader | null>;
  pinned(dir: string, path: string): boolean;
  refreshWorld(worldId: string): Promise<void>;
  log(entry: Record<string, unknown>): void;
}

const DAY = 86_400_000;
const AUTO_DELAY_MS = 120_000;
const AUTO_MAX_BYTES = 2 * 1024 ** 3;

/**
 * Clean up for the open world (SPEC-066): plans computed on request and kept in memory for 30
 * minutes, one run at a time, and the hold read back from the ledger. Answers go to the asking
 * Studio window only.
 */
export class WorldCleanup {
  private plans = new Map<string, Planned>();
  private run: CleanupRun | null = null;
  private running: AbortController | null = null;
  private execution: Promise<void> | null = null;
  /** Taken before anything awaits: two windows asking at once cannot both start (Codex on PR 3052). */
  private admitting = false;
  private worldId: string | null = null;
  private autoTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: WorldCleanupDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private iso(): string { return new Date(this.now()).toISOString(); }

  private context(store: WorldStore): RunContext {
    return {
      store, ledger: new Ledger(store.dir, () => this.iso()), now: () => this.iso(),
      benchChanged: sessionId => this.deps.benchChanged(store.worldId, sessionId).catch(() => {}),
      pinned: path => this.deps.pinned(store.dir, path),
    };
  }

  /** A different world open: what was planned for the last one is gone with it. */
  private forWorld(store: WorldStore): void {
    if (this.worldId === store.worldId) return;
    this.worldId = store.worldId; this.plans.clear(); this.run = null; this.running?.abort(); this.running = null;
  }

  async handle(msg: WorldCleanupCommand, reply: (answer: WorldCleanupAnswer) => void): Promise<void> {
    const store = this.deps.openStore();
    if (!store || store.worldId !== msg.worldId || store.isClosed()) { reply({ ok: false, reason: "That world is not open." }); return; }
    this.forWorld(store);
    try {
      const request = msg.request;
      switch (request.op) {
        case "plan": {
          // Mid-run the sheet shows the run: the item under way has an intent and no outcome yet,
          // and recovering it then would undo it under the run's feet.
          if (this.running) { reply({ ok: true, status: await this.status(store) }); return; }
          // Opening Clean up settles a cut-short run, then lets ended holds go (R-24, R-30).
          if (await this.writable(store)) { await this.recover(store); await this.expire(store); }
          const planned = await computePlan(store, {
            appRoot: this.deps.appRoot(), now: () => this.now(), newPlanId: () => `cp_${ulid()}`, signal: store.closingSignal,
            ...(this.deps.playNarrator ? { playNarrator: (p: string, c: string) => this.deps.playNarrator!(store, p, c) } : {}),
          });
          for (const [id, old] of this.plans) if (this.now() - old.madeAtMs > 30 * 60_000) this.plans.delete(id);
          this.plans.set(planned.plan.id, planned);
          reply({ ok: true, plan: planned.plan, status: await this.status(store) });
          return;
        }
        case "status": reply({ ok: true, status: await this.status(store) }); return;
        case "dismiss": if (!this.running) this.run = null; reply({ ok: true, status: await this.status(store) }); return;
        case "stop": this.running?.abort(); reply({ ok: true, status: await this.status(store) }); return;
        case "auto-mixes": {
          if (!(await this.writable(store))) throw new Error("Clean up can change this world only where it is open for writing.");
          // Off means off now: a clear already scheduled for this open is cancelled too.
          if (!request.on && this.autoTimer) { clearTimeout(this.autoTimer); this.autoTimer = null; }
          await new Ledger(store.dir, () => this.iso()).append({ kind: "setting", autoMixes: request.on });
          reply({ ok: true, status: await this.status(store) }); return;
        }
        case "run": {
          if (this.admitting || this.running) { reply({ ok: false, reason: refusalText.running }); return; }
          this.admitting = true;
          try {
            const refusal = await this.refusal(store);
            if (refusal) { reply({ ok: false, reason: refusalText[refusal] }); return; }
            const planned = this.plans.get(request.planId);
            if (!planned || this.now() - planned.madeAtMs > 30 * 60_000) { reply({ ok: false, reason: "Plan again: this plan is more than 30 minutes old." }); return; }
            const chosen = request.items.map(id => planned.items.get(id));
            if (chosen.some(item => !item)) { reply({ ok: false, reason: "Plan again: an item is not in this plan." }); return; }
            // A plan runs at most once (R-13).
            this.plans.delete(request.planId);
            this.start(store, planned, chosen as NonNullable<typeof chosen[number]>[]);
          } finally { this.admitting = false; }
          reply({ ok: true, status: await this.status(store) }); return;
        }
        case "restore": case "empty": {
          if (this.admitting || this.running) { reply({ ok: false, reason: refusalText.running }); return; }
          this.admitting = true;
          try {
            const refusal = await this.refusal(store);
            if (refusal) { reply({ ok: false, reason: refusalText[refusal] }); return; }
            const ctx = this.context(store), held = heldItems(await readLedger(store.dir)).get(request.planId) ?? [];
            const wanted = request.op === "restore" && request.items ? new Set(request.items) : null;
            let done = 0, refused = 0;
            for (const item of held) {
              if (wanted && !wanted.has(item.id)) continue;
              const step = () => request.op === "restore" ? restoreItem(ctx, request.planId, item) : removeHeld(ctx, request.planId, item, "empty");
              const outcome = item.bench ? await this.deps.serialiseTake(`${store.worldId}/${item.bench.sessionId}/${item.bench.takeId}`, step) : await step();
              if (outcome.result === "done") done++; else refused++;
            }
            await this.deps.refreshWorld(store.worldId).catch(() => {});
            reply({ ok: true, status: await this.status(store), ...(refused ? { note: `${done} done · ${refused} stayed held` } : {}) }); return;
          } finally { this.admitting = false; }
        }
        case "put-back": {
          if (!(await this.writable(store))) throw new Error("Clean up can change this world only where it is open for writing.");
          const latest = [...this.plans.values()].sort((a, b) => b.madeAtMs - a.madeAtMs)[0];
          for (const take of latest?.putBack ?? []) await this.deps.keep(store.worldId, take.sessionId, take.takeId).catch(() => {});
          reply({ ok: true, status: await this.status(store) }); return;
        }
      }
    } catch (error) {
      reply({ ok: false, reason: error instanceof Error ? error.message.slice(0, 300) || "Clean up failed." : "Clean up failed." });
    }
  }

  /** On every writable open: settle what a crash cut short, then, if asked for, clear old chapter mixes (R-24, R-41). */
  async opened(store: WorldStore): Promise<void> {
    this.forWorld(store);
    if (!(await this.writable(store))) return;
    const lines = await readLedger(store.dir).catch(() => []);
    if (!lines.length) return;
    await this.recover(store).catch(() => {});
    const setting = [...lines].reverse().find((line): line is Extract<LedgerLine, { kind: "setting" }> => line.kind === "setting");
    if (!setting?.autoMixes) return;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => { this.autoTimer = null; void this.autoMixes(store).catch(() => {}); }, AUTO_DELAY_MS);
    this.autoTimer.unref();
  }

  /** Old chapter mixes only, a week old at least, 2 GiB at most a time, and never while anything else runs (R-41). */
  private async autoMixes(store: WorldStore): Promise<void> {
    if (store.isClosed() || this.running || this.admitting || store.worldId !== this.worldId || await this.refusal(store)) return;
    const setting = [...await readLedger(store.dir)].reverse().find((line): line is Extract<LedgerLine, { kind: "setting" }> => line.kind === "setting");
    if (!setting?.autoMixes) return;
    const planned = await computePlan(store, { appRoot: this.deps.appRoot(), now: () => this.now(), newPlanId: () => `cp_${ulid()}`, signal: store.closingSignal });
    let bytes = 0;
    const chosen = [...planned.items.values()].filter(item => item.view.class === "stale-mixes" && item.files.every(f => this.now() - f.mtimeMs >= 7 * DAY))
      .filter(item => (bytes += item.view.bytes) <= AUTO_MAX_BYTES);
    if (chosen.length) { this.start(store, planned, chosen, true); this.deps.log({ kind: "cleanup.auto-mixes", items: chosen.length }); }
  }

  private async writable(store: WorldStore): Promise<boolean> {
    if (!store.canWrite()) return false;
    try { await store.assertOwnership(); return true; } catch { return false; }
  }

  private async refusal(store: WorldStore): Promise<CleanupRefusal | null> {
    if (!store.canWrite()) return store.getBundle().externalEdits.length ? "outside-edits" : "read-only";
    try { await store.assertOwnership(); } catch { return "opened-elsewhere"; }
    if (this.running) return "running";
    if (unsettled(await readLedger(store.dir)).length) return "unsettled";
    return null;
  }

  private async recover(store: WorldStore): Promise<void> {
    const open = unsettled(await readLedger(store.dir));
    if (!open.length) return;
    const ctx = this.context(store);
    for (const line of open) await recoverIntent(ctx, line);
    await this.deps.refreshWorld(store.worldId).catch(() => {});
  }

  /** Held files whose hold ended a day ago or more go, on this opening of Clean up (R-30). */
  private async expire(store: WorldStore): Promise<void> {
    const lines = await readLedger(store.dir), ctx = this.context(store), starts = runStarts(lines);
    let changed = false;
    for (const [planId, items] of heldItems(lines)) {
      if (!(await lstat(toExtendedLength(join(store.dir, ".held", planId))).catch(() => null))) continue;
      // A plan's items go together, at the end its card shows: its longest hold (Codex on PR 3052).
      const ends = (starts.get(planId) ?? this.now()) + Math.max(...items.map(item => CLEANUP_HOLD_DAYS[item.class])) * DAY;
      if (this.now() < ends + DAY) continue;
      for (const item of items) {
        const step = () => removeHeld(ctx, planId, item, "expire");
        if ((item.bench ? await this.deps.serialiseTake(`${store.worldId}/${item.bench.sessionId}/${item.bench.takeId}`, step) : await step()).result === "done") changed = true;
      }
    }
    if (changed) this.deps.log({ kind: "cleanup.expired", worldId: store.worldId });
  }

  private start(store: WorldStore, planned: Planned, chosen: Planned["items"] extends Map<string, infer T> ? T[] : never, auto = false): void {
    const control = new AbortController();
    const order = (cls: CleanupClass) => CLEANUP_CLASSES.indexOf(cls);
    const sorted = [...chosen].sort((a, b) => order(a.view.class) - order(b.view.class));
    const holds = sorted.filter(item => item.action === "hold").map(item => CLEANUP_HOLD_DAYS[item.view.class]);
    const run: CleanupRun = {
      planId: planned.plan.id, startedAt: this.iso(), endedAt: null, done: 0, total: sorted.length, cleared: 0, held: 0,
      holdUntil: holds.length ? new Date(this.now() + Math.max(...holds) * DAY).toISOString() : null,
      classes: [...new Set(sorted.map(item => item.view.class))].map(cls => ({ class: cls, done: 0, skipped: 0, failed: 0, bytes: 0, reasons: [] })),
      availableBefore: null, availableAfter: null,
    };
    this.running = control;
    if (!auto) this.run = run;
    this.execution = this.execute(store, run, sorted, control).catch(() => {}).finally(() => { if (this.running === control) { this.running = null; this.execution = null; } });
  }

  private async execute(store: WorldStore, run: CleanupRun, items: Array<Planned["items"] extends Map<string, infer T> ? T : never>, control: AbortController): Promise<void> {
    const ctx = this.context(store), stoppedClasses = new Map<CleanupClass, string>();
    let since: Set<unknown> | null = null;
    run.availableBefore = await available(store.dir);
    await ctx.ledger.append({ kind: "plan", planId: run.planId, holdUntil: run.holdUntil, items: items.length });
    for (const item of items) {
      const row = run.classes.find(c => c.class === item.view.class)!;
      const reason = (text: string) => { if (!row.reasons.includes(text) && row.reasons.length < 8) row.reasons.push(text); };
      if (control.signal.aborted) { run.stopped = "stopped"; break; }
      if (store.isClosed()) { run.stopped = "world-closed"; break; }
      if (store.getBundle().externalEdits.length) { run.stopped = "outside-edits"; break; }
      const stopped = stoppedClasses.get(item.view.class);
      if (stopped) { row.skipped++; reason(stopped); run.done++; continue; }
      // Holds come after links and mixes: the census is taken again once, right before the first.
      if (item.action === "hold") {
        since ??= await namedSince(store.dir, this.deps.appRoot(), items, store.closingSignal).catch(() => new Set<unknown>(items));
        if (since.has(item)) { row.skipped++; reason("In use since plan"); run.done++; continue; }
      }
      try {
        const step = () => runItem(ctx, run.planId, item);
        const outcome = item.bench ? await this.deps.serialiseTake(`${store.worldId}/${item.bench.sessionId}/${item.bench.takeId}`, step) : await step();
        if (outcome.result === "done") {
          row.done++; row.bytes += item.view.bytes;
          if (item.action === "hold") run.held += item.view.bytes; else run.cleared += item.view.bytes;
        } else {
          row[outcome.result]++; reason(outcome.reason);
          if (outcome.result === "failed" && "stopClass" in outcome && outcome.stopClass) stoppedClasses.set(item.view.class, outcome.reason);
        }
      } catch (error) {
        if (store.isClosed()) { run.stopped = "world-closed"; break; }
        if (!(await this.writable(store))) { run.stopped = store.getBundle().externalEdits.length ? "outside-edits" : "opened-elsewhere"; break; }
        row.failed++; reason(error instanceof Error ? error.message.slice(0, 120) : "Failed");
      }
      run.done++;
    }
    await ctx.ledger.append({ kind: "end", op: "run", planId: run.planId, ...(run.stopped ? { stopped: run.stopped } : {}) }).catch(() => { run.stopped ??= "failed"; });
    run.availableAfter = await available(store.dir);
    run.endedAt = this.iso();
    await this.deps.refreshWorld(store.worldId).catch(() => {});
    this.deps.log({ kind: "cleanup.run", worldId: store.worldId, planId: run.planId, done: run.done, total: run.total, stopped: run.stopped ?? null });
  }

  async status(store: WorldStore): Promise<CleanupStatus> {
    const lines = await readLedger(store.dir).catch(() => [] as LedgerLine[]);
    const setting = [...lines].reverse().find((line): line is Extract<LedgerLine, { kind: "setting" }> => line.kind === "setting");
    return { run: this.run, running: this.running !== null, held: await heldPlans(store.dir, lines, this.now()), refusal: await this.refusal(store), autoMixes: setting?.autoMixes ?? false };
  }

  /** Stops before the next item and waits for the one under way, so nothing moves after the world is let go (Codex on PR 3052). */
  async stop(): Promise<void> {
    this.running?.abort(); if (this.autoTimer) clearTimeout(this.autoTimer); this.autoTimer = null;
    await this.execution;
  }
}

const refusalText: Record<CleanupRefusal, string> = {
  "read-only": "Read-only world", "outside-edits": "Outside edits · Adopt first", "opened-elsewhere": "Opened elsewhere",
  unsettled: "Unsettled run", running: "Running",
};

async function available(dir: string): Promise<number | null> {
  try { const info = await statfs(toExtendedLength(dir)); const bytes = Number(info.bavail) * Number(info.bsize); return Number.isSafeInteger(bytes) ? bytes : null; }
  catch { return null; }
}

/** When each plan's run began: holds are counted from there (R-28). */
function runStarts(lines: readonly LedgerLine[]): Map<string, number> {
  const starts = new Map<string, number>();
  for (const line of lines) if (line.kind === "plan" && !starts.has(line.planId)) starts.set(line.planId, Date.parse(line.at));
  return starts;
}

/** What each plan still holds: held by its run, and neither restored nor removed since. */
export function heldItems(lines: readonly LedgerLine[]): Map<string, LedgerItem[]> {
  const intents = new Map<string, LedgerItem>(), held = new Map<string, Map<string, LedgerItem>>();
  for (const line of lines) {
    if (line.kind === "intent") intents.set(`${line.op}|${line.planId}|${line.item.id}`, line.item);
    if (line.kind !== "outcome" || (line.result !== "done" && line.result !== "recovered")) continue;
    const item = intents.get(`${line.op}|${line.planId}|${line.itemId}`);
    if (!item) continue;
    const plan = held.get(line.planId) ?? new Map<string, LedgerItem>();
    if (line.op === "run" && item.action === "hold") plan.set(item.id, item);
    else if (line.op === "restore" || line.op === "expire" || line.op === "empty") plan.delete(item.id);
    held.set(line.planId, plan);
  }
  // A hold recovered by rolling back never held anything: its files are where they were.
  return new Map([...held].map(([planId, items]): [string, LedgerItem[]] => [planId, [...items.values()]]).filter(([, items]) => items.length > 0));
}

async function heldPlans(dir: string, lines: readonly LedgerLine[], now: number): Promise<CleanupHeldPlan[]> {
  const starts = runStarts(lines), open = new Set(unsettled(lines).map(line => line.planId)), plans: CleanupHeldPlan[] = [];
  const there = async (path: string) => !!(await lstat(toExtendedLength(join(dir, ...path.split("/")))).catch(() => null));
  for (const [planId, items] of heldItems(lines)) {
    const start = starts.get(planId) ?? now;
    const until = start + Math.max(...items.map(item => CLEANUP_HOLD_DAYS[item.class])) * DAY;
    const view = [];
    for (const item of items) {
      const firstHeld = item.paths.length === 1 && !item.files.some(f => f.path === item.paths[0]) ? item.paths[0]! : item.files[0]?.path;
      const blocked = !firstHeld ? undefined : await there(heldPath(planId, firstHeld)) ? (await there(firstHeld) ? "Name taken" : undefined) : "Not where it was held";
      view.push({ id: item.id, class: item.class, label: item.label, bytes: item.bytes, ...(blocked ? { blocked } : {}) });
    }
    const elsewhere = !(await there(`.held/${planId}`));
    plans.push({
      planId, madeAt: new Date(start).toISOString(), holdUntil: new Date(until).toISOString(), goesAfter: new Date(until + DAY).toISOString(),
      state: open.has(planId) ? "unsettled" : elsewhere ? "elsewhere" : now >= until ? "ended" : "held",
      bytes: items.reduce((sum, item) => sum + item.bytes, 0), items: view,
    });
  }
  return plans.sort((a, b) => b.madeAt.localeCompare(a.madeAt));
}

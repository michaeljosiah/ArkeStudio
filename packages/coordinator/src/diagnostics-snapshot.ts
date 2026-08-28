import {
  deriveDiagnostics,
  diagnosticsEqual,
  type DiagnosticsSnapshot,
  type DiagnosticsSources,
  type DiagnosticsTails,
  type RedactionBoundary,
} from "@arke-studio/contracts";

/**
 * The one holder of the current diagnostics snapshot (SPEC-032 §1.9).
 *
 * Derivation is re-run when any source changes and never on a timer (R-33): the coordinator
 * pokes `schedule()` from its one event path, and everything that lands in a tick coalesces
 * into a single derivation on the next immediate — which is also what keeps it off every path
 * a user action awaits (R-34). The previous snapshot stays here because R-11 makes `firstSeen`
 * an input: the derivation is pure, and this class is the caller that owns the bookkeeping.
 *
 * A fresh derivation is broadcast only when it states something different. Sources change far
 * more often than findings do, and re-sending an identical set on every job progress event
 * would be noise the client then has to diff anyway.
 */
export class DiagnosticsSnapshotHolder {
  private current: DiagnosticsSnapshot | null = null;
  private scheduled: NodeJS.Immediate | null = null;
  private disposed = false;
  private forceBroadcast = false;
  /** Callers awaiting the next derivation (the bundle's freshness gate). */
  private settlers: Array<(snapshot: DiagnosticsSnapshot) => void> = [];

  constructor(
    private readonly deps: {
      sources: () => DiagnosticsSources;
      /** Bounded log tails (R-18). #555 supplies the real read; until then an empty tail. */
      tails: () => DiagnosticsTails;
      boundary: RedactionBoundary;
      onSnapshot: (snapshot: DiagnosticsSnapshot) => void;
      clock?: () => string;
    },
  ) {}

  /** Coalesce however many source changes arrive this tick into at most one derivation (R-33). */
  schedule(): void {
    if (this.disposed || this.scheduled !== null) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      this.deriveNow(true);
    });
  }

  /**
   * R-33's on-demand half, for the view opening after a quiet stretch: derive and broadcast
   * even when nothing material changed, because the derivation instant and any staleness marks
   * are themselves what the asker came for. Still coalesced — a refresh joining a pending
   * schedule is one derivation, force carried.
   */
  refresh(): void {
    if (this.disposed) return;
    this.forceBroadcast = true;
    this.schedule();
  }

  /**
   * The latest derived snapshot. Maintained eagerly from the first `schedule()`, so callers on
   * request paths (a fresh connection's replay) read rather than compute; deriving here is
   * only the cold-start fallback before the first tick has fired — and that one is not
   * broadcast, because the caller is about to deliver it itself and no client holds an older
   * one to correct.
   */
  currentSnapshot(): DiagnosticsSnapshot {
    return this.current ?? this.deriveNow(false);
  }

  /**
   * Resolves with the NEXT derivation — the support bundle's freshness gate. A bundle pulled
   * after a quiet stretch must not answer for the instant something last changed: staleness
   * marks are computed at derivation, so the cached snapshot's are as old as the quiet. The
   * derivation still runs on its own immediate, off the asking frame handler's path (R-34);
   * the handler merely awaits it, as it awaits the log read beside it.
   */
  refreshed(): Promise<DiagnosticsSnapshot> {
    if (this.disposed) return Promise.resolve(this.currentSnapshot());
    return new Promise((resolve) => {
      this.settlers.push(resolve);
      this.forceBroadcast = true;
      this.schedule();
    });
  }

  private deriveNow(broadcast: boolean): DiagnosticsSnapshot {
    // This derivation supersedes any pending one — running both would be two in a tick (R-33).
    if (this.scheduled !== null) {
      clearImmediate(this.scheduled);
      this.scheduled = null;
    }
    const snapshot = deriveDiagnostics({
      sources: this.deps.sources(),
      tails: this.deps.tails(),
      previous: this.current,
      now: (this.deps.clock ?? (() => new Date().toISOString()))(),
      boundary: this.deps.boundary,
    });
    const changed = !diagnosticsEqual(this.current, snapshot) || this.forceBroadcast;
    this.forceBroadcast = false;
    this.current = snapshot;
    if (broadcast && changed && !this.disposed) this.deps.onSnapshot(snapshot);
    for (const settle of this.settlers.splice(0)) settle(snapshot);
    return snapshot;
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled !== null) {
      clearImmediate(this.scheduled);
      this.scheduled = null;
    }
    // Nothing may hang shutdown on a derivation that will never fire; the last snapshot (or a
    // cold pure derive) is the honest answer to a caller already in flight.
    for (const settle of this.settlers.splice(0)) settle(this.current ?? this.deriveNow(false));
  }
}

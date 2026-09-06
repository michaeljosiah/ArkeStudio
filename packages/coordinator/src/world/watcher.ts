import { watch, type FSWatcher } from "node:fs";

/**
 * External-edit watcher (SPEC-002 R-23): observes an open world, debounced, and reports that
 * something outside the app wrote to it. Never merges — the report is "reload required".
 * The store suppresses it around its own commits.
 */

const DEBOUNCE_MS = 400;
/** Known operational paths can be ignored as an optimization; all other names are hints only. */
const IGNORED = [
  /^\.commit([/\\]|$)/,
  /^\.index([/\\]|$)/,
  /^\.history([/\\]|$)/,
  /^\.proposals([/\\]|$)/,
  // Conversation writes are app-owned and frequent. Without this every message would raise
  // "this world changed outside Arke Studio" against the app's own append.
  /^\.conversations([/\\]|$)/,
  // Bench sessions are the same operational history (issue 305 §6): every event append and
  // every landed take would otherwise accuse the app of editing its own world.
  /^\.sessions([/\\]|$)/,
  /^\.cache([/\\]|$)/,
  // Continuity records (turn 129) are derived by the app beside each chapter; its own write
  // must not read as the world changing outside it.
  /(^|[/\\])\.continuity([/\\]|$)/,
  /^\.staging([/\\]|$)/,
  /^world\.lock$/,
  /\.tmp-[0-9A-Z]+$/i,
];
export interface WatcherDeps {
  /** Injectable for the error-path unit tests; defaults to fs.watch. */
  watch?: typeof watch;
}

export class WorldWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private suppressed = 0;

  constructor(
    private readonly dir: string,
    private readonly onExternalChange: () => void,
    private readonly deps: WatcherDeps = {},
  ) {}

  start(): void {
    const open = this.deps.watch ?? watch;
    try {
      const watcher = open(this.dir, { recursive: true }, (_event, filename) => {
        if (this.suppressed > 0) return;
        // A filename is only a hint. Windows may omit it and editors may report an incomplete
        // rename sequence; the store verifies the complete byte manifest after debounce.
        if (filename !== null && filename !== "" && IGNORED.some((pattern) => pattern.test(filename))) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.onExternalChange(), DEBOUNCE_MS);
      });
      watcher.on("error", (err: NodeJS.ErrnoException) => this.onWatchError(err));
      this.watcher = watcher;
      // Detection must never hold the process open — a leaked watcher is a hang, not a feature.
      this.watcher.unref?.();
    } catch {
      // A filesystem that cannot watch degrades detection, not the product.
      this.watcher = null;
    }
  }

  /**
   * Watcher errors are reports, never crashes.
   *
   * Only Windows and macOS watch a tree natively. Everywhere else Node emulates `recursive`
   * in JavaScript: it walks the world, keeps one watcher per directory, and re-reads a
   * directory whenever that directory changes. Accepting or discarding a proposal deletes
   * `.proposals/<id>/` out from under that re-read, so the walk lands on a directory that no
   * longer exists and the ENOENT arrives here. An `FSWatcher` is an EventEmitter, and an
   * emitter that emits `error` with nobody listening rethrows into the process — which is how
   * an ordinary deletion became an uncaught exception that killed whatever was running.
   */
  private onWatchError(err: NodeJS.ErrnoException): void {
    // A directory we deleted ourselves, mid-walk. Nothing external happened; nothing to report.
    if (err.code === "ENOENT") return;
    // Anything else — inotify exhausted, permission lost — means the watch no longer sees the
    // world. Let it go rather than trust it: same degraded detection as a filesystem that
    // cannot watch at all, and reconciliation at open (R-28) still catches the edits.
    this.stop();
  }

  /** Suppress while the app itself writes; unsuppress lingers past the debounce window. */
  suppress(): void {
    this.suppressed++;
  }

  unsuppress(): void {
    // Events for our own renames can arrive after the write returns — hold the gate briefly.
    setTimeout(() => {
      this.suppressed = Math.max(0, this.suppressed - 1);
    }, DEBOUNCE_MS + 200).unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = null;
  }
}

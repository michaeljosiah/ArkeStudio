import { watch, type FSWatcher } from "node:fs";

/**
 * External-edit watcher (SPEC-002 R-23): observes an open world, debounced, and reports that
 * something outside the app wrote to it. Never merges — the report is "reload required".
 * The store suppresses it around its own commits.
 */

const DEBOUNCE_MS = 400;
/**
 * Paths the app owns operationally — changes here are ours or derived, never "external".
 * `.proposals/` is staging: authoring agents legitimately write there mid-session (SPEC-005),
 * the gate rescans after every operation, and base hashes protect the live world regardless.
 */
const IGNORED = [
  /^\.commit([/\\]|$)/,
  /^\.index([/\\]|$)/,
  /^\.history([/\\]|$)/,
  /^\.proposals([/\\]|$)/,
  /^\.cache([/\\]|$)/, // derived previews and staging (SPEC-011) — regenerable, never canon
  /^\.staging([/\\]|$)/, // the queue's artifact staging area (SPEC-009 R-12)
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
        // Windows delivers null filenames on rename bursts — overwhelmingly our own SQLite/
        // journal traffic straggling past the suppression window. Closed-world reconciliation
        // (R-28) still catches anything a dropped event would have flagged.
        if (filename === null || filename === "") return;
        if (IGNORED.some((rx) => rx.test(filename))) return;
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

import { watch, type FSWatcher } from "node:fs";

/**
 * External-edit watcher (SPEC-002 R-23): observes an open world, debounced, and reports that
 * something outside the app wrote to it. Never merges — the report is "reload required".
 * The store suppresses it around its own commits.
 */

const DEBOUNCE_MS = 400;
/** Paths the app owns operationally — changes here are ours or derived, never "external". */
const IGNORED = [/^\.commit([/\\]|$)/, /^\.index([/\\]|$)/, /^\.history([/\\]|$)/, /^world\.lock$/, /\.tmp-[0-9A-Z]+$/i];

export class WorldWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private suppressed = 0;

  constructor(
    private readonly dir: string,
    private readonly onExternalChange: () => void,
  ) {}

  start(): void {
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_event, filename) => {
        if (this.suppressed > 0) return;
        // Windows delivers null filenames on rename bursts — overwhelmingly our own SQLite/
        // journal traffic straggling past the suppression window. Closed-world reconciliation
        // (R-28) still catches anything a dropped event would have flagged.
        if (filename === null || filename === "") return;
        if (IGNORED.some((rx) => rx.test(filename))) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.onExternalChange(), DEBOUNCE_MS);
      });
      // Detection must never hold the process open — a leaked watcher is a hang, not a feature.
      this.watcher.unref?.();
    } catch {
      // A filesystem that cannot watch degrades detection, not the product.
      this.watcher = null;
    }
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

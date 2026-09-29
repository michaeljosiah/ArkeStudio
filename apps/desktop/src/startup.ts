export type StartupState =
  { status: "initializing" } | { status: "ready"; port: number } | { status: "failed"; detail: string };

export interface StartupControllerOptions {
  initialize(): Promise<{ port: number }>;
  cleanup(): Promise<void>;
  publish(state: StartupState): void;
  report(error: unknown): void;
}

const FAILURE_DETAIL =
  "Arke Studio could not finish starting. Open the data folder to inspect the logs, then retry.";

/** Runs at most one initialization attempt and turns every rejection into visible state. */
export class StartupController {
  private running: Promise<void> | null = null;
  private ready = false;
  private retryRequested = false;
  private needsCleanup = false;

  constructor(private readonly opts: StartupControllerOptions) {}

  run(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.running) {
      this.retryRequested = true;
      return this.running;
    }
    this.opts.publish({ status: "initializing" });
    this.running = this.attempt().finally(() => {
      this.running = null;
      if (this.retryRequested && !this.ready) {
        this.retryRequested = false;
        void this.run();
      }
    });
    return this.running;
  }

  private async attempt(): Promise<void> {
    // A failed cleanup may still own a coordinator, world lock or published gateway.
    // Retry must drain that same host before initialize can construct its replacement.
    if (this.needsCleanup && !await this.cleanup()) return;
    try {
      const { port } = await this.opts.initialize();
      this.ready = true;
      this.opts.publish({ status: "ready", port });
    } catch (error) {
      this.needsCleanup = true;
      this.opts.report(error);
      this.opts.publish({ status: "failed", detail: FAILURE_DETAIL });
      await this.cleanup();
    }
  }

  private async cleanup(): Promise<boolean> {
    try {
      await this.opts.cleanup();
      this.needsCleanup = false;
      return true;
    } catch (error) {
      this.opts.report(error);
      this.opts.publish({ status: "failed", detail: "Studio could not finish cleaning up the previous start. Restore Tailscale if unavailable, then retry. A new session will wait until cleanup succeeds." });
      return false;
    }
  }
}

export function isBackgroundLogin(platform: string, args: readonly string[], login?: { wasOpenedAtLogin: boolean }): boolean {
  return platform === "win32" ? args.includes("--remote-background") : platform === "darwin" && login?.wasOpenedAtLogin === true;
}

/** A login launch reaches first paint without ever showing. Explicit Open and startup
 * failures reveal it; neither themed readiness nor the fallback timer may do so first. */
export class StartupWindowPresentation {
  private finish!: () => void;
  readonly ready = new Promise<void>(resolve => { this.finish = resolve; });
  constructor(private background: boolean, private readonly show: () => void) {}
  present(): void { if (!this.background) this.show(); this.finish(); }
  reveal(): void { this.background = false; this.present(); }
}

/** Window creation resolves at first paint (first show for ordinary foreground launches). */
export async function launchDesktop(
  createWindow: () => Promise<void>,
  controller: StartupController,
): Promise<void> {
  await createWindow();
  void controller.run();
}

/** Remote unpublication has its own bounded operations. It must finish before the core
 * shutdown deadline begins, so a slow Serve call cannot abandon a still-running stop chain. */
export async function drainDesktop(stopRemote: () => Promise<void>, stopCore: () => Promise<void>, deadlineMs = 15_000): Promise<void> {
  await stopRemote();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stopCore(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("local shutdown did not finish safely")), deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

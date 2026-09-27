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
    try {
      const { port } = await this.opts.initialize();
      this.ready = true;
      this.opts.publish({ status: "ready", port });
    } catch (error) {
      this.opts.report(error);
      this.opts.publish({ status: "failed", detail: FAILURE_DETAIL });
      await this.opts.cleanup().catch((cleanupError: unknown) => this.opts.report(cleanupError));
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

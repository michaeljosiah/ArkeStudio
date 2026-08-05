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

/** Window creation resolves on first show, so startup work cannot compete with first paint. */
export async function launchDesktop(
  createWindow: () => Promise<void>,
  controller: StartupController,
): Promise<void> {
  await createWindow();
  void controller.run();
}

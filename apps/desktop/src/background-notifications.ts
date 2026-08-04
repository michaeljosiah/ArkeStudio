import type { BackgroundNotificationPreference, ClientState, DomainEvent, Job } from "@arke-studio/contracts";

export interface NotificationHandle {
  onClick(listener: () => void): void;
  show(): void;
}

export interface NotificationWindow {
  isFocused(): boolean;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  activateActivity(): void;
}

export interface BackgroundNotificationDeps {
  supported(): boolean;
  packaged: boolean;
  platform: string;
  window(): NotificationWindow | null;
  create(input: { title: string; body: string; silent: boolean }): NotificationHandle;
}

function targetLabel(job: Job): string {
  switch (job.target.kind) {
    case "character-sheet": {
      const characterName = job.params["characterName"];
      return typeof characterName === "string" ? `Character sheet for ${characterName}` : "Character sheet";
    }
    case "character-look":
      return "Character look";
    case "main-photo-candidate":
      return "Character portrait";
    case "shot":
      return "Shot";
    case "scene-pass":
      return "Scene";
    case "voice-line":
      return "Voice line";
    default:
      return "Generation";
  }
}

export class BackgroundNotificationController {
  private armed = false;
  private stopped = false;
  private preference: BackgroundNotificationPreference = "issues-only";
  private readonly jobs = new Map<string, Job>();
  private readonly consumed = new Set<string>();
  private readonly paused = new Set<string>();

  constructor(private readonly deps: BackgroundNotificationDeps) {}

  arm(state: ClientState): void {
    this.preference = state.app.backgroundNotifications;
    for (const job of state.app.jobs) this.jobs.set(job.id, job);
    for (const queue of state.app.queues) if (queue.paused) this.paused.add(queue.provider);
    this.armed = true;
  }

  stop(): void {
    this.stopped = true;
  }

  observe(event: DomainEvent): void {
    if (event.type === "background-notifications.changed") {
      this.preference = event.preference;
      return;
    }
    if (!this.armed || this.stopped) return;
    if (event.type === "job.ready") {
      this.jobs.set(event.job.id, event.job);
      this.notify("results", `job:${event.job.id}:ready`, {
        title: "Generation ready",
        body: `${targetLabel(event.job)} is ready in Arke Studio.`,
      });
      return;
    }
    if (event.type === "queue.status") {
      if (!event.queue.paused) {
        this.paused.delete(event.queue.provider);
        this.consumed.delete(`queue:${event.queue.provider}:paused`);
        return;
      }
      if (event.queue.pauseKind === "offline") return;
      if (this.paused.has(event.queue.provider)) return;
      this.paused.add(event.queue.provider);
      this.notify("issues", `queue:${event.queue.provider}:paused`, {
        title: "Provider needs attention",
        body: "A provider is paused. Open Activity to continue.",
      });
      return;
    }
    if (event.type !== "job.updated") return;
    const previous = this.jobs.get(event.job.id);
    this.jobs.set(event.job.id, event.job);
    if (event.job.status !== "needs-reconciliation") {
      this.consumed.delete(`job:${event.job.id}:needs-reconciliation`);
    }
    if (event.job.finalization?.status !== "failed") {
      this.consumed.delete(`job:${event.job.id}:finalization-failed`);
    }
    if (event.job.status === "needs-reconciliation" && previous?.status !== "needs-reconciliation") {
      this.notify("issues", `job:${event.job.id}:needs-reconciliation`, {
        title: "Generation needs your answer",
        body: "A submission outcome is unknown. Open Activity to decide safely.",
      });
    } else if (event.job.status === "failed" && previous?.status !== "failed") {
      this.notify("issues", `job:${event.job.id}:failed`, {
        title: "Generation failed",
        body: "A generation needs attention. Open Activity for details.",
      });
    } else if (event.job.finalization?.status === "failed" && previous?.finalization?.status !== "failed") {
      this.notify("issues", `job:${event.job.id}:finalization-failed`, {
        title: "Result needs attention",
        body: "A generated result could not be prepared. Open Activity to continue.",
      });
    }
  }

  private notify(kind: "results" | "issues", key: string, copy: { title: string; body: string }): void {
    if (this.consumed.has(key)) return;
    this.consumed.add(key);
    if (
      this.preference === "off" ||
      (kind === "results" && this.preference !== "background-results-and-issues")
    )
      return;
    if (!this.deps.packaged || this.deps.platform !== "win32" || !this.deps.supported()) return;
    const window = this.deps.window();
    if (!window || window.isDestroyed() || window.isFocused()) return;
    const notification = this.deps.create({ ...copy, silent: true });
    notification.onClick(() => {
      if (this.stopped || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      window.focus();
      window.activateActivity();
    });
    notification.show();
  }
}

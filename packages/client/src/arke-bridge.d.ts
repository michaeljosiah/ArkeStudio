/** The typed preload bridge (SPEC-001 R-9). Mirrors apps/desktop/src/preload.ts. */
export interface ArkeBridge {
  appVersion: string;
  platform: string;
  coordinatorHttpBase?(): string | null;
  theme?: { preference: ThemePreference; resolved: ResolvedTheme };
  startupState?(): StartupState;
  onStartupState?(listener: (state: StartupState) => void): () => void;
  retryStartup?(): void;
  openDataFolder?(): void;
  quit?(): void;
  connect(): void;
  send(json: string): void;
  subscribe(
    onFrame: (frameJson: string) => void,
    onStatus: (status: "connecting" | "open" | "closed") => void,
  ): void;
  onActivateActivity?(listener: () => void): () => void;
  setHostTheme?(preference: ThemePreference): void;
  onThemeChange?(
    listener: (theme: { preference: ThemePreference; resolved: ResolvedTheme }) => void,
  ): () => void;
  themeReady?(): void;
  /**
   * Hold the dark caption buttons while the launch screen's plate is up, whatever the
   * appearance preference. Optional: a browser session has no host chrome to repaint.
   */
  chromeOverPlate?(over: boolean): void;
  /**
   * Desktop only, and optional for that reason: a browser session has no host to resolve a
   * dropped file's path, so the composer simply does not offer the affordance there.
   */
  attachDropped?(target: AttachTarget, files: readonly File[]): { filed: number; unresolved: number[] };
  attachBytes?(
    target: AttachTarget,
    name: string,
    bytes: Uint8Array,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type StartupState =
  { status: "initializing" } | { status: "ready" } | { status: "failed"; detail: string };

/**
 * Where an attachment is going: a world to file into, a genesis conversation that does not have
 * one yet, or one World Chat conversation, which keeps it privately rather than filing it.
 *
 * Each member is also the frame it becomes — the host appends the resolved `sourcePath` and sends
 * the object as-is — so a new destination is a new member here and a matching `ClientMessage`.
 */
export type AttachTarget =
  /** `production` is SPEC-020 ownership; `null` is the world stated out loud. Mirrors preload.ts. */
  | { kind: "file-artifact"; worldId: string; production?: string | null }
  | { kind: "genesis-attach"; genesisId: string }
  | { kind: "world-chat-attach"; worldId: string; conversationId: string };

declare global {
  interface Window {
    arke?: ArkeBridge;
  }
}

export {};

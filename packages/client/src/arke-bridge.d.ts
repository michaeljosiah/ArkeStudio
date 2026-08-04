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

/** A world to file into, or a genesis conversation that does not have one yet. */
export type AttachTarget =
  { kind: "file-artifact"; worldId: string } | { kind: "genesis-attach"; genesisId: string };

declare global {
  interface Window {
    arke?: ArkeBridge;
  }
}

export {};

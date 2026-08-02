/** The typed preload bridge (SPEC-001 R-9). Mirrors apps/desktop/src/preload.ts. */
export interface ArkeBridge {
  appVersion: string;
  platform: string;
  connect(): void;
  send(json: string): void;
  subscribe(
    onFrame: (frameJson: string) => void,
    onStatus: (status: "connecting" | "open" | "closed") => void,
  ): void;
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

/** A world to file into, or a genesis conversation that does not have one yet. */
export type AttachTarget =
  | { kind: "file-artifact"; worldId: string }
  | { kind: "genesis-attach"; genesisId: string };

declare global {
  interface Window {
    arke?: ArkeBridge;
  }
}

export {};

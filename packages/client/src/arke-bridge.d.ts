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
}

declare global {
  interface Window {
    arke?: ArkeBridge;
  }
}

export {};

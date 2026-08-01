import type { WorldBundle, WorldSummary } from "@arke-studio/contracts";

/**
 * Reads the world model (SPEC-001 §2.6). SPEC-002 replaced the SPEC-001 mock with the real
 * filesystem provider (`world/provider.ts`); this interface is what the coordinator holds.
 * Optional capabilities arrived with SPEC-002 — a provider without them simply cannot create
 * or reconcile, and the coordinator degrades accordingly.
 */
export interface WorldProvider {
  listWorlds(): Promise<WorldSummary[]>;
  loadWorld(worldId: string): Promise<WorldBundle>;
  createWorld?(input: {
    name: string;
    logline?: string;
    tone?: string;
    genre?: string;
  }): Promise<{ worldId: string; slug: string }>;
  reloadWorld?(worldId: string): Promise<WorldBundle>;
  reconcileExternalEdit?(worldId: string, path: string): Promise<WorldBundle>;
  onWorldStale?(cb: (worldId: string) => void): void;
  close?(): Promise<void>;
}

import type { WorldBundle, WorldSummary } from "@arke-studio/contracts";
import type { ProposalManager } from "./gate/proposals.js";
import type { WorldStore } from "./world/store.js";

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
    artDirection?: string;
    bible?: string;
  }): Promise<{ worldId: string; slug: string }>;
  /** Move a world out of the library into `archive/`, whole. Returns where it went. */
  archiveWorld?(worldId: string): Promise<{ folder: string }>;
  /**
   * Copy the sample world shipped with this build into the library under a fresh identity
   * (SPEC-016 R-6). Where the build keeps it is the shell's business, not the provider's.
   */
  installSampleWorld?(sourceDir: string): Promise<{ worldId: string; slug: string; name: string }>;
  reconcileExternalEdit?(worldId: string, path: string): Promise<WorldBundle>;
  /**
   * The open world took newer bytes for an ungated file and needs no decision (SPEC-022).
   *
   * Nothing is wrong, nobody has to reconcile, and the only correct response is to redraw.
   */
  onWorldAdopted?(cb: (worldId: string) => void): void;
  /** The accept gate over the open world (SPEC-004). Null until a world is open. */
  gate?(): ProposalManager | null;
  /** The open store itself (SPEC-005: the world-query tool reads through it). */
  openStore?(): WorldStore | null;
  /**
   * Run against a world's locked store without changing which world the renderer has open.
   * Used by durable background jobs whose owner may not be the selected world.
   */
  withWorldStore?<T>(worldId: string, fn: (store: WorldStore) => Promise<T>): Promise<T>;
  /**
   * Resolve a world-relative media file for the renderer (design-fidelity pass): read-only,
   * traversal-guarded, media extensions only. Null when the file is not servable.
   */
  serveMedia?(slug: string, relPath: string): Promise<{ path: string; contentType: string } | null>;
  /** A sandbox directory for a genesis conversation — created on first use, world-less. */
  genesisDir?(genesisId: string): Promise<string>;
  /** Remove a genesis sandbox — the conversation began a world or was abandoned. */
  discardGenesis?(genesisId: string): Promise<void>;
  close?(): Promise<void>;
}

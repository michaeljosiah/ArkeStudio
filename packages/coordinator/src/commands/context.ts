import type { DomainEvent } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { ClientCommandKind } from "./router.js";

/**
 * What every command module may reach of the coordinator (issue 2796): the members most domains
 * share. A collaborator one domain alone uses is that module's own dependency, passed when the
 * module is made, so this stays the shared surface rather than the whole class again. It grows
 * as domains move out of `coordinator.ts`.
 */
export interface CommandContext {
  /** True once the studio has begun to stop; work that would outlive it is not started. */
  stopping(): boolean;
  /** The open world's store, if a world is open. */
  openStore(): WorldStore | undefined;
  emit(event: DomainEvent): void;
  nowIso(): string;
  /** Publishes the open world's bundle again; a world that is no longer open is left alone. */
  refreshWorldSnapshot(worldId: string): Promise<void>;
  /**
   * Tells the person a command did not finish, on the toaster every command failure reaches: a
   * string as written, an error as a person reads it (`describeCoordinatorError`).
   */
  fail(command: ClientCommandKind, requestId: string | null, error: unknown): void;
}

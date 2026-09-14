/** Optional materialised-folder adapter and existing dispatcher; no desktop construction. */
export { createLocalWorldRepository } from "../../coordinator/src/application/local-worlds.js";
export { FileEngineOperationStore } from "../../coordinator/src/application/local-operations.js";
export { FsWorldProvider } from "../../coordinator/src/world/provider.js";
export { JobQueue } from "../../coordinator/src/queue/dispatcher.js";
export type { JobQueueOptions, DispatchClient, DispatchArtifact } from "../../coordinator/src/queue/dispatcher.js";
export type { JobStateStore } from "../../coordinator/src/queue/journal.js";
export { JobJournal } from "../../coordinator/src/queue/journal.js";

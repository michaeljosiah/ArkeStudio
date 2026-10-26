import { Coordinator, type CoordinatorOptions } from "../coordinator.js";
import { createStudioStorage } from "./studio-composition.js";
import { StudioServer } from "../studio-server.js";
import { AppStorageService } from "../storage/service.js";
import { RecoveryControlService } from "../recovery/control.js";
import { FileRecoveryControlStore } from "../recovery/control-file.js";
import { RecoveryHistoryService } from "../recovery/history.js";
import { FileRecoveryHistoryStore } from "../recovery/history-file.js";
import { join } from "node:path";

/** Production desktop/dev assembly. Direct Coordinator construction remains supported by fixtures. */
export function createStudioCoordinator(options: CoordinatorOptions): Coordinator {
  return new Coordinator({ ...options, storage: options.storage ?? createStudioStorage(options),
    storageHealth: options.storageHealth === undefined && options.appRoot ? new AppStorageService({ appRoot: options.appRoot }) : options.storageHealth,
    recoveryControl: options.recoveryControl === undefined && options.appRoot ? new RecoveryControlService({ store: new FileRecoveryControlStore(join(options.appRoot, "operations", "recovery-control.json")) }) : options.recoveryControl,
    recoveryHistory: options.recoveryHistory === undefined && options.appRoot ? new RecoveryHistoryService({ store: new FileRecoveryHistoryStore(join(options.appRoot, "operations", "recovery-history.json")) }) : options.recoveryHistory });
}

/** Shared desktop and Node host composition; platform callbacks retain the Studio controller. */
export function createStudioHost(options: CoordinatorOptions) {
  const coordinator = createStudioCoordinator(options);
  const server = new StudioServer(coordinator.serverApplication, options.transportAuth);
  return { server, coordinator };
}

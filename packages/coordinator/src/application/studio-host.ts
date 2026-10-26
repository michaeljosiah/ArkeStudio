import { Coordinator, type CoordinatorOptions } from "../coordinator.js";
import { createStudioStorage } from "./studio-composition.js";
import { StudioServer } from "../studio-server.js";
import { AppStorageService } from "../storage/service.js";

/** Production desktop/dev assembly. Direct Coordinator construction remains supported by fixtures. */
export function createStudioCoordinator(options: CoordinatorOptions): Coordinator {
  return new Coordinator({ ...options, storage: options.storage ?? createStudioStorage(options),
    storageHealth: options.storageHealth === undefined && options.appRoot ? new AppStorageService({ appRoot: options.appRoot }) : options.storageHealth });
}

/** Shared desktop and Node host composition; platform callbacks retain the Studio controller. */
export function createStudioHost(options: CoordinatorOptions) {
  const coordinator = createStudioCoordinator(options);
  const server = new StudioServer(coordinator.serverApplication, options.transportAuth);
  return { server, coordinator };
}

import { Coordinator, type CoordinatorOptions } from "../coordinator.js";
import { createStudioStorage } from "./studio-composition.js";

/** Production desktop/dev assembly. Direct Coordinator construction remains supported by fixtures. */
export function createStudioCoordinator(options: CoordinatorOptions): Coordinator {
  return new Coordinator({ ...options, storage: options.storage ?? createStudioStorage(options) });
}

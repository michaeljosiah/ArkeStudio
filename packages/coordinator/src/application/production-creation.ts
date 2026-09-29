import { createProduction, productionCreatedBy, type CreateProductionInput } from "../productions/ops.js";
import type { WorldStore } from "../world/store.js";

export type ProductionCreationOutcome =
  | { status: "created"; slug: string }
  | { status: "pending" }
  | { status: "invalid"; reason: string }
  | { status: "failed"; error: unknown };

/** Local creation orchestration. The domain writer retains commit and slug authority. */
export class ProductionCreationService {
  private readonly running = new Set<string>();

  async create(
    store: WorldStore,
    input: CreateProductionInput,
    committed: () => Promise<void>,
  ): Promise<ProductionCreationOutcome> {
    if (input.medium === undefined && input.format === undefined) {
      return { status: "invalid", reason: "the request names neither a medium nor a format" };
    }
    const requestId = input.requestId;
    // Keep the reservation until the host has published the committed world. Another delivery
    // during that publication must not answer before the first caller's state is ready.
    if (requestId) {
      if (this.running.has(requestId)) return { status: "pending" };
      this.running.add(requestId);
    }
    try {
      if (requestId) {
        const prior = await productionCreatedBy(store.dir, requestId).catch(() => null);
        if (prior) return { status: "created", slug: prior };
      }
      const slug = await createProduction(store, input);
      await committed();
      return { status: "created", slug };
    } catch (error) {
      return { status: "failed", error };
    } finally {
      if (requestId) this.running.delete(requestId);
    }
  }
}

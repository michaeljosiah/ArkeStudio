import type { HarnessAdapter, SessionConfigInput } from "@arke-studio/contracts";

/**
 * Every roster entry uses the same admission check, including the small helpers that do not
 * pass through production chat. An open session keeps its captured model; a new session must
 * revalidate a saved override after a harness switch.
 */
export function withModelValidation(
  adapter: HarnessAdapter,
  validate: (reference: string, needsImages: boolean, signal?: AbortSignal) => Promise<{ reason?: string }>,
): HarnessAdapter {
  const preparations = new Map<string, SessionConfigInput>();
  const overrides: Partial<HarnessAdapter> = {
    prepareSession(input) {
      if (input.preparationId !== undefined && preparations.has(input.preparationId)) {
        throw new Error("Session preparation token is already in use.");
      }
      const captured = structuredClone(input);
      adapter.prepareSession?.(captured);
      if (captured.preparationId !== undefined) preparations.set(captured.preparationId, captured);
    },
    abandonSessionPreparation(id) {
      preparations.delete(id);
      adapter.abandonSessionPreparation?.(id);
    },
    async createSession(input) {
      const config = input.preparationId !== undefined ? preparations.get(input.preparationId) : undefined;
      if (input.preparationId !== undefined) {
        if (!config) throw new Error("Session preparation is missing or was already consumed.");
        // Claim before the asynchronous catalog check: a second create cannot use the same
        // token while the first is still waiting, or clean up the first one's preparation.
        preparations.delete(input.preparationId);
      }
      try {
        input.signal?.throwIfAborted();
        const model = config?.model ?? config?.agents?.[input.agent ?? "sheet-editor"]?.model;
        if (model !== undefined) {
          // The creation's own signal reaches the check (issue 1247): the catalogue it reads
          // may be discovery still under way, and a stopped creation must not wait it out.
          const result = await validate(model, input.agent === "stage-designer", input.signal);
          input.signal?.throwIfAborted();
          if (result.reason) throw new Error(result.reason);
        }
        return await adapter.createSession(input);
      } finally {
        // Failed validation never reaches the adapter's create/consume step. Retiring both
        // copies prevents a retry from borrowing the unvalidated underlying settings.
        if (input.preparationId !== undefined) adapter.abandonSessionPreparation?.(input.preparationId);
      }
    },
    async dispose() {
      preparations.clear();
      await adapter.dispose?.();
    },
  };
  return new Proxy(adapter, { get(target, key) {
    const override = Reflect.get(overrides, key);
    if (override !== undefined) return override;
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

import { createHash } from "node:crypto";
import type { EngineAction, EngineContext, EngineOperationStore, EnginePolicy, EngineResource } from "./contracts.js";

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export function engineHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function requireContext(context: EngineContext): void {
  if (!context || [context.actorId, context.scopeId, context.executorId, context.subjectId]
    .some(value => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("A trusted actor, scope, executor and subject are required.");
  }
}
export class EngineOperationUncertainError extends Error {
  constructor(readonly operationKey: string) {
    super("This operation has an uncertain outcome. Reconcile its durable record before trying again.");
    this.name = "EngineOperationUncertainError";
  }
}

/** Durable uniqueness belongs to the supplied store; this map only joins live calls. */
export class EngineOperations {
  private readonly active = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private stopping = false;
  constructor(readonly store: EngineOperationStore, readonly policy: EnginePolicy) {}

  key(context: EngineContext, resource: EngineResource, operationId: string): string {
    requireContext(context);
    if (!operationId.trim() || !resource.worldId.trim()) throw new Error("World and operation IDs are required.");
    return engineHash([context.scopeId, context.actorId, resource.worldId, operationId]);
  }

  async run<T>(context: EngineContext, action: EngineAction, resource: EngineResource, operationId: string,
    input: unknown, execute: (key: string) => Promise<T>, uncertainCompletion?: (result: T) => T): Promise<T> {
    if (this.stopping) throw new Error("The engine is stopping.");
    const key = this.key(context, resource, operationId);
    // A completed operation is not a bearer token: revalidate before replaying its result.
    await this.policy.authorise(context, action, resource);
    if (this.stopping) throw new Error("The engine is stopping.");
    const fingerprint = engineHash({ action, resource, input, subjectId: context.subjectId });
    const running = this.active.get(key);
    if (running) {
      if (running.fingerprint !== fingerprint) throw new Error("Operation ID reused with different input.");
      return structuredClone(await running.promise) as T;
    }
    const promise = (async () => {
      const claimed = await this.store.begin({ key, fingerprint, context: structuredClone(context), resource, action, status: "started" });
      if (claimed.operation.fingerprint !== fingerprint) throw new Error("Operation ID reused with different input.");
      if (!claimed.inserted) {
        if (claimed.operation.status === "completed") return structuredClone(claimed.operation.result) as T;
        throw new EngineOperationUncertainError(key);
      }
      // Never infer that a rejected call had no side effect. The started row deliberately stays
      // visible if execution or completion fails, rather than silently running the operation again.
      const result = await execute(key);
      try { await this.store.complete(key, fingerprint, result); }
      catch (error) {
        // Only a service with independently durable evidence may supply an uncertain receipt.
        // The started operation remains unresolved; this is never permission to execute again.
        if (uncertainCompletion) return uncertainCompletion(result);
        throw error;
      }
      return result;
    })();
    this.active.set(key, { fingerprint, promise });
    try { return structuredClone(await promise); }
    finally { if (this.active.get(key)?.promise === promise) this.active.delete(key); }
  }

  async close(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.active.values()].map(value => value.promise));
    await this.store.drain();
  }
}

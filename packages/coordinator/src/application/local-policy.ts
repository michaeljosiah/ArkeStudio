import type { EngineContext, EnginePolicy } from "./contracts.js";

export const LOCAL_ENGINE_CONTEXT: Readonly<EngineContext> = Object.freeze({
  scopeId: "studio-local", actorId: "local-user", executorId: "studio", subjectId: "local-user",
});

/** Only trusted desktop/dev composition opts into the single-author policy. */
export function createLocalEnginePolicy(): EnginePolicy {
  return {
    async authorise(context) {
      if (context.scopeId !== LOCAL_ENGINE_CONTEXT.scopeId || context.actorId !== LOCAL_ENGINE_CONTEXT.actorId ||
        context.subjectId !== LOCAL_ENGINE_CONTEXT.subjectId || context.executorId !== LOCAL_ENGINE_CONTEXT.executorId) {
        throw new Error("The local engine policy only accepts the trusted Studio actor.");
      }
    },
    async project(_context, bundle) { return bundle; },
    async deliver() {},
    async reserve(_context, key) { return key; },
    async settle() {},
    async release() {},
  };
}

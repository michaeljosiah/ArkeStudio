import { randomUUID } from "node:crypto";
import { EventEmitter, on } from "node:events";
import type { HarnessAdapter, HarnessEvent, SendMessageInput, SessionConfigInput } from "@arke-studio/contracts";
import type { LocalGpu } from "../local-ai/gpu.js";

/** Cover every harness caller, including fire-and-watch turns outside the provider queue. */
export function withLocalGpu(adapter: HarnessAdapter, gpu: LocalGpu): HarnessAdapter {
  const prepared = new Map<string, SessionConfigInput>();
  const models = new Map<string, string | undefined>();
  const turns = new Map<string, { abort: AbortController; started: boolean }>();
  const closed = new AbortController();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let pumping = false;
  const publish = (event: HarnessEvent) => events.emit("event", event);
  const pump = () => {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try { for await (const event of adapter.streamEvents(closed.signal)) publish(event); }
      finally { pumping = false; }
    })().catch(() => {});
  };
  const send = async (input: SendMessageInput) => {
    if (closed.signal.aborted) throw new Error("The writing harness is stopping.");
    if (turns.has(input.sessionId)) throw new Error("This writing session already has a turn in progress.");
    const turn = { abort: new AbortController(), started: false };
    turns.set(input.sessionId, turn);
    let release: (() => void) | undefined;
    try {
      const model = models.get(input.sessionId);
      // v2 identifies its actual default. v1 can report several provider defaults, so reserve
      // conservatively when Ollama is among them; an explicit cloud choice never waits.
      const local = model !== undefined ? model.startsWith("ollama/") :
        (await adapter.listModels?.())?.some((row) => row.provider === "ollama" && row.isDefault) === true;
      const signal = AbortSignal.any([turn.abort.signal, closed.signal]);
      if (local) release = await gpu.acquire("Ollama", signal, (reason) => publish({
        type: "tool.activity", sessionId: input.sessionId, tool: "local-inference",
        summary: reason ?? "Writing with Ollama",
      }));
      signal.throwIfAborted();
      turn.started = true;
      return await adapter.sendMessage(input);
    } finally { release?.(); turns.delete(input.sessionId); }
  };
  const overrides: Partial<HarnessAdapter> = {
    prepareSession(input) {
      if (input.preparationId) prepared.set(input.preparationId, input);
      adapter.prepareSession?.(input);
    },
    abandonSessionPreparation(id) { prepared.delete(id); adapter.abandonSessionPreparation?.(id); },
    async createSession(input) {
      const config = input.preparationId ? prepared.get(input.preparationId) : undefined;
      const session = await adapter.createSession(input);
      models.set(session.sessionId, config?.model ?? (input.agent ? config?.agents?.[input.agent]?.model : undefined));
      if (input.preparationId) prepared.delete(input.preparationId);
      return session;
    },
    sendMessage: send,
    async dispatchAsync(input) {
      pump();
      const receipt = { sessionId: input.sessionId, correlationId: input.correlationId ?? randomUUID() };
      void send({ ...input, correlationId: receipt.correlationId }).catch((error) => publish({
        type: "session.error", sessionId: input.sessionId,
        message: error instanceof Error ? error.message : "Local writing could not start.",
      }));
      return receipt;
    },
    async interrupt(sessionId) {
      const turn = turns.get(sessionId);
      turn?.abort.abort(new Error("Writing cancelled."));
      if (!turn || turn.started) await adapter.interrupt?.(sessionId);
    },
    streamEvents(signal) {
      const combined = AbortSignal.any([...(signal ? [signal] : []), closed.signal]);
      const iterator = on(events, "event", { signal: combined });
      pump();
      return { async *[Symbol.asyncIterator]() {
        try { for await (const [event] of iterator) yield event as HarnessEvent; }
        catch (error) { if (!combined.aborted) throw error; }
      } };
    },
    async dispose() {
      closed.abort();
      await adapter.dispose?.();
      prepared.clear(); models.clear();
    },
  };
  // Preserve optional adapter capabilities and bind their private state to the real adapter.
  return new Proxy(adapter, { get(target, property) {
    const override = Reflect.get(overrides, property);
    if (override !== undefined) return override;
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

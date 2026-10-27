import { randomUUID } from "node:crypto";
import { EventEmitter, on } from "node:events";
import type { HarnessAdapter, HarnessEvent, ModelInfo, SendMessageInput, SessionConfigInput } from "@arke-studio/contracts";
import type { LocalGpu } from "../local-ai/gpu.js";

/**
 * Cover every harness caller, including fire-and-watch turns outside the provider queue.
 * `onLocalModel` hears each Ollama model a local turn names, so quitting can hand back what this
 * run loaded and leave another application's models alone (issue 1289).
 */
export function withLocalGpu(
  adapter: HarnessAdapter, gpu: LocalGpu, settled: () => void = () => {}, onLocalModel: (model: string) => void = () => {},
): HarnessAdapter {
  const prepared = new Map<string, SessionConfigInput>();
  const models = new Map<string, string | undefined>();
  const priorities = new Map<string, "normal" | "background">();
  const privateSessions = new Set<string>();
  const privateCompletion = new Map<string, Promise<void>>();
  const turns = new Map<string, { abort: AbortController; started: boolean; release?: () => void }>();
  const closed = new AbortController();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let pumping = false;
  const publish = (event: HarnessEvent) => {
    if ("sessionId" in event && event.sessionId && privateSessions.has(event.sessionId)) return;
    events.emit("event", event);
  };
  const pump = () => {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try { for await (const event of adapter.streamEvents(closed.signal)) publish(event); }
      finally { pumping = false; }
    })().catch(() => {});
  };
  const send = async (input: SendMessageInput, beforeDispatch?: () => void) => {
    if (closed.signal.aborted) throw new Error("The writing harness is stopping.");
    if (turns.has(input.sessionId)) throw new Error("This writing session already has a turn in progress.");
    const turn: { abort: AbortController; started: boolean; release?: () => void } = { abort: new AbortController(), started: false };
    turns.set(input.sessionId, turn);
    let confirmed = false;
    try {
      const model = models.get(input.sessionId);
      // Claude cannot dispatch to Ollama. Its SDK catalog starts a separate process, so
      // consulting it here would add discovery latency to every default-model message.
      const canUseOllama = adapter.id !== "claude";
      // A failed default lookup can still return a catalogue. When none is marked, an
      // available Ollama model may be the actual default; an explicit cloud choice never waits.
      let catalog: ModelInfo[] | undefined;
      try { catalog = canUseOllama && model === undefined ? await adapter.listModels?.() : undefined; }
      catch { /* Discovery is optional; an unknown catalogue must still allow the turn. */ }
      const hasDefault = catalog?.some((row) => row.isDefault) === true;
      const local = canUseOllama && (model !== undefined ? model.startsWith("ollama/") :
        catalog === undefined || catalog.some((row) => row.provider === "ollama" && (row.isDefault || !hasDefault)));
      const signal = AbortSignal.any([turn.abort.signal, closed.signal]);
      if (local) turn.release = await gpu.acquire("Ollama", signal, (reason) => publish({
        type: "tool.activity", sessionId: input.sessionId, tool: "local-inference",
        summary: reason ?? "Writing with Ollama",
      }), priorities.get(input.sessionId));
      signal.throwIfAborted();
      if (local && model !== undefined) onLocalModel(model.replace(/^ollama\//, ""));
      const dispatch = () => { signal.throwIfAborted(); beforeDispatch?.(); turn.started = true; };
      let receipt: Awaited<ReturnType<HarnessAdapter["sendMessage"]>> | undefined, failed = false, failure: unknown;
      try {
        if (adapter.sendMessageWithFence) receipt = await adapter.sendMessageWithFence(input, dispatch);
        else { dispatch(); receipt = await adapter.sendMessage(input); }
      } catch (error) { failed = true; failure = error; }
      // A private send can settle on an HTTP/stream error while inference continues. Its
      // native proof outlives the requester/observer; Stop and disposal are not that proof.
      if (privateSessions.has(input.sessionId) && turn.started) {
        await privateCompletion.get(input.sessionId)!;
        confirmed = true;
      }
      if (failed) throw failure;
      return receipt!;
    } finally {
      if (!privateSessions.has(input.sessionId) || !turn.started || confirmed) { turn.release?.(); turns.delete(input.sessionId); settled(); }
    }
  };
  const overrides: Partial<HarnessAdapter> = {
    prepareSession(input) {
      if (input.preparationId) prepared.set(input.preparationId, input);
      adapter.prepareSession?.(input);
    },
    abandonSessionPreparation(id) { prepared.delete(id); adapter.abandonSessionPreparation?.(id); },
    async createSession(input) {
      if (input.visibility === "private" && adapter.privateSessions !== true) throw new Error("The harness does not support private operational sessions.");
      const config = input.preparationId ? prepared.get(input.preparationId) : undefined;
      const session = await adapter.createSession(input);
      models.set(session.sessionId, config?.model ?? (input.agent ? config?.agents?.[input.agent]?.model : undefined));
      priorities.set(session.sessionId, config?.inferencePriority ?? "normal");
      if (input.visibility === "private") {
        if (!session.privateEvents || !session.privateTurnSettled) throw new Error("The private session has no native completion proof.");
        privateSessions.add(session.sessionId); privateCompletion.set(session.sessionId, session.privateTurnSettled);
      }
      if (input.preparationId) prepared.delete(input.preparationId);
      return session;
    },
    sendMessage: send,
    sendMessageWithFence: send,
    async dispatchAsync(input) {
      pump();
      const receipt = { sessionId: input.sessionId, correlationId: input.correlationId ?? randomUUID() };
      // A turn the adapter ended has already said why, as `session.ended` with its reason; this
      // error follows it rather than racing it, a turn later, so a listener that stops at the
      // first ending hears "over budget" and not only a message (issue 1265).
      void send({ ...input, correlationId: receipt.correlationId }).catch((error) => setImmediate(() => publish({
        type: "session.error", sessionId: input.sessionId,
        message: error instanceof Error ? error.message : "Local writing could not start.",
      })));
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
      prepared.clear(); models.clear(); priorities.clear();
      // Unknown turns still own their exact release capability after the adapter closes.
      // A writing child ending cannot prove an external model finished. Closed admission
      // prevents another turn entering this wrapper while its native proof remains pending.
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

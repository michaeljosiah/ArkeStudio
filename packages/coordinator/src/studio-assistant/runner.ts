import { mkdir, mkdtemp, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { agentPromptFor, ROSTER, findHarnessModel, harnessModelReference, STUDIO_ASSISTANT_LIMITS, type HarnessAdapter, type PrivateSessionRequest, type PrivateSessionTransport } from "@arke-studio/contracts";
import { createPreparedSession, scopeSessionInput, sessionTurnTimeoutMs, type SessionInput } from "../harness/session-files.js";
import { toExtendedLength } from "../world/paths.js";

export type StudioRole = "studio-assistant" | "diagnostic-specialist";
export interface StudioModelDisclosure { role: StudioRole; model: string; provider: string; local: boolean; destination: string; prompt: string; system?: string; outputTokenLimit?: number; customBrief?: string; variant?: string }
export interface StudioModelPort {
  busy(): boolean;
  subscribe?(listener: () => void): () => void;
  run(input: { role: StudioRole; model: string; prompt: string }, signal: AbortSignal,
    authorize: (disclosure: StudioModelDisclosure, signal: AbortSignal) => Promise<{ cloudApproved: boolean }>): Promise<string>;
  stop(): Promise<void>;
}
export interface StudioPrivateTransport {
  configuration: PrivateSessionTransport; identity: string; approve(): boolean; stop(): Promise<boolean>;
}
interface Active { control: AbortController; transport?: StudioPrivateTransport; listen?: AbortController; ownerStopped?: () => void; retire?: (signal: AbortSignal) => Promise<boolean>; retireFiles?: () => Promise<boolean>; finishing?: Promise<void>; dir?: string; sessionId?: string; work?: Promise<string>; confirmed: boolean; started: boolean; workFinished: boolean; failed?: boolean }

/** One explicit model call at a time. Native tools are denied by the operational roster;
 * structured delegation is handled by the coordinator, never a native subagent command.
 * A response error/interrupt acknowledgement is not proof of completed model work. */
export class HarnessStudioModelRunner implements StudioModelPort {
  private readonly lifetime = new AbortController();
  private readonly active = new Set<Active>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly deps: { adapter(): HarnessAdapter | null; sessionInput: SessionInput; scratch: string; timeoutMs?: number;
    /** Trusted host ownership/route attestation, never inferred from a provider/model name.
     * Qualified native adapters additionally bind their exact per-session route into approval. */
    destination(model: string, provider: string): { local: boolean; identity: string } | null;
    /** Trusted host composition only. This does not supply missing managed-origin proof. */
    privateTransport?(request: PrivateSessionRequest, signal: AbortSignal): Promise<StudioPrivateTransport> }) {}
  busy(): boolean { return this.active.size > 0; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { for (const listener of this.listeners) { try { listener(); } catch { /* Observation grants no inference authority. */ } } }

  async run(input: { role: StudioRole; model: string; prompt: string }, signal: AbortSignal,
    authorize: (disclosure: StudioModelDisclosure, signal: AbortSignal) => Promise<{ cloudApproved: boolean }>): Promise<string> {
    input = Object.freeze({ role: input.role, model: input.model, prompt: input.prompt });
    if (this.lifetime.signal.aborted || signal.aborted || this.busy()) throw new Error("Studio inference is stopped or still awaiting its previous owner.");
    if (!["studio-assistant", "diagnostic-specialist"].includes(input.role) || !input.model || input.model.length > 512 || Buffer.byteLength(input.prompt) > 192 * 1024) throw new Error("The Studio request exceeds its model input bound.");
    const entry: Active = { control: new AbortController(), confirmed: false, started: false, workFinished: false }; this.active.add(entry); this.changed();
    const combined = AbortSignal.any([signal, this.lifetime.signal, entry.control.signal]);
    let stop!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => { reject(new Error(entry.failed ? "The Studio model response could not be completed within its limits." : "Studio inference stopped. Submitted work was not replayed.")); };
      combined.addEventListener("abort", stop, { once: true }); if (combined.aborted) stop();
    });
    entry.work = this.execute(entry, input, combined, authorize);
    // Keep native work and its private config reachable after observation stops. An unknown
    // dispatch holds this runner until the actual owner confirms settlement or host shutdown.
    void entry.work.then(() => { entry.workFinished = true; return this.finish(entry); }, () => { entry.workFinished = true; if (!entry.started || entry.confirmed) void this.finish(entry); });
    timer = setTimeout(() => entry.control.abort(), this.deps.timeoutMs ?? sessionTurnTimeoutMs(input.model, 180_000));
    try { const text = await Promise.race([entry.work, stopped]); await Promise.race([this.finish(entry), stopped]); return text; }
    finally { clearTimeout(timer); combined.removeEventListener("abort", stop); }
  }

  private async execute(entry: Active, input: { role: StudioRole; model: string; prompt: string }, signal: AbortSignal,
    authorize: (disclosure: StudioModelDisclosure, signal: AbortSignal) => Promise<{ cloudApproved: boolean }>): Promise<string> {
    const adapter = this.deps.adapter();
    if (!adapter?.readiness().ready || !adapter.capabilities().has("events")) throw new Error("The Studio model is unavailable.");
    const revision = adapter.lifecycleRevision?.();
    if (!Number.isSafeInteger(revision) || revision === undefined || revision < 0) throw new Error("The Studio model owner has no verified generation fence.");
    if (adapter.privateSessions !== true) throw new Error("The Studio model owner does not support private operational sessions.");
    if (adapter.privateDestinations === true && !adapter.sendMessageWithFence) throw new Error("The Studio model owner has no native destination dispatch fence.");
    if (adapter.privateDestinations === true && adapter.privatePayloads !== true) throw new Error("The Studio native owner cannot seal the reviewed provider payload.");
    if (adapter.privateDestinations === true && adapter.privateTransient !== true) throw new Error("The Studio native owner has no qualified transient completion protocol.");
    const sameOwner = () => this.deps.adapter() === adapter && adapter.lifecycleRevision?.() === revision && adapter.readiness().ready;
    signal.throwIfAborted();
    const catalog = await adapter.listModels?.(); signal.throwIfAborted();
    const model = catalog && findHarnessModel(input.model, catalog);
    if (!model) throw new Error("Choose an available Studio model. No fallback model was used.");
    const reference = harnessModelReference(model);
    if (reference.length > 512 || model.provider.length > 128) throw new Error("The Studio model identity exceeds its bound.");
    const destination = this.deps.destination(reference, model.provider);
    if (!destination || typeof destination.local !== "boolean" || !/^[a-f0-9]{64}$/.test(destination.identity)) throw new Error("The Studio model destination could not be verified.");
    const sameDestination = () => { const current = this.deps.destination(reference, model.provider); return current?.identity === destination.identity && current.local === destination.local; };
    const config = scopeSessionInput({ ...await this.deps.sessionInput({ agent: input.role, model: reference }), agent: input.role, model: reference });
    signal.throwIfAborted();
    const customBrief = config.agents?.[input.role]?.brief;
    if (customBrief && customBrief.length > 16_000) throw new Error("The Studio role instructions exceed their bound.");
    if (config.modelVariant && config.modelVariant.length > 512) throw new Error("The Studio model variant exceeds its bound.");
    if (config.modelVariant && config.modelVariant !== "default") throw new Error("The Studio provider payload for this effort has not been qualified.");
    const member = ROSTER.find(value => value.name === input.role)!;
    const system = agentPromptFor({ ...member, researchWeb: false, ...(customBrief !== undefined ? { brief: customBrief } : {}) });
    if (Buffer.byteLength(system) > 32 * 1024) throw new Error("The Studio system instructions exceed their bound.");
    const privateRequest = Object.freeze({ model: reference, system, prompt: input.prompt, outputTokenLimit: 4096 });
    if (this.deps.privateTransport) {
      if (adapter.privateDestinations !== true) throw new Error("The native owner cannot verify a private bridge route.");
      const route = await this.deps.privateTransport(privateRequest, signal);
      entry.transport = Object.freeze({ configuration: Object.freeze({ ...route.configuration }), identity: route.identity,
        approve: route.approve.bind(route), stop: route.stop.bind(route) });
      if (!/^[a-f0-9]{64}$/.test(entry.transport.identity)) throw new Error("The private transport identity is invalid.");
      signal.throwIfAborted();
    }
    const approve = async (route: { local: boolean; identity: string }) => {
      const destinationIdentity = entry.transport ? createHash("sha256").update(JSON.stringify([route.identity, entry.transport.identity])).digest("hex") : route.identity;
      const approval = await authorize({ role: input.role, model: reference, provider: model.provider, local: route.local, destination: destinationIdentity, prompt: input.prompt,
        system, outputTokenLimit: privateRequest.outputTokenLimit,
        ...(customBrief !== undefined ? { customBrief } : {}), ...(config.modelVariant ? { variant: config.modelVariant } : {}) }, signal);
      signal.throwIfAborted();
      if (!route.local && !approval.cloudApproved) throw new Error("Cloud explanation requires explicit approval of this payload.");
      if (!sameOwner() || !sameDestination()) throw new Error("The selected Studio model owner changed before dispatch.");
      if (entry.transport && !entry.transport.approve()) throw new Error("The selected Studio transport changed before dispatch.");
    };
    // Synthetic host ports retain their original contract. Qualified native owners must
    // create an unsent private session before approval can name its actual scoped route.
    if (adapter.privateDestinations !== true) await approve(destination);
    if (!sameOwner() || !sameDestination()) throw new Error("The selected Studio model owner changed before dispatch.");
    await mkdir(toExtendedLength(this.deps.scratch), { recursive: true });
    entry.dir = await mkdtemp(join(this.deps.scratch, "turn-"));
    const session = await createPreparedSession(adapter, entry.dir, config, { purpose: "ask", agent: input.role, visibility: "private", privateRequest,
      ...(entry.transport ? { privateTransport: entry.transport.configuration } : {}) }, undefined, signal,
      retire => { entry.retireFiles = retire; });
    entry.sessionId = session.sessionId;
    entry.retire = session.privateRetire?.bind(session);
    entry.retireFiles = session.retirePrivateFiles;
    if (adapter.privateDestinations === true && !entry.retire) throw new Error("The Studio native owner has no verified session retirement capability.");
    if (!session.privateEvents) throw new Error("The Studio model owner did not return a private session observer.");
    if (!session.privateTurnSettled) throw new Error("The Studio model owner did not return a native completion proof.");
    entry.ownerStopped = session.privateOwnerStopped?.bind(session);
    signal.throwIfAborted(); if (!sameOwner() || !sameDestination()) throw new Error("The selected Studio model owner changed before dispatch.");
    if (adapter.privateDestinations === true) {
      if (!session.privateDestination) throw new Error("The Studio model owner did not return native destination proof.");
      const native = await session.privateDestination(signal);
      signal.throwIfAborted();
      if (!native || native.model !== reference || native.provider !== model.provider || typeof native.local !== "boolean" || !/^[a-f0-9]{64}$/.test(native.identity)) throw new Error("The Studio native model destination could not be verified.");
      if (!sameOwner() || !sameDestination()) throw new Error("The selected Studio model owner changed before approval.");
      // Neither a host-local claim nor native loopback metadata may override the other's
      // nonlocal verdict. The one-use disclosure binds both independent identities.
      await approve({ local: destination.local && native.local,
        identity: createHash("sha256").update(JSON.stringify([destination.identity, destination.local, native.identity, native.local])).digest("hex") });
      if (!sameOwner() || !sameDestination()) throw new Error("The selected Studio model owner changed before dispatch.");
    }
    const listen = entry.listen = new AbortController(); let completed = false;
    const interrupt = () => { if (sameOwner()) void adapter.interrupt?.(session.sessionId).catch(() => {}); };
    signal.addEventListener("abort", interrupt, { once: true }); if (signal.aborted) interrupt();
    const answer = (async () => {
      for await (const event of session.privateEvents!(listen.signal)) {
        if (!("sessionId" in event) || event.sessionId !== session.sessionId) continue;
        if (event.type === "message.completed") {
          completed = true;
          if (Buffer.byteLength(event.text) > STUDIO_ASSISTANT_LIMITS.responseBytes) throw new Error("The Studio model response exceeds its bound.");
          return event.text;
        }
        if (event.type === "session.error" || event.type === "session.ended") throw new Error("The Studio model did not return a completed response.");
      }
      throw new Error("The Studio model response is unavailable.");
    })();
    void answer.catch(() => {});
    try {
      const dispatch = () => {
        signal.throwIfAborted(); if (!sameOwner() || !sameDestination()) throw new Error("The Studio model owner changed.");
        entry.started = true;
      };
      // sendMessage's completion and a final response are both required. No resend or retry.
      const message = { sessionId: session.sessionId, correlationId: session.sessionId, parts: [{ type: "text" as const, text: input.prompt }] };
      const sent = adapter.sendMessageWithFence ? adapter.sendMessageWithFence(message, dispatch) : (dispatch(), adapter.sendMessage(message));
      // Keep ownership after the visible observer ends on an error. A late native completion
      // plus settled send retires the original owner without publishing/replaying its reply.
      void Promise.all([session.privateTurnSettled, sent.then(() => {}, () => {})]).then(() => {
        entry.confirmed = true; if (entry.workFinished) void this.finish(entry);
      }, () => {});
      try {
        const text = await Promise.race([answer, sent.then(() => answer)]);
        await sent; await session.privateTurnSettled; entry.confirmed = true;
        signal.throwIfAborted(); return text;
      } catch {
        entry.failed = true; entry.control.abort();
        // A bounded-response refusal is still a known completion if its owner settles.
        // A failed send without that final response remains unknown and held.
        if (completed) await Promise.all([sent.then(() => {}, () => {}), session.privateTurnSettled]).then(() => { entry.confirmed = true; }, () => {});
        throw new Error("The Studio model response could not be completed within its limits.");
      }
    } finally {
      // An error may arrive after a final response, but it still needs the owner's settlement.
      if (!completed && signal.aborted) interrupt();
      signal.removeEventListener("abort", interrupt); listen.abort();
    }
  }
  private async finish(entry: Active): Promise<void> {
    if (!this.active.has(entry)) return;
    if (entry.finishing) return entry.finishing;
    entry.listen?.abort();
    const work = async () => {
      if (entry.retire) {
        try { if (!await entry.retire(AbortSignal.timeout(5_000))) return; }
        catch { return; } // Unknown retirement retains one reachable owner/config, never a replay.
      }
      if (entry.transport) {
        try { if (!await entry.transport.stop()) return; }
        catch { return; }
      }
      if (entry.dir) {
      if (entry.retireFiles && !await entry.retireFiles()) return;
      // Exact captured preparation bytes, then an empty UUID directory. Unknown/changed
      // contents remain; there is no generic scratch/creative cleanup or recursive deletion.
      await rmdir(toExtendedLength(entry.dir)).catch(() => {});
      }
      this.active.delete(entry); this.changed();
    };
    entry.finishing = work().finally(() => { entry.finishing = undefined; }); return entry.finishing;
  }
  /** Trusted housekeeping only: retry known-complete/unsent native retirement, never inference. */
  async reconcileRetirement(): Promise<void> { for (const entry of this.active) if (entry.workFinished && (!entry.started || entry.confirmed)) await this.finish(entry); }
  async stop(): Promise<void> {
    this.lifetime.abort(); for (const entry of this.active) entry.control.abort();
    await Promise.allSettled([...this.active].map(entry => entry.transport?.stop()));
  }
  /** Trusted confirmation that both the exact backing inference and its writing owner have
   * completed native cleanup/no further dispatch. A writer exit or Stop reply is insufficient.
   * Never a model/renderer tool; callers must retain the matched native cleanup authority. */
  async ownerStopped(): Promise<void> { for (const entry of this.active) { entry.control.abort(); entry.ownerStopped?.(); await this.finish(entry); } }
}

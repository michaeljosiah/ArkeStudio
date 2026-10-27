import { mkdir, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { findHarnessModel, harnessModelReference, STUDIO_ASSISTANT_LIMITS, type HarnessAdapter } from "@arke-studio/contracts";
import { createPreparedSession, scopeSessionInput, sessionTurnTimeoutMs, type SessionInput } from "../harness/session-files.js";
import { toExtendedLength } from "../world/paths.js";

export type StudioRole = "studio-assistant" | "diagnostic-specialist";
export interface StudioModelDisclosure { role: StudioRole; model: string; provider: string; local: boolean; destination: string; prompt: string; customBrief?: string; variant?: string }
export interface StudioModelPort {
  busy(): boolean;
  run(input: { role: StudioRole; model: string; prompt: string }, signal: AbortSignal,
    authorize: (disclosure: StudioModelDisclosure, signal: AbortSignal) => Promise<{ cloudApproved: boolean }>): Promise<string>;
  stop(): Promise<void>;
}
interface Active { control: AbortController; dir?: string; sessionId?: string; work?: Promise<string>; confirmed: boolean; started: boolean }

/** One explicit model call at a time. Native tools are denied by the operational roster;
 * structured delegation is handled by the coordinator, never a native subagent command.
 * A response error/interrupt acknowledgement is not proof of completed model work. */
export class HarnessStudioModelRunner implements StudioModelPort {
  private readonly lifetime = new AbortController();
  private readonly active = new Set<Active>();
  constructor(private readonly deps: { adapter(): HarnessAdapter | null; sessionInput: SessionInput; scratch: string; timeoutMs?: number;
    /** Actual host-owned route identity/locality, never inferred from a provider/model name. */
    destination(model: string, provider: string): { local: boolean; identity: string } | null }) {}
  busy(): boolean { return this.active.size > 0; }

  async run(input: { role: StudioRole; model: string; prompt: string }, signal: AbortSignal,
    authorize: (disclosure: StudioModelDisclosure, signal: AbortSignal) => Promise<{ cloudApproved: boolean }>): Promise<string> {
    if (this.lifetime.signal.aborted || signal.aborted || this.busy()) throw new Error("Studio inference is stopped or still awaiting its previous owner.");
    if (!["studio-assistant", "diagnostic-specialist"].includes(input.role) || !input.model || input.model.length > 512 || Buffer.byteLength(input.prompt) > 192 * 1024) throw new Error("The Studio request exceeds its model input bound.");
    const entry: Active = { control: new AbortController(), confirmed: false, started: false }; this.active.add(entry);
    const combined = AbortSignal.any([signal, this.lifetime.signal, entry.control.signal]);
    let stop!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => { reject(new Error("Studio inference stopped. Submitted work was not replayed.")); };
      combined.addEventListener("abort", stop, { once: true }); if (combined.aborted) stop();
    });
    entry.work = this.execute(entry, input, combined, authorize);
    // Keep native work and its private config reachable after observation stops. An unknown
    // dispatch holds this runner until the actual owner confirms settlement or host shutdown.
    void entry.work.then(() => this.finish(entry), () => { if (!entry.started || entry.confirmed) void this.finish(entry); });
    timer = setTimeout(() => entry.control.abort(), this.deps.timeoutMs ?? sessionTurnTimeoutMs(input.model, 180_000));
    try { return await Promise.race([entry.work, stopped]); }
    finally { clearTimeout(timer); combined.removeEventListener("abort", stop); }
  }

  private async execute(entry: Active, input: { role: StudioRole; model: string; prompt: string }, signal: AbortSignal,
    authorize: (disclosure: StudioModelDisclosure, signal: AbortSignal) => Promise<{ cloudApproved: boolean }>): Promise<string> {
    const adapter = this.deps.adapter();
    if (!adapter?.readiness().ready || !adapter.capabilities().has("events")) throw new Error("The Studio model is unavailable.");
    const revision = adapter.lifecycleRevision?.();
    if (!Number.isSafeInteger(revision) || revision === undefined || revision < 0) throw new Error("The Studio model owner has no verified generation fence.");
    if (adapter.privateSessions !== true) throw new Error("The Studio model owner does not support private operational sessions.");
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
    const approval = await authorize({ role: input.role, model: reference, provider: model.provider, local: destination.local, destination: destination.identity, prompt: input.prompt,
      ...(customBrief !== undefined ? { customBrief } : {}), ...(config.modelVariant ? { variant: config.modelVariant } : {}) }, signal);
    signal.throwIfAborted();
    if (!destination.local && !approval.cloudApproved) throw new Error("Cloud explanation requires explicit approval of this payload.");
    if (!sameOwner() || !sameDestination()) throw new Error("The selected Studio model owner changed before dispatch.");
    await mkdir(toExtendedLength(this.deps.scratch), { recursive: true });
    entry.dir = await mkdtemp(join(this.deps.scratch, "turn-"));
    const session = await createPreparedSession(adapter, entry.dir, config, { purpose: "ask", agent: input.role, visibility: "private" }, undefined, signal);
    entry.sessionId = session.sessionId;
    if (!session.privateEvents) throw new Error("The Studio model owner did not return a private session observer.");
    signal.throwIfAborted(); if (!sameOwner() || !sameDestination()) throw new Error("The selected Studio model owner changed before dispatch.");
    const listen = new AbortController(); let completed = false;
    const interrupt = () => { void adapter.interrupt?.(session.sessionId).catch(() => {}); };
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
      try {
        const text = await Promise.race([answer, sent.then(() => answer)]);
        await sent; entry.confirmed = true;
        signal.throwIfAborted(); return text;
      } catch {
        // A bounded-response refusal is still a known completion if its owner settles.
        // A failed send without that final response remains unknown and held.
        if (completed) await sent.then(() => { entry.confirmed = true; }, () => {});
        throw new Error("The Studio model response could not be completed within its limits.");
      }
    } finally {
      // An error may arrive after a final response, but it still needs the owner's settlement.
      if (!completed && signal.aborted) interrupt();
      signal.removeEventListener("abort", interrupt); listen.abort();
    }
  }
  private async finish(entry: Active): Promise<void> {
    this.active.delete(entry);
    if (entry.dir) {
      // Only the known adapter config and then an empty UUID directory. Unknown contents
      // remain; there is no generic scratch/creative cleanup or recursive deletion.
      await unlink(toExtendedLength(join(entry.dir, "opencode.json"))).catch(() => {});
      await rmdir(toExtendedLength(entry.dir)).catch(() => {});
    }
  }
  async stop(): Promise<void> { this.lifetime.abort(); for (const entry of this.active) entry.control.abort(); }
  /** Trusted lifecycle-owner confirmation only, after its actual stop/cleanup. Never a tool. */
  async ownerStopped(): Promise<void> { for (const entry of this.active) { entry.control.abort(); await this.finish(entry); } }
}

import { randomBytes } from "node:crypto";
import { RECOVERY_ACTION_LIMITS, RECOVERY_POLICY, RecoveryRetryPlanSchema,
  type RecoveryActionCommand, type RecoveryActionResult, type RecoveryRetryPlan } from "@arke-studio/contracts";
import type { PreparedSupervisorRetry } from "../supervisor.js";

interface Target { service: RecoveryRetryPlan["service"]; prepare(): PreparedSupervisorRetry | null }
interface Preview { plan: RecoveryRetryPlan; target: Target; prepared: PreparedSupervisorRetry }
/** Typed review broker over the existing supervisor executor. Volatile plans are not durable
 * execution authority: the original owner still flushes its exact intent before a spawn. */
export class RecoveryActionRegistry {
  private readonly targets = new Map<string, Target>();
  private readonly previews = new Map<string, Preview>();
  private readonly closed = new AbortController();
  private active: { plan: RecoveryRetryPlan; control: AbortController } | null = null;
  constructor(private readonly deps: { now(): number; publish(result: RecoveryActionResult): void }) {}
  register(key: string, target: Target): void {
    if (this.closed.signal.aborted) return;
    if (!/^[a-f0-9]{64}$/.test(key) || !this.targets.has(key) && this.targets.size >= RECOVERY_POLICY.maxTargets) throw new Error("Recovery target unavailable.");
    this.targets.set(key, target);
  }
  availability(): { key: string; service: RecoveryRetryPlan["service"]; retryAvailable: boolean }[] {
    return [...this.targets].map(([key, target]) => {
      let prepared: PreparedSupervisorRetry | null = null;
      try { prepared = target.prepare(); } catch { /* Unknown target state is unavailable. */ }
      return { key, service: target.service, retryAvailable: !this.closed.signal.aborted && !this.active && prepared !== null && prepared.offer.key === key && prepared.offer.service === target.service && this.current(prepared) };
    });
  }
  private publish(result: RecoveryActionResult): void { if (!this.closed.signal.aborted) { try { this.deps.publish(result); } catch { /* Presentation cannot grant or reverse authority. */ } } }
  private current(prepared: PreparedSupervisorRetry): boolean { try { return prepared.current(); } catch { return false; } }
  invalidateReviews(): void { this.previews.clear(); }
  async handle(message: RecoveryActionCommand): Promise<void> {
    const reply = (value: Omit<RecoveryActionResult, "requestId">) => this.publish({ requestId: message.requestId, ...value });
    if (this.closed.signal.aborted) return;
    const now = this.deps.now();
    if (!Number.isSafeInteger(now) || now < 0) { reply({ status: "refused", reason: "unavailable" }); return; }
    for (const [id, preview] of this.previews) if (now >= preview.plan.expiresAt || now < preview.plan.preparedAt) this.previews.delete(id);
    const command = message.command;
    if (command.action === "cancel") {
      this.previews.delete(command.planId);
      if (this.active?.plan.id === command.planId) this.active.control.abort();
      reply({ status: "cancelled" }); return;
    }
    if (this.active) { reply({ status: "refused", reason: "busy" }); return; }
    if (command.action === "preview-retry") {
      const target = this.targets.get(command.resourceKey);
      let prepared: PreparedSupervisorRetry | null = null;
      try { prepared = target?.prepare() ?? null; } catch { /* No raw native errors reach presentation. */ }
      if (!target || !prepared || prepared.offer.key !== command.resourceKey || prepared.offer.service !== target.service || !this.current(prepared)) { reply({ status: "refused", reason: "unavailable" }); return; }
      if (this.previews.size >= RECOVERY_ACTION_LIMITS.previews) { reply({ status: "refused", reason: "busy" }); return; }
      const parsed = RecoveryRetryPlanSchema.safeParse({ id: randomBytes(32).toString("hex"), action: "retry-managed-runtime", resourceKey: command.resourceKey,
        service: prepared.offer.service, evidence: prepared.offer.evidence, policyRevision: prepared.offer.policyRevision,
        preparedAt: now, expiresAt: now + RECOVERY_ACTION_LIMITS.previewMs, downloadBytes: 0, diskBytes: null, interruptsWork: false, replaysJobs: false });
      if (!parsed.success) { reply({ status: "refused", reason: "unavailable" }); return; }
      const plan = Object.freeze(parsed.data);
      this.previews.set(plan.id, { plan, target, prepared }); reply({ status: "preview", plan }); return;
    }
    const preview = this.previews.get(command.planId); this.previews.delete(command.planId);
    if (!preview || this.targets.get(preview.plan.resourceKey) !== preview.target || !this.current(preview.prepared)) { reply({ status: "refused", reason: "stale" }); return; }
    const { plan, prepared } = preview, control = new AbortController();
    this.active = { plan, control }; reply({ status: "accepted", plan });
    const timer = setTimeout(() => control.abort(), plan.expiresAt - now);
    try {
      const signal = AbortSignal.any([control.signal, this.closed.signal]);
      const result = await prepared.run(signal, () => {
        const at = this.deps.now();
        return !signal.aborted && Number.isSafeInteger(at) && at >= plan.preparedAt && at < plan.expiresAt;
      });
      reply({ status: result === "ready" ? "verified" : result, plan,
        ...(result === "refused" ? { reason: control.signal.aborted ? this.deps.now() >= plan.expiresAt ? "stale" as const : "cancelled" as const : "stale" as const } : {}) });
    } catch { reply({ status: "unknown", plan }); }
    finally { clearTimeout(timer); if (this.active?.plan === plan) this.active = null; }
  }
  closeAdmission(): void { this.closed.abort(); this.previews.clear(); this.active?.control.abort(); this.targets.clear(); }
}

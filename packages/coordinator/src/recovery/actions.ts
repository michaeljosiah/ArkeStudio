import { randomBytes } from "node:crypto";
import { CACHE_CLEANUP_POLICY, RECOVERY_ACTION_LIMITS, RECOVERY_POLICY, RecoveryRetryPlanSchema, RecoveryCachePlanSchema,
  type RecoveryActionCommand, type RecoveryActionResult, type RecoveryRetryPlan } from "@arke-studio/contracts";
import type { PreparedSupervisorRetry } from "../supervisor.js";
import type { PreparedPreviewCleanup } from "../storage/local-preview-cache.js";

interface Target { service: RecoveryRetryPlan["service"]; prepare(): PreparedSupervisorRetry | null }
interface Preview { plan: RecoveryRetryPlan; target: Target; prepared: PreparedSupervisorRetry }
type CleanupAvailability = NonNullable<import("@arke-studio/contracts").RecoveryPolicySnapshot["cleanup"]>;
interface CleanupTarget { available(): CleanupAvailability; prepare(signal: AbortSignal, scope?: string): Promise<PreparedPreviewCleanup | null>;
  reconcile?(signal: AbortSignal): Promise<import("@arke-studio/contracts").RecoveryCacheReconciliation>;
  setMaintenance?(enabled: boolean): Promise<boolean>; revokeMaintenance?(): void; maintenanceReady?(): boolean;
  runMaintenance?(planId: string, signal: AbortSignal, allowed: () => boolean): Promise<void> }
/** Typed review broker over the existing supervisor executor. Volatile plans are not durable
 * execution authority: the original owner still flushes its exact intent before a spawn. */
export class RecoveryActionRegistry {
  private readonly targets = new Map<string, Target>();
  private readonly previews = new Map<string, Preview>();
  private readonly closed = new AbortController();
  private active: { plan: { id: string }; control: AbortController } | null = null;
  private cleanupTarget: CleanupTarget | null = null;
  private readonly cleanupPreviews = new Map<string, { plan: import("@arke-studio/contracts").RecoveryCachePlan; prepared: PreparedPreviewCleanup; target: CleanupTarget }>();
  private preparing = false;
  private revision = 0;
  constructor(private readonly deps: { now(): number; publish(result: RecoveryActionResult): void; automaticAllowed?: () => boolean; maintenanceSettled?: () => void }) {}
  register(key: string, target: Target): void {
    if (this.closed.signal.aborted) return;
    if (!/^[a-f0-9]{64}$/.test(key) || !this.targets.has(key) && this.targets.size >= RECOVERY_POLICY.maxTargets) throw new Error("Recovery target unavailable.");
    this.targets.set(key, target);
  }
  registerCleanup(target: CleanupTarget): void { if (!this.closed.signal.aborted) { this.cleanupTarget = target; this.invalidateReviews(); } }
  cleanupAvailability(): CleanupAvailability {
    const state = this.cleanupTarget?.available() ?? { available: false, pending: false };
    return { ...state, available: state.available && !this.closed.signal.aborted && !this.active && !this.preparing };
  }
  availability(): { key: string; service: RecoveryRetryPlan["service"]; retryAvailable: boolean }[] {
    return [...this.targets].map(([key, target]) => {
      let prepared: PreparedSupervisorRetry | null = null;
      try { prepared = target.prepare(); } catch { /* Unknown target state is unavailable. */ }
      return { key, service: target.service, retryAvailable: !this.closed.signal.aborted && !this.active && !this.preparing && prepared !== null && prepared.offer.key === key && prepared.offer.service === target.service && this.current(prepared) };
    });
  }
  private publish(result: RecoveryActionResult): void { if (!this.closed.signal.aborted) { try { this.deps.publish(result); } catch { /* Presentation cannot grant or reverse authority. */ } } }
  private current(prepared: PreparedSupervisorRetry): boolean { try { return prepared.current(); } catch { return false; } }
  invalidateReviews(): void { this.revision++; this.previews.clear(); this.cleanupPreviews.clear(); }
  private automaticAllowed(): boolean { try { return !this.closed.signal.aborted && this.deps.automaticAllowed?.() === true; } catch { return false; } }
  async maintainCleanup(): Promise<void> {
    const target = this.cleanupTarget, at = this.deps.now();
    if (!Number.isSafeInteger(at) || at < 0 || this.active || this.preparing || !this.automaticAllowed() || !target?.runMaintenance || !target.maintenanceReady?.()) return;
    const plan = { id: randomBytes(32).toString("hex") }, control = new AbortController(); this.active = { plan, control };
    const signal = AbortSignal.any([control.signal, this.closed.signal]), timer = setTimeout(() => control.abort(), RECOVERY_ACTION_LIMITS.previewMs);
    try { await target.runMaintenance(plan.id, signal, () => !signal.aborted && this.cleanupTarget === target && this.automaticAllowed()); }
    catch { /* The existing cache owner retains uncertain native/audit authority; never replay it. */ }
    finally {
      clearTimeout(timer); if (this.active?.plan === plan) this.active = null;
      if (!this.closed.signal.aborted) try { this.deps.maintenanceSettled?.(); } catch { /* Presentation does not grant cleanup authority. */ }
    }
  }
  async handle(message: RecoveryActionCommand): Promise<void> {
    const reply = (value: Omit<RecoveryActionResult, "requestId">) => this.publish({ requestId: message.requestId, ...value });
    if (this.closed.signal.aborted) return;
    const command = message.command;
    if (command.action === "set-cleanup-maintenance" && !command.enabled) this.cleanupTarget?.revokeMaintenance?.();
    const now = this.deps.now();
    if (!Number.isSafeInteger(now) || now < 0) { reply({ status: "refused", reason: "unavailable" }); return; }
    for (const [id, preview] of this.previews) if (now >= preview.plan.expiresAt || now < preview.plan.preparedAt) this.previews.delete(id);
    for (const [id, preview] of this.cleanupPreviews) if (now >= preview.plan.expiresAt || now < preview.plan.preparedAt) this.cleanupPreviews.delete(id);
    if (command.action === "cancel") {
      this.previews.delete(command.planId);
      this.cleanupPreviews.delete(command.planId);
      if (this.active?.plan.id === command.planId) this.active.control.abort();
      reply({ status: "cancelled" }); return;
    }
    if (command.action === "set-cleanup-maintenance") {
      const target = this.cleanupTarget;
      if (!target?.setMaintenance || command.enabled && (this.active || this.preparing)) { reply({ status: "refused", reason: "busy" }); return; }
      if (command.enabled) this.preparing = true;
      try {
        const saved = await target.setMaintenance(command.enabled); this.invalidateReviews();
        reply(saved ? { status: "verified", maintenanceSaved: command.enabled } : { status: "refused", reason: "unavailable" });
      } catch { reply({ status: "unknown" }); }
      finally { if (command.enabled) this.preparing = false; }
      return;
    }
    if (this.active || this.preparing) { reply({ status: "refused", reason: "busy" }); return; }
    if (command.action === "reconcile-cleanup") {
      const target = this.cleanupTarget;
      if (!target?.reconcile || !target.available().pending) { reply({ status: "refused", reason: "unavailable" }); return; }
      const plan = { id: randomBytes(32).toString("hex") }, control = new AbortController(); this.active = { plan, control };
      const timer = setTimeout(() => control.abort(), 30_000); reply({ status: "accepted" });
      try {
        const reconciliation = await target.reconcile(AbortSignal.any([control.signal, this.closed.signal]));
        reply({ status: reconciliation.outcome === "unconfirmed" ? "unknown" : "verified", reconciliation });
      } catch { reply({ status: "unknown", reconciliation: { outcome: "unconfirmed", availableBytes: null } }); }
      finally { clearTimeout(timer); if (this.active?.plan === plan) this.active = null; }
      return;
    }
    if (command.action === "preview-cleanup") {
      const target = this.cleanupTarget, revision = this.revision;
      if (!target?.available().available || this.previews.size + this.cleanupPreviews.size >= RECOVERY_ACTION_LIMITS.previews) { reply({ status: "refused", reason: "unavailable" }); return; }
      this.preparing = true;
      try {
        const prepared = await target.prepare(this.closed.signal, command.scope), at = this.deps.now();
        if (!prepared || this.revision !== revision || this.cleanupTarget !== target || !target.available().available || at < now || at >= now + RECOVERY_ACTION_LIMITS.previewMs) { reply({ status: "refused", reason: "unavailable" }); return; }
        const plan = Object.freeze(RecoveryCachePlanSchema.parse({ id: randomBytes(32).toString("hex"), action: "cleanup-local-preset-previews", evidence: prepared.evidence,
          policyRevision: 1, preparedAt: now, expiresAt: now + RECOVERY_ACTION_LIMITS.previewMs, category: "fixed-local-preset-previews",
          files: prepared.files, targets: prepared.targets, logicalBytes: prepared.logicalBytes, allocatedBytes: prepared.allocatedBytes, minAgeMs: CACHE_CLEANUP_POLICY.minAgeMs,
          stopAtAvailableBytes: prepared.stopAtAvailableBytes, ...(command.scope ? { scope: command.scope } : {}), replaysJobs: false, interruptsWork: false, undoable: false }));
        this.cleanupPreviews.set(plan.id, { plan, prepared, target }); reply({ status: "preview", cleanupPlan: plan });
      } catch { reply({ status: "refused", reason: "unavailable" }); }
      finally { this.preparing = false; }
      return;
    }
    if (command.action === "approve-cleanup") {
      const preview = this.cleanupPreviews.get(command.planId); this.cleanupPreviews.delete(command.planId);
      if (!preview || preview.target !== this.cleanupTarget || !preview.target.available().available) { reply({ status: "refused", reason: "stale" }); return; }
      const { plan, prepared } = preview, control = new AbortController(); this.active = { plan, control };
      reply({ status: "accepted", cleanupPlan: plan }); const timer = setTimeout(() => control.abort(), plan.expiresAt - now);
      try {
        const signal = AbortSignal.any([control.signal, this.closed.signal]);
        const result = await prepared.run(plan.id, signal, () => {
          const at = this.deps.now(); return !signal.aborted && at >= plan.preparedAt && at < plan.expiresAt && this.cleanupTarget === preview.target;
        });
        reply({ status: result.status, cleanupPlan: plan, cleanup: result.cleanup, ...(result.status === "refused" ? { reason: "stale" as const } : {}) });
      } catch { reply({ status: "unknown", cleanupPlan: plan }); }
      finally { clearTimeout(timer); if (this.active?.plan === plan) this.active = null; }
      return;
    }
    if (command.action === "preview-retry") {
      const target = this.targets.get(command.resourceKey);
      let prepared: PreparedSupervisorRetry | null = null;
      try { prepared = target?.prepare() ?? null; } catch { /* No raw native errors reach presentation. */ }
      if (!target || !prepared || prepared.offer.key !== command.resourceKey || prepared.offer.service !== target.service || !this.current(prepared)) { reply({ status: "refused", reason: "unavailable" }); return; }
      if (this.previews.size + this.cleanupPreviews.size >= RECOVERY_ACTION_LIMITS.previews) { reply({ status: "refused", reason: "busy" }); return; }
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
  closeAdmission(): void { this.closed.abort(); this.invalidateReviews(); this.active?.control.abort(); this.targets.clear(); this.cleanupTarget = null; }
}

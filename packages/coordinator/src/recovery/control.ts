import { randomBytes } from "node:crypto";
import { z } from "zod";
import { RecoveryControlSchema, RecoveryRestartContextSchema, RECOVERY_POLICY, decideRecoveryRestart, emptyRecoveryTarget, recentRecoveryAttempts,
  type RecoveryControl, type RecoveryMode, type RecoveryTarget, type RecoveryRestartContext, type RecoveryHoldReason } from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";
import type { RecoveryControlStore } from "./control-file.js";

type Intent = NonNullable<RecoveryTarget["intent"]>;
type Hold = { status: "held"; reason: RecoveryHoldReason };
type AuditFailure = "invalid" | "permission" | "disk-full" | "read-failed" | "write-failed";
export type RecoveryAuthorization = Hold | { status: "authorized"; intent: Intent };

/** Durable restart gate for lifecycle owners (SPEC-061 R-11/R-25).
 * Only lifecycle owners call it, under their existing fence. It never spawns, kills, retries a
 * job or infers readiness itself. A renderer/model request is not an owner verification. */
export class RecoveryControlService {
  private control: RecoveryControl = { version: 1, policyRevision: 1, mode: "automatic", targets: [] };
  private readonly writes = new WriteQueue();
  private opened = false;
  private auditAvailable = true;
  private auditFailure: AuditFailure | undefined;
  private closing = false;
  private closed = false;

  constructor(private readonly deps: { store: RecoveryControlStore; now?: () => number; onChange?: () => void }) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    let value!: T; return this.writes.enqueue(async () => { value = await action(); }).then(() => value);
  }
  private changed(): void { if (!this.closing) try { this.deps.onChange?.(); } catch { /* Presentation cannot grant mutation. */ } }
  snapshot(): { audit: "starting" | "available" | "unavailable"; reason?: AuditFailure; control: RecoveryControl } {
    return { audit: !this.opened ? "starting" : this.auditAvailable ? "available" : "unavailable", reason: this.auditFailure, control: structuredClone(this.control) };
  }
  private failure(error: unknown, fallback: "read-failed" | "write-failed"): AuditFailure {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return "invalid";
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    return code === "ENOSPC" || code === "EDQUOT" ? "disk-full" : code === "EACCES" || code === "EPERM" ? "permission" : fallback;
  }
  open(): Promise<void> {
    return this.serial(async () => {
      if (this.opened || this.closing) return;
      try {
        this.control = RecoveryControlSchema.parse(await this.deps.store.load());
        for (const target of this.control.targets) {
          if (target.intent) target.intent.phase = "unknown";
          target.healthySince = null; // Downtime is not continuous measured health.
        }
      } catch (error) { this.auditAvailable = false; this.auditFailure = this.failure(error, "read-failed"); }
      this.opened = true; this.changed();
    });
  }
  private ready(): Hold | null {
    return this.closing ? { status: "held", reason: "stopped" } : !this.opened || !this.auditAvailable ? { status: "held", reason: "audit-unavailable" } : null;
  }
  private async persist(next: RecoveryControl): Promise<boolean> {
    try {
      await this.deps.store.save(RecoveryControlSchema.parse(next)); this.control = next; this.changed(); return true;
    } catch (error) {
      // A rejected replacement may nevertheless be on disk. Keep both possible intents held;
      // disable further mutations instead of retrying an append or inventing a clean budget.
      const retained = new Map(this.control.targets.map(target => [target.key, target]));
      for (const target of next.targets) {
        const previous = retained.get(target.key);
        retained.set(target.key, { ...target, intent: target.intent ?? previous?.intent ?? null });
      }
      for (const target of retained.values()) if (target.intent) target.intent = { ...target.intent, phase: "unknown" };
      this.control = { ...next, targets: [...retained.values()] }; this.auditAvailable = false; this.auditFailure = this.failure(error, "write-failed"); this.changed(); return false;
    }
  }

  /** Persists a single-use intent and spends an automatic attempt before a child can start.
   * The caller must later call begin under the same lifecycle owner, then report its outcome. */
  authorize(input: { key: string; service: RecoveryTarget["service"]; context: RecoveryRestartContext; automatic: boolean }): Promise<RecoveryAuthorization> {
    const context = RecoveryRestartContextSchema.parse(input.context);
    return this.serial(async () => {
      const held = this.ready(); if (held) return held;
      const now = this.now(), next = structuredClone(this.control);
      let target = next.targets.find(value => value.key === input.key);
      if (target && target.service !== input.service) return { status: "held", reason: "target-changed" };
      if (!target) {
        if (next.targets.length >= RECOVERY_POLICY.maxTargets) return { status: "held", reason: "target-limit" };
        target = emptyRecoveryTarget(input.key, input.service, now); next.targets.push(target);
      }
      const decision = decideRecoveryRestart({ target, context, mode: next.mode, automatic: input.automatic, now });
      if (!decision.allowed) {
        if (decision.reason === "circuit-open" && !target.circuitOpen) {
          target.circuitOpen = true; target.lastObservedAt = now;
          if (!await this.persist(next)) return { status: "held", reason: "audit-unavailable" };
        }
        return { status: "held", reason: decision.reason };
      }
      target.lastObservedAt = now; target.healthySince = null;
      if (input.automatic) {
        target.attempts = [...recentRecoveryAttempts(target, now), now];
        target.consecutiveFailures = Math.min(3, target.consecutiveFailures + 1);
      } else target.stoppedByUser = false; // An explicit owner-authorized retry; never a notification click.
      target.intent = { id: randomBytes(32).toString("hex"), action: "restart-managed-runtime", generation: context.generation,
        componentDigest: context.componentDigest, automatic: input.automatic, authorizedAt: now, notBefore: now + decision.delayMs, phase: "intended" };
      if (!await this.persist(next)) return { status: "held", reason: "audit-unavailable" };
      if (this.closing) return { status: "held", reason: "stopped" };
      return { status: "authorized", intent: structuredClone(target.intent) };
    });
  }

  /** Final check under the owning service's idle/epoch fence. The owner holds that fence until
   * it synchronously initiates the action; this method creates no competing executor. */
  begin(key: string, intentId: string, current: () => RecoveryRestartContext): Promise<Hold | { status: "begin" }> {
    return this.serial(async () => {
      const held = this.ready(); if (held) return held;
      const target = this.control.targets.find(value => value.key === key), intent = target?.intent;
      if (!target || intent?.id !== intentId || intent.phase !== "intended") return { status: "held", reason: "pending-outcome" };
      const check = (): RecoveryHoldReason | null => {
        if (this.closing) return "stopped";
        const now = this.now();
        if (now < target.lastObservedAt) return "clock-reversed";
        if (now < intent.notBefore) return "too-early";
        if (target.stoppedByUser) return "user-stopped";
        if (intent.automatic && this.control.mode !== "automatic") return "suggest-only";
        let context: RecoveryRestartContext;
        try { context = RecoveryRestartContextSchema.parse(current()); } catch { return "target-changed"; }
        if (context.generation !== intent.generation || context.componentDigest !== intent.componentDigest) return "target-changed";
        if (context.ownership !== "managed") return "external";
        if (!context.exitConfirmed) return "cleanup-unconfirmed";
        return context.idle ? null : "busy";
      };
      const before = check(); if (before) return { status: "held", reason: before };
      const next = structuredClone(this.control), record = next.targets.find(value => value.key === key)!;
      record.intent!.phase = "executing"; record.lastObservedAt = this.now();
      if (!await this.persist(next)) return { status: "held", reason: "audit-unavailable" };
      const after = check(); if (after) return { status: "held", reason: after };
      return { status: "begin" };
    });
  }

  /** Trusted owner confirms settled cleanup/current readiness or retains an unknown outcome.
   * This is intentionally absent from renderer commands and diagnostic-assistant tools. */
  settleFromOwner(key: string, intentId: string, outcome: "verified" | "failed" | "not-started" | "unknown"): Promise<boolean> {
    return this.serial(async () => {
      if (this.closed || !this.opened || !this.auditAvailable) return false;
      const next = structuredClone(this.control), target = next.targets.find(value => value.key === key);
      if (!target?.intent || target.intent.id !== intentId) return false;
      const now = this.now(); if (now < target.lastObservedAt) return false;
      target.lastObservedAt = now;
      if (outcome === "unknown") target.intent.phase = "unknown";
      else {
        const automatic = target.intent.automatic;
        target.intent = null; target.healthySince = outcome === "verified" ? now : null;
        if (outcome === "verified" && !automatic) target.circuitOpen = false;
        if (outcome === "failed" && recentRecoveryAttempts(target, now).length >= 3) target.circuitOpen = true;
      }
      return this.persist(next);
    });
  }

  setMode(mode: RecoveryMode): Promise<boolean> {
    return this.serial(async () => { if (this.ready()) return false; return this.persist({ ...structuredClone(this.control), mode }); });
  }
  setStoppedByUser(identity: Pick<RecoveryTarget, "key" | "service">, stopped: boolean): Promise<boolean> {
    return this.serial(async () => {
      if (this.ready()) return false;
      const next = structuredClone(this.control);
      let target = next.targets.find(value => value.key === identity.key);
      if (target && target.service !== identity.service) return false;
      if (!target) {
        if (next.targets.length >= RECOVERY_POLICY.maxTargets) return false;
        target = emptyRecoveryTarget(identity.key, identity.service, this.now()); next.targets.push(target);
      }
      target.stoppedByUser = stopped; return this.persist(next);
    });
  }
  noteHealth(key: string, healthy: boolean): Promise<boolean> {
    return this.serial(async () => {
      if (this.ready()) return false;
      const next = structuredClone(this.control), target = next.targets.find(value => value.key === key), now = this.now();
      if (!target || target.intent || now < target.lastObservedAt) return false;
      target.healthySince = healthy ? target.healthySince ?? now : null; target.lastObservedAt = now;
      if (!target.circuitOpen && target.healthySince !== null && now - target.healthySince >= RECOVERY_POLICY.healthyResetMs) target.consecutiveFailures = 0;
      return this.persist(next);
    });
  }
  closeAdmission(): void { this.closing = true; }
  async stop(): Promise<void> { this.closed = true; this.closeAdmission(); await this.writes.drain(); }
}

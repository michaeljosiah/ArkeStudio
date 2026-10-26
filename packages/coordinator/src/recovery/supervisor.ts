import { decideRecoveryRestart, emptyRecoveryTarget, type RecoveryHoldReason, type RecoveryTarget } from "@arke-studio/contracts";
import type { SupervisorRecoveryPort } from "../supervisor.js";
import type { RecoveryControlService } from "./control.js";

const HOLD: Record<RecoveryHoldReason, string> = {
  "suggest-only": "Suggest only is enabled.", "user-stopped": "You stopped this service.", external: "The selected service is owned outside Arke.",
  busy: "Admitted work is still using this service.", "cleanup-unconfirmed": "Process cleanup has not been confirmed.",
  "pending-outcome": "An earlier recovery is waiting for verification.", "circuit-open": "The restart limit was reached. Review before retrying.",
  "clock-reversed": "The system clock moved backwards. Retry timing is unknown.", stopped: "Recovery is stopping.",
  "audit-unavailable": "Recovery status could not be saved or read.", "target-limit": "The recovery target limit was reached.",
  "target-changed": "The selected service changed.", "too-early": "The restart delay has not elapsed.",
};

/** Bridges the existing supervisor to durable admission. Native startup remains inside that
 * supervisor, and its owner supplies the same inference-lane lease used by ordinary work.
 * The retained lease stays reachable after unconfirmed cleanup until the owner confirms exit. */
export class SupervisorRecovery implements SupervisorRecoveryPort {
  private retained: { release(): void; intentId: string } | null = null;
  constructor(private readonly deps: {
    control: RecoveryControlService; identity: Pick<RecoveryTarget, "key" | "service">;
    /** Current immutable configuration identity; no I/O, paths never leave the owning host. */
    componentDigest(): string; current(): boolean; ownership(): "managed" | "external";
    acquire(signal: AbortSignal): Promise<() => void>;
    now?: () => number;
  }) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }

  async allowStart(signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (signal.aborted || !this.deps.current()) return { ok: false, reason: HOLD.stopped };
    // This gate owns managed restart authority. A deliberate personal-path selection may
    // perform ordinary startup without resetting or inheriting the managed role's circuit.
    if (this.deps.ownership() !== "managed") return { ok: true };
    await this.deps.control.open();
    if (signal.aborted || !this.deps.current()) return { ok: false, reason: HOLD.stopped };
    const snapshot = this.deps.control.snapshot();
    if (snapshot.audit !== "available") return { ok: false, reason: HOLD["audit-unavailable"] };
    if (!snapshot.accepting) return { ok: false, reason: HOLD.stopped };
    const target = snapshot.control.targets.find(value => value.key === this.deps.identity.key);
    const reason = target?.intent ? "pending-outcome" : target?.stoppedByUser ? "user-stopped" : target?.circuitOpen ? "circuit-open" : null;
    return reason ? { ok: false, reason: HOLD[reason] } : { ok: true };
  }

  async recover(work: Parameters<SupervisorRecoveryPort["recover"]>[0]): Promise<void> {
    if (!work.current() || work.signal.aborted || !this.deps.current()) return;
    if (this.deps.ownership() !== "managed") { work.held(HOLD.external); return; }
    if (this.retained) { work.held(HOLD["cleanup-unconfirmed"]); return; }
    await this.deps.control.open();
    const state = this.deps.control.snapshot();
    if (!state.accepting) { work.held(state.audit === "available" ? HOLD.stopped : HOLD["audit-unavailable"]); return; }
    const target = state.control.targets.find(value => value.key === this.deps.identity.key) ?? emptyRecoveryTarget(this.deps.identity.key, this.deps.identity.service, this.now());
    const preflight = decideRecoveryRestart({ target, mode: state.control.mode, automatic: true, now: this.now(), context: {
      ownership: this.deps.ownership(), idle: true, exitConfirmed: work.exitConfirmed(), generation: work.generation, componentDigest: this.deps.componentDigest(),
    } });
    if (!preflight.allowed) {
      if (preflight.reason === "circuit-open") await this.deps.control.markCircuitOpen(this.deps.identity);
      work.held(HOLD[preflight.reason]); return;
    }
    let release: (() => void) | null = null, intentId: string | null = null, safe = true;
    try {
      release = await this.deps.acquire(work.signal);
      if (!work.current() || work.signal.aborted || !this.deps.current()) return;
      const context = () => ({ ownership: this.deps.ownership(), idle: !work.signal.aborted && this.deps.current(),
        exitConfirmed: work.exitConfirmed(), generation: work.generation, componentDigest: this.deps.componentDigest() });
      const grant = await this.deps.control.authorize({ ...this.deps.identity, context: context(), automatic: true });
      if (grant.status !== "authorized") {
        // A flush may finish after shutdown closed admission. No authority was granted, but
        // this owner still knows the saved intent never started and must settle it on drain.
        if (grant.intent) {
          intentId = grant.intent.id;
          await this.deps.control.settleFromOwner(this.deps.identity.key, intentId, "not-started");
        }
        work.held(HOLD[grant.reason]); return;
      }
      intentId = grant.intent.id;
      await work.sleep(Math.max(0, grant.intent.notBefore - this.now()));
      if (!work.current() || work.signal.aborted || !this.deps.current()) {
        await this.deps.control.settleFromOwner(this.deps.identity.key, intentId, "not-started"); return;
      }
      const begin = await this.deps.control.begin(this.deps.identity.key, intentId, context);
      if (begin.status !== "begin") {
        // Nothing was spawned; the owner has direct knowledge of this path even if the
        // flushed phase already says executing. A rejected control write stays unavailable.
        await this.deps.control.settleFromOwner(this.deps.identity.key, intentId, "not-started");
        work.held(HOLD[begin.reason]); return;
      }
      const canSpawn = () => {
        const state = this.deps.control.snapshot(), target = state.control.targets.find(value => value.key === this.deps.identity.key);
        return !work.signal.aborted && this.deps.current() && this.deps.ownership() === "managed" &&
          this.deps.componentDigest() === grant.intent.componentDigest && state.accepting && state.control.mode === "automatic" &&
          target?.stoppedByUser === false && target.intent?.id === intentId && target.intent.phase === "executing";
      };
      safe = false;
      const outcome = await work.restart(canSpawn);
      safe = outcome !== "unknown";
      await this.deps.control.settleFromOwner(this.deps.identity.key, intentId, outcome === "ready" ? "verified" : safe ? "failed" : "unknown");
    } catch {
      if (intentId) await this.deps.control.settleFromOwner(this.deps.identity.key, intentId, safe ? "not-started" : "unknown");
      if (work.current() && !work.signal.aborted) work.held(safe ? "Recovery could not acquire its work reservation." : HOLD["cleanup-unconfirmed"]);
    } finally {
      if (release) {
        if (safe) release();
        else if (intentId) this.retained = { release, intentId };
      }
    }
  }

  // A health failure needs a reviewed stop/restart plan before it may kill a still-running
  // process. Unexpected-exit recovery above starts only after its owner confirmed cleanup.
  mayStopForFailedHealth(): boolean { return false; }
  async budgetExhausted(): Promise<void> { await this.deps.control.markCircuitOpen(this.deps.identity); }
  async ownerStopped(): Promise<void> {
    const held = this.retained; this.retained = null;
    if (held) {
      await this.deps.control.settleFromOwner(this.deps.identity.key, held.intentId, "failed");
      held.release();
    }
  }
}

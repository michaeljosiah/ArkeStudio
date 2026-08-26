import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  vendorAuthUnavailable,
  type HarnessAdapter,
  type VendorAuthStatus,
  type VendorCarry,
  type VendorIntegration,
  type VendorOAuthAttempt,
  type VendorSignIn,
} from "@arke-studio/contracts";
import type { AppLog } from "../app-log.js";

/**
 * Vendor sign-in through the harness (SPEC-030 §2.2, §3.1). The harness owns every exchange
 * and every credential; this service asks it to begin, opens the vendor's page, polls the
 * attempt (nothing announces completion — R-9b), and publishes the whole surface after every
 * change. Arke's part is deliberately small: no listener, no code catching, no token — the
 * one-time code of a `code`-mode attempt and a typed API key pass through and are registered
 * for log redaction on the way (R-1).
 *
 * Carrying an existing sign-in (§2.3) does not engage on the measured build: it keeps
 * credentials inside its database rather than the stable line's credential file, so there is
 * no file whose identity a link could share without carrying every other piece of state
 * across the isolation boundary too (R-3). That is R-4's case — the person signs in through
 * Arke instead, and the limitation is stated once, only to somebody who actually has personal
 * harness state to carry.
 */

export interface VendorAuthServiceOptions {
  /** Lazy: the adapter is assembled by the host and can be absent or replaced. */
  adapter: () => HarnessAdapter | null;
  /** Host port for the vendor's page. Never a renderer concern — the URL stays out of state. */
  openExternal: (url: string) => void;
  onChange: (status: VendorAuthStatus) => void;
  /** Register pass-through secrets (typed keys, one-time codes) for log redaction. */
  registerSecret?: (value: string) => void;
  log?: AppLog | null;
  /** Test seams. */
  pollIntervalMs?: number;
  personalStateDir?: string;
  now?: () => number;
}

interface InFlight {
  vendor: string;
  methodLabel: string;
  attempt: VendorOAuthAttempt | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Poll faults in a row; a run of them is a stated failure, one is a blip. */
  consecutivePollErrors: number;
}

const POLL_INTERVAL_MS = 2_000;
/** Give the harness a beat past its own deadline before calling the wait over. */
const EXPIRY_GRACE_MS = 15_000;
const POLL_ERROR_LIMIT = 5;

/** Where the person's own harness state lives, for the carry statement only — never read. */
function defaultPersonalStateDir(): string {
  return join(homedir(), ".local", "share", "opencode");
}

export class VendorAuthService {
  private available = false;
  private reason: string | null = "the harness has not started";
  private vendors: VendorIntegration[] = [];
  private signIn: VendorSignIn | null = null;
  private inFlight: InFlight | null = null;
  private readonly needsSignIn = new Set<string>();
  private carry: VendorCarry = "none";
  private carryDetail: string | null = null;
  private refreshing: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly opts: VendorAuthServiceOptions) {}

  current(): VendorAuthStatus {
    return {
      available: this.available,
      reason: this.reason,
      carry: this.carry,
      carryDetail: this.carryDetail,
      vendors: this.vendors,
      signIn: this.signIn,
    };
  }

  private publish(): void {
    this.opts.onChange(this.current());
  }

  private adapterWithAuth(): HarnessAdapter | null {
    const adapter = this.opts.adapter();
    if (!adapter || !adapter.capabilities().has("auth")) return null;
    return adapter;
  }

  /**
   * Re-read the surface from the harness. `patient` waits out the catalog's asynchronous
   * population after spawn (~5s measured) — used by the harness-ready seed, not by a screen
   * asking where things stand right now.
   */
  async refresh(opts: { patient?: boolean } = {}): Promise<void> {
    // Serialized against itself: two refreshes interleaving would publish out of order.
    while (this.refreshing) await this.refreshing.catch(() => {});
    const run = this.refreshNow(opts.patient === true);
    this.refreshing = run;
    try {
      await run;
    } finally {
      this.refreshing = null;
    }
  }

  private async refreshNow(patient: boolean): Promise<void> {
    const adapter = this.adapterWithAuth();
    if (!adapter || !adapter.listIntegrations) {
      const unavailable = vendorAuthUnavailable("this harness cannot sign in to a vendor from here");
      this.available = unavailable.available;
      this.reason = unavailable.reason;
      this.vendors = [];
      this.publish();
      return;
    }
    try {
      let listed = await adapter.listIntegrations();
      // The catalog populates a few seconds after spawn; an empty answer from a healthy
      // server usually means "not yet", so the seed path waits it out, bounded.
      for (let tries = 0; patient && listed.length === 0 && tries < 5 && !this.stopped; tries++) {
        await sleep(3_000);
        listed = await adapter.listIntegrations();
      }
      this.available = true;
      this.reason = null;
      this.vendors = this.surfaceOf(listed);
      this.updateCarry();
    } catch (err) {
      // The capability exists but the call failed: the surface stays, the fault is stated.
      this.available = true;
      this.reason = messageOf(err);
    }
    this.publish();
  }

  /**
   * The surface is the vendors a person can subscribe-sign-in to, plus any vendor that
   * already holds a stored connection (so it can be seen and removed). Key-only vendors are
   * Settings › Providers work — offering 200 rows of them here would bury the feature this
   * screen exists for. The filter is by method KIND, never by vendor name: no list of
   * vendors lives in Arke (R-7, D12).
   */
  private surfaceOf(listed: VendorIntegration[]): VendorIntegration[] {
    const surfaced = listed.filter(
      (vendor) =>
        vendor.methods.some((m) => m.kind === "oauth") || vendor.connections.some((c) => c.kind === "stored"),
    );
    const connected = (v: VendorIntegration) => v.connections.some((c) => c.kind === "stored");
    surfaced.sort((a, b) => {
      if (connected(a) !== connected(b)) return connected(a) ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return surfaced.map((vendor) => ({ ...vendor, needsSignIn: this.needsSignIn.has(vendor.id) }));
  }

  /**
   * R-4's statement, made only to somebody with personal harness state on the machine: the
   * measured build keeps credentials in its database, so an existing sign-in cannot be
   * shared by link and a fresh one here is the way through. Presence is checked, contents
   * never read.
   */
  private updateCarry(): void {
    const dir = this.opts.personalStateDir ?? defaultPersonalStateDir();
    const hasPersonalState = existsSync(join(dir, "auth.json")) || existsSync(join(dir, "opencode.db"));
    if (hasPersonalState) {
      this.carry = "unavailable";
      this.carryDetail = "sign-ins from your own installation stay there on this version — connect here separately";
    } else {
      this.carry = "none";
      this.carryDetail = null;
    }
  }

  /**
   * Begin an OAuth sign-in: ask the harness, open the vendor's page, show the instructions
   * verbatim, poll until the attempt settles (§2.2). One at a time — a new begin replaces a
   * stale one, cancelling its attempt so nothing is left pending on the harness.
   */
  async beginOAuth(vendor: string, methodId: string, answers?: Record<string, string>): Promise<void> {
    const adapter = this.adapterWithAuth();
    if (!adapter?.beginVendorOAuth) return;
    this.abandonStale();
    const methodLabel =
      this.vendors.find((v) => v.id === vendor)?.methods.find((m) => m.id === methodId)?.label ?? methodId;
    // Published before the first await, so the screen moves the instant the button is pressed.
    const flight: InFlight = { vendor, methodLabel, attempt: null, timer: null, consecutivePollErrors: 0 };
    this.inFlight = flight;
    this.setSignIn({ vendor, method: methodLabel, phase: "waiting", instructions: null, codeEntry: false, detail: null });
    try {
      const attempt = await adapter.beginVendorOAuth(vendor, methodId, answers);
      if (this.inFlight !== flight) {
        // Replaced or cancelled while beginning. The cancel could not release an attempt whose
        // id did not exist yet, so the release happens here, on arrival.
        void this.releaseAttempt(vendor, attempt.attemptId);
        return;
      }
      flight.attempt = attempt;
      this.setSignIn({
        vendor,
        method: methodLabel,
        phase: "waiting",
        instructions: attempt.instructions.length > 0 ? attempt.instructions : null,
        codeEntry: attempt.mode === "code",
        detail: null,
      });
      if (attempt.url.startsWith("https://")) this.opts.openExternal(attempt.url);
      void this.opts.log?.append({ kind: "vendor.sign-in-begun", vendor, method: methodId });
      this.schedulePoll();
    } catch (err) {
      // A rejection from a superseded request must not fail the sign-in that replaced it.
      if (this.inFlight === flight) this.failSignIn(messageOf(err));
    }
  }

  /** The typed-secret method: one call, one outcome, nothing retained (§2.2, R-1). */
  async submitKey(vendor: string, key: string, answers?: Record<string, string>): Promise<void> {
    const adapter = this.adapterWithAuth();
    if (!adapter?.connectVendorKey) return;
    this.abandonStale();
    this.opts.registerSecret?.(key);
    const methodLabel =
      this.vendors.find((v) => v.id === vendor)?.methods.find((m) => m.kind === "key")?.label ?? "API key";
    const flight: InFlight = { vendor, methodLabel, attempt: null, timer: null, consecutivePollErrors: 0 };
    this.inFlight = flight;
    this.setSignIn({ vendor, method: methodLabel, phase: "waiting", instructions: null, codeEntry: false, detail: null });
    try {
      await adapter.connectVendorKey(vendor, key, answers);
      if (this.inFlight !== flight) return;
      void this.opts.log?.append({ kind: "vendor.key-connected", vendor });
      await this.settleSuccess(vendor);
    } catch (err) {
      if (this.inFlight === flight) this.failSignIn(messageOf(err));
    }
  }

  /** Hand back the code a `code`-mode attempt gave the person. Passed through, not retained. */
  async submitCode(code: string): Promise<void> {
    const adapter = this.adapterWithAuth();
    const flight = this.inFlight;
    if (!adapter?.completeVendorOAuth || !flight?.attempt || this.signIn?.codeEntry !== true) return;
    this.opts.registerSecret?.(code);
    try {
      await adapter.completeVendorOAuth(flight.vendor, flight.attempt.attemptId, code);
      // The poll confirms from what it observes rather than from this call (R-9b) — but ask
      // now instead of waiting out the interval.
      if (this.inFlight === flight) await this.pollOnce();
    } catch (err) {
      // A rejection from a superseded completion must not fail the flow that replaced it.
      if (this.inFlight === flight) this.failSignIn(messageOf(err));
    }
  }

  /** Stop waiting on a sign-in the person has abandoned. Leaves no partial state (R-9b). */
  async cancel(): Promise<void> {
    const flight = this.inFlight;
    this.clearInFlight();
    this.setSignIn(null);
    if (flight?.attempt) await this.releaseAttempt(flight.vendor, flight.attempt.attemptId);
  }

  /**
   * Remove a connection — the harness's operation, never a file deletion (R-9a, D16). The
   * screen says what removal reaches before asking; by the time this runs, it was said.
   */
  async remove(vendor: string, credentialId: string): Promise<void> {
    const adapter = this.adapterWithAuth();
    if (!adapter?.removeVendorCredential) return;
    let refusal: string | null = null;
    try {
      await adapter.removeVendorCredential(credentialId);
      this.needsSignIn.delete(vendor);
      void this.opts.log?.append({ kind: "vendor.connection-removed", vendor });
    } catch (err) {
      refusal = messageOf(err);
    }
    await this.refresh();
    if (refusal !== null) {
      // Re-applied AFTER the refresh, which clears `reason` on success — otherwise the refused
      // sign-out would leave the connection sitting there with no word of why.
      this.reason = refusal;
      this.publish();
    }
  }

  /**
   * A turn failed because a token could not be refreshed (R-13). Mark the connection where
   * it can be named; where it cannot, state the fault on the surface rather than guessing.
   *
   * `providerHint` is the provider the failed session actually ran on, where the caller can
   * name it — an agent's model override routes past the harness default, and marking the
   * default's vendor for an override's failure would send the person to re-authenticate a
   * connection that was never the problem.
   */
  async noteAuthFailure(providerHint?: string | null): Promise<void> {
    const adapter = this.adapterWithAuth();
    const credentialed = this.vendors.filter((v) => v.connections.some((c) => c.kind === "stored"));
    let target: string | null =
      providerHint != null && credentialed.some((v) => v.id === providerHint) ? providerHint : null;
    // Without a hint, the turn ran on the default model; its provider names the vendor.
    if (target === null && adapter?.listModels) {
      try {
        const models = await adapter.listModels();
        target = models.find((m) => m.isDefault === true)?.provider ?? null;
      } catch {
        /* the mark falls back below */
      }
    }
    if (target === null || !credentialed.some((v) => v.id === target)) {
      target = credentialed.length === 1 ? credentialed[0]!.id : null;
    }
    if (target !== null) {
      this.needsSignIn.add(target);
      this.vendors = this.vendors.map((v) => (v.id === target ? { ...v, needsSignIn: true } : v));
    } else {
      this.reason = "a vendor sign-in has stopped working — check the connections below";
    }
    void this.opts.log?.append({ kind: "vendor.needs-sign-in", vendor: target });
    this.publish();
  }

  /** Coordinator shutdown: stop timers. The harness's own attempt expires on its own. */
  stop(): void {
    this.stopped = true;
    if (this.inFlight?.timer) clearTimeout(this.inFlight.timer);
  }

  // ---- the poll (R-9b: bounded, observed, nothing evented) -----------------

  private schedulePoll(): void {
    const flight = this.inFlight;
    if (!flight || this.stopped) return;
    const timer = setTimeout(() => void this.pollOnce(), this.opts.pollIntervalMs ?? POLL_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
    flight.timer = timer;
  }

  private async pollOnce(): Promise<void> {
    const adapter = this.adapterWithAuth();
    const flight = this.inFlight;
    if (!adapter?.pollVendorOAuth || !flight?.attempt || this.stopped) return;
    if (flight.timer) clearTimeout(flight.timer);
    const now = this.opts.now?.() ?? Date.now();
    if (now > flight.attempt.expiresAt + EXPIRY_GRACE_MS) {
      // The measured build reports a taken callback port as pending forever, so the bounded
      // wait is where that failure gets its stated reason (R-9c).
      this.failSignIn("the sign-in did not complete in time — the other methods still work");
      return;
    }
    try {
      const state = await adapter.pollVendorOAuth(flight.vendor, flight.attempt.attemptId);
      // Replaced, cancelled, or shutting down while polling: a late answer starts nothing —
      // shutdown especially, where a settle would dial a harness being torn down.
      if (this.inFlight !== flight || this.stopped) return;
      flight.consecutivePollErrors = 0;
      if (state.status === "complete") {
        await this.settleSuccess(flight.vendor);
        return;
      }
      if (state.status === "failed") {
        this.failSignIn(state.message);
        return;
      }
      if (state.status === "expired") {
        this.failSignIn("the sign-in did not complete in time — the other methods still work");
        return;
      }
      this.schedulePoll();
    } catch (err) {
      if (this.inFlight !== flight || this.stopped) return;
      flight.consecutivePollErrors += 1;
      if (flight.consecutivePollErrors >= POLL_ERROR_LIMIT) {
        this.failSignIn(messageOf(err));
        return;
      }
      this.schedulePoll();
    }
  }

  private async settleSuccess(vendor: string): Promise<void> {
    this.needsSignIn.delete(vendor);
    this.clearInFlight();
    this.setSignIn(null);
    void this.opts.log?.append({ kind: "vendor.signed-in", vendor });
    await this.refresh();
  }

  private failSignIn(detail: string): void {
    const flight = this.inFlight;
    this.clearInFlight();
    // A wait that gave up locally can leave the harness's side still pending — the bind-blocked
    // attempt is exactly that shape — so the attempt is released here, not only on cancel.
    if (flight?.attempt) void this.releaseAttempt(flight.vendor, flight.attempt.attemptId);
    if (flight) {
      this.setSignIn({
        vendor: flight.vendor,
        method: flight.methodLabel,
        phase: "failed",
        instructions: null,
        codeEntry: false,
        detail,
      });
    }
  }

  private setSignIn(signIn: VendorSignIn | null): void {
    this.signIn = signIn;
    this.publish();
  }

  private clearInFlight(): void {
    if (this.inFlight?.timer) clearTimeout(this.inFlight.timer);
    this.inFlight = null;
  }

  /**
   * Synchronously take over from a stale sign-in — a new begin replaces it — releasing the
   * harness's side in the background. Synchronous deliberately: the caller publishes its own
   * waiting state next, and the screen must move on the press, not after a round trip.
   */
  private abandonStale(): void {
    const flight = this.inFlight;
    this.clearInFlight();
    if (flight?.attempt) void this.releaseAttempt(flight.vendor, flight.attempt.attemptId);
  }

  /** Release the harness's side of an abandoned attempt; its own expiry is the backstop. */
  private async releaseAttempt(vendor: string, attemptId: string): Promise<void> {
    await this.opts
      .adapter()
      ?.cancelVendorOAuth?.(vendor, attemptId)
      .catch(() => {});
  }
}

/**
 * The human half of an adapter error. Adapter errors carry the harness's stated reason in
 * `detail`; their `message` leads with the method and route, which is an implementation
 * surface no screen should repeat — and it names the harness, which R-5 keeps out of sight.
 */
function messageOf(err: unknown): string {
  if (err !== null && typeof err === "object" && "detail" in err) {
    const detail = (err as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * R-13's classifier: whether a turn's failure is a vendor credential that could not be
 * refreshed. Deliberately narrow — the v2 normaliser keeps the wire's `provider.auth` type in
 * front of the message precisely so this stays matchable, and "token refresh" is the stable
 * line's wording. Anything broader would convert ordinary provider faults into sign-in
 * prompts, which sends a person to re-authenticate a connection that was never the problem.
 */
export function isAuthShapedFailure(detail: string | null | undefined): boolean {
  if (!detail) return false;
  // One leading `Name: ` is allowed because the operator log's cause is written as
  // `${err.name}: ${err.message}` — "Error: provider.auth" is the same failure. A single word
  // only, so prose that merely mentions provider.auth mid-sentence stays unmatched.
  return /^(?:\w+: )?provider\.auth\b/i.test(detail) || /token refresh/i.test(detail);
}

/** R-13's stated reason, shared by every turn surface so the words cannot drift apart. */
export const AUTH_FAILURE_REASON = "a vendor sign-in has expired — sign in again from Settings";

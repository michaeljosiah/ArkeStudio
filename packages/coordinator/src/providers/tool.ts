import { basename } from "node:path";
import type { ProviderId, ProviderToolStatus, ProviderWorkspace } from "@arke-studio/contracts";
import type { AppLog } from "../app-log.js";

/**
 * Providers whose credential is not ours (issue #137). Higgsfield authenticates through its
 * own CLI — OAuth 2.0 PKCE over a loopback callback — so "is this provider configured" is a
 * question about a binary on this machine, not about `credentials.dat`. This service is what
 * asks it, and what runs the sign-in.
 *
 * The login is deliberately not scraped. The credential arrives on the loopback socket rather
 * than on stdin, so there is nothing to read and nothing to type: the CLI opens a browser, the
 * user finishes there, and the process exits 0. Watching the exit code is the whole protocol,
 * which is why no pseudo-terminal is needed and no output format is depended on.
 *
 * The callback port is left to the CLI. It picks a default and falls back when that is taken —
 * documented behaviour that handles a collision better than pinning a port of our own and then
 * having to handle the collision ourselves anyway.
 */

export interface ToolProbe {
  /** Where the tool is, or null when nothing was found. */
  discover(): Promise<{ command: string; source: "configured" | "path" | "bundled"; version: string | null } | null>;
  /** Ask the tool who it is signed in as. Rejects when it is not. */
  whoAmI(command: string): Promise<{ account: string | null }>;
  /**
   * Run the interactive login to completion. Resolves with the exit code; the caller decides
   * what a non-zero one means, because only the tool knows why.
   */
  signIn(command: string, signal: AbortSignal): Promise<{ code: number | null; detail: string | null }>;
  /**
   * Which accounts this sign-in can bill. Never rejects: a tool that cannot say has not thereby
   * become signed out, and an empty list only means there is no choice to offer.
   */
  listWorkspaces?(command: string): Promise<ProviderWorkspace[]>;
  /** Choose which account pays; null hands billing back to the personal context. */
  selectWorkspace?(command: string, workspaceId: string | null): Promise<void>;
}

const SIGN_IN_COMMAND = "higgsfield auth login";

export class ProviderToolService {
  private status: ProviderToolStatus;
  private running: AbortController | null = null;

  constructor(
    private readonly provider: ProviderId,
    private readonly probe: ToolProbe,
    private readonly onChange: (status: ProviderToolStatus) => void,
    private readonly log: AppLog | null = null,
  ) {
    this.status = {
      provider,
      state: "absent",
      executableName: null,
      source: null,
      version: null,
      account: null,
      workspaces: [],
      detail: null,
      signInCommand: SIGN_IN_COMMAND,
    };
  }

  current(): ProviderToolStatus {
    return this.status;
  }

  private set(patch: Partial<ProviderToolStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onChange(this.status);
  }

  /**
   * Where the tool is and whether it is signed in. A sign-in in flight owns the state, so a
   * background re-probe declines rather than flickering the row back to signed-out while the
   * user is still standing in front of the browser.
   */
  async refresh(): Promise<ProviderToolStatus> {
    if (this.running) return this.status;
    return this.probeNow();
  }

  /**
   * Never throws: every outcome is a state with a reason, because "we could not tell" and
   * "it is not installed" are different answers and an exception would collapse them.
   */
  private async probeNow(): Promise<ProviderToolStatus> {
    const found = await this.probe.discover().catch(() => null);
    if (!found) {
      this.set({
        state: "absent",
        executableName: null,
        source: null,
        version: null,
        account: null,
        workspaces: [],
        detail: "the Higgsfield CLI is not on this machine",
      });
      return this.status;
    }
    // A basename only: the absolute path stays in the main process (R-6).
    const shared = {
      executableName: basename(found.command),
      source: found.source,
      version: found.version,
    };
    try {
      const { account } = await this.probe.whoAmI(found.command);
      // Read after the sign-in is known good, and never allowed to fail the probe: not knowing
      // which accounts exist is a missing picker, not a broken session.
      const workspaces = this.probe.listWorkspaces
        ? await this.probe.listWorkspaces(found.command).catch(() => [])
        : [];
      this.set({ ...shared, state: "ready", account, workspaces, detail: null });
    } catch (err) {
      this.set({
        ...shared,
        state: "signed-out",
        account: null,
        workspaces: [],
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return this.status;
  }

  /**
   * Start the browser login and wait for it. A second call while one is running is the same
   * sign-in, not a second browser window.
   */
  async signIn(): Promise<ProviderToolStatus> {
    if (this.running) return this.status;
    // Armed and published before the first await, both so the row changes the instant the
    // button is pressed and so a refresh racing this one cannot start underneath it.
    const controller = new AbortController();
    this.running = controller;
    this.set({
      state: "signing-in",
      detail: "finish signing in from the browser window the CLI opened",
    });
    try {
      const found = await this.probe.discover().catch(() => null);
      if (!found) {
        this.set({ state: "absent", detail: "the Higgsfield CLI is not on this machine" });
        return this.status;
      }
      const { code, detail } = await this.probe.signIn(found.command, controller.signal);
      if (code === 0) {
        void this.log?.append({ kind: "provider.tool-signed-in", provider: this.provider });
        // The probe is what confirms it, not the exit code: a login can exit 0 having signed
        // in an account with no credit, and the row should say so. Awaited inside the try so
        // `running` is still held while it runs.
        return await this.probeNow();
      }
      this.set({
        state: "signed-out",
        account: null,
        workspaces: [],
        detail: detail ?? (controller.signal.aborted ? "sign-in cancelled" : "sign-in did not complete"),
      });
      return this.status;
    } catch (err) {
      this.set({ state: "signed-out", detail: err instanceof Error ? err.message : String(err) });
      return this.status;
    } finally {
      this.running = null;
    }
  }

  /**
   * Choose which account pays. `null` hands billing back to the personal context.
   *
   * The outcome is re-probed rather than assumed: the tool is the authority on what it actually
   * selected, and this is the one setting here that decides whose money is spent — a picker
   * showing a choice the tool did not make would be the worst kind of wrong.
   */
  async selectWorkspace(workspaceId: string | null): Promise<ProviderToolStatus> {
    if (!this.probe.selectWorkspace) return this.status;
    const found = await this.probe.discover().catch(() => null);
    if (!found) return this.probeNow();
    let failure: string | null = null;
    try {
      await this.probe.selectWorkspace(found.command, workspaceId);
      void this.log?.append({
        kind: "provider.tool-workspace-selected",
        provider: this.provider,
        workspaceId,
      });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    // Re-read either way: the selection may or may not have moved, and only the listing knows
    // which. The reason is re-applied *after*, because a successful probe clears `detail` — so
    // setting it before this would have made a refused change look like a silent revert.
    await this.probeNow();
    if (failure !== null) this.set({ detail: failure });
    return this.status;
  }

  /** Stop waiting on a login the user has abandoned. The browser tab is theirs to close. */
  cancelSignIn(): void {
    this.running?.abort();
  }
}

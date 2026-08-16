import { join } from "node:path";

/**
 * The opencode2 launch protocol, shared by the desktop and dev hosts (issue 327 §2, §4).
 *
 * Three facts of the v2 server shape everything here, all measured against the pinned build:
 * it prints `server password <secret>` on stdout before serving and authenticates every
 * route with it (Basic, username `opencode`); it reads the user's own credential store
 * unless the profile is redirected, and stored connections OUTRANK spawn-env keys — a stale
 * personal login then fails turns with a bare `provider.auth`; and its `serve` arguments are
 * otherwise identical to v1's. So the launch is: redirected profile, password parsed from
 * stdout and held in memory, health probed with Basic auth.
 *
 * The password never appears in a log line, a trace, a status reason, or an error string —
 * the holder below is the only place it lives, and the accessors hand it to exactly two
 * consumers: the supervisor's health probe and the adapter's Authorization header.
 */

/** The launch line, exactly as the pinned build prints it. */
const PASSWORD_LINE = /^server password (\S+)$/;

/** Parse the password from one stdout line, or null for every other line. */
export function passwordFromLine(line: string): string | null {
  const match = PASSWORD_LINE.exec(line.trim());
  return match ? match[1]! : null;
}

/**
 * Holds the launch password across supervisor restarts: each spawn prints a fresh secret,
 * and the newest one is the only one that opens the current child.
 */
export class HarnessPasswordHolder {
  private password: string | null = null;

  /** Feed every stdout line through; non-password lines are ignored. */
  readonly onStdoutLine = (line: string): void => {
    const found = passwordFromLine(line);
    if (found !== null) this.password = found;
  };

  /** The current password, for the adapter's lazy `password()` option. */
  readonly current = (): string | null => this.password;

  /**
   * Health-probe headers: Basic auth once the password is known, bare until then — a bare
   * probe answers 401, which reads as "not yet" and keeps the probe loop patient.
   */
  readonly healthHeaders = (): Record<string, string> => {
    if (this.password === null) return {};
    return { authorization: "Basic " + Buffer.from(`opencode:${this.password}`).toString("base64") };
  };
}

/**
 * The redirected-profile environment (issue 327 §2): the spawned server sees an Arke-owned
 * state directory as its home, so the user's personal OpenCode logins cannot leak in and
 * shadow the credentials Arke injects. All four variables travel together deliberately —
 * which one the binary reads is its business, and the measured behavior (stored connections
 * vanish, env keys win) was verified with the full set.
 */
export function v2ProfileEnv(profileDir: string): Record<string, string> {
  return {
    HOME: profileDir,
    USERPROFILE: profileDir,
    XDG_CONFIG_HOME: join(profileDir, ".config"),
    XDG_DATA_HOME: join(profileDir, ".local", "share"),
  };
}

/** Where a host's harness profile lives, given its app root. */
export function harnessProfileDir(appRoot: string): string {
  return join(appRoot, "harness", "profile");
}

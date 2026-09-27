import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

type ServeConfig = { TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string; TerminateTLS?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> };
export type TailscaleRun = (args: string[]) => Promise<string>;
/** The caller must retain its bound gateway until mapping cleanup succeeds. */
export class ServeCleanupRequired extends Error {}
const run: TailscaleRun = args => new Promise((resolve, reject) => {
  const windows = join(process.env.ProgramFiles ?? "C:/Program Files", "Tailscale", "tailscale.exe");
  const binary = process.platform === "win32" && existsSync(windows) ? windows : "tailscale";
  execFile(binary, args, { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new Error("Tailscale could not complete the setup. Check that it is installed, connected, and allows Serve."));
    else resolve(stdout);
  });
});

/** Never reset Serve or replace a mapping owned by another application. */
export class TailscaleServe {
  constructor(private readonly execute: TailscaleRun = run) {}
  async origin(): Promise<string> {
    const status = JSON.parse(await this.execute(["status", "--json"]));
    const name = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
    if (status.BackendState !== "Running") throw new Error("Connect Tailscale on this PC first.");
    if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(name) || !status.CurrentTailnet?.MagicDNSEnabled || !status.CertDomains?.includes(name)) {
      throw new Error("Enable MagicDNS and HTTPS certificates in the Tailscale DNS settings first.");
    }
    return "https://" + name;
  }
  private async configuration(): Promise<ServeConfig> { return JSON.parse(await this.execute(["serve", "status", "--json"])); }
  private ours(config: ServeConfig, origin: string, port: number): boolean {
    const key = new URL(origin).hostname + ":443";
    const handler = config.Web?.[key]?.Handlers;
    return config.TCP?.["443"]?.HTTPS === true && !config.TCP["443"].TCPForward
      && !!handler && Object.keys(handler).length === 1 && handler["/"]?.Proxy === `http://127.0.0.1:${port}`
      && !Object.entries(config.AllowFunnel ?? {}).some(([host, allowed]) => host.endsWith(":443") && allowed)
      && !Object.keys(config.Web ?? {}).some(host => host.endsWith(":443") && host !== key);
  }
  async enable(origin: string, port: number, owned: boolean): Promise<boolean> {
    const config = await this.configuration();
    if (config.TCP?.["443"] || Object.keys(config.Web ?? {}).some(host => host.endsWith(":443"))) {
      if (owned && this.ours(config, origin, port)) return false;
      throw new Error("Tailscale port 443 is already in use. Remove its existing mapping before enabling Studio remote access.");
    }
    if (Object.entries(config.AllowFunnel ?? {}).some(([host, allowed]) => host.endsWith(":443") && allowed)) throw new Error("Disable Funnel on port 443 before using Studio remote access.");
    try {
      await this.execute(["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
      if (!this.ours(await this.configuration(), origin, port)) throw new Error("Tailscale did not publish the expected private mapping.");
    } catch (error) {
      // A timed-out CLI may already have published. Roll back only a verified matching
      // mapping, so a failed setup does not strand port 443 or remove somebody else's site.
      try { await this.disable(origin, port); }
      catch { throw new ServeCleanupRequired("Tailscale setup failed and its mapping could not be removed. Retry disabling remote access before quitting.", { cause: error }); }
      throw error;
    }
    return true;
  }
  async disable(origin: string, port: number): Promise<void> {
    let config = await this.configuration();
    if (this.ours(config, origin, port)) {
      await this.execute(["serve", "--https=443", "off"]);
      config = await this.configuration();
    }
    // A changed handler or Funnel setting is no longer ours to delete, but it must not
    // keep forwarding to a port we are about to release. Require owner recovery instead.
    const targets = [
      ...Object.values(config.Web ?? {}).flatMap(site => Object.values(site.Handlers ?? {}).map(handler => handler.Proxy)),
      ...Object.values(config.TCP ?? {}).map(tcp => tcp.TCPForward ? "http://" + tcp.TCPForward : undefined),
    ];
    for (const address of targets) {
      if (!address) continue;
      let target: URL;
      try { target = new URL(address); } catch { continue; }
      if (["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) && target.port === String(port)) {
        throw new Error("A Tailscale mapping still forwards to Studio's local port. Remove that mapping before disabling remote access or quitting.");
      }
    }
  }
}

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
  async origin(previous: string | null = null, allowHostnameChange = false): Promise<string> {
    const status = JSON.parse(await this.execute(["status", "--json"]));
    const name = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
    if (status.BackendState !== "Running") throw new Error("Connect Tailscale on this PC first.");
    if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(name) || !status.CurrentTailnet?.MagicDNSEnabled || !status.CertDomains?.includes(name)) {
      throw new Error("Enable MagicDNS and HTTPS certificates in the Tailscale DNS settings first.");
    }
    const saved = previous ? new URL(previous) : null;
    if (saved && (saved.protocol !== "https:" || saved.origin !== previous)) throw new Error("The saved remote address is invalid. Disable remote access before setting it up again.");
    if (saved && saved.hostname !== name && !allowHostnameChange) throw new Error("The tailnet address changed. Disable remote access before setting up its new address.");
    const config = await this.configuration();
    // Keep bookmarked addresses stable, but let first-time setup coexist with other apps.
    const ports = [...new Set([...(saved ? [saved.port || "443"] : []), "443", "8443", "9443",
      "10443", "11443", "12443", "13443", "14443", "15443", "16443", "17443", "18443", "19443"])];
    const available = ports.find(port => !this.occupied(config, port));
    if (!available) throw new Error("Studio could not find an available remote address. Close an unused Tailscale sharing connection, then try again.");
    return new URL(`https://${name}:${available}`).origin;
  }
  private async configuration(): Promise<ServeConfig> { return JSON.parse(await this.execute(["serve", "status", "--json"])); }
  private occupied(config: ServeConfig, port: string): boolean {
    return !!config.TCP?.[port] || Object.keys(config.Web ?? {}).some(host => host.endsWith(`:${port}`))
      || Object.entries(config.AllowFunnel ?? {}).some(([host, allowed]) => host.endsWith(`:${port}`) && allowed);
  }
  private ours(config: ServeConfig, origin: string, port: number): boolean {
    const address = new URL(origin), httpsPort = address.port || "443";
    const key = address.hostname + ":" + httpsPort;
    const handler = config.Web?.[key]?.Handlers;
    return config.TCP?.[httpsPort]?.HTTPS === true && !config.TCP[httpsPort].TCPForward
      && !!handler && Object.keys(handler).length === 1 && handler["/"]?.Proxy === `http://127.0.0.1:${port}`
      && !Object.entries(config.AllowFunnel ?? {}).some(([host, allowed]) => host.endsWith(`:${httpsPort}`) && allowed)
      && !Object.keys(config.Web ?? {}).some(host => host.endsWith(`:${httpsPort}`) && host !== key);
  }
  async enable(origin: string, port: number, owned: boolean): Promise<boolean> {
    const config = await this.configuration();
    const httpsPort = new URL(origin).port || "443";
    if (this.occupied(config, httpsPort)) {
      if (owned && this.ours(config, origin, port)) return false;
      throw new Error("Another service has started using this remote address. Disable and enable remote access to let Studio choose another.");
    }
    try {
      await this.execute(["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`]);
      if (!this.ours(await this.configuration(), origin, port)) throw new Error("Tailscale did not publish the expected private mapping.");
    } catch (error) {
      // A timed-out CLI may already have published. Roll back only a verified matching
      // mapping, so a failed setup does not strand forwarding or remove somebody else's site.
      try { await this.disable(origin, port); }
      catch { throw new ServeCleanupRequired("Tailscale setup failed and its mapping could not be removed. Retry disabling remote access before quitting.", { cause: error }); }
      throw error;
    }
    return true;
  }
  async disable(origin: string | null, port: number): Promise<void> {
    let config = await this.configuration();
    // Damaged ownership records still need recovery. Discover only the exact private
    // Studio mapping to its fixed port; other targets, extra handlers and Funnel stay owned
    // by their operator and continue to prevent releasing the protected port.
    const candidates = origin ? [origin] : Object.keys(config.Web ?? {}).filter(host => /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net:\d{1,5}$/.test(host))
      .map(host => new URL("https://" + host).origin);
    for (const candidate of candidates) {
      if (this.ours(config, candidate, port)) {
        await this.execute(["serve", `--https=${new URL(candidate).port || "443"}`, "off"]);
        config = await this.configuration();
      }
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

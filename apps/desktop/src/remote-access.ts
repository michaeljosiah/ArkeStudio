import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RemoteAccessCommandSchema, type RemoteAccessReply, type RemoteAccessStatus } from "@arke-studio/contracts";
import { RemoteDevices, RemoteGateway, writeRemotePrivate } from "@arke-studio/coordinator";
import { TailscaleServe } from "./tailscale-serve.js";

const Config = z.object({ enabled: z.boolean(), startOnLogin: z.boolean(), origin: z.string().url().nullable() });
type Settings = z.infer<typeof Config>;
const port = 8793;

/** Desktop owns this gateway and the existing coordinator; no second world writer is started. */
export class DesktopRemoteAccess {
  private config: Settings = { enabled: false, startOnLogin: false, origin: null };
  private reason: string | null = null;
  private gateway: RemoteGateway | null = null;
  private devices: RemoteDevices;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private loaded = false;
  private path: string;
  constructor(private readonly options: { root: string; clientDirectory: string; session: { port: number; token: string };
    startupSupported: boolean; setStartOnLogin: (enabled: boolean) => void; tailscale?: TailscaleServe }) {
    this.path = join(options.root, "remote", "settings.json");
    this.devices = new RemoteDevices(join(options.root, "remote", "devices.json"));
  }
  async initialize(): Promise<void> {
    try {
      try { this.config = Config.parse(JSON.parse(await readFile(this.path, "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await this.devices.load();
      this.loaded = true;
      if (this.config.enabled) await this.start();
    } catch { this.reason = "Remote access could not start. Check Tailscale, then disable and enable remote access to retry."; }
  }
  private tailscale() { return this.options.tailscale ?? new TailscaleServe(); }
  private async save(config: Settings): Promise<void> { await writeRemotePrivate(this.path, config); this.config = config; }
  private async start(): Promise<void> {
    if (this.gateway) return;
    const origin = await this.tailscale().origin();
    if (this.config.origin && this.config.origin !== origin) throw new Error("The tailnet address changed. Disable remote access before setting up its new address.");
    const gateway = new RemoteGateway({ origin, clientDirectory: this.options.clientDirectory, devices: this.devices, session: this.options.session });
    let published = false;
    try {
      await gateway.start(port);
      published = await this.tailscale().enable(origin, port, this.config.enabled && this.config.origin === origin);
      await this.save({ ...this.config, enabled: true, origin });
      this.gateway = gateway;
    } catch (error) {
      await gateway.stop();
      if (published) await this.tailscale().disable(origin, port);
      throw error;
    }
  }
  status(): RemoteAccessStatus {
    return { ...this.config, running: !!this.gateway, startupSupported: this.options.startupSupported,
      url: this.config.origin, reason: this.reason, devices: this.devices.list(), pending: this.devices.pending() };
  }
  command(input: unknown): Promise<RemoteAccessReply> {
    const work = this.tail.then(async () => {
      if (this.closing) throw new Error("Studio is shutting down.");
      const command = RemoteAccessCommandSchema.parse(input);
      if (!this.loaded && command.kind !== "status") throw new Error("Remote access records could not be read. Restore them before changing access.");
      let pairing: RemoteAccessReply["pairing"];
      if (command.kind !== "status") this.reason = null;
      try {
        switch (command.kind) {
          case "enable": await this.start(); break;
          case "disable":
            await this.gateway?.stop(); this.gateway = null;
            if (this.config.origin && this.config.enabled) await this.tailscale().disable(this.config.origin, port);
            this.options.setStartOnLogin(false);
            await this.devices.stop();
            await this.save({ enabled: false, startOnLogin: false, origin: null }); break;
          case "startup":
            if (!this.options.startupSupported || !this.gateway) throw new Error("Enable remote access in the installed desktop app first.");
            this.options.setStartOnLogin(command.enabled);
            try { await this.save({ ...this.config, startOnLogin: command.enabled }); }
            catch (error) { this.options.setStartOnLogin(this.config.startOnLogin); throw error; }
            break;
          case "pair":
            if (!this.gateway) throw new Error("Enable remote access first.");
            pairing = this.devices.createCode(); break;
          case "approve": await this.devices.approve(command.id); break;
          case "reject": this.devices.reject(command.id); break;
          case "revoke": await this.devices.revoke(command.id); this.gateway?.recheckDevices(); break;
        }
      } catch (error) { this.reason = error instanceof Error ? error.message : "Remote access could not complete that action."; }
      return { status: this.status(), ...(pairing ? { pairing } : {}) };
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async stop(): Promise<void> {
    this.closing = true;
    await this.tail;
    await this.gateway?.stop(); this.gateway = null;
    await this.devices.stop();
    // Keep the owned Serve mapping for the next desktop start; its upstream stays closed.
  }
}

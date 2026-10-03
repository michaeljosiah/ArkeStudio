import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { z } from "zod";
import { RemoteAccessCommandSchema, RemotePairingDurationSchema, type RemoteAccessReply, type RemoteAccessStatus } from "@arke-studio/contracts";
import { RemoteDevices, RemoteGateway, writeRemotePrivate, type RemoteTrace } from "@arke-studio/coordinator";
import { ServeCleanupRequired, TailscaleServe } from "./tailscale-serve.js";

const Config = z.object({ enabled: z.boolean(), startOnLogin: z.boolean(), origin: z.string().url().nullable(),
  pairingDuration: RemotePairingDurationSchema.default(90) });
type Settings = z.infer<typeof Config>;
/** Fixed so a Serve mapping and every paired phone's bookmark survive restarts; tests pass a free port. */
export const remoteGatewayPort = 8793;

/** Desktop owns this gateway and the existing coordinator; no second world writer is started. */
export class DesktopRemoteAccess {
  private config: Settings = { enabled: false, startOnLogin: false, origin: null, pairingDuration: 90 };
  private reason: string | null = null;
  private gateway: RemoteGateway | null = null;
  private gatewayOrigin: string | null = null;
  private reservation: Server | null = null;
  private inspectMapping = false;
  private running = false;
  private devices: RemoteDevices;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private loaded = false;
  private settingsLoaded = false;
  private path: string;
  constructor(private readonly options: { root: string; clientDirectory: string; session: { port: number; token: string };
    gatewayPort: number; startupSupported: boolean; setStartOnLogin: (enabled: boolean) => void;
    tailscale?: TailscaleServe; writeClipboard?: (text: string) => void; trace?: RemoteTrace }) {
    this.path = join(options.root, "remote", "settings.json");
    this.devices = new RemoteDevices(join(options.root, "remote", "devices.json"));
  }
  initialize(): Promise<void> {
    // Settings IPC is already reachable during desktop startup. Enrol automatic startup in
    // the same drain as owner commands so Disable/Quit cannot be overtaken by a late start.
    const work = this.tail.then(async () => {
      if (this.closing) return;
      const bindError = await this.reservePort();
      let readingRecords = true;
      try {
        let missingSettings = false;
        try { this.config = Config.parse(JSON.parse(await readFile(this.path, "utf8"))); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          missingSettings = true;
        }
        this.settingsLoaded = true;
        if (missingSettings) {
          // Missing settings alongside device records are recovery, not a first launch.
          this.inspectMapping = true;
          try { await stat(join(this.options.root, "remote", "devices.json")); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") this.inspectMapping = false; else throw error; }
        }
        readingRecords = false;
        if (this.config.enabled || this.inspectMapping) {
          this.inspectMapping = true;
          this.gatewayOrigin = this.config.origin;
          await this.stopGateway();
          if (bindError) throw bindError;
        } else await this.releaseReservation();
        readingRecords = true;
        await this.devices.load();
        readingRecords = false;
        this.loaded = true;
        if (this.config.enabled) await this.start();
      } catch (error) {
        this.reason = readingRecords
          ? "Remote access records could not be read. Restore the remote settings and device records from a backup before changing access."
          : `${error instanceof Error ? error.message : "Remote access could not start."} Disable and enable remote access to retry.`;
        if (!this.settingsLoaded) {
          this.inspectMapping = true;
          try { await this.stopGateway(); }
          catch { this.reason += " Forwarding could not be cleared. Restore Tailscale and use Disable to retry cleanup."; }
        }
      }
    });
    this.tail = work;
    return work;
  }
  private tailscale() { return this.options.tailscale ?? new TailscaleServe(); }
  private async reservePort(): Promise<unknown> {
    // Claim an inert listener before reading either record. Even damaged ownership settings
    // must not leave a cookie-bearing origin pointing at a port another process can claim.
    this.reservation = createServer((_req, res) => res.writeHead(503).end("Remote access needs attention on the host."));
    this.reservation.on("upgrade", (_req, socket) => socket.destroy());
    try { this.reservation.listen(this.options.gatewayPort, "127.0.0.1"); await once(this.reservation, "listening"); }
    catch (error) { return error; } // Still attempt mapping withdrawal if another listener got there first.
  }
  private async releaseReservation(): Promise<void> {
    if (this.reservation?.listening) {
      const reservation = this.reservation;
      const closed = new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
      reservation.closeAllConnections();
      await closed;
    }
    this.reservation = null;
  }
  private async save(config: Settings): Promise<void> { await writeRemotePrivate(this.path, config); this.config = config; }
  private async start(): Promise<void> {
    if (this.running) return;
    if (this.gateway) await this.stopGateway();
    const origin = await this.tailscale().origin(this.config.origin, !this.config.enabled);
    if (this.config.origin !== origin) {
      // A replacement service at the old origin can read that origin's browser key.
      // Revoke durably before publishing elsewhere, including recovery without an origin.
      const hadDevices = this.devices.list().length > 0;
      // Every phone has to pair again after this, so the move is recorded with what forced it.
      this.options.trace?.("remote.address-moved", { from: this.config.origin, to: origin, unpaired: this.devices.list().map(row => row.name) });
      await this.devices.revokeAll();
      if (hadDevices) this.reason = "Studio has a new address. Pair your devices again using the new link.";
    }
    const gateway = new RemoteGateway({ origin, clientDirectory: this.options.clientDirectory, devices: this.devices, session: this.options.session,
      ...(this.options.trace ? { trace: this.options.trace } : {}) });
    let published = false;
    try {
      // Also withdraw a matching mapping left by an interrupted older host before trying
      // to claim its port; a failed bind must not leave HTTPS pointing at that occupant.
      if (this.config.enabled) await this.tailscale().disable(origin, this.options.gatewayPort);
      await gateway.start(this.options.gatewayPort);
      const owned = this.config.enabled && this.config.origin === origin;
      // Serve survives this process. Record ownership durably before publishing, including
      // re-enablement, so a crash at any later point enters stale-mapping recovery on restart.
      await this.save({ ...this.config, enabled: true, origin });
      await this.tailscale().enable(origin, this.options.gatewayPort, owned);
      published = true;
      this.gateway = gateway;
      this.gatewayOrigin = origin;
      this.running = true;
      this.options.trace?.("remote.started", { origin, devices: this.devices.list().map(row => row.name) });
    } catch (error) {
      if (published || error instanceof ServeCleanupRequired) {
        this.gateway = gateway;
        this.gatewayOrigin = origin;
        await this.stopGateway();
      } else await gateway.stop();
      throw error;
    }
  }
  private async stopGateway(): Promise<void> {
    const origin = this.gatewayOrigin ?? (this.config.enabled ? this.config.origin : null);
    // Withdraw HTTPS before releasing the port: a replacement local listener must never
    // receive a paired browser's cookie. On cleanup failure retain the bound gateway and
    // fail shutdown, so the owner can retry without creating that impersonation window.
    if (origin || this.inspectMapping) await this.tailscale().disable(origin, this.options.gatewayPort);
    await this.gateway?.stop();
    await this.releaseReservation();
    this.inspectMapping = false;
    this.gateway = null; this.gatewayOrigin = null; this.running = false;
  }
  status(): RemoteAccessStatus {
    return { ...this.config, enabled: this.config.enabled || this.gatewayOrigin !== null || this.inspectMapping,
      running: this.running, startupSupported: this.options.startupSupported,
      url: this.config.origin, reason: this.reason, devices: this.devices.list(), pending: this.devices.pending() };
  }
  command(input: unknown): Promise<RemoteAccessReply> {
    const work = this.tail.then(async () => {
      if (this.closing) throw new Error("Studio is shutting down.");
      const command = RemoteAccessCommandSchema.parse(input);
      if (!this.loaded && command.kind !== "status" && !(command.kind === "disable" && (this.settingsLoaded || this.inspectMapping))) {
        throw new Error("Remote access records could not be read. Restore them before changing access.");
      }
      let pairing: RemoteAccessReply["pairing"];
      let copied = false;
      if (command.kind !== "status" && this.loaded) this.reason = null;
      try {
        switch (command.kind) {
          case "copy-link":
            if (!this.running || !this.config.origin) throw new Error("Enable remote access first.");
            if (!this.options.writeClipboard) throw new Error("Clipboard is unavailable. Copy the address shown in Settings.");
            // Copy the host's clean address, never renderer-supplied text or a session proof.
            this.options.writeClipboard(this.config.origin); copied = true; break;
          case "enable": await this.start(); break;
          case "disable":
            this.options.trace?.("remote.disabled", {});
            await this.stopGateway();
            if (this.options.startupSupported) this.options.setStartOnLogin(false);
            await this.devices.stop();
            if (this.settingsLoaded) await this.save({ ...this.config, enabled: false, startOnLogin: false });
            break;
          case "startup":
            if (!this.options.startupSupported || !this.running) throw new Error("Enable remote access in the installed desktop app first.");
            this.options.setStartOnLogin(command.enabled);
            try { await this.save({ ...this.config, startOnLogin: command.enabled }); }
            catch (error) { this.options.setStartOnLogin(this.config.startOnLogin); throw error; }
            break;
          case "pair":
            if (!this.running) throw new Error("Enable remote access first.");
            pairing = this.devices.createCode(); break;
          case "duration": await this.save({ ...this.config, pairingDuration: command.duration }); break;
          case "approve": {
            const name = this.devices.pending().find(row => row.id === command.id)?.name;
            await this.devices.approve(command.id, this.config.pairingDuration);
            this.options.trace?.("remote.paired", { device: name, days: this.config.pairingDuration }); break;
          }
          case "reject": this.devices.reject(command.id); break;
          case "revoke": {
            const name = this.devices.list().find(row => row.id === command.id)?.name;
            await this.devices.revoke(command.id); this.gateway?.recheckDevices();
            this.options.trace?.("remote.revoked", { device: name }); break;
          }
        }
      } catch (error) {
        this.reason = error instanceof Error ? error.message : "Remote access could not complete that action.";
        this.options.trace?.("remote.failed", { command: command.kind, reason: this.reason });
      }
      return { status: this.status(), ...(pairing ? { pairing } : {}), ...(copied ? { copied } : {}) };
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async stop(): Promise<void> {
    this.closing = true;
    await this.tail;
    await this.stopGateway();
    await this.devices.stop();
  }
}

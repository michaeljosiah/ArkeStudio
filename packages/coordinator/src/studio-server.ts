import { randomBytes } from "node:crypto";
import type { DomainEvent } from "@arke-studio/contracts";
import { Transport, type TransportAuth, type TransportOptions } from "./transport.js";

export interface StudioEventSink {
  broadcast(event: DomainEvent): void;
  broadcastSnapshot(): void;
}

/** Studio request/state adaptation. The host owns sockets; application services own work. */
export interface StudioServerApplication extends Omit<TransportOptions, "auth"> {
  attachTransport(sink: StudioEventSink): void;
  registerSecret(token: string): void;
  start(): Promise<void>;
  /** Preserve application drain ordering while the host closes its connections. */
  stop(connectionsClosed: Promise<void>): Promise<void>;
}

/** One local authenticated host, embedded by Electron or launched under ordinary Node. */
export class StudioServer {
  private readonly transport: Transport;
  private readonly auth: TransportAuth;
  private starting: Promise<{ port: number; token: string }> | null = null;
  private stopping = false;
  private stopped: Promise<void> | null = null;

  constructor(private readonly application: StudioServerApplication, auth?: TransportAuth) {
    this.auth = auth ? { token: auth.token, allowedOrigins: [...auth.allowedOrigins] } :
      { token: randomBytes(32).toString("hex"), allowedOrigins: [] };
    this.transport = new Transport({ ...application, auth: this.auth });
    application.registerSecret(this.auth.token);
    application.attachTransport(this.transport);
  }

  async start(port = 0): Promise<{ port: number; token: string }> {
    if (this.starting || this.stopping) throw new Error("The Studio server has already started or stopped.");
    this.starting = (async () => {
      await this.application.start();
      if (this.stopping) throw new Error("The Studio server is stopping.");
      const bound = await this.transport.start(port);
      if (this.stopping) throw new Error("The Studio server is stopping.");
      return { port: bound, token: this.auth.token };
    })();
    try { return await this.starting; }
    catch (error) {
      try { await this.stop(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Studio startup and cleanup failed."); }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.stopped) this.stopped = (async () => {
      // Initialization owns stores and recovery work too; never close underneath it.
      await this.starting?.catch(() => {});
      await this.application.stop(this.transport.stop());
    })();
    try { await this.stopped; }
    catch (error) { this.stopped = null; throw error; }
  }
}

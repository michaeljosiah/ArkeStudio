import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { PrivateSessionRequest, PrivateSessionWriter } from "@arke-studio/contracts";
import { isSupervisedProcessCleanupConfirmed, type SupervisedProcessOrigin } from "../supervisor.js";
import { VerifiedLoopbackHttpTransport, type VerifiedHttpOptions, type VerifiedHttpPolicy } from "../local-ai/verified-loopback-http.js";

const refused = () => new Error("The private writing connection is outside its captured session.");
const idValid = (value: string) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);

/** Original managed writer/API socket, separate from the upstream provider bridge.
 * The host still owns destination/approval/native completion and exact file retirement. */
export class ManagedStudioWriterTransport extends VerifiedLoopbackHttpTransport implements PrivateSessionWriter {
  readonly identity: string;
  private readonly authorization: string;
  private readonly requestInput: Readonly<PrivateSessionRequest>;
  private directory: string | null = null;
  private agent: string | null = null;
  private sessionId: string | null = null;
  private creating = false;
  private generated = false;
  private sealed = false;
  private readonly originalOwner: SupervisedProcessOrigin;
  constructor(options: VerifiedHttpOptions & { authorization: string; request: PrivateSessionRequest }) {
    super({ ...options, timeoutMs: options.timeoutMs ?? 300_000 }, 900_000);
    this.originalOwner = options.origin;
    const { model, system, prompt, outputTokenLimit } = options.request;
    if (!model || model.length > 512 || model.indexOf("/") < 1 || typeof system !== "string" || typeof prompt !== "string" ||
      Buffer.byteLength(system) + Buffer.byteLength(prompt) > 1024 ** 2 || !Number.isSafeInteger(outputTokenLimit) || outputTokenLimit < 1 || outputTokenLimit > 4096 ||
      !/^Basic [A-Za-z0-9+/]+=*$/.test(options.authorization) || options.authorization.length > 16_384) throw refused();
    this.authorization = options.authorization; this.requestInput = Object.freeze({ model, system, prompt, outputTokenLimit });
    this.identity = createHash("sha256").update(JSON.stringify([options.origin.identity, this.authorization, this.requestInput])).digest("hex");
  }
  current(): boolean { return this.available(); }
  /** No inference claim: the backing provider must confirm its own original process separately. */
  ownerStopped(): boolean { return isSupervisedProcessCleanupConfirmed(this.originalOwner); }
  bindDirectory(directory: string, agent: string): boolean {
    if (!this.available() || this.sealed || this.directory !== null || typeof directory !== "string" || !isAbsolute(directory) || directory.length > 4096 || [...directory].some(character => character.charCodeAt(0) < 32) ||
      !["studio-assistant", "diagnostic-specialist"].includes(agent)) return false;
    this.directory = directory.replaceAll("\\", "/"); this.agent = agent; return true;
  }
  bindSession(sessionId: string): boolean {
    if (!this.available() || !this.creating || this.sessionId !== null || !idValid(sessionId)) return false;
    this.sessionId = sessionId; return true;
  }
  seal(): void { this.sealed = true; }
  close(): Promise<boolean> { this.seal(); return super.stop(); }
  protected policy(url: URL, method: string, body: string, headers: Headers): VerifiedHttpPolicy {
    if (!this.directory || headers.get("authorization") !== this.authorization) throw refused();
    const policy: VerifiedHttpPolicy = { requestBytes: 1024 ** 2, responseBytes: 64 * 1024, responseType: "application/json", nativeStatuses: true };
    const metadata = method === "GET" && ["/api/model", "/api/plugin"].includes(url.pathname);
    if (metadata) {
      const query = [...url.searchParams];
      if (query.length !== 1 || query[0]![0] !== "location[directory]" || query[0]![1] !== this.directory) throw refused();
      return { ...policy, responseBytes: 1024 ** 2 };
    }
    if (url.search) throw refused();
    if (method === "POST" && url.pathname === "/api/session") {
      const slash = this.requestInput.model.indexOf("/");
      const expected = { location: { directory: this.directory }, model: { providerID: this.requestInput.model.slice(0, slash), id: this.requestInput.model.slice(slash + 1) } };
      if (this.sealed || this.creating || body !== JSON.stringify(expected)) throw refused();
      this.creating = true; return { ...policy, beforeWrite: () => !this.sealed };
    }
    if (!this.sessionId) throw refused();
    const prefix = `/api/session/${this.sessionId}`;
    if ((method === "GET" || method === "DELETE") && url.pathname === prefix) return policy;
    if (method === "GET" && url.pathname === prefix + "/message") return { ...policy, responseBytes: 4 * 1024 ** 2 };
    if (method === "GET" && url.pathname === prefix + "/permission") return policy;
    if (method === "POST" && url.pathname === prefix + "/agent") {
      if (this.sealed || body !== JSON.stringify({ agent: this.agent })) throw refused(); return { ...policy, beforeWrite: () => !this.sealed };
    }
    if (method === "POST" && url.pathname === prefix + "/generate") {
      if (this.sealed || this.generated || body !== JSON.stringify({ prompt: this.requestInput.prompt })) throw refused();
      this.generated = true; return { ...policy, responseBytes: 2 * 1024 ** 2, beforeWrite: () => !this.sealed };
    }
    if (method === "POST" && url.pathname === prefix + "/interrupt" && body === "{}") return policy;
    if (method === "POST" && url.pathname.startsWith(prefix + "/permission/") && url.pathname.endsWith("/reply")) {
      const permissionId = url.pathname.slice((prefix + "/permission/").length, -"/reply".length);
      const value = JSON.parse(body);
      if (!idValid(permissionId) || !value || value.decision !== "reject" || Object.keys(value).some(key => !["decision", "message"].includes(key)) ||
        value.message !== undefined && (typeof value.message !== "string" || value.message.length > 512)) throw refused();
      return policy;
    }
    throw refused();
  }
}

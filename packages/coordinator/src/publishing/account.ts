import * as oidc from "openid-client";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import { SIGNED_OUT, type AccountPage, type AccountState } from "@arke-studio/contracts";
import type { AccountService } from "../account.js";
import type { Cipher } from "../credentials/store.js";
import { savePublishingFile, PublishingSerial } from "./files.js";
import { trustedAonikUrl, type AonikConfiguration } from "./config.js";
import { toExtendedLength } from "../world/paths.js";

const CredentialsSchema = z.object({
  issuer: z.string(), clientId: z.string(), subject: z.string().min(1).max(500),
  accessToken: z.string().min(1).max(65536), refreshToken: z.string().min(1).max(65536).optional(), expiresAt: z.number().finite(),
  name: z.string().min(1).max(200), email: z.string().min(1).max(320),
}).strict();
type Credentials = z.infer<typeof CredentialsSchema>;
export class CreatorSignInRequired extends Error { constructor() { super("Sign in to your creator account to continue."); } }

export interface AonikAccountOptions {
  configuration: AonikConfiguration;
  file: string;
  cipher: Cipher;
  openExternal: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  clock?: () => number;
  handoffTimeoutMs?: number;
  secrets?: { register(secret: string): void };
}

/** OIDC public client owned by the host. No credential is part of AccountState or a wire frame. */
export class AonikAccount implements AccountService {
  private state: AccountState = SIGNED_OUT;
  private readonly listeners = new Set<(state: AccountState) => void>();
  private credentials: Credentials | null = null;
  private configuration: Promise<oidc.Configuration> | null = null;
  private generation = 0;
  private stopped = false;
  private readonly lifetime = new AbortController();
  private handoff: { controller: AbortController; server: Server; done: Promise<void> } | null = null;
  private refresh: Promise<string> | null = null;
  private readonly writes = new PublishingSerial();
  constructor(private readonly options: AonikAccountOptions) {}
  private now() { return this.options.clock?.() ?? Date.now(); }
  current(): AccountState { return this.state; }
  actorKey(): string | null {
    const c = this.credentials, o = this.options.configuration;
    return c ? createHash("sha256").update(JSON.stringify([o.apiBaseUrl, o.issuer, o.clientId, o.tenantId, o.channelKey, c.subject])).digest("hex") : null;
  }
  async initialise(): Promise<void> {
    if (!this.options.cipher.isAvailable()) return;
    try {
      const raw = await readFile(toExtendedLength(this.options.file), "utf8");
      if (raw.length > 262144) return;
      const c = CredentialsSchema.parse(JSON.parse(this.options.cipher.decryptString(Buffer.from(raw, "base64"))));
      if (c.issuer !== this.options.configuration.issuer || c.clientId !== this.options.configuration.clientId) return;
      this.options.secrets?.register(c.accessToken); if (c.refreshToken) this.options.secrets?.register(c.refreshToken);
      this.credentials = c; this.signed(c.expiresAt > this.now() ? "ok" : "expired");
    } catch { /* Missing, unavailable or invalid protected storage leaves local Studio signed out. */ }
  }
  onChange(listener: (state: AccountState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private move(next: AccountState) { if (this.stopped) return; this.state = next; for (const listener of this.listeners) listener(next); }
  private signed(session: "ok" | "expired" | "offline") {
    const c = this.credentials; if (!c) return;
    this.move({ kind: "signed-in", person: { name: c.name, email: c.email, picture: null }, plan: { name: "Creator", paid: false }, session, creatorScope: this.actorKey()!,
      pages: [...(this.options.configuration.accountUrl ? ["account" as const] : []), ...(this.options.configuration.planUrl ? ["plan" as const] : [])] });
  }
  private oidc(): Promise<oidc.Configuration> {
    if (!this.configuration) {
      const o = this.options.configuration;
      this.configuration = oidc.discovery(new URL(o.issuer), o.clientId, { token_endpoint_auth_method: "none" }, oidc.None(), {
        ...(o.allowLoopbackHttp ? { execute: [oidc.allowInsecureRequests] } : {}),
        [oidc.customFetch]: async (input, init) => {
          const target = new URL(input);
          // Discovery may add its standard query. Credentials still never follow redirects.
          trustedAonikUrl(target.origin + target.pathname, o.allowLoopbackHttp);
          return (this.options.fetch ?? fetch)(input, { ...init, redirect: "error", credentials: "omit",
            signal: AbortSignal.any([this.lifetime.signal, ...(init?.signal ? [init.signal] : []), ...(this.handoff ? [this.handoff.controller.signal] : []), AbortSignal.timeout(15000)]) });
        },
      }).catch(error => { this.configuration = null; throw error; });
    }
    return this.configuration;
  }
  async signIn(): Promise<void> { await this.begin(); }
  async createAccount(): Promise<void> { await this.begin(); }
  private async begin(): Promise<void> {
    if (this.stopped || this.handoff) return;
    if (!this.options.cipher.isAvailable()) { this.move({ kind: "signed-out", refusal: "Secure account storage is unavailable on this device." }); return; }
    const generation = ++this.generation;
    this.credentials = null;
    try { await this.writes.run(() => rm(toExtendedLength(this.options.file), { force: true })); }
    catch { this.move({ kind: "signed-out", refusal: "Secure account storage could not be updated. Try signing in again." }); return; }
    if (generation !== this.generation || this.stopped) return;
    this.move({ kind: "signing-in" });
    const controller = new AbortController();
    const state = randomBytes(32).toString("base64url"), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
    this.options.secrets?.register(state); this.options.secrets?.register(verifier);
    let settle!: (url: URL) => void;
    const callback = new Promise<URL>(resolve => { settle = resolve; });
    let redirect: URL;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Security-Policy", "default-src 'none'");
      if (request.method !== "GET" || url.pathname !== "/aonik/callback" || url.searchParams.get("state") !== state) { response.writeHead(400).end("This sign-in response does not belong to this request."); return; }
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Return to Arke Studio to finish signing in.");
      settle(new URL(redirect.origin + url.pathname + url.search));
    });
    const done = (async () => {
      const timer = setTimeout(() => controller.abort(), this.options.handoffTimeoutMs ?? 180000); timer.unref();
      let onAbort: (() => void) | undefined;
      try {
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.options.configuration.redirectPort, "127.0.0.1", resolve); });
        const address = server.address(); if (!address || typeof address === "string") throw new Error("No callback listener");
        redirect = new URL(`http://127.0.0.1:${address.port}/aonik/callback`);
        const configuration = await this.oidc();
        // An explicit sign-in must let the author choose their identity, even when
        // the system browser still has another creator's or reviewer's SSO session.
        const url = oidc.buildAuthorizationUrl(configuration, { ...(this.options.configuration.audience ? { audience: this.options.configuration.audience } : {}), redirect_uri: redirect.href, scope: this.options.configuration.scope,
          prompt: "login", state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256" });
        trustedAonikUrl(url.origin + url.pathname, this.options.configuration.allowLoopbackHttp);
        if (controller.signal.aborted || generation !== this.generation) return;
        const cancelled = new Promise<never>((_, reject) => {
          onAbort = () => reject(new CreatorSignInRequired());
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
        // The OS browser launch cannot be aborted. Stop owning the callback immediately;
        // a late browser completion must not keep cancellation or shutdown waiting.
        const returned = await Promise.race([cancelled, Promise.resolve().then(async () => {
          controller.signal.throwIfAborted();
          await this.options.openExternal(url.href);
          return callback;
        })]);
        if (controller.signal.aborted || generation !== this.generation || this.stopped) return;
        const tokens = await oidc.authorizationCodeGrant(configuration, returned, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
        const claims = tokens.claims(); if (!claims?.sub) throw new CreatorSignInRequired();
        const profile = configuration.serverMetadata().userinfo_endpoint ? await oidc.fetchUserInfo(configuration, tokens.access_token, claims.sub) : claims;
        const c = CredentialsSchema.parse({ issuer: this.options.configuration.issuer, clientId: this.options.configuration.clientId, subject: claims.sub,
          accessToken: tokens.access_token, ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}), expiresAt: this.now() + Math.max(0, tokens.expires_in ?? 0) * 1000,
          name: (String(profile.name ?? profile.preferred_username ?? "").trim() || "Creator").slice(0, 200), email: (String(profile.email ?? "").trim() || "Email unavailable").slice(0, 320) });
        await this.keep(c, generation, controller.signal); if (generation === this.generation && !controller.signal.aborted) { this.credentials = c; this.signed("ok"); }
      } catch {
        if (generation === this.generation && !this.stopped) this.move({ kind: "signed-out", refusal: controller.signal.aborted ? "Sign-in timed out. Try again in your browser." : "Sign-in was not completed. Try again in your browser." });
      } finally { clearTimeout(timer); if (onAbort) controller.signal.removeEventListener("abort", onAbort); server.closeAllConnections(); server.close(); if (this.handoff?.controller === controller) this.handoff = null; }
    })();
    this.handoff = { controller, server, done };
  }
  private keep(c: Credentials, generation: number, signal?: AbortSignal): Promise<void> {
    return this.writes.run(async () => {
      if (generation !== this.generation || this.stopped || signal?.aborted) return;
      this.options.secrets?.register(c.accessToken); if (c.refreshToken) this.options.secrets?.register(c.refreshToken);
      await savePublishingFile(this.options.file, this.options.cipher.encryptString(JSON.stringify(c)).toString("base64"), true);
      if (generation !== this.generation || this.stopped || signal?.aborted) await rm(toExtendedLength(this.options.file), { force: true });
    });
  }
  async bearer(forceRefresh = false): Promise<string> {
    const c = this.credentials; if (!c || this.stopped) throw new CreatorSignInRequired();
    if (!forceRefresh && c.expiresAt > this.now() + 30000) return c.accessToken;
    if (!c.refreshToken) { this.signed("expired"); throw new CreatorSignInRequired(); }
    if (!this.refresh) {
      const generation = this.generation;
      this.refresh = (async () => {
        try {
          const tokens = await oidc.refreshTokenGrant(await this.oidc(), c.refreshToken!);
          if (generation !== this.generation || this.stopped) throw new CreatorSignInRequired();
          const claims = tokens.claims(); if (claims && claims.sub !== c.subject) throw new CreatorSignInRequired();
          const next = CredentialsSchema.parse({ ...c, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? c.refreshToken,
            expiresAt: this.now() + Math.max(0, tokens.expires_in ?? 0) * 1000 });
          await this.keep(next, generation); if (generation !== this.generation || this.stopped) throw new CreatorSignInRequired();
          this.credentials = next; this.signed("ok"); return next.accessToken;
        } catch (error) { if (generation === this.generation) this.signed(error instanceof oidc.ResponseBodyError ? "expired" : "offline"); throw new CreatorSignInRequired(); }
      })().finally(() => { this.refresh = null; });
    }
    return this.refresh;
  }
  async cancelSignIn(): Promise<void> { if (this.state.kind === "signed-in") return; ++this.generation; const handoff = this.handoff; handoff?.controller.abort(); if (handoff) await handoff.done; this.move(SIGNED_OUT); }
  async signOut(): Promise<void> { ++this.generation; this.credentials = null; this.handoff?.controller.abort(); this.move(SIGNED_OUT); await this.writes.run(() => rm(toExtendedLength(this.options.file), { force: true })); }
  async open(page: AccountPage): Promise<void> { const url = page === "account" ? this.options.configuration.accountUrl : this.options.configuration.planUrl; if (this.credentials && url) await this.options.openExternal(url); }
  async stop(): Promise<void> { this.stopped = true; ++this.generation; this.lifetime.abort(); this.handoff?.controller.abort(); await Promise.allSettled([this.handoff?.done, this.refresh]); await this.writes.drain(); this.listeners.clear(); }
}

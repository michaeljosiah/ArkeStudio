import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { AonikAccount } from "../../src/publishing/account.js";
import { parseAonikConfiguration } from "../../src/publishing/config.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { tempDir } from "../tmp.js";

async function waitFor(check: () => boolean) { const until = Date.now() + 10000; while (!check()) { if (Date.now() > until) throw new Error("Account did not settle"); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function fixture(mode: "ok" | "denied" | "waiting" = "ok", timeout = 10000, opening?: Promise<void>) {
  const root = await tempDir("arke-creator-account-"); const cipher = devCipher(); const file = join(root, "account.dat");
  const configuration = parseAonikConfiguration({ apiBaseUrl: "https://api.example.invalid", issuer: "https://identity.example.invalid", clientId: "native-public-client", scope: "openid profile offline_access", tenantId: randomUUID(), channelKey: "test", rightsDeclarationVersion: "fixture", permissionText: "Synthetic fixture permission" });
  const { privateKey, publicKey } = await generateKeyPair("RS256"); const jwk = { ...await exportJWK(publicKey), kid: "test", alg: "RS256", use: "sig" };
  let authorization: URL | undefined; let refreshes = 0; let offline = false; let now = Date.now();
  const secrets: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    const path = new URL(String(input)).pathname;
    if (offline) throw new TypeError("Synthetic offline");
    if (path.endsWith("openid-configuration")) return Response.json({ issuer: configuration.issuer, authorization_endpoint: configuration.issuer + "/authorize", token_endpoint: configuration.issuer + "/token", jwks_uri: configuration.issuer + "/jwks", response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });
    if (path === "/jwks") return Response.json({ keys: [jwk] });
    assert.equal(path, "/token"); const body = new URLSearchParams(String(init?.body));
    assert.equal(body.has("client_secret"), false);
    if (body.get("grant_type") === "refresh_token") { refreshes++; assert.equal(body.get("refresh_token"), "test-refresh"); return Response.json({ access_token: "test-refreshed-access", refresh_token: "test-rotated-refresh", token_type: "Bearer", expires_in: 3600 }); }
    assert.equal(body.get("code"), "test-code"); assert.equal(body.get("redirect_uri"), authorization!.searchParams.get("redirect_uri"));
    assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), authorization!.searchParams.get("code_challenge"));
    const id_token = await new SignJWT({ name: "Synthetic Creator", email: "creator@example.invalid", nonce: authorization!.searchParams.get("nonce") }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(configuration.issuer).setAudience(configuration.clientId).setSubject("creator-123").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    return Response.json({ access_token: "test-access", refresh_token: "test-refresh", token_type: "Bearer", expires_in: 3600, id_token });
  };
  const account = new AonikAccount({ configuration, file, cipher, fetch: fetcher, clock: () => now, secrets: { register: value => secrets.push(value) }, handoffTimeoutMs: timeout,
    openExternal: async url => { authorization = new URL(url); assert.equal(authorization.searchParams.get("code_challenge_method"), "S256"); assert.ok(authorization.searchParams.get("nonce")); const callback = new URL(authorization.searchParams.get("redirect_uri")!); assert.equal(callback.hostname, "127.0.0.1");
      if (opening) { await opening; return; }
      // An unsolicited local request cannot complete or consume the handoff.
      const wrong = new URL(callback); wrong.searchParams.set("state", "wrong"); assert.equal((await fetch(wrong)).status, 400);
      if (mode === "waiting") return;
      callback.searchParams.set("state", authorization.searchParams.get("state")!); callback.searchParams.set(mode === "denied" ? "error" : "code", mode === "denied" ? "access_denied" : "test-code"); assert.equal((await fetch(callback)).status, 200);
    } });
  return { account, file, cipher, configuration, secrets, fetcher, get refreshes() { return refreshes; }, get authorization() { return authorization; }, expire: () => { now += 3600001; }, offline: () => { offline = true; } };
}

describe("native creator account", () => {
  it("uses real OIDC PKCE/nonce checks, encrypts credentials and restores only the configured identity", async () => {
    const h = await fixture(); try { await h.account.signIn(); await waitFor(() => h.account.current().kind === "signed-in"); assert.equal(await h.account.bearer(), "test-access");
      const state = JSON.stringify(h.account.current()); assert.ok(!state.includes("test-access")); assert.ok(!state.includes("test-refresh")); assert.ok(!state.includes("code_verifier")); assert.equal((h.account.current() as { person: { picture: null } }).person.picture, null);
      const saved = await readFile(h.file, "utf8"); assert.ok(!saved.includes("test-access")); assert.ok(h.secrets.includes("test-refresh"));
      const restored = new AonikAccount({ configuration: h.configuration, file: h.file, cipher: h.cipher, openExternal: async () => {} }); await restored.initialise(); assert.equal(restored.actorKey(), h.account.actorKey()); await restored.stop();
      const other = new AonikAccount({ configuration: { ...h.configuration, clientId: "other-client" }, file: h.file, cipher: h.cipher, openExternal: async () => {} }); await other.initialise(); assert.equal(other.current().kind, "signed-out"); await other.stop();
    } finally { await h.account.stop(); }
  });
  it("rotates a refresh token once for concurrent requests and removes protected credentials on sign out", async () => {
    const h = await fixture(); try { await h.account.signIn(); await waitFor(() => h.account.current().kind === "signed-in"); h.expire(); assert.deepEqual(await Promise.all([h.account.bearer(), h.account.bearer()]), ["test-refreshed-access", "test-refreshed-access"]); assert.equal(h.refreshes, 1);
      await h.account.signOut(); assert.equal(h.account.actorKey(), null); await assert.rejects(readFile(h.file), { code: "ENOENT" }); await assert.rejects(h.account.bearer());
    } finally { await h.account.stop(); }
  });
  it("reports denial without reflecting provider errors or credentials", async () => {
    const h = await fixture("denied"); try { await h.account.signIn(); await waitFor(() => h.account.current().kind === "signed-out"); assert.match(JSON.stringify(h.account.current()), /not completed/); await assert.rejects(readFile(h.file)); } finally { await h.account.stop(); }
  });
  it("cancels the loopback listener and drains an outstanding browser handoff", async () => {
    const h = await fixture("waiting"); await h.account.signIn(); await waitFor(() => !!h.authorization); const callback = h.authorization!.searchParams.get("redirect_uri")!;
    await h.account.cancelSignIn(); assert.equal(h.account.current().kind, "signed-out"); await assert.rejects(fetch(callback)); await h.account.stop();
  });
  it("times out an abandoned browser handoff without retaining credentials", async () => {
    const h = await fixture("waiting", 100); try { await h.account.signIn(); await waitFor(() => h.account.current().kind === "signed-out"); assert.match(JSON.stringify(h.account.current()), /timed out/); assert.equal(h.account.actorKey(), null); await assert.rejects(readFile(h.file)); } finally { await h.account.stop(); }
  });
  for (const end of ["cancel", "stop", "timeout"] as const) it(`${end} closes the callback while the OS browser launch is still pending`, async () => {
    let release!: () => void;
    const opening = new Promise<void>(resolve => { release = resolve; });
    const h = await fixture("waiting", end === "timeout" ? 500 : 10000, opening);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await h.account.signIn(); await waitFor(() => !!h.authorization);
      const ended = end === "cancel" ? h.account.cancelSignIn() : end === "stop" ? h.account.stop() : waitFor(() => h.account.current().kind === "signed-out");
      await Promise.race([ended, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Browser launch blocked handoff cancellation")), 2000); })]);
      await assert.rejects(fetch(h.authorization!.searchParams.get("redirect_uri")!));
      assert.equal(h.account.actorKey(), null); await assert.rejects(readFile(h.file), { code: "ENOENT" });
      if (end === "cancel") assert.equal(h.account.current().kind, "signed-out");
      if (end === "timeout") assert.match(JSON.stringify(h.account.current()), /timed out/);
      const state = h.account.current(); release(); await opening; await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(h.account.current(), state, "late browser completion cannot restore a cancelled account");
    } finally {
      clearTimeout(deadline); release();
      // Also release the old implementation's callback so a failed regression can clean up.
      if (h.authorization) { const callback = new URL(h.authorization.searchParams.get("redirect_uri")!); callback.searchParams.set("state", h.authorization.searchParams.get("state")!); callback.searchParams.set("error", "access_denied"); await fetch(callback).catch(() => {}); }
      await h.account.stop();
    }
  });
  it("retains an offline creator identity without claiming a valid session", async () => {
    const h = await fixture(); try { await h.account.signIn(); await waitFor(() => h.account.current().kind === "signed-in"); const actor = h.account.actorKey(); h.expire(); h.offline(); await assert.rejects(h.account.bearer()); assert.equal(h.account.actorKey(), actor); assert.match(JSON.stringify(h.account.current()), /offline/); } finally { await h.account.stop(); }
  });
  it("refuses to sign in when native protected storage is unavailable", async () => {
    const h = await fixture(); const account = new AonikAccount({ configuration: h.configuration, file: h.file, cipher: { ...h.cipher, isAvailable: () => false }, openExternal: async () => { assert.fail("No browser without secure storage"); } });
    try { await account.signIn(); assert.match(JSON.stringify(account.current()), /Secure account storage/); } finally { await account.stop(); await h.account.stop(); }
  });
});

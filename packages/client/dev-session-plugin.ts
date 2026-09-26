import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const LOOPBACK = ["localhost", "127.0.0.1"];

/**
 * Where the browser reaches the coordinator, and where this machine does. They are the same
 * loopback address unless a remote browser is being served through a TLS proxy such as
 * `tailscale serve`. The coordinator itself never leaves loopback: the proxy is what crosses
 * the network, so a remote endpoint must be `wss:` and must name the loopback coordinator it
 * forwards to. A plain `ws:` endpoint on another host would put the capability on the wire.
 */
export function sessionEndpoints(env: Record<string, string | undefined>): { browser: URL; local: URL; origin: string | undefined } {
  const browser = new URL(env.VITE_ARKE_WS ?? "ws://127.0.0.1:8791");
  const origin = env.ARKE_DEV_ORIGIN === undefined ? undefined : new URL(env.ARKE_DEV_ORIGIN).origin;
  if (LOOPBACK.includes(browser.hostname)) return { browser, local: browser, origin };
  if (browser.protocol !== "wss:") throw new Error("A remote VITE_ARKE_WS must use wss: through a TLS proxy.");
  if (!env.ARKE_DEV_LOCAL_WS) throw new Error("A remote VITE_ARKE_WS needs ARKE_DEV_LOCAL_WS, the loopback coordinator it forwards to.");
  if (origin === undefined) throw new Error("A remote VITE_ARKE_WS needs ARKE_DEV_ORIGIN, the address the remote browser opens.");
  const local = new URL(env.ARKE_DEV_LOCAL_WS);
  if (!LOOPBACK.includes(local.hostname)) throw new Error("ARKE_DEV_LOCAL_WS must be a loopback address.");
  return { browser, local, origin };
}

/**
 * The page's policy only lets it reach a loopback coordinator, which is right for the packaged
 * app and would silently refuse a proxied one. Only the dev server, and only for the one
 * coordinator named above, widens it; a build keeps the loopback-only policy.
 */
export function widenPolicy(html: string, browser: URL): string {
  const https = "https://" + browser.host;
  const additions: Record<string, string[]> = { "img-src": [https], "media-src": [https], "object-src": [https],
    "frame-src": [https], "connect-src": [https, "wss://" + browser.host] };
  return html.replace(/(http-equiv="Content-Security-Policy"\s+content=")([^"]*)"/, (_all, head: string, policy: string) =>
    head + policy.split(";").map(part => {
      const name = part.trim().split(/\s+/)[0] ?? "";
      return additions[name] ? part.trimEnd() + " " + additions[name].join(" ") : part;
    }).join(";") + '"');
}

/** The launch capability is handed to the developer in the terminal, never served in public
 * HTML or a bootstrap endpoint. A URL fragment does not go to Vite in an HTTP request. */
export function devSessionPlugin(): Plugin {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  // Read the endpoint as the client bundle does, .env files included, not from process.env alone.
  let endpoint: string | undefined;
  return {
    name: "arke-dev-session",
    apply: "serve",
    config(config) {
      // Vite normally allows the workspace via /@fs/. Do not turn the private handoff into
      // an unauthenticated token endpoint, even when the dev root is packages/client.
      const server: Record<string, unknown> = { fs: { deny: [...(config.server?.fs?.deny ?? [".env", ".env.*", "*.{crt,pem}", "**/.git/**"]), "**/.dev/**"] } };
      // Vite refuses Host headers it does not recognise (DNS rebinding). A proxied browser
      // arrives under the declared origin's name; allow that one name and nothing wider.
      const declared = process.env.ARKE_DEV_ORIGIN ? new URL(process.env.ARKE_DEV_ORIGIN).hostname : undefined;
      if (declared && !LOOPBACK.includes(declared) && config.server?.allowedHosts !== true) server.allowedHosts = [declared];
      return { server };
    },
    configResolved(resolved) { endpoint = resolved.env.VITE_ARKE_WS as string | undefined; },
    transformIndexHtml(html) {
      try {
        const { browser, local } = sessionEndpoints({ ...process.env, VITE_ARKE_WS: endpoint });
        return browser === local ? html : widenPolicy(html, browser);
      } catch { return html; } // The listening hook reports a misconfiguration; the page keeps its policy.
    },
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        let endpoints: ReturnType<typeof sessionEndpoints>;
        try { endpoints = sessionEndpoints({ ...process.env, VITE_ARKE_WS: endpoint }); }
        catch (error) { server.config.logger.warn("Arke session link not printed: " + (error as Error).message); return; }
        void (async () => {
          const { browser, local } = endpoints;
          const port = Number(local.port);
          const session = JSON.parse(await readFile(resolve(root, ".dev", "transport-" + port + ".json"), "utf8")) as { port: number; token: string };
          if (session.port !== port || !/^[a-f0-9]{64}$/.test(session.token)) throw new Error("invalid session");
          const address = server.httpServer?.address();
          if (!address || typeof address === "string") return;
          const origin = endpoints.origin ?? "http://localhost:" + address.port;
          // A handoff can outlive its server or belong to another checkout. Authenticate a
          // bodyless request before printing it; never send the capability through a redirect.
          // A proxied endpoint is probed through the proxy, so the link is only printed once
          // the path the remote browser will take has accepted it.
          const probe = new URL("/session", browser.origin);
          probe.protocol = browser.protocol === "wss:" ? "https:" : "http:";
          const response = await fetch(probe, { method: "HEAD", redirect: "error",
            headers: { Authorization: "Bearer " + session.token, Origin: origin }, signal: AbortSignal.timeout(3000) });
          if (response.status !== 204 || response.headers.get("X-Arke-Session") !== "authenticated") throw new Error("session was not accepted");
          server.config.logger.info("Arke session: " + origin + "/#/?arke-session=" + session.token);
        })().catch(() => server.config.logger.warn("Could not verify the Arke session. Start your Studio server from this checkout, check VITE_ARKE_WS and the allowed browser origin, then restart the frontend for a fresh link."));
      });
    },
  };
}

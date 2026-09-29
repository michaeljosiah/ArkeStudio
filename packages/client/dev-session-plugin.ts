import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, type Plugin } from "vite";

const LOOPBACK = ["localhost", "127.0.0.1"];

export interface SessionEndpoints {
  /** Where the browser reaches the coordinator. */
  browser: URL;
  /** Where this machine reaches it; its port names the handoff file. */
  local: URL;
  /** The page's origin, when it is not Vite's own loopback address. */
  origin: string | undefined;
  /** True when a remote browser reaches both through a TLS proxy. */
  proxied: boolean;
}

/**
 * Where the browser reaches the coordinator, and where this machine does. They are the same
 * loopback address unless a remote browser is being served through a TLS proxy such as
 * `tailscale serve`. The coordinator itself never leaves loopback: the proxy is what crosses
 * the network, so a proxied setup is `wss:` to the coordinator and `https:` for the page, and
 * names the loopback coordinator the proxy forwards to. Either half in the clear would let the
 * capability, or a script that reads it, travel the network unencrypted.
 */
export function sessionEndpoints(env: Record<string, string | undefined>): SessionEndpoints {
  const browser = new URL(env.VITE_ARKE_WS ?? "ws://127.0.0.1:8791");
  const origin = env.ARKE_DEV_ORIGIN === undefined ? undefined : new URL(env.ARKE_DEV_ORIGIN).origin;
  const remoteOrigin = origin !== undefined && !LOOPBACK.includes(new URL(origin).hostname);
  if (env.ARKE_DEV_LOCAL_WS === undefined) {
    if (!LOOPBACK.includes(browser.hostname)) {
      if (browser.protocol !== "wss:") throw new Error("A remote VITE_ARKE_WS must use wss: through a TLS proxy.");
      throw new Error("A remote VITE_ARKE_WS needs ARKE_DEV_LOCAL_WS, the loopback coordinator it forwards to.");
    }
    // A remote page with a loopback coordinator verifies here and fails on the other device,
    // which would dial its own loopback.
    if (remoteOrigin) throw new Error("A remote ARKE_DEV_ORIGIN needs a proxied wss: VITE_ARKE_WS and ARKE_DEV_LOCAL_WS.");
    return { browser, local: browser, origin, proxied: false };
  }
  if (browser.protocol !== "wss:") throw new Error("A proxied VITE_ARKE_WS must use wss: through a TLS proxy.");
  if (origin === undefined) throw new Error("A proxied VITE_ARKE_WS needs ARKE_DEV_ORIGIN, the https: address the remote browser opens.");
  if (!origin.startsWith("https:")) throw new Error("ARKE_DEV_ORIGIN must be https: when the page is proxied.");
  const local = new URL(env.ARKE_DEV_LOCAL_WS);
  if (local.protocol !== "ws:" || !LOOPBACK.includes(local.hostname) || local.port === "") {
    throw new Error("ARKE_DEV_LOCAL_WS must be a loopback ws: address with its port.");
  }
  return { browser, local, origin, proxied: true };
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
  // Decided once, so the allowed hosts, the page policy and the printed link cannot disagree
  // about whether this is a proxied session.
  let setup: { endpoints: SessionEndpoints } | { refused: string };
  return {
    name: "arke-dev-session",
    apply: "serve",
    config(config, { mode }) {
      // Read the endpoint as the client bundle does, .env files included, not from process.env alone.
      const envDir = config.envDir === false ? false : resolve(config.root ?? process.cwd(), config.envDir ?? "");
      try { setup = { endpoints: sessionEndpoints({ ...process.env, VITE_ARKE_WS: loadEnv(mode, envDir, "VITE_").VITE_ARKE_WS }) }; }
      catch (error) { setup = { refused: (error as Error).message }; }
      // Vite normally allows the workspace via /@fs/. Do not turn the private handoff into
      // an unauthenticated token endpoint, even when the dev root is packages/client.
      const server: Record<string, unknown> = { fs: { deny: [...(config.server?.fs?.deny ?? [".env", ".env.*", "*.{crt,pem}", "**/.git/**"]), "**/.dev/**"] } };
      // Vite refuses Host headers it does not recognise (DNS rebinding). A proxied browser
      // arrives under the declared origin's name; allow that one name, and only for a proxied
      // session this plugin has accepted.
      if ("endpoints" in setup && setup.endpoints.proxied) {
        if (config.server?.allowedHosts !== true) server.allowedHosts = [new URL(setup.endpoints.origin!).hostname];
        // Vite itself asks no capability of anyone, and its /@fs/ reaches the whole workspace.
        // On loopback that is only this machine; through the proxy it is every tailnet device.
        // Serve what the page is built from and nothing else of the checkout.
        (server.fs as Record<string, unknown>).allow = ["packages/client", "packages/contracts", "node_modules"].map(path => resolve(root, path));
      }
      return { server };
    },
    transformIndexHtml(html) {
      return "endpoints" in setup && setup.endpoints.proxied ? widenPolicy(html, setup.endpoints.browser) : html;
    },
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        if ("refused" in setup) { server.config.logger.warn("Arke session link not printed: " + setup.refused); return; }
        const { endpoints } = setup;
        const { browser, local } = endpoints;
        void (async () => {
          const port = Number(local.port);
          const session = JSON.parse(await readFile(resolve(root, ".dev", "transport-" + port + ".json"), "utf8")) as { port: number; token: string };
          if (session.port !== port || !/^[a-f0-9]{64}$/.test(session.token)) throw new Error("invalid session");
          const address = server.httpServer?.address();
          if (!address || typeof address === "string") return;
          const origin = endpoints.origin ?? "http://localhost:" + address.port;
          // A handoff can outlive its server or belong to another checkout. Authenticate a
          // bodyless request before printing it; never send the capability through a redirect.
          // A proxied coordinator is probed through the proxy, the route the browser's socket
          // and media will take. The page's own route is not probed here.
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

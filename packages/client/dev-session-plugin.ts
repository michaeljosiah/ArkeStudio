import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** The launch capability is handed to the developer in the terminal, never served in public
 * HTML or a bootstrap endpoint. A URL fragment does not go to Vite in an HTTP request. */
export function devSessionPlugin(): Plugin {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  return {
    name: "arke-dev-session",
    apply: "serve",
    config(config) {
      // Vite normally allows the workspace via /@fs/. Do not turn the private handoff into
      // an unauthenticated token endpoint, even when the dev root is packages/client.
      return { server: { fs: { deny: [...(config.server?.fs?.deny ?? [".env", ".env.*", "*.{crt,pem}", "**/.git/**"]), "**/.dev/**"] } } };
    },
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        void (async () => {
          const endpoint = new URL(server.config.env.VITE_ARKE_WS ?? "ws://127.0.0.1:8791");
          if (!["localhost", "127.0.0.1"].includes(endpoint.hostname)) throw new Error("Arke dev coordinator must be local");
          const port = Number(endpoint.port);
          const session = JSON.parse(await readFile(resolve(root, ".dev", "transport-" + port + ".json"), "utf8")) as { port: number; token: string };
          if (session.port !== port || !/^[a-f0-9]{64}$/.test(session.token)) throw new Error("invalid session");
          const address = server.httpServer?.address();
          if (!address || typeof address === "string") return;
          const origin = process.env.ARKE_DEV_ORIGIN ?? "http://localhost:" + address.port;
          server.config.logger.info("Arke session: " + origin + "/#/?arke-session=" + session.token);
        })().catch(() => server.config.logger.warn("Start npm run dev:coordinator first, then restart Vite for an Arke session link."));
      });
    },
  };
}

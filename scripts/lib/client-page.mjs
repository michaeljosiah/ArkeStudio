// The client as a local page for the smoke scripts (issue 2813): its stylesheets, a bundle of an
// entry the script writes, and a server for the folder they land in.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** The client's stylesheet imports, as main.tsx orders them: paste them into an entry. */
export async function clientStyles() {
  const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
  return [...main.matchAll(/^import "([^"\n]+\.css)";/gm)].map(match => match[0]).join("\n");
}

/**
 * Vite's `?url` imports (the pdf.js worker) as the file's path: esbuild has no such suffix, and
 * every page that reaches the story preview fails to build without it.
 */
export const urlAssets = { name: "url-assets", setup(builder) {
  builder.onResolve({ filter: /\?url$/ }, args => ({ path: createRequire(import.meta.url).resolve(args.path.slice(0, -4)), namespace: "url-asset" }));
  builder.onLoad({ filter: /.*/, namespace: "url-asset" }, args => ({ contents: JSON.stringify(args.path), loader: "text" }));
} };

/**
 * Bundles `contents`, a tsx entry resolved from the client's src folder, into `dir` as view.js
 * and view.css, and writes an index.html that loads them into `#root`. An ES module, not an IIFE:
 * the App has awaited at its top level since its routes became lazy, which an IIFE cannot hold.
 */
export async function buildClientPage(dir, contents) {
  await build({
    stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents },
    bundle: true, platform: "browser", format: "esm", define: { "import.meta.env": "{}" },
    external: ["/*.webp", "/*.png"], loader: { ".woff": "file", ".woff2": "file" }, outfile: join(dir, "view.js"),
    plugins: [urlAssets],
  });
  await writeFile(join(dir, "index.html"), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<link rel="stylesheet" href="view.css"><div id="root"></div><script type="module" src="view.js"></script>');
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff": "font/woff", ".woff2": "font/woff2" };

/** Serves `dir` on a loopback port, and nothing outside it. `close()` stops the server. */
export async function servePage(dir) {
  const server = createServer(async (request, response) => {
    try {
      const path = resolve(dir, decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1) || "index.html");
      const inside = relative(dir, path);
      if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("outside the page's folder");
      response.setHeader("Content-Type", TYPES[extname(path)] ?? "application/octet-stream");
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

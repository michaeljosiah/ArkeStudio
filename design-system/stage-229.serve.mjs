// Read-only loopback server for turn 229's stage renders: the design-system folder plus three.js
// from node_modules, so stage-229.render.html can import it without a CDN.
//   node design-system/stage-229.serve.mjs   (DESIGN_PORT picks the port)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
// three exports no package.json subpath; its main entry sits in build/, one level under the package.
const three = path.dirname(path.dirname(createRequire(import.meta.url).resolve('three')));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
export function createStageServer() {
  return http.createServer((req, res) => {
    let requested;
    try { requested = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).slice(1) || 'stage-229.render.html'; } catch { res.writeHead(400); res.end(); return; }
    const root = requested.startsWith('three/') ? three : here;
    const file = path.resolve(root, requested.startsWith('three/') ? requested.slice(6) : requested);
    const relative = path.relative(root, file);
    if (!['GET', 'HEAD'].includes(req.method) || relative.startsWith('..') || path.isAbsolute(relative) || !types[path.extname(file)]) { res.writeHead(404); res.end(); return; }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createStageServer();
  server.listen(Number(process.env.DESIGN_PORT) || 0, '127.0.0.1', () => console.log(`Stage renders: http://127.0.0.1:${server.address().port}/stage-229.render.html`));
}

// Read-only loopback preview. Only design assets and two public client styles are served.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/plain' };
const clientFiles = new Map([
  ['/packages/client/src/theme/tokens/colors.css', path.join(here, '../packages/client/src/theme/tokens/colors.css')],
  ['/packages/client/src/components/model-chip.css', path.join(here, '../packages/client/src/components/model-chip.css')],
]);
http.createServer((req, res) => {
  let requested;
  try { requested = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
  catch { res.writeHead(400); res.end(); return; }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  const leaf = requested.replace(/^\/design-system\//, '').replace(/^\//, '') || 'audio-studio.review.html';
  const file = clientFiles.get(requested) ?? path.resolve(here, leaf);
  const relative = path.relative(here, file);
  const ext = path.extname(file);
  if ((!clientFiles.has(requested) && (relative.startsWith('..') || path.isAbsolute(relative))) || !types[ext] || ext === '.md' && leaf !== 'audio-studio.notes.md') {
    res.writeHead(404); res.end(); return;
  }
  fs.readFile(file, (error, bytes) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[ext] + (['.html', '.css', '.js', '.md'].includes(ext) ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
}).listen(Number(process.argv[2] ?? process.env.PORT ?? 8795), '127.0.0.1', function () {
  console.log(`Audio Studio review: http://127.0.0.1:${this.address().port}/design-system/audio-studio.review.html`);
});

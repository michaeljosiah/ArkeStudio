// Serves only newly authored turns 242–244 and their current application assets.
// The design master and all earlier review pages are deliberately outside this preview.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const names=['install-journeys.review.html','install-journeys.css','install-journeys.prototype.mjs','install-journeys.frames.mjs','install-journeys.icons.mjs','install-journeys.notes.md'];
const allowed=new Map(names.map(n=>['/design-system/'+n,path.join(here,n)]));
allowed.set('/',path.join(here,'install-journeys.review.html'));
for(const n of ['src/screens/launch.css','src/theme/tokens/launch.css','public/launch-creation.webp'])allowed.set('/packages/client/'+n,path.join(root,'packages/client',n));
const tokens='_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
for(const n of ['fonts','colors','typography','spacing','effects'])allowed.set('/design-system/'+tokens+'/'+n+'.css',path.join(here,tokens,n+'.css'));
for(const n of fs.readdirSync(path.join(here,'_ds/fonts')).filter(n=>n.endsWith('.woff2')))allowed.set('/design-system/_ds/fonts/'+n,path.join(here,'_ds/fonts',n));
const types={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.woff2':'font/woff2','.webp':'image/webp','.md':'text/plain'};
http.createServer((req,res)=>{let name;try{name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}const file=allowed.get(name);if(!file){res.writeHead(404).end('Not part of the installation-journey preview.');return;}try{res.writeHead(200,{'Content-Type':types[path.extname(file)]??'text/plain','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(fs.readFileSync(file));}catch{res.writeHead(404).end();}}).listen(4242,'127.0.0.1',()=>console.log('Install design turns: http://127.0.0.1:4242/design-system/install-journeys.review.html'));

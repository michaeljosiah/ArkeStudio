// Read-only loopback preview of public design assets. No app data or provider access.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const types = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.md':'text/plain'};
const extra = new Map([
 ['/docs/research/audio-drama-adaptation.md', path.join(here,'../docs/research/audio-drama-adaptation.md')],
 ['/packages/client/src/theme/tokens/colors.css', path.join(here,'../packages/client/src/theme/tokens/colors.css')],
 ['/packages/client/src/components/model-chip.css', path.join(here,'../packages/client/src/components/model-chip.css')],
]);
http.createServer((req,res)=>{
 let requested;
 try{requested=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{res.writeHead(400).end();return;}
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
 const file=extra.get(requested)??path.resolve(here,requested.replace(/^\/design-system\//,'').replace(/^\//,'')||'audio-drama-228.review.html');
 const relative=path.relative(here,file), ext=path.extname(file);
 if((!extra.has(requested)&&(relative.startsWith('..')||path.isAbsolute(relative)))||!types[ext]){res.writeHead(404).end();return;}
 fs.readFile(file,(error,bytes)=>{if(error){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':types[ext],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);});
}).listen(Number(process.argv[2]??8796),'127.0.0.1',function(){console.log(`Audio Drama review: http://127.0.0.1:${this.address().port}/design-system/audio-drama-228.review.html`);});

// Read-only loopback design server. No world or application files are exposed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const files=new Set(['branch-map-state-240.review.html','branch-map-state-240.css','branch-map-state-240.view.mjs','branch-map-state-240.prototype.mjs','branch-map-state-240.notes.md','Arke Studio.dc.html','design-review.html','support.js','theme-switch.js','image-slot.js']);
const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.md':'text/plain; charset=utf-8','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{let requested;try{requested=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname).slice(1)||'branch-map-state-240.review.html';}catch{res.writeHead(400);res.end();return;}const file=path.resolve(here,requested),relative=path.relative(here,file),type=types[path.extname(file)];if(!['GET','HEAD'].includes(req.method)||!(files.has(requested)||requested.startsWith('_ds/')||requested.startsWith('assets/'))||relative.startsWith('..')||path.isAbsolute(relative)||!type){res.writeHead(404);res.end();return;}fs.stat(file,(err,info)=>{if(err||!info.isFile()){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});if(req.method==='HEAD')res.end();else fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);});});
server.listen(Number(process.env.DESIGN_PORT)||0,'127.0.0.1',()=>console.log('Design turn 240: http://127.0.0.1:'+server.address().port+'/branch-map-state-240.review.html'));

// New-turn preview only. Never serves the master, consolidated review or turn 239.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const types={'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.woff2':'font/woff2','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
const allowed=new Set(['system-status-240.review.html','system-status-240.native-review.html','system-status-240.prototype.mjs','system-status-240.frames.mjs','system-status-240.references.mjs','system-status-240.css','chapter-page-227.css','system-status-240.notes.md']);
http.createServer((req,res)=>{
  let name;try{name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'');}catch{res.writeHead(400).end();return;}
  if(!name)name='system-status-240.review.html';
  if(name==='system-status-240.native.html'){
    try{res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'}).end(fs.readFileSync(path.join(here,'../.dev/system-status-240/native.html')));}catch{res.writeHead(404).end();}return;
  }
  const file=path.resolve(here,name),relative=path.relative(here,file);
  const font=name.startsWith('_ds/fonts/')&&path.extname(name)==='.woff2';
  if(relative.startsWith('..')||path.isAbsolute(relative)||!allowed.has(name)&&!name.startsWith('assets/')&&!font&&!name.startsWith('_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens/')){res.writeHead(403).end('This preview serves only new turn 240 and its assets.');return;}
  try{const data=fs.readFileSync(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]??'application/octet-stream','Cache-Control':'no-store'}).end(data);}catch{res.writeHead(404).end();}
}).listen(4240,'127.0.0.1',()=>console.log('New turn 240 only: http://127.0.0.1:4240/system-status-240.review.html'));

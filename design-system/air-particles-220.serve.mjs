// Read-only loopback server for public design drawings; no application or world access.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const roots=new Set(['air-particles-220.native.mjs','air-particles-220.native.css','air-particles-220.native-prototype.mjs','air-particles-220.review.html','air-particles-220.css','air-particles-220.prototype.mjs','air-particles-220.view.mjs','air-particles-220.renderer.mjs','air-particles-220.physics.mjs','Arke Studio.dc.html','design-review.html','support.js','theme-switch.js','image-slot.js']);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2'};
export function createDesignServer(){
  return http.createServer((req,res)=>{
    let requested;
    try{requested=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname).slice(1)||'air-particles-220.review.html';}catch{res.writeHead(400);res.end();return;}
    const file=path.resolve(here,requested),relative=path.relative(here,file),ext=path.extname(file);
    const allowed=roots.has(requested)||requested.startsWith('_ds/')||requested.startsWith('assets/');
    if(!['GET','HEAD'].includes(req.method)||!allowed||relative.startsWith('..')||path.isAbsolute(relative)||!types[ext]){res.writeHead(404);res.end();return;}
    fs.stat(file,(err,stat)=>{
      if(err||!stat.isFile()){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'Content-Type':types[ext],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      if(req.method==='HEAD')res.end();else fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
    });
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=createDesignServer();server.listen(Number(process.env.DESIGN_PORT)||0,'127.0.0.1',()=>console.log(`Design review: http://127.0.0.1:${server.address().port}/air-particles-220.review.html`));
}

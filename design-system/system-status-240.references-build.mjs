// Source capture only. This never opens or renders the design master.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const master=fs.readFileSync(path.join(here,'Arke Studio.dc.html'),'utf8');
const {document}=parseHTML(master);
const snapshots={};
for(const [device,id] of Object.entries({desktop:'227a',tablet:'227k',phone:'227m'})){
  const frame=document.querySelector(`#${id} .dv-card>div`).cloneNode(true);
  frame.removeAttribute('data-screen-label');frame.style.width='100%';frame.style.height='100%';
  // The 227m drawing is content-only; restore the existing AppChrome titlebar above it.
  if(device==='phone')frame.insertAdjacentHTML('afterbegin','<header class="tb s240-phone-chrome"><button type="button" class="s240-phone-back" aria-label="Back to chapters"><!--system-status-back-->Chapters</button><span class="util"><!--system-status-controls--></span></header>');
  else frame.querySelector('.tb .util').innerHTML='<!--system-status-controls-->';
  snapshots[device]=frame.outerHTML;
}
const iconsSource='packages/client/src/components/icons.tsx';
const iconsPath=path.join(root,iconsSource);
const names={system:'Cpu',chat:'Message',activity:'Bell',settings:'Cog',account:'User',close:'X',back:'ChevronLeft',refresh:'RefreshCw',warning:'TriangleAlert',cloud:'Cloud',storage:'Folder',next:'ArrowRight'};
const out=path.join(root,'.dev/system-status-240/native-icons.cjs');
await build({stdin:{resolveDir:root,loader:'tsx',contents:`import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import*as Icons from ${JSON.stringify(iconsPath)};export const icons=Object.fromEntries(Object.entries(${JSON.stringify(names)}).map(([key,name])=>[key,renderToStaticMarkup(React.createElement(Icons[name],{size:16}))]));`},bundle:true,platform:'node',format:'cjs',jsx:'automatic',nodePaths:[path.dirname(path.dirname(createRequire(import.meta.url).resolve('react/package.json')))],outfile:out});
const nativeIcons=createRequire(import.meta.url)(out).icons;
snapshots.phone=snapshots.phone.replace('<!--system-status-back-->',nativeIcons.back);
const receipt={masterFrames:['227a','227k','227m'],shell:'206b Activity / 239 approved geometry: 12px corners, 440px desktop width, full border and shadow-lg',iconsSource,iconsSha256:createHash('sha256').update(fs.readFileSync(iconsPath)).digest('hex'),names};
fs.writeFileSync(path.join(here,'system-status-240.references.mjs'),'// Existing 227 writing-room drawings; current client icons. Source snapshots only.\nexport const references='+JSON.stringify(snapshots)+';\nexport const nativeIcons='+JSON.stringify(nativeIcons)+';\nexport const receipt='+JSON.stringify(receipt,null,2)+';\n');
console.log('Captured 227a/k/m page sources and current native icons for new turn 241. No master rendering.');

import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=process.argv[2]?path.resolve(process.argv[2]):path.resolve(here,'..');
const source=fs.readFileSync(path.join(root,'design-system/Arke Studio.dc.html'),'utf8');
const {document}=parseHTML(source);
function frame(id){const e=document.querySelector(`#${id} .dv-card>div`);if(!e)throw new Error(id);const clone=e.cloneNode(true);clone.removeAttribute('data-screen-label');clone.style.width='100%';clone.style.height='100%';if(id.startsWith('227')){const util=clone.querySelector('.tb .util');if(util)util.innerHTML=[['chat','Open Arke','open'],['inbox','Proposals','proposals'],['bell','Activity','activity'],['settings','Settings','settings'],['account','Account','account']].map(([name,label,action])=>'<button type="button" aria-label="'+label+'" data-action="'+action+'">'+nativeIcons[name]+'</button>').join('');}return clone.outerHTML;}
const iconsPath=path.join(root,'packages/client/src/components/icons.tsx');
const composer=fs.readFileSync(path.join(root,'packages/client/src/components/composer.tsx'),'utf8');
const send=composer.slice(composer.indexOf('className="fy-cx__send"')).match(/<svg[\s\S]*?<\/svg>/)[0];
const names={chat:'Message',bell:'Bell',settings:'Cog',inbox:'Inbox',account:'User',close:'X',plus:'Plus',mic:'Mic',speaker:'Speaker',chevron:'ChevronDown',back:'ChevronLeft',history:'ListBullet',storage:'Folder',health:'Cpu',help:'Help',warning:'TriangleAlert',studio:'Monitor',check:'Check',next:'ArrowRight'};
const out=path.join(root,'.dev/global-chat-239/native-icons.cjs');
await build({stdin:{resolveDir:root,loader:'tsx',contents:`import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import*as Icons from ${JSON.stringify(iconsPath)};export const icons=Object.fromEntries(Object.entries(${JSON.stringify(names)}).map(([key,name])=>[key,renderToStaticMarkup(React.createElement(Icons[name],{size:16}))]));icons.arrow=renderToStaticMarkup(${send});`},bundle:true,platform:'node',format:'cjs',jsx:'automatic',nodePaths:[path.dirname(path.dirname(createRequire(import.meta.url).resolve('react/package.json')))],outfile:out});
const nativeIcons=createRequire(import.meta.url)(out).icons;
const start=source.indexOf('.v206{'),end=source.indexOf('/* Turn 208:',start);
if(start<0||end<0)throw new Error('Missing notification reference CSS');
fs.writeFileSync(path.join(root,'design-system/global-chat-239.reference.css'),source.slice(start,end));
const snapshots={desktop:frame('227a'),phone:frame('227m'),tablet:frame('227k'),notification:frame('206b')};
const receipt={masterFrames:['227a','227m','227k','206b'],iconsSource:'packages/client/src/components/icons.tsx',iconsSha256:createHash('sha256').update(fs.readFileSync(iconsPath)).digest('hex'),composerSource:'packages/client/src/components/composer.tsx'};
fs.writeFileSync(path.join(root,'design-system/global-chat-239.references.mjs'),'// Current master frame snapshots and icons rendered from the client icon components.\nexport const references='+JSON.stringify(snapshots)+';\nexport const nativeIcons='+JSON.stringify(nativeIcons)+';\nexport const receipt='+JSON.stringify(receipt,null,2)+';\n');
console.log('Captured current 227a/227m/227k/206b drawings and '+Object.keys(nativeIcons).length+' native icons; no new glyphs.');

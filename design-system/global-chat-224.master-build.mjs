// A reading of the restored master, not redrawn samples.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {parseHTML} from 'linkedom';
const here=path.dirname(fileURLToPath(import.meta.url)),out=path.resolve(here,'../.dev/global-chat-design/native');
const master=fs.readFileSync(path.join(here,'Arke Studio.dc.html'),'utf8');const {document}=parseHTML(master);
// The master keeps its shared drawing stylesheet in the body, before the turn sections.
const css=[...document.querySelectorAll('style')].filter(e=>e.textContent.includes('.v195')).map(e=>e.textContent).join('\n');
const tokens=[...document.querySelectorAll('link[rel=stylesheet]')].map(e=>e.getAttribute('href')).filter(p=>p.startsWith('_ds/')&&p.endsWith('.css')).map(file=>{const p=path.join(here,file);return fs.readFileSync(p,'utf8').replace(/url\("([^"\)]+)"\)/g,(match,asset)=>asset.endsWith('.woff2')?`url("data:font/woff2;base64,${fs.readFileSync(path.resolve(path.dirname(p),asset)).toString('base64')}")`:match);}).join('\n');
const turn=document.getElementById('t195');if(!turn)throw Error('Restore 195 before building the comparison');
const nativeTurn=turn.outerHTML.replace(/src="(assets\/[^\"]+)"/g,(_,file)=>`src="data:image/${file.endsWith('.ico')?'x-icon':file.endsWith('.png')?'png':'webp'};base64,${fs.readFileSync(path.join(here,file)).toString('base64')}"`);
const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${tokens}\n${css}</style><style>body{margin:0;padding:24px;background:var(--background);color:var(--foreground);font:var(--type-body)}.dv-turn{margin-top:0}.dv-opts{flex-direction:column}.dv-opt{flex:none}.dv-card{overflow:auto}.dv-thd{margin-bottom:20px}</style></head><body>${nativeTurn}</body></html>`;
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'master-195.html'),html);
console.log('Built all seven restored master frames');

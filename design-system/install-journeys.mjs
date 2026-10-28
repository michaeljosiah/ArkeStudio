// Draft turns only. Source reading never opens/renders an earlier design turn.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, data) => fs.writeFileSync(path.join(here, name), data);
const names = {laptop:'Laptop',settings:'Sliders',folder:'Folder',next:'ArrowRight',check:'Check',cpu:'Cpu',mic:'Mic',cloud:'Cloud',warning:'TriangleAlert',download:'Download',plus:'Plus',upload:'Upload',book:'Book',chat:'Message',bell:'Bell',cog:'Cog',user:'User'};
const out = path.join(root, '.dev/install-journeys/native-icons.cjs');
const iconSource = path.join(root, 'packages/client/src/components/icons.tsx');
await build({stdin:{resolveDir:root,loader:'tsx',contents:`import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import*as Icons from ${JSON.stringify(iconSource)};export const icons=Object.fromEntries(Object.entries(${JSON.stringify(names)}).map(([k,n])=>[k,renderToStaticMarkup(React.createElement(Icons[n],{size:18}))]));`},bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:out});
const icons = createRequire(import.meta.url)(out).icons;
const sources = ['packages/client/src/components/icons.tsx','packages/client/src/screens/launch.tsx','packages/client/src/screens/launch.css','packages/client/src/theme/tokens/launch.css','packages/client/public/launch-creation.webp','packages/client/src/screens/shell.tsx','packages/client/src/screens/fidelity.css','packages/client/src/screens/home.css','packages/client/src/components/chrome.tsx'];
const receipt = Object.fromEntries(sources.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
write('install-journeys.icons.mjs', `// Generated from current client components. Do not draw replacement icon paths.\nexport const icons=${JSON.stringify(icons)};\nexport const sourceReceipt=${JSON.stringify(receipt,null,2)};\n`);
const {FRAMES,TURNS,esc} = await import('./install-journeys.frames.mjs');
// Copy the current Worlds rules under a preview-only scope. Do not restyle earlier turns.
const homeCss=fs.readFileSync(path.join(root,'packages/client/src/screens/fidelity.css'),'utf8');
const homeSelectors=['fy-app','fy-content','fy-titlebar','fy-titlebar__side','fy-titlebar__side--right','fy-titlebar__brand','fy-brand__arke','fy-brand__studio','fy-iconbtn','fy-home-hero','fy-hero__eyebrow','fy-hero__title','fy-hero__title--home','fy-hero__lede','fy-home-cards','fy-worldcard','fy-worldcard__frame','fy-worldcard__empty','fy-worldcard__name','fy-newworldcard'];
write('install-journeys.worlds.css','/* Generated from current fidelity.css; scoped to the new Worlds drawing. */\n'+homeSelectors.map(name=>{const match=homeCss.match(new RegExp('^\\.'+name+'\\s*\\{([^}]+)\\}','m'));if(!match)throw new Error('Missing Worlds rule '+name);return '.ij-worlds .'+name+'{'+match[1]+'}';}).join('\n'));
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const styles = ['../packages/client/src/theme/tokens/launch.css','../packages/client/src/screens/launch.css','install-journeys.worlds.css','install-journeys.css'];
const links = styles.map(file=>`<link rel="stylesheet" href="${file}">`).join('\n');
const matrix = `<section class="ij-matrix"><h2>What gets installed, and when can I begin?</h2><table><thead><tr><th>Decision</th><th>Guided</th><th>Advanced</th><th>Lightweight</th></tr></thead><tbody>
<tr><th>Base installer · all paths</th><td colspan="3">The same desktop app: editor, coordinator, OpenCode v2, Voxa, media tools, native index and included sample. Current Windows qualification build: about 358 MB download; installed size is larger. This is a dated baseline, not a promised future release size.</td></tr>
<tr><th>Additional default downloads</th><td>Choose cloud or local writing with included OpenCode. Local adds managed Ollama + a compatible starter model; cloud connects a provider instead. Kokoro / Whisper and managed ComfyUI remain selected on supported hardware. Review the complete package first.</td><td>Only selected capabilities and their missing dependencies. OpenCode offers the same cloud/local writing choice. Detected Claude Code or Codex can be explicitly selected; their routes do not require Ollama.</td><td>None. No local AI engines or model weights downloaded automatically.</td></tr>
<tr><th>Optional</th><td>Image/video weights, voice cloning, larger text models, provider connections and remote access.</td><td>Each capability, model, provider and supported override can be selected or omitted.</td><td>Every AI capability; local or hosted. Add one when useful.</td></tr>
<tr><th>Before entering Arke</th><td colspan="3">Core running and a valid writable workspace. World creation, editing and saving work. No account, GPU or AI model is required for manual authoring.</td></tr>
<tr><th>Before claiming AI ready</th><td>Cloud writing: authenticated provider and a checked selected model. Local writing: healthy Ollama and a ready, responding model. Other selected components pass their own checks.</td><td>The same writing checks, with compatibility/account checks for an existing harness. Only selected capabilities affect their own readiness.</td><td>Not applicable until AI is added. Each selected capability then follows the same checks.</td></tr>
<tr><th>Next launch</th><td>Open the saved workspace, recheck enabled services and show paused downloads. Resume explicitly.</td><td>Keep selected sources, folders and models. Existing services stay user-managed.</td><td>Open the workspace; do not install or launch unselected AI services.</td></tr>
</tbody></table></section>`;
const maps = {
  242:['Download Arke','Install & launch','Set it up for me','Cloud provider or local Ollama model','Connect / review downloads','Install / verify','Worlds landing'],
  243:['Same installer','Choose my setup','Select harness & capabilities','OpenCode: cloud or local','Choose sources & locations','Review / check','Worlds landing'],
  244:['Same installer','Start lightweight','Check workspace','Worlds: create / import / sample','Use manual tools','Add AI when needed'],
};
const rules = t => t.rules.map(([title,text],i)=>`<p class="dv-rule"><b>${i+1} · ${esc(title)}.</b> ${esc(text)}</p>`).join('\n');
const reviewTurns = TURNS.map(t=>`<section id="turn${t.id}"><h2>Turn ${t.id} · ${esc(t.title)}</h2><p>Draft · proposed journey, not implemented behaviour.</p><div class="ij-map">${maps[t.id].map(x=>`<span>${esc(x)}</span>`).join('<b aria-hidden="true">→</b>')}</div>${t.keys.map(key=>{const f=FRAMES.find(f=>f.key===key);return `<article class="ij-frame" id="${f.id}"><h3>${f.id} · ${esc(f.title)}</h3><div class="ij-fit" data-width="${f.width}" data-height="${f.height}"><div class="ij-scale" style="width:${f.width}px;height:${f.height}px">${f.markup}</div></div></article>`;}).join('\n')}<details><summary>Journey decisions &amp; implementation boundaries</summary>${rules(t)}</details></section>`).join('\n');
write('install-journeys.review.html',`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arke · Installation journeys · Turns 242–244</title>${['fonts','colors','typography','spacing','effects'].map(x=>`<link rel="stylesheet" href="${tokens}/${x}.css">`).join('')}${links}</head>
<body class="ij-review"><header><div class="ij-kicker">ARKE STUDIO · DESIGN TURNS 242–244 · DRAFT · REVISION 3 · 28 OCTOBER 2026</div><h1>Three ways in. One studio.</h1><p>A proposed first-run journey for people who want Arke to handle setup, people who want control, and people who want to start with a small footprint. Built on Arke’s current launch design, assets, type and icons.</p><p><strong>Design preview.</strong> All detected installations, downloads, locations, free space, progress and readiness shown below are illustrative. Controls navigate the proposal; they do not install, connect to services or change your configuration.</p><nav class="ij-toolbar"><a href="#turn242">242 · Guided</a><a href="#turn243">243 · Advanced</a><a href="#turn244">244 · Lightweight</a><a href="install-journeys.notes.md">Journey notes</a><button type="button" id="ij-theme">Review light / dark</button></nav></header>
<main><section><h2>Walk through the proposed setup</h2><div class="ij-toolbar" id="ij-controls"><button data-preview="choose" aria-pressed="true">Choose a setup</button><button data-preview="242f" aria-pressed="false">Guided</button><button data-preview="243e" aria-pressed="false">Advanced</button><button data-preview="244a" aria-pressed="false">Lightweight</button><button data-preview="242d" aria-pressed="false">Interrupted download</button><button data-preview="242e" aria-pressed="false">Ready</button><button data-preview="244b" aria-pressed="false">Worlds landing</button><button id="ij-size" aria-pressed="false">Narrow window</button></div><div id="ij-stage"></div><p id="ij-status" role="status">Choose a path. These are simulated design states.</p></section>${matrix}${reviewTurns}<p class="ij-reference">Source: current client launch.tsx / launch.css / launch tokens / native icons; SPEC-016 (draft), R-1–R-8; current managed local runtime guidance. Proposal changes the current mandatory runtime gate. No product behaviour has changed.</p></main><script type="module" src="install-journeys.prototype.mjs"></script></body></html>`);
if(process.argv.includes('--preview')){console.log(`Wrote draft review with ${FRAMES.length} frames.`);process.exit(0);}
let master=read('Arke Studio.dc.html');
for(const t of TURNS){
 const cards=t.keys.map(key=>{const f=FRAMES.find(f=>f.key===key);return `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;height:${f.height}px;max-width:none">${f.markup}</div></div>`;}).join('\n');
 const turn=`<section class="dv-turn" id="t${t.id}"><div class="dv-thd"><a class="dv-tid" href="#t${t.id}">${t.id}</a><span class="dv-tname">${esc(t.title)}</span></div><p class="dv-next">28 October 2026 · Draft for review · <a href="install-journeys.review.html#turn${t.id}">Interactive journey</a> · <a href="install-journeys.notes.md">Notes</a></p><div class="dv-opts">${cards}</div>${rules(t)}</section>\n`;
 const starts=[...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)];const old=starts.find(m=>Number(m[1])===t.id);
 if(old){const next=starts.find(m=>m.index>old.index);if(!next)throw new Error('No safe next turn');master=master.slice(0,old.index)+turn+master.slice(next.index);}
 else{const before=starts.find(m=>Number(m[1])>0&&Number(m[1])<t.id);if(!before)throw new Error('No safe insertion');master=master.slice(0,before.index)+turn+master.slice(before.index);}
}
for(const file of styles){const link=`<link rel="stylesheet" href="${file}">`;if(!master.includes(link))master=master.replace('</helmet>',link+'\n</helmet>');}
write('Arke Studio.dc.html',master);
let review=read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN INSTALL JOURNEYS[\s\S]*?  \/\/ END INSTALL JOURNEYS(?:\r?\n)*/g,'\n');
const entries=FRAMES.map(f=>`  { group: "Install journeys · turns 242–244", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Proposed first-run setup", status: "drawn", checked: "2026-10-28", controls: [], notes: ["Draft for owner review. Not approved or implemented. ${f.persona} journey; measurements are illustrative."] },`);
review=review.replace('const SCREENS = [','const SCREENS = [\n  // BEGIN INSTALL JOURNEYS\n'+entries.join('\n')+'\n  // END INSTALL JOURNEYS\n');
if(!review.includes('file: "install-journeys.review.html"'))review=review.replace('const PAGES = [','const PAGES = [\n  { file: "install-journeys.review.html", what: "Turns 242–244: Guided, Advanced and Lightweight install journeys.", state: "draft; not approved or implemented" },');
for(const file of styles){const link=`<link rel="stylesheet" href="${file}">`;if(!review.includes(link))review=review.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">',link+'\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');}
write('build-review.mjs',review);
console.log(`Registered draft turns 242–244: ${FRAMES.length} HTML frames. Existing turns retained.`);

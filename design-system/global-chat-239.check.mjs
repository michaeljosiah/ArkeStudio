// Source/DOM checks only: these do not render or measure layout in a browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseHTML} from 'linkedom';
const root=process.argv[2]?path.resolve(process.argv[2]):path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=path.join(root,'design-system');
const {FRAMES,screen}=await import(pathToFileURL(path.join(base,'global-chat-239.frames.mjs')));
const {references,nativeIcons,receipt}=await import(pathToFileURL(path.join(base,'global-chat-239.references.mjs')));
assert.equal(FRAMES.length,8);
assert.equal(new Set(FRAMES.map(f=>f.id)).size,8);
assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,receipt.iconsSource))).digest('hex'),receipt.iconsSha256,'Native icons must match the current source');
assert(!fs.readFileSync(path.join(base,'global-chat-239.frames.mjs'),'utf8').includes('const paths ='),'Do not redraw glyphs');
const master=parseHTML(fs.readFileSync(path.join(base,'Arke Studio.dc.html'),'utf8')).document;
for(const [key,id] of Object.entries({desktop:'227a',phone:'227m',tablet:'227k',notification:'206b'})){
  const current=master.querySelector(`#${id} .dv-card>div`).cloneNode(true);
  current.removeAttribute('data-screen-label');current.style.width='100%';current.style.height='100%';
  const snapshot=parseHTML(references[key]).document.querySelector('div');
  // The background's page content is exact; only the titlebar gets current native icon controls.
  assert.equal(snapshot.querySelector('.body')?.outerHTML,current.querySelector('.body')?.outerHTML,`${key} current page content`);
}
for(const frame of FRAMES){
  const document=parseHTML(frame.markup).document;
  assert(document.querySelector('[data-screen-label]'));
  if(frame.state==='activity')continue;
  assert(document.querySelector('.g239-page>.ch227'),'Use the existing page');
  assert(document.querySelector('.fy-mchip'),'Use the native ModelChip specimen');
  assert(document.querySelector('.gc224-editor[data-draft]'),'Use the shared contenteditable composer');
  assert(!document.querySelector('textarea'),'No replacement textarea');
  assert.equal(document.querySelector('.g239-dialog').getAttribute('role'),'dialog');
  assert.equal(document.querySelector('.g239-dialog').getAttribute('aria-modal'),frame.device==='desktop'?null:'true');
  for(const svg of document.querySelectorAll('.g239-head svg'))assert(Object.values(nativeIcons).some(markup=>parseHTML(markup).document.querySelector('svg').outerHTML===svg.outerHTML));
}
const html=fs.readFileSync(path.join(base,'global-chat-239.review.html'),'utf8');
const {window,document}=parseHTML(html);
const host=document.getElementById('g239-prototype');
Object.defineProperty(host,'clientWidth',{value:1200,configurable:true});
document.activeElement=null;
window.HTMLElement.prototype.focus=function(){document.activeElement=this;};
let timer=null;
const context={screen,document,ResizeObserver:class{observe(){}},setTimeout:fn=>{timer=fn;return 1;},clearTimeout:()=>{timer=null;}};
const script=fs.readFileSync(path.join(base,'global-chat-239.prototype.mjs'),'utf8').replace(/^import .*;\r?\n/,'');
vm.runInNewContext(script,context);
const click=selector=>{const node=host.querySelector(selector);assert(node,selector);node.dispatchEvent(new window.Event('click',{bubbles:true}));};
const state=()=>host.firstElementChild.dataset.state;
host.querySelector('[data-draft]').textContent='Keep my studio question';
click('[data-action=close]');assert.equal(state(),'closed');
click('[data-action=open]');assert.equal(host.querySelector('[data-draft]').textContent,'Keep my studio question');
click('[data-action=diagnose]');assert.equal(state(),'checking');
click('[data-action=activity]');assert.equal(state(),'activity');timer();assert.equal(state(),'activity','completed investigation must not force chat open');
click('[data-action=return-chat]');assert.equal(state(),'diagnosis');
assert.equal(host.querySelector('[data-draft]').textContent,'Keep my studio question');
click('[data-action=activity]');click('[data-action=return-chat]');assert.equal(state(),'diagnosis','Activity restores the retained finding');
click('[data-action=review]');assert.equal(state(),'repair');
assert(host.querySelector('[data-action=approve]'));click('[data-action=deny]');assert.equal(state(),'denied');
document.querySelector('[data-preview-state=repair]').dispatchEvent(new window.Event('click',{bubbles:true}));
click('[data-action=approve]');assert.equal(state(),'recovered');
console.log('8 current-source frames; native icon provenance; shared composer/ModelChip; exact background page content; close/reopen draft retention; diagnosis → review → deny/approve: pass.');
console.log('Rendered layout, visual fidelity, real microphone and physical keyboard behavior remain unverified by these source/DOM checks.');

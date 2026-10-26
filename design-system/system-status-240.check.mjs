// Source/DOM/prototype checks. Does not launch a browser or render the master.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {parseHTML} from 'linkedom';
import {FRAMES,screen} from './system-status-240.frames.mjs';
import {receipt,references,nativeIcons} from './system-status-240.references.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,receipt.iconsSource))).digest('hex'),receipt.iconsSha256,'Native icon source hash');
assert.equal(FRAMES.length,7);assert.equal(new Set(FRAMES.map(f=>f.id)).size,7);
const master=parseHTML(fs.readFileSync(path.join(here,'Arke Studio.dc.html'),'utf8')).document;
const head=execFileSync('git',['show','HEAD:design-system/Arke Studio.dc.html'],{cwd:root,encoding:'utf8',maxBuffer:50000000});
function turns(source){const starts=[...source.matchAll(/<section class="dv-turn" id="t(\d+)"/g)];return starts.map((match,i)=>[match[1],source.slice(match.index,i+1<starts.length?starts[i+1].index:undefined)]);}
const current=new Map(turns(fs.readFileSync(path.join(here,'Arke Studio.dc.html'),'utf8')));
for(const [id,body] of turns(head))if(id!=='240')assert.equal(current.get(id),body,'Historical turn '+id+' stays byte-identical');
for(const [device,id] of Object.entries({desktop:'227a',tablet:'227k',phone:'227m'})){
  const old=master.querySelector(`#${id} .dv-card>div`),copy=parseHTML(references[device]).document.querySelector('div');
  const selector=device==='phone'?'.pscroll':'.body';
  assert.equal(copy.querySelector(selector).outerHTML,old.querySelector(selector).outerHTML,device+' unchanged content');
}
for(const frame of FRAMES){
  const d=parseHTML(frame.markup).document;
  assert.deepEqual([...d.querySelectorAll('.tb .util>button')].map(b=>b.dataset.action),['chat','system','activity','settings','account']);
  const system=d.querySelector('.tb [data-action=system]');
  assert.equal(system.querySelector('svg').outerHTML,parseHTML(nativeIcons.system).document.querySelector('svg').outerHTML);
  assert(!d.querySelector('[data-action=proposals]'),'Proposal shortcut replaced');
  const dialog=d.querySelector('.s240-dialog');
  if(!frame.open){assert(!dialog);continue;}
  assert.equal(dialog.getAttribute('role'),'dialog');
  assert.equal(dialog.getAttribute('aria-modal'),frame.device==='desktop'?null:'true');
  assert(dialog.textContent.includes('Example data'));assert(dialog.textContent.includes('This desktop'));
  assert.equal(dialog.querySelectorAll('.s240-metric').length,4);
  assert.equal(dialog.querySelectorAll('.s240-drive').length,2);
  assert(dialog.textContent.includes('Not checked'));
  assert(dialog.querySelector('footer [data-action=diagnostics]'));
  assert(!/clear|delete|restart|kill|approve|retry/.test([...dialog.querySelectorAll('[data-action]')].map(n=>n.dataset.action).join(' ')));
  if(frame.state==='unavailable'){
    assert(dialog.textContent.includes('Last: 24%'));assert(dialog.textContent.includes('3 min ago'));
    assert.equal(dialog.querySelectorAll('.s240-meter').length,0,'No live bars over stale/missing measurements');
    assert(dialog.textContent.includes('Unavailable'));
  }
  if(frame.state==='warning'){assert(dialog.textContent.includes('Another 3 GiB'));assert(d.querySelector('.s240-attention'));}
}
const {window,document}=parseHTML(fs.readFileSync(path.join(here,'system-status-240.review.html'),'utf8'));
const host=document.getElementById('s240-prototype');
document.activeElement=null;window.HTMLElement.prototype.focus=function(){document.activeElement=this;};
const context={screen,document,ResizeObserver:class{observe(){}}};
vm.runInNewContext(fs.readFileSync(path.join(here,'system-status-240.prototype.mjs'),'utf8').replace(/^import .*;\r?\n/,''),context);
const click=selector=>{const node=document.querySelector(selector);assert(node,selector);node.dispatchEvent(new window.Event('click',{bubbles:true}));};
click('#s240-prototype [data-action=close]');assert.equal(host.firstElementChild.dataset.open,'false');assert.equal(document.activeElement.dataset.action,'system');
click('#s240-prototype [data-action=system]');assert.equal(host.firstElementChild.dataset.open,'true');assert.equal(document.activeElement.dataset.action,'close');
click('[data-preview-state=unavailable]');click('#s240-prototype [data-action=refresh]');assert.equal(host.firstElementChild.dataset.state,'unavailable','Refresh must not fabricate health');
click('#s240-prototype [data-action=diagnostics]');assert(document.getElementById('s240-prototype-status').textContent.includes('performs no action'));
click('[data-preview-format=phone]');assert.equal(host.querySelector('.s240-page').getAttribute('aria-hidden'),'true');
assert.equal(host.querySelector('.s240-dialog').getAttribute('aria-modal'),'true');
const tabEvent=new window.Event('keydown',{bubbles:true,cancelable:true});tabEvent.key='Tab';
host.querySelector('.s240-foot [data-action=diagnostics]').focus();host.dispatchEvent(tabEvent);assert.equal(document.activeElement.dataset.action,'close','Modal Tab wraps to close');
const escape=new window.Event('keydown',{bubbles:true,cancelable:true});escape.key='Escape';host.dispatchEvent(escape);assert.equal(host.firstElementChild.dataset.open,'false');assert.equal(document.activeElement.dataset.action,'system');
console.log('Turn 240: 7 source-backed frames; exact page content; native icon hash; shortcut order; example/freshness/absence labels; harmless actions; close/reopen, modal Tab and Escape focus return: pass.');
console.log('These checks do not establish rendered visual fidelity or native application acceptance.');

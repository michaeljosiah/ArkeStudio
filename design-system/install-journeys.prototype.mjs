import {screen,screens} from './install-journeys.frames.mjs';
const stage=document.querySelector('#ij-stage'),status=document.querySelector('#ij-status');
let current='choose',narrow=false,entryState='manual';
const selections={writing:true,media:true,voice:false,ming:false,cloud:false};
const values={};
function render(key,focus=true){
 current=key;stage.innerHTML=screen(key,narrow);stage.classList.toggle('ij-narrow',narrow);
 for(const e of stage.querySelectorAll('input[type=checkbox][name]'))e.checked=selections[e.name];
 for(const e of stage.querySelectorAll('select,input:not([type=checkbox])'))if(values[e.getAttribute('aria-label')])e.value=values[e.getAttribute('aria-label')];
 for(const e of stage.querySelectorAll('[data-source]'))stage.querySelector(`[data-existing=${e.dataset.source}]`).hidden=e.selectedIndex===0;
 if(key==='243b'){
   for(const [name,field] of [['writing','writing'],['media','media']]){const e=stage.querySelector(`[data-source=${field}]`);if(e)e.closest('.ij-field').hidden=!selections[name]&&!(name==='media'&&selections.ming);}
   stage.querySelector('select[aria-label="Local text model"]').closest('.ij-field').hidden=!selections.writing;
   const extra=[];if(selections.voice)extra.push('Preset voice & dictation: Kokoro + Whisper selected.');if(selections.ming)extra.push('Ming 0.5B selected. A compatible local Python runtime is required; a remote ComfyUI URL cannot supply it.');if(selections.cloud)extra.push('Cloud provider: choose your provider in the existing connection flow. No credentials are collected in this preview.');
   for(const text of extra){const p=document.createElement('p');p.className='ij-note';p.textContent=text;stage.querySelector('.ij-content').insertBefore(p,stage.querySelector('.ij-content>.ij-actions'));}
 }
 if(key==='243d'){
   const labels={writing:'Local writing assistant',media:'Local media engine',voice:'Preset voice & dictation',ming:'Ming 0.5B voice cloning',cloud:'Cloud provider connection'};
   const plan=stage.querySelector('[data-plan-rows]');plan.replaceChildren();
   for(const name of Object.keys(selections).filter(n=>selections[n])){
     const row=document.createElement('div');row.className='ij-row';const body=document.createElement('div');const label=document.createElement('strong');label.textContent=labels[name];const detail=document.createElement('p');detail.textContent=name==='writing'?(values['Writing engine source']??'Arke-managed (recommended)'):name==='media'?(values['Media engine source']??'Arke-managed (recommended)'):name==='cloud'?'Choose a provider in the existing connection flow.':'Selected with its required support files.';body.append(label,detail);row.append(body);plan.append(row);
   }
   const defaultPlan=selections.writing&&selections.media&&!selections.voice&&!selections.ming&&!selections.cloud&&(!values['Writing engine source']||values['Writing engine source'].startsWith('Arke-managed'))&&(!values['Media engine source']||values['Media engine source'].startsWith('Arke-managed'));
   if(!defaultPlan){stage.querySelector('[data-plan-cost]').textContent='Your exact download and space quote is calculated from these selections.';const install=stage.querySelector('.ij-primary');install.disabled=true;install.textContent='Quote needed before install';}
 }
 if(key==='244b'){
   const block=stage.querySelector('.ij-block');
   if(entryState==='downloading'){block.querySelector('h3').textContent='Local AI is still setting up';block.querySelector('p').textContent='Start with the form or your existing files. Activity keeps your selected downloads and their next steps in view.';}
   if(entryState==='ready'){block.querySelector('h3').textContent='Your selected AI is ready';block.querySelector('p').textContent='Use your configured writing assistant. Add other capabilities in Settings when you need them.';}
 }
 for(const b of document.querySelectorAll('[data-preview]'))b.setAttribute('aria-pressed',String(b.dataset.preview===key));
 status.textContent=`${screens[key]?.title??screens.choose.title}. Design example only; no installation or live check.`;
 if(focus)stage.querySelector('h2')?.focus({preventScroll:true});
}
document.addEventListener('click',e=>{
 const p=e.target.closest('[data-preview]');if(p){render(p.dataset.preview);return;}
 const go=e.target.closest('#ij-stage [data-go]');if(go){let target=go.dataset.go;if(target==='243b'&&current==='243a'&&!Object.values(selections).some(Boolean))target='244a';if(target==='244b')entryState=['242c','242d','243d'].includes(current)?'downloading':['242e','243c'].includes(current)?'ready':'manual';render(target);return;}
 const pause=e.target.closest('#ij-stage [data-pause]');if(pause){const paused=pause.textContent==='Pause';pause.textContent=paused?'Resume':'Pause';status.textContent=paused?'Preview: this download is paused. Verified partial data is retained; writing stays available.':'Preview: resume the accepted download from its retained receipt.';return;}
 const msg=e.target.closest('#ij-stage [data-message]');if(msg){status.textContent=msg.dataset.message+' This design stops at that existing flow.';return;}
 if(e.target.closest('#ij-size')){narrow=!narrow;document.querySelector('#ij-size').setAttribute('aria-pressed',String(narrow));render(current);}
 if(e.target.closest('#ij-theme'))document.documentElement.classList.toggle('dark');
});
stage.addEventListener('change',e=>{
 if(e.target.matches('input[type=checkbox][name]')){selections[e.target.name]=e.target.checked;stage.querySelector('[data-selection-note]').textContent=`${Object.values(selections).filter(Boolean).length} capabilities selected. The next step shows their sources and dependencies.`;}
 if(e.target.matches('select,input:not([type=checkbox])'))values[e.target.getAttribute('aria-label')]=e.target.value;
 if(e.target.matches('[data-source]'))stage.querySelector(`[data-existing=${e.target.dataset.source}]`).hidden=e.target.selectedIndex===0;
});
function fit(){for(const e of document.querySelectorAll('.ij-fit')){const s=Math.min(1,e.clientWidth/Number(e.dataset.width));e.firstElementChild.style.transform=`scale(${s})`;e.style.height=`${Number(e.dataset.height)*s}px`;}}
addEventListener('resize',fit);addEventListener('load',fit);render('choose',false);fit();

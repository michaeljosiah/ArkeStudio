import {screen,screens} from './install-journeys.frames.mjs';
const stage=document.querySelector('#ij-stage'),status=document.querySelector('#ij-status');
let current='choose',narrow=false,entryState='manual',harness='opencode',journey='guided',writingRoute='local',cloudReady=false;
const harnessNames={opencode:'OpenCode',claude:'Claude Code',codex:'Codex'};
const selections={writing:true,media:true,voice:false};
const values={};
function render(key,focus=true){
 current=key;stage.innerHTML=screen(key,narrow);stage.classList.toggle('ij-narrow',narrow);
 for(const e of stage.querySelectorAll('input[type=checkbox][name]'))e.checked=selections[e.name];
 for(const e of stage.querySelectorAll('input[name=harness]'))e.checked=e.value===harness;
 for(const e of stage.querySelectorAll('input[name="writing-route"]'))e.checked=e.value===writingRoute;
 for(const e of stage.querySelectorAll('select,input:not([type=checkbox]):not([type=radio])'))if(values[e.getAttribute('aria-label')])e.value=values[e.getAttribute('aria-label')];
 for(const e of stage.querySelectorAll('[data-source]'))stage.querySelector(`[data-existing=${e.dataset.source}]`).hidden=e.selectedIndex===0;
 if(key==='243e')updateHarnessNote();
 if(key==='242f')updateWritingRoute();
 if(key==='242b'&&writingRoute==='cloud'){
   stage.querySelector('[data-guided-writing]').innerHTML='<div class="ij-row"><div><strong>Cloud writing assistant</strong><p>OpenCode + selected provider and model. No Ollama or local writing weights.</p></div><span class="ij-state">'+(cloudReady?'Ready':'Connection needed')+'</span></div>';
   stage.querySelector('[data-guided-cost]').innerHTML='<div><span>Download</span><strong>About 3.7 GB</strong></div><div><span>Kept on disk</span><strong>About 12 GB</strong></div><div><span>Space during setup</span><strong>18 GB</strong></div>';
 }
 if(key==='242c'&&writingRoute==='cloud'){
   stage.querySelector('[data-progress-writing]').innerHTML='<div class="ij-row"><div><strong>Cloud writing assistant</strong><p>Selected provider connection and writing model checked.</p></div><span class="ij-state">Ready</span></div>';
   stage.querySelector('[data-local-progress]').hidden=true;
 }
 if(key==='242e'&&writingRoute==='cloud'){
   const writing=stage.querySelectorAll('.ij-row')[1];writing.querySelector('strong').textContent='Cloud writing assistant';writing.querySelector('p').textContent='Selected provider account and model checks passed through OpenCode.';
 }
 if(key==='243a'&&harness!=='opencode')stage.querySelector('[data-writing-detail]').textContent=`Use the selected ${harnessNames[harness]} installation and account connection. No Ollama download.`;
 if(key==='243b'){
   for(const [name,field] of [['writing','writing'],['media','media']]){const e=stage.querySelector(`[data-source=${field}]`);if(e)e.closest('.ij-field').hidden=!selections[name]||(name==='writing'&&(harness!=='opencode'||writingRoute==='cloud'));}
   stage.querySelector('select[aria-label="Local text model"]').closest('.ij-field').hidden=!selections.writing||harness!=='opencode'||writingRoute==='cloud';
   const summary=stage.querySelector('[data-harness-summary]');summary.hidden=!selections.writing;if(harness!=='opencode')summary.textContent=`Writing harness: ${harnessNames[harness]} · existing installation. Check compatibility and account connection before enabling AI writing. OpenCode remains included; Ollama is not part of this writing setup.`;
   if(harness==='opencode'&&writingRoute==='cloud')summary.textContent='Writing harness: OpenCode · selected cloud provider and model checked. No Ollama or local writing-model download.';
   const extra=[];if(selections.voice)extra.push('Preset voice & dictation: Kokoro + Whisper selected.');
   for(const text of extra){const p=document.createElement('p');p.className='ij-note';p.textContent=text;stage.querySelector('.ij-content').insertBefore(p,stage.querySelector('.ij-content>.ij-actions'));}
 }
 if(key==='243d'){
   const labels={writing:'Writing assistance',media:'Local media engine',voice:'Preset voice & dictation'};
   const plan=stage.querySelector('[data-plan-rows]');plan.replaceChildren();
   for(const name of Object.keys(selections).filter(n=>selections[n])){
     const row=document.createElement('div');row.className='ij-row';const body=document.createElement('div');const label=document.createElement('strong');label.textContent=labels[name];const detail=document.createElement('p');detail.textContent=name==='writing'?(harness==='opencode'?(writingRoute==='cloud'?'OpenCode (included) → selected cloud provider and model. No Ollama or local writing weights.':`OpenCode (included) → Ollama + selected local model · ${values['Writing engine source']??'Arke-managed (recommended)'}`):`${harnessNames[harness]} · reuse existing installation; compatibility and account checks required. No Ollama download.`):name==='media'?(values['Media engine source']??'Arke-managed (recommended)'):'Selected with its required support files.';body.append(label,detail);row.append(body);plan.append(row);
   }
   const defaultPlan=harness==='opencode'&&writingRoute==='local'&&selections.writing&&selections.media&&!selections.voice&&(!values['Writing engine source']||values['Writing engine source'].startsWith('Arke-managed'))&&(!values['Media engine source']||values['Media engine source'].startsWith('Arke-managed'));
   if(!defaultPlan){stage.querySelector('[data-plan-cost]').textContent='Your exact download and space quote is calculated from these selections.';const install=stage.querySelector('.ij-primary');install.disabled=true;install.textContent='Quote needed before install';}
   if(harness==='opencode'&&writingRoute==='cloud'&&selections.writing&&selections.media&&!selections.voice&&(!values['Media engine source']||values['Media engine source'].startsWith('Arke-managed'))){stage.querySelector('[data-plan-cost]').innerHTML='<div><span>Download</span><strong>About 3.5 GB</strong></div><div><span>Kept on disk</span><strong>About 12 GB</strong></div><div><span>Space during setup</span><strong>18 GB</strong></div>';const action=stage.querySelector('.ij-primary');action.disabled=false;action.textContent='Install selected';}
   if(selections.writing&&!selections.media&&!selections.voice&&(harness!=='opencode'||writingRoute==='cloud')){stage.querySelector('[data-plan-cost]').textContent='Additional AI download: 0 GB · '+(harness==='opencode'?'use the selected cloud connection.':'reuse the selected installed harness.');const action=stage.querySelector('.ij-primary');action.disabled=false;if(harness==='opencode'){action.textContent='Open Arke';}else{action.removeAttribute('data-go');action.dataset.message='The selected harness compatibility and account flow opens. No prompt is sent by this preview.';action.textContent='Check selected assistant';}}
 }
 if(key==='244b'){
   const summary=stage.querySelector('[data-world-status]');
   if(entryState==='downloading')summary.textContent='Some local tools are still setting up. See progress in Activity; you can write now.';
   if(entryState==='ready')summary.textContent='Your writing assistant is ready. Other capabilities can be added in Settings.';
 }
 for(const b of document.querySelectorAll('[data-preview]'))b.setAttribute('aria-pressed',String(b.dataset.preview===key));
 status.textContent=`${screens[key]?.title??screens.choose.title}. Design example only; no installation or live check.`;
 if(focus)stage.querySelector('h2,h1[tabindex]')?.focus({preventScroll:true});
}
function updateWritingRoute(){
 const cloud=writingRoute==='cloud';stage.querySelector('[data-route-title]').textContent=cloud?'Connect an account, choose a model':'Local writing, ready to use';
 stage.querySelector('[data-route-detail]').textContent=cloud?'Choose your provider, sign in or add its API key, then choose a model. Arke checks the connection before enabling AI writing.':'Arke checks your computer, prepares Ollama and a suitable model, then checks that the model responds.';
 stage.querySelector('.ij-primary').textContent=cloud?'Connect a provider':'Review local setup';
}
function updateHarnessNote(){const note=stage.querySelector('[data-harness-selection]');if(note)note.textContent=harness==='opencode'?'OpenCode is selected. Local writing can use Ollama; hosted providers are optional.':`${harnessNames[harness]} is selected. Reuse this installation after compatibility and account checks. No automatic switch to OpenCode.`;}
document.addEventListener('click',e=>{
 const p=e.target.closest('[data-preview]');if(p){if(p.dataset.preview==='242f'){journey='guided';harness='opencode';}if(p.dataset.preview==='243e')journey='advanced';render(p.dataset.preview);return;}
 const go=e.target.closest('#ij-stage [data-go]');if(go){let target=go.dataset.go;
   if(current==='choose'&&target==='242f'){journey='guided';harness='opencode';}
   if(target==='243e'){journey='advanced';if(current==='244a'){selections.writing=true;selections.media=false;selections.voice=false;}}
   if(current==='243a'&&target==='243b'){if(!Object.values(selections).some(Boolean))target='244a';else if(selections.writing&&harness==='opencode')target='242f';}
   if(current==='242f'){if(target==='choose')target=journey==='advanced'?'243a':'choose';else target=writingRoute==='cloud'?'242g':journey==='advanced'?'243b':'242b';}
   if(current==='242g'&&target==='242h')cloudReady=true; // Simulated result only; no credential or request.
   if(current==='242g'&&target==='242f')writingRoute='local';
   if(current==='242h'&&target==='242b')target=journey==='advanced'?'243b':'242b';
   if(target==='244b')entryState=['242c','242d'].includes(current)?'downloading':['242e','243c'].includes(current)||current==='243d'&&harness==='opencode'&&writingRoute==='cloud'&&!selections.media&&!selections.voice?'ready':current==='243d'?'downloading':'manual';
   const previous=current;render(target);if(previous==='242g'&&target==='242h')status.textContent='Design preview: the existing provider/account/model flow is represented by this connected example. No login, credentials or live checks occurred.';return;
 }
 const pause=e.target.closest('#ij-stage [data-pause]');if(pause){const paused=pause.textContent==='Pause';pause.textContent=paused?'Resume':'Pause';status.textContent=paused?'Preview: this download is paused. Verified partial data is retained; writing stays available.':'Preview: resume the accepted download from its retained receipt.';return;}
 const msg=e.target.closest('#ij-stage [data-message]');if(msg){status.textContent=msg.dataset.message+' This design stops at that existing flow.';return;}
 if(e.target.closest('#ij-size')){narrow=!narrow;document.querySelector('#ij-size').setAttribute('aria-pressed',String(narrow));render(current);}
 if(e.target.closest('#ij-theme'))document.documentElement.classList.toggle('dark');
});
stage.addEventListener('change',e=>{
 if(e.target.matches('input[name=harness]')){harness=e.target.value;updateHarnessNote();}
 if(e.target.matches('input[name="writing-route"]')){writingRoute=e.target.value;updateWritingRoute();}
 if(e.target.matches('input[type=checkbox][name]')){selections[e.target.name]=e.target.checked;stage.querySelector('[data-selection-note]').textContent=`${Object.values(selections).filter(Boolean).length} capabilities selected. The next step shows their sources and dependencies.`;}
 if(e.target.matches('select,input:not([type=checkbox]):not([type=radio])'))values[e.target.getAttribute('aria-label')]=e.target.value;
 if(e.target.matches('[data-source]'))stage.querySelector(`[data-existing=${e.target.dataset.source}]`).hidden=e.target.selectedIndex===0;
});
function fit(){for(const e of document.querySelectorAll('.ij-fit')){const s=Math.min(1,e.clientWidth/Number(e.dataset.width));e.firstElementChild.style.transform=`scale(${s})`;e.style.height=`${Number(e.dataset.height)*s}px`;}}
addEventListener('resize',fit);addEventListener('load',fit);render('choose',false);fit();

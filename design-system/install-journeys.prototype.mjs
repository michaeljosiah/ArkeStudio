import {screen,screens,esc} from './install-journeys.frames.mjs';
const stage=document.querySelector('#ij-stage'),status=document.querySelector('#ij-status');
let current='choose',narrow=false,entryState='manual',harness='opencode',journey='guided',writingRoute='local',cloudReady=false,provider='chatgpt',profile='fit',checkTimer;
const harnessNames={opencode:'OpenCode',claude:'Claude Code',codex:'Codex'};
const providerNames={chatgpt:'ChatGPT',copilot:'GitHub Copilot'};
// Design examples, not a scan of this computer. Eligibility comes from real checks in implementation.
const profiles={fit:{local:true,media:true,voice:true,assistants:[]},small:{local:false,media:false,voice:true,assistants:[]},existing:{local:false,media:true,voice:true,assistants:['claude','codex']}};
const selections={writing:true,media:true,voice:false},values={};
const facts=()=>profiles[profile];
const connectedName=()=>harness==='opencode'?providerNames[provider]:harnessNames[harness];
const row=(name,detail,state='')=>`<div class="ij-row"><div><strong>${esc(name)}</strong><p>${esc(detail)}</p></div><span class="ij-state">${esc(state)}</span></div>`;
const quote=(download,kept,peak)=>`<div><span>Download</span><strong>${download}</strong></div><div><span>Kept on disk</span><strong>${kept}</strong></div><div><span>Space during setup</span><strong>${peak}</strong></div>`;
function startGuided(){journey='guided';harness='opencode';cloudReady=false;writingRoute=facts().local?'local':'cloud';render('242i');}
function writingChoice(){return facts().local?'242f':'242j';}
function render(key,focus=true){
 clearTimeout(checkTimer);current=key;stage.innerHTML=screen(key,narrow);stage.classList.toggle('ij-narrow',narrow);
 for(const e of stage.querySelectorAll('input[type=checkbox][name]'))e.checked=selections[e.name];
 for(const e of stage.querySelectorAll('input[name=harness]'))e.checked=e.value===harness;
 for(const e of stage.querySelectorAll('input[name="writing-route"]'))e.checked=e.value===writingRoute;
 for(const e of stage.querySelectorAll('select,input:not([type=checkbox]):not([type=radio])'))if(values[e.getAttribute('aria-label')])e.value=values[e.getAttribute('aria-label')];
 for(const e of stage.querySelectorAll('[data-source]'))stage.querySelector(`[data-existing=${e.dataset.source}]`).hidden=e.selectedIndex===0;
 if(key==='242i')checkTimer=setTimeout(()=>render(facts().assistants.length?'242k':writingChoice()),650);
 if(key==='242k')for(const e of stage.querySelectorAll('[data-detected]'))e.hidden=!facts().assistants.includes(e.dataset.detected);
 if(key==='243e')updateHarnessNote();
 if(key==='242f'){
   if(journey==='advanced'){
     stage.querySelector('.ij-step').textContent='CUSTOM · OPENCODE WRITING';
     stage.querySelector('.ij-lead').textContent='Connect an online account, or configure a managed or existing model service.';
     const choice=stage.querySelector('input[value="local"]').closest('label');choice.querySelector('strong').textContent='Local or existing model service';choice.querySelector('span span').textContent='Configure Ollama and choose a model. The selected service and model must pass their checks.';
   }
   updateWritingRoute();
 }
 if(key==='242l'){
   const name=connectedName();stage.querySelector('h2').textContent=harness==='opencode'?`Finish signing in with ${name}.`:`Checking your ${name} assistant.`;
   if(harness!=='opencode'){
     stage.querySelector('.ij-lead').textContent='We’re checking that this installed assistant is ready to help you write.';
     stage.querySelector('[data-signin-instructions]').innerHTML='<section class="ij-block"><h3>Checking the account…</h3><p>If you need to sign in, we’ll show the steps for your chosen assistant.</p></section>';
     stage.querySelector('button[data-message]').hidden=true;
     stage.querySelector('[data-go="242g"]').textContent='Choose another assistant';
   }else if(provider==='copilot'){
     stage.querySelector('[data-signin-instructions]').innerHTML='<section class="ij-block"><h3>Enter your code on GitHub</h3><p>Your one-time code will appear here. Enter it on the GitHub sign-in page, then return to Arke.</p><div class="ij-code-placeholder">Code supplied by GitHub</div><p>Waiting for you to sign in…</p></section>';
   }
 }
 if(key==='242h'){
   stage.querySelector('[data-connected-account]').innerHTML=row(connectedName(),'Your account and available writing support have been checked.','Ready');
   if(harness!=='opencode')stage.querySelector('[data-connected-detail]').textContent=`Arke will use your installed ${connectedName()} assistant. You can change this in Settings.`;
 }
 if(['242b','242c','242e'].includes(key)){
   for(const e of stage.querySelectorAll('[data-guided-media]'))e.hidden=!facts().media;
   for(const e of stage.querySelectorAll('[data-guided-voice]'))e.hidden=!facts().voice;
   const external=harness!=='opencode'||writingRoute==='cloud';
   if(key==='242b'){
     if(external)stage.querySelector('[data-guided-writing]').innerHTML=row(`Writing help with ${connectedName()}`,'Use your connected account. No large writing download.',cloudReady?'Ready':'Sign-in needed');
     const download=(external?0:4.3)+(facts().media?3.5:0)+(facts().voice?0.2:0);
     stage.querySelector('[data-guided-cost]').innerHTML=quote(download?`About ${download.toFixed(1)} GB`:'None',facts().media?(external?'About 12 GB':'About 17 GB'):'About 1 GB',facts().media?(external?'18 GB':'24 GB'):'2 GB');
     if(!facts().media)stage.querySelector('.ij-lead').textContent='This smaller setup includes the tools we found that work on this computer.';
   }
   if(key==='242c'&&external){stage.querySelector('[data-progress-writing]').innerHTML=row(`Writing help with ${connectedName()}`,'Your connected account is ready to use.','Ready');stage.querySelector('[data-local-progress]').hidden=true;}
   if(key==='242e'){
     const rows=stage.querySelectorAll('.ij-row');rows[1].querySelector('p').textContent=external?`Use your connected ${connectedName()} account.`:'Writing help works on this computer, including offline.';
     rows[2].hidden=!facts().voice;rows[3].hidden=!facts().media;
   }
 }
 if(key==='243a'&&harness!=='opencode')stage.querySelector('[data-writing-detail]').textContent=`Use the selected ${harnessNames[harness]} installation and account connection. No Ollama download.`;
 if(key==='243b'){
   const local=selections.writing&&harness==='opencode'&&writingRoute==='local';
   stage.querySelector('[data-source=writing]').closest('.ij-field').hidden=!local;
   stage.querySelector('[data-source=media]').closest('.ij-field').hidden=!selections.media;
   stage.querySelector('select[aria-label="Local text model"]').closest('.ij-field').hidden=!local;
   const summary=stage.querySelector('[data-harness-summary]');summary.hidden=!selections.writing;
   if(harness!=='opencode')summary.textContent=`Writing harness: ${harnessNames[harness]} · existing installation. Check compatibility and account connection before enabling AI writing. No Ollama download.`;
   else if(writingRoute==='cloud')summary.textContent=`Writing harness: OpenCode · ${providerNames[provider]} account connected and writing model checked. No Ollama or local writing-model download.`;
 }
 if(key==='243d'){
   const local=harness==='opencode'&&writingRoute==='local';
   const entries=[];
   if(selections.writing)entries.push(row('Writing assistance',harness!=='opencode'?`${harnessNames[harness]} · existing installation; compatibility/account checks required.`:local?`OpenCode → Ollama + selected local model · ${values['Writing engine source']??'Arke-managed (recommended)'}`:`OpenCode → ${providerNames[provider]} · account and model checked. No Ollama or local writing weights.`));
   if(selections.media)entries.push(row('Local media engine',values['Media engine source']??'Arke-managed ComfyUI'));
   if(selections.voice)entries.push(row('Preset voice & dictation','Kokoro + Whisper and their required support files.'));
   stage.querySelector('[data-plan-rows]').innerHTML=entries.join('');
   const action=stage.querySelector('.ij-primary');
   const changedSource=Object.entries(values).some(([key,value])=>key.endsWith('engine source')&&!value.startsWith('Arke-managed'));
   if(changedSource){stage.querySelector('[data-plan-cost]').textContent='Calculate the missing downloads and space for these selected sources before installing.';action.disabled=true;action.textContent='Quote needed before install';}
   else if(selections.writing&&!selections.media&&!selections.voice&&!local){
     stage.querySelector('[data-plan-cost]').textContent='Additional AI download: 0 GB';action.textContent=harness==='opencode'?'Open Arke':'Check selected assistant';
     if(harness!=='opencode'){action.removeAttribute('data-go');action.dataset.message='Open the selected assistant compatibility and account check.';}
   }else if(!local){stage.querySelector('[data-plan-cost]').innerHTML=quote(selections.media?(selections.voice?'About 3.7 GB':'About 3.5 GB'):'About 0.2 GB',selections.media?'About 12 GB':'About 1 GB',selections.media?'18 GB':'2 GB');}
 }
 if(key==='244a')stage.querySelector('[data-existing-choice]').hidden=!facts().assistants.length;
 if(key==='244b'){
   const summary=stage.querySelector('[data-world-status]');
   if(entryState==='downloading')summary.textContent='Some tools are still setting up. See progress in Activity; you can write now.';
   if(entryState==='ready')summary.textContent='Your writing assistant is ready. Add other tools in Settings when you need them.';
 }
 document.querySelector('#ij-auth-success').hidden=key!=='242l';
 document.querySelector('#ij-auth-failure').hidden=key!=='242l';
 for(const b of document.querySelectorAll('[data-preview]'))b.setAttribute('aria-pressed',String(b.dataset.preview===key));
 status.textContent=`${screens[key]?.title??screens.choose.title}. Design example only; no installation or live check.`;
 if(focus)stage.querySelector('h2,h1[tabindex]')?.focus({preventScroll:true});
}
function updateWritingRoute(){
 const cloud=writingRoute==='cloud';stage.querySelector('[data-route-title]').textContent=cloud?'Use an account you already have':'A setup that fits';
 stage.querySelector('[data-route-detail]').textContent=cloud?'Choose ChatGPT or GitHub Copilot, then sign in. Arke checks that your account can provide writing help.':journey==='advanced'?'Configure managed Ollama or an existing service, then select a supported model. Readiness is checked for that connection.':'Arke found a supported writing model that fits this computer. Review its download and space needed before starting.';
 stage.querySelector('.ij-primary').textContent=cloud?'Choose an account':'Review my setup';
}
function updateHarnessNote(){const note=stage.querySelector('[data-harness-selection]');if(note)note.textContent=harness==='opencode'?'OpenCode is selected. Choose local writing or connect ChatGPT / GitHub Copilot next.':`${harnessNames[harness]} is selected. Reuse this installation after compatibility and account checks.`;}
function go(target){
 if(target==='242i'){startGuided();return;}
 if(current==='244a'&&['242g','242k'].includes(target)){journey='lightweight';harness='opencode';writingRoute='cloud';}
 if(target==='243e')journey='advanced';
 if(current==='243a'&&target==='243b'){if(!Object.values(selections).some(Boolean))target='244a';else if(selections.writing&&harness==='opencode')target='242f';}
 if(current==='242k'&&target==='242f'){if(harness==='opencode')target=journey==='lightweight'?'242g':writingChoice();else target='242l';}
 if(current==='242f'){if(target==='choose')target=journey==='advanced'?'243a':facts().assistants.length?'242k':'choose';else target=writingRoute==='cloud'?'242g':journey==='advanced'?'243b':'242b';}
 if(current==='242j'&&target==='242g')writingRoute='cloud';
 if(current==='242g'&&target==='242f')target=journey==='lightweight'?'244a':journey==='advanced'?'242f':writingChoice();
 if(current==='242l'&&target==='242g'&&harness!=='opencode')target='242k';
 if(current==='242h'&&target==='242g'&&harness!=='opencode')target='242k';
 if(current==='242h'&&target==='242b')target=journey==='advanced'?'243b':journey==='lightweight'?'244b':'242b';
 if(current==='242b'&&target==='242f')target=facts().assistants.length?'242k':writingChoice();
 if(target==='244b')entryState=['242c','242d'].includes(current)?'downloading':['242e','243c','242h'].includes(current)?'ready':current==='243d'?(selections.media||selections.voice?'downloading':'ready'):'manual';
 render(target);
}
document.addEventListener('click',e=>{
 const scenario=e.target.closest('[data-scenario]');if(scenario){profile=scenario.dataset.scenario;for(const b of document.querySelectorAll('[data-scenario]'))b.setAttribute('aria-pressed',String(b===scenario));startGuided();return;}
 const p=e.target.closest('[data-preview]');if(p){if(p.dataset.preview==='242i'){startGuided();return;}if(p.dataset.preview==='243e')journey='advanced';if(p.dataset.preview==='242g'){journey='guided';harness='opencode';writingRoute='cloud';}if(p.dataset.preview==='242d')writingRoute='local';render(p.dataset.preview);return;}
 const account=e.target.closest('#ij-stage [data-provider]');if(account){provider=account.dataset.provider;writingRoute='cloud';harness='opencode';cloudReady=false;render('242l');return;}
 if(e.target.closest('#ij-auth-success')){cloudReady=true;render('242h');status.textContent='Design example: sign-in and available writing model checks succeeded. No real account was connected.';return;}
 if(e.target.closest('#ij-auth-failure')){cloudReady=false;stage.querySelector('[data-signin-instructions]').innerHTML='<section class="ij-block"><h3>We couldn’t connect your writing assistant.</h3><p>Please check your sign-in and that your account includes access to a writing model. Try again, choose another account, or continue without AI.</p></section>';status.textContent='Design example: account or model-access check failed. Writing is not marked ready.';return;}
 const button=e.target.closest('#ij-stage [data-go]');if(button){go(button.dataset.go);return;}
 const pause=e.target.closest('#ij-stage [data-pause]');if(pause){const paused=pause.textContent==='Pause';pause.textContent=paused?'Resume':'Pause';status.textContent=paused?'Preview: download paused; writing stays available.':'Preview: resume the accepted download.';return;}
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

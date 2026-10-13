import {screen,state,defaults} from './air-particles-220.view.mjs';
import {renderParticles} from './air-particles-220.renderer.mjs';
const stage=document.getElementById('live-stage'),clone=x=>structuredClone(x),key='arke-air-particles-design-220-v1';
let s=state();try{const saved=JSON.parse(localStorage.getItem(key));if(saved?.current&&saved.schema===1)s={...state(),...saved,playing:false};}catch{}
let lastTime=0,lastFrame=-1,dark=false;
const active=()=>s.review&&s.view==='suggested'?s.pending:s.current;
const save=()=>{try{localStorage.setItem(key,JSON.stringify({...s,playing:false,schema:1}));}catch{}};
function rgba(p,time,width,height){
 const data=renderParticles(time,width,height,{amount:p.amount/100,size:p.size/100,speed:p.speed/100,depth:p.depth/100,texture:p.texture/100,softness:p.softness/100,turbulence:p.airflow/100,boundary:p.boundary==='Open flow'?'open':'bounce',interactions:p.interactions,seed:p.seed});
 // The study's grayscale plate is converted to transparent white particles for the design fixture.
 // The production alpha/colour contract is intentionally left to the later specification.
 for(let i=0;i<data.length;i+=4){data[i+3]=Math.min(255,data[i]*3.6)*p.opacity/100;data[i]=data[i+1]=data[i+2]=255;}
 return new ImageData(data,width,height);
}
function paint(canvas,p,time,overlay=false){
 canvas.style.mixBlendMode=p.blend==='Screen'?'screen':p.blend==='Add'?'plus-lighter':'normal';
 const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
 if(overlay){const data=renderParticles(time,canvas.width,canvas.height);for(let i=0;i<data.length;i+=4){data[i]=data[i+1]=data[i+2]=Math.min(255,data[i]*3.6);data[i+3]=p.opacity/100*255;}ctx.putImageData(new ImageData(data,canvas.width,canvas.height),0,0);}
 else if(p.exists&&time>=p.start&&time<p.end)ctx.putImageData(rgba(p,time,canvas.width,canvas.height),0,0);
 canvas.dataset.ready='true';
}
function render(){
 const values=s.panel==='placement'?(s.placementDraft??active()):active();
 stage.innerHTML=screen({...s,values,live:true,dark});
 if(s.review&&s.view==='current')stage.querySelectorAll('[data-key]').forEach(e=>e.disabled=true);
 paint(stage.querySelector('[data-particles]'),active(),s.clock);
 save();lastFrame=-1;scale();
}
function undoPoint(){s.undo=clone(s.current);}
function edit(key,value){
 if(s.panel==='placement'){s.placementDraft??=clone(active());s.placementDraft[key]=value;render();return;}
 if(s.review&&s.view==='current')return;
 if(key==='reaction'&&value==='On'&&active().source==='No source selected'){s.message='Choose an audible source before enabling reaction.';render();return;}
 if(key==='source'&&value==='No source selected'&&active().reaction==='On'){s.message='Turn reaction Off before clearing its source.';render();return;}
 if(!s.review)undoPoint();active()[key]=value;
 if(['beat','bass','energy','affects','cap','smoothing'].includes(key))active().response='Custom';
 if(s.review&&!s.adjusted.includes(key))s.adjusted.push(key);
 if(s.incoming){s.incoming.values[key]=value;s.message='Your adjustment also carries into the waiting version.';}else s.message=s.review?`${key} · Adjusted by you`:`${key} saved · Undo available`;
 render();
}
function proposal(){
 const p=clone(s.pending??s.current);
 if(!s.adjusted.includes('amount')&&!p.protect.amount)p.amount=s.ready?Math.max(40,p.amount-10):125;
 if(!s.adjusted.includes('airflow')&&!p.protect.airflow)p.airflow=s.ready?110:125;
 return p;
}
function act(action){
 if(action.startsWith('protect:')){const k=action.slice(8);if(active().protect[k]){s.releaseKey=k;s.panel='release';}else{if(!s.review)undoPoint();active().protect[k]=true;active().ruleScopes??={};active().ruleScopes[k]=['start','end'].includes(k)?'Exact boundary':k==='passage'?'Fixed passage · 0:24–0:40':active().protectionScope;s.message=`Protected ${k}`;if(s.review&&!s.adjusted.includes('protect:'+k))s.adjusted.push('protect:'+k);}render();return;}
 if(['appearance','motion','audio','blend','protect','chat'].includes(action)){s.panel=action;render();return;}
 switch(action){
 case 'placement':s.placementDraft=clone(active());s.panel='placement';break;
 case 'whole':s.placementDraft.start=0;s.placementDraft.end=72;break;
 case 'cancel-add':delete s.placementDraft;s.panel='appearance';break;
 case 'add':{const p=s.placementDraft??clone(active());if(p.start>=p.end){s.message='End must be after Start.';break;}p.exists=true;p.reaction='Off';if(s.review){s.pending=clone(p);s.adjusted.push('target','start','end');}else{undoPoint();s.current=clone(p);}delete s.placementDraft;s.panel='appearance';s.message='Air Particles added · reaction Off';break;}
 case 'pattern':edit('seed',active().seed+173);return;
 case 'play':s.playing=!s.playing;lastTime=0;break;
 case 'suggest':{if(s.applied){s.ready=false;s.pending=null;s.adjusted=[];s.version=1;}const p=proposal();if(!s.ready){s.pending=p;s.ready=true;s.applied=false;}else{s.incoming={version:s.version+1,values:p};}s.panel='chat';s.message=s.review?'Another version is ready. Your active preview is unchanged.':'Suggestion ready in Arke. Current stays active.';break;}
 case 'review':if(s.ready&&!s.stale){s.review=true;s.view='suggested';s.panel='chat';s.applied=false;s.message='Reviewing version '+s.version;}break;
 case 'review-incoming':if(s.incoming){s.pending=s.incoming.values;s.version=s.incoming.version;s.incoming=null;s.review=true;s.view='suggested';s.stale=false;s.message='Reviewing version '+s.version;s.panel='chat';}break;
 case 'current':s.view='current';break;
 case 'suggested':s.view='suggested';break;
 case 'close':s.review=false;s.view='current';s.panel='chat';s.message='Review retained. Choose Review in timeline to resume.';break;
 case 'apply':if(s.review&&s.view==='suggested'&&!s.stale){undoPoint();s.current=clone(s.pending);s.current.release=[];s.pending=null;s.incoming=null;s.review=false;s.view='current';s.applied=true;s.ready=true;s.panel='chat';s.adjusted=[];s.message='Applied exact reviewed arrangement · one Undo';}break;
 case 'undo':if(s.undo){s.current=clone(s.undo);s.undo=null;s.pending=null;s.incoming=null;s.review=false;s.view='current';s.ready=false;s.applied=false;s.message='Arrangement and protection restored';}break;
 case 'keep-amount':if(s.pending){s.pending.amount=s.current.amount;if(!s.adjusted.includes('amount'))s.adjusted.push('amount');if(s.incoming)s.incoming.values.amount=s.current.amount;s.message='Current Amount retained in this proposal family.';}break;
 case 'release':{const k=s.releaseKey??'blend';if(s.review){const p=clone(s.pending);p.protect[k]=false;p.release.push(k);s.incoming={version:s.version+1,values:p};s.panel='chat';s.message=`Release ${k} on Apply · Review the new version first`; }else{undoPoint();s.current.protect[k]=false;s.panel='protect';s.message=`Released ${k}; other rules retained`;}break;}
 case 'update':if(s.ready){const p=clone(s.current),draft=proposal();for(const k of ['amount','airflow',...s.adjusted])if(k in draft)p[k]=draft[k];for(const [k,v] of Object.entries(s.current.protect)){if(v){p.protect[k]=true;if(k in s.current)p[k]=s.current[k];}}p.release=[];s.incoming={version:s.version+1,values:p};s.panel='chat';s.message='Updated proposal ready. Review the new version before Apply.';}break;
 case 'discard':s.pending=null;s.incoming=null;s.ready=false;s.review=false;s.view='current';s.adjusted=[];s.stale=false;s.panel='chat';s.message='Proposal discarded. Current unchanged.';break;
 }
 render();
}
stage.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(b&&!b.disabled)act(b.dataset.act);});
stage.addEventListener('change',e=>{const el=e.target;if(!el.dataset.key)return;if(el.type==='number'&&!el.checkValidity()){s.message='Use a value within the shown limits.';render();return;}edit(el.dataset.key,el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):el.value);});
stage.addEventListener('input',e=>{if(e.target.matches('[data-clock]')){s.clock=Number(e.target.value)/24;s.playing=false;paint(stage.querySelector('[data-particles]'),active(),s.clock);stage.querySelector('[data-time]').textContent=`${s.clock.toFixed(2)} / 72.00`;save();}});
document.querySelectorAll('[data-demo]').forEach(b=>b.onclick=()=>{const a=b.dataset.demo;if(a==='reset'){s=state();}else if(a==='dark'){dark=!dark;}else if(a==='stale'){undoPoint();s.current.opacity=60;s.stale=true;s.message='Current opacity changed. Update and Review are required.';}else if(a==='chat'){if(!s.ready){s.pending=proposal();s.ready=true;}s.panel='chat';}else if(a==='placement'){s.placementDraft=clone(active());s.panel=a;}else s.panel=a;render();});
function scale(){document.querySelectorAll('.frame-wrap').forEach(w=>{const inner=w.firstElementChild,n=Math.min(1,w.clientWidth/Number(w.dataset.width));inner.style.transform=`scale(${n})`;w.style.height=`${inner.scrollHeight*n}px`;});}
new ResizeObserver(scale).observe(document.body);
for(const canvas of document.querySelectorAll('.frame-wrap [data-particles]')){const p=JSON.parse(canvas.dataset.values);const overlay=canvas.closest('article')?.id.match(/222[b,d,h]/);paint(canvas,p,2,Boolean(overlay));}
render();window.airDesignState=()=>clone(s);
function tick(now){if(s.playing){if(lastTime)s.clock=(s.clock+Math.min(.1,(now-lastTime)/1000))%72;const f=Math.floor(s.clock*24);if(f!==lastFrame){paint(stage.querySelector('[data-particles]'),active(),f/24);stage.querySelector('[data-clock]').value=String(f);stage.querySelector('[data-time]').textContent=`${s.clock.toFixed(2)} / 72.00`;lastFrame=f;}}lastTime=now;requestAnimationFrame(tick);}requestAnimationFrame(tick);
await document.fonts.ready;scale();

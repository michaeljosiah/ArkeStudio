// Isolated design fixture: no Studio services, world mutations, model calls or persistence.
import {nativeScreen,nativeDefaults,parseTimecode,timecode} from './air-particles-220.native.mjs';
import {renderParticles} from './air-particles-220.renderer.mjs';
const stage=document.getElementById('live-stage'),copy=x=>structuredClone(x);
let values=nativeDefaults(),draft=null,undo=[],focus='library',dark=false,highlight=true,sheet=false,libraryOpen=false,message='',playing=false,last=0,physicsOpen=false;
const device=()=>stage.clientWidth<600?'phone':stage.clientWidth<1100?'fold':'desktop';
const state=()=>({values:copy(values),draft:copy(draft),focus,sheet,playing,undo:undo.length});
window.airNativeState=state;
function paint(canvas,p){
 const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
 canvas.style.mixBlendMode=p.blend==='Screen'?'screen':p.blend==='Add'?'plus-lighter':'normal';
 if(p.added&&p.clock>=p.start&&p.clock<p.end){
  const data=renderParticles(p.clock/24,canvas.width,canvas.height,{amount:p.amount/65,size:p.size/55,speed:p.speed/35,depth:p.depth/60,texture:p.texture/100,softness:p.softness/100,turbulence:p.airflow/50,boundary:p.boundary==='Open flow'?'open':'bounce',interactions:p.interactions,seed:p.seed});
  const fade=Math.min(1,p.fadeIn?(p.clock-p.start)/p.fadeIn:1,p.fadeOut?(p.end-p.clock)/p.fadeOut:1);
  const colour=[1,3,5].map(n=>parseInt(p.colour.slice(n,n+2),16));
  for(let i=0;i<data.length;i+=4){data[i+3]=Math.min(255,data[i]*3.6)*p.opacity/100*fade;[data[i],data[i+1],data[i+2]]=colour;}
  ctx.putImageData(new ImageData(data,canvas.width,canvas.height),0,0);
 }
 canvas.dataset.ready='true';
}
function position(root,key){
 if(key==='library'){const library=root.querySelector('.n-library-content');library.scrollTop=library.scrollHeight;}
 const scroller=root.querySelector('.n-inspector-scroll'),section=root.querySelector(`[data-native-section="${key}"]`);
 if(section)scroller.scrollTop+=section.getBoundingClientRect().top-scroller.getBoundingClientRect().top-16;
 else scroller.scrollTop=0;
}
function render(keepScroll=false){
 const previous=stage.querySelector('.n-inspector-scroll')?.scrollTop||0;
 stage.innerHTML=nativeScreen({values,live:true,device:device(),focus,dark,highlight,dialog:!!draft,draft,phoneInspector:sheet,message,libraryOpen});
 const root=stage.firstElementChild;
 const details=root.querySelector('[data-native-section=motion] details');if(details)details.open=physicsOpen;
 if(keepScroll)root.querySelector('.n-inspector-scroll').scrollTop=previous;else position(root,focus);
 paint(root.querySelector('[data-native-particles]'),values);
 root.querySelectorAll('[data-native-act=play]').forEach(b=>{b.textContent=playing?'Ⅱ':'▷';b.setAttribute('aria-label',playing?'Pause preview':'Play preview');});
 const preset=root.querySelector('[data-native-key=preset]');if(preset)preset.disabled=true;
 root.querySelectorAll('[data-native-key=direction],[data-native-key=left],[data-native-key=top],[data-native-key=width],[data-native-key=height],[data-native-act=full-area]').forEach(e=>{e.disabled=true;e.title='Existing control shown for context; the independent motion study does not implement this field.';});
 root.querySelectorAll('button:not([data-native-act]),input:not([data-native-key]):not([data-native-time]),select:not([data-native-key])').forEach(e=>{e.disabled=true;e.title='Context only in this turn 220 fixture';});
}
function snapshot(){undo.push(copy(values));if(undo.length>40)undo.shift();}
function valid(p){return p.start>=0&&p.end<=1728&&p.start<p.end&&p.fadeIn>=0&&p.fadeOut>=0;}
function edit(el){
 const key=el.dataset.nativeKey??el.dataset.nativeTime;if(!key)return;
 const p=copy(draft??values);let v;
 if(el.dataset.nativeTime){v=parseTimecode(el.value);if(v===null){message='Use HH:MM:SS:FF at 24 fps (frames 00–23).';render(true);return;}}
 else if(el.type==='checkbox')v=el.checked;
 else if(el.type==='range'||el.type==='number'){if(!el.checkValidity())return;v=Number(el.value);}
 else v=el.value;
 if(key==='colour'&&!/^#[0-9a-f]{6}$/i.test(v))return;
 if(key==='move'){const delta=v-p.start;p.start+=delta;p.end+=delta;}else p[key]=v;
 if(!valid(p)){message='Use an end after the start, within this 72-second fixture.';render(true);return;}
 if(draft)draft=p;else{snapshot();values=p;}
 message='';render(true);
}
stage.addEventListener('change',e=>edit(e.target));
stage.addEventListener('input',e=>{
 const el=e.target;if(el.type!=='range')return;
 // Audition continuously; commit one undo entry on change.
 const p={...values,[el.dataset.nativeKey]:Number(el.value)};
 stage.querySelectorAll(`[data-native-key="${el.dataset.nativeKey}"]`).forEach(other=>{if(other!==el)other.value=el.value;});
 paint(stage.querySelector('[data-native-particles]'),p);
});
stage.addEventListener('toggle',e=>{if(e.target.matches('[data-native-section=motion] details'))physicsOpen=e.target.open;},true);
stage.addEventListener('click',e=>{
 const a=e.target.closest('[data-native-act]')?.dataset.nativeAct;if(!a)return;
 message='';
 switch(a){
 case 'choose':message='Air Particles selected. Choose Add effect to set target and range.';break;
 case 'add-open':draft=copy(values);libraryOpen=false;playing=false;break;
 case 'cancel':draft=null;break;
 case 'whole':draft.start=0;draft.end=1728;break;
 case 'selected-range':draft.start=0;draft.end=432;break;
 case 'add':snapshot();values={...draft,added:true,clock:Math.min(draft.end-1,draft.start+48)};draft=null;focus='placement';sheet=true;message='Air Particles added · reaction Off · Undo available';break;
 case 'pattern':snapshot();values.seed+=173;message='New pattern · Undo restores the previous pattern';break;
 case 'full-area':snapshot();Object.assign(values,{left:0,top:0,width:100,height:100});break;
 case 'undo':if(undo.length){values=undo.pop();message='Previous edit restored';}break;
 case 'play':playing=!playing;last=0;break;
 case 'inspect':sheet=true;focus='top';break;
 case 'library':libraryOpen=true;focus='library';break;
 case 'close-library':libraryOpen=false;break;
 case 'close-sheet':sheet=false;break;
 }
 render(!['add','inspect','library'].includes(a));
});
document.querySelectorAll('[data-native-demo]').forEach(b=>b.addEventListener('click',()=>{
 const a=b.dataset.nativeDemo;
 if(a==='reset'){values=nativeDefaults();draft=null;undo=[];sheet=false;libraryOpen=false;focus='library';playing=false;message='';}
 else if(a==='dark')dark=!dark;
 else{values.added=true;draft=null;focus=a;sheet=true;message='Review shortcut: selected Air Particles in the existing Inspector.';}
 render();
}));
document.querySelector('[data-native-highlight]').addEventListener('change',e=>{highlight=e.target.checked;render(true);});
function scale(){document.querySelectorAll('.frame-wrap').forEach(w=>{
 const s=w.querySelector('.frame-scale'),k=Math.min(1,w.clientWidth/Number(w.dataset.width));s.style.transform=`scale(${k})`;w.style.height=`${s.scrollHeight*k}px`;
});}
await document.fonts.ready;
render();
document.querySelectorAll('.frame-wrap [data-native-root]').forEach(root=>{
 position(root,root.dataset.focus);
 const canvas=root.querySelector('[data-native-particles]');paint(canvas,JSON.parse(canvas.dataset.values));
});
document.querySelectorAll('.legacy-frames').forEach(d=>d.addEventListener('toggle',scale));
scale();let currentDevice=device();
new ResizeObserver(()=>{const next=device();if(next!==currentDevice){currentDevice=next;render(true);}scale();}).observe(stage);
window.addEventListener('resize',scale);
// No reroll on playback. The study's motion is deterministic at a given clock and pattern.
function tick(now){if(playing){if(!last)last=now;if(now-last>=80){values.clock=(values.clock+(now-last)*24/1000)%1728;last=now;paint(stage.querySelector('[data-native-particles]'),values);stage.querySelector('.n-view-time').textContent=`${timecode(values.clock)} / 00:01:12:00`;}}requestAnimationFrame(tick);}
requestAnimationFrame(tick);

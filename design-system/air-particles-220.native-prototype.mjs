// Isolated revision 3 design fixture. No Studio services, production writes or model calls.
import {nativeScreen,nativeDefaults,parseTimecode,timecode} from './air-particles-220.native.mjs';
import {sampleRules,flowDefaults,changeCount,labels} from './air-particles-220.native-panels.mjs';
import {renderParticles} from './air-particles-220.renderer.mjs';
const stage=document.getElementById('live-stage'),copy=x=>structuredClone(x);
let current=nativeDefaults(),candidate=null,draft=null,flow=flowDefaults(),undo=[],pendingUndo=[],appliedBefore=null;
let focus='library',panel='inspector',dark=false,highlight=true,sheet=false,libraryOpen=false,message='',playing=false,last=0,clock=48,overlay=false;
let disclosures={physics:false,advanced:false,protection:false},form={property:'blend',scope:'whole',start:576,end:960},expanded=false,chatFocus='';
const device=()=>stage.clientWidth<600?'phone':stage.clientWidth<1100?'fold':'desktop';
const active=()=>flow.review&&flow.comparison==='suggested'?candidate:current;
const readOnly=()=>flow.review&&flow.comparison==='current';
window.airNativeState=()=>({values:{...copy(active()),clock},current:copy(current),candidate:copy(candidate),draft:copy(draft),flow:copy(flow),focus,panel,sheet,playing,clock,undo:undo.length,pendingUndo:pendingUndo.length,overlay});
function paint(canvas,p){
 canvas.style.background='none';canvas.style.opacity='1';const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
 canvas.style.mixBlendMode=p.blend==='Screen'?'screen':p.blend==='Add'?'plus-lighter':'normal';
 if(p.added&&!p.proxy&&p.clock>=p.start&&p.clock<p.end){
  const data=renderParticles((p.clock-p.origin)/24,canvas.width,canvas.height,{amount:p.amount/65,size:p.size/55,speed:p.speed/35,depth:p.depth/60,texture:p.texture/100,softness:p.softness/100,turbulence:p.airflow/50,boundary:p.boundary==='Open flow'?'open':'bounce',interactions:p.interactions,seed:p.seed});
  const fade=Math.max(0,Math.min(1,p.fadeIn?(p.clock-p.fadeStart)/p.fadeIn:1))*Math.max(0,Math.min(1,p.fadeOut?(p.fadeEnd-p.clock)/p.fadeOut:1)),colour=[1,3,5].map(n=>parseInt(p.colour.slice(n,n+2),16));
  for(let i=0;i<data.length;i+=4){if(p.overlay){data[i]=data[i+1]=data[i+2]=Math.min(255,data[i]*3.6);data[i+3]=255*p.opacity/100;}else{data[i+3]=Math.min(255,data[i]*3.6)*p.opacity/100*fade;[data[i],data[i+1],data[i+2]]=colour;}}
  ctx.putImageData(new ImageData(data,canvas.width,canvas.height),0,0);
 }
 canvas.dataset.ready='true';
}
function position(root,key){
 if(key==='library'){const library=root.querySelector('.n-library-content');library.scrollTop=library.scrollHeight;}
 const scroller=root.querySelector('.n-inspector-scroll'),section=root.querySelector(`[data-native-section="${key}"]`);
 if(section)scroller.scrollTop+=section.getBoundingClientRect().top-scroller.getBoundingClientRect().top-16-(root.querySelector('.n-inspector-review')?.offsetHeight||0);else scroller.scrollTop=0;
}
function render(keep=false){
 const previous=stage.querySelector('.n-inspector-scroll')?.scrollTop||0,chatScroll=stage.querySelector('.n-chat-log')?.scrollTop||0;
 stage.innerHTML=nativeScreen({values:{...active(),clock},current:flow.applied?appliedBefore:current,candidate:candidate||current,flow,live:true,device:device(),focus,panel,dark,highlight,dialog:!!draft,draft,phoneInspector:sheet,message,libraryOpen,overlay,physicsOpen:disclosures.physics,advanced:disclosures.advanced,protectionOpen:disclosures.protection,protectionForm:form,cardExpanded:expanded,chatFocus});
 const root=stage.firstElementChild;
 if(keep)root.querySelector('.n-inspector-scroll').scrollTop=previous;else position(root,focus);
 const log=root.querySelector('.n-chat-log');if(log){if(chatFocus==='incoming'&&flow.incoming){const card=log.querySelector(`[data-proposal-version="${flow.incoming.version}"]`);log.scrollTop=card.offsetTop-log.offsetTop;}else if(keep)log.scrollTop=chatScroll;}
 paint(root.querySelector('[data-native-particles]'),{...active(),clock,overlay});
 root.querySelectorAll('[data-native-act=play]').forEach(b=>{b.textContent=playing?'Ⅱ':'▷';b.setAttribute('aria-label',playing?'Pause preview':'Play preview');});
 root.querySelectorAll('[data-native-key=preset],[data-native-key=direction],[data-native-key=left],[data-native-key=top],[data-native-key=width],[data-native-key=height],[data-native-act=full-area]').forEach(e=>{e.disabled=true;e.title='Existing control shown for context in the independent design study';});
 root.querySelectorAll('button:not([data-native-act]),input:not([data-native-key]):not([data-native-time]):not([data-protection]),select:not([data-native-key]):not([data-protection])').forEach(e=>{e.disabled=true;e.title='Context only in this design fixture';});
 if(readOnly())root.querySelectorAll('[data-native-key],[data-native-time],[data-protection],[data-native-act^=protect-],[data-native-act^="release:"],[data-native-act=pattern]').forEach(e=>e.disabled=true);
}
function reset(){current=nativeDefaults();candidate=null;draft=null;flow=flowDefaults();undo=[];pendingUndo=[];appliedBefore=null;focus='library';panel='inspector';sheet=false;libraryOpen=false;message='';playing=false;clock=48;overlay=false;expanded=false;chatFocus='';disclosures={physics:false,advanced:false,protection:false};}
function sample(){current={...nativeDefaults(),added:true,rules:sampleRules()};overlay=false;}
function snapshot(){if(flow.review){pendingUndo.push({candidate:copy(candidate),flow:copy(flow)});}else undo.push(copy(current));}
function markStale(){flow.stale=true;if(flow.incoming)flow.incoming.rebased=false;}
function setActive(p){if(flow.review)candidate=p;else{current=p;if(flow.ready)markStale();}}
function protectedKey(p,k){return p.rules.some(r=>r.key===k);}
function proposal(base,less=false){const p=copy(base);p.added=true;const changes=less?{amount:Math.max(10,p.amount-12),airflow:Math.max(0,p.airflow-10),speed:Math.max(5,p.speed-10)}:{amount:Math.min(100,p.amount+15),size:Math.min(100,p.size+15),opacity:Math.min(100,p.opacity+15)};for(const [key,v] of Object.entries(changes))if(!protectedKey(p,key)&&!flow.adjusted.includes(key))p[key]=v;return p;}
function arrive(){if(!flow.ready){flow=flowDefaults();pendingUndo=[];candidate=proposal(current);flow.ready=true;}else incoming(proposal(candidate,true));message=flow.review?'A new card is ready. The reviewed preview stays active.':'Suggestion ready in Arke. Current stays active.';}
function incoming(values,releases=flow.releases,rebased=false){flow.incoming={version:Math.max(flow.version,flow.incoming?.version||0)+1,values:copy(values),releases:[...releases],adjusted:[...flow.adjusted],rebased};}
function markAdjustment(keys){keys=Array.isArray(keys)?keys:[keys];for(const key of keys)if(flow.review&&!flow.adjusted.includes(key))flow.adjusted.push(key);if(flow.incoming){const next={...flow.incoming.values};for(const key of keys)next[key]=candidate[key]===undefined?undefined:copy(candidate[key]);incoming(next,flow.incoming.releases,flow.incoming.rebased);message='A fresh waiting version carries your adjustment. The active preview stays selected.';}}
function commit(p,key){const before=active(),keys=Object.keys(p).filter(k=>JSON.stringify(before[k])!==JSON.stringify(p[k]));snapshot();setActive(p);if(flow.review)markAdjustment(keys.length?keys:[key]);}
function valid(p){return p.start>=0&&p.end<=1728&&p.start<p.end&&p.fadeIn>=0&&p.fadeOut>=0&&p.fadeIn<=p.end-p.start&&p.fadeOut<=p.end-p.start;}
function edit(el){
 if(readOnly())return;
 if(el.dataset.protection){const key=el.dataset.protection;const v=['start','end'].includes(key)?parseTimecode(el.value):el.value;if(v===null)return;form[key]=v;render(true);return;}
 const key=el.dataset.nativeKey??el.dataset.nativeTime;if(!key)return;
 const p=copy(draft??active());let v;
 if(el.dataset.nativeTime){v=parseTimecode(el.value);if(v===null){message='Use HH:MM:SS:FF at 24 fps (frames 00–23).';render(true);return;}}
 else if(el.type==='checkbox')v=el.checked;
 else if(el.type==='range'||el.type==='number'){if(!el.checkValidity())return;v=Number(el.value);}else v=el.value;
 if(key==='colour'&&!/^#[0-9a-f]{6}$/i.test(v))return;
 if(key==='reaction'&&v&&p.source==='No audio source')return;
 if(key==='move'){const delta=v-p.start;p.start+=delta;p.end+=delta;p.origin+=delta;p.fadeStart+=delta;p.fadeEnd+=delta;}else p[key]=v;
 if(key==='source'&&v==='No audio source')p.reaction=false;
 if(key==='response'&&v!=='Custom'){const mappings={'Gentle shimmer':{beat:0,bass:0,energy:30,affected:'Brightness',limit:30,smoothing:10},'Beat pulse':{beat:100,bass:0,energy:0,affected:'Emission',limit:60,smoothing:2},'Build with energy':{beat:0,bass:0,energy:100,affected:'Emission',limit:50,smoothing:12}};const patch=mappings[v];if(patch){if(Object.keys(patch).some(k=>protectedKey(p,k)&&p[k]!==patch[k])){message='That response would change a protected setting. Edit the named control directly or explicitly Release its rule.';render(true);return;}Object.assign(p,patch);}}
 if(['beat','bass','energy','affected','limit','smoothing'].includes(key))p.response='Custom';
 if(!valid(p)){message='Use a valid interval within this 72-second fixture; fades must fit its duration.';render(true);return;}
 if(draft)draft=p;else commit(p,key);
 if(!flow.incoming)message=flow.review?'Adjusted by you · retained in revisions':'Saved in the design fixture · Undo available';render(true);
}
function protect(rule){if(readOnly())return;const p=copy(active());if(p.rules.some(r=>JSON.stringify({...r,id:''})===JSON.stringify({...rule,id:''}))){message='That exact rule is already present.';return;}snapshot();p.rules.push(rule);setActive(p);message='Protection added. Your own edits remain available.';}
function release(id,pending){
 const source=pending?(candidate||current):current,rule=source.rules.find(r=>r.id===id);if(!rule)return;
 if(pending){const p=copy(flow.incoming?.values||candidate||current);p.rules=p.rules.filter(r=>r.id!==id);incoming(p,[...new Set([...(flow.incoming?.releases||flow.releases),id])]);flow.needsReview=true;panel='arke';sheet=true;chatFocus='incoming';expanded=false;message='Named Release on Apply prepared. Review the fresh card before Apply.';}
 else{snapshot();current.rules=current.rules.filter(r=>r.id!==id);if(flow.ready)markStale();message='Named Current rule released · Undo available';}
}
function act(a){
 message='';chatFocus='';
 if(a.startsWith('keep:')){const key=a.slice(5);if(!candidate||flow.stale)return;snapshot();candidate[key]=current[key];if(!flow.adjusted.includes(key))flow.adjusted.push(key);if(!flow.kept.includes(key))flow.kept.push(key);markAdjustment(key);message=`Keep current ${labels[key]} · retained in revisions`;render(true);return;}
 if(a.startsWith('permit:')){const key=a.slice(7);flow.adjusted=flow.adjusted.filter(k=>k!==key);flow.kept=flow.kept.filter(k=>k!==key);message=`Arke may revise ${labels[key]} in this family. Permanent protection stays.`;render(true);return;}
 if(a.startsWith('release:')||a.startsWith('proposal-release:')){release(a.split(':')[1],a.startsWith('proposal-')||flow.review);render(true);return;}
 switch(a){
 case 'choose':message='Air Particles selected. Add effect chooses target and time.';break;
 case 'add-open':if(readOnly())break;draft=copy(active());libraryOpen=false;playing=false;break;
 case 'cancel':draft=null;break;
 case 'whole':draft.start=0;draft.end=1728;break;
 case 'selected-range':draft.start=0;draft.end=432;break;
 case 'add':snapshot();setActive({...draft,added:true,origin:draft.start,fadeStart:draft.start,fadeEnd:draft.end});clock=Math.min(draft.end-1,draft.start+48);draft=null;focus='placement';panel='inspector';sheet=true;break;
 case 'fit-fades':if(!readOnly())commit({...active(),fadeStart:active().start,fadeEnd:active().end},'fades');break;
 case 'pattern':if(!readOnly())commit({...active(),seed:active().seed+173},'seed');break;
 case 'undo':if(flow.review&&flow.comparison==='suggested'&&pendingUndo.length){const p=pendingUndo.pop();candidate=p.candidate;flow=p.flow;message='Pending edit restored. Current is unchanged.';}else if(!flow.review&&undo.length){current=undo.pop();candidate=null;flow=flowDefaults();message='Previous authored arrangement and rules restored.';}break;
 case 'play':playing=!playing;last=0;break;
 case 'inspect':panel='inspector';sheet=true;focus='top';break;
 case 'inspect-effect':if(flow.review&&flow.comparison==='suggested'){panel='inspector';sheet=true;focus='appearance';}break;
 case 'arke':panel='arke';sheet=true;break;
 case 'library':libraryOpen=true;focus='library';break;
 case 'close-library':libraryOpen=false;break;
 case 'close-sheet':sheet=false;if(device()!=='desktop')panel='inspector';break;
 case 'review':if(flow.ready&&!flow.stale&&!flow.needsReview){flow.review=true;flow.comparison='suggested';if(device()!=='desktop'){sheet=false;panel='inspector';}}break;
 case 'review-incoming':if(flow.incoming&&(!flow.stale||flow.incoming.rebased)){const next=flow.incoming;candidate=copy(next.values);flow.version=next.version;flow.releases=[...next.releases];flow.adjusted=[...next.adjusted];flow.incoming=null;flow.ready=true;flow.review=true;flow.comparison='suggested';flow.stale=false;flow.needsReview=false;pendingUndo=[];if(device()!=='desktop'){sheet=false;panel='inspector';}}break;
 case 'compare-current':flow.comparison='current';break;
 case 'compare-suggested':flow.comparison='suggested';break;
 case 'close-review':flow.review=false;flow.comparison='current';break;
 case 'changes':panel='arke';sheet=true;expanded=true;if(flow.needsReview&&flow.incoming)chatFocus='incoming';break;
 case 'details':expanded=!expanded;break;
 case 'revise':panel='arke';sheet=true;message='Use the scripted “less busy” revision above to demonstrate an arriving card.';break;
 case 'update':{const p=proposal(current);for(const key of flow.adjusted)p[key]=candidate[key];p.rules=copy(current.rules);incoming(p,[],true);flow.needsReview=true;panel='arke';sheet=true;chatFocus='incoming';message='Fresh card prepared. Current and the active preview stay unchanged. Changed release baselines need a new named Release.';break;}
 case 'apply':if(flow.review&&!flow.stale&&!flow.needsReview&&flow.comparison==='suggested'&&changeCount(current,candidate,flow.releases)>0){undo.push(copy(current));appliedBefore=copy(current);current=copy(candidate);flow.applied=true;flow.review=false;flow.ready=false;flow.incoming=null;flow.comparison='current';panel='arke';sheet=true;message='Applied exact reviewed arrangement · one Undo';}break;
 case 'discard':candidate=null;flow=flowDefaults();pendingUndo=[];message='Discarded pending arrangement and release decisions. Current is unchanged.';break;
 case 'protect-start':case 'protect-end':{const key=a.slice(8);protect({id:'boundary-'+key,kind:'boundary',key});break;}
 case 'protect-setting':if(form.scope==='passage'&&(form.end<=form.start||form.start<0||form.end>1728)){message='Choose a valid fixed passage.';break;}protect({id:'rule-'+Date.now(),kind:'property',key:form.property,scope:form.scope,...form.scope==='passage'?{start:form.start,end:form.end}:{}});break;
 case 'protect-coverage':if(form.end<=form.start||form.start<0||form.end>1728){message='Choose a valid fixed passage.';break;}protect({id:'coverage-'+Date.now(),kind:'coverage',start:form.start,end:form.end});break;
 }
 render(!['add','inspect','inspect-effect','arke','changes'].includes(a));
}
stage.addEventListener('change',e=>edit(e.target));
stage.addEventListener('input',e=>{const el=e.target;if(el.type!=='range'||readOnly())return;const p={...active(),clock,overlay,[el.dataset.nativeKey]:Number(el.value)};stage.querySelectorAll(`[data-native-key="${el.dataset.nativeKey}"]`).forEach(other=>{if(other!==el)other.value=el.value;});paint(stage.querySelector('[data-native-particles]'),p);});
stage.addEventListener('toggle',e=>{if(stage.contains(e.target)&&e.target.dataset.nativeDisclosure)disclosures[e.target.dataset.nativeDisclosure]=e.target.open;},true);
stage.addEventListener('click',e=>{const ruler=e.target.closest('[data-native-ruler]');if(ruler){const box=ruler.getBoundingClientRect(),label=device()==='phone'?44:88;clock=Math.min(1727,Math.max(0,Math.round((e.clientX-box.left-label)/(box.width-label)*1728)));playing=false;render(true);return;}const button=e.target.closest('[data-native-act]');if(button&&!button.disabled)act(button.dataset.nativeAct);});
document.querySelectorAll('[data-native-demo]').forEach(b=>b.addEventListener('click',()=>{
 const a=b.dataset.nativeDemo;message='';chatFocus='';
 if(a==='reset')reset();else if(a==='dark')dark=!dark;
 else if(a==='arke'){reset();sample();arrive();panel='arke';sheet=true;}
 else if(a==='receive'){arrive();}
 else if(a==='less-busy'){if(!candidate)arrive();else incoming(proposal(candidate,true));message='Scripted revision arrived in Arke. The active preview and selected panel are unchanged.';}
 else if(a==='stale'){undo.push(copy(current));current.opacity=Math.max(0,current.opacity-5);if(flow.ready)markStale();message='Current opacity changed. Update and Review are required.';}
 else if(a==='overlay'){reset();current={...nativeDefaults(),added:true,end:190};overlay=true;focus='appearance';sheet=true;}
 else{if(!active().added)current.added=true;panel='inspector';focus=a;sheet=true;draft=null;if(a==='motion')disclosures.physics=true;if(a==='protection'){if(!current.rules.length&&!flow.review)current.rules=sampleRules();disclosures.protection=false;}}
 render();
}));
document.querySelector('[data-native-highlight]').addEventListener('change',e=>{highlight=e.target.checked;render(true);});
function scale(){document.querySelectorAll('.frame-wrap').forEach(w=>{const s=w.querySelector('.frame-scale'),k=Math.min(1,w.clientWidth/Number(w.dataset.width));s.style.transform=`scale(${k})`;w.style.height=`${s.scrollHeight*k}px`;});}
await document.fonts.ready;render();
document.querySelectorAll('.frame-wrap [data-native-root]').forEach(root=>{position(root,root.dataset.focus);const canvas=root.querySelector('[data-native-particles]');paint(canvas,JSON.parse(canvas.dataset.values));});
scale();let currentDevice=device();new ResizeObserver(()=>{const next=device();if(next!==currentDevice){currentDevice=next;render(true);}scale();}).observe(stage);window.addEventListener('resize',scale);
stage.addEventListener('keydown',e=>{if(e.target.matches('[data-native-ruler]')&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();clock=Math.max(0,Math.min(1727,clock+(e.key==='ArrowRight'?1:-1)));playing=false;render(true);stage.querySelector('[data-native-ruler]').focus();}});
function syncClock(){stage.querySelectorAll('[data-native-clock]').forEach(e=>e.textContent=timecode(clock));stage.querySelector('.n-view-time').textContent=`${timecode(clock)} / 00:01:12:00`;stage.querySelector('.n-playhead').style.left=`calc(var(--n-track-label,88px) + (100% - var(--n-track-label,88px)) * ${clock/1728})`;stage.querySelector('[data-native-ruler]').setAttribute('aria-valuenow',String(Math.round(clock)));}
function tick(now){if(playing){if(!last)last=now;if(now-last>=80){clock=(clock+Math.round((now-last)*24/1000))%1728;last=now;paint(stage.querySelector('[data-native-particles]'),{...active(),clock,overlay});syncClock();}}requestAnimationFrame(tick);}requestAnimationFrame(tick);

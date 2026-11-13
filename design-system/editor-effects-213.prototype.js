// Synthetic fixtures for a proposed design. No app connection, model call or real audio analysis.
(() => {
 const root=document.getElementById('effects-prototype');
 if(!root)return;
 const status=document.getElementById('prototype-status');
 const storageKey='arke-design-effects-213-review-v3';
 const fresh=()=>({amount:42,size:24,opacity:60,speed:18,strength:30,response:'Gentle shimmer',beat:60,bass:20,energy:35,limit:65,target:'Brightness',smoothing:'Soft swells',react:true,embers:true,leak:false,protected:true,protections:[{key:'colour',scope:'Whole effect',passage:''},{key:'start',scope:'Selected range',passage:'0:00–0:24'},{key:'end',scope:'Selected range',passage:'0:00–0:24'}],visualTarget:'Whole composition',start:'0:00',end:'3:12',audioSource:'Audio track · Audio 1',points:[54,45,45,12,12,45,57],reactionPoints:[57,51,51,25,25,51,60]});
 const clone=value=>JSON.parse(JSON.stringify(value));
 let state={proposal:fresh(),current:{...fresh(),amount:35,strength:15,embers:false,leak:true},view:'current',reviewing:false,incoming:null,time:96,version:1,adjusted:false,stale:false,applied:false,discarded:false,baseRevision:21,reviewBase:21,panel:'chat',curve:'Intensity'};
 try{const saved=JSON.parse(localStorage.getItem(storageKey));if(saved?.proposal&&saved?.current)state={...state,...saved};}catch{}
 let playing=false,lastStart=0,startTime=state.time,previewReaction=true,hiddenDust=false,loop=false,advanced=false,dialogDraft=null,protectionDraft={scope:'Selected range',passage:'0:00–0:24',keys:['start','end']},dragPoint=null;
 const q=selector=>root.querySelector(selector);
 const all=selector=>[...root.querySelectorAll(selector)];
 const say=text=>{status.textContent=text;};
 const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify(state));}catch{}};
 const pending=()=>!state.applied&&!state.discarded;
 const editable=()=>state.reviewing&&state.reviewing&&state.view==='suggested'&&pending()&&!state.stale;
 const shown=()=>state.view==='current'?state.current:state.proposal;
 const fillTemplate=key=>document.getElementById('fx-template-'+key).innerHTML;
 const format=sec=>`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(Math.floor(sec%60)).padStart(2,'0')}:${String(Math.floor(sec%1*24)).padStart(2,'0')}`;
 function mark(){state.adjusted=true;save();refresh();}
 function setPanel(key){if(key==='changes')key='chat';state.panel=key;const panel=q('[data-panel]');q('.inspector').hidden=false;root.classList.toggle('chat-open',key==='chat');const template=key==='chat'?(state.incoming?'revisionChat':state.reviewing?'reviewChat':'chat'):key;panel.innerHTML=fillTemplate(template);panel.scrollTop=0;all('.panel-tabs [data-act]').forEach(b=>b.classList.toggle('on',b.dataset.act===(key==='chat'?'chat':'inspect')));refresh();save();}

 function updateCurve(){const curve=q('[data-live-curve]');const points=state.curve==='Intensity'?state.proposal.points:state.proposal.reactionPoints;const xs=[0,90,210,320,390,490,590];curve.querySelector('.base').setAttribute('points',points.map((y,i)=>`${xs[i]},${y}`).join(' '));[...curve.querySelectorAll('circle')].forEach((dot,i)=>{dot.setAttribute('cy',points[i]);dot.setAttribute('aria-valuenow',Math.round((60-points[i])/.48));});q('[data-curve-label]').textContent=state.curve;}
 function refresh(){
  root.dataset.view=state.view;q('[data-review-shell]').hidden=!state.reviewing&&!state.applied;
  root.dataset.reviewing=String(state.reviewing);root.dataset.pending=String(pending());root.dataset.stale=String(state.stale);
  q('[data-view-label]').textContent=state.view==='current'?'Current':'Suggested';
  q('[data-review-title]').textContent=state.applied?'Arrangement applied':state.discarded?'Suggestion discarded':state.stale?'Review needs updating':'Reviewing suggestion';
  q('[data-review-meta]').textContent=state.applied?'One undoable edit':state.discarded?'Current arrangement retained':state.stale?'Timeline changed · your adjustments retained':`Version ${state.version} · ${state.adjusted?'Adjusted by you · ':''}${state.proposal.start}–${state.proposal.end}`;
  all('.review-bar [data-act="current"],.review-bar [data-act="suggested"]').forEach(b=>b.classList.toggle('on',b.dataset.act===state.view));
  const apply=q('.review-bar [data-act="apply"],.review-bar [data-act="undo"],.review-bar [data-act="update"]');
  apply.dataset.act=state.applied?'undo':state.stale?'update':'apply';apply.textContent=state.applied?'Undo arrangement':state.stale?'Update proposal':'Apply reviewed version';apply.disabled=state.discarded||(!state.stale&&!state.applied&&state.proposal.react&&state.proposal.audioSource==='Choose audio…');
  q('.review-bar [data-act="discard"]').disabled=!pending();
  q('[data-footer]').textContent=state.applied?'Applied · one Undo entry':state.discarded?'Current arrangement':state.reviewing?'Pending effects review':'Suggestion ready in Arke · Current timeline';
  all('[data-panel] [data-key]').forEach(el=>{const key=el.dataset.key;el.value=key==='protectionRange'?protectionDraft.scope:key==='protectedPassage'?protectionDraft.passage:state.proposal[key]??el.value;if(el.nextElementSibling?.tagName==='OUTPUT')el.nextElementSibling.textContent=el.value+'%';el.disabled=!editable();});
  const changed=q('[data-amount-change]');if(changed)changed.textContent=state.proposal.amount+'%';
  all('[data-atmosphere-note]').forEach(el=>el.hidden=state.proposal.react);
  all('[data-protection-selection]').forEach(el=>el.textContent=(protectionDraft.keys.map(propertyLabel).join(', ')||'No settings selected')+' · '+(protectionDraft.scope==='Whole effect'?'whole effect':protectionDraft.passage));
  const protectedList=q('[data-current-protection]');if(protectedList){protectedList.replaceChildren();state.proposal.protections.forEach((p,i)=>{const row=document.createElement('div');row.className='protection-entry';const label=document.createElement('span');label.className='meta';label.textContent=propertyLabel(p.key)+' · '+(p.scope==='Whole effect'?'whole effect':p.passage);const release=document.createElement('button');release.type='button';release.dataset.act='release-protection';release.dataset.protectionIndex=i;release.textContent='Release '+propertyLabel(p.key).toLowerCase();release.disabled=!editable();row.append(label,release);protectedList.append(row);});if(!state.proposal.protections.length)protectedList.textContent='No protected settings';}
  all('[data-act="react"]').forEach(b=>{b.setAttribute('aria-checked',state.proposal.react);b.classList.toggle('off',!state.proposal.react);b.querySelector('b').textContent=state.proposal.react?'On':'Off';b.disabled=!editable();});
  all('[data-protect]').forEach(el=>{el.checked=protectionDraft.keys.includes(el.dataset.protect);el.disabled=!editable();});
  all('[data-protection-summary]').forEach(el=>el.textContent=state.proposal.protections.map(p=>`${propertyLabel(p.key)} · ${p.scope==='Whole effect'?'whole effect':p.passage}`).join(' / ')||'No protected settings');
  all('[data-protection-count]').forEach(el=>el.textContent=state.proposal.protections.length+' settings');
  const incomingCard=el=>el.closest('[data-card-role="incoming"]');
  const cardDataFor=el=>incomingCard(el)?state.incoming?.proposal||state.proposal:state.proposal;
  const cardData=state.incoming?.proposal||state.proposal;
  all('[data-placement-summary]').forEach(el=>{const p=cardDataFor(el);el.textContent=`${p.visualTarget} · ${p.start}–${p.end}`;});
  all('[data-audio-summary]').forEach(el=>{const p=cardDataFor(el);el.textContent=p.react?`${p.audioSource} · ${p.response}`:'Audio reaction off';});
  all('[data-card-version]').forEach(el=>el.textContent='Version '+(incomingCard(el)?state.incoming?.version||state.version:state.version));
  all('[data-card-status]').forEach(el=>el.textContent=state.applied?'Applied':state.discarded?'Discarded':state.stale&&!incomingCard(el)?'Needs updating':incomingCard(el)?'Ready · not previewing':state.reviewing?'Reviewing':'Ready · not previewing');
  all('[data-card-scope]').forEach(el=>{const p=cardDataFor(el);el.textContent=`${p.visualTarget} · ${p.start}–${p.end} / ${p.react?p.audioSource:'Audio reaction off'}`;});
  all('[data-card-adjustments]').forEach(el=>el.textContent=state.adjusted?`Adjusted by you · amount ${cardDataFor(el).amount}%`:'1 changed · 1 added · 1 removed');
  all('[data-card-protection]').forEach(el=>el.textContent=cardDataFor(el).protections.map(p=>propertyLabel(p.key)+' · '+(p.scope==='Whole effect'?'whole effect':p.passage)).join(' / '));
  all('[data-card-review]').forEach(b=>{b.dataset.act=incomingCard(b)?'review-new':'review';b.textContent=incomingCard(b)?'Review version '+state.incoming.version:'Review in timeline';b.disabled=!pending()||state.stale&&!incomingCard(b);});
  all('[data-card-preview]').forEach(el=>el.textContent=`Reviewing Version ${state.version} · ${state.view==='current'?'Current':'Suggested'}`);
  all('[data-amount-change]').forEach(el=>el.textContent=cardDataFor(el).amount+'%');
  all('[data-placement-audio]').forEach(el=>el.textContent=state.proposal.react?`${state.proposal.audioSource} · independent input`:'Off · atmosphere continues');
  all('[data-reaction-settings]').forEach(el=>el.hidden=!state.proposal.react);
  all('[data-audio-controls]').forEach(el=>el.hidden=!state.proposal.react);
  all('[data-source-status]').forEach(el=>el.textContent=state.proposal.audioSource==='Choose audio…'?'Choose a source to enable reaction':state.proposal.audioSource==='Composition audio mix'?'Ready · mix follows timeline mute and levels':state.proposal.audioSource==='Video sound · Harbour boat.mp4'?'Ready · Video 1 clip at 1:36–1:44':'Ready · source follows Audio 1 placement');
  all('[data-act="save-protection"],[data-act="release-protection"],[data-source]').forEach(el=>el.disabled=!editable());
  all('[data-act="save-protection"]').forEach(el=>el.disabled=!editable()||!protectionDraft.keys.length);
  all('[data-source]').forEach(el=>el.classList.toggle('on',el.dataset.source===state.proposal.audioSource));
  const count=1+Number(state.proposal.embers)+Number(!state.proposal.leak);q('[data-change-count]').textContent=count+' changes';q('[data-change-count]').hidden=!pending();all('[data-card-count]').forEach(el=>el.textContent=(1+Number(cardDataFor(el).embers)+Number(!cardDataFor(el).leak))+' changes');

  all('.advanced-section').forEach(el=>el.hidden=!advanced);
  all('[data-act="advanced"]').forEach(b=>{b.textContent=(advanced?'⌄':'›')+' Advanced';b.setAttribute('aria-expanded',advanced);});
  q('[data-effect="embers"]').hidden=!shown().embers;
  q('[data-effect="dust"]').textContent=`Floating dust · ${shown().visualTarget.replace('Video track · ','')} · ${shown().amount}%${state.proposal.protected?' · Protected':''}`;
  const leak=q('[data-effect="leak"]');if(leak){leak.hidden=state.view==='current'&&!shown().leak;leak.classList.toggle('removed',state.reviewing&&state.view==='suggested'&&pending()&&!state.proposal.leak);leak.textContent=state.reviewing&&state.view==='suggested'&&pending()&&!state.proposal.leak?'Light leak · Removed':'Light leak';}
  all('.effect-block[data-effect="dust"],.effect-block[data-effect="embers"]').forEach(el=>el.classList.toggle('proposed',state.reviewing&&state.view==='suggested'&&pending()));
  const dust=q('[data-effect="dust"]');dust.style.left=(parseTime(shown().start)/192*100)+'%';dust.style.width=(Math.max(0,parseTime(shown().end)-parseTime(shown().start))/192*100)+'%';
  q('.viewer-foot').textContent=state.view==='current'?'Current · same playhead':'Suggested · build 1:20–2:08';
  q('[data-act="preview-react"]').textContent=previewReaction?'Reaction on':'Reaction off';
  all('[data-act="curve-intensity"],[data-act="curve-reaction"]').forEach(b=>b.classList.toggle('on',(b.dataset.act==='curve-intensity')===(state.curve==='Intensity')));
  all('[data-panel] [data-act="exclude"],[data-panel] [data-act="keep-current"],[data-panel] [data-act="keep-leak"],[data-panel] [data-act="inspect-dust"]').forEach(b=>b.disabled=!editable()||!!incomingCard(b));
  all('[data-act="send"]').forEach(b=>b.disabled=!pending());
  updateCurve();paint();
 }
 function openDialog(key){dialogDraft=key==='placement'?{addVisualTarget:'Whole composition',addRange:'Whole video · 0:00–3:12',start:'0:00',end:'3:12'}:{suggestVisualTarget:'Whole composition',suggestRange:'Whole video · 0:00–3:12',suggestAudioSource:'Audio track · Audio 1'};q('[data-live-dialog]').innerHTML=fillTemplate(key);q('[data-live-dialog] button')?.focus();}
 function closeDialog(){q('[data-live-dialog]').innerHTML='';dialogDraft=null;q('[data-act="place"]')?.focus();}
 function sampleCurve(points,time){const xs=[0,90,210,320,390,490,590];const x=time/192*590;let i=0;while(i<xs.length-2&&x>xs[i+1])i++;const f=Math.min(1,Math.max(0,(x-xs[i])/(xs[i+1]-xs[i])));return Math.max(0,(60-(points[i]+(points[i+1]-points[i])*f))/48);}
 const canvas=q('canvas'),ctx=canvas.getContext('2d');
 q('[data-particles]').hidden=true;
 function paint(){
  const p=shown(),w=canvas.clientWidth||640,h=canvas.clientHeight||360;canvas.width=w;canvas.height=h;ctx.clearRect(0,0,w,h);
  const t=state.time,beat=Math.exp(-((t*2)%1)*8),energy=.5+.5*Math.sin(t/8);
  const sourceActive=p.audioSource!=='Choose audio…'&&(p.audioSource!=='Video sound · Harbour boat.mp4'||(t>=96&&t<104));
  const pulse=previewReaction&&p.react&&sourceActive?(p.response==='Beat pulse'?beat:p.response==='Build with energy'?energy:.25*beat+.6*energy)*p.strength/100:0;
  const envelope=sampleCurve(p.points,t),fade=Math.min(1,t/4,(192-t)/8);
  const effectActive=t>=parseTime(p.start)&&t<parseTime(p.end);
  if(!hiddenDust&&effectActive){for(let i=0;i<Math.round(p.amount*.8);i++){const x=((i*71.3+t*(.25+p.speed/40))%100)/100*w,y=((i*43.7-t*(.35+p.speed/65)+10000)%100)/100*h;ctx.globalAlpha=Math.min(1,(.15+(i%5)*.1+pulse)*p.opacity/100*envelope*fade);ctx.fillStyle='#fff4d7';ctx.beginPath();ctx.arc(x,y,1+(i%3)*p.size/30,0,Math.PI*2);ctx.fill();}}
  if(p.embers&&t>=80&&t<128){for(let i=0;i<24;i++){ctx.globalAlpha=(.3+.5*pulse)*Math.min(1,(t-80)/3,(128-t)/6);ctx.fillStyle='#f5b83d';ctx.beginPath();ctx.arc(((i*39.7+t*.4)%100)/100*w,((i*73.1-t*2+10000)%100)/100*h,1+i%3,0,Math.PI*2);ctx.fill();}}
  if(p.leak&&t>=144){const g=ctx.createLinearGradient(0,0,w*.55,h);g.addColorStop(0,'rgba(255,200,120,.4)');g.addColorStop(1,'rgba(255,200,120,0)');ctx.globalAlpha=Math.min(1,(t-144)/4,(192-t)/8);ctx.fillStyle=g;ctx.fillRect(0,0,w,h);}
  ctx.globalAlpha=1;q('[data-clock]').textContent=format(t);q('[data-key="seek"]').value=t;q('[data-playhead]').style.left=`${14+t/192*84}%`;
 }
 function animate(now){if(playing){state.time=startTime+(now-lastStart)/1000;if(loop&&state.time>128){state.time=80;startTime=80;lastStart=now;}if(state.time>=192){state.time=192;playing=false;q('[data-act="play"]').textContent='▶';}paint();}requestAnimationFrame(animate);}
 const parseTime=value=>{const parts=String(value).split(':').map(Number);return parts.length===2&&parts.every(Number.isFinite)?parts[0]*60+parts[1]:0;};
 const propertyLabel=key=>({visualTarget:'Visual target',start:'Start',end:'End',colour:'Colour',amount:'Amount',size:'Particle size',opacity:'Opacity',audioSource:'Audio source',strength:'Reaction strength',points:'Intensity curve',reactionPoints:'Reaction curve'})[key]||key;
 const protectedAt=(key,start,end)=>state.proposal.protections.some(p=>p.key===key&&(p.scope==='Whole effect'||(()=>{const parts=p.passage.split('–');return parts.length===2&&parseTime(parts[0])<end&&parseTime(parts[1])>start;})()));
 root.addEventListener('input',event=>{const el=event.target;
  if(el.dataset.protect){protectionDraft.keys=all('[data-protect]:checked').map(c=>c.dataset.protect);refresh();return;}
  if(!el.dataset.key)return;const key=el.dataset.key;
  if(el.closest('[data-live-dialog]')){dialogDraft[key]=el.value;if(key==='addRange'){const values=el.value.split(' · ')[1].split('–');dialogDraft.start=values[0];dialogDraft.end=values[1];all('[data-live-dialog] [data-key="start"],[data-live-dialog] [data-key="end"]').forEach(e=>e.value=dialogDraft[e.dataset.key]);}return;}
  if(key==='seek'){state.time=+el.value;startTime=state.time;lastStart=performance.now();paint();save();return;}
  if(!editable())return;
  if(key==='protectionRange'){protectionDraft.scope=el.value;refresh();return;}if(key==='protectedPassage'){protectionDraft.passage=el.value;refresh();return;}
  state.proposal[key]=el.type==='range'?+el.value:el.value;
  if(['beat','bass','energy','target','smoothing','limit'].includes(key))state.proposal.response='Custom';mark();
 });
 root.addEventListener('click',event=>{
  const b=event.target.closest('[data-act]');if(!b||b.disabled){if(event.target.closest('[data-effect="dust"]'))setPanel('appearance');return;}const act=b.dataset.act;
  if(act==='current'||act==='suggested'){if(!state.reviewing)return;state.view=act;save();refresh();say(`${act==='current'?'Current':'Suggested'} at ${format(state.time)}. Comparison preserves the clock.`);return;}
  if(act==='inspect'||act==='inspect-dust'){setPanel('appearance');return;}if(act==='changes'){setPanel('chat');all('.retained-card').forEach(el=>el.open=true);const active=q('[data-card-role="active"]');active.querySelector('.proposal-details').open=true;active.scrollIntoView({block:'nearest'});return;}if(act==='response'){setPanel('response');return;}if(act==='placement-settings'){setPanel('placementSettings');return;}if(act==='sources'){setPanel('sources');return;}if(act==='protect-settings'){setPanel('protect');return;}
  if(act.startsWith('source-')&&editable()){state.proposal.audioSource=b.dataset.source;mark();setPanel('response');say('Audio source selected; visual target and effect interval retained.');return;}
  if(act==='close-panel'){q('.inspector').hidden=true;return;}
  if(act==='chat'||act==='ask'){setPanel('chat');return;}if(act==='effects'){openDialog('placement');return;}
  if(act==='advanced'){advanced=!advanced;refresh();return;}
  if(act==='curves'){setPanel('curves');return;}
  if(act==='curve-intensity'||act==='curve-reaction'){state.curve=act==='curve-intensity'?'Intensity':'Audio reaction';refresh();return;}
  if(act==='play'){playing=!playing;startTime=state.time;lastStart=performance.now();b.textContent=playing?'Ⅱ':'▶';b.setAttribute('aria-label',playing?'Pause preview':'Play preview');return;}
  if(act==='preview-react'){previewReaction=!previewReaction;refresh();say('Temporary comparison only; the reviewed response settings stay intact.');return;}
  if(act==='loop'){loop=!loop;b.classList.toggle('primary',loop);say(loop?'Looping 1:20–2:08.':'Loop off.');return;}
  if(act==='hide'){hiddenDust=!hiddenDust;paint();say(hiddenDust?'Dust hidden for inspection.':'Dust visible again.');return;}
  if(act==='react'&&editable()){state.proposal.react=!state.proposal.react;mark();return;}
  if(act==='save-protection'&&editable()){const selected=protectionDraft.keys.map(key=>({key,scope:protectionDraft.scope,passage:protectionDraft.scope==='Whole effect'?'':protectionDraft.passage}));state.proposal.protections=[...state.proposal.protections.filter(p=>!selected.some(n=>n.key===p.key&&n.scope===p.scope&&n.passage===p.passage)),...selected];state.proposal.protected=state.proposal.protections.length>0;mark();setPanel('appearance');say('Selected properties protected. Direct edits remain available; other settings stay editable.');return;}
  if(act==='release-protection'&&editable()){state.proposal.protections.splice(+b.dataset.protectionIndex,1);state.proposal.protected=state.proposal.protections.length>0;mark();say('Selected protection released; other protection remains.');return;}

  if(act==='keep-current'&&editable()){state.proposal.amount=state.current.amount;state.proposal.response=state.current.response;state.proposal.strength=state.current.strength;mark();say('Dust restored to current values in the pending proposal.');return;}
  if(act==='exclude'&&editable()){state.proposal.embers=false;mark();say('Embers excluded; the complete proposal is updated.');return;}
  if(act==='keep-leak'&&editable()){state.proposal.leak=true;mark();say('Light leak retained in the pending proposal.');return;}
  if(act==='apply'&&pending()&&!state.stale&&(!state.proposal.react||state.proposal.audioSource!=='Choose audio…')){state.previous=clone(state.current);state.current=clone(state.proposal);state.applied=true;state.reviewing=false;state.incoming=null;state.view='current';state.baseRevision++;save();refresh();say('Exactly this adjusted arrangement applied as one undoable edit.');return;}
  if(act==='undo'&&state.previous){state.current=clone(state.previous);state.previous=null;state.applied=false;state.reviewing=false;state.discarded=true;state.baseRevision++;save();refresh();say('Arrangement undone in one action.');return;}
  if(act==='discard'){state.discarded=true;state.reviewing=false;state.incoming=null;state.view='current';save();refresh();say('Suggestion discarded. Current effect settings retained.');return;}
  if(act==='update'){state.incoming={proposal:clone(state.proposal),version:state.version+1,base:state.baseRevision};setPanel('chat');save();refresh();say('Updated composite card ready. Choose Review in timeline to inspect it; the old review remains unchanged.');return;}

  if(act==='highlights'||act==='next'){state.time=act==='highlights'?80:state.time<80?80:state.time<128?128:0;startTime=state.time;lastStart=performance.now();paint();save();say('Jumped to the next changed passage.');return;}
  if(act==='place'){openDialog('placement');return;}if(act==='suggest'){openDialog('suggest');return;}
  if(act==='cancel'||act==='close-sheet'){closeDialog();return;}
  if(act==='add'){const draft=clone(dialogDraft);if(parseTime(draft.end)<=parseTime(draft.start)||parseTime(draft.end)>192){say('Choose an end after the start within 0:00–3:12.');return;}closeDialog();Object.assign(state.proposal,{amount:42,visualTarget:draft.addVisualTarget,start:draft.start,end:draft.end,react:false,audioSource:'Choose audio…'});state.discarded=false;state.applied=false;state.reviewing=true;state.view='suggested';mark();setPanel('appearance');say('Floating dust added to the pending arrangement with independent target/time and audio reaction off.');return;}
  if(act==='prepare'){const draft=clone(dialogDraft),prior=clone(state.proposal),range=draft.suggestRange.split(' · ')[1].split('–');closeDialog();const next={...fresh(),visualTarget:draft.suggestVisualTarget,start:range[0],end:range[1],react:!draft.suggestAudioSource.startsWith('Off'),audioSource:draft.suggestAudioSource.startsWith('Off')?'Choose audio…':draft.suggestAudioSource,protections:clone(prior.protections)};for(const p of prior.protections)if(p.key in prior)next[p.key]=clone(prior[p.key]);next.protected=next.protections.length>0;if(state.reviewing){state.incoming={proposal:next,version:state.version+1,base:state.baseRevision};}else{state.proposal=next;state.version++;state.reviewBase=state.baseRevision;state.stale=false;}state.discarded=false;state.applied=false;setPanel('chat');save();refresh();say('Illustrative composite card ready in Arke. Current playback and comparison stay as chosen until Review in timeline.');return;}
  if(act==='send'&&pending()){const next=clone(state.proposal);if(!protectedAt('strength',80,105))next.strength=Math.max(5,next.strength-10);state.versions??=[];state.versions.push({version:state.version,proposal:clone(state.proposal)});state.incoming={proposal:next,version:state.version+1,base:state.baseRevision};setPanel('chat');save();refresh();say('New composite card ready. The reviewed version, Current/Suggested selection, manual edits and playhead stay intact until you choose it.');return;}
  if(act==='review'&&pending()&&!state.stale){state.reviewing=true;state.view='suggested';setPanel('chat');say('Review opened explicitly. Suggested is active at the same playhead; current timeline content is unchanged.');return;}
  if(act==='review-new'&&state.incoming){const next=state.incoming;state.proposal=clone(next.proposal);state.version=next.version;state.reviewBase=next.base;state.incoming=null;state.stale=state.reviewBase!==state.baseRevision;state.reviewing=true;state.view='suggested';setPanel('chat');save();refresh();say('Selected version now previews as Suggested at the same playhead. Apply remains a separate action.');return;}
  if(act==='review-current'){say('Retained reviewed version remains active.');setPanel('appearance');return;}
  if(act==='accent'||act==='cues'){say('An editable accent would be placed at '+format(state.time)+'. Cue analysis is illustrated in turn 214.');return;}
  if(act==='point'){say('Drag a curve point, use arrow keys, or use the typed point controls in the drawing.');return;}
 });
 const liveCurve=q('[data-live-curve]');
 liveCurve.addEventListener('pointerdown',event=>{const dot=event.target.closest('[data-point]');if(!dot||!editable())return;dragPoint=+dot.dataset.point;liveCurve.setPointerCapture(event.pointerId);event.preventDefault();});
 liveCurve.addEventListener('pointermove',event=>{if(dragPoint===null)return;const r=liveCurve.getBoundingClientRect();const y=Math.max(12,Math.min(60,(event.clientY-r.top)/r.height*72));state.proposal[state.curve==='Intensity'?'points':'reactionPoints'][dragPoint]=y;state.adjusted=true;refresh();});
 liveCurve.addEventListener('pointerup',()=>{dragPoint=null;save();});
 liveCurve.addEventListener('keydown',event=>{const dot=event.target.closest('[data-point]');if(!dot||!editable()||!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const pts=state.proposal[state.curve==='Intensity'?'points':'reactionPoints'];const i=+dot.dataset.point;pts[i]=Math.max(12,Math.min(60,pts[i]+(event.key==='ArrowUp'?-2:2)));mark();});
 document.querySelectorAll('[data-demo]').forEach(b=>b.addEventListener('click',()=>{
  if(b.dataset.demo==='reset'){state={proposal:fresh(),current:{...fresh(),amount:35,strength:15,embers:false,leak:true},view:'current',reviewing:false,incoming:null,time:96,version:1,adjusted:false,stale:false,applied:false,discarded:false,baseRevision:21,reviewBase:21,panel:'chat',curve:'Intensity'};playing=false;previewReaction=true;hiddenDust=false;advanced=false;setPanel('chat');save();refresh();say('Example reset. The card is ready in Arke; choose Review in timeline to begin.');}
  if(b.dataset.demo==='stale'){state.baseRevision++;state.stale=true;save();refresh();say('Current picture timing changed. Update the review before applying; your adjustments remain.');}
  if(b.dataset.demo==='resume'){save();const retained=JSON.parse(localStorage.getItem(storageKey));state={...state,...retained};setPanel(state.panel);refresh();say('Review resumed at '+format(state.time)+' with your adjustments retained.');}
  if(b.dataset.demo==='dark')document.documentElement.classList.toggle('dark');
 }));
 function fit(){for(const wrap of document.querySelectorAll('.frame-wrap')){const width=+wrap.dataset.width,inner=wrap.querySelector('.frame-scale'),scale=Math.min(1,wrap.clientWidth/width);inner.style.width=width+'px';inner.style.transform=`scale(${scale})`;wrap.style.height=Math.round(inner.querySelector('.fx213').offsetHeight*scale)+'px';}root.classList.toggle('phone',innerWidth<600);root.classList.toggle('fold',innerWidth>=600&&innerWidth<1100);paint();}
 addEventListener('resize',fit);addEventListener('pagehide',save);document.fonts.ready.then(fit);
 setPanel(state.panel);fit();requestAnimationFrame(animate);
 // Read-only state inspection makes the design smoke check inspectable without app APIs.
 window.effectDesignState=()=>clone({...state,playing,previewReaction});
})();

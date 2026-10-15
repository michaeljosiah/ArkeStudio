// Isolated layout fixture: no app commands, generation or audio playback.
const $ = selector => document.querySelector('#studio-view '+selector);
const $$ = selector => [...document.querySelectorAll('#studio-view '+selector)];
const state={selected:'mara',attachment:'linked',longer:false,reviewing:false,suggested:true,time:12,history:[],redo:[],zoom:1,loop:false,playing:false,muted:{},solo:{},gains:{narrator:-3,mara:-3,elias:-3,closing:-3,door:-6,music:-14,ambience:-18}};
const clips=[
 ['narrator','Narrator','Dialogue','Opening narration','opening.wav',0,7,'neutral-500'],
 ['mara','Mara','Dialogue','We should leave','mara-01.wav',7,5,'voice-1'],
 ['elias','Elias','Dialogue','Then tell me','elias-01.wav',11.5,4.5,'voice-2'],
 ['closing','Narrator','Dialogue','She closed the door','closing.wav',16,4,'neutral-500'],
 ['door','Effects','SFX','Cabin door','cabin-door.wav',12,2,'neutral-600'],
 ['music','Music','Music','Low tide','low-tide.wav',0,24,'voice-4'],
 ['ambience','Ambience','Ambience','Rain on the quay','rain-on-quay.wav',0,24,'timeline-ambience'],
].map(([id,lane,role,title,source,start,duration,colour])=>({id,lane,role,title,source,start,duration,colour}));
const changed=()=>state.longer||state.reviewing&&state.suggested;
const total=()=>changed()?26:24;
const clock=n=>`00:${n.toFixed(3).padStart(6,'0')}`;
const resolved=c=>({...c,source:changed()&&c.id==='mara'?'mara-take-02.wav':c.source,start:c.start+(changed()&&(['elias','closing'].includes(c.id)||c.id==='door'&&state.attachment==='linked')?2:0),duration:c.duration+(changed()&&['mara','music','ambience'].includes(c.id)?2:0)});
const snapshot=()=>({attachment:state.attachment,longer:state.longer,gains:{...state.gains}});
function checkpoint(){state.history.push(snapshot());state.redo=[];}
function say(text){$('#status').textContent=text;}
function panel(arke){$('#inspector-content').hidden=arke;$('#arke-content').hidden=!arke;$('.n-inspector').classList.toggle('n-is-arke',arke);$$('.n-inspector-tabs button').forEach(el=>el.classList.toggle('selected',arke?el.dataset.nativeAct==='arke':el.dataset.nativeAct==='inspect'));$('.n-sheet-title b').textContent=arke?'Arke':'Details';}
function selection(id){state.selected=id;state.time=resolved(clips.find(c=>c.id===id)).start;render();}
function transport(){ $$('[data-clock]').forEach(el=>el.textContent=clock(state.time));$$('.as-total').forEach(el=>el.textContent='/ '+clock(total()));$('#playhead').style.left=`calc(var(--n-track-label,88px) + (100% - var(--n-track-label,88px)) * ${state.time/total()})`;$$('[data-audio-act="play"]').forEach(el=>{el.textContent=state.playing?'Ⅱ':'▷';el.setAttribute('aria-label',state.playing?'Pause':'Play');}); }
function render(){
 $('.audio226').classList.toggle('has-review',state.reviewing);
 const selected=resolved(clips.find(c=>c.id===state.selected));
 $('#clip-role').textContent=selected.role.toUpperCase();$('#clip-title').textContent=selected.title;$('#clip-source').textContent='World artifact · '+selected.source;
 $('#source-context').textContent=selected.id==='door'?(state.attachment==='linked'?'Attached to the end of Mara’s line.':'Placed at a fixed chapter time.'):selected.role==='Dialogue'?'Chosen performance · linked to its script passage.':'Loops across the chapter range.';
 $('#audio-assets [data-select="mara"] small').textContent='Dialogue · '+(changed()?7:5)+'s';
 $('#start-value').value=clock(selected.start);$('#end-value').value=clock(selected.start+selected.duration);$('#move-value').value=clock(selected.start);
 $('#gain').value=state.gains[selected.id];$('#gain-value').textContent=state.gains[selected.id]+' dB';$('#gain').disabled=state.reviewing;
 $('#audio-role').innerHTML=`<option>${selected.role}</option>`;$('#duck').checked=selected.id==='music';
 const attachment=$('#attachment');attachment.innerHTML=selected.id==='door'?'<option value="linked">Follow Mara’s line end</option><option value="fixed">Fixed at 00:12.000</option>':`<option>${['music','ambience'].includes(selected.id)?'Follow chapter range':'Follow script sequence'}</option>`;if(selected.id==='door')attachment.value=state.attachment;attachment.disabled=selected.id!=='door'||state.reviewing;
 $('#anchor-note').textContent=selected.id==='door'&&state.attachment==='fixed'?'Stays at this chapter time when narration changes.':'Follows its passage or range when narration changes.';
 $$('[data-select]').forEach(el=>{el.classList.toggle('selected',el.dataset.select===selected.id);el.setAttribute('aria-pressed',String(el.dataset.select===selected.id));});
 $('#change-panel').hidden=!state.reviewing;$$('[data-native-act="compare-current"]').forEach(el=>el.classList.toggle('selected',!state.suggested));$$('[data-native-act="compare-suggested"]').forEach(el=>el.classList.toggle('selected',state.suggested));$('[data-native-act="apply"]').disabled=!state.suggested;
 $('#change-door').textContent=state.attachment==='linked'?'12.000 → 14.000s':'Fixed · 12.000s';$('#revision-label').textContent=state.reviewing?state.suggested?'Suggested · not applied':'Current · comparison':state.longer?'Current · replacement applied':'Current';$('#chapter-duration').textContent=total()+'s';$('#try-replacement').disabled=state.reviewing||state.longer;$('#undo').disabled=!state.history.length||state.reviewing;$('#redo').disabled=!state.redo.length||state.reviewing;
 $('#ticks').innerHTML=[0,total()/4,total()/2,total()*3/4,total()].map(n=>`<span>${Number(n.toFixed(1))}s</span>`).join('');$('#lanes').replaceChildren();
 for(const name of ['Narrator','Mara','Elias','Effects','Music','Ambience']){
  const row=document.createElement('div');row.className='n-lane';const label=document.createElement('label');label.textContent=name;const controls=document.createElement('span');controls.className='as-lane-controls';
  for(const [kind,title]of [['muted','Mute'],['solo','Solo']]){const button=document.createElement('button');button.textContent=title[0];button.setAttribute('aria-label',title+' '+name);button.setAttribute('aria-pressed',String(!!state[kind][name]));button.addEventListener('click',()=>{state[kind][name]=!state[kind][name];render();say(`${title} ${name}: ${state[kind][name]?'on':'off'} · preview only.`);});controls.append(button);}label.append(controls);
  const strip=document.createElement('div');strip.className='as-lane-strip';
  for(const source of clips.filter(c=>c.lane===name)){const clip=resolved(source);const button=document.createElement('button');button.className='as-clip'+(clip.id===state.selected?' selected':'');button.dataset.clip=clip.id;button.style.left=clip.start/total()*100+'%';button.style.width=clip.duration/total()*100+'%';button.style.setProperty('--clip-colour',`var(--${clip.colour})`);button.setAttribute('aria-label',clip.title+', '+clip.start+'s');const text=document.createElement('span');text.textContent=clip.title;const wave=document.createElement('div');wave.className='as-wave';wave.setAttribute('aria-hidden','true');for(let i=0;i<35;i++){const bar=document.createElement('i');bar.style.height=(3+(i*17+clip.id.length)%7)+'px';wave.append(bar);}button.append(text,wave);button.addEventListener('click',()=>{selection(clip.id);$(`[data-clip="${clip.id}"]`).focus({preventScroll:true});});strip.append(button);}
  row.append(label,strip);$('#lanes').append(row);
 }
 $('.as-timeline-content').style.width=state.zoom*100+'%';$('#zoom-value').textContent=state.zoom.toFixed(1)+'×';transport();
}
function review(){state.playing=false;state.reviewing=true;state.suggested=true;render();say('Review replacement · Current remains unchanged.');}
function dialog(title,body){$('.n-dialog-shade')?.remove();const shade=document.createElement('div');shade.className='n-dialog-shade';shade.innerHTML=`<div class="n-dialog" role="dialog" aria-modal="true" aria-label="${title}"><header><b>${title}</b></header><div class="n-dialog-body">${body}<div class="n-actions n-end"><button type="button" data-audio-act="close-dialog">Cancel</button></div></div></div>`;$('.audio226').append(shade);shade.querySelector('button').focus();}
document.querySelector('#studio-view').addEventListener('click',event=>{
 const el=event.target.closest('button');if(!el)return;if(el.dataset.select){selection(el.dataset.select);return;}const action=el.dataset.audioAct??el.dataset.nativeAct;
 if(action==='replacement')review();
 else if(action==='compare-current'||action==='compare-suggested'){state.suggested=action==='compare-suggested';render();}
 else if(action==='apply'){checkpoint();state.longer=true;state.reviewing=false;render();say('Replacement applied · one Undo restores the previous arrangement.');}
 else if(action==='discard'||action==='close-review'){state.reviewing=false;render();say('Returned to Current.');}
 else if(action==='undo'&&state.history.length){state.redo.push(snapshot());Object.assign(state,state.history.pop());render();}
 else if(action==='redo'&&state.redo.length){state.history.push(snapshot());Object.assign(state,state.redo.pop());render();}
 else if(['arke','changes','revise'].includes(action)){panel(true);$('.n-inspector').classList.add('is-open');}
 else if(action==='inspect'){panel(false);$('.n-inspector').classList.add('is-open');}
 else if(action==='close-sheet')$('.n-inspector').classList.remove('is-open');
 else if(action==='library')$('.n-library').classList.add('is-open');
 else if(action==='close-library')$('.n-library').classList.remove('is-open');
 else if(action==='play'){state.playing=!state.playing;transport();say('Silent timing preview · this fixture contains no audio.');}
 else if(action==='listen'){state.time=0;state.playing=true;transport();say('Silent timing preview from the start.');}
 else if(action==='previous'||action==='next'){const speech=clips.filter(c=>c.role==='Dialogue').map(resolved);state.time=action==='next'?(speech.find(c=>c.start>state.time)?.start??0):([...speech].reverse().find(c=>c.start<state.time)?.start??0);transport();}
 else if(action==='loop'){state.loop=!state.loop;el.setAttribute('aria-pressed',String(state.loop));}
 else if(action==='zoom-in'||action==='zoom-out'){state.zoom=Math.max(1,Math.min(3,state.zoom+(action==='zoom-in'?.5:-.5)));render();}
 else if(['select','split','hand'].includes(action)){$$('.as-tools button').forEach(button=>button.setAttribute('aria-pressed',String(button===el)));say(`${action} tool selected · gesture editing is outside this fixture.`);}
 else if(action==='follow')el.setAttribute('aria-pressed',String(el.getAttribute('aria-pressed')!=='true'));
 else if(['media','effects','transitions'].includes(action)){$$('.n-library-tabs button').forEach(button=>button.classList.toggle('selected',button===el));$('#audio-assets').hidden=action!=='media';$('#library-collection-note').hidden=action==='media';$('#library-collection-note').textContent=action==='effects'?'Audio effects use this existing collection.':'Audio crossfades use this existing collection.';}
 else if(action==='unused'){$$('#audio-assets [data-select]').forEach(button=>button.hidden=true);$('#library-collection-note').hidden=false;$('#library-collection-note').textContent='All chapter media is placed.';}
 else if(action==='all'){$$('#audio-assets [data-select]').forEach(button=>button.hidden=false);$('#library-collection-note').hidden=true;}
 else if(action==='kinds')dialog('Media kind','<p>All kinds · Dialogue · Music · Ambience · SFX</p>');
 else if(action==='import')dialog('Import media','<p>Add recordings, music or sound effects.</p><label class="n-select">Destination<select><option>Library only</option><option>Selected audio track</option></select></label>');
 else if(action==='export')dialog('Export audio','<label class="n-select">Include<select><option>This chapter · The harbour</option><option>Whole book</option></select></label><label class="n-select">Format<select><option>WAV</option><option>MP3</option></select></label><p>Uses the committed arrangement.</p>');
 else if(action==='close-dialog')$('.n-dialog-shade')?.remove();
});
$('#attachment').addEventListener('change',event=>{checkpoint();state.attachment=event.target.value;render();});let gainBefore=null;
$('#gain').addEventListener('input',event=>{gainBefore??=snapshot();state.gains[state.selected]=Number(event.target.value);$('#gain-value').textContent=event.target.value+' dB';});$('#gain').addEventListener('change',()=>{if(gainBefore)state.history.push(gainBefore);gainBefore=null;state.redo=[];render();});
$('#library-search').addEventListener('input',event=>{$$('#audio-assets [data-select]').forEach(el=>el.hidden=!el.textContent.toLowerCase().includes(event.target.value.toLowerCase()));});
$('#text-scale').addEventListener('change',event=>{$$('.as-passage').forEach(el=>el.style.fontSize=event.target.value==='100%'?'var(--text-base)':event.target.value==='125%'?'var(--text-lg)':'var(--text-xl)');});
$('#ticks').addEventListener('click',event=>{const rect=event.currentTarget.getBoundingClientRect(),gutter=$('.audio226').classList.contains('phone')?72:88;state.time=Math.max(0,Math.min(total(),(event.clientX-rect.left-gutter)/(rect.width-gutter)*total()));transport();});
function view(mode){const video=mode==='video';document.querySelector('#video-view').hidden=!video;document.querySelector('#studio-view').hidden=video;state.playing=false;const root=$('.audio226');root.classList.remove('desktop','phone','fold');root.classList.add(mode==='phone'?'phone':mode==='fold'?'fold':'desktop');root.style.width=mode==='phone'?'390px':mode==='fold'?'984px':'1360px';document.querySelectorAll('[data-review-view]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.reviewView===mode)));transport();}
document.querySelectorAll('[data-review-view]').forEach(el=>el.addEventListener('click',()=>view(el.dataset.reviewView)));document.querySelector('#review-replacement').addEventListener('click',()=>{view('audio');review();});
let previous=performance.now();function tick(now){if(state.playing){state.time+=(now-previous)/1000;if(state.time>=total()){state.time=state.loop?0:total();state.playing=state.loop;}transport();}previous=now;requestAnimationFrame(tick);}requestAnimationFrame(tick);
window.audioFixture={state,view,selection,review,panel};view(innerWidth<600?'phone':innerWidth<1100?'fold':'audio');render();

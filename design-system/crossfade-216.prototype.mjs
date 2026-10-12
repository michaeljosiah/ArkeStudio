import {base,screen,batchPlan,joins} from './crossfade-216.view.mjs';
const host=document.getElementById('live-stage');
const storageKey='arke-crossfade-216-design-v1';
const fresh=()=>({current:{hasTransition:false,duration:1,protectJoin:false,protectDuration:false,joinDurations:{ab:.75}},
  proposal:null,incoming:null,reviewed:false,view:'current',panel:'inspect',version:1,adjusted:false,stale:false,
  applied:false,phase:50,scope:'All still images',replace:false,acceptShort:false,skipShort:false,phonePanel:true,
  batchDuration:1,rangeStart:12,rangeEnd:36,status:'',undo:null,releasePending:false,excluded:false});
let state=fresh(),playTimer;
try {const saved=JSON.parse(localStorage.getItem(storageKey));if(saved?.current&&saved.schema===1)state={...fresh(),...saved};}catch{}
const copy=value=>structuredClone(value);
function currentEdit(){return state.reviewed&&state.view==='suggested'?state.proposal:state.current;}
function save(){localStorage.setItem(storageKey,JSON.stringify({...state,schema:1}));}
function render(){
  const shown=state.reviewed&&state.view==='suggested'?state.proposal:state.current;
  const o={...base(),...shown,...state,hasTransition:shown.hasTransition,duration:state.panel==='batch'?state.batchDuration:shown.duration,
    protectJoin:shown.protectJoin,protectDuration:shown.protectDuration,live:true,details:true,incoming:!!state.incoming,
    joinDurations:state.current.joinDurations,proposalDuration:state.proposal?.duration,
    proposalHasTransition:state.proposal?.hasTransition,proposalReady:!!state.proposal,
    cardRows:state.proposal?joins.filter(j=>(state.applied?state.undo:state.current)?.joinDurations[j.id]!==state.proposal.joinDurations[j.id]).map(j=>({name:j.name,id:j.id,before:(state.applied?state.undo:state.current)?.joinDurations[j.id]||0,after:state.proposal.joinDurations[j.id]||0})):[]};
  const scroll=host.querySelector('.panel-scroll')?.scrollTop||0;
  host.innerHTML=screen(o);
  if(state.reviewed&&state.view==='current'){
    for(const e of host.querySelectorAll('.inspector input,.inspector select,[data-act="remove"],[data-act="add"],[data-act="protect"],[data-act="release"]'))e.disabled=true;
  }
  host.querySelector('.panel-scroll').scrollTop=scroll;
  save();
}
function status(text){state.status=text;}
function remember(){state.undo=copy(state.current);}
function changeDuration(value){
  if(state.reviewed&&state.view==='current')return;
  const n=Number(value);
  if(!Number.isFinite(n)||n<1/12||n>4){status('Use 2–96 frames at this join (0.08–4.00s). The cut will not move.');render();return;}
  const duration=Math.round(n*24)/24;
  if(state.panel==='batch'){state.batchDuration=duration;state.acceptShort=false;state.skipShort=false;}
  else{if(!state.reviewed)remember();currentEdit().duration=duration;currentEdit().joinDurations.bc=duration;
    if(state.reviewed)state.adjusted=true;status(state.reviewed?'Adjusted by you · retained in revisions':'Duration saved · cut remains at 0:24');}
  render();
}
function candidate(){
  const p=copy(state.current);p.hasTransition=true;p.duration=p.protectDuration?p.duration:1;
  p.joinDurations={...p.joinDurations,bc:p.duration,de:.5,ef:.5};return p;
}
function runPreview(){
  if(playTimer){clearInterval(playTimer);playTimer=null;state.previewing=false;render();return;}
  state.previewing=true;state.phase=0;render();
  let phase=0;playTimer=setInterval(()=>{
    phase=(phase+2)%102;state.phase=Math.min(100,phase);
    const shown=state.reviewed&&state.view==='suggested'?state.proposal:state.current;
    const img=host.querySelector('.incoming-picture');if(img)img.style.opacity=shown.hasTransition?state.phase/100:state.phase>=50?1:0;
    const slider=host.querySelector('[data-key=phase]');if(slider)slider.value=state.phase;
  },35);
}
function action(act){
  switch(act){
    case 'inspect':state.panel='inspect';state.phonePanel=true;break;
    case 'chat':state.panel='chat';state.phonePanel=true;break;
    case 'batch':if(state.reviewed){status('Return to Current editing before starting a separate batch. Pending transitions can be adjusted in the Inspector.');break;}state.panel='batch';state.phonePanel=true;state.acceptShort=false;break;
    case 'close-panel':state.phonePanel=false;break;
    case 'add':if(state.reviewed&&state.view==='current')return;if(!state.reviewed)remember();currentEdit().hasTransition=true;currentEdit().joinDurations.bc=currentEdit().duration;state.panel='inspect';status('Crossfade added at 0:24. Film still ends at 1:12.');break;
    case 'remove':if(state.reviewed&&state.view==='current')return;if(!state.reviewed)remember();Object.assign(currentEdit(),{hasTransition:false,protectJoin:false,protectDuration:false});delete currentEdit().joinDurations.bc;if(state.reviewed)state.adjusted=true;status('Hard cut restored. Clip positions unchanged.');break;
    case 'protect':state.panel='protect';break;
    case 'release':state.releaseKey='protectDuration';state.panel='release';break;
    case 'confirm-release':if(!state.reviewed)remember();currentEdit()[state.releaseKey||'protectDuration']=false;state.releasePending=state.reviewed;state.panel='inspect';status(state.reviewed?'Named release is pending; review again before Apply.':'Named setting released. Other protection retained.');break;
    case 'review-release':state.releasePending=false;state.view='suggested';status('Reviewed the version with a pending Duration release.');break;
    case 'skip-short':state.skipShort=true;state.acceptShort=false;break;
    case 'apply-batch':{
      if(state.reviewed)return;const plan=batchPlan({...state,...state.current,duration:state.batchDuration});const rows=plan.filter(j=>!j.keep&&!j.skip);
      if(!rows.length||plan.some(j=>j.shorter)&&!state.acceptShort)return;
      remember();for(const j of rows)state.current.joinDurations[j.id]=j.value;
      if(state.current.joinDurations.bc){state.current.hasTransition=true;state.current.duration=state.current.joinDurations.bc;}
      state.panel='inspect';status(`${rows.length} crossfades applied · one Undo step · all cuts and total duration unchanged.`);break;
    }
    case 'suggest':{
      if(state.reviewed){const incoming=copy(state.proposal);if(!state.adjusted&&!incoming.protectDuration)incoming.duration=Math.min(4,incoming.duration+.25);
        if(incoming.hasTransition)incoming.joinDurations.bc=incoming.duration;else delete incoming.joinDurations.bc;state.incoming=incoming;status('A new version arrived. Your active preview and clock stayed unchanged.');}
      else{state.proposal=candidate();state.incoming=null;state.applied=false;state.discarded=false;state.excluded=false;state.adjusted=false;state.releasePending=false;state.stale=false;state.panel='chat';state.version=1;status('Arke fixture prepared a card. Current is still active.');}break;
    }
    case 'review':if(!state.proposal)state.proposal=candidate();state.reviewed=true;state.view='suggested';state.panel='chat';status('Suggested active. Changes remain pending.');break;
    case 'review-new':if(!state.incoming)return;state.proposal=copy(state.incoming);state.incoming=null;state.version++;state.reviewed=true;state.view='suggested';state.stale=false;status('Explicitly reviewing the new version.');break;
    case 'current':state.view='current';break;
    case 'suggested':state.view='suggested';break;
    case 'leave':state.reviewed=false;state.view='current';status('Returned to Current. The proposal is retained.');break;
    case 'discard':state.proposal=null;state.incoming=null;state.reviewed=false;state.view='current';state.discarded=true;state.releasePending=false;state.stale=false;state.panel='chat';status('Proposal discarded. Current and its protection are unchanged.');break;
    case 'exclude':if(!state.proposal)return;state.proposal.hasTransition=state.current.hasTransition;state.proposal.duration=state.current.duration;
      if(state.current.joinDurations.bc)state.proposal.joinDurations.bc=state.current.joinDurations.bc;else delete state.proposal.joinDurations.bc;
      state.excluded=true;state.adjusted=true;status('Harbour → Coast kept as Current; this decision survives revisions.');break;
    case 'keep-protected':state.conflict=false;status('Protected duration retained.');break;
    case 'update':state.incoming=copy(state.proposal||candidate());status('Updated card ready. Choose Review version to enter its preview.');break;
    case 'apply':if(!state.reviewed||state.stale||state.releasePending)return;remember();state.current=copy(state.proposal);state.reviewed=false;state.view='current';state.applied=true;state.panel='chat';status('Applied exact reviewed version · one Undo step.');break;
    case 'undo':if(!state.undo)return;state.current=copy(state.undo);state.undo=null;state.reviewed=false;state.view='current';state.applied=false;state.panel='inspect';status('Undone · previous transitions and protection restored.');break;
    case 'preview':runPreview();return;
    default:return;
  }
  render();
}
host.addEventListener('click',e=>{const button=e.target.closest('[data-act]');if(button&&!button.disabled)action(button.dataset.act);});
host.addEventListener('change',e=>{
  const key=e.target.dataset.key;if(!key)return;
  if(key==='duration'){changeDuration(e.target.value);return;}
  if(key==='protectJoin'||key==='protectDuration'){
    if(!e.target.checked){state.releaseKey=key;state.panel='release';}
    else{if(!state.reviewed)remember();currentEdit()[key]=true;status(state.reviewed?'Protection will be saved on Apply.':'Protection saved; direct edits stay available.');}
  }
  else if(key==='scope'){state.scope=e.target.value;state.acceptShort=false;state.skipShort=false;}
  else if(key==='existing')state.replace=e.target.value==='Replace unprotected';
  else if(key==='acceptShort')state.acceptShort=e.target.checked;
  else if(key==='rangeStart'||key==='rangeEnd')state[key]=Number(e.target.value);
  else if(key==='phase')state.phase=Number(e.target.value);
  else return;
  render();
});
host.addEventListener('input',e=>{if(e.target.dataset.key==='phase'){state.phase=Number(e.target.value);const active=currentEdit();host.querySelector('.incoming-picture').style.opacity=active.hasTransition?state.phase/100:state.phase>=50?1:0;save();}});
host.addEventListener('keydown',e=>{if(!e.target.dataset.handle||!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const sign=e.key==='ArrowRight'?1:-1;changeDuration(currentEdit().duration+sign*2/24);});
host.addEventListener('pointerdown',e=>{
  const handle=e.target.dataset.handle;if(!handle||state.reviewed&&state.view==='current')return;
  e.preventDefault();const start=e.clientX,duration=currentEdit().duration;const direction=handle==='right'?1:-1;
  const up=event=>{document.removeEventListener('pointerup',up);changeDuration(Math.max(1/12,Math.min(4,duration+(event.clientX-start)*direction/35)));};
  document.addEventListener('pointerup',up,{once:true});
});
document.querySelector('.demo-tools').addEventListener('click',e=>{
  const demo=e.target.dataset.demo;if(!demo)return;
  if(demo==='dark'){document.documentElement.classList.toggle('dark');return;}
  if(playTimer){clearInterval(playTimer);playTimer=null;}
  if(demo==='stale'){state.stale=true;status('Fixture: a source cut changed. Update and review again before Apply.');}
  else{state=fresh();if(demo==='bulk')state.panel='batch';if(demo==='arke'){state.panel='chat';state.proposal=candidate();}}
  render();
});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='z'&&!['INPUT','TEXTAREA'].includes(e.target.tagName)){e.preventDefault();action('undo');}});
function fitFrames(){for(const wrap of document.querySelectorAll('.frame-wrap')){const natural=Number(wrap.dataset.width);const scale=Math.min(1,wrap.parentElement.clientWidth/natural);const inner=wrap.querySelector('.frame-scale');inner.style.width=natural+'px';inner.style.transform=`scale(${scale})`;wrap.style.width=natural*scale+'px';wrap.style.height=inner.firstElementChild.offsetHeight*scale+'px';}}
new ResizeObserver(fitFrames).observe(document.querySelector('.review-wrap'));
window.addEventListener('resize',fitFrames);window.crossfadeDesignState=()=>copy(state);
render();fitFrames();

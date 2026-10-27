import { FRAMES, render, esc } from './branch-map-state-240.view.mjs';
import { CONNECTOR_MODES, DESTINATIONS, FACTS, emptyDraft, draftReady } from './branch-map-state-240.connectors.mjs';
let state={...FRAMES[0].state};
const drawing=document.getElementById('drawing');
const picker=document.getElementById('frame');
function fit(){const root=drawing.firstElementChild;if(!root)return;const scale=Math.min(1,document.getElementById('fit').clientWidth/root.offsetWidth);drawing.style.transform=`scale(${scale})`;document.getElementById('fit').style.height=Math.ceil(root.offsetHeight*scale+2)+'px';}
function draw(){drawing.innerHTML=render(state);const frame=FRAMES.find(f=>f.state.mode===state.mode)||FRAMES[0];picker.value=frame.id;document.getElementById('caption').innerHTML=`<b>${frame.id} · ${esc(frame.title)}</b><p>${esc(frame.description)}</p>`;fit();if(state.review||state.adding||state.mode==='fact-edit')drawing.querySelector('.modal input,.modal select,.modal button')?.focus();}
function chooseFrame(frame){state=structuredClone(frame.state);history.replaceState(null,'','#'+frame.id);draw();}
picker.addEventListener('change',()=>chooseFrame(FRAMES.find(f=>f.id===picker.value)));
document.getElementById('theme').addEventListener('click',()=>document.documentElement.classList.toggle('dark'));
function cancelConnector(){const editing=state.isEditingAdded,device=state.device||(state.mode==='connector-mobile'?'phone':undefined);state={mode:editing?'connector-added':'connector-start',createdChoice:state.createdChoice,device};draw();drawing.querySelector(editing?'[data-act="select-added"]':'[data-act="begin-connector"]')?.focus();}
function connectorAction(action,button){
 if(action==='connector-start'){state={mode:'connector-start'};}
 else if(action==='begin-connector'){state={...state,mode:'connector-pick',draft:emptyDraft(),isEditingAdded:false};}
 else if(action==='cancel-connector'){cancelConnector();return true;}
 else if(action==='choose-destination'){
  if(!DESTINATIONS.some(d=>d.id===button.dataset.target))return true;
  state={...state,mode:'connector-edit',draft:{...(state.draft||emptyDraft()),to:button.dataset.target}};
 }
 else if(action==='add-draft-condition'){
  const draft=structuredClone(state.draft||emptyDraft());
  draft.conditions.push({fact:draft.conditions.length===0?'dev':'wei',comparison:draft.conditions.length===0?'is':'is not',value:'Alive'});
  state={...state,mode:state.mode==='connector-mobile'?state.mode:'connector-rules',draft};
 }
 else if(action==='remove-draft-condition'){
  const draft=structuredClone(state.draft);draft.conditions.splice(Number(button.dataset.index),1);state={...state,draft};
 }
 else if(action==='add-draft-effect'){
  const draft=structuredClone(state.draft||emptyDraft()),fact=FACTS.find(f=>!draft.effects.some(e=>e.fact===f.id));
  if(!fact)return true;draft.effects.push({fact:fact.id,value:fact.values[0]});
  state={...state,mode:state.mode==='connector-mobile'?state.mode:'connector-rules',draft};
 }
 else if(action==='remove-draft-effect'){
  const draft=structuredClone(state.draft);draft.effects.splice(Number(button.dataset.index),1);state={...state,draft};
 }
 else if(action==='save-connector'){
  if(!draftReady(state.draft))return true;
  state={...state,mode:'connector-added',createdChoice:structuredClone(state.draft),isEditingAdded:false};
 }
 else if(action==='select-added'){state={...state,mode:'connector-added'};}
 else if(action==='edit-added'){state={...state,mode:'connector-rules',draft:structuredClone(state.createdChoice),isEditingAdded:true};}
 else if(action==='connector-source'){state={...state,mode:'connector-start'};}
 else if(action==='connector-noop'){return true;}
 else return false;
 draw();
 if(action==='begin-connector')drawing.querySelector('[data-draft="to"]')?.focus();
 if(action==='choose-destination')drawing.querySelector('[data-draft="text"]')?.focus();
 if(action==='save-connector')drawing.querySelector('[data-act="select-added"]')?.focus();
 return true;
}
function updateDraft(event){
 const control=event.target.closest('[data-draft]');if(!control)return;
 const binding=control.dataset.draft,parts=binding.split('.');
 const draft=structuredClone(state.draft||emptyDraft());
 if(parts.length===1)draft[binding]=control.value;
 else{const [kind,index,key]=parts;draft[kind][Number(index)][key]=control.value;if(key==='fact')draft[kind][Number(index)].value=FACTS.find(f=>f.id===control.value).values[0];}
 state={...state,draft};
 if(binding==='to'){
  state.mode=state.mode==='connector-mobile'?state.mode:(draft.conditions.length||draft.effects.length?'connector-rules':'connector-edit');draw();drawing.querySelector('[data-draft="to"]')?.focus();
 }else if(parts[2]==='fact'||parts[0]==='effects'){draw();drawing.querySelector(`[data-draft="${binding}"]`)?.focus();}
 else{
  const save=drawing.querySelector('[data-act="save-connector"]');if(save)save.disabled=!draftReady(draft);
  if(binding==='text'){const edge=drawing.querySelector('[data-draft-edge-label]');if(edge)edge.textContent=draft.text||'New choice';}
 }
}
drawing.addEventListener('input',event=>{if(event.target.matches('textarea[data-draft]'))updateDraft(event);});
drawing.addEventListener('change',event=>{if(event.target.matches('select[data-draft]'))updateDraft(event);});
drawing.addEventListener('keydown',event=>{if(event.key==='Escape'&&CONNECTOR_MODES.includes(state.mode)&&state.mode!=='connector-start'){event.preventDefault();cancelConnector();}});
drawing.addEventListener('click',event=>{const button=event.target.closest('[data-act]');if(!button)return;const action=button.dataset.act;
 if(connectorAction(action,button))return;
 if(['map','facts','remember','conditions','dialogue','preview','findings'].includes(action)){state={...state,mode:action,review:false,saved:false};}
 else if(action==='edit-fact'){state={...state,mode:'fact-edit',factId:button.dataset.fact||'elsie',newFact:false};}
 else if(action==='new-fact'){state={...state,mode:'fact-edit',newFact:true};}
 else if(action==='dismiss'){state={...state,review:false,adding:false,mode:state.mode==='fact-edit'?'facts':state.mode};}
 else if(action==='keep-fact'){state={...state,mode:'facts',saved:true};}
 else if(action==='apply'){state={...state,review:true};}
 else if(action==='keep'){state={...state,review:false,saved:true};}
 else if(action==='toggle-elsie'){state={...state,elsie:state.elsie==='Lost in bore'?'Alive':'Lost in bore'};}
 else if(action==='toggle-wei'){state={...state,wei:state.wei==='Alive'?'Lost in communications':'Alive',scenario:true};}
 else if(action==='rewind'){state={mode:'preview',wei:'Alive',ana:'Alive',elsie:'Alive',tomas:'Alive',rewinding:true};}
 else if(action==='depart'){state={...state,mode:'ending',volunteer:button.dataset.volunteer||'imani',remote:false};}
 else if(action==='remote'){state={...state,mode:'ending',remote:true};}
 else if(action==='power-clinic'){state={mode:'preview',wei:'Lost in communications',ana:'Alive',elsie:'Alive'};}
 else if(action==='power-comms'){state={mode:'preview',wei:'Alive',ana:'Lost in clinic',elsie:'Lost in clinic'};}
 else if(action==='power-aux'){state={mode:'preview',wei:'Alive',ana:'Alive',elsie:'Alive'};}
 else if(action==='fortress'){state={...state,mode:'ending',fortress:true};}
 else if(action==='keep-condition'){state={...state,adding:false,extraCondition:drawing.querySelector('[data-add-fact]').value};}
 else if(action==='add-condition'){state={...state,adding:true};}
 draw();});
const initial=FRAMES.find(f=>'#'+f.id===location.hash);if(initial)state=structuredClone(initial.state);
addEventListener('hashchange',()=>{const frame=FRAMES.find(f=>'#'+f.id===location.hash);if(frame)chooseFrame(frame);});
addEventListener('resize',fit);document.fonts.ready.then(fit);draw();

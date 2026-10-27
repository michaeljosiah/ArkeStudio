import { FRAMES, render, esc } from './branch-map-state-240.view.mjs';
let state={...FRAMES[0].state};
const drawing=document.getElementById('drawing');
const picker=document.getElementById('frame');
function fit(){const root=drawing.firstElementChild;if(!root)return;const scale=Math.min(1,document.getElementById('fit').clientWidth/root.offsetWidth);drawing.style.transform=`scale(${scale})`;document.getElementById('fit').style.height=Math.ceil(root.offsetHeight*scale+2)+'px';}
function draw(){drawing.innerHTML=render(state);const frame=FRAMES.find(f=>f.state.mode===state.mode)||FRAMES[0];picker.value=frame.id;document.getElementById('caption').innerHTML=`<b>${frame.id} · ${esc(frame.title)}</b><p>${esc(frame.description)}</p>`;fit();if(state.review||state.adding||state.mode==='fact-edit')drawing.querySelector('.modal input,.modal select,.modal button')?.focus();}
picker.addEventListener('change',()=>{const f=FRAMES.find(f=>f.id===picker.value);state={...f.state};history.replaceState(null,'','#'+f.id);draw();});
document.getElementById('theme').addEventListener('click',()=>document.documentElement.classList.toggle('dark'));
drawing.addEventListener('click',event=>{const button=event.target.closest('[data-act]');if(!button)return;const action=button.dataset.act;
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
const initial=FRAMES.find(f=>'#'+f.id===location.hash);if(initial)state={...initial.state};
addEventListener('resize',fit);document.fonts.ready.then(fit);draw();

import { screen } from './global-chat-239.frames.mjs';

const host=document.getElementById('g239-prototype');
const status=document.getElementById('g239-prototype-status');
let state='ready',draft='';
let pending=null;
const device=()=>host.clientWidth<600?'phone':host.clientWidth<1100?'tablet':'desktop';
function saveDraft(){const field=host.querySelector('[data-draft]');if(field)draft=field.textContent;}
function render(next=state){
  saveDraft();state=next;
  host.innerHTML=screen({state,device:device(),interactive:true,label:'Interactive design fixture · Studio assistant',draft});
  const modal=host.querySelector('[aria-modal=true]');
  const background=host.querySelector('.g239-page');
  if(background)background.inert=Boolean(modal);
  if(['repair','denied','recovered'].includes(state)){
    const log=host.querySelector('.g239-messages');if(log)log.scrollTop=log.scrollHeight;
  }
}
function announce(text){status.textContent=text;}
function diagnose(){
  clearTimeout(pending);render('checking');announce('Illustrative check in progress; no service is contacted.');
  pending=setTimeout(()=>{render('diagnosis');announce('Illustrative storage finding. Review cleanup opens a plan without deleting.');},650);
}
host.addEventListener('click',event=>{
  const target=event.target.closest('[data-action],[data-act]');if(!target)return;
  saveDraft();
  switch(target.dataset.action ?? target.dataset.act){
    case 'open':render('ready');host.querySelector('[data-draft]')?.focus();announce('Studio assistant opened. The draft is preserved.');break;
    case 'close':clearTimeout(pending);render('closed');host.querySelector('[data-action=open]')?.focus();announce('Dialog closed; draft kept. This never cancels ongoing work.');break;
    case 'activity':clearTimeout(pending);render('activity');announce('Activity temporarily replaces the chat; return with the Chat control.');break;
    case 'diagnose':diagnose();break;
    case 'help':render('help');break;
    case 'review':render('repair');announce('Review only. Clear previews requires a separate approval.');break;
    case 'approve':render('recovered');announce('Illustrative approval and verification. No files have been changed.');break;
    case 'deny':render('denied');announce('Files kept. Nothing was approved.');break;
    case 'handoff':announce('In Arke, this opens the named World Chat with your request as an editable draft. This fixture sends nothing.');break;
    case 'send':{
      const text=draft.trim();if(!text){host.querySelector('[data-draft]')?.focus();break;}
      if(/story|chapter|world|rewrite/i.test(text)){render('handoff');announce('A world request has an explicit handoff. Nothing is sent into another conversation.');}
      else diagnose();
      break;
    }
    default:announce('This control keeps its existing Arke behavior. This isolated design fixture does not access models, files, settings or your microphone.');
  }
});
host.addEventListener('input',()=>{saveDraft();const send=host.querySelector('[data-action=send]');if(send)send.disabled=!draft.trim();});
host.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&state!=='closed'){event.preventDefault();clearTimeout(pending);render('closed');host.querySelector('[data-action=open]')?.focus();announce('Closed; the draft is kept.');return;}
  if(event.key==='Enter'&&!event.shiftKey&&event.target.matches('[data-draft]')){event.preventDefault();host.querySelector('[data-action=send]')?.click();return;}
  if(event.key==='Tab'){
    const modal=host.querySelector('[aria-modal=true]');if(!modal)return;
    const targets=[...modal.querySelectorAll('button,[contenteditable]')].filter(e=>!e.disabled);
    const first=targets[0],last=targets.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
});
document.getElementById('g239-theme').addEventListener('click',()=>document.documentElement.classList.toggle('dark'));
document.querySelectorAll('[data-preview-state]').forEach(button=>button.addEventListener('click',()=>{clearTimeout(pending);render(button.dataset.previewState);announce('Illustrative '+button.textContent+' state. No services or files are changed.');}));
let lastDevice=device();new ResizeObserver(()=>{const next=device();if(next!==lastDevice){lastDevice=next;render();}}).observe(host);
render();

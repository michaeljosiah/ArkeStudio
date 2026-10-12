import {initial,screen} from './global-chat-224.view.mjs';
const root=document.querySelector('#chat-prototype');
let state=initial();
const render=focus=>{root.innerHTML=screen({...state,live:true,device:root.clientWidth<600?'phone':root.clientWidth<1100?'fold':undefined});if(focus){let target=root.querySelector(focus);if(target?.disabled)target=root.querySelector('.gc224-panel [data-act=adopt],.gc224-panel [data-act=world]');target?.focus();}};
const stash=()=>{const input=root.querySelector('[data-draft]');if(input&&!input.disabled)state.drafts[state.chat]=input.value;};
const open=()=>{state.chat=state.page;state.worldChanged=false;state.open=true;state.history=false;};
function act(action){
 stash();
 if(['world','production','shot'].includes(action)){const noWorld=state.page==='none';state.page=action;if(state.worldChanged){state.worldChanged=false;state.chat='world';state.open=false;}else if(noWorld&&state.open){state.chat=action;}}
 else if(action==='toggle'){if(state.open){state.open=false;state.history=false;}else open();}
 else if(action==='close'){state.open=false;state.history=false;}
 else if(action==='history')state.history=!state.history;
 else if(action.startsWith('resume-')){state.chat=action.slice(7);state.open=true;state.history=false;state.worldChanged=false;}
 else if(action==='adopt'){state.chat=state.page;state.history=false;state.worldChanged=false;state.open=true;}
 else if(action==='send'){const text=(state.drafts[state.chat]||'').trim();if(text&&!state.worldChanged&&state.page!=='none'){(state.messages[state.chat]??=[]).push(text);state.drafts[state.chat]='';}}
 else if(action==='dismiss-overlay')state.overlay=null;
 else if(action==='review')state.overlay='Review Shot 4 · design example';
 else if(['activity','settings','proposals','account'].includes(action)){state.history=false;state.overlay=action[0].toUpperCase()+action.slice(1);}
 render(['close','toggle'].includes(action)&&!state.open?'[data-chat-trigger]':action==='history'&&state.history?'[role=menuitem]':state.open&&!state.overlay?'[data-draft]':undefined);
}
root.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(b&&!b.disabled)act(b.dataset.act);});
root.addEventListener('input',e=>{if(e.target.matches('[data-draft]'))state.drafts[state.chat]=e.target.value;});
root.addEventListener('keydown',e=>{
 if(e.key==='Escape'){e.preventDefault();if(state.overlay){state.overlay=null;render('[data-draft]');}else if(state.history){state.history=false;render('[data-act=history]');}else if(state.open)act('close');}
 if(e.key==='Tab'&&root.querySelector('.gc224-phone .gc224-panel')&&!state.overlay){const els=[...root.querySelectorAll('.gc224-panel button:not(:disabled),.gc224-panel textarea:not(:disabled)')].filter(x=>x.getClientRects().length);const first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
});
document.querySelectorAll('[data-demo]').forEach(b=>b.addEventListener('click',()=>{
 const demo=b.dataset.demo;
 if(demo==='reset')state=initial();
 if(demo==='builder')state={...initial(),page:'production',chat:'production',open:true,example:true};
 if(demo==='navigation')state={...initial(),page:'shot',chat:'world',open:true,drafts:{world:'Tell me more about Maren’s connection to the tide.'},example:true};
 if(demo==='running')state={...initial(),running:{world:true},drafts:{world:'Keep the older version for now.'}};
 if(demo==='world-change')state={...initial(),page:'other',chat:'world',open:true,worldChanged:true,drafts:{world:'Continue with Maren.'}};
 if(demo==='no-world')state={...initial(),page:'none',chat:'none',open:true};
 if(demo==='theme'){document.documentElement.classList.toggle('dark');return;}
 render(state.open?'[data-draft]':undefined);
}));
let lastWidth=root.clientWidth;
new ResizeObserver(([entry])=>{if(Math.abs(entry.contentRect.width-lastWidth)<1)return;lastWidth=entry.contentRect.width;const focused=root.contains(document.activeElement);stash();render(focused&&state.open?'[data-draft]':undefined);}).observe(root);
window.globalChatDesignState=()=>structuredClone(state);
render();

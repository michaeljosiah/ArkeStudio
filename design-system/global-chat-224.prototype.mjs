import {initial,screen} from './global-chat-224.view.mjs';
const root=document.querySelector('#chat-prototype');
let state=initial(), nextFile=0;
const inVoice=()=>['listening','transcribing'].includes(state.voice?.phase);
const render=focus=>{root.innerHTML=screen({...state,live:true,device:root.clientWidth<600?'phone':root.clientWidth<1100?'fold':undefined});if(focus){let target=root.querySelector(focus);if(target?.disabled||target?.matches('[data-draft][aria-disabled=true]'))target=root.querySelector('.gc224-panel [data-act=adopt],.gc224-panel [data-act=world]');target?.focus();}};
const stash=()=>{const input=root.querySelector('[data-draft]');if(input&&input.getAttribute('contenteditable')!=='false')state.drafts[state.chat]=input.innerText;};
const open=()=>{state.chat=inVoice()?state.voice.chat:state.page;state.worldChanged=false;state.open=true;state.history=false;};
const fileKind=file=>file.type.startsWith('image/')?'image':file.type.startsWith('audio/')?'audio':file.type.startsWith('video/')?'video':file.type.startsWith('text/')||file.type.startsWith('application/')?'document':'other';
const stopCapture=()=>{if(state.voice?.phase==='listening')state.voice.phase='transcribing';};
const addFile=(a,chat=state.pickingChat||state.chat)=>{(state.attachments[chat]??=[]).push({...a,id:'file-'+(++nextFile),promoted:false});state.uploadNotice[chat]='Attached in this conversation';};
function act(action){
 stash();
 if(['world','production','shot'].includes(action)){const noWorld=state.page==='none';state.page=action;if(state.worldChanged){stopCapture();state.worldChanged=false;state.chat='world';state.open=false;}else if(noWorld&&state.open){state.chat=action;}}
 else if(action==='toggle'){if(state.open){stopCapture();state.open=false;state.history=false;}else open();}
 else if(action==='close'){stopCapture();state.open=false;state.history=false;}
 else if(action==='history'){if(inVoice())return;state.history=!state.history;}
 else if(action.startsWith('resume-')){if(inVoice())return;state.chat=action.slice(7);state.open=true;state.history=false;state.worldChanged=false;}
 else if(action==='adopt'){if(inVoice())return;state.chat=state.page;state.history=false;state.worldChanged=false;state.open=true;}
 else if(action==='send'){const text=(state.drafts[state.chat]||'').trim();if(text&&!state.worldChanged&&state.page!=='none'&&!state.running[state.chat]){(state.messages[state.chat]??=[]).push(text);(state.sentAttachments[state.chat]??=[]).push((state.attachments[state.chat]||[]).map(a=>a.name));state.drafts[state.chat]='';}}
 else if(action==='attach'){if(state.running[state.chat]||state.worldChanged||state.page==='none')return;state.pickingChat=state.chat;state.overlay='Attachments';}
 else if(action.startsWith('sample-')){
  if(action==='sample-refusal')(state.refusals[state.pickingChat]??=[]).push({id:'refusal-'+(++nextFile),name:'large-reference.mov',reason:'File exceeds the allowed size'});
  else addFile(action==='sample-image'?{name:'harbour.png',kind:'image'}:action==='sample-document'?{name:'shot-notes.pdf',kind:'document',textOnly:true}:{name:'ambience.wav',kind:'audio',unreadable:true});
  state.overlay=null;
 }
 else if(action.startsWith('remove-'))state.attachments[state.chat]=(state.attachments[state.chat]||[]).filter(a=>a.id!==action.slice(7));
 else if(action.startsWith('file-')){const a=state.attachments[state.chat]?.find(a=>a.id===action.slice(5));if(a)a.promoted=true;}
 else if(action.startsWith('refusal-'))state.refusals[state.chat]=(state.refusals[state.chat]||[]).filter(a=>a.id!==action.slice(8));
 else if(action==='dictate'){
  if(state.micUnavailable||state.worldChanged||state.page==='none'||state.running[state.chat])return;
  if(state.voice?.phase==='listening')stopCapture();else if(!inVoice()){state.voice={chat:state.chat,phase:'listening'};state.replyPlaying=false;}
 }
 else if(action==='finish-dictation'){if(state.voice?.phase!=='transcribing')return;const chat=state.voice.chat,prior=state.drafts[chat]||'';state.drafts[chat]=prior?prior+' Bring out the first light on the water.':'Bring out the first light on the water.';state.voice={chat,phase:'idle',completed:chat};}
 else if(action==='read-replies')state.readReplies=!state.readReplies;
 else if(action==='model')state.overlay='Model picker · existing production choice';
 else if(action==='dismiss-overlay')state.overlay=null;
 else if(action==='review')state.overlay='Review Shot 4 · design example';
 else if(['activity','settings','proposals','account'].includes(action)){stopCapture();state.history=false;state.overlay=action[0].toUpperCase()+action.slice(1);}
 render(state.overlay==='Attachments'?'.gc224-picker-examples button':['close','toggle'].includes(action)&&!state.open?'[data-chat-trigger]':action==='history'&&state.history?'[role=menuitem]':action==='dictate'&&state.voice?.phase==='listening'?'.gc224-mic':state.open&&!state.overlay?'[data-draft]':undefined);
}
root.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(b&&!b.disabled&&b.getAttribute('aria-disabled')!=='true')act(b.dataset.act);});
root.addEventListener('input',e=>{if(e.target.matches('[data-draft]')){state.drafts[state.chat]=e.target.innerText;const send=root.querySelector('[data-act=send]');if(send)send.disabled=state.worldChanged||state.page==='none'||!!state.running[state.chat]||!e.target.innerText.trim();}});
root.addEventListener('change',e=>{if(e.target.matches('[data-file-picker]')){for(const file of e.target.files||[])addFile({name:file.name,kind:fileKind(file)});state.overlay=null;render('[data-draft]');}});
root.addEventListener('paste',e=>{if(!e.target.closest('[data-composer]')||state.worldChanged||state.running[state.chat]||state.page==='none')return;const files=[...(e.clipboardData?.files||[])],text=e.clipboardData?.getData('text/plain')||'';if(files.length||text.length>8000||(text.match(/\n/g)||[]).length>120){e.preventDefault();stash();files.forEach(f=>addFile({name:f.name,kind:fileKind(f)},state.chat));if(!files.length)addFile({name:'pasted-text.txt',kind:'document',textOnly:true},state.chat);render('[data-draft]');}});
root.addEventListener('dragover',e=>{if(e.target.closest('[data-composer]')&&[...(e.dataTransfer?.types||[])].includes('Files'))e.preventDefault();});
root.addEventListener('drop',e=>{if(!e.target.closest('[data-composer]')||state.worldChanged||state.running[state.chat]||state.page==='none')return;e.preventDefault();stash();[...(e.dataTransfer?.files||[])].forEach(f=>addFile({name:f.name,kind:fileKind(f)},state.chat));render('[data-draft]');});
root.addEventListener('keydown',e=>{
 if(e.key==='Escape'){e.preventDefault();if(state.overlay){state.overlay=null;render('[data-draft]');}else if(state.history){state.history=false;render('[data-act=history]');}else if(state.open)act('close');}
 if(e.key==='Tab'&&!state.overlay&&root.querySelector('.gc224-phone .gc224-panel')){const els=[...root.querySelectorAll('.gc224-panel button:not(:disabled),.gc224-panel [data-draft][contenteditable="plaintext-only"]')].filter(x=>x.getClientRects().length);const first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
});
document.querySelectorAll('[data-demo]').forEach(b=>b.addEventListener('click',()=>{
 const demo=b.dataset.demo;
 if(demo==='reset')state=initial();
 if(demo==='builder')state={...initial(),page:'production',chat:'production',open:true,example:true};
 if(demo==='navigation')state={...initial(),page:'shot',chat:'world',open:true,drafts:{world:'Tell me more about Maren’s connection to the tide.'},example:true};
 if(demo==='attachments')state={...initial(),page:'production',chat:'production',open:true,attachments:{production:[{id:'sample',name:'shot-notes.pdf',kind:'document',textOnly:true,promoted:false}]},drafts:{production:'Use these notes to shape the opening.'}};
 if(demo==='dictation')state={...initial(),page:'production',chat:'production',open:true,readReplies:true,replyPlaying:true,drafts:{production:'Keep Maren by the water.'}};
 if(demo==='mic-unavailable')state={...initial(),page:'production',chat:'production',open:true,micUnavailable:true,showVoiceTip:true};
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

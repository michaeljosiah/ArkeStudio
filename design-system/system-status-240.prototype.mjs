import {screen} from './system-status-240.frames.mjs';
const host=document.getElementById('s240-prototype');
const status=document.getElementById('s240-prototype-status');
let state='overview',open=true,format='desktop';
const formats={desktop:[1360,820],tablet:[834,900],phone:[390,844],short:[390,550]};
function device(){return format==='short'?'phone':format;}
function draw(focus=null){
  const [width,height]=formats[format];
  host.style.maxWidth=width+'px';host.style.height=height+'px';
  host.innerHTML=screen({state,open,device:device(),interactive:true,label:'Interactive System design · example data'});
  const page=host.querySelector('.s240-page');
  if(open&&device()!=='desktop'){
    // The titlebar remains visible, but background controls are inert while modal.
    page.inert=true;
    page.setAttribute('aria-hidden','true');
  }
  if(focus)host.querySelector(focus)?.focus();
}
document.getElementById('s240-theme').addEventListener('click',()=>document.documentElement.classList.toggle('dark'));
for(const button of document.querySelectorAll('[data-preview-state]'))button.addEventListener('click',()=>{state=button.dataset.previewState;open=true;draw('[data-action=close]');status.textContent='Example state: '+button.textContent+'. No live readings or host actions.';});
for(const button of document.querySelectorAll('[data-preview-format]'))button.addEventListener('click',()=>{format=button.dataset.previewFormat;draw();status.textContent='Preview: '+button.textContent+'. Readings describe the Arke host.';});
host.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');
  if(!button)return;
  const action=button.dataset.action;
  if(action==='system'){open=!open;draw(open?'[data-action=close]':'[data-action=system]');}
  else if(action==='close'){open=false;draw('[data-action=system]');status.textContent='System closed. Work is unchanged.';}
  else if(action==='refresh'){status.textContent='Example refresh only. Production Refresh must request bounded host collection and retain unknown or stale state until fresh measurements arrive.';}
  else if(action==='diagnostics'){status.textContent='Design handoff: open existing Settings → Diagnostics with this finding selected. Review any remedy there. This fixture performs no action.';}
  else status.textContent='Existing '+button.getAttribute('aria-label')+' entry. Only System is interactive in this design fixture.';
});
host.addEventListener('keydown',event=>{
  if(!open)return;
  if(event.key==='Escape'){event.preventDefault();open=false;draw('[data-action=system]');}
  else if(event.key==='Tab'&&device()!=='desktop'){
    const buttons=[...host.querySelectorAll('.s240-dialog button')];
    const first=buttons[0],last=buttons.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
});
new ResizeObserver(()=>{
  // Review scaling is deliberately separate from native phone layout acceptance.
  const fit=host.parentElement.clientWidth;
  const width=formats[format][0];
  if(fit<width){host.style.width=width+'px';host.style.transform=`scale(${fit/width})`;host.parentElement.style.height=formats[format][1]*(fit/width)+'px';}
  else{host.style.width='100%';host.style.transform='';host.parentElement.style.height='';}
}).observe(host.parentElement);
draw();

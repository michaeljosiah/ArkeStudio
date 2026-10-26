import {references,nativeIcons} from './system-status-240.references.mjs';
export const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const icon=name=>nativeIcons[name];
const button=(label,action,primary=false)=>`<button type="button" class="s240-button${primary?' s240-primary':''}" data-action="${action}">${esc(label)}</button>`;
function backdrop(device,state,open){
  const controls=[['chat','Chat'],['system',state==='warning'?'System · storage needs attention':state==='unavailable'?'System · readings unavailable':'System'],['activity','Activity'],['settings','Settings'],['account','Account']].map(([name,label])=>`<button type="button" aria-label="${label}" title="${label}" data-action="${name}" ${name==='system'?`aria-haspopup="dialog" aria-expanded="${open}"`:''}>${icon(name)}${name==='system'&&state==='warning'?'<span class="s240-attention" aria-hidden="true"></span>':''}</button>`).join('');
  return references[device].replace('<!--system-status-controls-->',controls);
}
const sectionTitle=(label,detail)=>`<div class="s240-section-title"><h3>${label}</h3><span>${detail}</span></div>`;
function metric(label,value,detail,percent=null,unavailable=false){return `<div class="s240-metric${unavailable?' s240-metric--unknown':''}"><div class="s240-metric-label">${label}</div><div class="s240-value">${value}</div><div class="s240-detail">${detail}</div>${percent===null?'':`<div class="s240-meter" aria-hidden="true"><i style="width:${percent}%"></i></div>`}</div>`;}
function resources(state){
  const missing=state==='unavailable';
  return sectionTitle('Performance',missing?'Last CPU / RAM sample · 3 min ago':'Sampled 2 s ago')+`<div class="s240-metrics">${metric('CPU',missing?'Last: 24%':'24%','Overall utilisation',missing?null:24,missing)}${metric('Memory',missing?'Last: 18.2 GiB':'18.2 / 32 GiB',missing?'Stale · cannot confirm current use':'57% in use',missing?null:57,missing)}${metric('GPU',missing?'Unavailable':'42%',missing?'This driver exposes no reading':'Overall utilisation',missing?null:42,missing)}${metric('GPU memory',missing?'Unavailable':'7.8 / 12 GiB',missing?'No supported reading':'65% in use',missing?null:65,missing)}</div>`;
}
function drive(name,detail,value,foot,percent=null,warning=false){return `<div class="s240-drive"><div class="s240-row"><b>${name}</b><span${warning?' class="s240-warning-text"':''}>${value}</span></div><div class="s240-row s240-detail"><span>${detail}</span><span>${foot}</span></div>${percent===null?'':`<div class="s240-meter${warning?' s240-meter--warning':''}" aria-hidden="true"><i style="width:${percent}%"></i></div>`}</div>`;}
function storage(state){
  const missing=state==='unavailable',warning=state==='warning';
  return sectionTitle('Storage',missing?'Capacity check failed':'Checked 2 s ago')+`<div class="s240-storage">${drive('System · C:', 'App & local models',missing?'Unavailable':'42 GiB free',missing?'Not zero':'of 476 GiB',missing?null:91)}${drive('Media · D:', 'Current world & exports',missing?'Unavailable':warning?'6 GiB free':'312 GiB free',missing?'Check again':'of 1.8 TiB',missing?null:warning?99:83,warning)}</div>`;
}
function service(label,value,detail,tone=''){return `<div class="s240-service"><div><span class="s240-dot ${tone}" aria-hidden="true"></span><b>${label}</b></div><span>${value}<small>${detail}</small></span></div>`;}
function services(state){
  const missing=state==='unavailable';
  return sectionTitle('Local AI',missing?'Connection lost':'Checked 5 s ago')+`<div class="s240-services">${service('Ollama',missing?'Unknown':'Ready',missing?'Last check 3 min ago':'No active request',missing?'':'s240-dot--ready')}${service('ComfyUI',missing?'Unknown':'Working',missing?'Last check 3 min ago':'1 image request',missing?'':'s240-dot--busy')}${service('Ming',missing?'Unknown':'Not running',missing?'Last check 3 min ago':'Starts when needed')}</div>`+sectionTitle('Cloud','Configured providers')+`<div class="s240-services">${service('Provider connections','Not checked','Check in Diagnostics')}</div><p class="s240-note">A configured provider does not confirm its current availability.</p>`;
}
function notice(state){
  if(state==='warning')return `<div class="s240-notice"><div>${icon('warning')}<b>Media drive needs more space</b></div><p>Export waiting · 6 GiB free, 9 GiB needed including working reserve. Another 3 GiB is needed.</p>${button('Review in Diagnostics','diagnostics')}</div>`;
  if(state==='unavailable')return `<div class="s240-notice s240-notice--quiet"><div>${icon('system')}<b>Current readings unavailable</b></div><p>Last readings are stale. Arke cannot confirm current use, free space or service health.</p></div>`;
  return '';
}
export function screen({state='overview',device='desktop',width=1360,height=820,label='',interactive=false,open=true}={}){
  return `<div class="s240-scene" data-device="${device}" data-state="${state}" data-open="${open}" data-screen-label="${esc(label)}" style="${interactive?'width:100%;height:100%':`width:${width}px;height:${height}px`}"><div class="s240-page">${backdrop(device,state,open)}</div>${!open?'':`<div class="s240-scrim"></div><section class="s240-dialog" role="dialog" aria-label="System" ${device==='desktop'?'':'aria-modal="true"'}><header class="s240-head"><div><h2>System</h2><p>This desktop <span>· Example data</span></p></div><button type="button" class="s240-icon" aria-label="Close System" data-action="close">${icon('close')}</button></header><div class="s240-scroll">${notice(state)}${resources(state)}${storage(state)}${services(state)}</div><footer class="s240-foot"><p>Readings describe the Arke host.</p><div>${button('Refresh','refresh')}${button('Diagnostics','diagnostics',true)}</div></footer></section>`}</div>`;
}
export const FRAMES=[
  ['a','System replaces the proposal shortcut',1360,820,'overview','desktop',false,'Current native Cpu glyph takes the former Inbox slot: Chat, System, Activity, Settings, Account. Page content and underlying proposal workflows remain unchanged.'],
  ['b','A glance at this desktop',1360,820,'overview','desktop',true,'CPU, RAM, GPU and GPU memory are distinct values, with storage by destination. Every value in this design is illustrative; production shows qualified host observations or explicit unavailable states.'],
  ['c','Storage needs attention',1360,820,'warning','desktop',true,'A quiet warning dot opens the same dialog. The measured deficit names affected work and opens Diagnostics for review; there are no repair or cleanup controls here.'],
  ['d','Stale and missing readings',1360,820,'unavailable','desktop',true,'Old CPU/RAM values are labelled Last and have no live bars. Unsupported GPU data and failed capacity checks say Unavailable. Missing facts never read as zero or healthy.'],
  ['e','Tablet · same rounded window',834,900,'overview','tablet',true,'A modal 440px card floats over the current tablet drawing with a 16px outside gap. Readings still describe the host desktop.'],
  ['f','Phone · read the host, not the phone',390,844,'warning','phone',true,'The same dialog has 12px outside gaps, four rounded corners and 44px controls. This desktop remains visible; the content scrolls above a stable footer.'],
  ['g','Small visible height',390,550,'unavailable','phone',true,'Header, close, Refresh and Diagnostics stay reachable in a reduced visible area. Old or unavailable measurements remain explicit in the scrolling content.'],
].map(([letter,title,width,height,state,device,open,note])=>({id:`240${letter}`,title,width,height,state,device,open,note,markup:screen({state,device,width,height,open,label:`240${letter} ${title}`})}));

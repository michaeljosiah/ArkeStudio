// Shared HTML drawings for the design master and isolated review. No Studio runtime imports.
export const esc = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
export const btn = (text, act='', cls='', extra='') => `<button type="button" class="${cls}" ${act ? `data-act="${act}"` : ''} ${extra}>${text}</button>`;
const tag = (text, cls='') => `<span class="tag ${cls}">${text}</span>`;
const note = (title, text='', warn=false) => `<div class="notice ${warn?'warning':''}"><b>${title}</b>${text?`<span>${text}</span>`:''}</div>`;
const field = (title, input) => `<label class="field"><span>${title}</span>${input}</label>`;
const select = (title, values, chosen, key) => field(title, `<select data-key="${key}" aria-label="${title}">${values.map(v=>`<option ${v===chosen?'selected':''}>${esc(v)}</option>`).join('')}</select>`);
const check = (label, checked, key) => `<label class="check"><input type="checkbox" data-key="${key}" ${checked?'checked':''}>${label}</label>`;
export const joins = [
  {id:'ab',name:'Dawn → Harbour',at:12,kind:'image',duration:.75,protected:true},
  {id:'bc',name:'Harbour → Coast',at:24,kind:'image',duration:0},
  {id:'cv',name:'Coast → Boat',at:36,kind:'video',duration:0},
  {id:'vd',name:'Boat → Window',at:44,kind:'video',duration:0},
  {id:'de',name:'Window → Detail',at:52,kind:'short',duration:0},
  {id:'ef',name:'Detail → Evening',at:52.625,kind:'short',duration:0},
  {id:'fg',name:'Evening → Lights',at:64,kind:'gap',duration:0},
];
export const base = () => ({mode:'manual',panel:'inspect',duration:1,hasTransition:false,protectJoin:false,protectDuration:false,
  reviewed:false,view:'current',version:1,incoming:false,adjusted:false,stale:false,applied:false,
  scope:'All still images',replace:false,acceptShort:false,batch:false,phase:50,status:'',phonePanel:true});
export function batchPlan(o) {
  const chosen=joins.filter(j=>o.scope==='Selected images'?['de','ef'].includes(j.id):o.scope==='Time range'?j.at>=(o.rangeStart??12)&&j.at<(o.rangeEnd??36):true);
  return chosen.map(j=>{
    const existing=o.joinDurations?.[j.id]??j.duration;
    const protectedDuration=j.protected||(j.id==='bc'&&o.protectDuration);
    const shorter=j.kind==='short'&&o.duration>.5;
    const skip=['video','gap'].includes(j.kind)||(shorter&&o.skipShort);
    const keep=existing>0&&(protectedDuration||!o.replace);
    return {...j,existing,shorter:shorter&&!keep&&!skip,skip,keep,value:Math.min(o.duration,j.kind==='short'?.5:4),protectedDuration,
      outcome:skip?`Skipped · ${j.kind==='video'?'video join':j.kind==='gap'?'gap':'short clip'}`:keep?`Kept · ${protectedDuration?'protected ':''}${existing.toFixed(2)}s`:`${existing?'Replace':'Add'} · ${shorter&&!o.acceptShort?'needs shorter duration':`${Math.min(o.duration,j.kind==='short'?.5:4).toFixed(2)}s`}`};
  });
}
export function durationControl(o={}) {
  return `${field('Duration',`<span class="duration-input"><input type="number" aria-label="Duration in seconds" data-key="duration" value="${o.duration??1}" min="0.0833" max="4" step="0.0833"><span>seconds</span></span>`)}
  <p class="meta">${Math.round((o.duration??1)*24)} frames · centred on the cut</p>`;
}
function inspector(o) {
  if(o.panel==='protect') return `<div class="panel-heading">${btn('‹ Crossfade','inspect','plain')}<h3>Protect from Arke</h3><p>Harbour → Coast · at 0:24</p></div>
    <div class="section">${check('Keep a crossfade at this join',o.protectJoin,'protectJoin')}<p class="meta">Arke cannot remove or replace this transition.</p>
    ${check('Keep this duration',o.protectDuration,'protectDuration')}<p class="meta">${o.duration.toFixed(2)}s · Arke can adjust other unprotected settings.</p></div>
    ${note('Your edits stay available','Changing a protected value yourself updates what is protected. A broad request to Arke does not release it.')}
    <div class="section">${btn('Done','inspect','primary')}</div>`;
  if(o.panel==='release') return `<div class="panel-heading"><h3>Release ${o.releaseKey==='protectJoin'?'join protection':'duration'}?</h3><p>Harbour → Coast · at 0:24</p></div>
    ${note(`Only ${o.releaseKey==='protectJoin'?'Join protection':'Duration'} will be released`,o.releaseKey==='protectJoin'?'Duration protection is unchanged.':`${o.duration.toFixed(2)}s is currently protected. Join protection is unchanged.`,true)}
    <p class="section">${o.reviewed?'Release is pending until Apply. Review the resulting version again.':'This is an undoable edit to Current.'}</p>
    <div class="section actions">${btn('Cancel','protect')}${btn(o.reviewed?'Release on Apply':'Release named setting','confirm-release','primary')}</div>`;
  if(o.panel==='invalid') return `<div class="panel-heading"><h3>Join needs attention</h3><p>Harbour → Coast</p></div>${note('These images no longer touch','A gap now separates them. The crossfade is inactive; it is not attached to another pair.',true)}
    <div class="section">${btn('Inspect affected clips','','primary')}<p>Restore adjacency or remove this transition explicitly. Arke proposals using this join need a fresh review.</p></div>`;
  return `<div class="panel-heading">${o.reviewed?btn('‹ Back to proposal','chat','plain'):''}<div class="row between"><h3>${o.hasTransition?'Crossfade':'Selected join'}</h3>${o.protectDuration?tag('Protected'):''}</div><p>Harbour → Coast</p><p class="meta">Picture · cut at 00:00:24:00</p></div>
    ${!o.hasTransition?`<div class="section">${btn('Add crossfade','add','primary wide')}<p>Blend these two stills across their existing cut.</p></div>`:`<div class="section">${durationControl(o)}
    ${o.adjusted?tag('Adjusted by you · retained'):''}${o.protectDuration?`<p class="meta">Duration protected · ${o.duration.toFixed(2)}s</p>`:''}
    ${o.short?note('Maximum here: 0.50s','The neighbouring transition leaves room for 12 frames. Cut positions stay fixed.',true):''}
    <div class="blend-window"><span>${(24-o.duration/2).toFixed(2)}s</span><b>24.00s cut</b><span>${(24+o.duration/2).toFixed(2)}s</span></div>
    ${btn('▶ Preview transition','preview','wide')}${o.previewing?tag('Preview loop · soundtrack clock retained'):''}</div>
    <div class="section"><h4>Protection</h4><p class="meta">${o.protectJoin?'Join protected':'Join open'} · ${o.protectDuration?'Duration protected':'Duration open'}</p>
    ${btn('Protect settings…','protect','wide')}${o.protectDuration?btn('Release duration…','release','plain'):''}</div>
    <div class="section">${btn('Remove crossfade','remove','wide')}<p class="meta">Restores a hard cut. Clip positions stay fixed.</p></div>`}
    ${note(o.reviewed?'Editing Suggested':'Fixed picture timing','Cut at 0:24 · film ends at 1:12 · soundtrack unchanged')}`;
}
export function batchPanel(o) {
  const plan=batchPlan(o), changed=plan.filter(j=>!j.keep&&!j.skip), shorter=plan.filter(j=>j.shorter), allowed=changed.length>0&&(!shorter.length||o.acceptShort);
  const rows = plan.map(j=>{
    return `<div class="join-result ${j.shorter?'short-row':''}"><span><b>${j.name}</b><small>at ${j.at.toFixed(2)}s</small></span><span>${j.outcome}</span></div>`;
  }).join('');
  return `<div class="panel-heading"><div class="row between"><h3>Apply across images</h3>${btn('Close','inspect','plain')}</div><p>Crossfades at existing picture cuts</p></div>
    <div class="section">${select('Scope',['All still images','Selected images','Time range'],o.scope,'scope')}
    ${o.scope==='Selected images'?note('Both sides must be selected','Window, Detail and Evening · 2 joins inside the selection'):''}
    ${o.scope==='Time range'?`<div class="row">${field('From (seconds)',`<input type="number" value="${o.rangeStart??12}" aria-label="From" data-key="rangeStart">`)}${field('To (seconds)',`<input type="number" value="${o.rangeEnd??36}" aria-label="To" data-key="rangeEnd">`)}</div><p class="meta">Includes cuts at From, up to but not including To.</p>`:''}
    ${durationControl(o)}${select('Existing transitions',['Keep existing','Replace unprotected'],o.replace?'Replace unprotected':'Keep existing','existing')}
    <p class="meta">Protected durations stay fixed. Join protection keeps the crossfade; its unprotected duration can change.</p></div>
    <div class="section"><div class="row between"><h4>Check the joins</h4>${tag(`${plan.length} joins`)}</div>${rows||'<p>No joins in this range.</p>'}</div>
    ${shorter.length?`<div class="section">${note(`${shorter.length} joins need shorter fades`,'The 15-frame Detail clip cannot support two 1.00s fades. Use 0.50s at each join, or skip those joins.',true)}
    ${check('Use the shown shorter durations',o.acceptShort,'acceptShort')}${btn('Skip the 2 short joins','skip-short','plain')}
    <p class="meta">${o.replace?'Only unprotected existing transitions may be replaced.':'Existing transitions are preserved.'}</p></div>`:''}
    <div class="section sticky-actions">${btn(allowed?`Apply ${changed.length} crossfades`:changed.length?'Review shorter durations first':'No changes to apply','apply-batch','primary wide',allowed?'':'disabled')}
    <p class="meta">${changed.length} changes · ${plan.filter(j=>j.keep).length} kept · ${plan.filter(j=>j.skip).length} skipped · one Undo step</p></div>`;
}
export function chatPanel(o) {
  const rows=o.cardRows??[{id:'bc',name:'Harbour → Coast',before:0,after:o.adjusted?1.25:1},{id:'de',name:'Window → Detail',before:0,after:.5},{id:'ef',name:'Detail → Evening',before:0,after:.5}];
  if(o.live&&!o.proposalReady)return `<div class="panel-heading"><h3>Arke</h3><p>Harbour lights · production conversation</p></div><div class="chat-message">${o.discarded?'Crossfade proposal discarded. Current is unchanged.':'Ask for transitions between these images. Arke will return a card for review.'}</div><div class="composer">${field('Ask Arke','<textarea aria-label="Ask Arke" placeholder="Add gentle crossfades between the stills…"></textarea>')}${btn('Prepare example proposal','suggest','primary wide')}</div>`;
  return `<div class="panel-heading"><h3>Arke</h3><p>Harbour lights · production conversation</p></div>
    <div class="chat-message person">Add gentle one-second crossfades between the stills. Keep the video and song timing as they are.</div>
    <div class="chat-message">I’ve prepared crossfades for the stills. Short joins use 0.50s; your protected opening transition stays as it is.</div>
    <article class="proposal"><div class="row between"><h4>Crossfades · Version ${o.version}</h4>${tag(o.applied?'Applied':o.reviewed?'Reviewing':'Ready')}</div>
    <p>All still images · Picture</p><div class="proposal-stats"><b>${rows.length} changes</b><span>Opening kept · video and gap skipped</span></div>
    <p class="meta">Fixed cuts · 1:12 total · sound unchanged</p>
    ${o.stale?note('A picture cut changed','Window → Detail moved after this proposal. Apply is unavailable until you update and review again.',true):''}
    ${o.conflict?note('Duration stays protected','Arke suggests 1.25s at this join. Current 0.75s remains; release requires your explicit choice.',true):''}
    ${o.adjusted?note('Adjusted by you',o.excluded?'Harbour → Coast · Current retained':`Harbour → Coast · ${(o.proposalDuration??o.duration).toFixed(2)}s retained in revisions`):''}
    <details ${o.details?'open':''}><summary>${rows.length} changes · Show details</summary>
    ${rows.map(r=>`<div class="join-result"><span>${r.name}</span><b>${r.before?`${r.before.toFixed(2)}s`:'Cut'} → ${r.after?`${r.after.toFixed(2)}s`:'Cut'}</b></div>${r.id==='bc'&&!o.applied&&o.reviewed?`${btn('Inspect transition','inspect')}${btn('Keep Current here','exclude','plain')}`:''}`).join('')}
    <p class="meta">Shortened to prevent overlapping blends. Opening 0.75s protected. Video joins and the gap skipped.</p></details>
    ${o.applied?`<p>Applied in one Undo step.</p>${btn('Undo crossfades','undo')}`:o.stale?btn('Update proposal','update','wide'):
    !o.reviewed?btn('Review in timeline','review','primary wide'):`<p class="meta">${o.view==='current'?'Comparing Current':'Suggested is active'} · version ${o.version}</p>`}
    ${!o.applied?btn('Discard proposal','discard','plain'):''}
    ${o.conflict?`${btn('Keep protected duration','keep-protected','wide')}${btn('Release duration…','release','plain')}`:''}</article>
    ${o.incoming?`<article class="proposal incoming"><h4>Crossfades · Version ${o.version+1}</h4><p>Your manual decisions and protection are retained.</p>${btn(`Review version ${o.version+1}`,'review-new','primary wide')}<p class="meta">Version ${o.version} stays in the preview until you choose this version.</p></article>`:''}
    <div class="composer">${field('Ask Arke','<textarea data-key="prompt" aria-label="Ask Arke" placeholder="Make these transitions gentler…"></textarea>')}${btn(o.reviewed?'Prepare revision':'Ask Arke','suggest','primary wide')}</div>`;
}
function timeline(o) {
  return `<section class="timeline"><div class="row between"><b>Timeline</b><span class="meta">24 fps · 1:12 total</span></div>
  <div class="ruler"><span>0:00</span><span>0:12</span><span class="cut-time">0:24</span><span>0:36</span><span>0:48</span><span>1:00</span><span>1:12</span></div>
  <div class="picture-strip"><div class="clip" style="--pic:url('assets/launch-harbour.webp')">Dawn</div><div class="clip" style="--pic:url('assets/launch-harbour.webp')">Harbour</div><div class="clip" style="--pic:url('assets/scene4-shot13.png')">Coast</div><div class="clip video">▶ Boat</div><div class="clip" style="--pic:url('assets/scene4-shot12.png')">Window</div><div class="clip short">Detail</div><div class="clip" style="--pic:url('assets/scene4-shot13.png')">Evening</div><div class="clip gap">gap</div><div class="clip" style="--pic:url('assets/launch-harbour.webp')">Lights</div>
  <span class="join existing" title="Opening crossfade · protected duration">⋈</span>
  ${btn(o.hasTransition?'⋈':'＋',o.hasTransition?'inspect':'add',`join selected ${o.hasTransition?'has':''}`,'aria-label="Harbour to Coast transition"')}
  ${o.hasTransition?'<span class="handle left" role="slider" tabindex="0" aria-label="Crossfade left duration handle" data-handle="left"></span><span class="handle right" role="slider" tabindex="0" aria-label="Crossfade right duration handle" data-handle="right"></span>':''}
  <i class="cut-line" aria-hidden="true"></i></div>
  <div class="audio-strip"><b>♫</b><span>Harbour lights.wav · original timing</span><i aria-hidden="true"></i></div>
  <div class="effects-strip">✦ Floating lights · continuous across transitions</div>
  <div class="row timeline-actions">${btn('Apply across images…','batch')}${btn('Ask Arke','chat','plain')}</div></section>`;
}
export function screen(options={}) {
  const o={...base(),...options};
  const panel=o.panel==='batch'?batchPanel(o):o.panel==='chat'?chatPanel(o):inspector(o);
  return `<div class="xf216 ${o.device||'desktop'} ${o.live?'live':''}" data-screen-label="${esc(o.label||'Crossfades')}" ${o.live?'id="crossfade-prototype"':''}>
  <header class="app-head"><span>‹ World</span><b>Harbour lights</b><span class="grow"></span><b>Arke <span class="muted">Studio</span></b><span class="head-tail">◉　⚙</span></header>
  <div class="editor-body"><aside class="library"><h3>Library</h3><div class="row">${tag('Media')}${tag('Effects')}</div><p class="meta">8 pictures · 1 audio</p>
  <img src="assets/launch-harbour.webp" alt="Harbour still"><p>Harbour</p><img src="assets/scene4-shot13.png" alt="Coast still"><p>Coast</p><div class="library-help"><b>Transitions</b><p>Select a cut between two stills to add a crossfade.</p>${btn('Apply across images…','batch','wide')}</div></aside>
  <main class="cut"><div class="cut-head row between"><div><h2>The cut</h2><span class="meta">Still-picture film · fixed picture timing</span></div>${tag(o.reviewed?'Reviewing':'Current')}</div>
  ${o.reviewed?`<div class="review-bar"><b>Review · Version ${o.version}</b><div class="row">${btn('Current','current',o.view==='current'?'on':'')}${btn('Suggested','suggested',o.view==='suggested'?'on':'')}${btn(`${o.cardRows?.length??3} changes`,'chat')}</div><div class="row">${btn('Return to Current editing','leave')}${btn('Apply reviewed version','apply','primary',o.stale||o.releasePending?'disabled':'')}</div>${o.releasePending?`<span>Release on Apply · review required</span>${btn('Review release version','review-release')}`:''}</div>`:''}
  <div class="preview"><img src="assets/launch-harbour.webp" alt="Outgoing Harbour still"><img class="incoming-picture" src="assets/scene4-shot13.png" alt="Incoming Coast still" style="opacity:${o.hasTransition?o.phase/100:0}"><span class="preview-label">${o.reviewed?o.view==='suggested'?'Suggested':'Current':'Current'} · ${o.hasTransition?'Crossfade':'Hard cut'}</span><div class="preview-caption">Harbour <span>→</span> Coast</div><div class="preview-time">0:24 / 1:12</div></div>
  <div class="transport">${btn(o.previewing?'Ⅱ Pause':'▶ Preview join','preview','plain')}<input type="range" min="0" max="100" value="${o.phase}" aria-label="Transition preview position" data-key="phase"><span class="meta">${o.hasTransition?`${o.duration.toFixed(2)}s blend`:'Hard cut'}</span></div>
  ${timeline(o)}${o.status?`<div class="status" role="status">${esc(o.status)}${o.undo?btn('Undo','undo','plain'):''}</div>`:''}
  <div class="mobile-tools">${btn('Join','inspect')}${btn('Apply across','batch')}${btn('Arke','chat')}</div></main>
  <aside class="inspector ${o.phonePanel?'shown':''}"><div class="panel-tabs">${btn('Inspector','inspect',o.panel==='chat'?'':'on')}${btn('Arke','chat',o.panel==='chat'?'on':'')}${btn('Done','close-panel','touch-only')}</div><div class="panel-scroll">${panel}</div></aside></div>
  <footer><span>${o.reviewed?'Pending review · Current unchanged':'Saved cut · 1:12'}</span><span>Cut positions preserved</span></footer></div>`.replace(/[ \t]+$/gm,'');
}

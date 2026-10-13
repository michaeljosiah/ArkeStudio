// Join discovery and transition placement drawings, scoped to revised turn 216.
const button=(label,act,extra='')=>`<button type="button" data-act="${act}" ${extra}>${label}</button>`;
export function transitionTile(act='add',drag=false){
  return button('<span class="transition-art" aria-hidden="true"><i></i><i></i><b>⋈</b></span><span><b>Crossfade</b><small>Blend two images · 1.00s default</small></span>',act,`class="transition-tile" ${drag?'draggable="true" data-transition="crossfade" aria-label="Crossfade. Drag to a clip boundary or click to choose."':''}`);
}
export function transitionPicker(o){
  if(!o.picker&&!o.replacePrompt)return '';
  const replacing=o.replacePrompt;
  return `<div class="transition-picker ${replacing?'replacement':''}" role="dialog" aria-label="${replacing?'Replace transition':'Add transition'}">
    <div class="row between"><h3>${replacing?'Replace transition?':'Add transition'}</h3>${button('Close','close-picker','class="plain"')}</div>
    <p class="meta">Harbour → Coast · cut at 0:24</p>
    ${replacing?`<div class="replacement-summary"><span>Current <b>Crossfade · ${o.duration.toFixed(2)}s</b></span><span>New <b>Crossfade · 1.00s</b></span></div>
      <p class="meta">${o.protectDuration?o.reviewed?'Protected duration stays fixed during review.':'This direct edit updates the protected duration; protection stays on.':'Replace this join only. Other transitions stay as they are.'}</p>
      <div class="row">${button('Keep existing','close-picker')}${button('Replace transition','replace-transition','class="primary"')}</div>`:
      `${transitionTile()}<p class="meta">Choose to add immediately. Adjust duration afterwards.</p>`}
    <p class="picker-foot">Cut stays at 0:24 · film ends at 1:12</p></div>`;
}
export function transitionLibrary(){
  return `<div class="transition-collection"><h3>Transitions</h3><p class="meta">Choose at a cut, or drag onto its boundary.</p>${transitionTile('open-picker',true)}<p class="meta">Drop between touching stills. Existing transitions ask before replacement.</p></div>`;
}
export function joinEntry(o){
  return `${button(o.hasTransition?'⋈':'<span>＋</span>',o.hasTransition?'inspect':'open-picker',`class="join selected join-trigger ${o.hasTransition?'has':'empty'} ${o.discover||o.picker?'revealed':''} ${o.focusJoin?'focus-drawn':''}" data-drop="join" aria-label="${o.hasTransition?'Inspect Harbour to Coast crossfade':'Add transition between Harbour and Coast'}" ${!o.hasTransition?`aria-haspopup="dialog" aria-expanded="${!!o.picker}"`:''}`)}
    ${o.discover&&!o.hasTransition&&!o.picker?'<span class="join-hint">＋ Add transition</span>':''}
    <span class="drop-ghost" aria-hidden="true">Crossfade · 1.00s</span>${transitionPicker(o)}`;
}
export function mobileJoin(o){
  return `<div class="mobile-join"><span><b>Harbour → Coast</b><small>Join at 0:24</small></span>${button(o.hasTransition?'⋈ Crossfade':'＋',o.hasTransition?'inspect':'open-picker',`aria-label="${o.hasTransition?'Inspect crossfade':'Add transition at 0:24'}" ${!o.hasTransition?'aria-haspopup="dialog"':''}`)}</div>`;
}

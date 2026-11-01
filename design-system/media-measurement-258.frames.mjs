// Synthetic Cut inspector drawings; no author world or media operation is used.
const esc = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const link = (letter,label,primary=false) => `<a class="ph257-btn${primary?' primary':''}" href="media-measurement-258.review.html#258${letter}">${label}</a>`;
function status(mode) {
 const states={unknown:['Source duration unavailable','Measure the saved file on this device to check its duration and audio. The clip stays unchanged.',link('b','Measure media',true)],
 measuring:['Measuring source…','Reading the saved file locally. No generation or upload is running.','<button class="ph257-btn primary" disabled>Measuring…</button>'],
 failed:['Could not measure this source','The saved clip is still available. Try the local measurement again.',link('e','Try again',true)],
 tools:['Media tools unavailable','Measurement needs Studio’s local media tools. The saved clip is still available.',link('g','Try again')],
 changed:['Source changed','The file changed while it was being read. Choose a valid saved take before measuring again.',link('g','Choose another take')],
 success:['Source measured','12.0 seconds · video and audio','']};
 const [title,body,action]=states[mode];
 return `<section class="mm258-status" aria-label="Source measurement"><strong>${title}</strong><p>${body}</p>${action}</section>`;
}
function panel(mode) {return `<div class="mm258-inspector"><div class="ph257-eyebrow">PICTURE CLIP</div><h2>Shot 12 · Maren at the rail</h2><dl><div><dt>Scene</dt><dd>SC 1 · The tide</dd></div><div><dt>Take</dt><dd>Take 3 · Video model</dd></div><div><dt>Clip window</dt><dd>6.0 seconds</dd></div><div><dt>Source length</dt><dd>${mode==='success'?'12.0 seconds':'Not measured'}</dd></div></dl>${status(mode)}<p class="ph257-meta mm258-note">Measurement reads this source only. It does not regenerate, replace or select a take.</p><div class="mm258-timing"><h3>Timing</h3><div><label>In <input value="00:00:00:00" readonly></label><label>Out <input value="00:00:06:00" readonly></label></div></div></div>`;}
function desktop(mode) { return `<div class="ph257 mm258"><header class="ph257-apphead"><b class="ph257-logo">arke</b><span>The Undersong / Saltlight</span><span class="grow"></span><span>Cut</span><span>Settings</span></header><div class="mm258-editor"><aside class="mm258-library"><b>Library</b><p class="ph257-meta">Shots · Media</p><div>▧ &nbsp; Shot 12<br><small>Maren at the rail</small></div><div>♪ &nbsp; Master track<br><small>The tide · 02:10</small></div></aside><main class="mm258-centre"><header><h1>Saltlight</h1><span>Saved timeline · v8</span></header><div class="mm258-preview"><img src="assets/saltlight-shot15.png" alt="Synthetic storyboard preview"></div><div class="mm258-transport">◀ &nbsp; ▶ &nbsp; 00:00:14:00</div><div class="mm258-lanes"><p>Picture &nbsp; <span>Shot 11</span><strong>Shot 12</strong><span>Shot 13</span></p><p>Music &nbsp; <b>Master track — The tide</b></p></div></main><aside class="mm258-right">${panel(mode)}</aside></div><footer class="ph257-appfoot">Connected<span class="grow"></span>Cut timing and selections are unchanged</footer></div>`;}
function phone(mode) {return `<div class="ph257 ph257-phone mm258"><div class="ph257-overlay"><section class="ph257-sheet"><header class="ph257-sheethead"><div><h2>Clip details</h2><p>Saltlight / The tide</p></div><span class="grow"></span><a class="ph257-close" href="media-measurement-258.review.html#258g" aria-label="Close">✕</a></header><div class="ph257-sheetbody">${panel(mode)}</div><footer class="ph257-sheetfoot"><span class="ph257-meta">Reads the saved file on this device</span><span class="grow"></span>${link('a','Done')}</footer></section></div></div>`;}
export const frames=[
{id:'258a',title:'Cut inspector · measure an unmeasured source',width:1360,height:820,markup:desktop('unknown')},
{id:'258b',title:'Local measurement · one pending act, no generation',width:1360,height:820,markup:desktop('measuring')},
{id:'258c',title:'Phone · a failed measurement preserves the take',width:390,height:844,markup:phone('failed')},
{id:'258d',title:'Phone · local media tools unavailable',width:390,height:844,markup:phone('tools')},
{id:'258e',title:'Measured · duration and audio become available',width:1360,height:820,markup:desktop('success')},
{id:'258f',title:'Phone · changed source refuses stale metadata',width:390,height:844,markup:phone('changed')},
{id:'258g',title:'Phone · measure this source from Clip details',width:390,height:844,markup:phone('unknown')},
];
for(const f of frames)f.markup=f.markup.replace('<div class=',`<div data-screen-label="${esc(f.id+' '+f.title)}" style="width:${f.width}px;height:${f.height}px" class=`);
export {esc};

// Arke Player · the frames, turn by turn. The sample is The Undersong, shared by Helen Marsh with
// Jonah Pike, beside Copper Saints (shared by Ama Mensah) and Meridian Dust (added from a file).
// Every picture is already in design-system/assets; nothing here is generated.
import { A, ic, seek, sb, hi, tabs, dock, frame, cc, tile, wc, sh, row, sheet, gb } from './arke-player.view.mjs';

// ---- the sample ------------------------------------------------------------------------------
const W = {
  undersong: { img: 'world-undersong.png', name: 'The Undersong', by: 'Helen Marsh', count: '6 productions', logline: 'A drowned god still sings beneath the harbour of Saltmouth.' },
  copper: { img: 'world-copper-saints.png', name: 'Copper Saints', by: 'Ama Mensah', count: '2 productions' },
  meridian: { img: 'world-meridian-dust.png', name: 'Meridian Dust', count: '3 productions', size: '1.4 GB' },
};
const PR = {
  saltlight: { img: 'saltlight-shot15.png', pos: '38% 50%', title: 'Saltlight', kind: 'Film · 1 h 32 m' },
  bell: { img: 'char-sereth.png', pos: '50% 28%', title: 'The Bell Watch', kind: 'Micro drama · 40 episodes' },
  low: { img: 'drowned-quarter.png', pos: '30% 50%', title: 'Low Water', kind: 'Interactive movie · 14 scenes' },
  lantern: { img: 'art-direction-illustrated.png', pos: '34% 40%', title: 'The Lantern Road', kind: 'Visual novel · 9 scenes' },
  tenth: { img: 'banner-story.png', pos: '50% 40%', title: 'The Tenth Key', kind: 'Audiobook · Book · 9 h 40 m' },
  undertow: { img: 'banner-audio.png', pos: '50% 50%', title: 'Undertow', kind: 'Audio drama · 8 episodes' },
};
const back = gb('left', 22);
const more = gb('more', 20);
const close = '<span class="ib">' + ic('down', 26, 2) + '</span>';
const media = (cls = '') => `phone media${cls ? ' ' + cls : ''}`;

// ---- P1 · the shape -------------------------------------------------------------------------
const P1 = [
  frame('P1a', 'First open', media(), `<img class="pic" src="${A}world-undersong.png" alt="" style="height:66%;object-position:56% 50%"><div class="sbot" style="height:600px"></div>${sb(true)}
<div style="position:absolute;left:0;right:0;top:432px;text-align:center"><div class="wm">Arke</div><div class="wm2">Player</div></div>
<div style="position:absolute;left:20px;right:20px;bottom:54px;display:flex;flex-direction:column;gap:10px"><span class="btn pri wide">Sign in with Arke ${ic('out', 16, 2)}</span><span class="btn wide">${ic('package', 18)}Add a package</span></div>${hi()}`),

  frame('P1b', 'Home', 'phone', `${sb()}<div class="hd"><h1>Home</h1><span class="av">JP</span></div><div class="body">
${sh('Continue')}<div class="hrow">${cc({ img: PR.tenth.img, pos: '50% 40%', kind: 'Audiobook', title: 'The Tenth Key', where: 'Chapter 7 · 19 min left', at: 55 })}${cc({ img: PR.saltlight.img, pos: PR.saltlight.pos, kind: 'Film', title: 'Saltlight', where: '38 min left', at: 59 })}</div>
${sh('New')}<div class="hrow">${tile({ ...PR.bell, kind: 'Micro drama · The Undersong' })}${tile({ ...PR.undertow, kind: 'Audio drama · The Undersong' })}${tile({ img: 'world-copper-saints.png', pos: '70% 50%', title: 'Foundry Hymns', kind: 'Audiobook · Copper Saints' })}</div>
${sh('Worlds')}<div class="hrow">${wc({ ...W.undersong, meta: 'Helen Marsh', cls: 'mini', pos: '60% 50%' })}${wc({ ...W.copper, meta: 'Ama Mensah', cls: 'mini' })}</div>
</div>${tabs('Home')}${hi()}`),

  frame('P1c', 'Library', 'phone', `${sb()}<div class="hd"><h1>Library</h1><span class="icb">${ic('plus', 20, 2)}</span></div><div class="chips"><span class="chip on">All</span><span class="chip">Shared</span><span class="chip">Added</span></div><div class="body" style="padding-top:16px">
${wc({ ...W.undersong, meta: 'Helen Marsh · 6 productions', pos: '60% 50%' })}${wc({ ...W.copper, meta: 'Ama Mensah · 2 productions' })}${wc({ ...W.meridian, meta: 'Added · 3 productions · 1.4 GB', pos: '40% 50%' })}
</div>${tabs('Library')}${hi()}`),

  frame('P1d', 'A world', 'phone', `${sb(true)}<div class="body"><div class="hero" style="padding-top:226px"><img src="${A}world-undersong.png" alt="" style="height:300px;object-position:60% 50%"><div class="fade" style="top:100px;height:201px"></div><div class="top">${back}${more}</div><div class="in"><h1>The Undersong</h1><div class="meta">Helen Marsh · 6 productions</div><div class="lg">${W.undersong.logline}</div></div></div>
${sh('Watch')}<div class="hrow">${tile({ ...PR.saltlight, at: 59 })}${tile({ ...PR.bell, kind: 'Micro drama · 40 episodes', at: 30 })}</div>
${sh('Play')}<div class="hrow">${tile(PR.low)}${tile(PR.lantern)}</div>
</div>${dock({ img: 'scene4-shot15.png', title: 'The Tenth Key', where: 'Chapter 7 · 12:04', at: 38 })}${tabs('Library')}${hi()}`),

  frame('P1e', 'A production · audiobook and book', 'phone', `${sb(true)}<div class="body"><div class="hero" style="padding-top:218px"><img src="${A}banner-story.png" alt="" style="height:290px;object-position:50% 40%"><div class="fade" style="top:90px;height:201px"></div><div class="top">${back}${more}</div><div class="in"><h1>The Tenth Key</h1><div class="meta">Audiobook · Book · 9 h 40 m · Read by Odile’s voice</div>
<div style="margin-top:16px"><span class="btn pri wide">${ic('play', 16)}Continue <em>· Chapter 7 · 12:04</em></span></div><div class="acts"><span class="btn" style="flex:1">${ic('book', 18)}Read</span><span class="btn" style="flex:1">${ic('download', 18)}412 MB</span><span class="btn" style="width:44px;padding:0">${ic('more')}</span></div></div></div>
${sh('Chapters')}
${[['scene4-shot12.png', '6 · The Weir', '41 min', 100, true], ['scene4-shot15.png', '7 · The Tenth Key', '32 min', 38, true], ['scene4-shot14b.png', '8 · Saltmouth Bells', '38 min', 0, true], ['scene4-shot13.png', '9 · A Choir Underwater', '44 min', 0, false]].map(([img, t, d, at, dl]) => `<div class="ep"><div class="th"><img src="${A}${img}" alt="">${at ? `<div class="pl"><i style="width:${at}%"></i></div>` : ''}</div><div class="grow"><div class="t">${t}</div><div class="m"><span>${d}</span>${dl ? ic('downloaded', 14) : ''}</div></div></div>`).join('')}
</div>${tabs('Library')}${hi()}`),

  frame('P1f', 'A production · micro drama', 'phone', `${sb(true)}<div class="body"><div class="hero" style="padding-top:218px"><img src="${A}char-sereth.png" alt="" style="height:290px;object-position:50% 26%"><div class="fade" style="top:90px;height:201px"></div><div class="top">${back}${more}</div><div class="in"><h1>The Bell Watch</h1><div class="meta">Micro drama · 40 episodes · 1 h 52 m</div>
<div style="margin-top:16px"><span class="btn pri wide">${ic('play', 16)}Continue <em>· Episode 13</em></span></div><div class="acts"><span class="btn" style="flex:1">${ic('download', 18)}640 MB</span><span class="btn" style="width:44px;padding:0">${ic('more')}</span></div></div></div>
${sh('Episodes')}<div class="grid4">${['char-maren.png', 'scene4-shot12.png', 'scene4-shot14b.png', 'char-ilo.png', 'scene4-shot15.png', 'char-bray.png', 'scene4-shot13.png', 'char-chorister.png'].map((img, i) => `<div class="vt"><img src="${A}${img}" alt="" style="object-position:50% 30%"><span class="n">${i + 1}</span><div class="pl"><i style="width:100%"></i></div></div>`).join('')}</div>
</div>${tabs('Library')}${hi()}`),
];

// ---- P2 · getting worlds in ------------------------------------------------------------------
const firstOpenBehind = `<img class="pic" src="${A}world-undersong.png" alt="" style="height:66%;object-position:56% 50%"><div class="sbot" style="height:600px"></div>${sb(true)}<div style="position:absolute;left:0;right:0;top:432px;text-align:center"><div class="wm">Arke</div><div class="wm2">Player</div></div>`;
const shareCard = `<div style="padding:2px 16px 0"><div class="on-media" style="position:relative;height:196px;border-radius:14px;overflow:hidden;background:var(--media-overlay-bg)"><img src="${A}world-undersong.png" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:60% 50%"><div class="shade"></div><div style="position:absolute;left:14px;bottom:12px"><div class="k">World</div><div style="margin-top:3px;font:var(--weight-semibold) var(--text-xl)/1.2 var(--font-sans);letter-spacing:var(--tracking-tight)">The Undersong</div></div></div>
<div style="display:flex;align-items:center;gap:12px;margin-top:14px"><span class="av" style="width:40px;height:40px"><img src="${A}char-odile.png" alt="" style="object-position:50% 20%"></span><div class="grow"><div style="font:var(--type-ui);font-size:var(--text-base)">Helen Marsh</div><div class="mute" style="font:var(--type-meta)">6 productions</div></div></div></div>`;
const libraryBehind = (extra = '') => `${sb()}<div class="hd"><h1>Library</h1><span class="icb">${ic('plus', 20, 2)}</span></div><div class="chips"><span class="chip on">All</span><span class="chip">Shared</span><span class="chip">Added</span></div><div class="body" style="padding-top:16px">${wc({ ...W.undersong, meta: 'Helen Marsh · 6 productions', pos: '60% 50%' })}${wc({ ...W.copper, meta: 'Ama Mensah · 2 productions' })}${extra}</div>${tabs('Library')}`;
const meridianThumb = (pos) => `<div class="th" style="width:96px;height:54px"><img class="crop" src="${A}world-meridian-dust.png" alt="" style="transform-origin:${pos}"></div>`;

const P2 = [
  frame('P2a', 'A share link, signed out', media(), `${firstOpenBehind}<div class="veil"></div>${sheet('Shared with you', `${shareCard}<div style="display:flex;flex-direction:column;gap:8px;padding:20px 16px 0"><span class="btn pri wide">Sign in with Arke ${ic('out', 16, 2)}</span><span class="btn ghost wide">Not now</span></div>`)}<div class="hi" style="color:var(--foreground)"></div>`),

  frame('P2b', 'Waiting for the browser', media(), `${firstOpenBehind}<div class="veil"></div>${sheet('Shared with you', `${shareCard}<div style="display:flex;flex-direction:column;gap:8px;padding:20px 16px 0"><span class="btn wide" style="gap:10px"><span class="spin"></span>waiting for the browser</span><span class="btn ghost wide">Cancel</span></div>`)}<div class="hi" style="color:var(--foreground)"></div>`),

  frame('P2c', 'Add a package', 'phone', `${libraryBehind()}<div class="veil"></div>${sheet('Add a package', `<div class="opt">${ic('folder', 22)}<span class="l">Choose a file</span><span class="mute">${ic('right', 18)}</span></div><div class="opt">${ic('link', 22)}<span class="l">Paste a link</span><span class="mute">${ic('right', 18)}</span></div>`)}${hi()}`),

  frame('P2d', 'Checking a package', 'phone', `${libraryBehind()}<div class="veil"></div>${sheet('Checking', `<div style="display:flex;align-items:center;gap:14px;padding:6px 16px 0"><span class="icb" style="width:52px;height:52px;border-radius:14px">${ic('package', 26)}</span><div class="grow"><div style="font:var(--type-ui);font-size:var(--text-base)">meridian-dust.arke</div><div class="mute num" style="font:var(--type-meta)">1.4 GB</div></div></div><div style="padding:18px 16px 0"><div class="bar"><i style="width:51%"></i></div><div class="mute num" style="margin-top:8px;font:var(--type-meta)">212 of 418 files</div></div><div style="padding:18px 16px 0"><span class="btn wide">Cancel</span></div>`, { close: false })}${hi()}`),

  frame('P2e', 'A package, ready', 'phone', `${sb()}<div class="hd"><span class="icb">${ic('x', 18, 2)}</span><span class="grow"></span></div><div class="body">
<div class="on-media" style="position:relative;margin:4px 16px 0;height:200px;border-radius:16px;overflow:hidden;background:var(--media-overlay-bg)"><img src="${A}world-meridian-dust.png" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:40% 50%"><div class="shade"></div><div style="position:absolute;left:16px;bottom:14px"><div class="k">Package</div><div style="margin-top:3px;font:var(--weight-semibold) var(--text-2xl)/1.15 var(--font-sans);letter-spacing:var(--tracking-tighter)">Meridian Dust</div></div></div>
<div class="mute num" style="padding:10px 16px 0;font:var(--type-ui)">made 12 Oct 2026 · 3 productions · 1.4 GB</div>
${sh('Inside')}${[['12% 22%', 'Dust Line', 'Interactive movie · 820 MB'], ['72% 62%', 'The Long Haul', 'Audiobook · 380 MB'], ['92% 70%', 'Rail Song', 'Film · 210 MB']].map(([p, t, m]) => `<div class="ep">${meridianThumb(p)}<div class="grow"><div class="t">${t}</div><div class="m"><span>${m}</span></div></div></div>`).join('')}
<div style="height:14px"></div><div class="grp">${row('Space', '1.4 GB of 38 GB free', '')}</div>
</div><div style="flex:none;padding:12px 16px 34px"><span class="btn pri wide">Add to library</span></div>${hi()}`),

  frame('P2f', 'A package, refused', 'phone', `${libraryBehind()}<div class="veil"></div>${sheet('', `<div style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:14px 20px 0"><span class="warn">${ic('alert', 34, 1.8)}</span><div style="margin-top:4px;font:var(--type-h3)">3 files do not match</div><div class="mute num" style="font:var(--type-ui)">meridian-dust.arke · 1.4 GB</div></div><div style="display:flex;flex-direction:column;gap:8px;padding:20px 16px 0"><span class="btn pri wide">Choose another file</span><span class="btn ghost wide">Close</span></div>`)}${hi()}`),

  frame('P2g', 'A share that ended', 'phone', `${sb()}<div class="hd"><h1>Library</h1><span class="icb">${ic('plus', 20, 2)}</span></div><div class="chips"><span class="chip on">All</span><span class="chip">Shared</span><span class="chip">Added</span></div><div class="body" style="padding-top:16px">
${wc({ ...W.undersong, meta: 'Helen Marsh · 6 productions', pos: '60% 50%' })}<div class="wc ended" style="height:190px"><img src="${A}world-copper-saints.png" alt=""><div class="shade"></div><div class="tg"><span class="tag glass">No longer shared</span></div><div class="tx" style="right:110px"><h3>Copper Saints</h3><div class="m">Ama Mensah</div></div><span class="btn" style="position:absolute;right:12px;bottom:12px;height:40px">Remove</span></div>${wc({ ...W.meridian, meta: 'Added · 3 productions · 1.4 GB', pos: '40% 50%' })}
</div>${tabs('Library')}${hi()}`),
];

// ---- P3 · watching -------------------------------------------------------------------------
const filmPortrait = (withCaption = true) => `<img src="${A}saltlight-shot15.png" alt="" style="position:absolute;left:0;top:318px;width:390px;height:167px;object-fit:cover"><div class="st"></div><div class="sbot" style="height:300px"></div>${sb(true)}
<div class="ptop">${close}<div class="ttl"><div class="eb">The Undersong</div><div class="sc">Saltlight</div></div><span class="ib">${ic('cast', 20)}</span></div>
${withCaption ? '<div class="cap" style="top:500px">The tide is lower than it has ever been.</div>' : ''}
<div style="position:absolute;z-index:4;left:20px;right:20px;bottom:44px"><div class="scrub"><u style="width:68%"></u><i style="width:59%"></i><b style="left:59%"></b></div><div class="times"><span>54:40</span><span>1:32:40</span></div>
<div class="trow" style="margin-top:14px"><span class="ib on">${ic('captions', 20)}</span><span class="ib">${seek(10, true, 24)}</span><span class="play">${ic('pause', 24)}</span><span class="ib">${seek(10, false, 24)}</span><span class="ib">${ic('full', 20)}</span></div></div>${hi()}`;
const feed = `<img class="pic" src="${A}char-sereth.png" alt="" style="object-position:50% 30%"><div class="st"></div><div class="sbot" style="height:360px"></div>${sb(true)}
<div class="ptop">${close}<div class="ttl"><div class="eb">The Bell Watch</div><div class="sc">Episode 13</div></div></div>`;

const P3 = [
  frame('P3a', 'A film, held upright', media(), filmPortrait()),

  frame('P3b', 'A film, turned', 'turned media', `<img class="pic fit" src="${A}saltlight-shot15.png" alt=""><div class="st" style="height:140px"></div><div class="sbot" style="height:170px"></div>
<div class="ptop" style="top:14px;left:40px;right:40px">${close}<div class="ttl"><div class="eb">The Undersong</div><div class="sc">Saltlight</div></div><span class="ib">${ic('cast', 20)}</span><span class="ib on">${ic('captions', 20)}</span></div>
<div class="cap" style="bottom:104px;max-width:600px">The tide is lower than it has ever been.</div>
<div style="position:absolute;z-index:4;left:48px;right:48px;bottom:16px"><div class="scrub"><u style="width:68%"></u><i style="width:59%"></i><b style="left:59%"></b></div><div class="trow" style="margin-top:10px"><span style="display:flex;align-items:center;gap:6px"><span class="ib">${ic('pause', 22)}</span><span class="ib">${seek(10, true, 22)}</span><span class="ib">${seek(10, false, 22)}</span><span class="num" style="margin-left:8px;font:var(--type-ui);color:color-mix(in srgb,var(--media-overlay-fg) 82%,transparent)">54:40 / 1:32:40</span></span><span class="ib">${ic('unfull', 20)}</span></div></div>`),

  frame('P3c', 'A micro drama, playing', media(), `${feed}
<div class="cap" style="top:470px">Ring it once. Only once.</div>
<div style="position:absolute;z-index:5;right:8px;bottom:132px;display:flex;flex-direction:column;gap:14px"><span class="ib col"><i style="background:color-mix(in srgb,var(--media-overlay-bg) 42%,transparent)">${ic('grid', 20)}</i>Episodes</span><span class="ib col"><i style="background:color-mix(in srgb,var(--media-overlay-fg) 18%,transparent)">${ic('captions', 20)}</i>Captions</span><span class="ib col"><i style="background:color-mix(in srgb,var(--media-overlay-bg) 42%,transparent)">${ic('more', 20)}</i>More</span></div>
<div style="position:absolute;z-index:4;left:16px;right:84px;bottom:66px"><div style="font:var(--type-h3);letter-spacing:var(--tracking-tight)">13 · The lamp in the tower</div><div class="mute" style="margin-top:2px;font:var(--type-ui)">1:58 · 2:46</div></div>
<div style="position:absolute;z-index:4;left:16px;right:16px;bottom:42px"><div class="scrub" style="height:3px"><i style="width:71%"></i></div></div>${hi()}`),

  frame('P3d', 'Episodes', media(), `${feed}<div class="veil" style="background:color-mix(in srgb,var(--media-overlay-bg) 30%,transparent)"></div>${sheet('Episodes', `<div class="seg"><span class="on">1–20</span><span>21–40</span></div><div class="nts">${Array.from({ length: 20 }, (_, i) => `<span class="nt${i + 1 < 13 ? ' seen' : i + 1 === 13 ? ' now' : ''}">${i + 1}</span>`).join('')}</div>`, { glass: true, count: '40' })}${hi()}`),

  frame('P3e', 'Captions', media(), `${filmPortrait(false)}<div class="veil" style="background:color-mix(in srgb,var(--media-overlay-bg) 30%,transparent)"></div>${sheet('Captions', `${['Off', 'English', 'Español', 'Français'].map((l) => `<div class="opt"><span class="l">${l}</span>${l === 'English' ? ic('check', 20, 2.2) : ''}</div>`).join('')}<div class="sht" style="padding-top:14px"><h3 style="font:var(--type-ui);font-size:var(--text-base);opacity:.7">Size</h3></div><div class="seg"><span>S</span><span class="on">M</span><span>L</span></div>`, { glass: true })}${hi()}`),
];

// ---- P4 · playing ---------------------------------------------------------------------------
const lowWater = `<img class="pic" src="${A}drowned-quarter.png" alt="" style="object-position:30% 50%"><div class="dim"></div><div class="st"></div>${sb(true)}
<div class="ptop">${close}<div class="ttl"><div class="eb">Low Water</div><div class="sc">The drowned quarter</div></div><span class="ib glass">${ic('captions', 18)}</span><span class="ib glass" style="margin-left:6px">${ic('route', 18)}</span></div>`;
const lantern = `<img class="pic" src="${A}art-direction-illustrated.png" alt="" style="object-position:34% 40%"><div class="st" style="height:220px"></div>${sb(true)}
<div class="ptop">${close}<div class="ttl"><div class="eb">The Lantern Road</div><div class="sc">The lamp market</div></div><span class="ib">${ic('more', 20)}</span></div><div style="position:absolute;z-index:5;left:14px;top:104px;display:flex;gap:6px"><span class="ib lab on" style="height:40px">${ic('auto', 16)}Auto</span><span class="ib lab" style="height:40px">${ic('list', 16)}Log</span></div>`;
const still = (img, pos = 'center', ring = false, w = 96, h = 54) => `<span class="still${ring ? ' ring' : ''}" style="width:${w}px;height:${h}px"><img src="${A}${img}" alt="" style="object-position:${pos}"></span>`;

const P4 = [
  frame('P4a', 'An interactive movie · the choice', media(), `${lowWater}<div class="sbot" style="height:430px"></div>
<div style="position:absolute;z-index:4;left:16px;right:16px;bottom:96px;display:flex;flex-direction:column;gap:12px"><div class="choice focus"><span class="kn">1</span><span>Follow the lantern</span></div><div class="choice"><span class="kn">2</span><span>Stay with the boat</span></div></div>
<div style="position:absolute;z-index:4;left:0;right:0;bottom:36px;display:flex;justify-content:center"><span class="btn ghost" style="height:40px;color:color-mix(in srgb,var(--media-overlay-fg) 82%,transparent)">${ic('replay', 16)}Replay scene</span></div>${hi()}`),

  frame('P4b', 'An interactive movie · the route', media(), `${lowWater}<div class="veil" style="background:color-mix(in srgb,var(--media-overlay-bg) 30%,transparent)"></div>${sheet('Route', `<div class="rt">${still('launch-harbour.webp', '50% 60%')}<div class="grow"><div class="t">The harbour at dusk</div><div class="d num">1:12</div></div></div>
<div class="rc">${ic('right', 14, 2)}<span class="grow">Take the skiff</span><span class="btn">Choose again</span></div>
<div class="rt">${still('scene4-shot15.png')}<div class="grow"><div class="t">Under the pier</div><div class="d num">0:54</div></div></div>
<div class="rc">${ic('right', 14, 2)}<span class="grow">Follow the lantern</span><span class="btn">Choose again</span></div>
<div class="rt">${still('drowned-quarter.png', '30% 50%', true)}<div class="grow"><div class="t">The drowned quarter</div><div class="d">now</div></div></div>
<div style="padding:16px 16px 0"><span class="btn wide">${ic('replay', 16)}Start over</span></div>`, { glass: true })}${hi()}`),

  frame('P4c', 'An interactive movie · an ending', media(), `<img class="pic" src="${A}scene4-shot15.png" alt="" style="object-position:50% 40%"><div class="st"></div><div class="sbot" style="height:560px"></div>${sb(true)}<div class="ptop">${close}</div>
<div style="position:absolute;z-index:4;left:20px;right:20px;bottom:44px"><div class="eb">Ending</div><div style="margin-top:8px;font:var(--weight-bold) var(--text-4xl)/1.08 var(--font-sans);letter-spacing:var(--tracking-tighter)">The Bell Rings Twice</div>
<div style="display:flex;align-items:center;gap:6px;margin-top:20px">${still('launch-harbour.webp', '50% 60%', false, 64, 36)}${ic('right', 14, 2)}${still('scene4-shot15.png', 'center', false, 64, 36)}${ic('right', 14, 2)}${still('drowned-quarter.png', '30% 50%', false, 64, 36)}${ic('right', 14, 2)}${still('scene4-shot13.png', 'center', true, 64, 36)}</div>
<div class="mute" style="margin-top:10px;font:var(--type-meta)">Take the skiff · Follow the lantern · Ring the bell</div>
<div style="display:flex;flex-direction:column;gap:8px;margin-top:22px"><span class="btn pri wide">${ic('replay', 16)}Start again</span><span class="btn wide">Back to last choice</span></div></div>${hi()}`),

  frame('P4d', 'A visual novel · a line', media(), `${lantern}<div class="sbot" style="height:400px"></div>
<div class="vnbox"><span class="who">Maren</span><div class="vnline">Somebody lit a window down there. Nobody lives in the quarter now.</div><span style="position:absolute;right:16px;bottom:10px;color:color-mix(in srgb,var(--media-overlay-fg) 70%,transparent)">${ic('right', 16, 2)}</span></div><div class="beats"><i class="done"></i><i class="done"></i><i class="done"></i><i></i><i></i><i></i></div>${hi()}`),

  frame('P4e', 'A visual novel · the log', media(), `${lantern}<div class="veil" style="background:color-mix(in srgb,var(--media-overlay-bg) 30%,transparent)"></div>${sheet('Log', `${[['', 'The market shut at the second bell. One lamp stayed lit.', 'nar'], ['Maren', 'Somebody lit a window down there.', ''], ['Ilo', 'Then somebody lives there.', ''], ['Maren', 'Nobody lives in the quarter now.', 'now']].map(([s, t, c]) => `<div class="lr${c === 'nar' ? ' nar' : c === 'now' ? ' now' : ''}"><div class="grow">${s ? `<div class="spk">${s}</div>` : ''}<div class="tx">${t}</div></div><span class="ib">${ic('play', 14)}</span></div>`).join('')}`, { glass: true, count: 'Scene 3' })}${hi()}`),
];

// ---- P5 · listening and reading ----------------------------------------------------------------
const book = (where = '7 · The Tenth Key') => `<img class="pic" src="${A}scene4-shot15.png" alt="" style="height:62%;object-position:50% 45%"><div class="st"></div><div class="sbot" style="height:520px"></div>${sb(true)}
<div class="ptop">${close}<div class="ttl"><div class="eb">The Tenth Key</div><div class="sc">${where}</div></div><span class="ib">${ic('list', 20)}</span><span class="ib">${ic('more', 20)}</span></div>
<div style="position:absolute;z-index:5;left:16px;top:106px"><span class="ib lab glass" style="height:44px;gap:10px;padding:0 10px 0 14px">Slow push<span class="sw sm on"></span></span></div>`;
const audioBar = (row2) => `<div style="position:absolute;z-index:4;left:20px;right:20px;bottom:40px"><div class="scrub"><i style="width:44%"></i><b style="left:44%"></b></div><div class="times"><span>13:58</span><span>31:40</span></div>
<div class="trow" style="margin-top:14px"><span class="ib">${ic('prev', 20)}</span><span class="ib">${seek(15)}</span><span class="play">${ic('pause', 24)}</span><span class="ib">${seek(30, false)}</span><span class="ib">${ic('next', 20)}</span></div>
<div class="trow" style="margin-top:14px">${row2}</div></div>`;
const bookRow2 = `<span class="ib lab">1.0×</span><span class="ib lab">${ic('moon', 16)}End of chapter</span><span class="ib lab on">${ic('text', 16)}Text</span>`;

const P5 = [
  frame('P5a', 'An audiobook', media(), `${book()}<div class="words" style="bottom:286px">Odile did not answer. She held the lamp lower.</div>${audioBar(bookRow2)}${hi()}`),

  frame('P5b', 'Chapters', media(), `${book()}<div class="veil" style="background:color-mix(in srgb,var(--media-overlay-bg) 30%,transparent)"></div>${sheet('Chapters', `${[['5', 'The Weigh House', '39:12', 'done'], ['6', 'The Weir', '41:20', 'done'], ['7', 'The Tenth Key', '31:40', 'now'], ['8', 'Saltmouth Bells', '38:05', 'dl'], ['9', 'A Choir Underwater', '44:10', ''], ['10', 'The Keeper’s Ledger', '36:48', '']].map(([n, t, d, s]) => `<div class="chr${s === 'now' ? ' now' : ''}"><span class="no">${n}</span><div class="grow"><div class="t">${t}</div>${s === 'now' ? '<div class="ln2"><i style="width:44%"></i></div>' : ''}</div><span class="d">${d}</span><span style="width:20px;opacity:.7">${s === 'done' ? ic('check', 18, 2.2) : s === 'dl' || s === 'now' ? ic('downloaded', 18) : ''}</span></div>`).join('')}`, { glass: true, count: '22' })}${hi()}`),

  frame('P5c', 'Speed and sleep', media(), `${book()}<div class="veil" style="background:color-mix(in srgb,var(--media-overlay-bg) 30%,transparent)"></div>${sheet('Speed', `<div class="seg"><span>0.8×</span><span class="on">1.0×</span><span>1.2×</span><span>1.5×</span><span>2×</span></div><div class="sht" style="padding-top:22px"><h3>Sleep</h3></div>${['Off', 'End of chapter', '15 min', '30 min', '60 min'].map((l) => `<div class="opt"><span class="l">${l}</span>${l === 'End of chapter' ? ic('check', 20, 2.2) : ''}</div>`).join('')}`, { glass: true })}${hi()}`),

  frame('P5d', 'An audio drama · the transcript', media(), `${sb(true)}<div class="ptop">${close}<div class="ttl"><div class="eb">Undertow</div><div class="sc">3 · The Weir Gate</div></div><span class="ib">${ic('more', 20)}</span></div>
<div style="position:absolute;left:16px;right:16px;top:108px;height:150px;border-radius:14px;overflow:hidden"><img src="${A}banner-audio.png" alt="" style="width:100%;height:100%;object-fit:cover;object-position:50% 40%"></div>
<div class="mask" style="position:absolute;left:0;right:0;top:268px;height:300px;overflow:hidden;padding-top:26px">${[['Sereth', 'You said the gate would hold.', ''], ['Maren', 'I said it would hold until the tide turned.', ''], ['', '[Bells, far off. Water rising.]', 'fx'], ['Bray', 'Then it’s turned. Listen.', 'now'], ['Maren', 'That isn’t the tide.', '']].map(([s, t, c]) => `<div class="tl${c ? ' ' + c : ''}">${s ? `<div class="spk">${s}</div>` : ''}<div class="ln">${t}</div></div>`).join('')}</div>
${audioBar(`<span class="ib lab">1.0×</span><span class="ib lab">${ic('moon', 16)}Off</span><span class="ib lab on">${ic('text', 16)}Transcript</span><span class="ib">${ic('list', 18)}</span>`).replace('width:44%"></i><b style="left:44%', 'width:38%"></i><b style="left:38%').replace('<span>13:58</span><span>31:40</span>', '<span>9:12</span><span>24:30</span>')}${hi()}`),

  frame('P5e', 'A book', 'phone', `${sb()}<div class="hd" style="gap:6px;padding-bottom:0"><span class="icb" style="background:none">${ic('down', 24, 2)}</span><span class="grow mute" style="text-align:center;font:var(--type-ui)">7 · The Tenth Key</span><span class="icb" style="background:none;font:var(--type-ui);font-size:var(--text-md)">Aa</span><span class="icb" style="background:none">${ic('list', 20)}</span></div>
<div class="body"><div class="page"><div class="no" style="margin-top:18px">Chapter 7</div><h2>The Tenth Key</h2><p class="first">The key had no teeth. Odile turned it over twice in the lamplight before she understood that it was not meant for a lock at all.</p><p>Below the window the harbour lay flat and black. The bells had stopped an hour ago, and the silence they left behind was louder than any of them.</p><p>“You found it,” Bray said from the door. He did not come in.</p><p>“It found me.” She closed her hand around it. “Where is the tenth door?”</p><p>He looked at the water for a long time before he answered.</p></div></div>
<div style="flex:none;display:flex;align-items:center;gap:12px;padding:10px 20px 40px"><span class="mute num" style="font:var(--type-meta)">12 of 30</span><div class="bar grow"><i style="width:40%"></i></div><span class="btn" style="height:40px">${ic('headphones', 16)}Listen</span></div>${hi()}`),
];

// ---- P6 · offline, You, the Fold -------------------------------------------------------------
const FOLDWC = 'width:270px;height:152px';
const dlRow = (img, pos, title, state, end, at) => `<div class="ep"><div class="th" style="width:96px;height:54px"><img src="${A}${img}" alt="" style="object-position:${pos}"></div><div class="grow"><div class="t">${title}</div><div class="m">${state}</div>${at != null ? `<div class="bar" style="margin-top:7px;height:3px"><i style="width:${at}%"></i></div>` : ''}</div><span class="end">${end}</span></div>`;

const P6 = [
  frame('P6a', 'Downloads', 'phone', `${sb()}<div class="hd"><h1>Downloads</h1></div><div class="body">
<div style="padding:8px 16px 0"><div class="sbar"><i class="me" style="width:7%"></i><i class="other" style="width:58%"></i></div><div class="leg"><span><i></i>Arke Player 3.2 GB</span><span><i class="other"></i>Other 29 GB</span><span><i class="free"></i>41 GB free</span></div></div>
${sh('Shared')}${dlRow(PR.saltlight.img, PR.saltlight.pos, 'Saltlight', `<span class="num">1.9 GB</span>${ic('downloaded', 14)}`, ic('more', 18))}${dlRow(PR.tenth.img, '50% 40%', 'The Tenth Key', '<span class="num">Downloading · 42%</span>', ic('pausec', 22), 42)}${dlRow(PR.bell.img, '50% 26%', 'The Bell Watch', `${ic('clock', 14)}<span>Waiting for Wi-Fi</span>`, ic('more', 18))}
${sh('Added')}${dlRow(W.meridian.img, '40% 50%', 'Meridian Dust', '<span class="num">3 productions · 1.4 GB</span>', ic('more', 18))}
</div>${tabs('Downloads')}${hi()}`),

  frame('P6b', 'You', 'phone', `${sb()}<div class="hd"><h1>You</h1></div><div class="body" style="padding-top:8px">
<div class="grp"><div class="r" style="min-height:72px"><span class="av" style="width:46px;height:46px;font:var(--type-ui)">JP</span><span class="l"><span style="display:block">Jonah Pike</span><span class="mute" style="display:block;font:var(--type-meta)">jonah@pike.house</span></span><span class="c">${ic('out', 16, 2)}</span></div>${row('Sign out', '', '')}</div>
<div class="gl">Playback</div><div class="grp">${row('Captions', 'English')}${row('Text', '', 'off')}${row('Slow push', '', 'on')}${row('Autoplay next', '', 'on')}</div>
<div class="gl">Downloads</div><div class="grp">${row('Wi-Fi only', '', 'on')}${row('Storage', '3.2 GB')}</div>
<div class="gl">Content</div><div class="grp">${row('Adult content', 'Off')}</div>
</div>${tabs('You')}${hi()}`),

  frame('P6c', 'Adult content', 'phone', `${sb(true)}<div class="body"><div class="hero" style="padding-top:226px"><img src="${A}world-copper-saints.png" alt="" style="height:300px"><div class="fade" style="top:100px;height:201px"></div><div class="top">${back}${more}</div><div class="in"><h1>Copper Saints</h1><div class="meta">Ama Mensah · 2 productions</div></div></div>
${sh('Watch')}<div class="hrow">${tile({ img: 'world-copper-saints.png', pos: '20% 50%', title: 'Vigil', kind: 'Film · 48 min', cls: 'adult', tag: '<span class="tag glass">18+</span>', mid: ic('eyeoff', 26) })}</div>
${sh('Listen')}<div class="hrow">${tile({ img: 'world-copper-saints.png', pos: '70% 50%', title: 'Foundry Hymns', kind: 'Audiobook · 11 chapters' })}</div>
</div>${tabs('Library')}<div class="veil"></div>${sheet('', `<div style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:14px 20px 0">${ic('eyeoff', 32)}<div style="margin-top:4px;font:var(--type-h3)">Adult content is off</div><div class="mute" style="font:var(--type-ui)">Vigil · 18+</div></div><div style="display:flex;flex-direction:column;gap:8px;padding:20px 16px 0"><span class="btn pri wide">I am 18 or older · Turn on</span><span class="btn ghost wide">Not now</span></div>`)}${hi()}`),

  frame('P6d', 'Offline', 'phone', `${sb(false, true)}<div class="hd"><h1>Home</h1><span class="tag line" style="height:28px;padding:0 10px;font-size:var(--text-xs)">${ic('wifioff', 14, 2)}Offline</span><span class="av">JP</span></div><div class="body">
${sh('Continue')}<div class="hrow">${cc({ img: PR.saltlight.img, pos: PR.saltlight.pos, kind: 'Film', title: 'Saltlight', where: '38 min left', at: 59 })}<div class="cc off" style="width:300px;height:169px"><img src="${A}drowned-quarter.png" alt="" style="object-position:30% 50%"><div class="shade"></div><div class="tx"><div class="k">Interactive movie</div><div class="t">Low Water</div><div class="w">offline</div></div></div></div>
${sh('New')}<div class="hrow">${tile({ ...PR.bell, kind: 'offline', cls: 'off' })}${tile({ ...PR.undertow, kind: 'offline', cls: 'off' })}${tile({ img: 'world-meridian-dust.png', pos: '30% 50%', title: 'Dust Line', kind: 'Interactive movie · Meridian Dust' })}</div>
${sh('Worlds')}<div class="hrow">${wc({ ...W.undersong, meta: 'Helen Marsh', cls: 'mini', pos: '60% 50%' })}${wc({ ...W.meridian, meta: 'Added', cls: 'mini', pos: '40% 50%' })}</div>
</div>${tabs('Home')}${hi()}`),

  frame('P6e', 'Home on a Fold', 'fold', `${tabs('Home', true)}<div class="grow" style="display:flex;flex-direction:column;min-width:0;position:relative">${sb()}<div class="hd" style="padding:6px 28px 6px 24px"><h1>Home</h1><span class="av">JP</span></div><div class="body">
<div class="sh" style="padding:0 24px">${'<h2>Continue</h2>'}</div><div class="hrow" style="padding:0 24px;gap:16px">${cc({ img: PR.tenth.img, pos: '50% 40%', kind: 'Audiobook', title: 'The Tenth Key', where: 'Chapter 7 · 19 min left', at: 55, w: 420 })}${cc({ img: PR.saltlight.img, pos: PR.saltlight.pos, kind: 'Film', title: 'Saltlight', where: '38 min left', at: 59, w: 420 })}</div>
<div class="sh" style="padding:0 24px"><h2>New</h2></div><div class="hrow" style="padding:0 24px;gap:16px">${tile({ ...PR.bell, kind: 'Micro drama · The Undersong', w: 200 })}${tile({ ...PR.undertow, kind: 'Audio drama · The Undersong', w: 200 })}${tile({ img: 'world-copper-saints.png', pos: '70% 50%', title: 'Foundry Hymns', kind: 'Audiobook · Copper Saints', w: 200 })}${tile({ ...PR.lantern, kind: 'Visual novel · The Undersong', w: 200 })}</div>
<div class="sh" style="padding:0 24px"><h2>Worlds</h2></div><div class="hrow" style="padding:0 24px;gap:16px">${wc({ ...W.undersong, meta: 'Helen Marsh', cls: 'mini', pos: '60% 50%', style: FOLDWC })}${wc({ ...W.copper, meta: 'Ama Mensah', cls: 'mini', style: FOLDWC })}${wc({ ...W.meridian, meta: 'Added', cls: 'mini', pos: '40% 50%', style: FOLDWC })}</div>
</div>${hi()}</div>`),

  frame('P6f', 'An audiobook on a Fold', 'fold media', `<img src="${A}scene4-shot15.png" alt="" style="position:absolute;left:0;top:0;width:984px;height:553px;object-fit:cover;object-position:50% 45%"><div style="position:absolute;left:0;right:0;top:380px;height:174px;background:linear-gradient(to bottom,transparent,var(--media-overlay-bg))"></div><div class="st"></div>${sb(true)}
<div class="ptop" style="left:20px;right:20px">${close}<div class="ttl"><div class="eb">The Tenth Key</div><div class="sc">7 · The Tenth Key</div></div><span class="ib lab glass" style="height:44px;gap:10px;padding:0 10px 0 14px">Slow push<span class="sw sm on"></span></span><span class="ib">${ic('list', 20)}</span><span class="ib">${ic('more', 20)}</span></div>
<div class="fold-words" style="top:688px">Odile did not answer. She held the lamp lower.</div>
<div style="position:absolute;z-index:4;left:172px;width:640px;bottom:64px"><div class="scrub"><i style="width:44%"></i><b style="left:44%"></b></div><div class="times"><span>13:58</span><span>31:40</span></div>
<div class="trow" style="margin-top:16px;justify-content:center;gap:28px"><span class="ib">${ic('prev', 20)}</span><span class="ib">${seek(15)}</span><span class="play">${ic('pause', 24)}</span><span class="ib">${seek(30, false)}</span><span class="ib">${ic('next', 20)}</span></div>
<div class="trow" style="margin-top:16px;justify-content:center;gap:12px">${bookRow2}</div></div>${hi()}`),
];

// Widths per frame class; a frame's card is drawn at its frame's own size.
const size = (f) => f.markup.includes('class="ap fold') ? [984, 1092] : f.markup.includes('class="ap turned') ? [844, 390] : [390, 844];
const withSize = (list) => list.map((f) => ({ ...f, w: size(f)[0], h: size(f)[1] }));

export const FRAMES = { p1: withSize(P1), p2: withSize(P2), p3: withSize(P3), p4: withSize(P4), p5: withSize(P5), p6: withSize(P6) };

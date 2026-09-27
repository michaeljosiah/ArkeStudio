/*
 * The interactive video player (design turn 156): one player for the preview in the app and the
 * exported package. The app imports this module and mounts it over the window; the exporter
 * inlines this file's own text into player.html, so what an author previews is what a viewer
 * gets. That is why it is plain JavaScript with no imports and nothing outside the function:
 * it has to run as it is written, in a page with nothing else on it.
 *
 * Its text is also checked. `interactive-player-source.ts` holds a copy the exporter reads, kept
 * identical by `node scripts/interactive-player-source.mjs`, and the tests read the package for
 * what the brief binds: no timer anywhere (a choice is never made on the viewer's behalf), and
 * playback state that is the viewer's place and nothing more.
 *
 * A scene is clips (an interactive movie) or beats (a visual novel, turn 174): a picture and a
 * line each, read at the viewer's pace. The same rule holds for beats — what moves a beat on by
 * itself is a voice ending or a CSS animation ending, never a timer — and a beat scene's place is
 * the beat's index, kept in the same four fields.
 */

/**
 * @param {HTMLElement} root
 * @param {import("./interactive-player.js").InteractivePlayerOptions} options
 * @returns {import("./interactive-player.js").InteractivePlayerHandle}
 */
export function mountInteractivePlayer(root, options) {
  const doc = root.ownerDocument;
  const win = doc.defaultView || globalThis;
  const KEY = options.storageKey || null;
  const author = options.author || null;
  const scenes = options.scenes;
  const choices = options.choices;
  const endings = Object.fromEntries(options.endings.map((e) => [e.sceneId, e.title]));
  /** Which clips each scene plays, in order; a scene with none plays as a slate. */
  // A clip is a file, or a window into one: the cut plays a shot's trimmed range, and a pass's
  // segment, rather than the whole file it sits in (turn 156g: the preview plays the cut).
  const media = Object.fromEntries(
    Object.keys(scenes).map((id) => [
      id,
      (scenes[id].clips || []).map((c) => (typeof c === "string" ? { src: c, from: 0, to: null } : { src: c.src, from: c.from || 0, to: c.to == null ? null : c.to })),
    ]),
  );
  /** A visual novel's scenes read as beats (turn 174); a scene with beats plays no clips. */
  const beatsOf = (id) => (scenes[id] && Array.isArray(scenes[id].beats) ? scenes[id].beats : []);
  const isBeats = (id) => beatsOf(id).length > 0;
  /** The loaded clip's window in its file: where it starts, and how long it runs once that is known. */
  function span() {
    const c = (media[state.sceneId] || [])[clipIndex];
    const from = c ? c.from : 0;
    const end = c && c.to !== null ? (video.duration ? Math.min(c.to, video.duration) : c.to) : video.duration || 0;
    return { from, length: Math.max(0, end - from) };
  }
  /** Seconds into the loaded clip's window, not into its file. */
  function into() {
    return Math.max(0, (video.currentTime || 0) - span().from);
  }
  const origin = options.from && scenes[options.from] ? options.from : options.start;
  let unwalked = new Set(author ? author.unwalked : []);

  // Playback state only (brief §1, §5): the scene, the position, the route, when. Nothing else
  // exists to persist, by construction.
  let state = { sceneId: origin, positionSec: 0, route: [], updatedAt: new Date().toISOString() };
  let saved = null;
  if (KEY) {
    try {
      saved = JSON.parse(win.localStorage.getItem(KEY) || "null");
    } catch {
      saved = null;
    }
    // A saved scene this package does not contain is ignored rather than played blind.
    if (saved && media[saved.sceneId]) state = saved;
    else saved = null;
  }

  /** What the viewer is looking at; the route panel is drawn over any of them. */
  let mode = author || options.autoplay ? "playing" : "poster";
  let routeOpen = false;
  let clipIndex = 0;
  const durations = [];
  // A beat scene's reading: which beat, whether its line has finished typing on, whether its
  // voice has finished, and whether the viewer asked the beats to move on by themselves (Auto).
  // None of it is kept: the place is the beat's index in `state.positionSec`.
  let beatIndex = 0;
  let typed = false;
  let voiceDone = true;
  // A voice that would not play is not a voice heard: the beat reads as text and waits for the
  // reader, rather than moving on after a breath as if the line had been spoken.
  let voiceFailed = false;
  let auto = false;
  let logOpen = false;
  const still = () => Boolean(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const time = (sec) => {
    const s = Math.max(0, Math.floor(sec || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  const titleOf = (id) => (scenes[id] ? scenes[id].title : id);
  const outOf = (id) => choices.filter((c) => c.from === id);
  const choiceById = (id) => choices.find((c) => c.id === id);
  /** The scenes walked, origin first: the route's vocabulary for evidence (brief §4). */
  const walked = () => [origin].concat(state.route.map((id) => (choiceById(id) || { to: origin }).to));

  const icon = (d, size) =>
    '<svg width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
  const I = {
    play: '<path d="M6 3.8v16.4a1 1 0 0 0 1.5.86l13.2-8.2a1 1 0 0 0 0-1.72L7.5 2.94A1 1 0 0 0 6 3.8z" fill="currentColor"></path>',
    pause: '<rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"></rect><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"></rect>',
    back: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path>',
    volume: '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"></path><path d="M16 9a5 5 0 0 1 0 6"></path><path d="M19.4 18.4a9 9 0 0 0 0-12.8"></path>',
    muted: '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"></path><path d="m22 9-6 6"></path><path d="m16 9 6 6"></path>',
    route: '<line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>',
    full: '<path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>',
    x: '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>',
    undo: '<path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"></path>',
    map: '<rect width="7" height="7" x="3" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="14" rx="1"></rect><path d="M10 6.5h4a3 3 0 0 1 3 3V14"></path>',
    auto: '<path d="m6 17 5-5-5-5"></path><path d="m13 17 5-5-5-5"></path>',
    log: '<path d="M3 12h.01"></path><path d="M3 18h.01"></path><path d="M3 6h.01"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M8 6h13"></path>',
    next: '<path d="m9 18 6-6-6-6"></path>',
  };

  // The picture is the page (turn 156): always dark, whatever the app's theme; the media tokens
  // when the app supplies them, their values when the package stands alone.
  const css = `
.aip{--aip-bg:var(--media-overlay-bg,#0a0a0a);--aip-fg:var(--media-overlay-fg,#fafafa);position:relative;width:100%;height:100%;overflow:hidden;background:var(--aip-bg);color:var(--aip-fg);font-family:var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:14px;line-height:1.4;display:flex;flex-direction:column;outline:none;-webkit-font-smoothing:antialiased}
.aip *{box-sizing:border-box}
.aip button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.aip [hidden]{display:none!important}
.aip-strip{flex:none;height:56px;display:flex;align-items:center;gap:12px;padding:0 16px 0 20px;border-bottom:1px solid color-mix(in srgb,var(--aip-fg) 12%,transparent)}
.aip-strip b{font-weight:500;font-size:15px}
.aip-muted{color:color-mix(in srgb,var(--aip-fg) 62%,transparent)}
.aip-spacer{flex:1}
.aip-stage{position:relative;flex:1;min-height:0;overflow:hidden}
.aip-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:var(--aip-bg)}
.aip-dim{position:absolute;inset:0;background:color-mix(in srgb,var(--aip-bg) 34%,transparent);opacity:0;transition:opacity .4s ease;pointer-events:none}
.aip[data-mode="choice"] .aip-dim,.aip[data-mode="ending"] .aip-dim,.aip[data-mode="poster"] .aip-dim{opacity:1}
.aip-scrim-top{position:absolute;left:0;right:0;top:0;height:168px;background:linear-gradient(to bottom,color-mix(in srgb,var(--aip-bg) 72%,transparent),transparent);pointer-events:none}
.aip-scrim-bot{position:absolute;left:0;right:0;bottom:0;height:300px;background:linear-gradient(to top,color-mix(in srgb,var(--aip-bg) 88%,transparent) 10%,transparent);pointer-events:none}
.aip-top{position:absolute;left:32px;right:32px;top:26px;display:flex;align-items:flex-start;gap:12px}
.aip-eyebrow{font-size:11px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;color:color-mix(in srgb,var(--aip-fg) 68%,transparent)}
.aip-scene{margin-top:5px;font-size:18px;font-weight:600;letter-spacing:-.01em}
.aip-bar{position:absolute;left:32px;right:32px;bottom:20px}
.aip-scrub{position:relative;display:flex;gap:4px;height:14px;align-items:center;margin:0 26px 8px 0;cursor:pointer;border-radius:4px}
.aip-scrub:focus-visible{outline:2px solid color-mix(in srgb,var(--aip-fg) 55%,transparent);outline-offset:4px}
.aip-seg{position:relative;flex:1;height:4px;border-radius:99px;background:color-mix(in srgb,var(--aip-fg) 24%,transparent);overflow:hidden}
.aip-seg>i{position:absolute;left:0;top:0;bottom:0;background:var(--aip-fg);border-radius:99px}
.aip-fork{position:absolute;right:-26px;top:50%;transform:translateY(-50%);display:flex}
.aip-row{display:flex;align-items:center;gap:4px}
.aip-ib{width:40px;height:40px;flex:none;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;position:relative}
.aip-ib:hover,.aip-ib:focus-visible{background:color-mix(in srgb,var(--aip-fg) 12%,transparent)}
.aip-ib>.n{position:absolute;top:3px;right:1px;min-width:16px;height:16px;padding:0 4px;border-radius:99px;background:var(--aip-fg);color:var(--aip-bg);font-size:10px;font-weight:600;line-height:16px;text-align:center}
.aip-time{margin-left:10px;font-weight:500;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--aip-fg) 82%,transparent)}
.aip-chrome{transition:opacity .35s ease}
@keyframes aip-rest{to{opacity:0}}
.aip.aip-wake[data-mode="playing"]:not([data-paused]) .aip-chrome{animation:aip-rest .35s ease 2.5s forwards}
.aip[data-mode="playing"]:not([data-paused]):not(.aip-wake) .aip-chrome{opacity:0}
.aip[data-mode="choice"] .aip-bar,.aip[data-mode="ending"] .aip-bar,.aip[data-mode="poster"] .aip-bar,.aip[data-mode="ending"] .aip-top,.aip[data-mode="poster"] .aip-top{display:none}
.aip-choices{position:absolute;left:0;right:0;bottom:96px;display:flex;justify-content:center;flex-wrap:wrap;gap:16px;padding:14px 32px 8px;max-height:calc(100% - 176px);overflow-y:auto;overscroll-behavior:contain}
.aip-choice{position:relative;width:344px;max-width:100%;height:72px;display:flex!important;align-items:center;gap:14px;padding:0 20px!important;border-radius:16px;background:color-mix(in srgb,var(--aip-bg) 46%,transparent)!important;backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);border:1px solid color-mix(in srgb,var(--aip-fg) 22%,transparent)!important;box-shadow:0 10px 30px color-mix(in srgb,var(--aip-bg) 40%,transparent);font-size:18px!important;font-weight:600!important;letter-spacing:-.01em;text-align:left;animation:aip-rise .4s ease both}
.aip-choice:focus-visible,.aip-choice:hover{background:var(--aip-fg)!important;color:var(--aip-bg)!important;border-color:transparent!important;outline:2px solid color-mix(in srgb,var(--aip-fg) 55%,transparent);outline-offset:4px}
.aip-choice>.k{width:26px;height:26px;flex:none;border-radius:7px;border:1px solid currentColor;opacity:.6;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:500}
.aip-choice>.l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aip-chip{position:absolute;top:-11px;right:16px;height:22px;padding:0 9px;border-radius:99px;display:inline-flex;align-items:center;font-size:11px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;background:var(--aip-bg);color:var(--aip-fg);border:1px solid color-mix(in srgb,var(--aip-fg) 30%,transparent)}
@keyframes aip-rise{from{opacity:0;transform:translateY(14px)}}
.aip-under{position:absolute;left:0;right:0;bottom:36px;display:flex;justify-content:center}
.aip-ghost{height:36px;padding:0 14px!important;border-radius:999px;display:inline-flex!important;align-items:center;gap:7px;font-weight:500;color:color-mix(in srgb,var(--aip-fg) 80%,transparent)!important}
.aip-ghost:hover,.aip-ghost:focus-visible{color:var(--aip-fg)!important;background:color-mix(in srgb,var(--aip-fg) 10%,transparent)!important}
.aip-btn{height:44px;padding:0 20px!important;border-radius:999px;display:inline-flex!important;align-items:center;justify-content:center;gap:8px;font-weight:500!important;font-size:15px!important;white-space:nowrap;border:1px solid color-mix(in srgb,var(--aip-fg) 18%,transparent)!important;background:color-mix(in srgb,var(--aip-bg) 42%,transparent)!important;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.aip-btn.primary{background:var(--aip-fg)!important;color:var(--aip-bg)!important;border-color:transparent!important}
.aip-btn.small{height:32px;padding:0 13px!important;font-size:13px!important}
.aip-hero{position:absolute;left:72px;right:72px;bottom:80px;background:none;max-height:calc(100% - 128px);overflow-y:auto;overscroll-behavior:contain;padding-top:6px}
.aip-hero-title{margin-top:10px;font-size:48px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.aip-hero-actions{margin-top:28px;display:flex;flex-wrap:wrap;gap:10px}
.aip-poster-back{position:absolute;inset:0;background:linear-gradient(to right,color-mix(in srgb,var(--aip-bg) 90%,transparent) 18%,color-mix(in srgb,var(--aip-bg) 40%,transparent) 62%,transparent)}
.aip-place{margin-top:14px;display:flex;align-items:center;gap:12px;font-weight:500;color:color-mix(in srgb,var(--aip-fg) 72%,transparent)}
.aip-place>i{width:120px;height:3px;border-radius:99px;background:color-mix(in srgb,var(--aip-fg) 22%,transparent);overflow:hidden;display:block}
.aip-place>i>b{display:block;height:100%;background:var(--aip-fg)}
.aip-trail{margin-top:24px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;color:color-mix(in srgb,var(--aip-fg) 72%,transparent)}
.aip-trail>b{padding:6px 12px;border-radius:8px;background:color-mix(in srgb,var(--aip-fg) 10%,transparent);color:var(--aip-fg);font-weight:500}
.aip-trail>b:last-child{outline:2px solid var(--aip-fg);outline-offset:2px}
.aip-slate{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding-bottom:140px;text-align:center;background:radial-gradient(ellipse at 50% 38%,color-mix(in srgb,var(--aip-fg) 7%,transparent),transparent 62%)}
.aip-slate-title{margin-top:10px;font-size:36px;font-weight:600;letter-spacing:-.02em}
.aip-panel{position:absolute;top:16px;right:16px;bottom:16px;width:420px;max-width:calc(100% - 32px);border-radius:20px;padding:18px 14px 16px;display:flex;flex-direction:column;background:color-mix(in srgb,var(--aip-bg) 70%,transparent);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);border:1px solid color-mix(in srgb,var(--aip-fg) 16%,transparent);box-shadow:0 20px 50px color-mix(in srgb,var(--aip-bg) 50%,transparent)}
.aip-panel-head{display:flex;align-items:center;padding:0 6px 14px 12px;font-size:18px;font-weight:600}
.aip-panel-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px}
.aip-stop{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px}
.aip-stop.now{background:color-mix(in srgb,var(--aip-fg) 9%,transparent)}
.aip-stop>.n{width:22px;flex:none;font-size:12px;font-weight:500;color:color-mix(in srgb,var(--aip-fg) 60%,transparent)}
.aip-stop>.t{flex:1;min-width:0;font-weight:500;font-size:15px}
.aip-tag{height:22px;padding:0 9px;border-radius:99px;display:inline-flex;align-items:center;background:var(--aip-fg);color:var(--aip-bg);font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.aip-way{display:flex;align-items:center;gap:10px;padding:2px 12px 2px 46px;color:color-mix(in srgb,var(--aip-fg) 78%,transparent)}
.aip-way>span{flex:1;min-width:0;font-weight:500}
.aip-panel-foot{display:flex;gap:8px;padding:14px 6px 0 12px;border-top:1px solid color-mix(in srgb,var(--aip-fg) 14%,transparent)}
.aip-kbd{min-width:22px;height:20px;padding:0 5px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;border:1px solid color-mix(in srgb,var(--aip-fg) 30%,transparent)}
.aip-pic{position:absolute;inset:0;overflow:hidden;background:var(--aip-bg)}
.aip-pic>img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transform-origin:50% 45%}
.aip-pic>img.m-push{animation:aip-push 14s ease-out both}
.aip-pic>img.m-drift{animation:aip-drift 16s ease-in-out both}
@keyframes aip-push{from{transform:scale(1)}to{transform:scale(1.08)}}
@keyframes aip-drift{from{transform:scale(1.06) translateX(-2%)}to{transform:scale(1.06) translateX(2%)}}
.aip-beatbar{display:none;align-items:center;gap:2px}
.aip[data-kind="beats"] .aip-beatbar{display:flex}
.aip[data-kind="beats"] .aip-bar{display:none}
.aip-pill{height:40px;padding:0 14px 0 12px!important;border-radius:999px;display:inline-flex!important;align-items:center;gap:7px;font-weight:500}
.aip-pill:hover,.aip-pill:focus-visible,.aip-pill[aria-pressed="true"]{background:color-mix(in srgb,var(--aip-fg) 14%,transparent)!important}
.aip-box{position:absolute;left:50%;transform:translateX(-50%);bottom:40px;width:880px;max-width:calc(100% - 48px);min-height:128px;padding:26px 34px;border-radius:18px;background:color-mix(in srgb,var(--aip-bg) 52%,transparent);backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);border:1px solid color-mix(in srgb,var(--aip-fg) 20%,transparent);box-shadow:0 20px 50px color-mix(in srgb,var(--aip-bg) 40%,transparent)}
.aip[data-mode="ending"] .aip-box,.aip[data-mode="poster"] .aip-box{display:none}
.aip-who{position:absolute;left:28px;top:-15px;height:30px;padding:0 14px;border-radius:999px;display:inline-flex;align-items:center;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;background:var(--aip-fg);color:var(--aip-bg)}
.aip-line{font-size:24px;line-height:1.45;letter-spacing:-.01em;text-wrap:pretty}
.aip-box[data-kind="narration"] .aip-line{font-style:italic;color:color-mix(in srgb,var(--aip-fg) 90%,transparent)}
.aip-line>span{animation:aip-word .2s ease both}
.aip-box[data-typed] .aip-line>span{animation:none}
@keyframes aip-word{from{opacity:0}}
.aip-more{position:absolute;right:22px;bottom:14px;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:color-mix(in srgb,var(--aip-fg) 70%,transparent)}
.aip-ticks{position:absolute;left:50%;transform:translateX(-50%);bottom:14px;display:flex;gap:5px}
.aip-ticks>i{width:18px;height:3px;border-radius:99px;background:color-mix(in srgb,var(--aip-fg) 24%,transparent)}
.aip-ticks>i.done{background:var(--aip-fg)}
.aip[data-mode="ending"] .aip-ticks,.aip[data-mode="poster"] .aip-ticks{display:none}
.aip-hold{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
@keyframes aip-hold{from{opacity:0}to{opacity:.01}}
.aip[data-kind="beats"] .aip-choices{bottom:250px;max-height:calc(100% - 330px)}
.aip[data-kind="beats"] .aip-under{bottom:198px}
.aip-log-line{position:relative;padding:10px 44px 10px 12px;border-radius:12px}
.aip-log-line.now{background:color-mix(in srgb,var(--aip-fg) 12%,transparent)}
.aip-log-line>.w{font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:color-mix(in srgb,var(--aip-fg) 64%,transparent)}
.aip-log-line>.t{margin-top:3px;font-size:14px;line-height:1.5}
.aip-log-line.narration>.t{font-style:italic;margin-top:0}
.aip-log-line>button{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:28px;height:28px;border-radius:99px;display:inline-flex!important;align-items:center;justify-content:center;border:1px solid color-mix(in srgb,var(--aip-fg) 30%,transparent)!important}
@media (prefers-reduced-motion:reduce){.aip-pic>img{animation:none!important}.aip-line>span{animation:none}}
@media (max-width:640px){
.aip-top{left:20px;right:14px;top:20px}
.aip-bar{left:16px;right:16px}
.aip-choices{flex-direction:column;flex-wrap:nowrap;align-items:stretch;bottom:74px;padding:14px 16px 8px;gap:10px;max-height:calc(100% - 136px)}
.aip-choice{width:100%;height:58px;border-radius:14px}
.aip-hero{left:24px;right:24px;bottom:48px;max-height:calc(100% - 88px)}
.aip-hero-title{font-size:32px}
.aip-strip .aip-muted,.aip-strip .t,.aip-strip .aip-kbd{display:none}
.aip-strip{gap:8px;padding:0 10px 0 14px}
.aip-strip>span:not(.aip-spacer){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aip-strip .aip-btn{flex:none}
.aip-box{left:12px;right:12px;transform:none;width:auto;max-width:none;bottom:42px;min-height:0;padding:22px 20px 30px}
.aip-who{left:18px}
.aip-line{font-size:18px}
.aip-ticks{bottom:24px}
.aip-top{flex-wrap:wrap;row-gap:6px}
.aip[data-kind="beats"] .aip-top>div:first-child{flex:1 1 100%!important}
.aip-beatbar .t{display:none}
.aip[data-kind="beats"] .aip-choices{bottom:210px;max-height:calc(100% - 290px)}
.aip[data-kind="beats"] .aip-under{bottom:160px}
}
`;

  root.classList.add("aip");
  root.tabIndex = 0;
  root.innerHTML =
    "<style>" + css + "</style>" +
    (author ? '<div class="aip-strip" data-ref="strip"></div>' : "") +
    '<div class="aip-stage">' +
    '<video class="aip-video" data-ref="video" playsinline preload="auto"></video>' +
    '<div class="aip-pic" data-ref="pic" hidden><img data-ref="img" alt=""></div>' +
    '<audio data-ref="voice" preload="auto"></audio><audio data-ref="logVoice" preload="auto"></audio>' +
    '<div class="aip-slate" data-ref="slate" hidden></div>' +
    '<div class="aip-dim"></div>' +
    '<div class="aip-scrim-top aip-chrome"></div>' +
    '<div class="aip-top aip-chrome"><div style="flex:1;min-width:0"><div class="aip-eyebrow" data-ref="eyebrow"></div><div class="aip-scene" data-ref="scene"></div></div>' +
    '<div class="aip-beatbar">' +
    '<button type="button" class="aip-pill" data-act="auto" data-ref="autoBtn" aria-pressed="false">' + icon(I.auto, 16) + '<span class="t">Auto</span></button>' +
    '<button type="button" class="aip-pill" data-act="log" data-ref="logBtn" aria-pressed="false">' + icon(I.log, 16) + '<span class="t">Log</span></button>' +
    '<button type="button" class="aip-pill" data-act="route" aria-label="Route">' + icon(I.route, 16) + '<span class="t">Route</span></button>' +
    '<button type="button" class="aip-ib" data-act="mute" data-ref="beatMute" aria-label="Mute"></button>' +
    '<button type="button" class="aip-ib" data-act="full" aria-label="Full screen">' + icon(I.full) + "</button>" +
    "</div></div>" +
    '<div class="aip-scrim-bot aip-chrome"></div>' +
    '<div class="aip-bar aip-chrome" data-ref="bar">' +
    '<div class="aip-scrub" data-ref="scrub" role="slider" tabindex="0" aria-label="Position in this scene" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div>' +
    '<div class="aip-row">' +
    '<button type="button" class="aip-ib" data-act="toggle" data-ref="toggle" aria-label="Play"></button>' +
    '<button type="button" class="aip-ib" data-act="back" aria-label="Back 10 seconds">' + icon(I.back) + "</button>" +
    '<button type="button" class="aip-ib" data-act="mute" data-ref="mute" aria-label="Mute"></button>' +
    '<span class="aip-time" data-ref="time"></span><span class="aip-spacer"></span>' +
    '<button type="button" class="aip-ib" data-act="route" data-ref="routeBtn" aria-label="Route"></button>' +
    '<button type="button" class="aip-ib" data-act="full" aria-label="Full screen">' + icon(I.full) + "</button>" +
    "</div></div>" +
    '<div class="aip-box" data-ref="box" hidden><span class="aip-who" data-ref="who" hidden></span><div class="aip-line" data-ref="line" aria-live="polite"></div><span class="aip-more" data-ref="more"></span></div>' +
    '<div class="aip-ticks" data-ref="ticks"></div><div class="aip-hold" data-ref="hold"></div>' +
    '<div class="aip-choices" data-ref="choices" role="group" aria-label="Choices"></div>' +
    '<div class="aip-under" data-ref="under"></div>' +
    '<div data-ref="hero"></div>' +
    '<div class="aip-panel" data-ref="panel" role="dialog" aria-label="Route" hidden></div>' +
    '<div class="aip-panel" data-ref="log" role="dialog" aria-label="Log" hidden></div>' +
    "</div>";

  const ref = (name) => root.querySelector('[data-ref="' + name + '"]');
  const video = ref("video");
  const choicesEl = ref("choices");
  const el = {
    strip: ref("strip"), slate: ref("slate"), eyebrow: ref("eyebrow"), scene: ref("scene"), scrub: ref("scrub"),
    toggle: ref("toggle"), mute: ref("mute"), time: ref("time"), routeBtn: ref("routeBtn"), under: ref("under"),
    hero: ref("hero"), panel: ref("panel"),
    pic: ref("pic"), img: ref("img"), box: ref("box"), who: ref("who"), line: ref("line"), more: ref("more"),
    ticks: ref("ticks"), hold: ref("hold"), log: ref("log"), autoBtn: ref("autoBtn"), logBtn: ref("logBtn"), beatMute: ref("beatMute"),
  };
  const voice = ref("voice");
  const logVoice = ref("logVoice");

  function save() {
    state.updatedAt = new Date().toISOString();
    if (!KEY) return;
    try {
      win.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // A viewer who blocks storage still watches; they just start again next time.
    }
  }

  /** Chrome shows on any movement and rests after stillness, by CSS alone — no timer here. */
  function wake() {
    root.classList.remove("aip-wake");
    void root.offsetWidth;
    root.classList.add("aip-wake");
  }

  function play(sceneId, positionSec) {
    state.sceneId = sceneId;
    state.positionSec = positionSec || 0;
    save();
    mode = "playing";
    clipIndex = 0;
    durations.length = 0;
    if (isBeats(sceneId)) {
      // A beat scene plays no footage: the video is let go, and the place is a beat's index.
      video.pause && video.pause();
      video.removeAttribute("src");
      if (state.positionSec < 0) {
        // Saved at its choice or ending: the last beat's picture and line, without its voice.
        showBeat(beatsOf(sceneId).length - 1, true);
        finishScene();
        return;
      }
      showBeat(Math.min(Math.floor(state.positionSec), beatsOf(sceneId).length - 1));
      render();
      holdFocus();
      return;
    }
    const clips = media[sceneId] || [];
    if (state.positionSec < 0 && clips.length > 0) {
      // A place saved at a choice or an ending: the scene was watched to its end, so the viewer
      // returns to that moment — its last frame held, its choices or its ending — not its start.
      loadClip(clips.length - 1, 0, 1, false);
      finishScene();
      return;
    }
    if (clips.length === 0) {
      // No footage (preview only; an export refuses such a scene): the title card, and the
      // choices at once, so the route still walks.
      video.removeAttribute("src");
      finishScene();
      return;
    }
    loadClip(0, state.positionSec, undefined, undefined, true);
    render();
    holdFocus();
  }

  /**
   * A re-render replaces the button that was pressed — a choice, Replay, Continue — and focus
   * went with it, out of the player: its keys stopped working, and in the app's modal preview
   * the next Tab reached the map behind it. Focus comes back to the player itself.
   */
  function holdFocus() {
    const at = doc.activeElement;
    if (!at || at === doc.body || !root.contains(at)) root.focus();
  }

  /** The beat being read. */
  const beat = () => beatsOf(state.sceneId)[beatIndex] || {};

  /**
   * Show one beat: its picture (kept, not restarted, when the next beat shares it), its line typing
   * on word by word, and its voice. `quiet` shows it without its voice — a place reopened at the
   * scene's choice, or a choice point returned to.
   */
  function showBeat(index, quiet) {
    stopHold();
    logVoice.pause && logVoice.pause();
    const beats = beatsOf(state.sceneId);
    beatIndex = Math.max(0, Math.min(index, beats.length - 1));
    if (!quiet) {
      state.positionSec = beatIndex;
      save();
    }
    const b = beat();
    if (!b.picture) {
      // A beat with no picture shows none: holding the last one would preview an unfinished
      // scene as though it chose to keep it (a kept picture arrives as that picture's path).
      el.img.removeAttribute("src");
      el.img.className = "";
    } else {
      const motion = still() ? "none" : b.motion || "push";
      // A new picture starts its movement; one the beat keeps from the beat before (`keep`: a
      // shot's second line, or a shot asking for the same picture) goes on moving. Two shots that
      // merely show the same file each move as their own. The poster's picture was set still, so
      // it starts moving when reading begins.
      if (el.img.getAttribute("src") !== b.picture || !b.keep || el.img.className === "") {
        el.img.setAttribute("src", b.picture);
        el.img.className = "";
        void el.img.offsetWidth;
        el.img.className = "m-" + motion;
      }
    }
    // One span a word, each a little after the last, so the line types on by CSS alone; the
    // last one's animation ending is when it has finished.
    const words = String(b.text || "").split(/(\s+)/);
    let n = 0;
    el.line.innerHTML = words.map((w) => (/^\s+$/.test(w) || w === "" ? esc(w) : '<span style="animation-delay:' + (n++ * 0.05).toFixed(2) + 's">' + esc(w) + "</span>")).join("");
    typed = n === 0 || still();
    if (typed) el.box.setAttribute("data-typed", "");
    else el.box.removeAttribute("data-typed");
    voice.pause && voice.pause();
    voiceFailed = false;
    if (b.audio && !quiet) {
      voiceDone = false;
      voice.setAttribute("src", b.audio);
      const p = voice.play && voice.play();
      // A voice the browser will not start (no gesture yet, a missing file) is read as text.
      if (p && p.catch) p.catch(() => voiceLost());
    } else {
      voiceDone = true;
      voice.removeAttribute("src");
    }
    renderBeat();
    schedule(true);
  }

  /**
   * What moves this beat on by itself, if anything: a hold, from when it shows; after its voice, a
   * beat's breath once the voice ends; and with Auto on, the same breath, or a reading time for a
   * line with no voice. Otherwise it waits for the reader. Each is a CSS animation on one hidden
   * element whose end is the signal — the player keeps no timer.
   */
  function schedule(shown) {
    if (mode !== "playing" || !isBeats(state.sceneId)) return;
    const b = beat();
    const advance = b.advance || "tap";
    if (advance === "hold") {
      if (shown) startHold(b.holdSec || 4);
      return;
    }
    if (!voiceDone) return;
    const heard = Boolean(b.audio) && !voiceFailed;
    if (heard && (advance === "voice" || auto)) startHold(1.2);
    else if (auto) startHold(Math.min(12, 1.5 + String(b.text || "").split(/\s+/).filter(Boolean).length * 0.3));
  }
  function startHold(sec) {
    el.hold.style.animation = "none";
    void el.hold.offsetWidth;
    el.hold.setAttribute("data-beat", state.sceneId + "#" + beatIndex);
    el.hold.style.animation = "aip-hold " + sec + "s linear forwards";
  }
  function stopHold() {
    el.hold.style.animation = "none";
    el.hold.removeAttribute("data-beat");
  }
  function voiceEnded() {
    if (voiceDone) return;
    voiceDone = true;
    schedule(false);
  }
  function voiceLost() {
    if (voiceDone) return;
    voiceFailed = true;
    voiceEnded();
  }

  /** A tap, a key: the rest of the line if it is still typing on, else the next beat. */
  function advanceBeat() {
    if (!typed) {
      typed = true;
      el.box.setAttribute("data-typed", "");
      renderBeat();
      return;
    }
    nextBeat();
  }
  function nextBeat() {
    const beats = beatsOf(state.sceneId);
    if (beatIndex < beats.length - 1) {
      showBeat(beatIndex + 1);
      return;
    }
    stopHold();
    voice.pause && voice.pause();
    finishScene();
  }
  /** Back one beat, within the scene: a choice already made is changed from the route, not here. */
  function previousBeat() {
    if (beatIndex > 0) showBeat(beatIndex - 1);
  }

  function renderBeat() {
    const beats = beatsOf(state.sceneId);
    const b = beat();
    const who = b.speaker ? String(b.speaker) : "";
    el.who.hidden = who === "";
    el.who.textContent = who;
    el.box.setAttribute("data-kind", b.text ? (who ? "dialogue" : "narration") : "picture");
    // A beat with no line is the picture alone: the box steps aside for it.
    el.box.hidden = !isBeats(state.sceneId) || !b.text;
    el.more.innerHTML = mode === "playing" && typed ? "tap " + icon(I.next, 14) : "";
    el.ticks.innerHTML = beats.length > 1 ? beats.map((_, i) => '<i class="' + (i <= beatIndex ? "done" : "") + '"></i>').join("") : "";
    el.autoBtn.setAttribute("aria-pressed", auto ? "true" : "false");
    el.logBtn.setAttribute("aria-pressed", logOpen ? "true" : "false");
    el.beatMute.innerHTML = icon(voice.muted ? I.muted : I.volume);
    el.beatMute.setAttribute("aria-label", voice.muted ? "Unmute" : "Mute");
    renderLog();
  }

  /** The scene's lines so far, each with its voice to hear again; it is a view, and moves nothing on. */
  function renderLog() {
    el.log.hidden = !logOpen || !isBeats(state.sceneId);
    if (el.log.hidden) {
      const at = doc.activeElement;
      if (at && el.log.contains(at)) root.focus();
      return;
    }
    const lines = beatsOf(state.sceneId).slice(0, beatIndex + 1).map((b, i) => ({ b, i })).filter((x) => x.b.text);
    el.log.innerHTML =
      '<div class="aip-panel-head"><span style="flex:1">Log</span><span class="aip-kbd">L</span><button type="button" class="aip-ib" data-act="log" aria-label="Close">' + icon(I.x) + "</button></div>" +
      '<div class="aip-panel-list">' +
      lines.map((x) =>
        '<div class="aip-log-line' + (x.b.speaker ? "" : " narration") + (x.i === beatIndex ? " now" : "") + '">' +
        (x.b.speaker ? '<div class="w">' + esc(x.b.speaker) + "</div>" : "") + '<div class="t">' + esc(x.b.text) + "</div>" +
        (x.b.audio ? '<button type="button" data-line="' + x.i + '" aria-label="Play line">' + icon(I.play, 11) + "</button>" : "") + "</div>").join("") +
      "</div>";
  }

  /** Load one of the scene's clips and seek into it: to `at` seconds, or to `ratio` of its length once known. */
  function loadClip(index, at, ratio, autoplay, carry) {
    const clips = media[state.sceneId] || [];
    clipIndex = Math.max(0, Math.min(index, clips.length - 1));
    // A place saved across a scene (`carry`) that runs past this shot goes on into the next —
    // without looking, when the shot's length is already known, else once it loads.
    const known = lengthOf(clipIndex);
    if (carry && ratio === undefined && known !== undefined && at >= known && clipIndex < clips.length - 1) {
      loadClip(clipIndex + 1, at - known, undefined, autoplay, true);
      return;
    }
    video.setAttribute("src", clips[clipIndex].src);
    const seek = () => {
      const { from, length } = span();
      if (carry && ratio === undefined && length && at >= length && clipIndex < clips.length - 1) {
        video.removeEventListener("loadedmetadata", seek);
        loadClip(clipIndex + 1, at - length, undefined, autoplay, true);
        return;
      }
      const wanted = ratio !== undefined && length ? ratio * length : at;
      // Clamped, not refused: a place saved against a longer take (a re-export keeps the key
      // while the routing is unchanged) resumes near this take's end rather than at its start.
      const target = from + (length ? Math.max(0, Math.min(length - 0.05, wanted)) : wanted);
      if (target > 0) video.currentTime = target;
      video.removeEventListener("loadedmetadata", seek);
    };
    video.addEventListener("loadedmetadata", seek);
    if (autoplay === false) return;
    const started = video.play && video.play();
    if (started && started.catch) started.catch(() => render());
  }

  /** The scene has ended: its choices, or its ending, or a dead end the preview names. */
  function finishScene() {
    const options = outOf(state.sceneId);
    mode = options.length > 0 ? "choice" : "ending";
    // Saved as "over" (-1), so a return visit reopens this choice or ending rather than replaying
    // the scene from its start.
    state.positionSec = -1;
    save();
    render();
    if (mode === "choice") choicesEl.querySelector("button")?.focus();
    else root.focus();
  }

  function choose(choice) {
    if (author && author.onChoice) author.onChoice(choice, walked());
    state.route = state.route.concat([choice.id]);
    unwalked.delete(choice.id);
    play(choice.to, 0);
  }

  /** Back to the choice point a past choice was made at, dropping the route after it. */
  function chooseAgain(index) {
    const choice = choiceById(state.route[index]);
    if (!choice) return;
    state.route = state.route.slice(0, index);
    state.sceneId = choice.from;
    routeOpen = false;
    video.pause && video.pause();
    // The choice point is shown over its own scene's last frame, not the later scene's.
    const clips = media[choice.from] || [];
    if (isBeats(choice.from)) {
      voice.pause && voice.pause();
      showBeat(beatsOf(choice.from).length - 1, true);
    } else if (clips.length > 0) loadClip(clips.length - 1, 0, 1, false);
    else video.removeAttribute("src");
    finishScene();
  }

  function startAgain() {
    state.route = [];
    routeOpen = false;
    play(origin, 0);
  }

  function renderChoices() {
    const options = mode === "choice" ? outOf(state.sceneId) : [];
    choicesEl.innerHTML = options
      .map((c, i) =>
        '<button type="button" class="aip-choice" data-choice="' + esc(c.id) + '"><span class="k">' + (i + 1) + '</span><span class="l">' + esc(c.label) + "</span>" +
        (author && unwalked.has(c.id) ? '<span class="aip-chip">not walked</span>' : "") + "</button>")
      .join("");
    el.under.innerHTML = mode === "choice" && ((media[state.sceneId] || []).length > 0 || isBeats(state.sceneId))
      ? '<button type="button" class="aip-ghost" data-act="replay">' + icon(I.back, 15) + "Replay scene</button>"
      : "";
  }

  function renderHero() {
    if (mode === "poster") {
      const resume = saved !== null;
      const over = resume && saved.positionSec < 0;
      // The place is across the whole scene, so the bar is too: over every shot's length, once
      // they are all known, not the first shot's alone, which read as done midway through.
      const count = (media[state.sceneId] || []).length;
      let total = 0;
      for (let i = 0; i < count && total !== null; i++) {
        const length = lengthOf(i);
        total = length === undefined ? null : total + length;
      }
      // A beat scene's place is a beat, so its bar is beats read of the scene's beats.
      const beatCount = resume ? beatsOf(saved.sceneId).length : 0;
      const pct = over ? 100 : resume && beatCount > 0 ? Math.min(100, (100 * (saved.positionSec + 1)) / beatCount) : resume && total ? Math.min(100, (100 * saved.positionSec) / total) : 0;
      el.hero.innerHTML =
        '<div class="aip-poster-back"></div><div class="aip-hero">' +
        (options.eyebrow ? '<div class="aip-eyebrow">' + esc(options.eyebrow) + "</div>" : "") +
        '<div class="aip-hero-title">' + esc(options.title) + '</div><div class="aip-hero-actions">' +
        (resume
          ? '<button type="button" class="aip-btn primary" data-act="continue">' + icon(I.play, 16) + 'Continue</button><button type="button" class="aip-btn" data-act="restart">' + icon(I.back, 16) + "Start over</button>"
          : '<button type="button" class="aip-btn primary" data-act="restart">' + icon(I.play, 16) + "Play</button>") +
        "</div>" +
        (resume ? '<div class="aip-place"><i><b style="width:' + pct + '%"></b></i>' + esc(titleOf(saved.sceneId)) + " · " + (over ? (endings[saved.sceneId] !== undefined ? "the ending" : "the choice") : beatCount > 0 ? "beat " + (Math.floor(saved.positionSec) + 1) + " of " + beatCount : time(saved.positionSec)) + "</div>" : "") +
        "</div>";
      return;
    }
    if (mode === "ending") {
      const ending = endings[state.sceneId];
      const trail = walked();
      el.hero.innerHTML =
        '<div class="aip-poster-back"></div><div class="aip-hero">' +
        '<div class="aip-eyebrow">' + (ending !== undefined ? "Ending" : "No choices from here") + "</div>" +
        '<div class="aip-hero-title">' + esc(ending !== undefined ? ending : titleOf(state.sceneId)) + "</div>" +
        (trail.length > 1
          ? '<div class="aip-trail">' + trail.map((id, i) => (i > 0 ? "<span>→ " + esc((choiceById(state.route[i - 1]) || { label: "" }).label) + " →</span>" : "") + "<b>" + esc(titleOf(id)) + "</b>").join("") + "</div>"
          : "") +
        '<div class="aip-hero-actions"><button type="button" class="aip-btn primary" data-act="restart">' + icon(I.back, 16) + "Start again</button>" +
        (state.route.length > 0 ? '<button type="button" class="aip-btn" data-act="last">' + icon(I.undo, 16) + "Back to last choice</button>" : "") +
        "</div></div>";
      return;
    }
    el.hero.innerHTML = "";
  }

  function renderPanel() {
    el.panel.hidden = !routeOpen;
    if (!routeOpen) {
      // Closed from its own Close button (or a key pressed inside it), the panel hid the control
      // that had focus, and focus left the player: its keys went dead and Tab escaped the preview.
      const at = doc.activeElement;
      if (at && el.panel.contains(at)) root.focus();
      return;
    }
    const trail = walked();
    let list = "";
    trail.forEach((id, i) => {
      const now = i === trail.length - 1;
      list += '<div class="aip-stop' + (now ? " now" : "") + '"><span class="n">' + (i + 1) + '</span><span class="t">' + esc(titleOf(id)) + "</span>" + (now ? '<span class="aip-tag">Playing</span>' : "") + "</div>";
      if (i < state.route.length) {
        const c = choiceById(state.route[i]);
        list += '<div class="aip-way">' + icon(I.route, 14) + "<span>" + esc(c ? c.label : "") + '</span><button type="button" class="aip-btn small" data-again="' + i + '">Choose again</button></div>';
      }
    });
    el.panel.innerHTML =
      '<div class="aip-panel-head"><span style="flex:1">Route</span><button type="button" class="aip-ib" data-act="route" aria-label="Close">' + icon(I.x) + "</button></div>" +
      '<div class="aip-panel-list">' + list + "</div>" +
      '<div class="aip-panel-foot"><button type="button" class="aip-btn small" data-act="restart">' + icon(I.back, 15) + "Start over</button></div>";
  }

  function renderStrip() {
    if (!el.strip) return;
    el.strip.innerHTML =
      "<b>Preview</b><span class=\"aip-muted\">from " + esc(titleOf(origin)) + '</span><span class="aip-spacer"></span>' +
      (unwalked.size > 0 ? "<span>" + unwalked.size + " choice" + (unwalked.size === 1 ? "" : "s") + " not walked</span>" : '<span class="aip-muted">every choice walked</span>') +
      (author.onBranchMap ? '<button type="button" class="aip-btn small" data-act="map" aria-label="Branch map">' + icon(I.map, 15) + '<span class="t">Branch map</span></button>' : "") +
      (author.onClose ? '<button type="button" class="aip-btn small" data-act="close" aria-label="Close preview">' + icon(I.x, 15) + '<span class="t">Close preview</span> <span class="aip-kbd">Esc</span></button>' : "");
  }

  function renderBar() {
    const clips = media[state.sceneId] || [];
    const paused = video.paused !== false;
    el.toggle.innerHTML = icon(paused ? I.play : I.pause, 20);
    el.toggle.setAttribute("aria-label", paused ? "Play" : "Pause");
    el.mute.innerHTML = icon(video.muted ? I.muted : I.volume);
    el.mute.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
    el.routeBtn.innerHTML = icon(I.route) + (state.route.length > 0 ? '<span class="n">' + (state.route.length + 1) + "</span>" : "");
    const d = span().length;
    const at = into();
    const ratio = d > 0 ? Math.min(1, at / d) : 0;
    el.scrub.innerHTML =
      clips.map((_, i) => '<span class="aip-seg"><i style="width:' + (i < clipIndex ? 100 : i === clipIndex ? ratio * 100 : 0) + '%"></i></span>').join("") +
      (outOf(state.sceneId).length > 0 ? '<span class="aip-fork" title="Choices at the end">' + icon(I.route, 16) + "</span>" : "");
    // The slider is the whole scene, its shots in turn — not the one shot loaded, which read as
    // the scene starting over at every cut.
    el.scrub.setAttribute("aria-valuenow", String(Math.round((100 * (clipIndex + ratio)) / Math.max(1, clips.length))));
    el.scrub.setAttribute("aria-valuetext", (clips.length > 1 ? "Shot " + (clipIndex + 1) + " of " + clips.length + ", " : "") + time(at) + " of " + time(d));
    el.time.textContent = (clips.length > 1 ? "Shot " + (clipIndex + 1) + " of " + clips.length + " · " : "") + time(at) + " / " + time(d);
    if (paused) root.setAttribute("data-paused", "");
    else root.removeAttribute("data-paused");
  }

  function render() {
    root.setAttribute("data-mode", mode);
    el.eyebrow.textContent = options.title;
    el.scene.textContent = titleOf(state.sceneId);
    const beats = isBeats(state.sceneId);
    root.setAttribute("data-kind", beats ? "beats" : "clips");
    const slate = !beats && (media[state.sceneId] || []).length === 0 && mode !== "poster" && mode !== "ending";
    el.slate.hidden = !slate;
    el.slate.innerHTML = slate ? '<div class="aip-eyebrow">' + esc(options.title) + '</div><div class="aip-slate-title">' + esc(titleOf(state.sceneId)) + '</div><div class="aip-muted" style="margin-top:12px">No accepted take</div>' : "";
    video.hidden = slate || beats;
    el.pic.hidden = !beats;
    if (beats && mode === "poster" && !el.img.getAttribute("src")) {
      // The poster is the saved beat's picture, or the scene's first, held still.
      const at = saved && saved.positionSec >= 0 ? Math.floor(saved.positionSec) : saved ? beatsOf(state.sceneId).length - 1 : 0;
      const b = beatsOf(state.sceneId)[at] || beatsOf(state.sceneId)[0];
      if (b && b.picture) el.img.setAttribute("src", b.picture);
    }
    if (beats) renderBeat();
    else el.box.hidden = true;
    renderBar();
    renderChoices();
    renderHero();
    renderPanel();
    renderStrip();
  }

  const onTime = () => {
    // Only playing moves the place: a seek to a held last frame must not overwrite "over".
    if (mode !== "playing") return;
    // A window that ends before its file does ends here: a trimmed take, or one pass segment of
    // several, would otherwise run on into footage the cut replaced.
    const c = (media[state.sceneId] || [])[clipIndex];
    if (c && c.to !== null && (video.currentTime || 0) >= c.to - 0.02) {
      // Held at the window's end: on the last shot the choices open here, and the file's tail
      // must not go on playing behind them.
      if (video.pause) video.pause();
      onEnded();
      return;
    }
    // The place in the scene, not in this shot: saved as the shot's offset, a return visit put it
    // that far into the first shot instead. Shots before this one have played, so their lengths are known.
    let before = 0;
    for (let i = 0; i < clipIndex; i++) before += lengthOf(i) || 0;
    state.positionSec = before + into();
    save();
    renderBar();
  };
  const onMeta = () => {
    durations[clipIndex] = span().length;
    renderBar();
    if (mode === "poster") renderHero();
  };
  const onEnded = () => {
    // Once per clip: a window's end is caught on timeupdate, and the file's own ended can follow.
    if (mode !== "playing") return;
    const clips = media[state.sceneId] || [];
    if (clipIndex < clips.length - 1) {
      loadClip(clipIndex + 1, 0);
      renderBar();
    } else finishScene();
  };
  // A clip that will not load or decode never ends; it is passed over as if it had, so the
  // scene still reaches its choices — the author's walk and the viewer's route go on.
  const onError = () => {
    if (mode === "playing") onEnded();
  };
  const onPlayState = () => renderBar();

  function toggle() {
    if (mode !== "playing") return;
    if (video.paused) {
      const p = video.play && video.play();
      if (p && p.catch) p.catch(() => undefined);
    } else video.pause();
  }
  /** A shot's length, when it is known: played already, or a window with both ends. */
  function lengthOf(index) {
    if (durations[index]) return durations[index];
    const c = (media[state.sceneId] || [])[index];
    return c && c.to !== null ? Math.max(0, c.to - c.from) : undefined;
  }
  /**
   * Move by `sec` through the scene, across as many cuts as the step covers: Page Up's 30 seconds
   * over three short shots lands in the fourth, not at the end of the second. A shot whose length
   * is not known yet stops the walk there — entered going on, at its end going back — since
   * nothing says how far it runs.
   */
  function nudge(sec) {
    const { from, length } = span();
    if (mode !== "playing" || !length) return;
    const last = (media[state.sceneId] || []).length - 1;
    let index = clipIndex;
    let at = into() + sec;
    let len = length;
    while (at >= len && index < last) {
      at -= len;
      index += 1;
      const next = lengthOf(index);
      // Not known yet: the step lands in it, and its load clamps what is left to its length.
      if (next === undefined) break;
      len = next;
    }
    while (at < 0 && index > 0) {
      index -= 1;
      const before = lengthOf(index);
      if (before === undefined) {
        loadClip(index, 0, 1);
        renderBar();
        return;
      }
      at += before;
      len = before;
    }
    if (index !== clipIndex) {
      loadClip(index, Math.max(0, at));
      renderBar();
      return;
    }
    video.currentTime = from + Math.max(0, Math.min(length - 0.05, at));
  }
  /** The scene's first frame, or its last: its first shot or its last, not the loaded one's. */
  function seekScene(toEnd) {
    if (mode !== "playing") return;
    const last = (media[state.sceneId] || []).length - 1;
    if (toEnd ? clipIndex < last : clipIndex > 0) loadClip(toEnd ? last : 0, 0, toEnd ? 1 : 0);
    else {
      const { from, length } = span();
      if (length) video.currentTime = from + (toEnd ? Math.max(0, length - 0.05) : 0);
    }
  }
  function full() {
    if (doc.fullscreenElement) doc.exitFullscreen && doc.exitFullscreen();
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => undefined);
  }

  const onClick = (event) => {
    const target = event.target.closest ? event.target : null;
    if (!target) return;
    wake();
    const pick = target.closest("[data-choice]");
    if (pick) {
      const c = choiceById(pick.getAttribute("data-choice"));
      if (c) choose(c);
      return;
    }
    const again = target.closest("[data-again]");
    if (again) {
      chooseAgain(Number(again.getAttribute("data-again")));
      return;
    }
    const heard = target.closest("[data-line]");
    if (heard) {
      // Heard again from the log, on its own player: the beat being read is not disturbed.
      const b = beatsOf(state.sceneId)[Number(heard.getAttribute("data-line"))];
      if (b && b.audio) {
        logVoice.setAttribute("src", b.audio);
        const p = logVoice.play && logVoice.play();
        if (p && p.catch) p.catch(() => undefined);
      }
      return;
    }
    // A tap anywhere on the picture reads on; the chrome, the panels and the choices keep theirs.
    if (mode === "playing" && isBeats(state.sceneId) && !target.closest("button, .aip-panel, .aip-strip, .aip-top")) {
      advanceBeat();
      return;
    }
    const scrub = target.closest('[data-ref="scrub"]');
    if (scrub && mode === "playing") {
      const segs = [...scrub.querySelectorAll(".aip-seg")];
      const seg = target.closest(".aip-seg");
      const index = seg ? segs.indexOf(seg) : clipIndex;
      const box = seg || scrub;
      const rect = box.getBoundingClientRect ? box.getBoundingClientRect() : { left: 0, width: 0 };
      const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
      // A click in another shot's segment seeks to that point in that shot, not its start.
      if (index === clipIndex) {
        const { from, length } = span();
        if (length) video.currentTime = from + ratio * length;
      } else if (index >= 0) loadClip(index, 0, ratio);
      return;
    }
    const act = target.closest("[data-act]");
    if (!act) return;
    switch (act.getAttribute("data-act")) {
      case "toggle": toggle(); break;
      case "back": nudge(-10); break;
      case "mute": video.muted = !video.muted; voice.muted = video.muted; logVoice.muted = video.muted; renderBar(); renderBeat(); break;
      case "route": routeOpen = !routeOpen; if (routeOpen) logOpen = false; renderPanel(); renderBeat(); break;
      case "log": logOpen = !logOpen; if (logOpen) routeOpen = false; renderPanel(); renderBeat(); break;
      case "auto": auto = !auto; renderBeat(); if (auto && mode === "playing") schedule(false); else if (!auto && (beat().advance || "tap") === "tap") stopHold(); break;
      case "full": full(); break;
      case "replay": play(state.sceneId, 0); break;
      case "continue": saved = null; play(state.sceneId, state.positionSec); break;
      case "restart": saved = null; startAgain(); break;
      case "last": chooseAgain(state.route.length - 1); break;
      case "map": author && author.onBranchMap && author.onBranchMap(); break;
      case "close": author && author.onClose && author.onClose(); break;
    }
  };

  const onKey = (event) => {
    wake();
    const onButton = event.target && event.target.tagName === "BUTTON";
    const key = event.key;
    if (key === "Escape") {
      if (logOpen) {
        logOpen = false;
        renderBeat();
      } else if (routeOpen) {
        routeOpen = false;
        renderPanel();
      } else if (author && author.onClose) author.onClose();
      event.preventDefault();
      return;
    }
    if (mode === "choice" && /^[1-9]$/.test(key)) {
      const c = outOf(state.sceneId)[Number(key) - 1];
      if (c) {
        event.preventDefault();
        choose(c);
      }
      return;
    }
    if (mode === "playing" && isBeats(state.sceneId)) {
      // A beat scene reads on with the keys a reader expects; a focused button keeps its own.
      if (((key === " " || key === "Enter") && !onButton) || key === "ArrowRight") {
        event.preventDefault();
        advanceBeat();
        return;
      }
      if (key === "ArrowLeft") {
        event.preventDefault();
        previousBeat();
        return;
      }
      if (key === "a" || key === "A") {
        auto = !auto;
        renderBeat();
        if (auto) schedule(false);
        else if ((beat().advance || "tap") === "tap") stopHold();
        return;
      }
      if (key === "l" || key === "L") {
        logOpen = !logOpen;
        if (logOpen) routeOpen = false;
        renderPanel();
        renderBeat();
        return;
      }
    }
    if (event.target === el.scrub && mode === "playing" && video.duration) {
      // The scene's scrubber is a slider in the tab order, so it takes a slider's keys.
      const step = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 30, PageDown: -30 }[key];
      if (step !== undefined) {
        event.preventDefault();
        nudge(step);
        return;
      }
      if (key === "Home" || key === "End") {
        event.preventDefault();
        seekScene(key === "End");
        return;
      }
    }
    if ((key === " " && !onButton) || key === "k" || key === "K") {
      event.preventDefault();
      toggle();
    } else if (key === "ArrowLeft") nudge(-5);
    else if (key === "ArrowRight") nudge(5);
    else if (key === "m" || key === "M") {
      video.muted = !video.muted;
      voice.muted = video.muted;
      logVoice.muted = video.muted;
      renderBar();
      renderBeat();
    } else if (key === "r" || key === "R") {
      routeOpen = !routeOpen;
      renderPanel();
    } else if (key === "f" || key === "F") full();
  };

  video.addEventListener("timeupdate", onTime);
  video.addEventListener("loadedmetadata", onMeta);
  video.addEventListener("ended", onEnded);
  video.addEventListener("error", onError);
  video.addEventListener("play", onPlayState);
  video.addEventListener("pause", onPlayState);
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  root.addEventListener("pointermove", wake);
  // A beat's voice ending, and the two CSS animations whose ends are signals: the hold element's,
  // which moves the beat on, and the last word's, which is the line finished typing on.
  const onVoiceEnded = () => voiceEnded();
  const onVoiceError = () => voiceLost();
  const onAnimationEnd = (event) => {
    if (event.target === el.hold) {
      if (mode === "playing" && el.hold.getAttribute("data-beat") === state.sceneId + "#" + beatIndex) {
        stopHold();
        nextBeat();
      }
      return;
    }
    if (!typed && event.target && event.target.parentNode === el.line && event.target === el.line.lastElementChild) {
      typed = true;
      el.box.setAttribute("data-typed", "");
      renderBeat();
    }
  };
  voice.addEventListener("ended", onVoiceEnded);
  voice.addEventListener("error", onVoiceError);
  root.addEventListener("animationend", onAnimationEnd);

  if (mode === "poster") {
    render();
    // The poster shows the saved scene's first frame, or the start's, without playing it.
    if ((media[state.sceneId] || []).length > 0) loadClip(0, 0, undefined, false);
  } else play(state.sceneId, state.positionSec);
  wake();
  root.focus();

  return {
    setUnwalked(ids) {
      unwalked = new Set(ids);
      // The strip and the choices are redrawn; whichever of their controls had focus keeps it —
      // a choice by its id, the strip's buttons by what they do. Replaced and not refocused, focus
      // fell out of the player, where the preview's Tab trap cannot reach it.
      const at = doc.activeElement && root.contains(doc.activeElement) ? doc.activeElement : null;
      const choice = at ? at.getAttribute("data-choice") : null;
      const act = at ? at.getAttribute("data-act") : null;
      renderStrip();
      renderChoices();
      if (at !== null && !root.contains(at)) {
        const again = [...root.querySelectorAll(choice !== null ? "[data-choice]" : "[data-act]")].find((b) =>
          choice !== null ? b.getAttribute("data-choice") === choice : b.getAttribute("data-act") === act,
        );
        if (again) again.focus();
        else holdFocus();
      }
    },
    destroy() {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
      video.removeEventListener("play", onPlayState);
      video.removeEventListener("pause", onPlayState);
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("pointermove", wake);
      voice.removeEventListener("ended", onVoiceEnded);
      voice.removeEventListener("error", onVoiceError);
      root.removeEventListener("animationend", onAnimationEnd);
      voice.pause && voice.pause();
      logVoice.pause && logVoice.pause();
      video.pause && video.pause();
      root.innerHTML = "";
      root.classList.remove("aip", "aip-wake");
    },
  };
}

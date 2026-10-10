/*
 * The audiobook player (design turn 186, SPEC-047 R-66..R-71): the book as a listener hears it.
 * One player for the app and the exported package, as the interactive player is (turn 156): the
 * app imports this module and mounts it over the window, and the exporter inlines this file's own
 * text into player.html. That is why it is plain JavaScript with no imports and nothing outside
 * the function: it has to run as it is written, in a page with nothing else on it.
 *
 * It plays the made chapters in order and runs on from one to the next, passing over a chapter
 * with nothing made, which the Chapters sheet lists and holds. A chapter is its audio — a take a
 * file in the app, one joined file a chapter in a package — played back to back on one clock with
 * nothing added between: a grouped take was cut in the middle of the reader's own pause (turn
 * 185). The blocks with no take are gaps the clock skips over, marked on the scrubber and in Text.
 * Pictures set on blocks show from their block until the next, crossfading over a second.
 *
 * The listener's place is kept on this device only, by the block it is in and how far into it —
 * never by the chapter's clock alone, which moves whenever a block before it is made — so a place
 * kept while a chapter was half read opens where it was once the rest is read. The speed, the
 * sleep choice and Text are kept beside it.
 */

/**
 * @param {HTMLElement} root
 * @param {import("./audiobook-player.js").AudiobookPlayerOptions} options
 * @returns {import("./audiobook-player.js").AudiobookPlayerHandle}
 */
export function mountAudiobookPlayer(root, options) {
  const doc = root.ownerDocument;
  const win = doc.defaultView || globalThis;
  const nav = win.navigator || null;
  const clockNow = options.now || (() => Date.now());
  const KEY = options.storageKey || null;
  const SPEEDS = [0.8, 1, 1.2, 1.5, 1.75, 2];
  const SLEEPS = ["off", "chapter", 15, 30, 60];
  const GAP_NOTE_SEC = 4;

  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const pad = (n) => String(n).padStart(2, "0");
  // A chapter titled with its own number ("Chapter 1") is named once (design turn 192): the
  // heading said "Chapter 01 · Chapter 1".
  const ownTitle = (c) => {
    const m = /^chapter\s+0*(\d+)$/i.exec(String(c.title).trim());
    return m && Number(m[1]) === c.order ? "" : c.title;
  };
  const time = (sec) => {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return (h > 0 ? h + ":" + pad(m) : String(m)) + ":" + pad(s % 60);
  };
  const left = (sec) => {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? h + " h " + m + " m left" : m > 0 ? m + " m left" : s + " s left";
  };
  const speedLabel = (rate) => (Number.isInteger(rate) ? rate.toFixed(1) : String(rate)) + "×";

  /** Each chapter with its audio, a list of sources on its clock, and what it shows and says. */
  function normalise(list) {
    return (list || []).map((c) => {
      const audio = (c.audio && c.audio.length > 0 ? c.audio : (c.blocks || []).map((b) => ({ src: b.src, at: b.at, seconds: b.seconds }))).filter((a) => a.src && a.seconds > 0);
      return {
        id: c.id,
        order: c.order,
        title: c.title,
        state: c.state,
        seconds: c.seconds || 0,
        audio,
        blocks: c.blocks || [],
        gaps: c.gaps || [],
        pictures: (c.pictures || []).slice().sort((a, b) => a.at - b.at),
        opening: c.opening || null,
      };
    });
  }
  let chapters = normalise(options.chapters);
  const playable = (i) => Boolean(chapters[i] && chapters[i].audio.length > 0);
  const nextPlayable = (from, step) => {
    for (let i = from; i >= 0 && i < chapters.length; i += step) if (playable(i)) return i;
    return -1;
  };

  // ---- what this device keeps ----------------------------------------------------------------
  const read = () => {
    if (!KEY) return null;
    try {
      return JSON.parse(win.localStorage.getItem(KEY) || "null");
    } catch {
      return null;
    }
  };
  const kept = read() || {};
  let speed = SPEEDS.includes(kept.speed) ? kept.speed : 1;
  let sleep = SLEEPS.includes(kept.sleep) ? kept.sleep : "off";
  let textOn = kept.text === true;
  /** Where the listener is: a chapter, a block in it and how far in; `at` is the clock when the block is gone. */
  let saved = kept.place && typeof kept.place.chapterId === "string" ? kept.place : null;
  function save() {
    if (!KEY) return;
    try {
      win.localStorage.setItem(KEY, JSON.stringify({ place: saved, speed, sleep, text: textOn }));
    } catch {
      // A full or refused storage keeps nothing; the player plays on regardless.
    }
  }

  /** The block a chapter's clock stands in, and how far into it. */
  function blockAt(chapter, t) {
    let found = null;
    for (const block of chapter.blocks) if (block.at <= t + 1e-6) found = block;
    return found;
  }
  /** A kept place on this plan: by its block and offset while the block is there, else its clock. */
  function resolve(place) {
    const index = chapters.findIndex((c) => c.id === place.chapterId);
    if (index < 0) return null;
    const chapter = chapters[index];
    const block = place.key ? chapter.blocks.find((b) => b.key === place.key) : null;
    const t = block ? block.at + Math.min(Math.max(0, place.offset || 0), block.seconds) : Math.min(Math.max(0, place.at || 0), chapter.seconds);
    return { index, t };
  }
  function placeHere() {
    const chapter = chapters[ci];
    if (!chapter) return null;
    const block = blockAt(chapter, t);
    return { chapterId: chapter.id, key: block ? block.key : null, offset: block ? Math.max(0, t - block.at) : 0, at: t, updatedAt: new Date(clockNow()).toISOString() };
  }

  // ---- where it starts -----------------------------------------------------------------------
  let ci = 0;
  let t = 0;
  {
    const resumed = saved ? resolve(saved) : null;
    const asked = options.chapterId ? chapters.findIndex((c) => c.id === options.chapterId) : -1;
    if (asked >= 0 && !(resumed && resumed.index === asked)) {
      const at = nextPlayable(asked, 1);
      ci = at >= 0 ? at : Math.max(0, nextPlayable(0, 1));
      t = 0;
    } else if (resumed && playable(resumed.index)) {
      ci = resumed.index;
      t = resumed.t >= chapters[ci].seconds - 0.5 ? 0 : resumed.t;
    } else {
      ci = Math.max(0, nextPlayable(0, 1));
      t = 0;
    }
  }
  // Listen on the book opens on Continue when a place is kept here, and plays at once when not.
  if (Number.isFinite(options.startAt) && chapters[ci]) t = Math.max(0, Math.min(chapters[ci].seconds, options.startAt));
  let mode = options.autoplay && !(options.continueFirst && saved && playable(ci)) ? "playing" : "poster";
  let playing = false;
  let sheetOpen = false;
  let sleepLeft = null;
  let lastTick = null;
  let gapNote = null;
  /** The listener's place while a newer plan has nothing to play: kept for when takes come back. */
  let heldPlace = null;

  const icon = (d, size, fill) =>
    '<svg width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 24 24" fill="' + (fill ? "currentColor" : "none") + '" stroke="' + (fill ? "none" : "currentColor") + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
  const I = {
    play: '<path d="M7 4.5v15l13-7.5z"></path>',
    pause: '<rect x="6" y="4.5" width="4" height="15" rx="1"></rect><rect x="14" y="4.5" width="4" height="15" rx="1"></rect>',
    prev: '<path d="M6 5h2v14H6zM20 5v14L9 12z"></path>',
    next: '<path d="M16 5h2v14h-2zM4 5v14l11-7z"></path>',
    back: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">15</text>',
    fwd: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">30</text>',
    text: '<path d="M4 7V5h16v2M9 19h6M12 5v14"></path>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"></path>',
    x: '<path d="M18 6 6 18M6 6l12 12"></path>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"></path>',
  };

  // The picture is the page (turns 156, 186): always dark, whatever the app's theme; the media
  // tokens when the app supplies them, their values when the package stands alone.
  const css = `
.abp{--abp-bg:var(--media-overlay-bg,#0a0a0a);--abp-fg:var(--media-overlay-fg,#fafafa);position:relative;width:100%;height:100%;overflow:hidden;background:var(--abp-bg);color:var(--abp-fg);font-family:var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:14px;line-height:1.4;outline:none;-webkit-font-smoothing:antialiased}
.abp *{box-sizing:border-box}
.abp button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.abp [hidden]{display:none!important}
.abp-pic{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;opacity:0;transition:opacity 1s ease}
.abp-pic.on{opacity:1}
.abp-clipnote{position:absolute;left:24px;top:76px;color:white;font-size:12px;z-index:2}
.abp-scrim-top{position:absolute;left:0;right:0;top:0;height:160px;background:linear-gradient(to bottom,color-mix(in srgb,var(--abp-bg) 72%,transparent),transparent);pointer-events:none}
.abp-scrim-bot{position:absolute;left:0;right:0;bottom:0;height:330px;background:linear-gradient(to top,color-mix(in srgb,var(--abp-bg) 90%,transparent) 12%,transparent);pointer-events:none}
.abp-top{position:absolute;left:32px;right:24px;top:26px;display:flex;align-items:flex-start;gap:4px}
.abp-title{flex:1;min-width:0}
.abp-eyebrow{font-size:var(--text-2xs,11px);font-weight:500;letter-spacing:.05em;text-transform:uppercase;color:color-mix(in srgb,var(--abp-fg) 68%,transparent)}
.abp-chap{margin-top:5px;font-size:var(--text-lg,20px);font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.abp-ib{width:40px;height:40px;flex:none;border-radius:999px;display:inline-flex!important;align-items:center;justify-content:center}
.abp-ib:hover,.abp-ib:focus-visible,.abp-ib[aria-pressed="true"],.abp-lab:hover,.abp-lab:focus-visible{background:color-mix(in srgb,var(--abp-fg) 14%,transparent)!important}
.abp-ib:disabled{opacity:.35;cursor:default}
.abp-lab{height:40px;flex:none;border-radius:999px;display:inline-flex!important;align-items:center;gap:7px;padding:0 14px 0 12px!important;font-weight:500;white-space:nowrap}
.abp-follow{position:absolute;left:50%;transform:translateX(-50%);bottom:170px;width:860px;max-width:calc(100% - 64px);text-align:center;font-size:var(--text-xl,22px);line-height:1.5;text-wrap:pretty}
.abp-follow .now{color:var(--abp-fg)}
.abp-follow .rest{color:color-mix(in srgb,var(--abp-fg) 55%,transparent)}
.abp-follow .rest.gap,.abp-gapnote{font-style:italic}
.abp-gapnote{display:block;margin-bottom:6px;font-size:var(--text-xs,12px);font-style:normal;font-family:var(--font-mono,ui-monospace,monospace);color:color-mix(in srgb,var(--abp-fg) 62%,transparent)}
.abp-bar{position:absolute;left:32px;right:32px;bottom:28px}
.abp-track{position:relative;height:14px;display:flex;align-items:center;cursor:pointer;border-radius:4px;touch-action:none}
.abp-track:focus-visible{outline:2px solid color-mix(in srgb,var(--abp-fg) 55%,transparent);outline-offset:4px}
.abp-line{position:relative;flex:1;height:4px;border-radius:2px;background:color-mix(in srgb,var(--abp-fg) 24%,transparent)}
.abp-line>i{position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:var(--abp-fg)}
.abp-line>b{position:absolute;top:-4px;width:2px;height:12px;border-radius:1px;background:color-mix(in srgb,var(--abp-fg) 70%,transparent)}
.abp-line>u{position:absolute;top:-3px;width:10px;height:10px;margin-left:-5px;border-radius:50%;border:1.5px dashed color-mix(in srgb,var(--abp-fg) 70%,transparent);background:var(--abp-bg)}
.abp-knob{position:absolute;top:-5px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:var(--abp-fg)}
.abp-row{display:flex;align-items:center;gap:6px;margin-top:14px}
.abp-grow{flex:1}
.abp-ctl,.abp-labs{display:flex;align-items:center;gap:6px}
.abp-mono{font-family:var(--font-mono,ui-monospace,monospace);font-size:var(--text-xs,12px);color:color-mix(in srgb,var(--abp-fg) 72%,transparent);white-space:nowrap;font-variant-numeric:tabular-nums}
.abp-play{width:52px;height:52px;flex:none;border-radius:50%;background:var(--abp-fg)!important;color:var(--abp-bg)!important;display:inline-flex!important;align-items:center;justify-content:center}
.abp-book{position:relative;height:2px;margin-top:12px;border-radius:1px;background:color-mix(in srgb,var(--abp-fg) 16%,transparent)}
.abp-book>i{position:absolute;left:0;top:0;bottom:0;background:color-mix(in srgb,var(--abp-fg) 60%,transparent)}
.abp-text-lab{display:none!important}
.abp-chrome{transition:opacity .35s ease}
@keyframes abp-rest{to{opacity:0}}
.abp.abp-wake[data-mode="playing"]:not([data-paused]):not([data-sheet]) .abp-chrome{animation:abp-rest .35s ease 2.5s forwards}
.abp[data-mode="playing"]:not([data-paused]):not([data-sheet]):not(.abp-wake) .abp-chrome{opacity:0}
.abp[data-mode="poster"] .abp-bar,.abp[data-mode="poster"] .abp-top,.abp[data-mode="poster"] .abp-follow{display:none}
.abp-sheet{position:absolute;right:24px;top:84px;max-height:calc(100% - 264px);width:420px;max-width:calc(100% - 48px);border-radius:18px;padding:18px 0;display:flex;flex-direction:column;background:color-mix(in srgb,var(--abp-bg) 58%,transparent);backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);border:1px solid color-mix(in srgb,var(--abp-fg) 20%,transparent)}
.abp-sheet h4{margin:0 20px 10px;font-size:var(--text-2xs,11px);font-weight:500;letter-spacing:.05em;text-transform:uppercase;color:color-mix(in srgb,var(--abp-fg) 68%,transparent)}
.abp-list{flex:0 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.abp-ch{width:100%;display:flex!important;align-items:center;gap:12px;padding:9px 20px!important;text-align:left;font-weight:500}
.abp-ch.cur{background:color-mix(in srgb,var(--abp-fg) 12%,transparent)!important}
.abp-ch:disabled{color:color-mix(in srgb,var(--abp-fg) 40%,transparent);cursor:default}
.abp-ch:not(:disabled):hover,.abp-ch:not(:disabled):focus-visible{background:color-mix(in srgb,var(--abp-fg) 9%,transparent)!important}
.abp-ch .n{width:22px;flex:none}
.abp-ch .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.abp-ch .prog{width:44px;height:3px;flex:none;border-radius:2px;background:color-mix(in srgb,var(--abp-fg) 18%,transparent);position:relative}
.abp-ch .prog>i{position:absolute;left:0;top:0;bottom:0;background:var(--abp-fg);border-radius:2px}
.abp-poster{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:0 72px 80px;background:linear-gradient(to right,color-mix(in srgb,var(--abp-bg) 90%,transparent) 18%,color-mix(in srgb,var(--abp-bg) 40%,transparent) 62%,transparent)}
.abp-poster-title{margin-top:10px;font-size:var(--text-5xl,48px);font-weight:600;letter-spacing:-.02em;line-height:1.1}
.abp-poster-actions{margin-top:28px;display:flex;flex-wrap:wrap;gap:10px}
.abp-btn{height:44px;padding:0 20px!important;border-radius:999px;display:inline-flex!important;align-items:center;gap:10px;font-weight:500!important;font-size:15px!important;white-space:nowrap;border:1px solid color-mix(in srgb,var(--abp-fg) 18%,transparent)!important;background:color-mix(in srgb,var(--abp-bg) 42%,transparent)!important}
.abp-btn.primary{background:var(--abp-fg)!important;color:var(--abp-bg)!important;border-color:transparent!important}
.abp-btn>i{width:80px;height:3px;border-radius:99px;background:color-mix(in srgb,var(--abp-bg) 22%,transparent);overflow:hidden;display:block}
.abp-btn>i>b{display:block;height:100%;background:var(--abp-bg)}
@media (max-width:599px){
.abp-pic{height:62%;bottom:auto}
.abp-scrim-top{display:none}
.abp-scrim-bot{height:520px}
.abp-top{left:20px;right:12px;top:18px}
.abp-text-top,.abp-long{display:none!important}
.abp-text-lab{display:inline-flex!important}
.abp-follow{width:auto;left:20px;right:20px;transform:none;bottom:290px;font-size:var(--text-md,16px)}
.abp-bar{left:20px;right:20px;bottom:40px}
.abp-transport{display:grid;grid-template-columns:auto 1fr auto;grid-template-areas:"now . len" "ctl ctl ctl" "labs labs labs";row-gap:18px}
.abp-transport>.abp-grow{display:none}
.abp-now{grid-area:now}.abp-len{grid-area:len}
.abp-ctl{grid-area:ctl;justify-content:space-between}
.abp-labs{grid-area:labs;justify-content:space-between}
.abp-play{width:64px;height:64px}
.abp-sheet{left:12px;right:12px;width:auto;top:72px;max-height:calc(100% - 272px)}
.abp-poster{padding:0 24px 64px}
.abp-poster-title{font-size:var(--text-3xl,32px)}
}
`;

  root.classList.add("abp");
  root.tabIndex = 0;
  root.innerHTML =
    "<style>" + css + "</style>" +
    '<img class="abp-pic" data-ref="picA" alt=""><video class="abp-pic" data-ref="clipA" muted playsinline preload="auto"></video><img class="abp-pic" data-ref="picB" alt=""><video class="abp-pic" data-ref="clipB" muted playsinline preload="auto"></video><span class="abp-clipnote" data-ref="clipNote" role="status"></span>' +
    '<div class="abp-scrim-top abp-chrome"></div><div class="abp-scrim-bot abp-chrome"></div>' +
    '<div class="abp-top abp-chrome"><div class="abp-title"><div class="abp-eyebrow" data-ref="eyebrow"></div><div class="abp-chap" data-ref="chap"></div></div>' +
    '<button type="button" class="abp-ib abp-text-top" data-act="text" data-ref="textTop" aria-label="Text" title="Text">' + icon(I.text) + "</button>" +
    '<button type="button" class="abp-ib" data-act="chapters" data-ref="chaptersBtn" aria-label="Chapters" title="Chapters">' + icon(I.list) + "</button>" +
    (options.onClose ? '<button type="button" class="abp-ib" data-act="close" aria-label="Close" title="Close">' + icon(I.x) + "</button>" : "") +
    "</div>" +
    '<div class="abp-follow" data-ref="follow" aria-live="polite" hidden></div>' +
    '<div class="abp-sheet" data-ref="sheet" role="dialog" aria-label="Chapters" hidden></div>' +
    '<div class="abp-poster" data-ref="poster" hidden></div>' +
    '<div class="abp-bar abp-chrome" data-ref="bar">' +
    '<div class="abp-track" data-ref="track" role="slider" tabindex="0" aria-label="Position in this chapter" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"><div class="abp-line" data-ref="line"></div></div>' +
    '<div class="abp-row abp-transport">' +
    '<span class="abp-mono abp-now" data-ref="now"></span><span class="abp-grow"></span>' +
    '<span class="abp-ctl">' +
    '<button type="button" class="abp-ib" data-act="prev" data-ref="prevBtn" aria-label="Previous chapter" title="Previous chapter">' + icon(I.prev, 18, true) + "</button>" +
    '<button type="button" class="abp-ib" data-act="back" aria-label="Back 15 seconds" title="Back 15 seconds">' + icon(I.back, 20) + "</button>" +
    '<button type="button" class="abp-play" data-act="toggle" data-ref="toggle" aria-label="Play"></button>' +
    '<button type="button" class="abp-ib" data-act="fwd" aria-label="Forward 30 seconds" title="Forward 30 seconds">' + icon(I.fwd, 20) + "</button>" +
    '<button type="button" class="abp-ib" data-act="next" data-ref="nextBtn" aria-label="Next chapter" title="Next chapter">' + icon(I.next, 18, true) + "</button>" +
    "</span><span class=\"abp-grow\"></span>" +
    '<span class="abp-labs">' +
    '<button type="button" class="abp-lab" data-act="speed" data-ref="speedBtn" aria-label="Speed"></button>' +
    '<button type="button" class="abp-lab" data-act="sleep" data-ref="sleepBtn"></button>' +
    '<button type="button" class="abp-lab abp-text-lab" data-act="text" data-ref="textLab">' + icon(I.text) + "Text</button>" +
    "</span>" +
    '<span class="abp-mono abp-len" data-ref="len"></span>' +
    "</div>" +
    '<div class="abp-book" data-ref="book"><i></i></div>' +
    '<div class="abp-row" style="margin-top:8px"><span class="abp-mono abp-of" data-ref="of"></span><span class="abp-grow"></span><span class="abp-mono abp-left" data-ref="left"></span></div>' +
    "</div>" +
    '<audio data-ref="a0" preload="auto"></audio><audio data-ref="a1" preload="auto"></audio>';

  const ref = (name) => root.querySelector('[data-ref="' + name + '"]');
  const el = {
    pics: [ref("picA"), ref("picB")], eyebrow: ref("eyebrow"), chap: ref("chap"), textTop: ref("textTop"), textLab: ref("textLab"),
    chaptersBtn: ref("chaptersBtn"), follow: ref("follow"), sheet: ref("sheet"), poster: ref("poster"), track: ref("track"),
    line: ref("line"), now: ref("now"), len: ref("len"), toggle: ref("toggle"), prevBtn: ref("prevBtn"), nextBtn: ref("nextBtn"),
    speedBtn: ref("speedBtn"), sleepBtn: ref("sleepBtn"), book: ref("book"), of: ref("of"), left: ref("left"),
  };
  const players = [ref("a0"), ref("a1")];
  let cur = 0;
  /** Which of the chapter's audio each element holds: an index, or -1. */
  const holds = [-1, -1];
  let segIndex = 0;
  let shown = 0;
  let shownSrc = null;
  let shownKey = null;
  const clips = [ref("clipA"), ref("clipB")];
  const clipPictures = [null, null];
  const clipFadeUntil = [0, 0];
  const clipFailures = new Set();
  const reducedMotion = win.matchMedia ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const onClipError = (event) => {
    const index = clips.indexOf(event.target);
    if (index < 0) return;
    const picture = clipPictures[index];
    if (picture && picture.motion) clipFailures.add(picture.motion.src);
    clips[index].classList.remove("on");
    if (index === shown) ref("clipNote").textContent = "clip unavailable · showing the still";
  };
  for (const clip of clips) { clip.muted = true; clip.addEventListener("error", onClipError); }

  // ---- the audio, back to back -----------------------------------------------------------------
  const chapter = () => chapters[ci];
  const segAt = (c, at) => {
    let index = 0;
    c.audio.forEach((a, i) => {
      if (a.at <= at + 1e-6) index = i;
    });
    return index;
  };
  // A pause the player makes itself is not the listener's: an engine that tells of it at once
  // would otherwise read it as a headset's press, mid-way through a seek or a chapter's change.
  let internal = 0;
  function quietPause(audio) {
    internal += 1;
    try {
      audio.pause();
    } catch {
      // Not playing.
    } finally {
      internal -= 1;
    }
  }
  function applyRate(audio) {
    audio.playbackRate = speed;
    audio.defaultPlaybackRate = speed;
    // The pitch kept at every speed (R-68), under each engine's own name for it.
    audio.preservesPitch = true;
    audio.mozPreservesPitch = true;
    audio.webkitPreservesPitch = true;
  }
  /** Elements waiting to learn their length before an offset can be set: their clock is not the listener's yet. */
  const pending = new Set();
  function seekWithin(audio, offset) {
    const set = () => {
      pending.delete(audio);
      try {
        audio.currentTime = offset;
      } catch {
        // Not seekable after all: it plays from its start.
      }
    };
    if (audio.readyState === undefined || audio.readyState >= 1) set();
    else {
      pending.add(audio);
      audio.addEventListener("loadedmetadata", set, { once: true });
    }
  }
  /** One element loaded with one piece of the chapter's audio, at an offset into it. */
  function hold(which, index, offset) {
    const audio = players[which];
    const piece = chapter().audio[index];
    if (!piece) {
      holds[which] = -1;
      return;
    }
    if (holds[which] !== index || audio.getAttribute("src") !== piece.src) {
      audio.setAttribute("src", piece.src);
      holds[which] = index;
      if (typeof audio.load === "function" && audio.readyState !== undefined) audio.load();
    }
    applyRate(audio);
    seekWithin(audio, offset);
  }
  /** The element after this one holds the next piece, so the join is the takes' own. */
  function primeNext() {
    const other = 1 - cur;
    if (segIndex + 1 < chapter().audio.length) hold(other, segIndex + 1, 0);
    else {
      holds[other] = -1;
    }
  }
  function startAudio() {
    const audio = players[cur];
    // The host takes the app's voice back each time the book sounds (codex on PR 1499).
    if (options.onPlay) options.onPlay();
    applyRate(audio);
    const started = audio.play && audio.play();
    if (started && typeof started.catch === "function") {
      started.catch(() => {
        // Refused without a gesture: the listener's next press plays.
        playing = false;
        render();
      });
    }
  }
  /** Go to a place on this chapter's clock, playing on if it was playing. */
  function seek(at) {
    const c = chapter();
    if (!c || c.audio.length === 0) return;
    t = Math.max(0, Math.min(at, Math.max(0, c.seconds - 0.05)));
    const index = segAt(c, t);
    const offset = Math.max(0, t - c.audio[index].at);
    if (holds[cur] !== index) {
      if (holds[1 - cur] === index) {
        quietPause(players[cur]);
        cur = 1 - cur;
      }
    }
    segIndex = index;
    hold(cur, index, offset);
    quietPause(players[1 - cur]);
    primeNext();
    if (playing) startAudio();
    remember();
    render();
  }
  function goChapter(index, at) {
    if (!playable(index)) return;
    for (const audio of players) quietPause(audio);
    holds[0] = holds[1] = -1;
    ci = index;
    gapNote = leadingGap();
    seek(at || 0);
  }
  /**
   * The blocks not read before a chapter's first take (codex on PR 1493): the gap and the take
   * both stand at 0:00, so no clock ever crosses it, and it is said as the chapter opens.
   */
  function leadingGap() {
    const c = chapter();
    return c && c.audio.length > 0 ? c.gaps.find((gap) => gap.at < 1e-3) || null : null;
  }
  function play() {
    if (!playable(ci)) {
      const at = nextPlayable(ci, 1);
      if (at < 0) return;
      goChapter(at, 0);
    }
    mode = "playing";
    playing = true;
    lastTick = clockNow();
    if (sleep !== "off" && sleep !== "chapter" && sleepLeft === null) sleepLeft = sleep * 60;
    if (holds[cur] !== segIndex) seek(t);
    startAudio();
    render();
  }
  function pause() {
    playing = false;
    lastTick = null;
    quietPause(players[cur]);
    remember();
    render();
  }
  /** The chapter's last piece ended: run on to the next chapter with something to play, or rest at the end. */
  function chapterEnded() {
    const next = nextPlayable(ci + 1, 1);
    const sleepsHere = sleep === "chapter";
    if (next < 0) {
      t = chapter().seconds;
      pause();
      return;
    }
    if (sleepsHere) {
      // End of chapter: rest at the next chapter's start, so the next press goes on from there.
      // Stopped before the next chapter is loaded, or its first words would sound (codex on PR 1493).
      playing = false;
      lastTick = null;
      goChapter(next, 0);
      pause();
      return;
    }
    goChapter(next, 0);
    playing = true;
    startAudio();
    render();
  }
  function onEnded(event) {
    if (event.target !== players[cur]) return;
    const c = chapter();
    if (segIndex + 1 >= c.audio.length) {
      chapterEnded();
      return;
    }
    // The next piece is already loaded in the other element: swap and play on at once.
    const other = 1 - cur;
    segIndex += 1;
    if (holds[other] !== segIndex) hold(other, segIndex, 0);
    else seekWithin(players[other], 0);
    cur = other;
    t = c.audio[segIndex].at;
    // Blocks not read between this take and the last are said in Text as the clock crosses them.
    gapNote = c.gaps.find((gap) => Math.abs(gap.at - t) < 1e-3) || null;
    if (playing) startAudio();
    primeNext();
    render();
  }
  function onTime(event) {
    // Only a playing element moves the clock: a paused one's time is where a seek put it, and an
    // element still loading reports its start before the offset it was asked for is set.
    if (event.target !== players[cur] || !playing || pending.has(players[cur])) return;
    const c = chapter();
    if (!c || !c.audio[segIndex]) return;
    const before = t;
    t = Math.min(c.seconds, c.audio[segIndex].at + (players[cur].currentTime || 0));
    // A gap the clock just crossed is said in Text for a few seconds after (R-67).
    const crossed = c.gaps.find((gap) => gap.at > before + 1e-6 && gap.at <= t + 1e-6 && gap.at > 0);
    if (crossed) gapNote = crossed;
    if (gapNote && (t < gapNote.at || t > gapNote.at + GAP_NOTE_SEC)) gapNote = null;
    if (playing && lastTick !== null) {
      const tick = clockNow();
      const elapsed = Math.max(0, (tick - lastTick) / 1000);
      lastTick = tick;
      if (typeof sleep === "number") {
        sleepLeft = (sleepLeft === null ? sleep * 60 : sleepLeft) - elapsed;
        if (sleepLeft <= 0) {
          // The sleep timer: playing stops, the choice is kept, the next press starts it again.
          sleepLeft = null;
          pause();
          return;
        }
      }
    }
    remember();
    render();
  }
  function onPlayState(event) {
    // A take that ends pauses itself on the way to `ended`; that is the next take's cue, not a pause.
    if (internal > 0 || event.target !== players[cur] || (event.type === "pause" && players[cur].ended)) return;
    // A headset, the lock screen or the system paused or played the element itself.
    const now = !players[cur].paused;
    if (now !== playing) {
      playing = now;
      lastTick = now ? clockNow() : null;
      render();
    }
  }
  let lastSaved = -1;
  function remember() {
    if (!playable(ci)) return;
    const second = Math.floor(t);
    saved = placeHere();
    if (second === lastSaved && playing) return;
    lastSaved = second;
    save();
  }

  // ---- what is shown ---------------------------------------------------------------------------
  function pictureAt(c, at) {
    let found = null;
    for (const picture of c.pictures) if (picture.at <= at + 1e-6) found = picture;
    return found || { at: 0, src: c.opening || options.cover || null };
  }
  function showPicture(picture) {
    const key = (chapter() ? chapter().id : "") + "|" + JSON.stringify(picture);
    if (key !== shownKey) {
      clipFadeUntil[shown] = shownKey !== null && key.split("|")[0] === shownKey.split("|")[0] ? Date.now() + 1000 : 0;
      shownKey = key;
      shownSrc = picture.src;
      const next = 1 - shown;
      const incoming = el.pics[next];
      if (picture.src) { incoming.setAttribute("src", picture.src); incoming.classList.add("on"); }
      else incoming.classList.remove("on");
      el.pics[shown].classList.remove("on");
      clips[shown].classList.remove("on");
      clips[next].pause?.();
      clipPictures[next] = picture;
      if (picture.motion) clips[next].setAttribute("src", picture.motion.src);
      else clips[next].removeAttribute("src");
      shown = next;
      syncSession();
    }
    // The audio is the clock even after seeking, changing speed, or a repeat boundary.
    for (let index = 0; index < clips.length; index++) {
      const clip = clips[index];
      const current = clipPictures[index];
      const motion = current && current.motion;
      const outgoing = index !== shown && Date.now() < clipFadeUntil[index];
      const visible = (index === shown || outgoing) && motion && !current.motionProblem && !(reducedMotion && reducedMotion.matches) && !clipFailures.has(motion.src);
      if (!visible) { clip.classList.remove("on"); clip.pause?.(); continue; }
      const elapsed = Math.max(0, t - current.at);
      const target = motion.behavior === "repeat" ? elapsed % motion.seconds : Math.min(elapsed, Math.max(0, motion.seconds - 1 / 120));
      if (Number.isFinite(target) && clip.readyState >= 1 && Math.abs(clip.currentTime - target) > 0.12) clip.currentTime = target;
      clip.muted = true;
      clip.playbackRate = speed;
      if (index === shown) clip.classList.add("on");
      if (playing && (motion.behavior === "repeat" || elapsed < motion.seconds - 1 / 120)) { if (clip.paused) { const result = clip.play(); if (result && result.catch) result.catch(() => {}); } }
      else clip.pause?.();
    }
    ref("clipNote").textContent = picture.motionProblem || (picture.motion && clipFailures.has(picture.motion.src) ? "clip unavailable · showing the still" : "");
  }
  function sentenceAt(c, at) {
    const block = blockAt(c, at);
    if (!block) return null;
    let index = 0;
    block.sentences.forEach((sentence, i) => {
      if (sentence.at <= at + 1e-6) index = i;
    });
    return { block, index };
  }
  const gapWords = (gap) => {
    const n = gap.to - gap.from + 1;
    return n + (n === 1 ? " block" : " blocks") + " not read";
  };
  function renderFollow() {
    el.follow.hidden = !textOn || mode !== "playing";
    if (el.follow.hidden) return;
    const c = chapter();
    const here = c ? sentenceAt(c, t) : null;
    if (!here) {
      el.follow.innerHTML = "";
      return;
    }
    const now = here.block.sentences[here.index].text;
    let rest = here.block.sentences[here.index + 1];
    let restHtml = "";
    if (rest) restHtml = '<span class="rest">' + esc(rest.text) + "</span>";
    else {
      const end = here.block.at + here.block.seconds;
      const gap = c.gaps.find((g) => Math.abs(g.at - end) < 1e-3);
      const following = c.blocks.find((b) => b.at >= end - 1e-6 && b !== here.block);
      if (gap) restHtml = '<span class="rest gap">' + esc(gapWords(gap)) + "</span>";
      else if (following) restHtml = '<span class="rest">' + esc(following.sentences[0].text) + "</span>";
    }
    el.follow.innerHTML = (gapNote ? '<span class="abp-gapnote">' + esc(gapWords(gapNote)) + "</span>" : "") + '<span class="now">' + esc(now) + "</span> " + restHtml;
  }
  function renderTrack() {
    const c = chapter();
    const length = c ? c.seconds : 0;
    const pct = (at) => (length > 0 ? Math.max(0, Math.min(100, (at / length) * 100)) : 0);
    const ticks = c ? c.pictures.map((p) => '<b style="left:' + pct(p.at) + '%"></b>').join("") : "";
    const gaps = c ? c.gaps.map((g) => '<u title="' + esc(gapWords(g)) + '" style="left:' + pct(g.at) + '%"></u>').join("") : "";
    el.line.innerHTML = '<i style="width:' + pct(t) + '%"></i>' + ticks + gaps + '<span class="abp-knob" style="left:' + pct(t) + '%"></span>';
    el.track.setAttribute("aria-valuemax", String(Math.round(length)));
    el.track.setAttribute("aria-valuenow", String(Math.round(t)));
    el.track.setAttribute("aria-valuetext", time(t) + " of " + time(length));
  }
  function bookLine() {
    const total = chapters.reduce((sum, c) => sum + c.seconds, 0);
    const before = chapters.slice(0, ci).reduce((sum, c) => sum + c.seconds, 0);
    const done = before + t;
    return { pct: total > 0 ? Math.min(100, (done / total) * 100) : 0, left: Math.max(0, total - done) };
  }
  function renderSheet() {
    root.toggleAttribute("data-sheet", sheetOpen);
    el.sheet.hidden = !sheetOpen;
    el.chaptersBtn.setAttribute("aria-pressed", String(sheetOpen));
    if (!sheetOpen) return;
    const read = chapters.filter((c) => c.state === "read").length;
    const rows = chapters.map((c, i) => {
      const progress = i < ci ? 100 : i === ci && c.seconds > 0 ? Math.min(100, (t / c.seconds) * 100) : 0;
      const unread = c.gaps.reduce((sum, g) => sum + (g.to - g.from + 1), 0);
      const tail = c.audio.length === 0
        ? '<span class="abp-mono">not read</span>'
        : '<span class="prog"><i style="width:' + progress + '%"></i></span>' + (c.state === "part" ? '<span class="abp-mono">' + unread + " not read</span>" : "") + '<span class="abp-mono">' + time(c.seconds) + "</span>";
      return '<button type="button" class="abp-ch' + (i === ci ? " cur" : "") + '" data-act="chapter" data-index="' + i + '"' + (c.audio.length === 0 ? " disabled" : "") + (i === ci ? ' aria-current="true"' : "") + '><span class="n abp-mono">' + pad(c.order) + '</span><span class="t">' + esc(c.title) + "</span>" + tail + "</button>";
    });
    el.sheet.innerHTML = "<h4>Chapters · " + chapters.length + " · " + read + ' read</h4><div class="abp-list">' + rows.join("") + "</div>";
  }
  function renderPoster() {
    el.poster.hidden = mode !== "poster";
    if (mode !== "poster") return;
    const c = chapter();
    const resumable = saved && playable(ci) && (t > 0 || ci !== nextPlayable(0, 1));
    const pct = c && c.seconds > 0 ? Math.min(100, (t / c.seconds) * 100) : 0;
    el.poster.innerHTML =
      '<div class="abp-eyebrow">audiobook</div><div class="abp-poster-title">' + esc(options.title) + "</div>" +
      '<div class="abp-poster-actions">' +
      (resumable
        ? '<button type="button" class="abp-btn primary" data-act="continue">' + icon(I.play, 16, true) + "Continue · chapter " + c.order + " · " + time(t) + '<i><b style="width:' + pct + '%"></b></i></button>' +
          '<button type="button" class="abp-btn" data-act="restart">Start over</button>'
        : '<button type="button" class="abp-btn primary" data-act="continue"' + (nextPlayable(0, 1) < 0 ? " disabled" : "") + ">" + icon(I.play, 16, true) + "Play</button>") +
      "</div>";
  }
  function render() {
    const c = chapter();
    root.setAttribute("data-mode", mode);
    root.toggleAttribute("data-paused", !playing);
    // A phone says the book and `07 · The Tenth Key` (186d); the long words are the wide window's.
    el.eyebrow.innerHTML = esc(options.title) + '<span class="abp-long"> · audiobook</span>';
    el.chap.innerHTML = !c ? "" : ownTitle(c) === "" ? "Chapter " + pad(c.order) : '<span class="abp-long">Chapter </span>' + pad(c.order) + " · " + esc(c.title);
    el.toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
    el.toggle.innerHTML = icon(playing ? I.pause : I.play, 20, true);
    el.prevBtn.disabled = nextPlayable(ci - 1, -1) < 0;
    el.nextBtn.disabled = nextPlayable(ci + 1, 1) < 0;
    el.speedBtn.textContent = speedLabel(speed);
    el.sleepBtn.innerHTML = icon(I.moon, 16) + (sleep === "off" ? "" : sleep === "chapter" ? "End of chapter" : sleepLeft !== null ? time(sleepLeft) : sleep + " min");
    el.sleepBtn.setAttribute("aria-label", sleep === "off" ? "Sleep timer" : sleep === "chapter" ? "End of chapter" : sleep + " min");
    el.textTop.setAttribute("aria-pressed", String(textOn));
    el.textLab.setAttribute("aria-pressed", String(textOn));
    el.now.textContent = time(t);
    el.len.textContent = time(c ? c.seconds : 0);
    const book = bookLine();
    el.book.firstChild.style.width = book.pct + "%";
    el.of.textContent = "chapter " + (ci + 1) + " of " + chapters.length;
    el.left.textContent = left(book.left);
    renderTrack();
    renderFollow();
    renderSheet();
    renderPoster();
    showPicture(c ? pictureAt(c, t) : { at: 0, src: options.cover || null });
    syncSession();
    syncPosition();
  }

  // ---- the phone's lock screen and a headset (R-71) ---------------------------------------------
  const session = options.mediaSession || (nav && nav.mediaSession ? nav.mediaSession : null);
  let sessionKey = "";
  /** The lock screen fetches the artwork itself, so it is named in full where the page has a base. */
  const absolute = (src) => {
    try {
      return new URL(src, doc.baseURI || (win.location && win.location.href) || undefined).href;
    } catch {
      return src;
    }
  };
  function syncSession() {
    if (!session) return;
    const c = chapter();
    const key = (c ? c.id : "") + "|" + (shownSrc || "");
    const Metadata = options.MediaMetadata || win.MediaMetadata;
    if (key !== sessionKey && typeof Metadata === "function") {
      sessionKey = key;
      try {
        session.metadata = new Metadata({
          title: c ? "Chapter " + pad(c.order) + (ownTitle(c) === "" ? "" : " · " + c.title) : options.title,
          album: options.title,
          artwork: shownSrc ? [{ src: absolute(shownSrc) }] : [],
        });
      } catch {
        // An artwork the session cannot take is left off; the words still show.
      }
    }
    try {
      session.playbackState = playing ? "playing" : "paused";
    } catch {
      // Read-only in some engines.
    }
  }
  function syncPosition() {
    if (!session || typeof session.setPositionState !== "function") return;
    const c = chapter();
    if (!c || !(c.seconds > 0)) return;
    try {
      session.setPositionState({ duration: c.seconds, playbackRate: speed, position: Math.min(t, c.seconds) });
    } catch {
      // A position the engine refuses is left out.
    }
  }
  const sessionActions = {
    play: () => play(),
    pause: () => pause(),
    seekbackward: () => seek(t - 15),
    seekforward: () => seek(t + 30),
    previoustrack: () => step(-1),
    nexttrack: () => step(1),
    seekto: (details) => seek(details && typeof details.seekTime === "number" ? details.seekTime : t),
  };
  if (session && typeof session.setActionHandler === "function") {
    for (const [action, handler] of Object.entries(sessionActions)) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // An action this engine does not know.
      }
    }
  }

  // ---- presses and keys --------------------------------------------------------------------------
  function step(direction) {
    const target = nextPlayable(ci + direction, direction);
    if (target < 0) return;
    const wasPlaying = playing;
    goChapter(target, 0);
    if (wasPlaying) {
      playing = true;
      startAudio();
    }
    render();
  }
  function cycle(list, value) {
    const at = list.indexOf(value);
    return list[(at + 1) % list.length];
  }
  function act(name, target) {
    if (name === "toggle") (playing ? pause : play)();
    else if (name === "back") seek(t - 15);
    else if (name === "fwd") seek(t + 30);
    else if (name === "prev") step(-1);
    else if (name === "next") step(1);
    else if (name === "speed") {
      speed = cycle(SPEEDS, speed);
      for (const audio of players) applyRate(audio);
      save();
      render();
    } else if (name === "sleep") {
      sleep = cycle(SLEEPS, sleep);
      sleepLeft = typeof sleep === "number" ? sleep * 60 : null;
      save();
      render();
    } else if (name === "text") {
      textOn = !textOn;
      save();
      render();
    } else if (name === "chapters") {
      sheetOpen = !sheetOpen;
      render();
    } else if (name === "chapter") {
      const index = Number(target.getAttribute("data-index"));
      if (!playable(index)) return;
      const wasPlaying = playing || mode === "poster";
      mode = "playing";
      goChapter(index, 0);
      sheetOpen = false;
      if (wasPlaying) play();
      else render();
    } else if (name === "continue") {
      mode = "playing";
      play();
    } else if (name === "restart") {
      mode = "playing";
      const first = nextPlayable(0, 1);
      if (first >= 0) goChapter(first, 0);
      play();
    } else if (name === "close") {
      pause();
      if (options.onClose) options.onClose();
    }
  }
  function onClick(event) {
    const target = event.target && event.target.closest ? event.target.closest("[data-act]") : null;
    wake();
    if (!target || !root.contains(target) || target.disabled) return;
    act(target.getAttribute("data-act"), target);
  }
  function onKey(event) {
    wake();
    if (event.key === "Escape") {
      if (sheetOpen) {
        sheetOpen = false;
        render();
      } else if (options.onClose) act("close");
      return;
    }
    if (mode === "poster") return;
    const onButton = event.target && event.target.tagName === "BUTTON";
    if ((event.key === " " && !onButton) || event.key === "k" || event.key === "K") {
      if (event.preventDefault) event.preventDefault();
      act("toggle");
    } else if (event.key === "ArrowLeft") {
      if (event.preventDefault) event.preventDefault();
      seek(t - 5);
    } else if (event.key === "ArrowRight") {
      if (event.preventDefault) event.preventDefault();
      seek(t + 5);
    }
  }
  // The scrubber: a press or a drag seeks the chapter, the arrows move it when it has focus.
  let dragging = false;
  function seekFromPointer(event) {
    const box = el.line.getBoundingClientRect ? el.line.getBoundingClientRect() : null;
    const c = chapter();
    if (!box || !c || !(box.width > 0)) return;
    seek(((event.clientX - box.left) / box.width) * c.seconds);
  }
  const onDown = (event) => {
    dragging = true;
    if (el.track.setPointerCapture && event.pointerId !== undefined) {
      try { el.track.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    }
    seekFromPointer(event);
  };
  const onMove = (event) => {
    if (dragging) seekFromPointer(event);
  };
  const onUp = () => {
    dragging = false;
  };
  function wake() {
    root.classList.remove("abp-wake");
    void root.offsetWidth;
    root.classList.add("abp-wake");
  }

  for (const audio of players) {
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlayState);
    audio.addEventListener("pause", onPlayState);
  }
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  root.addEventListener("pointermove", wake);
  el.track.addEventListener("pointerdown", onDown);
  el.track.addEventListener("pointermove", onMove);
  el.track.addEventListener("pointerup", onUp);
  el.track.addEventListener("pointercancel", onUp);

  if (playable(ci)) {
    if (t < 1e-3) gapNote = leadingGap();
    segIndex = segAt(chapter(), t);
    hold(cur, segIndex, Math.max(0, t - chapter().audio[segIndex].at));
    primeNext();
  }
  if (mode === "playing") play();
  else render();
  wake();

  return {
    /**
     * A newer plan for the same book — a take landed while the listener listens (R-67): the
     * place is kept by its block, and the piece playing plays on unless it is gone.
     */
    update(next) {
      // A place held through a plan with nothing to play is the one to come back to (codex on PR 1495).
      const place = heldPlace || placeHere();
      heldPlace = null;
      const playingSrc = holds[cur] >= 0 && chapter() ? (chapter().audio[holds[cur]] || {}).src : null;
      const offsetInPiece = players[cur].currentTime || 0;
      chapters = normalise(next);
      const found = place ? resolve(place) : null;
      const from = found ? found.index : 0;
      // The place's chapter, else the next with takes, else the last one before it with takes.
      const landed = found && playable(found.index) ? found.index : nextPlayable(from, 1) >= 0 ? nextPlayable(from, 1) : nextPlayable(Math.min(from, chapters.length - 1), -1);
      if (landed < 0) {
        // Nothing left to play: what was sounding stops rather than going on as stale narration (codex on PR 1493).
        for (const audio of players) {
          quietPause(audio);
          audio.removeAttribute("src");
        }
        holds[0] = holds[1] = -1;
        playing = false;
        lastTick = null;
        heldPlace = place;
        ci = Math.min(ci, Math.max(0, chapters.length - 1));
        t = 0;
        render();
        return;
      }
      ci = landed;
      const c = chapter();
      const still = playingSrc ? c.audio.findIndex((a) => a.src === playingSrc) : -1;
      if (still >= 0 && found && found.index === ci) {
        // The element playing holds a piece the new plan still has: it plays on untouched.
        segIndex = still;
        holds[cur] = still;
        holds[1 - cur] = -1;
        t = c.audio[still].at + offsetInPiece;
        primeNext();
        render();
        return;
      }
      holds[0] = holds[1] = -1;
      seek(found && found.index === ci ? found.t : 0);
    },
    /** Another read takes the app's voice: the book pauses where it is. */
    pause() {
      if (playing) pause();
    },
    destroy() {
      for (const clip of clips) { clip.removeEventListener("error", onClipError); clip.pause?.(); clip.removeAttribute("src"); }
      for (const audio of players) {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("timeupdate", onTime);
        audio.removeEventListener("play", onPlayState);
        audio.removeEventListener("pause", onPlayState);
        try { audio.pause(); } catch { /* not playing */ }
        audio.removeAttribute("src");
      }
      if (session && typeof session.setActionHandler === "function") {
        for (const action of Object.keys(sessionActions)) {
          try { session.setActionHandler(action, null); } catch { /* unknown action */ }
        }
      }
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("pointermove", wake);
      root.classList.remove("abp", "abp-wake");
      root.removeAttribute("data-mode");
      root.innerHTML = "";
    },
  };
}

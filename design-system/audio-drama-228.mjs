// Design only. Generate turn 228 and its interactive review without changing prior turns.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen, FRAMES, esc } from './audio-drama-228.view.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, value) => fs.writeFileSync(path.join(here, name), value);
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="audio-drama-228.css">';
const tokenLinks = ['fonts','colors','typography','spacing','effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('\n');
write('audio-drama-228.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Audio Drama · Arke turn 228</title>${tokenLinks}${STYLE}</head><body class="ad-review"><header class="ad-review-head"><h1>Audio Drama · turn 228</h1><p>Proposed · revision 1 · 17 October 2026. Interactive design fixture, not an implemented production. Invented story and voices; no audio generation.</p><nav aria-label="Design views">${FRAMES.map(([,t,v]) => `<button data-view="${v}">${esc(t)}</button>`).join('')}<a href="audio-drama-228.notes.md">Design notes</a><a href="../docs/research/audio-drama-adaptation.md">Research</a></nav></header><main id="canvas" class="ad-review-canvas" aria-label="Production design"></main><dialog id="detail" class="ad-dialog"></dialog><script type="module" src="audio-drama-228.review.js"></script></body></html>`);
const rules = [
 ['A separate production','Audio Drama owns an adapted script and cast. Creating it from a Story pins a source edition and never rewrites the novel or its audiobook. Narrated drama, ensemble drama and in-world recordings are approaches, not competing data models.'],
 ['Read before adapting','The adaptation plan records source coverage and unread or deferred material. Every source beat has a destination or a reason for omission. Episode boundaries need not match chapters. Estimates include planned pauses and are distinguished from measured audio.'],
 ['A script written for the ear','Reuse turn 227’s writing room and turn 225’s Chat. Typed dialogue, narration, sound, ambience, music, silence and scene direction replace undifferentiated prose. Directions are not spoken. Listener position and withheld knowledge belong to each scene.'],
 ['Accountable changes','Source links are stable IDs and pinned versions with change detection. A later source revision opens a comparison and a keep-with-reason or script-proposal decision. No automatic script, cast, take or arrangement overwrite.'],
 ['Cast characters, then an exchange','Reuse the character and voice foundation. Actor direction is distinct from single-narrator portrayal. Show the character baseline, production override, scene intention and local delivery; disclose the effective provider request before generation. Missing voices block their lines rather than silently falling back.'],
 ['Performance context','Audition a short exchange in context. Preserve speaker identity independently from voice and acoustic channel. Carry necessary neighbouring context without including it as unwanted speech. A provider’s mixed dialogue output is not falsely presented as separate actor stems.'],
 ['One Audio Studio','Use turn 226 and the implemented arrangement contracts, coordinator, timeline, inspector, library, Current/Suggested review and render plan. Generalise the chapter source binding to a script unit; do not create a second mixer or mutable timeline. Scene work feeds explicit episode sequencing.'],
 ['Sound has an anchor','Cues attach to stable script beats or measured timing. Deletion or timing changes create a repair decision. Planned silence and ambience are distinct. Overlaps are explicit and assessed for intelligibility, never an accidental consequence of concatenated clips.'],
 ['Review the evidence','Script review checks adaptation fidelity, orientation, knowledge and performability. Listening review names exact script/cast/mix versions and covered intervals. Text-only or partial reviews never claim to have heard the complete scene. Fixes are inspectable proposals.'],
 ['Chat orchestrates','The existing production Chat delegates bounded adaptation, performance, sound and review work through task-specific prompts and capabilities. The coordinator owns versions, durable jobs, spend and acceptance. Agents share evidence, not mutable world ownership.'],
 ['An edition is a snapshot','Episode or compiled audio delivery captures script, cast, approved takes, arrangement, transcript, credits and source provenance. Missing assets, stale cues, unresolved scope decisions and selected delivery checks are visible. RSS hosting is outside the first release.'],
 ['Phone and keyboard','The same script works on phone; source and inspector become sheets. Touch controls are at least 44 px, focus is visible, and script operations have keyboard alternatives. The existing compact Audio Studio remains the arrangement surface.'],
 ['Proposal boundary','This turn adds HTML design drawings and research, not application behaviour. Implementation needs contracts, source adapter, episode composition, capability-aware request compilation and private spec amendments. See the notes for staged delivery and acceptance criteria.'],
];
const frames = FRAMES.map(([letter,title,view]) => ({ id:'228'+letter,title,view,width:view==='phone'?390:1360, markup:screen(view,{source:view!=='phone'}) }));
const turn = `<section class="dv-turn" id="t228"><div class="dv-thd"><a class="dv-tid" href="#t228">228</a><span class="dv-tname">Audio Drama · adapt, perform, arrange and review</span></div><p class="dv-next">17 October 2026 · Revision 1 · Proposed · ${frames.length} HTML drawings. <a href="audio-drama-228.review.html">Interactive review</a> · <a href="audio-drama-228.notes.md">Design notes</a></p><div class="dv-opts">${frames.map(f=>`<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([t,b],i)=>`<p class="dv-rule"><b>${i+1} · ${esc(t)}.</b> ${esc(b)}</p>`).join('\n')}</section>\n`;
let master = read('Arke Studio.dc.html');
const old = master.indexOf('<section class="dv-turn" id="t228">');
if(old>=0){const end=master.indexOf('<section class="dv-turn"',old+1);if(end<0)throw Error('No following turn');master=master.slice(0,old)+turn+master.slice(end);}
else {const below=[...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m=>Number(m[1])>0&&Number(m[1])<228);if(!below)throw Error('No insertion point');master=master.slice(0,below.index)+turn+master.slice(below.index);}
if(!master.includes(STYLE))master=master.replace('<helmet>','<helmet>\n'+STYLE);
write('Arke Studio.dc.html',master);
let build=read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN AUDIO DRAMA 228[\s\S]*?  \/\/ END AUDIO DRAMA 228(?:\r?\n)*/g,'\n');
const entries=frames.map(f=>`  { group: "Audio Drama · turn 228", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Audio Drama / Episodes / Scene", status: "drawn", checked: "2026-10-17", controls: [], notes: ["Proposed design, not implemented. See audio-drama-228.notes.md."] },`);
build=build.replace('const SCREENS = [','const SCREENS = [\n  // BEGIN AUDIO DRAMA 228\n'+entries.join('\n')+'\n  // END AUDIO DRAMA 228\n');
const entry='{ file: "audio-drama-228.review.html", what: "Turn 228: source-linked Audio Drama adaptation, typed script, casting, reused Audio Studio, listening review, editions and source changes.", state: "proposed; interactive design fixture" }';
if(build.includes('file: "audio-drama-228.review.html"'))build=build.replace(/\{ file: "audio-drama-228\.review\.html",[^\n]+?\}/,entry);
else build=build.replace('const PAGES = [','const PAGES = [\n  '+entry+',');
if(!build.includes(STYLE))build=build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">',STYLE+'\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs',build);
console.log(`Registered proposed turn 228: ${frames.length} drawings, ${rules.length} rules.`);

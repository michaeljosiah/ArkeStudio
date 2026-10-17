// Turn 228 · the Stage, uplifted (epic #1826). Writes the review page and, unless --preview, places
// the turn in the design master and registers its frames with build-review.
//   node design-system/stage-228.renders.mjs   (only after a scene edit: the stills and labels)
//   node design-system/stage-228.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './stage-228.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="stage-228.css">';
// The root carries data-screen-label: build-review and the shooting drivers find a frame by it.
const frames = FRAMES.map(([letter, title, width, height, markup]) => ({ id: '228' + letter, title, width, height, markup: markup.replace(/^<div class="st228/, `<div data-screen-label="228${letter} ${esc(title)}" class="st228`) }));
for (const f of frames) if (!f.markup.startsWith('<div data-screen-label=')) throw new Error(`${f.id}: frame root is not .st228`);

// The evidence beside the frames: the same stage in both looks, and the four cameras in Lit.
const evidence = `<section id="evidence"><h2>Evidence · the same scene, today’s renderer and the proposed one</h2><div class="ev"><figure><img src="assets/stage-228-over-grey.jpg" alt="Greybox overview"><figcaption>Greybox · today</figcaption></figure><figure><img src="assets/stage-228-over-lit.jpg" alt="Lit overview"><figcaption>Lit · proposed</figcaption></figure></div><div class="ev ev4">${['shot1-plate', 'shot1-lit', 'shot2-lit', 'shot3-lit', 'shot4-lit', 'shot1-grey'].map(n => `<figure><img src="assets/stage-228-${n}.jpg" alt="${n}"><figcaption>${n}</figcaption></figure>`).join('')}<figure><img src="assets/stage-228-plate.jpg" alt="plate"><figcaption>plate (stand-in)</figcaption></figure></div></section>`;

write('stage-228.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stage uplift · Turn 228</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}.ev{display:flex;gap:12px;flex-wrap:wrap}.ev figure{margin:0}.ev img{width:660px;border-radius:8px;display:block}.ev4 img{width:180px}.ev figcaption{font:var(--type-meta);margin-top:4px}</style></head>
<body><div class="rv"><header><b>Turn 228 · the Stage, uplifted · approved</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t228" style="color:inherit">Design master</a><a href="stage-228.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}
${evidence}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote stage-228.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '17 October 2026. Approved by the owner the same day; implementation is tracked in epic #1826 (issues #1817–#1825). Nothing is built yet. The viewport pictures are real renders of the proposed look from stage-228.render.mjs (three.js, the app’s own engine), not paintings: a kit-built lobby, jointed figures posed by name with two-bone IK, AgX, soft shadows, GTAO, fog and a night sky. The plate is a stand-in: an empty corner of Na Love or Juju’s nloj-backdrop.jpg, cropped to 9:16, because the world holds no empty location picture yet. A real plate is one image generation away.'],
  ['The look', 'The viewport’s top-right holds Look, in this order: Greybox · Lit · Plate, before the ghost toggle (228a, 228b). Greybox is today’s drawing, kept whole. Lit draws set items by their material tag and lights them with their practical lights. It uses AgX tone mapping, soft shadows fitted to the set’s bounds, contact shading (GTAO), haze and the production’s sky. Plate paints the set with the plate from its matching camera, and outside that frustum the set is a neutral grey. A playblast records the look it was exported in and says so on its tile. Every look renders the same pixels for the same time; recording hides labels, rigs, the grid and the PiP. In Lit and Plate, labels are chips with their own ground, so 140’s fixed light ground binds Greybox only.'],
  ['Figures', 'A figure is a jointed mannequin of about fifteen joints with a nose, so its facing reads in any view and at any size. Cast colours have strong contrast against a neutral set; they replace 140’s burgundy, ochre, slate, dark blue and brown, in order: blue #2f7fd8, magenta #d6336c, then four more chosen the same way. The capsule figure survives only in Greybox.'],
  ['The plate', 'A plate is a picture of the empty location. It sits first on the blockout line (Lobby · plate; Add plate, dashed, when there is none) and second in the stage list. Its form (228c) holds the picture, Replace, the shot it matches, lens and horizon height (both editable, because the build only estimated them), the light read from it as data, and whether it rides as Image 1. Match camera puts the matched shot’s first key where the plate was taken from. In Camera mode the match shows as data at the lens’s foot: horizon, lens, match score. The plate is part of the build’s source, so replacing it makes the blockout stale.'],
  ['The camera in words', 'With the camera selected, the form is words first (228a): subject, size (Wide · Med · MCU · CU), angle (Eye · Low · High · Top), side, lens and move. One mono line under them states the position and aim they resolve to. Edit as numbers opens 144’s numeric form, and a hand edit there drops the words for that key. The words are what is kept; a change of lens or a retime resolves them again.'],
  ['Poses and contacts', 'A figure’s mark carries a pose (228d) from one list: Stand, Sit, Lie, Walk, Lean on, Reach, Point, Wipe, Crouch, Stumble, Fall, Arms crossed, Phone to ear, Carry, Hands on hips. A hand (Left · Right · Both) can be put on a figure’s part or on a set, and the figure can look at a figure or a set. In Camera mode a contact shows as a label at the hand. The figure’s lane prints the pose name where it changes, and a held pose is a bar. A turn faster than about 180° per second marks the figure’s list line in the warning colour, with the time.'],
  ['Kit and lights', 'Add set opens the kit (228e): Room, Doorway, Window, Stairs, Counter, Booth, Table and chairs, Armchair, Sofa, Bed, Planter, Tree, Lamp, Car, Street and Facade, then Box, Cylinder, Sphere and Mesh under a rule. A Room’s form holds size, its open sides, ceiling, its openings as a list and its surfaces. Each surface has a swatch and a material: marble, plaster, wood, stone, metal, glass, fabric, leather, foliage, screen or neon. A Lamp brings its light. A light’s form holds kind, colour in kelvin, strength, reach, shadow, place and what it aims at. The production’s Look (time, sky, haze, shading) sits under it, because it belongs to no one light.'],
  ['The stage list', 'The stage list reads camera, plate, the cast, then set and lights, each a mono group header with its count. Kit items group onto one line when there are more than four of a kind (planter · palm · lamp), and the selected one always shows alone.'],
  ['Building', 'While Build with Arke runs, the line’s button is Stop and the disclosure reads Working (228f). A log opens over the viewport’s top-left. It has one line per step: a glyph (done, running, waiting), the step and its data. A render step shows its stills, the plate beside the build. Its head counts the round, the calls and the elapsed time. Each step lands on the stage as it completes, and the panel is locked until the build stops. The log holds steps and data only: no explanation, no reassurance.'],
  ['Board 1', 'When the shot belongs to a board, the head row carries This shot · Board 1 (228g). On Board 1:'],
  ['The Bench', 'A video session numbers its references in the order they are sent: Image 1, Image 2, Video 1 (228h). Each shows its source and the name the prompt uses. The drafted prompt is an opening line naming each reference, one line per cut with its time span, and a closing follow line. Follow (Camera + action · Camera only) rewrites only that closing line, and the choice is recorded on the take. No world coordinates reach the prompt.'],
  ['Implementation boundary', 'Design only; SPEC-036 §1.13 is amended in the private set when a slice is built. The stills come from stage-228.renders.mjs and must be rerun after a scene edit. The order in the epic stands: the prompt and Follow (#1817), the plate (#1818), the kit (#1819) with the look (#1825), words for the camera (#1820), poses (#1821), the brief (#1822), the build as tools (#1823), then the board (#1824).'],
];
// Board 1's body as a list, since it would not fit one plain sentence.
rules[9][1] += ' the viewport shows every camera, numbered; the PiP plays the animatic at the playhead; the track is the cut list, a block per shot with its number and name; and the figure lanes run across the cuts. The board’s form lists the shots with their durations, the total against the model’s limit, the 180° line check over every cut (a crossing names the pair, with Flip), whether the action is shared or per shot, and whether the cuts are hard or only marked. The foot is the animatic: filed, Export animatic, Render with this.';

const turn = `<section class="dv-turn" id="t228"><div class="dv-thd"><a class="dv-tid" href="#t228">228</a><span class="dv-tname">The Stage, uplifted &#8212; a plate to build from, a look worth sending, figures that pose, a kit, a board and a prompt written for the video model (epic #1826; amends <a class="dv-oid" href="#t140">140</a>&#8217;s viewport and <a class="dv-oid" href="#t144">144</a>&#8217;s forms)</span></div><p class="dv-next">17 October 2026 · Approved · epic #1826 · ${frames.length} HTML drawings around real renders. <a href="stage-228.review.html">Review page</a> · <a href="stage-228.notes.md">Notes</a></p><div class="dv-opts" style="margin-top:22px">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “the plate generated in the app” · “a crossing on the board” · “the Lit look on a phone”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t228">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 228, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 228);
  if (!below) throw new Error('No turn below 228 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN STAGE 228[\s\S]*?  \/\/ END STAGE 228(?:\r?\n)*/g, '\n');
const entries = frames.map(f => `  { group: "Stage · turn 228", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Scene / shot / Stage (full screen)", status: "drawn", checked: "2026-10-17", controls: [], notes: ["Approved 17 October 2026; implementation tracked in #1826."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN STAGE 228\n' + entries.join('\n') + '\n  // END STAGE 228\n');
const pageEntry = '{ file: "stage-228.review.html", what: "Turn 228: the Stage with a location plate, the Lit and Plate looks, jointed figures with poses and contacts, the kit and lights, the camera in words, Build with Arke as a working log, Board 1 with a cut animatic, and the Bench prompt written as timed cuts with Follow.", state: "approved; implementation tracked in #1826" }';
if (build.includes('file: "stage-228.review.html"')) build = build.replace(/\{ file: "stage-228\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 228: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);

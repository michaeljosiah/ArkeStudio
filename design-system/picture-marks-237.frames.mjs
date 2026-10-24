// Turn 237 · Picture marks: the frames. The sample is Na Love or Juju's Chapter 1, Gold on Gold, as it
// stands on 24 October 2026: 26 blocks grouped into 24 beats, 20:28 read in one designed voice, and 15
// pictures, one at the start of each pictured beat. Its first beat, The goat story, runs 2:12 under one
// picture. That picture is Tunde pulling the goat face, a moment 34 seconds in, shown from 0:03 because
// a picture can only start where a block does. The words are the author's; the times of moments inside
// a take are drawn as word timing would give them. Every frame's root is .ap237 with its data-screen-label.
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>';

const GOAT_FACE = 'assets/t237-tunde-face.jpg';
const BOOTH = 'assets/t237-booth.jpg';
const TUNDE = 'assets/t237-tunde.jpg';
const ADE = 'assets/t237-ade.jpg';
const IFE = 'assets/t237-ife.jpg';
const PLAN = 'ChatGPT plan';
const PAGE = '<div class="ap237-page">' + [28, 92, 88, 95, 60, 90, 84, 93, 70, 89, 91, 55, 80, 66, 88, 74].map((w) => `<i style="width:${w}%"></i>`).join('') + '</div>';

const root = (label, width, height, inner) => `<div class="ap237" data-screen-label="${label}" style="width:${width}px;height:${height}px">${inner}</div>`;

// The chapter's bar as built: the view's tabs, the reading, the cast, Blocks with its beats, then Direct and illustrate, Export and Listen.
const BAR = `<div class="ap237-bar"><span class="ap237-tabs"><span>Chapter</span><span>Manuscript</span><span class="on">Audiobook</span><span>Audio Studio</span></span>
<span class="ap237-press plain"><i>Performed &#183;</i> Nigerian Woman 2 ${CHEVRON}</span><span class="ap237-press">Notes</span><span class="ap237-press">Everyone <i>26</i> ${CHEVRON}</span><span class="ap237-press">Blocks <i>24 beats</i> ${CHEVRON}</span>
<span class="grow"></span><span class="ap237-press">Direct and illustrate ${CHEVRON}</span><span class="ap237-press">Export&#8230;</span><span class="ap237-press pri">${PLAY} Listen</span></div>`;

// The goat story, as the view draws a beat of several turns: one row a turn, each with who speaks.
// `{n}` marks where a picture's mark stands in the row; the rest of the row runs on after it.
const GOAT = [
  ['narrator', '{0}Tunde was telling the goat story again.'],
  ['narrator', 'Ade had been in the car the first time it happened, on the Ibadan expressway in 2004, and he had heard it told since at two weddings, one naming ceremony and Tunde&#8217;s fortieth, and every time the goat grew larger and the customs officer more corrupt and Tunde&#8217;s cousin from Ilesha more heroic. Tonight the goat had learned to open doors.'],
  ['Ade', '&#8220;It is not possible,&#8221;'],
  ['narrator', 'Ade said.'],
  ['Tunde', '&#8220;Ade, I am telling you. The goat looked at me like this &#8212;&#8221;'],
  ['narrator', '{1}Tunde widened his eyes and lowered his chin, and the effect, under the purple lights of the club, was so exactly that of an offended goat that Ade had to put his glass down.'],
  ['Tunde', '&#8220;&#8212; like say na me get the car.&#8221;'],
  ['Ade', '&#8220;The goat was in the boot, Tunde.&#8221;'],
  ['Tunde', '&#8220;Ehn-ehn. The goat was in the boot <span class="plate">[emphasis]</span> spiritually,&#8221;'],
  ['narrator', 'Tunde said.'],
  ['Tunde', '&#8220;Physically, he was in front.&#8221;'],
  ['narrator', 'Ade laughed until his chest hurt. It was the laugh only Tunde could get out of him: undignified, helpless, a laugh that belonged to the boy he had been at Unilag, sharing a room in Mariere Hall with a boy who could not cook and would not stop talking.'],
  ['narrator', '{2}Around them the club pressed on in the way Victoria Island clubs did after midnight: an amapiano log drum thudding up through the floor, the DJ shouting somebody&#8217;s birthday into the microphone, bottle girls threading between tables with sparklers held high over magnums of champagne, so that every few minutes one corner of the room went white and celebratory and then dark again. {3}Tunde had chosen the place. Tunde had chosen the table, a low leather booth near enough the dance floor to be seen and far enough to be heard, and had ordered without consulting anyone. When the waitress came back with the card machine, Ade already had his card out. Tunde did not pause in his story. Neither of them looked at the total.'],
  ['narrator', 'It had been like that for twenty years.'],
];

const whoClass = (who) => (who === 'Tunde' ? ' tunde' : who === 'Ade' ? ' ade' : '');
const chip = (mark) => mark.made
  ? `<span class="ap237-chip${mark.on ? ' on' : ''}"><img src="${mark.made}" alt="">${mark.at}</span>`
  : `<span class="ap237-chip prop${mark.on ? ' on' : ''}"><i></i>${mark.at}${mark.title ? ` &#183; <b>${mark.title}</b>` : ''}</span>`;
const pin = (mark) => (mark.place ? '<span class="ap237-place">+ Picture</span>' : `<span class="ap237-pin${mark.made ? '' : ' prop'}${mark.on ? ' on' : ''}"></span>`);

// One beat: its head, then its rows; a row carrying a mark draws the mark before its first word and
// the mark's chip at the row's end. `marks` maps the `{n}` slots; a slot not given draws nothing.
function beat({ name, whose, paragraphs, length, pictures, rows, marks, from = 0, to = rows.length, sel = false }) {
  const head = `<div class="ap237-beat"><b>${name}</b><span>${whose} &#183; ${paragraphs} paragraphs &#183; ${length}${pictures ? ` &#183; <em>${pictures}</em>` : ''}</span></div>`;
  const drawn = rows.slice(from, to).map(([who, text]) => {
    const here = [];
    const words = text.replace(/\{(\d)\}/g, (_, slot) => {
      const mark = marks[slot];
      if (mark === undefined) return '';
      if (!mark.place) here.push(mark);
      return pin(mark);
    });
    // Each chip stands level with the line its mark is on (a 22.4 px line: --text-base at 1.6), so
    // two marks in one long row read as two, each beside its own words.
    let y = 0;
    const ends = here.map((mark) => {
      const top = Math.max(y, (mark.line ?? 0) * 22.4 - 3);
      const gap = top - y;
      y = top + 34;
      return gap > 0 ? chip(mark).replace('<span class="ap237-chip', `<span style="margin-top:${gap.toFixed(1)}px" class="ap237-chip`) : chip(mark);
    });
    return `<div class="ap237-row"><span class="ap237-who${whoClass(who)}"><i></i>${who}</span><p class="ap237-text">${words}</p><span></span><span class="ap237-ends">${ends.join('')}</span></div>`;
  }).join('');
  return `<div class="ap237-block${sel ? ' sel' : ''}">${from === 0 ? head : ''}${drawn}</div>`;
}

const TITLE = '<div class="ap237-block"><div class="ap237-row"><span class="ap237-who"><i></i>title</span><p class="ap237-text">Chapter 1 &#183; Gold on Gold</p><span></span><span class="ap237-ends"></span></div></div>';
const NEXT = beat({
  name: 'Teasing the board memo', whose: 'Tunde', paragraphs: 5, length: '0:30', pictures: '1 picture',
  rows: [['Tunde', '{0}&#8220;You should come out more,&#8221; Tunde said, when the goat had finally been delivered to its owner in Ilesha. &#8220;Look at you. You&#8217;re enjoying yourself and you don&#8217;t even want to admit it.&#8221;']],
  marks: { 0: { at: '2:05', made: BOOTH } },
});

// The goat story with three marks: the goat face moved to its words at 0:37, and Illustrate's two
// proposals at 0:03 and 1:20 for one picture about every 45 s.
const MARKS_A = { 0: { at: '0:03', title: 'The goat story' }, 1: { at: '0:37', made: GOAT_FACE }, 2: { at: '1:20', title: 'The club after midnight' } };

// The panel's card for a mark not made yet: 235's card with both slots dashed.
const fact = (label, value) => `<div class="ap237-fact"><span>${label}</span><b>${value}</b></div>`;
const person = (img, name, sub) => `<div class="ap237-person"><img src="${img}" alt=""><div><b>${name}</b><span>${sub}</span></div></div>`;
const PANEL = `<aside class="ap237-panel"><div class="ap237-ph"><b>Picture at 1:48</b><span>The goat story &#183; holds 17 s &#183; to 2:05</span></div>
<div class="ap237-ptabs"><span>Read</span><span class="on">Picture</span><span>Motion</span></div>
<div class="ap237-card"><div class="ap237-top"><div class="ap237-shapes"><figure><span class="ap237-slot wide">16:9</span><figcaption>Wide</figcaption></figure><figure><span class="ap237-slot tall">9:16</span><figcaption>Tall</figcaption></figure></div>
<div class="ap237-facts">${fact('Frame', 'Medium &#183; the booth')}${fact('Rides', '2 references')}${fact('Model', `Codex Image &#183; ${PLAN}`)}</div></div>
<div class="ap237-sec"><span class="ap237-h">In frame</span><div class="ap237-cast">${person(TUNDE, 'Tunde', 'medium')}${person(ADE, 'Ade', 'medium')}</div></div>
<div class="ap237-sec"><span class="ap237-h">Words</span><p class="ap237-prompt">Tunde had chosen the place. Tunde had chosen the table, a low leather booth near enough the dance floor to be seen and far enough to be heard, and had ordered without consulting anyone. When the waitress came back with the card machine, Ade already had his card out.</p></div>
<div class="ap237-foot"><span class="ap237-btn ghost">Remove</span><span class="grow"></span><span class="ap237-btn">Edit prompt</span><span class="ap237-btn pri">Generate &#183; ${PLAN}</span></div></div></aside>`;

// Illustrate's proposal at 45 s: cards for moments inside beats, each naming the beat it falls in.
const ills = (at, frame, words, title, inBeat, who) => `<article class="ap237-ic"><div class="ap237-th"><span class="fr">${frame}</span><span class="tm ap237-mono">${at}</span><p>${words}</p></div>
<div class="ap237-ihd"><b>${title}</b><span>Skip</span></div><div class="ap237-iwh">${who.map(([img, name]) => `<span><img src="${img}" alt="">${name}</span>`).join('')}${inBeat === null ? '' : `<span class="ap237-in">in ${inBeat}</span>`}</div></article>`;
const CARDS = [
  ills('0:03', 'Medium', 'Tunde was telling the goat story again.', 'The goat story', 'The goat story', [[TUNDE, 'Tunde'], [ADE, 'Ade']]),
  ills('1:20', 'Wide', 'Around them the club pressed on in the way Victoria Island clubs did after midnight: an amapiano log drum thudding up through the floor&#8230;', 'The club after midnight', 'The goat story', [[ADE, 'Ade'], [TUNDE, 'Tunde']]),
  ills('2:36', 'Close', 'Ade had left a pot of ofada stew on the cooker at home, enough for two days, or two people.', 'One drink, three glasses', 'Ade takes stock', [[ADE, 'Ade']]),
  ills('5:04', 'Medium', 'She had sat down among friends &#8212; two women, and a man who kept leaning towards her and being, quite gently, ignored.', 'Among her friends', 'Watching her laugh', [[IFE, 'Ife']]),
  ills('5:40', 'Close', 'He was aware, suddenly, of his own body: the collar of his shirt, his hands on his knees&#8230;', 'A heat at his neck', 'Watching her laugh', [[ADE, 'Ade']]),
  ills('6:10', 'Medium', 'Tunde stared at him. Then he put a hand flat on the table and laughed until he coughed.', 'Like a weather report', 'Go and greet her', [[TUNDE, 'Tunde'], [ADE, 'Ade']]),
  ills('6:54', 'Wide', 'The dance floor was full, and crossing it took longer than it should have.', 'Crossing the floor', 'Crossing the floor', [[ADE, 'Ade']]),
  ills('7:22', 'Medium', 'Her friends saw him first. One said something and the other laughed.', 'Her friends see him first', 'Crossing the floor', [[IFE, 'Ife'], [ADE, 'Ade']]),
  ills('10:24', 'Close', 'The music was loud and she spoke softly, so he had to lean in to hear her.', 'Always the one leaning in', null, [[IFE, 'Ife'], [ADE, 'Ade']]),
  ills('11:50', 'Close', 'He knew he had been in the middle of a sentence. He knew roughly where it had been going. He could not find a single word of it.', 'The lost sentence', 'Her hand, his arm', [[ADE, 'Ade'], [IFE, 'Ife']]),
  ills('17:02', 'Wide', 'In the kitchen the ofada stew sat on the cooker where he had left it, covered, cold. Beside it, a pot of rice, enough for two.', 'Rice for two', 'The empty house', [[ADE, 'Ade']]),
  ills('18:50', 'Medium', 'He thought about her mouth when she had imitated him. He thought about the gold at her ear swinging against her jaw&#8230;', 'Gold, remembered', 'Blue ticks, nothing', [[IFE, 'Ife']]),
].join('');

const box = `<span class="ap237-box">${CHECK}</span>`;

export const FRAMES = [
  ['a', 'Pictures on the words: one beat, three pictures', 1360, 980, () => root(
    '237a Chapter 1&#8217;s first beat, The goat story, 2:12 read as one take: three pictures, each marked before the words it shows from with its start at the row&#8217;s end; the goat face at 0:37 where Tunde pulls it, and two proposed',
    1360, 980,
    `${BAR}<div class="ap237-blocks">${TITLE}${beat({ name: 'The goat story', whose: 'Tunde', paragraphs: 9, length: '2:12', pictures: '3 pictures', rows: GOAT, marks: MARKS_A })}${NEXT}</div>`,
  )],

  ['b', 'Put a picture at a sentence', 1360, 420, () => root(
    '237b Hovering the start of a sentence inside a beat offers + Picture there, as 198&#8217;s seams offer Join and Split; the beat&#8217;s other marks stay where they are',
    1360, 420,
    `${BAR}<div class="ap237-blocks">${beat({ name: 'The goat story', whose: 'Tunde', paragraphs: 9, length: '2:12', pictures: '3 pictures', rows: GOAT, marks: { ...MARKS_A, 3: { place: true } }, from: 11, to: 14 })}${NEXT}</div>`,
  )],

  ['c', 'A new picture&#8217;s panel', 1360, 640, () => root(
    '237c The mark placed at 1:48 and selected: the Picture panel names its start and how long it holds, the words it shows to the next mark, who is in them, and Generate',
    1360, 640,
    `${BAR}<div class="ap237-split"><div class="ap237-blocks" style="--ab-measure:470px">${beat({ name: 'The goat story', whose: 'Tunde', paragraphs: 9, length: '2:12', pictures: '4 pictures', rows: GOAT, marks: { ...MARKS_A, 3: { at: '1:48', on: true, line: 6 } }, from: 11, to: 14, sel: true })}</div></div>${PANEL}`,
  )],

  ['d', 'Pictures: how often', 1360, 560, () => root(
    '237d The Pictures sheet (235a) gains Pace: 90 s, 45 s or 20 s between pictures, with what that pace makes for the book; Illustrate proposes to it',
    1360, 560,
    `${PAGE}<div class="ap237-dim"></div><div class="ap237-sheet" style="top:56px;width:640px"><h3>Pictures &#183; Na love or Juju</h3><div class="sub">361 pictures &#183; 26 chapters</div><div class="ap237-opts">${[
      `<div class="ap237-opt"><span class="ap237-chk">${box}<b>Wide</b></span><span class="ap237-ratio">16:9</span><span class="grow"></span><i>desktop &#183; tablet</i><em>361 made</em></div>`,
      `<div class="ap237-opt"><span class="ap237-chk">${box}<b>Tall</b></span><span class="ap237-ratio">9:16</span><span class="grow"></span><i>phone</i><em>13 made</em></div>`,
      `<div class="ap237-opt"><b class="k">Model</b><span>Codex Image</span><span class="grow"></span><i>${PLAN} &#183; uses Codex allowance</i></div>`,
      `<div class="ap237-opt new"><b class="k">Pace</b><span class="ap237-seg"><span>90 s</span><span class="on">45 s</span><span>20 s</span></span><span class="grow"></span><i>~950 for the book</i></div>`,
    ].join('')}</div><div class="ap237-foot"><span class="grow"></span><span class="ap237-btn">Done</span></div></div>`,
  )],

  ['e', 'Illustrate at 45 s', 1360, 1000, () => root(
    '237e Illustrate&#8217;s proposal for Chapter 1 at 45 s: twelve pictures for moments inside the beats, each card naming the beat it falls in; the fifteen already standing stay',
    1360, 1000,
    `${PAGE}<div class="ap237-dim"></div><section class="ap237-ills"><header><h3>Illustrate &#183; Chapter 1</h3><span class="ap237-mono">12 pictures &#183; one every 45 s &#183; 12 to make &#183; 15 standing</span><span class="grow"></span><span class="ap237-btn">Illustrate again</span><span class="ap237-btn">Close</span></header>
<div class="ap237-grid">${CARDS}</div>
<footer class="ap237-ifoot"><span class="ap237-btn ghost">Review chapter looks</span><span class="ap237-btn">Refresh references</span><span class="grow"></span><span class="ap237-btn ghost">Discard</span><span class="ap237-btn pri">Accept &#183; ${PLAN}</span></footer></section>`,
  )],
];

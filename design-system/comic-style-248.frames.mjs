// Turn 248 · A graphic novel's comic style: the frames. Every card is the same page, Low Water's
// page 3 from turn 247 (Maren on the flooded pier, "Where are you?", the empty water, "Hsssh"),
// made in that style by ChatGPT Image (the Studio's codex-image route) on 29 October 2026, so the
// cards differ only in how the page is drawn. Each frame's root is .gn248 inside .gn247.
import { FRAMES as T247 } from './graphic-novel-247.frames.mjs';

const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3);
const PLUS = svg('<path d="M12 5v14M5 12h14"/>');
const DOWN = svg('<path d="m6 9 6 6 6-6"/>');

// [id, name, blurb, picture]. The words each seeds are in the notes; the card says the treatment.
export const STYLES = [
  ['world', 'World look', 'The world&#8217;s art direction', 'assets/world-undersong.png'],
  ['manga', 'Manga', 'Black and white, screentone'],
  ['superhero', 'Superhero', 'Bold ink, four colours'],
  ['clean-line', 'Clean line', 'Even line, flat colour'],
  ['noir', 'Noir', 'Black, white, hard light'],
  ['webtoon', 'Webtoon', 'Soft digital colour'],
  ['painted', 'Painted', 'Brushwork, no outline'],
  ['watercolour', 'Watercolour', 'Ink over washes'],
  ['ink-wash', 'Ink and wash', 'Brush and greys'],
  ['vintage', 'Vintage print', 'Halftone on newsprint'],
];
const picture = (id, given) => given ?? `assets/comic-styles/${id}.jpg`;

const grid = (on) => `<div class="gn248-styles">${STYLES.map(([id, name, blurb, given]) => `<div class="gn248-style${id === on ? ' on' : ''}"><div class="pl"><img src="${picture(id, given)}" alt=""><span class="tick">${CHECK}</span></div><div class="tx"><b>${name}</b><span class="s">${blurb}</span></div></div>`).join('')}<div class="gn248-style${on === null ? ' on' : ''}"><div class="pl">${PLUS}<span class="tick">${CHECK}</span></div><div class="tx"><b>Your own</b><span class="s">Describe it</span></div></div></div>`;

const MANGA = 'Japanese manga: black and white only, crisp pen line, grey screentone shading, speed lines and dramatic close-ups.';
const words = (seed, text) => `<div class="gn248-words"><div class="wh">Words for this style<span class="grow"></span><i>${seed}</i></div><div class="ta">${text}</div></div>`;

// 247b's Pages screen with a Style select beside Reading.
const pages = (label) => T247.find(([letter]) => letter === 'b')[5]()
  .replace(/^<div class="gn247" data-screen-label="[^"]*"/, `<div class="gn247 gn248" data-screen-label="${label}"`)
  .replace('<span class="gn247-sel"><b>Reading</b>', `<span class="gn247-sel"><b>Style</b><span class="gn248-sel-style"><img src="${picture('manga')}" alt="">Manga</span>${DOWN}</span><span class="gn247-sel"><b>Reading</b>`);

export const FRAMES = [
  ['a', 'Tell a story: a graphic novel&#8217;s style, picked by its page', 1360, 1250, () => `<div class="gn247 gn248" data-screen-label="248a Tell a story's step two with Graphic novel picked: under the name and Adapt from, Style shows the same page drawn ten ways and Your own; picking one seeds the words, which stay editable" style="width:1360px;height:1250px"><div class="gn247-door"><h2>Tell a story</h2><div class="q">What kind of story?</div><div class="gn247-cards">${[
    ['Novel', 'Chapters, to read.', 'assets/banner-story.png'], ['Audio drama', 'Episodes, for the ear.', 'assets/banner-audio.png'],
    ['Graphic novel', 'Pages, to look at.', picture('superhero')], ['Other', 'Nothing assumed.', ''],
  ].map(([b, s, img]) => `<div class="gn247-card${b === 'Graphic novel' ? ' on' : ''}"><div class="pl">${img ? `<img src="${img}" alt="">` : ''}</div><div class="tx"><b>${b}</b><span>${s}</span></div></div>`).join('')}</div><div class="gn247-field"><label>Name</label><div class="in">Low Water, drawn</div></div><div class="gn247-field"><label>Adapt from</label><div class="in">Low Water &#183; book &#183; 6 chapters<span class="grow"></span>${DOWN}</div></div><div class="gn247-field"><label>Style</label></div>${grid('manga')}${words('SEEDED BY MANGA', MANGA)}<div class="foot"><span class="gn247-btn">Back</span><span class="gn247-btn pri">Plan with Arke</span></div></div></div>`],

  ['b', 'Pages: Style, changed for the pages made next', 1360, 920, () => {
    const screen = pages("248b Pages with Style beside Reading; Style opens the same cards and words; Use style changes the pages made from then on, and the pages already made keep theirs");
    const sheet = `<div class="gn247-dim"></div><div class="gn247-sheet gn248-sheet" style="top:56px;width:860px"><h3>Style &#183; Low Water, drawn</h3><div class="sub">Graphic novel &#183; 24 pages &#183; 23 made in Manga</div>${grid('noir')}${words('SEEDED BY NOIR', 'Crime noir comic: solid black shapes and stark white, hard light carving the figure, almost no midtones, rain and shadow as graphic shapes.')}<div class="gn247-foot"><span class="m">Pages made from now</span><span class="grow"></span><span class="gn247-btn">Cancel</span><span class="gn247-btn pri">Use style</span></div></div>`;
    return screen.replace(/<\/div>$/, `${sheet}</div>`).replace('height:850px', 'height:920px');
  }],
];

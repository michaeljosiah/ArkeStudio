// Arke Player · writes its design master, `Arke Player.dc.html`, and a static review page.
//   node design-system/arke-player.mjs
// The Player master is its own document: turns P1, P2… and frames P1a… never share a number with
// the Studio master's. It borrows the Studio master's document chrome (the dv-* styles) so the two
// read alike, and cites Studio turns by link. Then: node design-system/check-master.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './arke-player.frames.mjs';
import { esc } from './arke-player.view.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const TOKENS = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e';
const DATE = '20 October 2026';

/** A Studio turn, cited by link into the Studio master. */
const S = (n) => `<a class="dv-oid" href="Arke%20Studio.dc.html#t${n}">${n}</a>`;
/** A frame or turn in this master. */
const F = (id) => `<a class="dv-oid" href="#${id.toLowerCase()}">${id}</a>`;

const TURNS = [
  {
    id: 'p1', name: 'The shape of Arke Player — first open, Home, Library, a world, a production',
    lead: `Asked: a phone app, Arke Player, that plays what is made in Arke — productions from worlds shared through Arke, and Arke packages a person adds — reusing the players already drawn in the Studio master. The Studio stays where things are made; the Player is where they are watched, heard, read and played.`,
    rules: [
      ['What it plays', `Arke Player is a phone app for <b>publications</b>: films, micro dramas, interactive movies, visual novels, audiobooks, audio dramas and books. A publication is a frozen edition with its own manifest (SPEC-048, <code>publication.json</code>). The Player <b>never opens a world’s source</b>: no sheets, prompts, takes, settings or unpublished work reach it, and nothing in it edits, generates or spends.`],
      ['Two ways in, no gate', `Things arrive as a <b>share</b> through an Arke account (${F('P2a')}) or as a <b>package</b> added from a file (${F('P2c')}). Neither needs the other: a package plays with no account. First open (${F('P1a')}) is the wordmark over a world’s picture and two presses, <code>Sign in with Arke ↗</code> and <code>Add a package</code>; no tour, no sentence.`],
      ['Four tabs', `<code>Home</code>, <code>Library</code>, <code>Downloads</code>, <code>You</code>, in a bar <code>84</code> high (<code>56</code> pressable, the rest the home indicator’s), icon over label, the current tab in full ink. A page pushed from a tab keeps the bar. On a Fold the bar becomes an <code>88</code>-wide rail (${F('P6e')}).`],
      ['Home is for going on', `Three sections, each absent when empty (${F('P1b')}): <b>Continue</b> — what is in progress, last played first, at most <code>8</code>, cards <code>300 × 169</code>; <b>New</b> — productions added to a shared world since this device last looked, the world on the kind line; <b>Worlds</b> — every world, <code>240 × 135</code>. A Continue card names the kind, the title and where you are as data (<code>Chapter 7 · 19 min left</code>, <code>38 min left</code>, <code>Episode 13</code>, <code>The drowned quarter</code>) over a <code>3</code>-high line of progress. An interactive or visual novel card names its scene and draws no line, because a route has no length (Studio ${S(156)}). The round press resumes in the player; the card opens the production. Finished things leave Continue.`],
      ['Library is every world', `A card per world, <code>358 × 190</code>, under the chips <code>All · Shared · Added</code>, with <code>+</code> (Add a package) in the head (${F('P1c')}). A shared world’s meta line is who shared it and the count (<code>Helen Marsh · 6 productions</code>); an added one’s is <code>Added · 3 productions · 1.4 GB</code>.`],
      ['A world’s page', `The world’s key art as the hero, <code>300</code> high under a back press and ⋯, its name in <code>text-3xl</code>, one meta line, and its logline in at most two lines — the author’s words as published, or nothing (${F('P1d')}). Then its productions grouped by what a person does: <b>Watch</b> (film, micro drama), <b>Play</b> (interactive movie, visual novel), <b>Listen</b> (audiobook, audio drama), <b>Read</b> (a book with no narration). A group with nothing in it is not drawn. A book with its narration is one production, under Listen, its kind line <code>Audiobook · Book</code>. Tiles are <code>160</code> wide, 16:9, with title, kind and length, and the line of progress.`],
      ['A production’s page', `Studio ${S(199)}’s show page on a phone (${F('P1e')}, ${F('P1f')}): the backdrop, the title in <code>text-3xl</code>, <b>one meta line</b> (<code>Audiobook · Book · 9 h 40 m · Read by Odile’s voice</code>), the primary full width and <code>50</code> high — <code>Play</code>, or <code>Continue · Chapter 7 · 12:04</code> when this device holds a place — then one row: the second way in (<code>Read</code>, for a book with narration), the download with its size, and ⋯ (<code>Start over</code>, <code>Remove download</code>, <code>Details</code>). Under it what it is made of: <code>Chapters</code> or <code>Episodes</code> as rows (a <code>128</code> thumbnail with its listened line, the title, the length, a downloaded mark); a micro drama’s episodes as a 4-across grid of 9:16 thumbnails. <code>Cast</code> is drawn only when the publication carries credits.`],
      ['The dock', `Audio that plays while its player is closed docks above the tabs (${F('P1d')}): <code>60</code> high, inset <code>8</code>, a <code>2</code>-high progress line on its top edge, the picture of the moment, the title over where, back 15 and play or pause; a press opens the player (Studio ${S(199)}). Video does not dock: closing its player pauses it and keeps its place, and the phone’s own picture in picture is offered where the system has it.`],
      ['Theme', `The shelves — Home, Library, Downloads, You and the sheets over them — follow the phone’s light or dark. A hero, a picture card and every player are on the media overlay colours whatever the theme (Studio ${S(156)}, ${S(199)}).`],
      ['Words', `Labels only: Home, Library, Downloads, You, Continue, New, Worlds, Watch, Play, Listen, Read, Chapters, Episodes, and counts, sizes and times as data. No sentence under a title (Studio ${S(137)}).`],
    ],
    next: `Try next: “Home with nothing yet” · “a world with one production” · “Details from ⋯”`,
  },
  {
    id: 'p2', name: 'Getting worlds in — a share through an Arke account, a package from a file',
    lead: `A shared world arrives as a link; a package arrives as a file. Both end as a world in Library.`,
    rules: [
      ['A share opens from its link', `A share link opens the Player (an app link; without the Player, its store page). The sheet <code>Shared with you</code> shows the world’s key art and name, who shared it — picture and name — and the count, then <code>Open</code>; signed out, <code>Sign in with Arke ↗</code> and <code>Not now</code> (${F('P2a')}). Signed in to an account the share was not made for, the sheet says <code>Not shared with this account</code> and offers <code>Switch account</code>.`],
      ['Sign-in is the browser’s', `As Studio ${S(151)}: no password field in the Player. The press hands off to the system’s browser sheet, the presses give way to <code>waiting for the browser</code> and <code>Cancel</code> (${F('P2b')}), and the Player keeps the session. <code>Arke account</code> is the only account it knows.`],
      ['What a share is', `A share gives one account the productions its owner chose from a world, as publications, under the world’s name, key art and logline. The owner can add productions — they appear under <code>New</code> — and can stop sharing. Who and what is set in the Studio, in a Share sheet this master does not draw. A shared production <b>streams</b> from the Arke cloud until it is downloaded (${F('P6a')}).`],
      ['A share that ends', `The world stays in Library, greyed, with <code>No longer shared</code> and <code>Remove</code> on its card (${F('P2g')}). Nothing in it opens, and its downloads are deleted the next time the Player reaches the cloud. Its places are kept until Remove, so a share made again resumes where it was.`],
      ['Adding a package', `<code>+</code> in Library, and <code>Add a package</code> on first open, open a sheet of two: <code>Choose a file</code> (the system’s picker) and <code>Paste a link</code> (<code>https</code> only) (${F('P2c')}). A package also arrives from the system’s Open in and Share menus. Accepted: a <b>world package</b> — a ZIP holding the world’s name, logline and key art and one or more publications, each with its own <code>publication.json</code> — or one publication’s ZIP. The world package is a proposal; its format is owed to SPEC-048 before it is built.`],
      ['Checked before it is shown', `Free space is checked first: a package larger than what is free is refused before it is copied. The Player then copies the file into its own storage and checks every asset’s byte length and SHA-256 against its manifest: <code>Checking</code>, the file’s name and size, a bar, <code>212 of 418 files</code>, <code>Cancel</code> (${F('P2d')}). Nothing in a package plays before the check passes.`],
      ['Ready', `The summary is what the manifests say (${F('P2e')}): the world’s picture and name, <code>made 12 Oct 2026 · 3 productions · 1.4 GB</code>, each production with its kind and size under <code>Inside</code>, the space it takes against what is free, and <code>Add to library</code>. Closing deletes the copy.`],
      ['Refused in one clause', `A refusal is its title (${F('P2f')}): <code>3 files do not match</code>, <code>Made with a newer Arke</code> (with <code>Update</code>), <code>Not an Arke package</code>, <code>Needs 1.4 GB · 0.9 GB free</code>. Nothing partial is added and the copy is deleted. <code>Choose another file</code> and <code>Close</code>.`],
      ['A package is the person’s', `An added world is removed only by <code>Remove</code>, needs no account and is never uploaded to one.`],
    ],
    next: `Try next: “Not shared with this account” · “a package arriving from Open in” · “Made with a newer Arke”`,
  },
  {
    id: 'p3', name: 'Watching — a film, a micro drama',
    lead: `The Player hosts the players the Studio already draws; a film and a micro drama get the transport a phone needs.`,
    rules: [
      ['One player, three homes', `The players are Studio ${S(156)}’s, ${S(174)}’s and ${S(186)}’s: the same framework-free modules the Studio previews with and the packages carry (156: one player, two homes). The Player runs those modules and adds only its close (⌄, back to where the player was opened) and the phone’s media session around them — lock screen and headset controls, background audio, picture in picture, casting. What plays in a browser from a package plays the same in the Player.`],
      ['A film', `The picture is the page (156): letterboxed, never cropped, on the overlay colours. Held upright, the picture sits in the middle with the chrome over two scrims (${F('P3a')}); turned, it fills the height (${F('P3b')}). A film’s scrubber runs across the whole film, since a film has a length. The transport: <code>Captions</code>, back <code>10</code>, play or pause <code>64</code>, forward <code>10</code>, full screen; the time as <code>54:40 / 1:32:40</code>; <code>Cast</code> at the top. The chrome rests after <code>2.5s</code> while playing and never while paused.`],
      ['A micro drama is a feed', `One episode a screen, 9:16, full bleed (${F('P3c')}). Swipe up for the next episode, down for the one before; a tap pauses. The top holds ⌄ and the production over <code>Episode 13</code>; a column at the right edge holds <code>Episodes</code>, <code>Captions</code> and <code>More</code>, <code>44</code> across with their names; a <code>3</code>-high scrubber sits above the home indicator, the episode’s number and title over it. At an episode’s end the next begins (<code>Autoplay next</code>, on by default, in You).`],
      ['Episodes', `A glass sheet over the picture, which keeps playing (${F('P3d')}): the count, <code>1–20 · 21–40</code>, and the episodes as numbered tiles five across, <code>48</code> high — seen ones dimmed, the current one inverted. A press plays that episode from its kept place, else its start.`],
      ['Captions', `A sheet of the publication’s text tracks by their label, <code>Off</code> first, the chosen one checked, then <code>Size</code> <code>S · M · L</code> (${F('P3e')}). The choice is kept on the device and applies to every production that carries that language; one without it plays with captions off.`],
    ],
    next: `Try next: “a series with seasons” · “casting to a TV” · “a micro drama paused”`,
  },
  {
    id: 'p4', name: 'Playing — an interactive movie, a visual novel',
    lead: `Studio 156’s interactive player and 174’s visual novel, on a phone and inside the Player.`,
    rules: [
      ['An interactive movie is 156’s player', `On a phone the choices stack full width where the thumb is, <code>58</code> high, in authored order, the first in focus, <code>Replay scene</code> under them; captions and the route sit at the top (${F('P4a')}, Studio ${S(156)}i). Nothing counts down: untimed is the only built behaviour (156).`],
      ['The route', `A glass sheet over the picture (${F('P4b')}): each scene watched with its <code>96 × 54</code> still, the choice taken between them with <code>Choose again</code>, and <code>Start over</code>. No endings found, no percentages (156).`],
      ['An ending is a title', `<code>ENDING</code>, the ending’s title in <code>text-4xl</code>, the route as stills with the choices taken in one line, then <code>Start again</code> and <code>Back to last choice</code> (${F('P4c')}, 156e on a phone).`],
      ['A visual novel is 174’s player', `The box above the home indicator, <code>12</code> in from each edge, the speaker’s tab and the line in <code>text-lg</code>; a tap anywhere moves on; <code>Auto</code>, <code>Log</code> and ⋯ (Route, Start over) at the top (${F('P4d')}, Studio ${S(174)}g). <code>Log</code> is a glass sheet of the scene’s lines up to now, newest last, each with its play (${F('P4e')}, 174e).`],
      ['Where you are', `A place is kept on the device, per routing version (156f): a scene and a time, or a scene and a beat. On a production’s page <code>Continue</code> names the scene; <code>Start over</code> is in ⋯.`],
    ],
    next: `Try next: “three and four choices on a phone” · “a visual novel at 16:9 on a phone” · “the route of a long story”`,
  },
  {
    id: 'p5', name: 'Listening and reading — an audiobook, an audio drama, a book',
    lead: `Studio 186’s audiobook player with 211’s Slow push and 212’s two lines, an audio drama with its transcript, and the book an edition carries.`,
    rules: [
      ['An audiobook is 186’s player', `The picture of the moment fills the top <code>62%</code> (${F('P5a')}); <code>Slow push</code> sits under the title as a labelled switch <code>44</code> high (Studio ${S(211)}); <code>Text</code> shows only the current phrase, at most two lines at <code>text-lg</code>, centred above the transport (Studio ${S(212)}). The transport: previous chapter, back <code>15</code>, play or pause <code>64</code>, forward <code>30</code>, next chapter; under it the speed, the sleep choice and <code>Text</code>. <code>Chapters</code> and ⋯ at the top (Studio ${S(186)}).`],
      ['Chapters', `A glass sheet (${F('P5b')}): each chapter’s number, title and length, a check when finished, the playing one with its line of progress, a downloaded mark. A chapter the edition does not hold is not listed: a publication carries only chapters read whole (186).`],
      ['Speed and sleep', `One sheet (${F('P5c')}): speed <code>0.8× · 1.0× · 1.2× · 1.5× · 2×</code>, the pitch kept (186); sleep <code>Off</code>, <code>End of chapter</code>, <code>15 min</code>, <code>30 min</code>, <code>60 min</code>. Both kept on the device.`],
      ['An audio drama', `The episode’s picture as a 16:9 card at the top, then the edition’s transcript (Studio ${S(230)}): the speaker in label caps over the line, the line being heard in full ink and the rest at <code>46%</code>, a sound cue in brackets and italics (${F('P5d')}). The transcript follows the audio; a press on a line plays from it. The transport is the audiobook’s, with <code>Transcript</code> and <code>Episodes</code>.`],
      ['A book', `The edition’s EPUB on the shelves’ theme (${F('P5e')}): ⌄, the chapter, <code>Aa</code> (size; Paper, Sepia, Night) and Contents at the top; the text; at the foot the page in the chapter (<code>12 of 30</code>) with its line, and <code>Listen</code> when the edition has narration. Listen opens that chapter in the audiobook at its kept place, else its start. Reading and listening keep separate places (Studio ${S(224)}).`],
      ['The phone’s controls', `Audio plays with the screen locked; the lock screen and headset drive it, with the picture of the moment as the artwork (186).`],
    ],
    next: `Try next: “an audio drama’s episodes” · “Aa open” · “the lock screen”`,
  },
  {
    id: 'p6', name: 'Offline, You, adult content and the Fold',
    lead: `What is on the phone, the device’s settings, the one gate a share can carry, and the Player open on a Fold7.`,
    rules: [
      ['Downloads', `A shared production plays from the cloud until it is downloaded; an added package is always on the phone. The tab opens on the space Arke Player takes against the rest and what is free, then <b>Shared</b> downloads — each with its size and a downloaded mark, <code>Downloading · 42%</code> with its line, or <code>Waiting for Wi-Fi</code> — then <b>Added</b> packages (${F('P6a')}). ⋯ on a row removes it. Downloads wait for Wi-Fi while <code>Wi-Fi only</code> is on.`],
      ['Offline', `Without a network the head of Home says <code>Offline</code> (${F('P6d')}). What is on the phone plays as ever; a shared production not downloaded is greyed with <code>offline</code> on its kind line and does not open. Places made offline are kept and sent on the next connection.`],
      ['You', `The account — picture, name, address, <code>Account ↗</code> (Studio ${S(151)}) and <code>Sign out</code> — then <b>Playback</b>: <code>Captions</code>, <code>Text</code>, <code>Slow push</code>, <code>Autoplay next</code>; <b>Downloads</b>: <code>Wi-Fi only</code>, <code>Storage</code>; <b>Content</b>: <code>Adult content</code>; then About (${F('P6b')}), in Studio ${S(149)}’s row grammar. Every setting is this device’s.`],
      ['Adult content', `Off by default. A production its owner marked adult shows blurred, with <code>18+</code>, and does not open; a press offers <code>Adult content is off</code> with <code>I am 18 or older · Turn on</code> and <code>Not now</code> (${F('P6c')}). Turning it on is a personal choice made once on this device and undone in You (Studio ${S(154)}).`],
      ['On a Fold', `At <code>600</code> wide and over the tabs become an <code>88</code>-wide rail, Continue cards are <code>420</code> wide and the shelves widen (${F('P6e')}). A player keeps the picture the page — 16:9 across the top at the full width — with the words and the transport centred under it at <code>640</code>, the words at <code>text-2xl</code> (${F('P6f')}). Bands: under <code>600</code> a phone; <code>600</code> to <code>1099</code> a Fold or a tablet.`],
      ['Implementation boundary', `Nothing here is built. The Arke cloud — accounts, shares, streaming — does not exist yet: the Studio’s account seam answers <code>Arke cloud is not available yet</code>. The first build can ship packages, the players and downloads, and take shares when the cloud arrives. The world package and the share model are owed to the specs (SPEC-048, SPEC-025) before either is built.`],
    ],
    next: `Try next: “Storage open” · “a download failed” · “the Fold folded mid-play”`,
  },
];

// ---- assemble ---------------------------------------------------------------------------------
const turnOrder = [...TURNS].reverse(); // newest first, as in the Studio master
const all = TURNS.flatMap((t) => FRAMES[t.id]);
const radius = (f) => (f.w === 390 ? 'border-radius:40px' : f.w === 844 ? 'border-radius:28px' : 'border-radius:22px');
const card = (f) => `<div class="dv-opt" id="${f.id.toLowerCase()}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id.toLowerCase()}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.w}px;max-width:none;${radius(f)}">${f.markup}</div></div>`;
const section = (t) => {
  const frames = FRAMES[t.id];
  return `<section class="dv-turn" id="${t.id}"><div class="dv-thd"><a class="dv-tid" href="#${t.id}">${t.id.toUpperCase()}</a><span class="dv-tname">${esc(t.name)}</span></div><p class="dv-next">${DATE} · Proposed · ${frames.length} frames. ${t.lead}</p><div class="dv-opts" style="margin-top:22px">${frames.map(card).join('\n')}</div>${t.rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${body}</p>`).join('\n')}<p class="dv-next">${t.next}</p></section>\n`;
};

const intro = `<section class="dv-turn" id="t0" style="padding:36px 44px 28px">
  <div style="max-width:760px;display:flex;flex-direction:column;gap:10px">
    <div style="font:650 20px/1.2 var(--font-sans);letter-spacing:-0.02em;color:var(--dv-ink)">Arke Player · design master</div>
    <div style="font:500 13px/1.5 var(--font-sans);color:var(--dv-ink)"><a href="#p6">Latest: P6 · Offline, You, adult content and the Fold</a> · ${DATE}</div>
    <div style="font:400 13px/1.65 var(--font-sans);color:var(--dv-ink-body)">A phone app for what is made in Arke: worlds shared through an Arke account and Arke packages added from a file, watched, heard, read and played. It hosts the Studio’s players — the interactive player (<a href="Arke%20Studio.dc.html#t156">Studio 156</a>), the visual novel (<a href="Arke%20Studio.dc.html#t174">174</a>), the audiobook (<a href="Arke%20Studio.dc.html#t186">186</a>, <a href="Arke%20Studio.dc.html#t211">211</a>, <a href="Arke%20Studio.dc.html#t212">212</a>) and the show page (<a href="Arke%20Studio.dc.html#t199">199</a>) — and adds the shelves, sharing, packages and downloads around them. Turns are numbered P1, P2… and frames P1a… so they never share a number with the <a href="Arke%20Studio.dc.html">Studio master</a>. Frames are 390 × 844 for a phone, 844 × 390 turned, 984 × 1092 for a Fold7 open. The sample is The Undersong, shared by Helen Marsh with Jonah Pike. <a href="arke-player.review.html">Review page</a> · <a href="arke-player.notes.md">Notes</a></div>
    <div style="font:400 13px/1.65 var(--font-sans);color:var(--dv-ink-body)"><b style="color:var(--dv-ink)">Turns.</b> ${TURNS.map((t) => `<a href="#${t.id}">${t.id.toUpperCase()} · ${esc(t.name.split(' — ')[0])}</a>`).join(' · ')}</div>
    <div style="font:400 13px/1.65 var(--font-sans);color:var(--dv-ink-body)"><b style="color:var(--dv-ink)">Calls for the owner.</b> 1 · When a share ends, its downloads go too (drawn so, <a href="#p2g">P2g</a>). 2 · The Player runs the Studio’s web player modules inside a native shell, rather than players written again (drawn so, <a href="#p3">P3</a>). 3 · A world package — a ZIP of a world’s name, logline, key art and its publications — is the file people add; its extension and schema go to SPEC-048 (<a href="#p2">P2</a>). 4 · The Studio’s Share sheet, who and which productions, is its own turn in the Studio master.</div>
  </div>
</section>
`;

// The document chrome is the Studio master's, read from it so the two never drift apart.
const studio = read('Arke Studio.dc.html');
const chromeStart = studio.indexOf("/* The document's own chrome");
const chromeEnd = studio.indexOf('\n', studio.indexOf('@keyframes pulseDot'));
if (chromeStart < 0 || chromeEnd < 0 || chromeEnd < chromeStart) throw new Error('could not find the Studio master’s document chrome');
const chrome = studio.slice(chromeStart, chromeEnd);

const master = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arke Player · design master</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<meta name="design_doc_mode" content="canvas">
${['fonts', 'colors', 'typography', 'spacing', 'effects'].map((n) => `<link rel="stylesheet" href="${TOKENS}/tokens/${n}.css">`).join('\n')}
<link rel="stylesheet" href="${TOKENS}/styles.css">
<link rel="stylesheet" href="arke-player.css">
<script src="${TOKENS}/_ds_bundle.js"></script>
<script src="theme-switch.js"></script>
<style>
${chrome}
/* The Player's frames are phones: the cards round like one. */
.dv-opts{gap:40px 36px}
</style>
</helmet>
${intro}${turnOrder.map(section).join('')}</x-dc>
</body>
</html>
`;

const review = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arke Player · review</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map((n) => `<link rel="stylesheet" href="${TOKENS}/tokens/${n}.css">`).join('')}<link rel="stylesheet" href="arke-player.css">
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:44px}.rv>header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv>header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}.rv a{color:inherit}.rv h2{font:var(--type-h3);margin:0 0 6px}.rv .lead{font:var(--type-body);max-width:1100px;opacity:.75;margin:0 0 18px}.rv .row{display:flex;flex-wrap:wrap;gap:36px}.rv figure{margin:0;display:flex;flex-direction:column;gap:8px}.rv figcaption{font:var(--type-ui)}.rv .fr{overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.12),0 4px 18px rgba(0,0,0,.08);width:max-content}.rv .rules{max-width:1100px;margin-top:20px;display:flex;flex-direction:column;gap:8px}.rv .dv-rule{margin:0;padding:10px 14px;border-left:2px solid #2a78d6;background:rgba(42,120,214,.05);font:var(--type-ui);font-weight:400;line-height:1.6}.rv .dv-rule code{font:inherit;background:rgba(0,0,0,.06);padding:0 4px;border-radius:3px}.rv .dv-oid{font-weight:600}</style></head>
<body><div class="rv"><header><b>Arke Player · ${DATE} · proposed</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Player.dc.html">Design master</a><a href="arke-player.notes.md">Notes</a></header>
${TURNS.map((t) => `<section id="${t.id}"><h2><a href="#${t.id}">${t.id.toUpperCase()}</a> · ${esc(t.name)}</h2><p class="lead">${t.lead}</p><div class="row">${FRAMES[t.id].map((f) => `<figure id="${f.id.toLowerCase()}"><figcaption><a href="#${f.id.toLowerCase()}">${f.id}</a> ${esc(f.title)}</figcaption><div class="fr" style="${radius(f)}">${f.markup}</div></figure>`).join('')}</div><div class="rules">${t.rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${body.replaceAll('href="#', 'href="#')}</p>`).join('')}</div></section>`).join('\n')}
</div></body></html>
`;

// ---- checks: what check-master asks of the Studio master, and that every frame closes ---------
const problems = [];
for (const f of all) {
  for (const tag of ['div', 'span']) {
    const open = (f.markup.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length;
    const shut = (f.markup.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    if (open !== shut) problems.push(`${f.id}: ${open} <${tag}> against ${shut} </${tag}>`);
  }
  const raw = f.markup.match(/\bfont(?:-size)?\s*:\s*(?:[0-9]{3}\s+)?[0-9]+(?:\.[0-9]+)?px/g);
  if (raw) problems.push(`${f.id}: raw font sizes ${raw.join(', ')}`);
  for (const m of f.markup.matchAll(/src="assets\/([^"]+)"/g)) if (!fs.existsSync(path.join(here, 'assets', m[1]))) problems.push(`${f.id}: missing asset ${m[1]}`);
}
const ids = [...master.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) problems.push(`duplicate ids: ${[...new Set(dupes)].join(', ')}`);
for (const m of master.matchAll(/href="#([^"]+)"/g)) if (!ids.includes(m[1])) problems.push(`anchor with no target: #${m[1]}`);
if (problems.length) {
  console.error(`arke-player: ${problems.length} problem(s)`);
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}

write('Arke Player.dc.html', master);
write('arke-player.review.html', review);
console.log(`Wrote Arke Player.dc.html and arke-player.review.html: ${TURNS.length} turns, ${all.length} frames, ${TURNS.reduce((n, t) => n + t.rules.length, 0)} rules.`);

// Build design-system/design-review.html from the design master (issue 1098).
//
//   npm run design:review            build the page
//   npm run design:review -- --check  validate only (lint runs this: a PR that ships a control
//                                     without drawing it fails here)
//
// The page walks the current screens in the order a person uses them, each frame copied out of
// the master's latest turn for that screen with that turn's binding rules beside it, and says per
// screen what has shipped and what is drawn but not built. The master is never modified; this
// is a reading of it, so the drawing stays the single source. It refuses to build when a frame it
// names is missing, when a screen it names has no frame and the master does not say so, or when
// a frame does not carry a control the build shipped — which is how the Stage, the Grid and the
// Bench's newer controls would have surfaced instead of shipping undrawn.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MASTER = join(here, "Arke Studio.dc.html");
const OUT = join(here, "design-review.html");
const TOKENS = "_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens";

/**
 * The walk. `frame` is the id of the master's latest frame for the screen, or null for a screen
 * the master declares built-not-drawn (a `<p class="dv-undrawn" data-screen="…">` in a turn).
 * `controls` are labels the build ships; each must appear in the frame's text or the build stops.
 * `status`: built · drifted (built, differs from the drawing in a way the notes name) · drawn
 * (drawn, not built). `checked` dates the notes — a note is as good as its date.
 */
const SCREENS = [
  { group: "Arrive", screen: "World door", frame: "1a", route: "#/worlds", status: "drifted", checked: "2026-09-06",
    controls: ["Pick up where you left off"],
    notes: ["Ships as the world picker with a card per world.", "<code>Archive</code> and <code>Install the sample world</code> were built without a frame."] },
  { group: "Arrive", screen: "World", frame: "63a", route: "#/w/:worldId", status: "built", checked: "2026-09-06",
    controls: ["Overview", "Art direction", "Cast", "Canon"],
    notes: ["The overview above the fold; art direction (67a) beside it. Not re-measured since the walk of 6 September."] },
  { group: "Arrive", screen: "Production · season", frame: "120a", route: "#/w/:worldId/p/:prodId/season", status: "drifted", checked: "2026-09-10",
    controls: ["Episodes", "Story structure"],
    notes: ["The rack ships. The rail's marks stay hidden until it folds; Audio and Exports in the rail redirect into the Cut; there is no Cast row (production.tsx, fidelity.css)."] },
  { group: "Arrive", screen: "Production · artifacts", frame: "134a", route: "#/w/:worldId/p/:prodId/artifacts", status: "built", checked: "2026-09-09",
    controls: ["Artifacts", "only here"],
    notes: ["Shipped by PR 1039: the world's shelf and this production's own in one grid, <code>only here</code> on the card."] },
  { group: "Arrive", screen: "Episode", frame: "100b", route: "#/w/:worldId/p/:prodId/episodes/:id", status: "built", checked: "2026-09-06",
    controls: ["Arke"],
    notes: ["The episode as a page with Arke docked on it. <code>Add scene</code> creates directly with an inline title (SPEC-036 §1.14)."] },

  { group: "Scene workspace", screen: "Storyboard · List", frame: "145a", route: "#/w/:worldId/p/:prodId/scenes/:sceneId", status: "built", checked: "2026-09-15",
    controls: ["Review scene", "Generate frames", "Regenerate", "Generate frame", "List", "Grid"],
    notes: ["PR 1112 builds 145a: the row is a row again — the script typed on it, the title opening the page and the pencil editing, no <code>Frame prompt</code> toggle, no unfolding, a chevron beside the overflow, 14px above and below the frame — and the view row is <code>Storyboard &middot; Flow &middot; Preview</code>.", "Turn 139's scale (24 / 15 / 13 / 11) now applies. Empty slots are compact and completed Plans fold to one line (issue 1096)."] },
  { group: "Scene workspace", screen: "Shot", frame: "145b", route: "#/w/:worldId/p/:prodId/scenes/:sceneId/shots/:shotId", status: "built", checked: "2026-09-12",
    controls: ["Regenerate", "View full prompt", "Rebuild"],
    notes: ["PR 1112 builds the page (<code>shot-page.tsx</code>, <code>shot-fields.tsx</code>) in place of turn 97's sheet: the breadcrumb ending on the scene, the filmstrip that steps and keeps the view, <code>Shot &middot; Stage</code> with the state word, the frame whole at the production's aspect beside Script, Frame prompt, Notes, Camera, Timing, Continuity, Sound and Props (145b, 145c), the no-frame state (145e), and the dock as <code>Arke &middot; Shot N</code>.", "The sheet's recipes (Establishing, Reaction, Insert…) did not come across: the turn does not draw them, and a chip row with nothing drawn behind it is not a control. Intent rides on the Camera card as its first line."] },
  { group: "Scene workspace", screen: "Storyboard · Grid", frame: "145f", route: "#/w/:worldId/p/:prodId/scenes/:sceneId · Grid", status: "built", checked: "2026-09-15",
    controls: ["Grid", "Regenerate", "Needs frame"],
    notes: ["PR 1112 builds 145f and 145g: the Grid is the storyboard&#8217;s default, <code>Grid &middot; List</code> in the control, the choice remembered per person; the card carries no <code>Frame prompt</code> toggle and a chevron on its foot, a press on the frame, the title or the chevron opens the page; the columns follow the production&#8217;s aspect &#8212; four across at portrait, three at landscape, one fewer under 176 or 280px.", "Uses the same corrected type scale and compact empty slots as the List (issue 1096)."] },
  { group: "Scene workspace", screen: "Frame run dialog", frame: "141a", route: "frame-run.tsx", status: "drifted", checked: "2026-09-11",
    controls: ["Per shot", "Shot board", "Shots without a frame", "Cancel", "Generate"],
    notes: ["Method, Include, Model with the aspect verdict, References and the props guard ship as drawn.", "A row's <code>Generate frame</code> still hands off to the Cut and assembles the scene, and a still is refused for the Cut's clock (issue 1096 D2, D3). A location mention reaches the provider raw (D1)."] },
  { group: "Scene workspace", screen: "Flow", frame: "135b", route: "#/w/:worldId/p/:prodId/scenes/:sceneId · Flow", status: "built", checked: "2026-09-10",
    controls: ["Flow"],
    notes: ["SPEC-044 / PR 1082: the character as a node feeding the shots that cite her; the cast row and its doors."] },
  { group: "Scene workspace", screen: "Flow · full screen", frame: "135h", route: "… · Flow · full screen", status: "built", checked: "2026-09-10",
    controls: ["Esc"],
    notes: ["Issue 1078: the glyph at the right end of the view row; the pill and the reversed glyph with <code>Esc</code>."] },
  { group: "Scene workspace", screen: "Stage", frame: "145d", route: "#/w/:worldId/p/:prodId/scenes/:sceneId/shots/:shotId · Stage", status: "built", checked: "2026-09-12",
    controls: ["Build with Arke", "Keep blocking", "Look", "Camera", "Keep", "Loop", "Add set", "Turn with target"],
    notes: ["Built by PR 900 and the 1040–1051 series; drawn first in 140a, the panel redrawn as an inspector in 144a (PR 1104). PR 1112 moves it onto the shot page as its second view (145d): the filmstrip steps, the stepper line goes, and the staging&#8217;s words sit on the view row beside the full-screen glyph; every door to it — a Flow staging node, a blockout or playblast Arke was asked for — opens that shot&#8217;s page on it.", "Round-57 findings are in issue 1094."] },
  { group: "Scene workspace", screen: "Stage · full screen", frame: "144b", route: "… · Stage · full screen", status: "built", checked: "2026-09-11",
    controls: ["Build with Arke", "Render with this"],
    notes: ["Issue 1078 gave the Stage the Flow's full screen; 144b moves the way out onto the head row (PR 1104)."] },
  { group: "Scene workspace", screen: "Preview", frame: null, route: "#/w/:worldId/p/:prodId/scenes/:sceneId · Preview", status: "built", checked: "2026-09-11",
    controls: [],
    notes: ["Built, not drawn: the master says so in turn 140. The view plays the scene's frames and clips in order (preview.tsx)."] },

  { group: "Make", screen: "Bench", frame: "142a", route: "#/w/:worldId/artifacts/bench/:sessionId", status: "built", checked: "2026-09-15",
    controls: ["Reference", "Keyframe", "End frame", "Image 1", "Presets", "Generate", "voice refs"],
    notes: ["Keyframe slots (PR 900), voice references (PR 856) and Presets ship; drawn for the first time in 142a.", "A shot's generation session is now the Bench 142a draws, not the prototype's second dress: the shot and the session's spend on the chrome's pills, the production's rail, icon tabs, one dispatch row with the name alone in the select and the price as one mono figure, <code>voice refs · on</code> as an option chip (absent without a voiced cast), the route fact on the Keyframe hint, the wall's pills, the clip's own transport, <code>Accept · file onto shot N</code>, and a numbered strip. Not built: the bar's filter and the two lenses, Voice on a shot, the seed and advanced buttons — none has a function behind it yet."] },
  { group: "Make", screen: "Cut", frame: "122a", route: "#/w/:worldId/p/:prodId/cut", status: "built", checked: "2026-09-09",
    controls: ["Library"],
    notes: ["The library beside the cut with one drag engine and posters by artifact id (PR 1054); typed trims in the Inspector and audio import (PR 944); the export sheet at <code>/cut?export=1</code> owns delivery."] },
  { group: "Make", screen: "Generate · takes", frame: "147a", route: "#/w/:worldId/p/:prodId/generate", status: "built", checked: "2026-09-13",
    controls: ["EPISODE", "SCENE", "SHOT", "Open in generator", "Accept take", "Reject", "Contact sheet", "Advanced"],
    notes: ["Turn 147 records the shipped episode/scene/shot scope, selectable playable cards and shared verdict bar for the picked take. The bar acts on the selected card; it is not duplicated on each card (issue 1165).", "Measured durations use one decimal. Accepted contact-sheet frames name their shot and mark acceptance as done."] },

  { group: "Interactive", screen: "Branch map", frame: "157a", route: "#/w/:worldId/p/:prodId/branch-map", status: "built", checked: "2026-09-27",
    controls: ["Branch map", "Preview", "Export blocked · 4"],
    notes: ["The canvas over <code>layoutRouting</code> (<code>branch-map.tsx</code>, <code>lib/branch-map.ts</code>): cards with the scene&#8217;s first shot frame, curves with labels, dashed until walked, the tray, the legend, zoom and fit; wheel pans, Ctrl or Cmd with the wheel zooms, a drag on the ground pans.", "The header counts every blocking finding, the export&#8217;s own number, and the warnings bar unvisited routes. No minimap yet past 60 scenes."] },
  { group: "Interactive", screen: "Branch map · findings", frame: "157b", route: "#/w/:worldId/p/:prodId/branch-map", status: "drifted", checked: "2026-09-27",
    controls: ["Draw a choice to it"],
    notes: ["Built as drawn: the count is a selection, the Inspector lists blocks first by title, unwalked choices folded into one row, and a row outlines its scene on the map.", "The unwalked row&#8217;s press reads <code>Preview from the start</code>, not <code>Preview a route that walks them</code>, because no route is computed; the other rows offer <code>Select &lt;scene&gt;</code>."] },
  { group: "Interactive", screen: "Branch map · drawing a choice", frame: "157c", route: "#/w/:worldId/p/:prodId/branch-map", status: "drifted", checked: "2026-09-27",
    controls: ["Add choice"],
    notes: ["Drag from a card&#8217;s out-port and drop on a card, or <code>Draw a choice from here</code> in the scene&#8217;s Inspector; the label is typed in the Inspector, not in a field on the new edge."] },
  { group: "Interactive", screen: "Branch map · a choice selected", frame: "157d", route: "#/w/:worldId/p/:prodId/branch-map", status: "built", checked: "2026-09-27",
    controls: ["Walk it", "Remove choice"],
    notes: ["The label renames in place; the selected arrowhead is a handle that retargets the choice by dragging, and From and To are selects as the way in without a pointer."] },
  { group: "Interactive", screen: "Branch map · removing a choice", frame: "157e", route: "#/w/:worldId/p/:prodId/branch-map", status: "built", checked: "2026-09-27",
    controls: ["Cancel", "Remove choice"],
    notes: ["The consequences are <code>routingFindings</code> run without the choice, diffed against now: a scene left with no way in, one that can no longer reach an ending, a loop with no way out. They are outlined on the map while it asks."] },
  { group: "Interactive", screen: "Branch map · a scene selected", frame: "157f", route: "#/w/:worldId/p/:prodId/branch-map", status: "drifted", checked: "2026-09-27",
    controls: ["Make this the start", "Preview from here", "Open scene"],
    notes: ["Adds what the frame leaves out: the scene&#8217;s ways out, each selecting its choice, and <code>Draw a choice from here</code>. An ending&#8217;s title is edited under its switch."] },
  { group: "Interactive", screen: "Branch map · day one", frame: "157g", route: "#/w/:worldId/p/:prodId/branch-map", status: "drifted", checked: "2026-09-27",
    controls: ["Draw the first choice from the start scene", "Start at The drowned quarter"],
    notes: ["The start is picked from the scenes&#8217; frames and written with <code>set-start</code>. No <code>Ask Arke to draft the map</code> press; Arke is docked beside the card instead."] },
  { group: "Interactive", screen: "Branch map · Arke staged", frame: "157h", route: "#/w/:worldId/p/:prodId/branch-map", status: "drawn", checked: "2026-09-27",
    controls: ["Accept", "Discard"],
    notes: ["Arke is docked on the map now, on the production&#8217;s thread, but nothing it stages is drawn on the canvas yet."] },
  { group: "Interactive", screen: "Branch map · narrow window", frame: "157i", route: "#/w/:worldId/p/:prodId/branch-map · below 900 wide", status: "drifted", checked: "2026-09-27",
    controls: ["goes to"],
    notes: ["Below 900 wide the map is a list: layers in order, each choice a goes-to row, dashed where nobody has walked it; the Inspector sits above it. Arke stacks under the list at a bounded height rather than folding to its strip."] },
  { group: "Interactive", screen: "Interactive preview", frame: "156g", route: "#/w/:worldId/p/:prodId/branch-map · Preview", status: "built", checked: "2026-09-27",
    controls: ["Branch map", "Close preview"],
    notes: ["The package's own player over the whole window (<code>components/interactive-player.tsx</code> mounting <code>contracts/src/interactive-player.js</code>), with the author's strip: where it started, how many choices nobody has walked, <code>Branch map</code>, <code>Close preview</code> and Esc.", "A scene plays its accepted clips in shot order, a pass covering several shots once; a pressed choice records walk evidence, and its <code>not walked</code> mark and the strip's count fall as the findings come back."] },
  { group: "Interactive", screen: "Interactive player · playing", frame: "156a", route: "exports/interactive-:prodId-:stamp/player.html", status: "drifted", checked: "2026-09-27",
    controls: [],
    notes: ["Built as drawn: the picture full-bleed, the title over the top scrim, the scene-scoped scrubber with its fork, the transport, and the chrome resting after 2.5s by a CSS animation restarted on input — the player holds no timer.", "No captions: the exporter copies no WebVTT, so the captions button and <code>C</code> are left out rather than drawn empty. A scene of several clips shows a segment each and <code>Shot 2 of 3</code> beside the time."] },
  { group: "Interactive", screen: "Interactive player · choice", frame: "156b", route: "exports/interactive-:prodId-:stamp/player.html", status: "built", checked: "2026-09-27",
    controls: ["Replay scene"],
    notes: ["The last frame holds and dims, the cards rise in authored order with their keys, the first holds focus; <code>1</code>–<code>9</code> choose. Untimed. The chosen card is not held for 300ms: the next scene cuts in at once."] },
  { group: "Interactive", screen: "Interactive player · timed choice", frame: "156c", route: "a production option, off by default", status: "drawn", checked: "2026-09-27",
    controls: ["default"],
    notes: ["Held. No production setting carries it, and the package's tests hold that no timer exists in the player."] },
  { group: "Interactive", screen: "Interactive player · route", frame: "156d", route: "player.html · R", status: "built", checked: "2026-09-27",
    controls: ["Route", "Choose again", "Start over"],
    notes: ["The scenes are listed by title with no still: the package carries clips, not posters."] },
  { group: "Interactive", screen: "Interactive player · ending", frame: "156e", route: "player.html · an ending scene", status: "drifted", checked: "2026-09-27",
    controls: ["Start again", "Back to last choice"],
    notes: ["The route runs beneath the title as scene names joined by the choice labels, not as stills. A dead end in preview says <code>No choices from here</code> where an ending would say <code>Ending</code>."] },
  { group: "Interactive", screen: "Interactive player · saved place", frame: "156f", route: "player.html · opened with a saved place", status: "built", checked: "2026-09-27",
    controls: ["Continue", "Start over"],
    notes: ["The poster is the saved scene's first frame, the place its title and time; without a saved place the one button reads <code>Play</code>."] },
  { group: "Interactive", screen: "Interactive player · phone", frame: "156i", route: "player.html · below 640 wide", status: "drifted", checked: "2026-09-27",
    controls: ["Replay scene"],
    notes: ["Below 640 wide the choices stack full width at the thumb. A 16:9 clip is letterboxed rather than filling the phone; the route and captions do not move to the top."] },
  { group: "Visual novel", screen: "New production · what kind of interactive", frame: "174a", route: "#/w/:worldId/productions/new · CHOOSE", status: "drifted", checked: "2026-09-27",
    controls: ["What kind of interactive?", "Interactive movie", "Visual novel", "Create and open it"],
    notes: ["Built as drawn: <code>CHOOSE</code> asks which interactive, each kind with its plate, and <code>Visual novel</code> writes the <code>visual-novel</code> kind.", "No <code>TEXT</code> or <code>ADVANCE</code> default: the line always shows in its box, and a beat moves on with a tap until its Beat card says otherwise. <code>RATE</code> is hidden, since a visual novel plays pictures."] },
  { group: "Visual novel", screen: "Scene · beats", frame: "174b", route: "#/w/:worldId/p/:prodId/scenes/:sceneId · visual novel", status: "drifted", checked: "2026-09-27",
    controls: ["Beats", "Same picture", "Narrator"],
    notes: ["Built: <code>Beats</code> and <code>Preview</code> (no Flow, no boards), each row's covered lines under <code>Narrator</code> or the speaker with voiced or not, the advance chip, and <code>Same picture</code> showing the held picture.", "<code>Voice lines</code> reads <code>n of m voiced</code> and <code>Voice n lines · $x</code>, preparing through the table read. Pictures are made with the existing frame run; the row keeps the shot's script under its lines, as the picture's description. Arke's reply chips are not built."] },
  { group: "Visual novel", screen: "Beat", frame: "174c", route: "#/w/:worldId/p/:prodId/scenes/:sceneId/shots/:shotId · visual novel", status: "drifted", checked: "2026-09-27",
    controls: ["Narrator", "Advance", "After the voice", "Movement"],
    notes: ["A <code>Beat</code> card leads the shot page: the shot's lines with their voice state, <code>Advance</code> (with a hold's seconds), <code>Movement</code> and <code>Same picture</code>, written to <code>shot.beat</code>.", "Who speaks is read from the script block, not chosen on the card, and the voice is prepared from the scene page, not read again here. The picture, its takes and its prompt are the shot page's own."] },
  { group: "Visual novel", screen: "Visual novel player · a line", frame: "174d", route: "player.html · a beat scene", status: "drifted", checked: "2026-09-27",
    controls: ["Auto", "Log", "Route"],
    notes: ["The one player reads beat scenes: the picture with its movement, the line typing on word by word by CSS, the name tab, the ticks, <code>Auto</code>, <code>Log</code>, <code>Route</code>. A hold and the breath after a voice are CSS animations whose end moves on; there is no timer.", "The box says <code>tap</code> once a line has typed on; the drawn <code>reading</code> mark is not shown."] },
  { group: "Visual novel", screen: "Visual novel player · the log", frame: "174e", route: "player.html · L", status: "built", checked: "2026-09-27",
    controls: ["Log", "Play line"],
    notes: ["<code>L</code> or <code>Log</code> lists the scene's lines so far; <code>Play line</code> plays one on its own player without moving the story; Escape closes it first."] },
  { group: "Visual novel", screen: "Visual novel player · choice", frame: "174f", route: "player.html · a beat scene's end", status: "built", checked: "2026-09-27",
    controls: ["Follow the lantern", "Stay with the boat"],
    notes: ["The last line stays in its box under 156b's choice cards and keys."] },
  { group: "Visual novel", screen: "Visual novel player · phone", frame: "174g", route: "player.html · below 640 wide", status: "drifted", checked: "2026-09-27",
    controls: ["Auto", "Log"],
    notes: ["Below 640 wide the box spans the width above the home bar and a tap anywhere reads on.", "The chrome shows icons without their words, and a 16:9 picture letterboxes in the middle with the box over its foot rather than under it."] },
  { group: "Visual novel", screen: "Export · visual novel", frame: "174h", route: "#/w/:worldId/p/:prodId/branch-map · Export", status: "drifted", checked: "2026-09-27",
    controls: ["Export"],
    notes: ["The branch map's Export ships a visual novel as a web package: each picture once, each prepared voice, the text as text, in a manifest the exporter verifies. A beat with no picture blocks by name; an unvoiced line reads as text.", "No export sheet: the blockers show in the branch map's export note, and <code>Film per scene</code> is not offered."] },

  { group: "Around it", screen: "Settings · Harness", frame: "148a", route: "#/settings/harness", status: "built", checked: "2026-09-15",
    controls: ["OpenCode", "Claude Code", "Codex", "Check again", "Choose…", "Advanced"],
    notes: ["Detected engine state is distinct from the saved next-restart choice. Found-but-blocked installations say needs attention. The initial desktop connection displays Starting Arke Studio, with no invented default engine (issue 1154)."] },
  { group: "Around it", screen: "Settings", frame: "124a", route: "#/settings", status: "built", checked: "2026-09-06",
    controls: ["Providers", "General", "Diagnostics"],
    notes: ["SPEC-042 / PR 875: a page, not a modal. Providers holds credentials; AI models holds models by kind then supplier. Sample clips on the card are issue 876."] },
  { group: "Around it", screen: "Settings · AI models", frame: "125a", route: "#/settings/models", status: "built", checked: "2026-09-06",
    controls: ["AI models", "Cloud", "On this machine"],
    notes: ["Kinds, then suppliers; the working prototype behind it is <code>settings-models.html</code>."] },
  { group: "Around it", screen: "Settings · Providers", frame: "125d", route: "#/settings/providers", status: "built", checked: "2026-09-06",
    controls: ["Services you connect", "Engines you run"],
    notes: ["A service is a credential, an engine is an address."] },
  { group: "Around it", screen: "Activity", frame: "136a", route: "the bell, over any screen", status: "built", checked: "2026-09-10",
    controls: ["Activity"],
    notes: ["PR 1087: a panel over the screen you are on, opened by the bell; the app's own news first, the spend alert as a row; a release card per tag."] },
  { group: "Around it", screen: "Arke account", frame: "151a", route: "the picture after the gear, over any screen", status: "built", checked: "2026-09-17",
    controls: ["Upgrade", "Account", "Sign out"],
    notes: ["Turn 151, ahead of Arke cloud: the account as the last control in the chrome's right group, a 300-wide menu with account things only — the person, <code>Plan</code> with its one action, <code>Account</code>, <code>Sign out</code> — and the states in 151c.", "PR 1219 builds it: <code>AccountControl</code> (client <code>components/account-menu.tsx</code>) over <code>app.account</code>, the coordinator's state, with the frames <code>account-sign-in</code>, <code>account-create</code>, <code>account-cancel-sign-in</code>, <code>account-sign-out</code> and <code>account-open</code>. Behind them is <code>NoArkeCloud</code>, the local default: there is no cloud yet, so the packaged app is always signed out and the signed-in menu is reached only by the tests. The spec is owed with the real service (SPEC-025 keeps accounts out of Studio)."] },
  { group: "Around it", screen: "Arke account · signed out", frame: "151b", route: "the person glyph after the gear, over any screen", status: "built", checked: "2026-09-17",
    controls: ["Sign in", "Create account"],
    notes: ["Turn 151: the same menu with no one signed in — one title and two buttons, both a browser handoff. Quiet in the chrome: no dot, no badge, nothing local gated.", "PR 1219 builds it; with <code>NoArkeCloud</code> either door answers <code>Arke cloud is not available yet</code> under the title, and the line goes with the menu."] },
  { group: "Around it", screen: "Update available", frame: "152a", route: "at launch, over the first screen with chrome", status: "built", checked: "2026-09-17",
    controls: ["Update available", "Update now", "Next start"],
    notes: ["Turn 152 ships as <code>update-announcement.tsx</code>: the editor's sheet at 440 over the screen the app opened on, once per version per run; the version and the release's name on one line, the notes in the scrolling pane, <code>Update now</code> downloading and then installing and restarting, <code>Next start</code> handing the update to the on-close flow before the download exists. Closing drops the intent and keeps the download; a failed download keeps the dialog with <code>Try again</code>."] },
  { group: "Around it", screen: "Character voice", frame: "132a", route: "#/w/:worldId/cast/:id/voice", status: "built", checked: "2026-09-08",
    controls: ["Voice"],
    notes: ["PR 1023: one voice with two uses, four entrances, the bible on the performance panel."] },
  { group: "Around it", screen: "Chapter (story)", frame: "126a", route: "#/w/:worldId/p/:prodId/chapters/:id", status: "built", checked: "2026-09-07",
    controls: ["Read the chapter"],
    notes: ["Story mode for novelists, turns 126–131, PRs 877–933: the chapter read, typed into and heard, beside what it draws on."] },
  { group: "Around it", screen: "Chapter · audiobook view (story)", frame: "165a", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "built", checked: "2026-09-27",
    controls: ["Manuscript", "Audiobook", "Play", "Narrator…", "Marker", "Pause", "Breath", "Emphasis", "Upload"],
    notes: ["Issue 1330 builds 165a's repairs of 155e (issue 1324 §3): the reading as a menu on the view row — <code>Performed · George</code>, the three readings written as the door's seg writes them, and <code>Narrator…</code> — with <code>Play</code> and the priced read beside it; the block panel titled <code>Block 3 · Odile Sarn</code> in sentence case over <code>read by George · narrator</code>; delivery as pill chips in a radiogroup; the marker list's words verbatim, never quoted twice; the add buttons one word each that never break; takes and the Voices panel naming a reader, never a provider id.", "Not built: sounds (<code>[sighs]</code>, <code>+ Sound</code>) and the Gemini reader wait for 1334 and 1329, and are absent until their capability is reported."] },
  { group: "Around it", screen: "Audiobook (story)", frame: "146a", route: "#/w/:worldId/p/:prodId/story/audiobook", status: "drifted", checked: "2026-10-03",
    controls: ["Read the book", "Export"],
    notes: ["SPEC-047 slice 3 ships the door: <code>Audiobook</code> on the rail between Chapters and Artifacts with the chapters read of those with prose, the count and running time under the title, <code>Narrator · Cast</code> with the voices beside it — the narrator, each speaker with the voice that reads them, <code>no voice · narrator</code> in warning — the 4px read bar, a row a chapter with its state or its running time, and <code>Read the book · N chapters · $X</code> with <code>reading… n of N chapters</code> and <code>Stop</code> while it goes.", "Drift: the head is <code>Listen · Export · Read the book</code>. Once a block anywhere is made, <code>Listen</code> (186) is its one primary, with a play icon, and <code>Read the book</code> steps down to secondary; before then Listen is a ghost and Read the book leads. The frame draws Read the book as the one primary and has no Listen — the owner could not find the player as a ghost beside Export (2026-10-03). A speaker's voice is named by its label or the world's name for it, never a designed voice's <code>designed:dv_…</code> target. A run's ending — <code>stopped · the takes made stand</code>, chapters left to their rows, controls dropped on a reading switch — is a line under the voices row the frame does not draw."] },
  { group: "Around it", screen: "Read the book dialog (story)", frame: "146c", route: "#/w/:worldId/p/:prodId/story/audiobook?read=1", status: "built", checked: "2026-09-14",
    controls: ["Confirm 9,400 characters · $0.94", "Cancel"],
    notes: ["SPEC-047 slice 3: the price asked once for the book — the chapters, characters and cloud lines under the title, a line a voice with what it reads and what it costs, the narrator's share free, a speaker with no voice in warning, where the words go. Confirm carries the figure and the token."] },
  { group: "Around it", screen: "Export audiobook sheet (story)", frame: "146d", route: "#/w/:worldId/p/:prodId/story/audiobook?export=1", status: "drawn", checked: "2026-09-13",
    controls: ["Chapter files", "Book", "Retail", "As made", "Read the rest · 9 chapters · $0.94", "Show in folder", "Export 6 chapters"],
    notes: ["Turn 146: chapter files or a book, the retail profile as data, chapters left out counted with the dashed door, the delivered folder. Not built."] },
  { group: "Around it", screen: "Chapter · who reads what (story)", frame: "155a", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drawn", checked: "2026-09-25",
    controls: ["Everyone", "Play", "Read the chapter · 5 blocks · $0.02", "Cast again", "Upload"],
    notes: ["Turn 155: the Audiobook view marks every block with its speaker — a colour a speaker, grey for the narrator, a dashed dot for a name no sheet carries; lines tinted, narration plain; a waveform or a microphone for how the take was made; a speaker filter; a recorded speaker's block <code>awaiting recording</code>. Not built."] },
  { group: "Around it", screen: "Chapter · speaker menu (story)", frame: "155b", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drawn", checked: "2026-09-25",
    controls: ["Speaker", "Narration", "Bram Tull"],
    notes: ["Turn 155: a press on a block's speaker, or words selected in narration, opens the menu; a correction is a pin on the cast that outlives <code>Cast again</code>. Not built."] },
  { group: "Around it", screen: "Upload a take dialog (story)", frame: "155c", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook&upload=:block", status: "drawn", checked: "2026-09-25",
    controls: ["Replace", "My voice", "Authorized", "Licensed", "Cancel", "Keep as take"],
    notes: ["Turn 155: one file for one block — the words over the file, the checks as data, a warning that does not refuse, the performer and rights once. Not built."] },
  { group: "Around it", screen: "Speaker lines sheet (story)", frame: "155d", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook&lines=:sheet", status: "drawn", checked: "2026-09-25",
    controls: ["Awaiting", "All 31", "Export", "Add files", "Cancel", "Keep 4 takes"],
    notes: ["Turn 155: a recorded speaker's script out as a PDF with ids and direction, recordings back in matched by id and checked; refused files in one clause. Not built."] },
  { group: "Around it", screen: "Chapter · markers, narrator reading (story)", frame: "155e", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drawn", checked: "2026-09-25",
    controls: ["Play", "Read the chapter · 4 blocks · $0.03", "Direct again"],
    notes: ["Turn 155: the narrator reads everything; markers such as <code>[whispered]</code> sit in the Audiobook view over spans or at points, kept on the audiobook record and never in the prose; the side shows the text the reader is sent. Not built."] },
  { group: "Around it", screen: "Marker menu (story)", frame: "155f", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drawn", checked: "2026-09-25",
    controls: ["Marker", "whispered", "pause · short", "Phrase…"],
    notes: ["Turn 155: select words and press <code>[</code>, or type it at a caret; deliveries cover a span, cues sit at a point, what the reader cannot do is struck. Not built."] },
  { group: "Around it", screen: "Chapter · performed reading (story)", frame: "155g", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drawn", checked: "2026-09-25",
    controls: ["Hear Odile · $0.01", "Read the chapter · 6 blocks · $0.03", "Use both"],
    notes: ["Turn 155: a third reading, <code>Performed</code> — one narrator reads everything, each speaker's lines carry a performance note set once in Voices, rendered as the line's phrase; <code>Hear</code> previews a line with the note, <code>Sent as</code> shows the rendered text. Not built."] },
  { group: "Around it", screen: "Book narrator dialog (story)", frame: "165c", route: "#/w/:worldId/p/:prodId/story/audiobook?narrator=1", status: "drifted", checked: "2026-09-27",
    controls: ["App narrator · George", "This book", "All", "This machine", "Cloud", "Cancel", "Use for this book"],
    notes: ["Issue 1330 builds 165c over 155h: a search that takes focus and matches every word against the name, provider, reader and attributes; <code>All · This machine · Cloud</code> with counts, <code>Saved</code> only once the world has a saved voice; the list grouped with this machine first; rows named <code>Kokoro · this machine</code>, never <code>mistral · voxtral-mini-tts</code>; arrows, Enter and Space in the list; the switch's costs as rows beside the chosen voice, and <code>Use for this book</code> waiting for them.", "Drift: the <code>Reader</code> seg (Flash · Flash-Lite) waits for 1329; <code>Hear</code> on the chosen voice is one button rather than the drawn quote of the block."] },
  { group: "Around it", screen: "Chapter · 1200 × 790 with the dock (story)", frame: "165k", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "built", checked: "2026-09-27",
    controls: ["Play", "Marker", "Pause"],
    notes: ["Issue 1330: under a centre of 900 the Audiobook view keeps the block panel beside the blocks at 250, the gap at 20; only under 700 does it stack. The rule that stacked it at 900 still holds for Manuscript."] },
  { group: "Around it", screen: "Chapter · on a phone (story)", frame: "165l", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drifted", checked: "2026-09-27",
    controls: ["Performed", "Marker", "Make again · $0.01"],
    notes: ["Issue 1330: under 700 the speaker is named over the line, the filter swipes, and a pressed block's panel is a sheet from the foot with a 44 close.", "Drift: the head keeps its full labels (<code>Read the chapter · 7 blocks</code>) and the chapter's context row stays above the view row."] },
  { group: "Around it", screen: "Book narrator on a phone (story)", frame: "165m", route: "#/w/:worldId/p/:prodId/story/audiobook?narrator=1", status: "built", checked: "2026-09-27",
    controls: ["This book", "All", "This machine", "Use for this book"],
    notes: ["Issue 1330: under 700 the dialog is the whole screen, one column, 44 search and 56 rows."] },
  { group: "Around it", screen: "Marker menu · sounds (story)", frame: "165b", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drawn", checked: "2026-09-27",
    controls: ["laughs", "sighs", "Phrase…"],
    notes: ["Turn 165: sounds as a third kind of marker, at a point. Waits for 1334."] },
  { group: "Around it", screen: "Design a voice dialog (story)", frame: "165d", route: "…/cast/:sheet/voice", status: "drawn", checked: "2026-09-27",
    controls: ["Design again · 3 · $0.06", "Keep candidate 2"],
    notes: ["Turn 165: three candidates from the sheet's words, heard on one of the speaker's lines. Waits for 1332."] },
  { group: "Around it", screen: "Replicate a voice dialog (story)", frame: "165e", route: "…/cast/:sheet/voice", status: "drawn", checked: "2026-09-27",
    controls: ["Authorized", "Replicate · $0.40"],
    notes: ["Turn 165: a reference and a consent statement, verified as the same speaker before anything is made. Waits for 1333."] },
  { group: "Around it", screen: "Audiobook · reading and stopped (story)", frame: "165g", route: "#/w/:worldId/p/:prodId/story/audiobook", status: "drawn", checked: "2026-09-27",
    controls: ["Read the rest · 180 blocks · $3.89", "Export"],
    notes: ["Turn 165 (165f, 165g): progress in blocks and money against the quote, and <code>Read the rest</code> priced without work already paid for. Waits for 1335."] },
  { group: "Around it", screen: "Read the book · token quote (story)", frame: "165h", route: "#/w/:worldId/p/:prodId/story/audiobook?read=1", status: "drawn", checked: "2026-09-27",
    controls: ["Read · $6.40", "Cancel"],
    notes: ["Turn 165: tokens in and out, the rates with their date, blocks made before not charged again. Waits for 1328."] },
  { group: "Around it", screen: "Saved voice out of reach (story)", frame: "165i", route: "#/w/:worldId/p/:prodId/story/audiobook", status: "drawn", checked: "2026-09-27",
    controls: ["Not now", "Open Providers"],
    notes: ["Turn 165: a saved voice bound to another project, said before a run, with three ways back. Waits for 1331."] },
  { group: "Around it", screen: "Export audiobook · on this machine (story)", frame: "165j", route: "#/w/:worldId/p/:prodId/story/audiobook?export=1", status: "drawn", checked: "2026-09-27",
    controls: ["Chapter files", "Read the rest · 2 chapters · $0.31", "Export 13 chapters"],
    notes: ["Turn 165 over 146d: the chosen takes, made on this machine with no provider and no key. Waits for 1336."] },
  { group: "Around it", screen: "Direct this chapter sheet (story)", frame: "184a", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drifted", checked: "2026-10-03",
    controls: ["Direct this chapter", "Reads", "Cast the lines first", "Draft the chapter note", "Draft speaker notes", "Book note", "Chapter note", "Cancel", "Direct", "nothing spent"],
    notes: ["Turn 184: the dock's prompt opens the sheet in the block panel's place; Reads is the coordinator's answer (<code>preview-direction</code>), Also sends the cast, the chapter note and the speaker notes with the direction. The book note and the chapter note are rows under the view line.", "Drift: the Direct press stays in the dock, as turn 146 has it, rather than on the head; <code>Cast the lines first</code> names why the lines are not cast where the frame counts them, since the count is known only once they are."] },
  { group: "Around it", screen: "Proposal on the blocks (story)", frame: "184b", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "built", checked: "2026-10-03",
    controls: ["Accept", "Discard", "Hear block", "Sent as", "Delivery", "Note", "proposed"],
    notes: ["Turn 184: a held proposal's markers on the blocks in a 1.5 dashed outline; the block's panel shows the proposed delivery, note and Sent as, and <code>Hear block</code> reads it as the proposal would send it. The card's tally counts blocks, directed, lines cast and dropped."] },
  { group: "Around it", screen: "The book's reading (story)", frame: "184c", route: "#/w/:worldId/p/:prodId/story/audiobook", status: "built", checked: "2026-10-03",
    controls: ["Book note", "Speakers", "drafted from the sheets", "Draft from the sheets", "Done"],
    notes: ["Turn 184: opened from a performed speaker's chip on the door; each note with <code>sheet</code> or <code>you</code>."] },
  { group: "Around it", screen: "Sent as on a tag reader (story)", frame: "184d", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "built", checked: "2026-10-03",
    controls: ["Sent as", "book note", "chapter note"],
    notes: ["Turn 184: a book or chapter note too long for a tag is struck under Sent as and never sent."] },
  { group: "Around it", screen: "Read the chapter, grouped (story)", frame: "185a", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drifted", checked: "2026-10-03",
    controls: ["Read the chapter", "Requests", "Per paragraph", "Estimate", "Cancel"],
    notes: ["Turn 185: the press counts requests beside blocks; each request's blocks are bracketed under a mono label; a grouped price is confirmed in a sheet in the block panel's place. Gated: shown only for a reader marked groupable, on a machine with a local transcriber.", "Drift: <code>Google today</code> is a row only where Google's free day is known; a paid tier's daily figure is not known to Arke."] },
  { group: "Around it", screen: "Reading, grouped (story)", frame: "185b", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drifted", checked: "2026-10-03",
    controls: ["Stop"],
    notes: ["Turn 185: progress says the request and the blocks; the request being read is bracketed dark.", "Drift: no Reading sheet with Split and Spent rows; the head carries the progress and Stop."] },
  { group: "Around it", screen: "A split that did not match (story)", frame: "185c", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drifted", checked: "2026-10-03",
    controls: ["split did not match", "Heard", "Words", "Keep", "Re-read"],
    notes: ["Turn 185, amended: Re-read sends the block with its neighbours, one request, keeping the middle cut.", "Drift: the panel names the cut's place as <code>grouped · 1:12–1:31</code>, not the request's number, and draws no waveform."] },
  { group: "Around it", screen: "The book's requests (story)", frame: "185d", route: "#/w/:worldId/p/:prodId/story/audiobook", status: "drifted", checked: "2026-10-03",
    controls: ["Requests", "Grouped", "Per paragraph", "Done"],
    notes: ["Turn 185: offered only where the coordinator says the book's reader groups here; grouped by default, written to the book.", "Drift: on the door, and in the book's reading when it is open; the counts are the book's, not a chapter's, and the provider's tier is not shown."] },
  { group: "Around it", screen: "The audiobook player (story)", frame: "186a", route: "#/w/:worldId/p/:prodId/story/audiobook · Listen", status: "drifted", checked: "2026-10-03",
    controls: ["End of chapter", "audiobook", "chapter 7 of 22"],
    notes: ["Turn 186: <code>audiobook-player.js</code> in contracts, one module for the app and the package; Listen on the door and on a chapter. The made takes back to back with nothing added; a chapter read in part plays its made blocks, its gap marked on the scrubber and said in Text (<code>68 blocks not read</code>); a chapter with none is passed over. Speed 0.8–2× with the pitch kept, the sleep timer, the kept place by block and offset, Media Session.", "Drift: the picture is letterboxed (<code>contain</code>) as the binding says, where the frame's CSS covers; speed and the sleep timer cycle on a press rather than open a menu; the chrome rests after 2.5 s of playing, as 156's does."] },
  { group: "Around it", screen: "The audiobook player · Chapters (story)", frame: "186b", route: "#/w/:worldId/p/:prodId/story/audiobook · Listen · Chapters", status: "built", checked: "2026-10-03",
    controls: ["Chapters", "read", "not read"],
    notes: ["Turn 186: every chapter listed with its progress and running time; a chapter read in part also counts its blocks not read; a chapter with none held and not pressable."] },
  { group: "Around it", screen: "A picture on a block (story)", frame: "186c", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drifted", checked: "2026-10-03",
    controls: ["Picture", "World", "Cast", "Scenes", "Generate", "Remove", "Done", "Holds", "cover at the start"],
    notes: ["Turn 186c: the block's panel gains Picture — the world's art and uploads, the cast's and places' pictures, scenes' frames and takes, or the Bench's pictures under Generate — and the margin a chip with the picture and its start. The panel says <code>shows 1:12–2:40 · 1 m 28 s</code>, flags a hold under 20 s, and counts the chapter's pictures.", "Drift: Generate opens a new Bench session in image mode with the block's words and the book's look written in, and the Bench prices, confirms and files the picture; it is then chosen under Generate. The panel sits under the block's direction rather than replacing it; times are estimated, and marked <code>~</code>, until the blocks are read.", "Drift: the head's <code>Listen</code> carries a play icon and is its primary once a block of this chapter is made, <code>Direct this chapter</code> and <code>Read the chapter</code> secondary beside it; the frame draws Listen as a secondary press beside a primary Read the chapter."] },
  { group: "Around it", screen: "Export audiobook (story)", frame: "186e", route: "#/w/:worldId/p/:prodId/story/audiobook · Export", status: "drifted", checked: "2026-10-03",
    controls: ["Export audiobook", "Audiobook player", "player.html", "read whole", "cover where a chapter has none", "Cancel", "Export"],
    notes: ["Turn 186e: the book as the player — <code>player.html</code> with the app's own player inlined, each chapter read whole joined into one file where this machine has ffmpeg (as made otherwise), each picture once — staged and moved under <code>exports/</code> whole, refused if the book moved meanwhile. Publications lists the world's web packages, the audiobook beside the interactive and the visual novel, with Show in folder.", "Drift: Chapter files is not offered — SPEC-047's own export (146d) is not built yet (issue 1336), and the sheet offers only what it makes; the package's size is said once it is written, not before."] },
  { group: "Around it", screen: "The audiobook player on a phone (story)", frame: "186d", route: "#/w/:worldId/p/:prodId/story/audiobook · Listen (phone)", status: "built", checked: "2026-10-03",
    controls: ["Text", "End of chapter"],
    notes: ["Turn 186: below 600 the picture takes the top, the transport sits under the thumb in three rows, play 64 across, and Text moves to the foot."] },
  { group: "Around it", screen: "Timing (story)", frame: "187a", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=timing", status: "drifted", checked: "2026-10-03",
    controls: ["Timing", "Starts", "Pause after", "Trim", "Plays", "After", "Under", "Set by", "Reset", "Play from here", "Play", "Propose timing"],
    notes: ["Turn 187a: the chapter's third view — a lane a voice, Narration then each speaker as they first speak, and Beds &amp; sounds; bars at the clock's places with their words and a mono line, overlaps hatched, a ruler and a playhead; zoom and scroll. A bar dragged sets its start, its edges its trim, the grip after it its pause; dropped over a bar in another lane it plays under it. The side holds the same values; Play runs the one mix from the playhead.", "Drift: zoom is two buttons in the view's own bar; a block not read is drawn dashed at the reading rate; Propose timing arrives with 187b. The Performed lock says <code>the reader's</code> where a field would be."] },
  { group: "Around it", screen: "Propose timing (story)", frame: "187b", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=timing", status: "drifted", checked: "2026-10-03",
    controls: ["Accept", "Discard", "this machine", "the cast"],
    notes: ["Turn 187b: Propose timing reads the chapter as it stands — the takes' ends heard on this machine, the words and their dashes, the cast's names — and draws Arke's starts, pauses, reactions and a bed dashed until accepted whole; the author's timing is never moved and is counted as kept. Nothing is spent.", "Drift: the card says what it changes as counts and what it read in two rows rather than a sentence of prose; the proposal is read by rules (a line that breaks off is cut into, an exchange tightened, a scene break and the heading let breathe, a reaction the narration names, a bed a sound's name in the prose), not by a model."] },
  { group: "Around it", screen: "The block's timing (story)", frame: "187c", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drifted", checked: "2026-10-03",
    controls: ["Trim", "Pause after", "Cut", "Reset", "Play with neighbours"],
    notes: ["Turn 187c: the block's panel gains the take's waveform with trim handles, Pause after, a grouped cut's nudge and Play with neighbours — the Timing view's values. A chapter with timing plays through the one mix.", "Drift: the timing sits under the block's direction and above its picture; trim is also two seconds fields; Cut shows only between two cuts of one request."] },
  { group: "Around it", screen: "A bed and a sound (story)", frame: "187d", route: "#/w/:worldId/p/:prodId/story/chapters/:id?view=audiobook", status: "drifted", checked: "2026-10-03",
    controls: ["Bed", "Sound", "Library", "World", "Generate", "Level", "Fade", "Ends", "Remove", "Done"],
    notes: ["Turn 187d: the block's panel gains Bed — from this block to the one it Ends on, a Level and a duck under voices, Fade in and out — and Sound at the block's start, each chosen from the world's sounds (Library: brought in; World: made here) or generated through the Bench's music route. Reactions sit above them: a sound from the cadence list or a few words, in a speaker's voice, under the block.", "Drift: the bed is edited from the block it starts on, not drawn on the page as a band; a sound's chips are the cadence list, struck nowhere yet for a reader that makes none — the run refuses it in one clause instead; Generate opens the Bench in music mode, as 186c's pictures do."] },
];

/** Standalone pages in this folder and where they stand. Listed here so it is findable at all. */
const PAGES = [
  { file: "Arke Studio.dc.html", what: "The design master. Every decision, newest first.", state: "current" },
  { file: "design-review.html", what: "This page — generated from the master by <code>npm run design:review</code>.", state: "current" },
  { file: "settings-models.html", what: "Working prototype of the AI models page, in real CSS; linked from turn 124.", state: "current" },
  { file: "Arke Website.dc.html", what: "The website's design canvas.", state: "current" },
  { file: "Arke Studio Prototype.dc.html", what: "First-generation screens, 99 frames, turns 114–119; still draws Audio, Exports, the Settings modal and the Activity page, all since replaced.", state: "superseded by this page, 2026-09-11" },
  { file: "since-the-prototype.html", what: "Prose on what the app had that the prototype did not, written against the Settings modal.", state: "superseded by this page, 2026-09-11" },
  { file: "scene-workspace-vertical.html", what: "The vertical scene-workspace exploration before turn 138, with its Stage prototype (titled <i>Bundled Page</i>); <code>scene-workspace-vertical.notes.md</code> and <code>scene-workspace-stage.md</code> describe it.", state: "superseded by turns 138–140" },
  { file: "settings-contact-sheet.html", what: "Settings as a contact sheet — an exploration behind turn 124.", state: "exploration" },
  { file: "export-prototype-standalone.html", what: "Standalone export of the first-generation prototype's home screen.", state: "superseded" },
  { file: "composer.html", what: "The composer: attach and voice on every chat composer (turn 41).", state: "exploration" },
  { file: "loading.html", what: "Ten loading variations behind the launch frames.", state: "exploration" },
  { file: "waitlist.html", what: "The website's waitlist page.", state: "website" },
];

// ---- read the master ------------------------------------------------------------------------

const html = readFileSync(MASTER, "utf8");
const problems = [];

/** The balanced <div> that starts at `at`. Frames are nested divs; nothing else is counted. */
function balancedDiv(source, at) {
  let depth = 0;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = at;
  for (let m; (m = re.exec(source)); ) {
    depth += m[0] === "<div" ? 1 : -1;
    if (depth === 0) return source.slice(at, m.index + m[0].length);
  }
  return null;
}

/** A frame by id: its root is the first [data-screen-label] inside its dv-opt, with or without a dv-card. */
function frame(id) {
  const optStart = html.indexOf(`<div class="dv-opt" id="${id}">`);
  if (optStart < 0) return null;
  const nextOpt = html.indexOf('<div class="dv-opt"', optStart + 1);
  const nextTurn = html.indexOf('<section class="dv-turn"', optStart + 1);
  const end = Math.min(...[nextOpt, nextTurn].filter((i) => i > 0));
  const labelAt = html.indexOf("data-screen-label=", optStart);
  if (labelAt < 0 || labelAt > end) return null;
  const rootAt = html.lastIndexOf("<div", labelAt);
  const root = balancedDiv(html, rootAt);
  if (!root) return null;
  const captionMatch = html.slice(optStart, labelAt).match(/<div class="dv-(?:olabel|cap)">([\s\S]*?)<\/div>/);
  const caption = captionMatch ? captionMatch[1].replace(/<a class="dv-oid"[^>]*>[^<]*<\/a>\s*/, "").trim() : "";
  return { root, caption, bitmapOnly: /^<div class="dv-card"[^>]*>\s*<img\b[^>]*>\s*<\/div>$/.test(root) };
}

function turnOf(id) { return Number(id.match(/^\d+/)[0]); }

function turn(n) {
  const start = html.indexOf(`<section class="dv-turn" id="t${n}">`);
  if (start < 0) return null;
  const next = html.indexOf('<section class="dv-turn"', start + 1);
  const body = html.slice(start, next < 0 ? undefined : next);
  const name = body.match(/<span class="dv-tname">([\s\S]*?)<\/span><\/div>/)?.[1] ?? "";
  const rules = [...body.matchAll(/<p class="dv-rule">([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  return { name, rules };
}

/** Screens the master declares as built and deliberately not drawn. */
const undrawn = new Map([...html.matchAll(/<p class="dv-undrawn" data-screen="([^"]+)">([\s\S]*?)<\/p>/g)].map((m) => [m[1], m[2]]));

const decode = (s) => s
  .replace(/&middot;/g, "·").replace(/&#8217;/g, "’").replace(/&#8212;/g, "—").replace(/&times;/g, "×")
  .replace(/&nbsp;/g, " ").replace(/&hellip;|&#8230;/g, "…").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const textOf = (markup) => decode(markup.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
/** A whole label, not a substring: the header's `Generate frames` must not stand in for a row's `Generate frame`. */
function hasLabel(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^\\p{L}\\p{N}])" + escaped + "(?=$|[^\\p{L}\\p{N}])", "u").test(text);
}

const sections = [];
for (const s of SCREENS) {
  if (s.frame === null) {
    const note = undrawn.get(s.screen);
    if (!note) { problems.push(`${s.screen}: no frame named and the master does not declare it built-not-drawn (add <p class="dv-undrawn" data-screen="${s.screen}"> to a turn)`); continue; }
    sections.push({ ...s, undrawnNote: note });
    continue;
  }
  const f = frame(s.frame);
  if (!f) { problems.push(`${s.screen}: frame ${s.frame} is not in the master`); continue; }
  if (f.bitmapOnly) { problems.push(`${s.screen}: frame ${s.frame} is a bitmap, not a drawing (turn 139)`); continue; }
  const text = textOf(f.root);
  const missing = s.controls.filter((c) => !hasLabel(text, c));
  if (missing.length) { problems.push(`${s.screen}: frame ${s.frame} does not carry ${missing.map((c) => `"${c}"`).join(", ")} — update the frame in the PR that shipped the control`); continue; }
  const t = turn(turnOf(s.frame));
  sections.push({ ...s, root: f.root, caption: f.caption, turn: turnOf(s.frame), turnName: t?.name ?? "", rules: t?.rules ?? [] });
}

if (problems.length) {
  console.error(`design-review: refusing to build — ${problems.length} problem(s)`);
  for (const p of problems) console.error(" - " + p);
  process.exit(1);
}

// ---- the page --------------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const masterStyle = html.match(/<helmet>[\s\S]*?<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
const generated = new Date().toISOString().slice(0, 10);
const groups = [...new Set(SCREENS.map((s) => s.group))];

const railHtml = groups.map((g) => `
      <div class="rail__group">${esc(g)}</div>
      ${sections.filter((s) => s.group === g).map((s) => `<a class="rail__item" href="#${esc(slug(s.screen))}"><i class="dot dot--${s.status}"></i><span>${esc(s.screen)}</span><b>${s.frame ?? "—"}</b></a>`).join("\n      ")}`).join("\n");

function slug(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }

const screensHtml = sections.map((s) => {
  const status = { built: "built", drifted: "built · drifted", drawn: "drawn · not built" }[s.status];
  const notes = `<ul>${s.notes.map((n) => `<li>${n}</li>`).join("")}</ul>`;
  if (!s.root) {
    return `
    <section class="screen" id="${esc(slug(s.screen))}">
      <div class="screen__head"><div><h2>${esc(s.screen)}</h2><div class="screen__meta"><span class="tag tag--${s.status}">${status}</span><code>${esc(s.route)}</code><span>checked ${s.checked}</span></div></div></div>
      <div class="undrawn"><b>Built, not drawn.</b> ${s.undrawnNote}</div>
      <div class="built built--${s.status}">${notes}</div>
    </section>`;
  }
  const width = s.root.match(/width:\s*(\d+)px/)?.[1] ?? "1360";
  // A rule copied out of the master keeps its `#126a` links; on this page those ids do not
  // exist, so the anchors are pointed back at the master (codex on PR 1164).
  const toMaster = (markup) => markup.replace(/href="#/g, 'href="Arke%20Studio.dc.html#');
  const rules = s.rules.length ? `<div class="rules"><div class="rules__head">Binding · turn <a href="Arke%20Studio.dc.html#t${s.turn}">${s.turn}</a> <span>${toMaster(s.turnName)}</span></div>${s.rules.map((r) => `<p class="dv-rule">${toMaster(r)}</p>`).join("")}</div>` : "";
  return `
    <section class="screen" id="${esc(slug(s.screen))}">
      <div class="screen__head">
        <div><h2>${esc(s.screen)}</h2><div class="screen__meta"><span class="tag tag--${s.status}">${status}</span><code>${esc(s.route)}</code><span>checked ${s.checked}</span></div></div>
        <a class="screen__frame" href="Arke%20Studio.dc.html#${s.frame}">${s.frame} in the master →</a>
      </div>
      <p class="screen__caption">${toMaster(s.caption)}</p>
      <div class="stage" data-width="${width}"><div class="stage__scale" style="width:${width}px">${s.root}</div></div>
      <div class="built built--${s.status}"><div class="built__head"><span class="tag tag--${s.status}">${status}</span><span class="built__label">what shipped</span></div>${notes}</div>
      ${rules}
    </section>`;
}).join("\n");

const pagesHtml = `<table class="pages"><thead><tr><th>Page</th><th>What it is</th><th>State</th></tr></thead><tbody>${PAGES.map((p) => `<tr><td><a href="${encodeURI(p.file)}">${esc(p.file)}</a></td><td>${p.what}</td><td>${esc(p.state)}</td></tr>`).join("")}</tbody></table>`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arke Studio · design review</title>
<link rel="stylesheet" href="${TOKENS}/fonts.css">
<link rel="stylesheet" href="${TOKENS}/colors.css">
<link rel="stylesheet" href="${TOKENS}/typography.css">
<link rel="stylesheet" href="${TOKENS}/spacing.css">
<link rel="stylesheet" href="${TOKENS}/effects.css">
<script src="image-slot.js"></script>
<script src="theme-switch.js"></script>
<style>
/* The master's own chrome, copied so its rules and cards read here as they read there. */
${masterStyle}
/* This page's chrome. theme-switch.js writes .dark / data-theme / color-scheme to the root exactly
   as the master does — System, Light, Dark — and the frames re-theme from the tokens alone. */
html { background: var(--dv-canvas); }
body { margin: 0; font: 400 var(--text-sm)/1.55 var(--font-sans); color: var(--dv-ink); }
.wrap { display: grid; grid-template-columns: 250px minmax(0, 1fr); min-height: 100vh; }
.rail { position: sticky; top: 0; height: 100vh; overflow-y: auto; box-sizing: border-box; padding: 24px 14px 30px 20px; border-right: 1px solid var(--dv-hairline); }
.rail__title { font: 600 var(--text-md)/1.3 var(--font-sans); margin: 0 0 4px; }
.rail__sub { margin: 0 0 18px; font: 400 var(--text-xs)/1.5 var(--font-sans); color: var(--dv-ink-soft); }
.rail__group { margin: 14px 0 4px; font: 500 var(--text-2xs)/1.2 var(--font-sans); letter-spacing: var(--tracking-label); text-transform: uppercase; color: var(--dv-ink-faint); }
.rail__item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 7px; text-decoration: none; color: var(--dv-ink); font: 400 var(--text-xs)/1.3 var(--font-sans); }
.rail__item:hover { background: var(--dv-chip); color: var(--dv-ink); }
.rail__item span { flex: 1; min-width: 0; }
.rail__item b { font: 500 var(--text-2xs)/1 var(--font-mono); color: var(--dv-ink-faint); }
.dot { width: 7px; height: 7px; border-radius: 99px; flex: none; }
.dot--built { background: #2d7b7a; } .dot--drifted { background: #c88d32; } .dot--drawn { background: #b9483d; }
.main { padding: 28px 36px 80px; min-width: 0; }
.top h1 { margin: 0 0 6px; font: 600 var(--text-2xl)/1.2 var(--font-sans); letter-spacing: var(--tracking-tighter); }
.top p { margin: 0; max-width: 78ch; color: var(--dv-ink-soft); }
.legend { display: flex; gap: 16px; margin: 14px 0 26px; font: 400 var(--text-xs)/1.4 var(--font-sans); color: var(--dv-ink-soft); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.screen { padding: 34px 0 28px; border-top: 1px solid var(--dv-hairline); scroll-margin-top: 12px; }
.screen__head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.screen h2 { margin: 0 0 6px; font: 600 var(--text-lg)/1.3 var(--font-sans); letter-spacing: var(--tracking-tight); }
.screen__meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font: 400 var(--text-2xs)/1.4 var(--font-sans); color: var(--dv-ink-soft); }
.screen__meta code { font: 400 var(--text-2xs)/1.4 var(--font-mono); background: var(--dv-code-bg); padding: 1px 6px; border-radius: 4px; }
.screen__frame { font: 500 var(--text-xs)/1.4 var(--font-sans); color: var(--dv-link); text-decoration: none; }
.screen__frame:hover { text-decoration: underline; }
.screen__caption { margin: 10px 0 12px; max-width: 110ch; color: var(--dv-ink-body); }
.tag { font: 500 var(--text-2xs)/1 var(--font-mono); text-transform: uppercase; letter-spacing: var(--tracking-label); padding: 4px 8px; border-radius: 99px; }
.tag--built { background: rgba(45,123,122,.14); color: #2d7b7a; } .tag--drifted { background: rgba(200,141,50,.16); color: #8a5f16; } .tag--drawn { background: rgba(185,72,61,.14); color: #b9483d; }
.stage { border: 1px solid var(--dv-card-line); border-radius: 12px; overflow: hidden; background: var(--background); box-shadow: var(--dv-card-shadow); }
.stage__scale { transform-origin: top left; }
.built { margin-top: 14px; border: 1px solid var(--dv-hairline); border-left: 3px solid #2d7b7a; border-radius: 10px; padding: 12px 16px; max-width: 1360px; box-sizing: border-box; }
.built--drifted { border-left-color: #c88d32; } .built--drawn { border-left-color: #b9483d; }
.built__head { display: flex; align-items: center; gap: 10px; }
.built__label { font: 500 var(--text-2xs)/1.2 var(--font-sans); letter-spacing: var(--tracking-label); text-transform: uppercase; color: var(--dv-ink-faint); }
.built ul { margin: 8px 0 0; padding-left: 18px; } .built li { margin: 4px 0; color: var(--dv-ink-body); }
.built code, .undrawn code { font: 400 var(--text-2xs)/1.4 var(--font-mono); background: var(--dv-code-bg); padding: 1px 5px; border-radius: 3px; }
.undrawn { margin-top: 12px; padding: 14px 16px; border: 1px dashed var(--dv-card-line); border-radius: 10px; max-width: 1360px; box-sizing: border-box; color: var(--dv-ink-body); }
.rules { margin-top: 6px; }
.rules__head { margin: 18px 0 0; font: 500 var(--text-2xs)/1.2 var(--font-sans); letter-spacing: var(--tracking-label); text-transform: uppercase; color: var(--dv-ink-faint); }
.rules__head a { color: var(--dv-link); } .rules__head span { text-transform: none; letter-spacing: 0; font: 400 var(--text-xs)/1.4 var(--font-sans); color: var(--dv-ink-soft); margin-left: 6px; }
.rules .dv-rule { margin-top: 10px; }
.pages { width: 100%; max-width: 1100px; border-collapse: collapse; margin-top: 14px; }
.pages th, .pages td { text-align: left; vertical-align: top; padding: 9px 12px 9px 0; border-bottom: 1px solid var(--dv-hairline); font: 400 var(--text-xs)/1.5 var(--font-sans); }
.pages th { font-weight: 600; } .pages a { color: var(--dv-link); }
/* The master writes its controls as <x-import>, resolved by the design tool and by nothing else —
   so copied out of it a button would render as bare text. The design system's Button and Badge,
   restated in plain CSS off the attributes the master already carries. */
x-import { display: inline-flex; align-items: center; justify-content: center; text-align: center; box-sizing: border-box; }
x-import[component-from-global-scope$="Button"] { height: 36px; padding: 0 15px; border-radius: var(--radius-md); cursor: pointer; background: var(--primary); color: var(--primary-foreground); font: 500 var(--text-sm) var(--font-sans); box-shadow: var(--shadow-xs); border: 1px solid transparent; }
x-import[component-from-global-scope$="Button"][size="lg"] { height: 40px; }
x-import[component-from-global-scope$="Button"][size="sm"] { height: 32px; font-size: var(--text-xs); padding: 0 12px; }
x-import[component-from-global-scope$="Button"][variant="secondary"] { background: var(--secondary); color: var(--foreground); }
x-import[component-from-global-scope$="Button"][variant="outline"], x-import[component-from-global-scope$="Button"][variant="ghost"] { background: transparent; color: var(--foreground); box-shadow: none; }
x-import[component-from-global-scope$="Button"][variant="outline"] { border-color: var(--border); }
x-import[component-from-global-scope$="Badge"] { height: 22px; padding: 0 9px; border-radius: 99px; border: 1px solid var(--border); font: 400 var(--text-2xs) var(--font-mono); color: var(--muted-foreground); }
x-import[hint-size^="100%"] { width: 100%; }
</style>
</head>
<body>
<div class="wrap">
  <nav class="rail">
    <h2 class="rail__title">Design review</h2>
    <p class="rail__sub">The master's latest frame for each screen, in the order a person uses them, with what shipped beside it.</p>
    ${railHtml}
    <div class="rail__group">Pages</div>
    <a class="rail__item" href="#pages"><span>Every page in this folder</span></a>
  </nav>
  <main class="main">
    <div class="top">
      <h1>Arke Studio · design review</h1>
      <p>Generated ${generated} from <code>Arke Studio.dc.html</code> by <code>npm run design:review</code>; this page never edits the master. Each screen is its latest frame, copied verbatim, then what shipped, then the turn's binding rules. A screen the master has deliberately not drawn says so. The build refuses a missing frame, a bitmap in place of a drawing, and a frame that does not carry a control the build shipped.</p>
    </div>
    <div class="legend"><span><i class="dot dot--built"></i> built</span><span><i class="dot dot--drifted"></i> built · drifted from the drawing</span><span><i class="dot dot--drawn"></i> drawn · not built</span></div>
    ${screensHtml}
    <section class="screen" id="pages">
      <h2>Every page in this folder</h2>
      ${pagesHtml}
    </section>
  </main>
</div>
<script>
  // Frames are drawn at their own width; scale each down to the column, never up.
  function fit() {
    for (const stage of document.querySelectorAll(".stage")) {
      const width = Number(stage.dataset.width) || 1360;
      const scale = Math.min(1, stage.clientWidth / width);
      const inner = stage.querySelector(".stage__scale");
      inner.style.transform = "scale(" + scale + ")";
      stage.style.height = Math.round(inner.getBoundingClientRect().height) + "px";
    }
  }
  addEventListener("resize", fit);
  addEventListener("load", fit);
  fit();
</script>
</body>
</html>
`;

if (process.argv.includes("--check")) {
  // The committed page must be the master's current reading, or it is the stale companion this
  // page replaced. Only the generation date is allowed to differ.
  const undated = (s) => s.replace(/Generated \d{4}-\d{2}-\d{2}/, "Generated");
  let committed = "";
  try { committed = readFileSync(OUT, "utf8"); } catch { /* absent counts as stale */ }
  if (undated(committed) !== undated(page)) {
    console.error("design-review: design-review.html is behind the master — run `npm run design:review` and commit it");
    process.exit(1);
  }
  console.log(`design-review: ${sections.length} screens resolve to frames that carry their controls; design-review.html is current`);
  process.exit(0);
}

writeFileSync(OUT, page);
console.log(`wrote design-review.html · ${sections.length} screens · ${page.length} bytes`);

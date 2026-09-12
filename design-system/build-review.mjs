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

  { group: "Scene workspace", screen: "Storyboard · List", frame: "145a", route: "#/w/:worldId/p/:prodId/scenes/:sceneId", status: "drifted", checked: "2026-09-12",
    controls: ["Review scene", "Generate frames", "Regenerate", "Generate frame", "List", "Grid"],
    notes: ["Built by PR 1092 to the 138 bitmap and PR 1102 to 143a: the row unfolds in place to Description, Frame prompt, Notes and Shot settings, and the others fold to 60px.", "Turn 145 draws the row as a row: the script typed on it, no <code>Frame prompt</code> toggle, no unfolding, a chevron that opens the shot page, 14px above and below the frame, and <code>Storyboard &middot; Flow &middot; Preview</code> with the Stage gone to the page; the List is no longer the default. Drawn, not built. Turn 139's scale is still issue 1096 A."] },
  { group: "Scene workspace", screen: "Shot", frame: "145b", route: "#/w/:worldId/p/:prodId/scenes/:sceneId/shots/:shotId", status: "drifted", checked: "2026-09-12",
    controls: ["Regenerate", "View full prompt", "Rebuild"],
    notes: ["The route exists and ships turn 97's shot sheet (14d, <code>storyboard.tsx</code>), reached from the row's <code>Advanced</code>: the old chrome, no dock, recipes, and Camera / Sound / Continuity / Technical as an accordion.", "Turn 145 replaces it with the page: the filmstrip, <code>Shot &middot; Stage</code>, the frame whole beside Script, Frame prompt, Notes, Camera, Timing, Continuity, Sound and Props (145b, 145c), the no-frame state (145e), and the dock as <code>Arke &middot; Shot 1</code>. Drawn, not built."] },
  { group: "Scene workspace", screen: "Storyboard · Grid", frame: "145f", route: "#/w/:worldId/p/:prodId/scenes/:sceneId · Grid", status: "drifted", checked: "2026-09-12",
    controls: ["Grid", "Regenerate", "Needs frame"],
    notes: ["Built by PR 1092 as the same rows in a grid; drawn for the first time in 139b. Same type-scale drift as the List.", "Turn 145 makes the Grid the storyboard&#8217;s default, <code>Grid &middot; List</code> in the control, and redraws the card without the <code>Frame prompt</code> toggle and with a chevron on the foot; a press on the card opens the shot page (145f). The card follows the production&#8217;s aspect and the columns follow it &#8212; four across at portrait, three at landscape (145g). Drawn, not built: the build opens on the List and draws four columns at every aspect."] },
  { group: "Scene workspace", screen: "Shot row · Frame prompt", frame: "139c", route: "rows.tsx", status: "drifted", checked: "2026-09-12",
    controls: ["Authored", "Rebuild", "Hide", "image prompt"],
    notes: ["Collapsed at rest with <code>Authored</code>, open with <code>Rebuild</code> and <code>Hide</code> — ships.", "Withdrawn by turn 145: the prompt is a section of the shot page (145b), and the row carries no toggle. The build still ships it.", "The prompt shown is assembled for the video capability and labelled <i>image prompt</i>; the frame run sends the image-capability prompt (issue 1096 B3)."] },
  { group: "Scene workspace", screen: "Frame run dialog", frame: "141a", route: "frame-run.tsx", status: "drifted", checked: "2026-09-11",
    controls: ["Per shot", "Shot board", "Shots without a frame", "Cancel", "Generate"],
    notes: ["Method, Include, Model with the aspect verdict, References and the props guard ship as drawn.", "A row's <code>Generate frame</code> still hands off to the Cut and assembles the scene, and a still is refused for the Cut's clock (issue 1096 D2, D3). A location mention reaches the provider raw (D1)."] },
  { group: "Scene workspace", screen: "Flow", frame: "135b", route: "#/w/:worldId/p/:prodId/scenes/:sceneId · Flow", status: "built", checked: "2026-09-10",
    controls: ["Flow"],
    notes: ["SPEC-044 / PR 1082: the character as a node feeding the shots that cite her; the cast row and its doors."] },
  { group: "Scene workspace", screen: "Flow · full screen", frame: "135h", route: "… · Flow · full screen", status: "built", checked: "2026-09-10",
    controls: ["Esc"],
    notes: ["Issue 1078: the glyph at the right end of the view row; the pill and the reversed glyph with <code>Esc</code>."] },
  { group: "Scene workspace", screen: "Stage", frame: "145d", route: "#/w/:worldId/p/:prodId/scenes/:sceneId/shots/:shotId · Stage", status: "drifted", checked: "2026-09-12",
    controls: ["Build with Arke", "Keep blocking", "Look", "Camera", "Keep", "Loop", "Add set", "Turn with target"],
    notes: ["Built by PR 900 and the 1040–1051 series as a view of the scene page with its own <code>&lsaquo; Shot 1 &rsaquo;</code> stepper; drawn first in 140a, the panel redrawn as an inspector in 144a, which PR 1104 builds.", "Turn 145 moves it onto the shot page as its second view (145d): the filmstrip steps, the stepper line goes, and <code>v3 &middot; 3 keys &middot; push in</code> sits on the view row. The body is 144a's, unchanged. Drawn, not built.", "Round-57 findings are in issue 1094."] },
  { group: "Scene workspace", screen: "Stage · full screen", frame: "144b", route: "… · Stage · full screen", status: "built", checked: "2026-09-11",
    controls: ["Build with Arke", "Render with this"],
    notes: ["Issue 1078 gave the Stage the Flow's full screen; 144b moves the way out onto the head row (PR 1104)."] },
  { group: "Scene workspace", screen: "Preview", frame: null, route: "#/w/:worldId/p/:prodId/scenes/:sceneId · Preview", status: "built", checked: "2026-09-11",
    controls: [],
    notes: ["Built, not drawn: the master says so in turn 140. The view plays the scene's frames and clips in order (preview.tsx)."] },

  { group: "Make", screen: "Bench", frame: "142a", route: "#/w/:worldId/generate", status: "drifted", checked: "2026-09-11",
    controls: ["Reference", "Keyframe", "End frame", "Image 1", "Presets", "Generate", "voice refs"],
    notes: ["Keyframe slots (PR 900), voice references (PR 856) and Presets ship; drawn for the first time in 142a.", "On the build the filters stack vertically, the model select is 60px wide under the estimate, and the voice-references label wraps to seven lines; two captions stand above and below the brief (issue 1096 C). Turn 142 binds one row and a chip."] },
  { group: "Make", screen: "Cut", frame: "122a", route: "#/w/:worldId/p/:prodId/cut", status: "built", checked: "2026-09-09",
    controls: ["Library"],
    notes: ["The library beside the cut with one drag engine and posters by artifact id (PR 1054); typed trims in the Inspector and audio import (PR 944); the export sheet at <code>/cut?export=1</code> owns delivery."] },

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
  { group: "Around it", screen: "Character voice", frame: "132a", route: "#/w/:worldId/cast/:id/voice", status: "built", checked: "2026-09-08",
    controls: ["Voice"],
    notes: ["PR 1023: one voice with two uses, four entrances, the bible on the performance panel."] },
  { group: "Around it", screen: "Chapter (story)", frame: "126a", route: "#/w/:worldId/p/:prodId/chapters/:id", status: "built", checked: "2026-09-07",
    controls: ["Read the chapter"],
    notes: ["Story mode for novelists, turns 126–131, PRs 877–933: the chapter read, typed into and heard, beside what it draws on."] },
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
  const rules = s.rules.length ? `<div class="rules"><div class="rules__head">Binding · turn <a href="Arke%20Studio.dc.html#t${s.turn}">${s.turn}</a> <span>${s.turnName}</span></div>${s.rules.map((r) => `<p class="dv-rule">${r}</p>`).join("")}</div>` : "";
  return `
    <section class="screen" id="${esc(slug(s.screen))}">
      <div class="screen__head">
        <div><h2>${esc(s.screen)}</h2><div class="screen__meta"><span class="tag tag--${s.status}">${status}</span><code>${esc(s.route)}</code><span>checked ${s.checked}</span></div></div>
        <a class="screen__frame" href="Arke%20Studio.dc.html#${s.frame}">${s.frame} in the master →</a>
      </div>
      <p class="screen__caption">${s.caption}</p>
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

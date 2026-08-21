// Build design-system/workflow-walkthrough.html: the design master's own frames, wired into the
// order a person actually walks, each annotated with what shipped. The master is never modified —
// frames are copied out of it, so the drawing stays the single source and this is a reading of it.
import { readFileSync, writeFileSync } from "node:fs";

const SCRATCH = process.argv[2];
const OUT = process.argv[3];
const frames = JSON.parse(readFileSync(SCRATCH + "/frames.json", "utf8"));
const tokens = readFileSync(SCRATCH + "/tokens.css", "utf8");

/**
 * The walk. `actions` are the buttons that must work: matched against the frame's own text, so a
 * hotspot exists only where the drawing really put a control. `built` is the comparison the whole
 * page exists for — status, the route in the shipped app, and what differs.
 */
const STEPS = [
  {
    id: "1a", step: "Pick a world",
    actions: [{ match: "The Undersong", to: "2c", hint: "open the world" }],
    built: { status: "drifted", route: "#/worlds",
      notes: ["Ships as the world picker with cards per world.",
              "Built without a frame: <code>Archive — moves the folder, deletes nothing</code> and <code>Install the sample world</code>."] },
  },
  {
    id: "2c", step: "Productions",
    actions: [{ match: "New production", to: "43a", hint: "start a production" }],
    built: { status: "built", route: "#/w/:worldId/productions",
      notes: ["Ships close to the drawing."] },
  },
  {
    id: "43a", step: "Step one · what are you making?",
    actions: [{ match: "Create and open day one", to: "53a", hint: "the drawing's primary action" }],
    built: { status: "built", route: "#/w/:worldId/productions/new",
      notes: ["<b>Built to the drawing (turn 85).</b> The modal now stands over the world's key art blurred back, the name field and joins line read as drawn, and the caption <code>nothing generates · nothing is copied out of the world</code> is under the buttons where the frame puts it.",
              "<b>Turn 83's binding is now met:</b> with Video selected the primary reads <code>Continue · what kind of video?</code> and routes to step two — it no longer creates past the kind. A one-kind family (Story, Interactive video) still creates directly, from <code>Create and open day one</code>.",
              "Third card is <b>Interactive video</b>, not the drawn <b>Stills</b> — turn 84's replacement, and turn 85 records that the drawing is the stale side here.",
              "Card copy is 6a's rather than 43a's, settled by turn 85 in the build's favour: this page shows 43a, so read its three card bodies as retired."] },
  },
  {
    id: "53a", step: "Step two · what kind of video?",
    actions: [{ match: "Create and open it", to: "53b", hint: "create the production" }],
    built: { status: "built", route: "#/w/:worldId/productions/new · step 2",
      notes: ["<b>Built to the drawing (turn 85).</b> It is its own screen now, with <code>What kind of video?</code>, the <code>step 2 of 2</code> counter, <code>Back</code>, and the caption <code>defaults · change them here or later</code>.",
              "<b>All three kinds are offered</b>, Music video included, in the frame's own words. A kind only sets starting numbers, so a music video is an ordinary Video production — what it still lacks is turn 60's Spine authoring, not coherence.",
              "<b><code>EPISODE LENGTH</code> is asked at last</b>, alongside FRAME, EPISODES and ENDING in mono caps, and the chosen range is written into <code>season.json</code> — verified end to end: picking 90–120s lands <code>episodeSecondsMin: 90</code> / <code>episodeSecondsMax: 120</code> on disk.",
              "The kind cards hold the banner area the frame draws, sized and waiting: there is no art for them yet, so the choice is still made by reading. That is the one part of 53a still outstanding.",
              "Beyond the drawing: a <code>Series name</code> field, which a Series being created genuinely needs."] },
  },
  {
    id: "53b", step: "Day one",
    actions: [{ match: "Write the first scene", to: "49a", hint: "straight to a scene" },
              { match: "Shape the whole thing first", to: "89a", hint: "decide what it is first" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId",
      notes: ["<b>Turn 93: this frame is a one-off Video's day one, not an episodic production's.</b> A Microdrama is created saying how many episodes it has, so its empty state is already drawn — 91a with every tile dashed — and its front page is its season. What it adds when nothing is decided is one line naming Production Chat, because a board of dashed tiles says what is missing and not what to do about it.",
              "<b>And the check behind this frame was wrong.</b> Day one counted scenes, takes and chapters — three things a microdrama can be a long way into a season without having — so a season with a question, an ending and three written episodes still opened here, offering <code>Shape the whole thing first</code> to somebody who had just done exactly that, while Season next door said <code>3 written</code>.",
              "<b>Built to the drawing (turn 53b).</b> The production's own name, the line saying nothing is written yet, a box to type in, the promise <code>talking writes nothing · you accept what you keep</code>, and both ways in — all as drawn.",
              "<b>What stood here is gone:</b> frame 43b's world inventory and its rail of canon seeds, which turn 53 cut and turn 83 superseded in whole. Turn 83 leaves seeds a way back, but only once the plain path has been used and found wanting — a decision to take deliberately rather than by leaving the old screen up.",
              "<b>Sending lands in Production Chat.</b> What you type becomes the opening line of the production's own thread, and the chat shows it back with a way to keep going — a send that landed on a screen with no trace of it would read as a lost message.",
              "The composer carries attach and voice, which the house binds every composer to since turn 41; a file dropped here is filed as the production's own artifact, since there is no conversation yet to attach it to.",
              "Beyond the drawing: the Delivery aspect selector (issue 389) sits <i>below</i> the two cards, so it stays reachable without interrupting the opening the frame draws.",
              "A Story production keeps its own day one (frame 54a) — this frame is drawn for a Video production and only that branch changed."] },
  },
  {
    id: "89a", step: "Production Chat · the conversation",
    actions: [{ match: "Wrap up · stage what is settled", to: "91a", hint: "stage what is settled, and land on the season" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/story",
      notes: ["<b>Turn 92: the wrap-up is built.</b> It was drawn on this frame from the start and existed nowhere, so this screen had a link to Season and no way to turn a conversation into anything — the first hop anybody walks was the one place the pattern was missing. The button now stages what is settled, says <code>nothing is settled yet · save a point above to make it ready</code> while it cannot be pressed, and shows a refused wrap-up rather than swallowing it.",
              "<b>And the rail's second state with it.</b> Once wrap-up has staged the season, the same rail becomes the staged proposal under <b>Accept Proposal</b>, and accepting lands on Season. One component draws that state at every level, so the season's and the episode's cannot drift apart.",
              "<b>Newly drawn (turn 89).</b> Frame 44a drew this screen with a staged-proposal rail; three turns of argument later the rail beside a <i>conversation</i> holds what it understood, not what it staged. This is the frame for what ships — 44a stands as the drawing it replaced.",
              "<b>It is called Production Chat.</b> &#8220;Development&#8221; named a phase of filmmaking rather than a thing on a screen. This is World Chat with a production for a subject — same transcript, same points, same wrap-up, same gate — and the name says so.",
              "<b>The details moved out.</b> What the conversation settles is read next door, on <code>Season</code> or <code>Overview</code>, which is its own rail item. Every screen used to be half a place to make something and half a place to read it, and a person could not tell which they were doing.",
              "<b>Turn 91 amends this frame on one point.</b> The rail's two states belong to two <i>moments</i>, not two screens: while talking it holds these points, and at wrap-up the same rail becomes the staged proposal under <code>Accept Proposal</code> — drawn one level down on 91b, and the same at every level. Accepting lands you on the season.",
              "The form editor behind <code>Start the overview</code> is gone, and so is the button that used to send you to World Chat."] },
  },
  {
    id: "91a", step: "Season · the overview",
    actions: [{ match: "Her mother\u2019s hour", to: "91b", hint: "open an episode" },
              { match: "Arcs \u00b7 4", to: "48b", hint: "the season's other tab" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/season",
      notes: ["<b>Turn 92: a press that stages something says so where it was pressed.</b> Opening a blank tile staged the episode exactly as intended and changed nothing on screen — the only mark anywhere was an unlabelled dot in the far corner of the chrome. The tile now answers immediately with <code>STARTING…</code> and settles into a <code>STAGED · NOT WRITTEN YET</code> tile carrying the name and number the proposal gave it.",
              "<b>The board reads the gate's own labels</b> — <code>Title</code>, <code>Order</code>, capitalised for reading — which a lowercase lookup missed silently, producing an unnumbered tile wearing a proposal summary for a title.",
              "<b>Built to the drawing (turn 91).</b> The production's own title as the heading, the counts as pills, and the season record — question, ending, inherited Series engine — in the header rather than behind a tab. Two tabs: <code>Episodes · 7</code> and <code>Arcs · 0</code>.",
              "<b>Three screens became one.</b> The Season tab, the separate episode board and the Direction tab are gone; Direction keeps its field on <code>season.json</code> and the conversation may still settle it.",
              "<b>Dashed tiles ship</b>, seven wide from the day the season declares seven — verified against a real production on disk: 3 written, 4 reading <code>OPEN TO START IT</code>, with <code>4 of 7 promised by the season and not started</code> beneath.",
              "<b>A missing style, found by looking.</b> <code>fy-emptycard</code> had three callers and no CSS anywhere, so the blank tiles came out in the browser's own grey-and-outset button chrome. Defined now, dashed as drawn.",
              "Beyond the drawing: the <code>↑ ↓</code> reorder buttons and the season <b>Findings</b> panel, both of which predate turn 91 and still earn their place."] },
  },
  {
    id: "48b", step: "Arcs · lanes across the season",
    actions: [{ match: "Episodes", to: "91a", hint: "back to the episodes" }],
    built: { status: "drifted", route: "Season \u2192 Arcs tab",
      notes: ["<b>Read the strip around this one as retired.</b> This is the old drawing, so it still shows four tabs including Direction; turn 91 leaves the Arcs grid itself untouched and replaces everything around it with 91a.",
              "The stalled-lane callout ships (<code>\"{arc}\" has no payoff</code>) \u2713.",
              "Cells print the literal words <code>SETUP</code> / <code>TURN</code> / <code>PAYOFF</code> and <code>\u2014</code>, where the drawing holds a phrase per cell (<i>rings alone</i>, <i>shows Odile</i>) with the markers alongside.",
              "<code>Add a lane</code> and the composer row are absent."] },
  },
  {
    id: "91b", step: "Episode Chat · and the proposal it ends in",
    actions: [{ match: "Accept Proposal", to: "91c", hint: "accept what the conversation settled" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/story/episodes/:id",
      notes: ["<b>Built to the drawing (turn 91).</b> An episode's tile opens a conversation with the episode named in the eyebrow, its own thread (entry context <code>episode</code>, so the coordinator briefs it on that episode rather than the season), and the composer the house binds every chat to.",
              "<b>The rail's two states are built as two moments.</b> With nothing staged it holds the points; with a proposal staged against this episode's file it holds that proposal field by field under <b>Accept Proposal</b>, which calls the same gate accept as the Proposals screen and then lands you on the episode.",
              "<b>Verified in the running app</b> for the first state, and by test for both. <b>Not yet driven end to end</b>: no episode wrap-up has been run against a live provider to watch a real proposal appear in this rail.",
              "<b>What is gone:</b> the promise editor. Three inputs behind <code>Edit the promise</code> were the second way to author one file, which is what turn 88 broke apart at season level."] },
  },
  {
    id: "91c", step: "The episode · summary, then scenes",
    actions: [{ match: "The hour found", to: "49a", hint: "open a scene with no script" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/episodes/:id",
      notes: ["<b>Turn 92: one control, one destination.</b> A tile used to open the chat when nothing was written and the page when something was; the same click landed in two places according to state nobody could see beforehand. Every tile opens the page. The tiles are links now rather than buttons, so middle-click and copy-link work — and so where a tile leads is something a test can read, which the version with an <code>onClick</code> was not.",
              "<b>Built to the drawing (turn 91).</b> The promise in the header, <code>Scenes · in order</code> as a heading rather than a strip of one tab, and the scene cards below it.",
              "<b>Both directions work</b>, checked by clicking: <code>← Season</code> up, <code>Talk it through</code> back into this episode's own thread, and the rail marks <b>Season</b> on both of an episode's screens — they live outside the <code>season</code> path, so without that the rail went blank exactly two levels deep.",
              "<b>A written episode opens here; an unwritten one opens its chat.</b> Day one's rule one level down: there is nothing to look at until something has been said.",
              "<b>Still the stopgap:</b> the <code>DRAFTED ELSEWHERE · NOT IN ANY EPISODE</code> band. Until turn 87's cascade lands, scenes are drafted somewhere else and adopted here, which runs the arrow backwards. Said out loud rather than dressed up."] },
  },
  {
    id: "49a", step: "The script",
    actions: [{ match: "Turn this into a proposal", to: "49b", hint: "accept the script" }],
    built: { status: "missing", route: "— no screen —",
      notes: ["<b>Turn 94: the scene is talked through in place now.</b> Its conversation used to open World Chat on another screen, so the shape a person had learned twice — talk here, accept here, land on the thing — stopped working at the level where the writing happens. Scene Chat is the same component with a smaller subject, and its <code>Talk it through</code> stays on this production.",
              "<b>The script surface itself is still not built</b> — no block ids in the margin, no <code>S01</code> / <code>A01</code> / <code>D01</code>. What exists is the conversation that would produce one and the accept that would land it.",
              "<b>Read <code>Turn this into a proposal</code> here as retired</b> (turn 91). The scene frames still carry the old wording because they have not been redrawn; the button is <code>Accept Proposal</code> at every level, since by the time a person reads what a conversation settled it already is one.",
              "<b>Not built.</b> There is no script surface: no block ids in the margin, no <code>S01</code> / <code>A01</code> / <code>D01</code>, no <code>accepting writes the script and creates no shots</code>.",
              "The scene screen ships a two-item strip — <code>Shots</code> and <code>Board</code> — where the drawing has four: <code>Script · Coverage · Board · Takes</code>.",
              "The <i>data model</i> is ahead of the screens: scene records carry script blocks, and a shot can cite blocks with a digest of the text at citation time."] },
  },
  {
    id: "49b", step: "Coverage · blocks against shots",
    actions: [{ match: "Turn this into proposals", to: "53e", hint: "accept the coverage" }],
    built: { status: "missing", route: "— no screen —",
      notes: ["<b>Not built.</b> No blocks-against-shots view, no <code>5 of 7 blocks covered</code>, no <code>NO SHOT COVERS THIS</code> row.",
              "49c (<i>covers text that changed</i> / <i>covers nothing</i> after an edit) and 50a–50c (split and merge) are not built either."] },
  },
  {
    id: "53e", step: "The board · priced, nothing sent",
    actions: [{ match: "Two-shot at the door", to: "53d", hint: "click a panel to change it" }],
    built: { status: "missing", route: "— no board screen —",
      notes: ["<b>Not built.</b> No priced panels, no <code>4 shots · 17s owned · 18s asked · 9:16</code> status line, no <code>Generate 4 shots · $5.46</code>.",
              "Staleness is whole-board in the app (<code>stale — scene is at v{n}</code>), never per panel as 51b draws.",
              "What did land, elsewhere: the <code>BEFORE YOU SPEND</code> warning bar ships in the <b>dispatch dialog</b> as <i>“{n} things worth knowing — none blocks”</i>, and <code>Export sheet</code> survives on the scene's Board tab."] },
  },
  {
    id: "53d", step: "One panel selected",
    actions: [{ match: "Generate this shot", to: "79a", hint: "spend on one shot" }],
    built: { status: "missing", route: "— no screen — (nearest: dispatch dialog)",
      notes: ["<b>Not built.</b> Selecting a panel does not open <code>PROMPT</code> / <code>Reset to assembled</code> / <code>MODEL</code> / <code>SIZE</code> / <code>LENGTH</code> / <code>REFERENCES</code> in place.",
              "The promises survive in the dispatch dialog: an edited prompt says it was edited and offers the assembled one back, both prices are on screen, warnings name their shot.",
              "Built without a frame: the whole SPEC-024 <b>plans panel</b> — <code>Review-gated</code> / <code>Pre-authorized</code> / <code>Continue · pass {i} · $x</code> / <code>Cancel plan</code>."] },
  },
  {
    id: "79a", step: "Dispatched · what the notification says",
    actions: [{ match: "Generate", to: "11b", hint: "watch it come back" }],
    built: { status: "built", route: "notification copy in components/queue-note.ts",
      notes: ["The binding ships literally: <code>model · cost</code>, <code>· N queued</code> only when something is ahead, <code>local</code> where the figure would be, one row updated in place ✓.",
              "The board that hosts it is the part that does not exist."] },
  },
  {
    id: "11b", step: "Generate · review the takes",
    actions: [{ match: "Accept take", to: "81a", hint: "accept a take into the cut" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/generate",
      notes: ["Three columns ship as drawn: composer left with <code>Reset</code>, viewer centre, takes rail right ✓.",
              "The seg reads <code>Shot · Scene · Contact sheet</code> — turn 55a's binding, met verbatim ✓.",
              "Accepting is <code>Accept take</code> / <code>Reject · cite the sheet</code> with the receipt <i>rejections teach the shot · accepts lock the clip into the cut</i>.",
              "Ergonomics worth fixing: the shot picker is a <code>&lt;select&gt;</code>, and <b>Accept take is disabled unless the selected take is the pending one</b> — easy to read as broken."] },
  },
  {
    id: "81a", step: "The cut",
    actions: [{ match: "Export cut", to: "25b", hint: "render a deliverable" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/cut",
      notes: ["<b>Matches.</b> Header template, <code>Watch from top</code>, <code>Export cut…</code>, the scene band over a <code>V</code> lane, both gap cards, the <code>A</code> lane and the trim strip with <code>TRIM IN</code> − / + all ship ✓.",
              "The rail folds on this route ✓ and the artifacts panel opens (82a) — though its <code>Filter</code> control is missing and rows show a basename rather than <code>WAV · 2:14</code>.",
              "<b>Music-video clock (80a): the section band (<code>INTRO | VERSE 1 | CHORUS…</code>) is not rendered at all</b>, though turns 80 and 81 both bind it. The anchored-shot count is missing from the header too, and there is no Spine screen to author any of it.",
              "Drift <i>inside the master</i>, visible above: this frame's rail still reads <code>Story v3</code>, though turn 78 — earlier — bound that sweep, and turn 89 has since swept every rail to <b>Production Chat</b>. This frame is the one the sweep could not reach without redrawing it."] },
  },
  {
    id: "25b", step: "Exports · the deliverable",
    actions: [],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/exports",
      notes: ["<b>Matches in shape.</b> <code>renders of the cut · the cut itself stays the source</code>, <code>DELIVERED</code>, <code>NEW EXPORT</code> and all three preset names ship verbatim ✓.",
              "Presets name real sizes: Master is <code>1920×1080 · clean</code>, not ProRes/4K; Social excerpt takes the whole cut, with no <i>pick a scene</i> step.",
              "Rendering says <code>renders locally · no provider call</code> rather than hedging about the machine.",
              "Built without a frame: the <b>Episodes band</b> (each episode its own deliverable, issue 396), the story variant, and the world-folder export bar.",
              "<b>Verified end to end on v0.5.30:</b> this button produced a 1080×1920 h264 file on disk."] },
  },
];

const STATUS_LABEL = { built: "Built · matches", drifted: "Built · drifted", missing: "Not built" };

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const railHtml = `
      <button class="rail__item" data-goto="map" type="button">
        <span class="rail__n">·</span>
        <span class="rail__body">
          <span class="rail__step">The shape of it</span>
          <span class="rail__id">map</span>
        </span>
      </button>` + STEPS.map((s, i) => `
      <button class="rail__item" data-goto="${s.id}" type="button">
        <span class="rail__n">${String(i + 1).padStart(2, "0")}</span>
        <span class="rail__body">
          <span class="rail__step">${s.step}</span>
          <span class="rail__id">${s.id}</span>
        </span>
        <span class="dot dot--${s.built.status}" title="${STATUS_LABEL[s.built.status]}"></span>
      </button>`).join("");

const mapHtml = `
    <section class="screen" data-frame="map" hidden>
<section class="map" id="map">
  <div class="map__head">
    <h2>How a season becomes a film</h2>
    <p>
      One pattern, three times: <b>a chat that makes it, and a screen that shows what it made.</b> The
      season decides what the thing is; an episode decides what happens in it and <b>makes the scenes it
      needs</b>; a scene decides how it is shot. Nothing below a level exists until the level above has
      said what it needs, which is why the arrows only point one way. Beside every chat is what it
      understood so far; beside every details screen is what is staged and waiting on a yes — two
      different things, never drawn as one.
    </p>
  </div>

  <div class="map__grid">
    <div class="lvl">
      <div class="lvl__spine">
        <span class="lvl__n">1</span>
        <span class="lvl__thread">Production Chat</span>
      </div>
      <div class="lvl__body">
        <div class="lvl__title">The season · what this whole thing is</div>
        <div class="cards">
          <div class="card is-built" data-goto="89a">
            <div class="card__k">Talk</div>
            <div class="card__d">One thread for the production. <b>Beside it: what it understood so far</b> — the season question, each episode, each arc — still soft, changed by saying more.</div>
            <div class="card__f">.conversations/cv_*</div>
          </div>
          <div class="card is-built">
            <div class="card__k">Accept</div>
            <div class="card__d">At the end the same rail becomes <b>the staged proposal</b>, every field with what it was and what it would become, under one action. <b>Accept Proposal</b>, not <i>turn this into a proposal</i>.</div>
            <div class="card__f">.proposals/pr_*</div>
          </div>
          <div class="card is-built" data-goto="91a">
            <div class="card__k">The season page</div>
            <div class="card__d">What it is, in the header. What is plural, as tabs: <b>Episodes</b> and <b>Arcs</b>. One season per production — another season is another production.</div>
            <div class="card__f">season.json</div>
          </div>
          <div class="card is-drifted" data-goto="48b">
            <div class="card__k">Arcs</div>
            <div class="card__d">What changes across the season. Needs episodes first — a lane names the episode it lands in.</div>
            <div class="card__f">season.json</div>
          </div>
        </div>
      </div>
    </div>
    <div class="arrow"><span>open an episode</span></div>
    <div class="lvl">
      <div class="lvl__spine">
        <span class="lvl__n">2</span>
        <span class="lvl__thread">Episode Chat</span>
      </div>
      <div class="lvl__body">
        <div class="lvl__title">One episode · what happens in it</div>
        <div class="cards">
          <div class="card is-built" data-goto="91b">
            <div class="card__k">Talk, then accept</div>
            <div class="card__d">The same two states, one level down. <b>The scenes it needs are part of its proposal</b> — turn 87's cascade — rather than drafted elsewhere and adopted from a pool.</div>
            <div class="card__f">episodes/03-*.json · scenes/*.json</div>
          </div>
          <div class="card is-built" data-goto="91c">
            <div class="card__k">The episode page</div>
            <div class="card__d">Its promise in the header; <b>Scenes</b> as the tab. <code>Talk it through</code> goes back into this episode's own thread, because an accept is not the end of a subject.</div>
            <div class="card__f">episodes/03-*.json</div>
          </div>
        </div>
      </div>
    </div>
    <div class="arrow"><span>open a scene</span></div>
    <div class="lvl">
      <div class="lvl__spine">
        <span class="lvl__n">3</span>
        <span class="lvl__thread">Scene Chat</span>
      </div>
      <div class="lvl__body">
        <div class="lvl__title">One scene · how it is shot</div>
        <div class="cards">
          <div class="card is-built">
            <div class="card__k">Talk, then accept</div>
            <div class="card__d">Built (turn 94), and not drawn separately, deliberately: it is the same two screens again with a smaller subject. A rail drawn once is a rail understood everywhere.</div>
            <div class="card__f"></div>
          </div>
          <div class="card is-todo" data-goto="49a">
            <div class="card__k">Script</div>
            <div class="card__d">Written first, in blocks that keep their ids. A script belongs to a scene and to nothing above it.</div>
            <div class="card__f">scenes/*.json</div>
          </div>
          <div class="card is-todo" data-goto="49b">
            <div class="card__k">Coverage</div>
            <div class="card__d">Which shot covers which block — and which blocks nothing covers.</div>
            <div class="card__f">scenes/*.json</div>
          </div>
          <div class="card is-todo" data-goto="53e">
            <div class="card__k">Board</div>
            <div class="card__d">Every shot, priced, before a penny moves.</div>
            <div class="card__f">boards/</div>
          </div>
        </div>
      </div>
    </div>
    <div class="arrow"><span>dispatch · money moves here</span></div>
    <div class="lvl lvl--flat">
      <div class="lvl__spine"><span class="lvl__n">→</span><span class="lvl__thread">no conversation</span></div>
      <div class="lvl__body">
        <div class="lvl__title">Making it</div>
        <div class="cards">
          <div class="card is-built" data-goto="11b"><div class="card__k">Generate</div><div class="card__d">Takes come back; accepting one locks it into the cut.</div><div class="card__f">takes/ · selections.json</div></div>
          <div class="card is-built" data-goto="81a"><div class="card__k">Cut</div><div class="card__d">A projection over accepted takes. Nothing to assemble.</div><div class="card__f">cut.json</div></div>
          <div class="card is-built" data-goto="25b"><div class="card__k">Exports</div><div class="card__d">A render of the cut. Local, no provider call.</div><div class="card__f">exports/*.mp4</div></div>
        </div>
      </div>
    </div>
  </div>

  <div class="map__key">
    <span><i class="dot dot--built"></i> built</span>
    <span><i class="dot dot--drifted"></i> partly built</span>
    <span><i class="dot dot--missing"></i> not built yet</span>
    <span class="map__hint">click any card to jump to its frame</span>
  </div>
</section>

    </section>`;

const framesHtml = STEPS.map((s) => {
  const f = frames[s.id];
  if (!f) throw new Error("missing frame " + s.id);
  const notes = s.built.notes.map((n) => `<li>${n}</li>`).join("");
  const acts = s.actions.length
    ? s.actions.map((a) => `<code>${esc(a.match)}</code> &rarr; ${a.hint}`).join(" &nbsp;·&nbsp; ")
    : "<i>end of the walk</i>";
  return `
    <section class="screen" data-frame="${s.id}" hidden>
      <div class="screen__head">
        <div>
          <div class="screen__step">${s.step}</div>
          <div class="screen__label">${f.label}</div>
        </div>
        <div class="screen__acts"><b>Working here:</b> ${acts}</div>
      </div>
      <div class="stage"><div class="shot__scale">${f.html}</div></div>
      <div class="built built--${s.built.status}">
        <div class="built__head">
          <span class="tag tag--${s.built.status}">${STATUS_LABEL[s.built.status]}</span>
          <code class="built__route">${esc(s.built.route)}</code>
        </div>
        <ul>${notes}</ul>
      </div>
    </section>`;
}).join("");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Arke Studio — the workflow, walked</title>
    <style>
${tokens}

      /* ---- walkthrough chrome (deliberately plain: the frames are the subject) ---- */
      :root { --wt-bg: #f6f4ef; --wt-ink: #1b1a17; --wt-soft: #5d574e; --wt-line: rgba(23,23,21,.14);
              --wt-card: #fffefb; --wt-ok: #2d7b7a; --wt-warn: #c88d32; --wt-bad: #b9483d; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--wt-bg); color: var(--wt-ink);
             font-family: "Geist", "Segoe UI Variable Text", system-ui, sans-serif; }
      .wrap { display: grid; grid-template-columns: 268px 1fr; min-height: 100vh; }

      .rail { border-right: 1px solid var(--wt-line); padding: 18px 14px 28px; position: sticky; top: 0;
              height: 100vh; overflow-y: auto; background: var(--wt-card); }
      .rail__title { font: 600 14px/1.3 inherit; margin: 0 6px 4px; }
      .rail__sub { font: 400 11.5px/1.5 inherit; color: var(--wt-soft); margin: 0 6px 16px; }
      .rail__item { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
                    background: none; border: 0; border-radius: 9px; padding: 7px 8px; cursor: pointer;
                    color: inherit; font: inherit; }
      .rail__item:hover { background: rgba(23,23,21,.05); }
      .rail__item.is-on { background: rgba(23,23,21,.09); }
      .rail__n { font: 500 10px var(--font-mono, monospace); color: var(--wt-soft); flex: none; width: 17px; }
      .rail__body { flex: 1; min-width: 0; }
      .rail__step { display: block; font-size: 12.5px; line-height: 1.35; }
      .rail__id { display: block; font: 400 9.5px var(--font-mono, monospace); color: var(--wt-soft); margin-top: 1px; }
      .dot { width: 7px; height: 7px; border-radius: 99px; flex: none; }
      .dot--built { background: var(--wt-ok); }
      .dot--drifted { background: var(--wt-warn); }
      .dot--missing { background: var(--wt-bad); }

      .main { padding: 22px 28px 70px; min-width: 0; }
      .top { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 4px; }
      .top h1 { font: 600 19px/1.3 inherit; margin: 0; }
      .top p { margin: 0; font-size: 12.5px; color: var(--wt-soft); max-width: 72ch; }
      .legend { display: flex; gap: 14px; margin: 12px 0 18px; font-size: 11.5px; color: var(--wt-soft); }
      .legend span { display: inline-flex; align-items: center; gap: 6px; }

      .screen__head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px;
                      margin-bottom: 10px; flex-wrap: wrap; }
      .screen__step { font: 600 16px/1.3 inherit; }
      .screen__label { font: 400 11px var(--font-mono, monospace); color: var(--wt-soft); margin-top: 3px; }
      .screen__acts { font-size: 11.5px; color: var(--wt-soft); }
      .screen__acts code { background: rgba(23,23,21,.06); padding: 1px 5px; border-radius: 4px; }

      .stage { border: 1px solid var(--wt-line); border-radius: 14px; overflow: hidden; background: #fff;
               box-shadow: 0 10px 30px rgba(28,24,18,.08); }
      /* Same class the copied token CSS scopes every design token to — renaming it here
         would mean editing CSS that is copied verbatim, so the markup adopts the name. */
      .shot__scale { width: 1360px; height: 850px; transform-origin: top left; }

      .built { margin-top: 16px; border: 1px solid var(--wt-line); border-left: 3px solid var(--wt-ok);
               border-radius: 12px; background: var(--wt-card); padding: 13px 17px; }
      .built--drifted { border-left-color: var(--wt-warn); }
      .built--missing { border-left-color: var(--wt-bad); }
      .built__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .tag { font: 500 10px var(--font-mono, monospace); text-transform: uppercase; letter-spacing: .09em;
             padding: 3px 8px; border-radius: 99px; }
      .tag--built { background: rgba(45,123,122,.13); color: var(--wt-ok); }
      .tag--drifted { background: rgba(200,141,50,.15); color: #8a5f16; }
      .tag--missing { background: rgba(185,72,61,.13); color: var(--wt-bad); }
      .built__route { font: 400 11px var(--font-mono, monospace); color: var(--wt-soft); }
      .built ul { margin: 9px 0 0; padding-left: 19px; }
      .built li { margin: 5px 0; font-size: 13px; line-height: 1.55; color: #35322c; }
      .built code { font: 400 11.5px var(--font-mono, monospace); background: rgba(23,23,21,.06);
                    padding: 1px 5px; border-radius: 4px; }

      .nav { position: fixed; right: 26px; bottom: 22px; display: flex; gap: 8px; z-index: 40; }
      .nav button { font: 500 13px inherit; padding: 9px 16px; border-radius: 9px; cursor: pointer;
                    border: 1px solid var(--wt-line); background: var(--wt-card); color: inherit;
                    box-shadow: 0 6px 18px rgba(28,24,18,.12); }
      .nav button[disabled] { opacity: .4; cursor: default; }
      .nav .is-primary { background: #1b1a17; color: #fff; border-color: #1b1a17; }


      /* ---- the map: the shape of the work, before any one screen ---- */
      .map { max-width: 1180px; }
      .map__head h2 { font: 600 20px/1.3 inherit; margin: 0 0 6px; }
      .map__head p { margin: 0 0 22px; font-size: 13.5px; line-height: 1.65; color: var(--wt-soft); max-width: 78ch; }
      .map__grid { display: grid; gap: 0; }
      .lvl { display: grid; grid-template-columns: 132px 1fr; gap: 18px; align-items: start;
             border: 1px solid var(--wt-line); border-radius: 14px; background: var(--wt-card); padding: 16px 18px; }
      .lvl--flat { background: transparent; }
      .lvl__spine { display: grid; gap: 4px; }
      .lvl__n { font: 600 22px var(--font-mono, monospace); color: var(--wt-ink); }
      .lvl__thread { font: 400 10.5px var(--font-mono, monospace); color: var(--wt-soft); line-height: 1.4; }
      .lvl__title { font: 600 14px inherit; margin-bottom: 10px; }
      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(196px, 1fr)); gap: 10px; }
      .card { border: 1px solid var(--wt-line); border-left: 3px solid var(--wt-ok); border-radius: 10px;
              padding: 11px 13px; background: #fff; cursor: default; }
      .card[data-goto] { cursor: pointer; }
      .card[data-goto]:hover { box-shadow: 0 6px 18px rgba(28,24,18,.10); transform: translateY(-1px); }
      .card.is-part { border-left-color: var(--wt-warn); }
      .card.is-todo { border-left-color: var(--wt-bad); }
      .card__k { font: 600 13px inherit; }
      .card__d { font-size: 12px; line-height: 1.55; color: var(--wt-soft); margin-top: 4px; }
      .card__f { font: 400 10px var(--font-mono, monospace); color: var(--wt-soft); margin-top: 8px; opacity: .8; }
      .arrow { display: flex; align-items: center; gap: 10px; padding: 9px 0 9px 60px; }
      .arrow::before { content: "↓"; font-size: 15px; color: var(--wt-soft); }
      .arrow span { font: 400 11px var(--font-mono, monospace); color: var(--wt-soft); }
      .map__key { display: flex; gap: 16px; align-items: center; margin-top: 18px; font-size: 11.5px; color: var(--wt-soft); }
      .map__key span { display: inline-flex; align-items: center; gap: 6px; }
      .map__hint { margin-left: auto; font-style: italic; }

      /* The master writes its controls as <x-import>, resolved by the design tool and by nothing
         else — so copied out of it, every button in every frame rendered as bare inline text. The
         page exists to answer "does this button work", and a control that does not look like one
         answers no before it is clicked. These rules are the design system's Button and Badge
         restated in plain CSS, keyed off the attributes the master already carries. */
      x-import { display: inline-flex; align-items: center; justify-content: center; text-align: center;
                 box-sizing: border-box; }
      x-import[component-from-global-scope$="Button"] {
        height: 36px; padding: 0 15px; border-radius: var(--radius-md); cursor: pointer;
        background: var(--primary); color: var(--primary-foreground);
        font: 500 13px var(--font-sans); box-shadow: var(--shadow-xs); border: 1px solid transparent; }
      x-import[component-from-global-scope$="Button"][size="lg"] { height: 40px; font-size: 13.5px; }
      x-import[component-from-global-scope$="Button"][size="sm"] { height: 32px; font-size: 12.5px; padding: 0 12px; }
      x-import[component-from-global-scope$="Button"][variant="secondary"] {
        background: var(--secondary); color: var(--foreground); }
      x-import[component-from-global-scope$="Button"][variant="outline"],
      x-import[component-from-global-scope$="Button"][variant="ghost"] {
        background: transparent; color: var(--foreground); box-shadow: none; }
      x-import[component-from-global-scope$="Button"][variant="outline"] { border-color: var(--border); }
      x-import[component-from-global-scope$="Badge"] {
        height: 22px; padding: 0 9px; border-radius: 99px; border: 1px solid var(--border);
        font: 400 11px var(--font-mono); color: var(--muted-foreground); }
      /* hint-size is the master's own width note; only the full-width case changes layout. */
      x-import[hint-size^="100%"] { width: 100%; }

      /* A wired control inside a frame. Outlined always — a prototype whose hotspots are invisible
         gets read as broken — and lifted on hover. */
      .hotspot { outline: 1.5px dashed rgba(45,123,122,.85); outline-offset: 3px; border-radius: 6px;
                 cursor: pointer; position: relative; }
      .hotspot:hover { outline-style: solid; background: rgba(45,123,122,.10); }
      .hint { position: fixed; z-index: 60; background: #1b1a17; color: #fff; font-size: 11.5px;
              padding: 5px 9px; border-radius: 7px; pointer-events: none; opacity: 0; transition: opacity .12s; }
      .hint.is-on { opacity: 1; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <nav class="rail">
        <h2 class="rail__title">The workflow, walked</h2>
        <p class="rail__sub">The design master's own frames, in the order a person moves through them. Click the outlined control on each screen.</p>
        ${railHtml}
      </nav>
      <main class="main">
        <div class="top">
          <h1>From a world to a finished file</h1>
        </div>
        <p style="margin:0 0 2px;font-size:12.5px;color:var(--wt-soft);max-width:74ch">
          Every screen below is copied verbatim out of <code>Arke Studio.dc.html</code> — this page never
          edits the master. Under each one is what actually shipped, so you can read the drawing and the
          build together. Dots and tags: <b>green</b> matches, <b>amber</b> drifted, <b>red</b> not built.
        </p>
        <div class="legend">
          <span><i class="dot dot--built"></i> matches</span>
          <span><i class="dot dot--drifted"></i> drifted</span>
          <span><i class="dot dot--missing"></i> not built</span>
        </div>
        ${mapHtml}
        ${framesHtml}
      </main>
    </div>
    <div class="nav">
      <button id="prev" type="button">&larr; Back</button>
      <button id="next" class="is-primary" type="button">Next &rarr;</button>
    </div>
    <div class="hint" id="hint"></div>

    <script>
      const STEPS = ${JSON.stringify(STEPS.map((s) => ({ id: s.id, actions: s.actions })))};
      const order = ["map", ...STEPS.map((s) => s.id)];
      const screens = new Map([...document.querySelectorAll(".screen")].map((el) => [el.dataset.frame, el]));
      const railItems = new Map([...document.querySelectorAll(".rail__item")].map((el) => [el.dataset.goto, el]));
      const hint = document.getElementById("hint");
      let at = 0;

      /** Deepest element whose own trimmed text is exactly the label — the control, not its container. */
      function findControl(root, label) {
        const hits = [...root.querySelectorAll("*")].filter((el) => {
          const t = (el.textContent || "").trim();
          return t === label || (t.startsWith(label) && t.length <= label.length + 3);
        });
        return hits.length ? hits[hits.length - 1] : null;
      }

      function wire(id) {
        const screen = screens.get(id);
        if (!screen || screen.dataset.wired === "1") return;
        if (id === "map") {
          // The map's cards are shortcuts into the frames they describe.
          for (const card of screen.querySelectorAll("[data-goto]")) {
            card.addEventListener("click", () => show(card.dataset.goto));
          }
          screen.dataset.wired = "1";
          return;
        }
        const step = STEPS.find((s) => s.id === id);
        // Only the drawing. A screen is the frame *and* the built-notes beneath it, and the notes
        // quote control labels in <code> — so searching the whole screen wired the annotation
        // instead of the button, and the walk still passed because the annotation was clickable.
        const art = screen.querySelector(".shot__scale") || screen;
        for (const a of step.actions) {
          const el = findControl(art, a.match);
          if (!el) { console.warn("no control for", a.match, "in", id); continue; }
          el.classList.add("hotspot");
          el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); show(a.to); });
          el.addEventListener("mousemove", (e) => {
            hint.textContent = a.hint; hint.classList.add("is-on");
            hint.style.left = (e.clientX + 14) + "px"; hint.style.top = (e.clientY + 16) + "px";
          });
          el.addEventListener("mouseleave", () => hint.classList.remove("is-on"));
        }
        screen.dataset.wired = "1";
      }

      function fit() {
        const screen = screens.get(order[at]);
        if (!screen) return;
        const stage = screen.querySelector(".stage");
        if (!stage) return;
        const scale = screen.querySelector(".shot__scale");
        const s = Math.min(1, (stage.clientWidth || 1000) / 1360);
        scale.style.transform = "scale(" + s + ")";
        stage.style.height = Math.round(850 * s) + "px";
      }

      function show(id) {
        const i = order.indexOf(id);
        if (i < 0) return;
        at = i;
        for (const [fid, el] of screens) el.hidden = fid !== id;
        for (const [fid, el] of railItems) el.classList.toggle("is-on", fid === id);
        wire(id);
        fit();
        document.getElementById("prev").disabled = at === 0;
        document.getElementById("next").disabled = at === order.length - 1;
        history.replaceState(null, "", "#" + id);
        window.scrollTo(0, 0);
      }

      document.getElementById("prev").onclick = () => show(order[Math.max(0, at - 1)]);
      document.getElementById("next").onclick = () => show(order[Math.min(order.length - 1, at + 1)]);
      for (const [fid, el] of railItems) el.onclick = () => show(fid);
      addEventListener("resize", fit);
      addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") show(order[Math.min(order.length - 1, at + 1)]);
        if (e.key === "ArrowLeft") show(order[Math.max(0, at - 1)]);
      });
      show(location.hash.slice(1) && order.includes(location.hash.slice(1)) ? location.hash.slice(1) : order[0]);
      // Wire every screen up front so a missing control is a console warning at load, not a dead click.
      for (const id of order) { const el = screens.get(id); el.hidden = false; wire(id); el.hidden = id !== order[at]; }
      fit();
    </script>
  </body>
</html>
`;

writeFileSync(OUT, html);
console.log("wrote", OUT, html.length, "bytes;", STEPS.length, "steps");

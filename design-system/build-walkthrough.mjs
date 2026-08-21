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
    actions: [{ match: "New production", to: "99a", hint: "start a production" }],
    built: { status: "built", route: "#/w/:worldId/productions",
      notes: ["Ships close to the drawing."] },
  },
  {
    id: "99a", step: "Step one · what are you making?",
    actions: [{ match: "Continue · what kind of video?", to: "100a", hint: "the only way on" }],
    built: { status: "drifted", route: "#/w/:worldId/productions/new",
      notes: ["<b>Built to the drawing (turns 99, 100), bar one card.</b> The question is the title, the counter appears only where a second step exists &#8212; a Story creates from here, and <code>step 1 of 2</code> would be a lie to it &#8212; and the caption is halved to <code>nothing generates</code> \u2713.",
              "<b>Interactive video is off this step.</b> It was a medium here from turn 84; turn 100 makes it a kind, and step two offers it. Verified end to end: creating one wrote <code>medium: video</code> with <code>kind: interactive</code>, and the rail showed <b>Branch map</b> &#8212; branching keys on the kind now, and a world written before turn 100 reads identically, because the resolve widened rather than the schema narrowing.",
              "<b>What is not built is Audio.</b> The drawing offers three media; the build offers two. Audio is a production shape that does not exist &#8212; no chapters, no scenes, no screens behind it &#8212; and a card that created one would be worse than the card's absence. It is drawn, and waiting on its own epic.",
              "The blurred world art, the name field and the joins line ship as drawn, the joins line halved to <code>cast, locations, canon</code>."] },
  },
  {
    id: "100a", step: "Step two · what kind of video?",
    actions: [{ match: "Create and open it", to: "99c", hint: "create it" }],
    built: { status: "built", route: "#/w/:worldId/productions/new · step 2",
      notes: ["<b>Five kinds ship, interactive among them (turn 100)</b> \u2713 &#8212; micro drama · series, film · short, music video, interactive, other, in the drawn order, with <code>Other</code> carrying the frame's <code>no defaults</code> in place of a banner.",
              "<b><code>ENDING</code> is gone (turn 99)</b> \u2713. It sat in this row as though how a season ends were a setting; it is storytelling, and it reaches <code>season.ending</code> through the conversation instead. Nothing else about the season record changed &#8212; a production created before this still shows the ending it was given.",
              "<b>The rest is grouped under one label</b> \u2713 &#8212; <code>DEFAULTS · CHANGE LATER</code> over FRAME, EPISODES and LENGTH, the last two only where a micro drama can answer them.",
              "<b>Beyond the drawing, and a real fix:</b> the frame now travels for <i>every</i> video kind and is re-seeded when the kind changes. Before turn 99 the aspect was sent for a micro drama alone, so a film could not be made vertical until after it existed &#8212; and the field's initial state was 9:16, a micro drama's answer sitting under every other kind.",
              "The kind cards hold a banner area with no art yet, so the choice is still made by reading. Also beyond the drawing: a <code>Series name</code> field, and a primary that reads <code>Create Series and Season 1</code> for a micro drama."] },
  },
  {
    id: "99c", step: "Season · day one, and Arke is already there",
    actions: [{ match: "Set the question", to: "99d", hint: "say what it is about" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/season",
      notes: ["<b>Built (turn 99).</b> An episodic production's day one is its season with every tile dashed &#8212; the frame turn 93 said was missing &#8212; and <b>Arke is docked from the first second</b>: the subject in its head, the transcript, the wrap-up, the composer. Verified in the running app against a real production on disk.",
              "<b>The card that used to stand here is gone.</b> It said <i>Nothing decided yet · Production Chat is where the season gets shaped</i> and pointed at a screen. The panel opens the conversation itself &#8212; <code>Let&#8217;s shape the season. What is it about?</code> &#8212; which is the same answer without the journey.",
              "<b>The rail lost Production Chat and gained Story structure</b> \u2713, indented under Season. The chat item goes where the panel lands and stays, renamed <b>Develop</b>, where it has not: a production with no season still reaches its thread the old way. Every route is untouched.",
              "<b>One collision, found by looking:</b> <code>fy-dock</code> is already the audio player's floating dock, so the panel inherited <code>position: fixed</code> and centred itself over the board. The class family is <code>fy-arke*</code>.",
              "Not built: the chips under the composer (<code>Set the question</code>, <code>Draft episode 1</code>), and the panel's own way to be put away &#8212; the frame draws both."] },
  },
  {
    id: "99d", step: "Season · underway, and the panel stages a change",
    actions: [{ match: "Her mother’s hour", to: "100b", hint: "open an episode" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/season",
      notes: ["<b>Built (turn 99).</b> The season with something to read, and the staged proposal in the panel under <b>Accept</b> &#8212; turns 92 and 96's wrap-up moved onto the page it is about. Accepting no longer navigates, because the panel is already on the thing it decides.",
              "<b>The tab strip is gone</b> \u2713: a season is its episodes. 48b's arcs grid is untouched and lives at <code>/story-structure</code>, one rail item under Season and off the default walk &#8212; which is why this walk no longer passes through it.",
              "<b><code>HOW IT ENDS</code> is filled here and asked nowhere</b> \u2713 &#8212; turn 99 took ENDING off creation, and the field on the season record is what the conversation fills.",
              "<b>The two rail states are still never up together</b> (turn 91): the understanding gives way to the decision, and it is put away behind a disclosure rather than dropped, because a 360px column cannot hold it open beside a transcript.",
              "<b>What ships beneath it</b>: <code>STAGED · NOT WRITTEN YET</code> answering a press immediately (turn 92), and the accept itself, verified &#8212; one press moved <code>season.json</code> v1&#8594;v2 and created <code>story.json</code> with no proposal left standing."] },
  },
  {
    id: "100b", step: "The episode · the page, and Arke on it",
    actions: [{ match: "Fill the gaps", to: "100c", hint: "ask for what is missing" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/episodes/:id",
      notes: ["<b>Built (turn 100): the episode is a page with Arke on it.</b> The same component, the same 360px column, the episode as its subject &#8212; <code>Arke · Episode 01</code> &#8212; entering its own thread, so a message about episode 3 does not arrive in the season's.",
              "<b><code>Talk it through</code> is gone with the trip it named.</b> It was the last control on the last level that treated a conversation as a destination. <code>← Season</code> stays, because the level above is still worth naming.",
              "<b>91b is retired as a drawing</b>, and its route still answers: <code>/story/episodes/:id</code> works, nothing links to it, and the screen it drew is superseded by this one.",
              "Not built: <code>Add scene</code> &#8212; the frame draws it as the one hand edit on this page, the one control that writes where it stands rather than waiting for a yes.",
              "<b>Still the stopgap:</b> until turn 87's cascade lands, scenes are drafted elsewhere and adopted here &#8212; the <code>DRAFTED ELSEWHERE · NOT IN ANY EPISODE</code> band. The panel is what makes the cascade natural: a scene this episode's own conversation invents belongs to it from the first second."] },
  },
  {
    id: "100c", step: "The episode · made while it is said",
    actions: [{ match: "The hour found", to: "14c", hint: "open a scene" }],
    built: { status: "missing", route: "nothing ships this yet",
      notes: ["<b>Arke's signature interaction, drawn (turn 100): the screen shows what the conversation is making, while it makes it.</b> Two scenes appear <b>in their place</b> between 03 and the bell, marked <code>NEW · NOT WRITTEN YET</code>; the promise line the conversation changed shows its new words marked <code>STAGED</code>; and the two settled scenes after them renumber, because that is what inserting does.",
              "<b>The panel keeps only the count and the yes</b> — <code>2 scenes · 1 promise line</code>, <b>Accept</b> / <b>Discard</b>. A field-by-field diff inside a chat asks a person to read a form to find out what just happened to their story. The story is the better display, and it is already on the screen.",
              "<b>This changes where a proposal is shown, never when it is written.</b> Nothing on this frame has reached <code>episodes/03-*.json</code>: the foot still reads <code>v4</code>, the pills read <code>5 scenes</code> beside <code>+2 staged</code> rather than <code>7 scenes</code>, and a staged scene <b>cannot be opened, counted as done, or dispatched</b> until it is accepted.",
              "<b>The instinct already shipped once:</b> turn 92's <code>STAGED · NOT WRITTEN YET</code> tile on the season board does exactly this for one case, and it is the only place in the app that does. Everywhere else a proposal is a list of fields on another screen.",
              "<b>Nothing here is built.</b> The staged-in-place vocabulary, the marked promise row, the count that says both — all new. What exists to build on: proposals are already durable objects with a gate that accepts them (<code>.proposals/pr_*</code>), so what is missing is the drawing of one, not the machinery."] },
  },
  {
    id: "14c", step: "Scene 4 · the storyboard",
    actions: [{ match: "Advanced", to: "14d", hint: "the full shot, behind the card" },
              { match: "Generate scene", to: "52c", hint: "the plan — the only thing that spends" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/scenes/:sceneId",
      notes: ["<b>Newly adopted (turn 97), replacing 14a.</b> The scene page is its storyboard and the storyboard is the editor: the script is written on the card itself, <code>@</code> names anything in the world and rides along as an image reference, and <code>Advanced</code> (under a card's <code>⋯</code> — scroll the strip to shot 15) opens the full shot.",
              "<b>Everything a card states is derived, never stored</b> — <code>needs attention</code> / <code>story</code> / <code>storyboard</code> / <code>production-ready</code> from what exists, and <code>script changed · Re-read</code> from SPEC-023's coverage digests. The data model for all of it already ships.",
              "<b>A hand edit saves where it stands</b> — the bible's model: versioned, <code>saved 2 minutes ago</code>, <code>version history</code>, a save against a moved base refused. <b>An assistant edit asks first</b>: plan cards under <code>Apply to shots</code> / <code>Discard</code> in the docked panel, and an invented shot stays <code>suggested</code> until confirmed. Scene Chat's separate screen (turn 94) is amended into this panel.",
              "<b>Built and driven in the installed app (0.5.36, 2026-08-21).</b> Direct save cuts versions with history (<code>v1 → v18</code> in one drive); add, insert-between, duplicate, drag-reorder and delete all land on disk; restore brings any version back as a new one. One defect found driving: accepted charge-split takes carry no media, so every frame read <code>no frame yet</code> — the frame now follows the covering take's media.",
              "Not adopted from the prototype: the per-shot aspect override (a route takes one aspect; a cut cannot hold two — the chip reads <code>16:9 · from the episode</code>) and invented credit pricing (prices quote the plan, turn 52)."] },
  },
  {
    id: "14d", step: "One shot · Advanced",
    actions: [{ match: "Confirm the shot", to: "14c", hint: "suggested until you say so" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/scenes/:sceneId/shots/:shotId",
      notes: ["<b>The full shot behind the card (turn 97):</b> script, the assembled prompt with <code>Rebuild</code>, cinematic intent — framing, lens and movement inferred from it, anything set by hand wins — timing beats, references, and Creative / Camera / Sound / Continuity / Technical.",
              "<b>Camera fields inherit from the scene and say which</b>: <code>from scene</code>, or an override dot. The prompt's override-never-replacement doctrine (SPEC-012 R-15) applied to every field.",
              "<b>Recipes are one-press coverage grammar</b> — <code>Establishing</code> / <code>Coverage · OTS</code> / <code>Reaction</code> / <code>Insert</code> / <code>Hold</code> fill size, angle, lens, movement and pace.",
              "<b>Continuity is issue 154's boundary frame said plainly</b> — <code>opens on the last frame of shot 14</code> — and that machinery ships today: the durable still, its hash, the first-frame route. <code>keep out of frame</code> is new.",
              "<b>Built and driven:</b> recipes fill five fields in one press, the override dot appears and the card reads <code>Shot 2 · Close-up</code> after, prompt · auto → edited by you → Rebuild → auto round-trips, beats, sound and keep-out save, and the continuity line names the real previous shot. Not yet: the docked assistant and per-shot dispatch (turn 97's later phases), and the @ catalog popover — references add through a picker."] },
  },
  {
    id: "52c", step: "The plan · the Director, then the price as a choice",
    actions: [{ match: "Generate 2 passes · $5.16", to: "11b", hint: "spend, then review the takes" },
              { match: "Two-shot at the door", to: "14d", hint: "a shot opens the same Advanced sheet" }],
    built: { status: "missing", route: "nearest: #/w/:worldId/p/:prodId/generate/dispatch",
      notes: ["<b>Turn 98 evolves turn 52's plan in place</b> (52a stays drawn in the master as what came before): the warning bar becomes a <b>Director's review</b> — an agent that read the scene, its findings in the words of the specific thing wrong, never blocking, <b>priced in its own header</b> (<code>$0.02</code>) because an agent reading a scene is a provider call like any other.",
              "<b>The review ends in a recommendation in the scene's own terms</b> — <i>the action flows across the joins</i> — because choosing a dispatch strategy is a directorial judgment about this scene, not a preference about scenes.",
              "<b>The price is a choice of strategy and every option names its retry unit</b>: per shot (every shot pays the route's floor — <code>3s planned · 4s asked</code>), packed passes (the floor disappears, junctions pinned on boundary frames), packed + storyboard (the board is its own priced generation and its own accept before it steers, R-25). Cheapest-per-attempt and cheapest-after-taste are different orderings; the difference is the retry unit.",
              "<b>The spend control's label follows the selection</b> — <code>Generate 2 passes · $5.16</code> — and <code>attempt one · retakes bill separately</code> says the one thing no estimate can cover.",
              "<b>What ships beneath it</b>: route-aware estimates, both dispatch modes (<code>per-shot</code> / <code>whole-scene</code>), storyboards-per-pass behind their accept, and SPEC-024 pre-authorization proven to the cent ($7.98 authorized, $7.98 billed). The Director and the strategy row ship nowhere yet."] },
  },
  {
    id: "11b", step: "Generate · review the takes",
    actions: [{ match: "Accept take", to: "81a", hint: "accept a take into the cut" }],
    built: { status: "built", route: "#/w/:worldId/p/:prodId/generate",
      notes: ["<b>Two steps left this walk here</b> (both frames stay in the master). 52b's promises live on: what travels shows on the plan's own cards (<code>3 refs · 1 dropped</code>), the full <code>CARRIED</code>/<code>DROPPED</code> breakdown ships in the dispatch dialog, and opening a shot is the Advanced sheet everywhere. 79a's notification ships literally — <code>model · cost</code>, <code>· N queued</code> only when something is ahead, one row updated in place ✓ — its host board is the screen turns 97/98 retired.",
              "Three columns ship as drawn: composer left with <code>Reset</code>, viewer centre, takes rail right ✓.",
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
      One pattern, three times: <b>the thing itself on the page, and Arke docked beside it.</b> The
      season decides what the thing is; an episode decides what happens in it and <b>makes the scenes it
      needs</b>; a scene decides how it is shot. Nothing below a level exists until the level above has
      said what it needs, which is why the arrows only point one way. <b>Turns 99 and 100 finish the pattern</b>: at every level
      the chat stops being a place you go to and becomes the panel on the page it is about, the way
      turn 97 drew it beside the storyboard — season, episode, scene, with nothing left over. A hand
      edit saves where it stands. A change Arke proposes is <b>drawn where it will live</b>, marked,
      while the panel keeps only the count and the yes: <b>the screen shows what the conversation is
      making, while it makes it.</b> Shown is not written — a staged thing cannot be opened, counted
      as done, or dispatched until it is accepted.
    </p>
  </div>

  <div class="map__grid">
    <div class="lvl">
      <div class="lvl__spine">
        <span class="lvl__n">1</span>
        <span class="lvl__thread">the docked panel</span>
      </div>
      <div class="lvl__body">
        <div class="lvl__title">The season · what this whole thing is</div>
        <div class="cards">
          <div class="card is-part" data-goto="99c">
            <div class="card__k">Talk</div>
            <div class="card__d">One thread for the production, <b>docked on the page it is about</b> (turn 99). No Production Chat to visit — the same panel turn 97 drew beside the storyboard, one level up.</div>
            <div class="card__f">.conversations/cv_*</div>
          </div>
          <div class="card is-part" data-goto="99d">
            <div class="card__k">Accept</div>
            <div class="card__d">A change arrives in the panel as <b>a staged proposal</b>, field by field, under <b>Accept</b> / <b>Discard</b>. Built, on the page it is leaving.</div>
            <div class="card__f">.proposals/pr_*</div>
          </div>
          <div class="card is-built" data-goto="99d">
            <div class="card__k">The season page</div>
            <div class="card__d">What it is, in the header; its episodes below. <b>No tabs</b> — a season is its episodes. One season per production; another season is another production.</div>
            <div class="card__f">season.json</div>
          </div>
          <div class="card is-todo">
            <div class="card__k">Story structure</div>
            <div class="card__d">Arcs, themes, setups and payoffs — one rail item under Season, <b>off the default walk</b> (turn 99). Arke follows a lane without the screen teaching one.</div>
            <div class="card__f">season.json</div>
          </div>
        </div>
      </div>
    </div>
    <div class="arrow"><span>open an episode</span></div>
    <div class="lvl">
      <div class="lvl__spine">
        <span class="lvl__n">2</span>
        <span class="lvl__thread">the docked panel</span>
      </div>
      <div class="lvl__body">
        <div class="lvl__title">One episode · what happens in it</div>
        <div class="cards">
          <div class="card is-built" data-goto="100b">
            <div class="card__k">The episode page</div>
            <div class="card__d">Its promise, its scenes in order, <code>Add scene</code>. <b>Episode Chat is retired</b> (turn 100) — there is nowhere to be sent, because the thread is here.</div>
            <div class="card__f">episodes/03-*.json</div>
          </div>
          <div class="card is-todo" data-goto="100c">
            <div class="card__k">Talk, and watch it appear</div>
            <div class="card__d">A proposed scene is <b>a scene card in its place</b>, marked; the panel keeps the count and the yes. <b>The scenes it needs are part of its proposal</b> — turn 87's cascade — rather than drafted elsewhere and adopted from a pool.</div>
            <div class="card__f">.proposals/pr_* · scenes/*.json</div>
          </div>
        </div>
      </div>
    </div>
    <div class="arrow"><span>open a scene</span></div>
    <div class="lvl">
      <div class="lvl__spine">
        <span class="lvl__n">3</span>
        <span class="lvl__thread">the docked panel</span>
      </div>
      <div class="lvl__body">
        <div class="lvl__title">One scene · how it is shot</div>
        <div class="cards">
          <div class="card is-built" data-goto="14c">
            <div class="card__k">Storyboard</div>
            <div class="card__d">Cards you write on (turn 97). The script lives on the card, blocks keep their ids underneath, and everything else the card states is derived.</div>
            <div class="card__f">scenes/*.json</div>
          </div>
          <div class="card is-built" data-goto="14d">
            <div class="card__k">The full shot</div>
            <div class="card__d">Advanced: intent, recipes, a camera that inherits from the scene, continuity, model and seed.</div>
            <div class="card__f">scenes/*.json</div>
          </div>
          <div class="card is-part" data-goto="14c">
            <div class="card__k">Talk, then apply</div>
            <div class="card__d">The assistant docks beside the strip and follows the selection. Its changes are plan cards under <b>Apply to shots</b>; a hand edit just saves.</div>
            <div class="card__f">.conversations/cv_*</div>
          </div>
          <div class="card is-part" data-goto="52c">
            <div class="card__k">The plan</div>
            <div class="card__d">The Director's findings, then every shot priced — and the price as a choice of strategy, each naming what a retry re-runs.</div>
            <div class="card__f">plans/pl_*</div>
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

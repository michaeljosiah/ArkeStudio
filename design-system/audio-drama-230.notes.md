# Audio drama — adapting a novel for the ear · design turn 230

Status: **Proposed · revision 1 · 17 October 2026.** For the owner's review, not approved for
implementation. Nothing here adds a production type to the app, generates audio or changes a novel.

Baseline: `origin/main` at f3dc79960, in an isolated worktree. [Review page](audio-drama-230.review.html) ·
[Prototype](audio-drama-230.prototype.html) · [Design master](Arke%20Studio.dc.html#t230) ·
[Research](../docs/research/audio-drama-adaptation.md).

Turn 229 is left free: open PR 1828 (the Stage uplift) still holds a turn 228 that collides with the
merged Audio Drama turn 228 and will need the next number.

## How this turn was made

Turn 228's notes and the research were read as **requirements**. Turn 228's drawings, prototype,
stylesheet, view generator, screenshots and master section were not opened. The design was formed
from the approved turns it has to live beside: 113 (the door), 199 (the audiobook show page),
205 (adaptation setup), 225 (global Chat), 226 (Audio Studio) and 227 (the chapter writing room).
The shipped code was surveyed for what already exists. SPEC-047 and SPEC-052 were checked in the
private set where this turn departs from them.

## The author's job

The author has a finished novel. They want a drama that works for someone who only hears it.
That means four jobs:

- decide what the listener must know and when;
- write for the ear;
- hear it early;
- keep everything traceable back to the book.

The design is built around those four jobs, not around the record types.

## Decisions, and where they differ from turn 228's notes

| # | This turn | Turn 228's notes | Why |
|---|---|---|---|
| 1 | **One script per episode.** Scenes are headings inside it. The episode is Audio Studio's unit, and scenes are regions on its ruler. | Scenes are the editing units. Episodes sequence their committed arrangements, and nothing crosses a scene boundary at first. | Scene transitions are audio drama's main craft: ambience crossfades, a sting over a cut. Making scenes separate arrangements needs a second, episode-level sequencer — a competing timeline by another name. An episode (20–30 min) is the same size as the chapter Audio Studio already edits (about 23 min). |
| 2 | **No Performances view.** The take is the script's last column. Hear is a selection action. | Scene · Script · Performances · Audio Studio. | Writing for the ear means hearing while writing. A separate view repeats the audiobook model: write the prose, then perform it. |
| 3 | **Narration is settled by example**, then set per scene as **Heard as**: Narrated, In the room or A recording. | Three named creative approaches offered at setup. | Real dramas mix these scene by scene. Setup shows one moment of the novel both ways. Seeing it beats reading a definition. |
| 4 | **Pilot before the verdict table.** Setup ends at Target, Spine, Narrator and Pilot. Verdicts and episodes come after, on the Adaptation page. | Coverage verdicts and episodes come before the pilot. | How inner life becomes sound is judged by ear. Verdicts on 18 chapters made before hearing anything would be made blind. Setup still reads the whole book and records the spine and secrets. This changes SPEC-052 R-11's order for this kind. |
| 5 | **An Adaptation page with a map**: chapters by words, episodes by minutes, one ribbon per decision. Source is also a side column in the script. | An Overview section plus a contextual Source drawer. | "What happened to chapter 5?" and "Where did this scene come from?" need a lasting home. On a map, a move is a crossing ribbon and a cut is a ribbon into Cut. A table hides both. |
| 6 | **A fourth door: LISTEN · Make an audio drama.** | Admit Audio Drama in Story setup. | The door names what the audience does (turn 113): read, watch, choose. Listening is a fourth. An audiobook stays a reading of a Story. |
| 7 | **Kept from the listener**: facts with their reveal episode, produced at setup and used by review, cast labels and transcripts. | Knowledge ceiling inside the specialists' context packet. | A mystery is an authored decision. It should be visible and editable, not hidden in a prompt. |
| 8 | **Read-through** (script) and **Listen-through** (audio) are named differently and live in different places. | One review flow, labelled "Script reviewed · audio not assessed". | Different names and places make it hard to mistake one for the other. Listen-through states which interval it heard. |
| 9 | **A missing voice blocks Hear.** The author chooses: a voice, the narrator standing in, or leaving the line out. | Same intent. | This changes SPEC-047 R-12. Today the audiobook shows the substitution on its door and then reads the line in the narrator's voice. |
| 10 | Rail: **Dashboard · Cast · Develop · Overview · Adaptation · Episodes · Artifacts**. Episodes is the show page. | Overview · Episodes · Cast · Listen · Artifacts. | It matches Story's rail. Listening happens on the show page (turn 199), so Listen is not a separate destination. Adaptation appears only when the production adapts something. |

### Trade-offs accepted

- **Larger arrangements.** Audio Studio must handle a whole episode. It needs an episode adapter
  that reads script lines instead of audiobook blocks. A scene region must be first class on the
  ruler.
- **A busier script page.** Take state, beds and cues all live in the script. The design keeps
  them quiet: only spoken words are full strength, and the take column shows nothing until
  something is performed.
- **A later whole-book plan.** The pilot's choices may not suit every episode. The setup still
  records the spine and secrets, and the map marks every unplanned chapter.

## The journey

The fixture novel, *Low Water*, is invented for these drawings. It is set in The Undersong. The
tense scene is the tide turning in a drowned bell tower (episode 1, scene 4). The quiet scene is
Maren and Odile in the lamp room after midnight (episode 2, scene 3).

| Frame | Step |
|---|---|
| 230a | Create something new: the LISTEN door beside WRITE, WATCH and CHOOSE. |
| 230b | What kind of audio?: series, radio play or other, with Adapt from, Episodes and Length. |
| 230c | Setup: Arke has read all 18 chapters and shows the same moment with and without a narrator. Kept from the listener. The pilot is chosen. |
| 230d | Arke's draft of the pilot scene waits in the page. Chat says what changed and what it read. |
| 230e | A line opens its source paragraph and the decision behind it: Hear. |
| 230f | A cue: what is heard, its purpose, required or optional, and no sound yet. |
| 230g | Ten lines selected: Hear, or Ask Arke with audio-specific asks. |
| 230h | Hear 10 lines: voices, requests, Sent as, context not read. Sereth has no voice, so nothing plays until the author chooses. |
| 230i | Audition in context: candidates beside their lines, one transcript check, Keep 9 of 10. |
| 230j | Read-through: script notes beside their lines; script only, audio not heard. |
| 230k | Cast: actor direction and the narrator's portrayal, with layered direction and Sent as. |
| 230l | The quiet scene: silence, an interruption that keeps a secret, two takes out of date. |
| 230m | Adaptation: the map, with chapter 5 (Cut) opened. |
| 230n | Source changed: chapter 6 v14, v15 and the script. Keep the script with a reason, or Ask Arke to revise. |
| 230o | Audio Studio: episode 1 as one arrangement, with a listen-through note on a heard interval. |
| 230p | Episodes: the show page, with episode 2 performing in the background. |
| 230q | Publish an edition: what is included, frozen and held back. |
| 230r–v | Phone: script, Hear sheet, Source sheet, Episodes, Cast sheet. |

The prototype also draws the steps between frames: the pilot kept, Narrator stands in, the Fix
waiting as a tracked edit, and Cast beside the pilot.

## The script, element by element

| Element | Spoken? | Where it is drawn |
|---|---|---|
| Scene heading | No | Number, place and time, then chips for Heard as, source chapter and estimate. |
| Dialogue, narration | Words only | Speaker in the name column, with the voice colour as its underline. The words are at reading size. |
| Direction | Never | In parentheses on its own line above the words, in muted body text. |
| Channel | Treatment | Under the speaker's name: off-mic, radio or recording. |
| Sound | Rendered | A quieter row labelled Sound, with its purpose. A required cue with no sound is amber. |
| Ambience, music | Rendered beds | An entry row, then a line down its lane for exactly the rows it plays under. A bed that stops has a foot. |
| Silence | Timing | A row with its length and what happens in it. |
| Interruption | Timing relation | A marked dash where the line is cut, and a hook on the line that lands on it. |
| New line | — | Marked new: it has no source in the novel. |

## Built and proposed

| Built today | Reused here | Proposed addition |
|---|---|---|
| The door and step two (`world.tsx`); the setup conversation with Adapt from and Target | 230a–c | The LISTEN door; an audio-drama kind in `ADAPTATION_KINDS`; Narrator and Pilot steps; Kept from the listener |
| The chapter writing room: the held bar, tracked edits, review notes with Fix, Intentional and Dismiss, versions | 230d, 230j, prototype Fix | A radio-script document with stable line ids, beds, silence, interruptions, channels and Heard as |
| Voices, voice direction with Sent as, grouped requests, quotes, Activity, transcript checks, recorded takes | 230h, 230i | A Hear dialog over any selection; a blocking choice for missing voices; a take column in the script |
| Character narration note, used by the Performed reading | 230k | Actor direction for this production; per-line layered direction |
| Audio Studio for a chapter: sequence, passage and fixed placement; Current and Suggested; stereo render | 230o | An episode as the unit; scenes as ruler regions; the listen-through strip |
| SPEC-052 verdicts (Keep, Cut, Merge, Show, Expand, Invent) in design; Target built | 230m | The Adaptation page and map; Hear as the audio name for Show; the source-change compare |
| The audiobook show page; story editions | 230p, 230q | Audio-drama editions with listener transcripts, credits, the production script and stems |
| Builder Chat (turn 225); chapter-review specialists | 230d | Adaptation, script, performance and listening specialists behind the same single Arke |

## Open questions for the owner

1. **Should Audio Studio's unit become the episode?** This turn recommends it. The alternative is
   scenes plus an episode sequencer, which this turn argues against.
2. **Is LISTEN a fourth door, or a kind under WRITE?** A fourth door is clearer to an author. It
   also reverses the decision recorded in `world.tsx` to keep audio off the door until something
   ships.
3. **Should the pilot come before the verdict table** for audio dramas (an amendment to SPEC-052
   R-11)? Or should micro drama and audio drama share one order?
4. **Can a published edition keep a narrator stand-in** once the author has accepted it? Or must
   every role be cast before publishing?
5. **Should table reads use a free local voice by default?** A dry audition on Kokoro costs nothing
   and catches pacing problems. Cast voices cost money on every pass.
6. **Which delivery profiles ship first?** This turn names Podcast · stereo and Archive · WAV but
   promises no loudness figure.
7. **When does a hidden role's real actor appear in the credits?** At the reveal episode, or at the
   end of the season?
8. **Is "Hear" the right audio name for SPEC-052's "Show" verdict?** Or should the verdict
   vocabulary stay identical across production types?

## Validation

- `node design-system/audio-drama-230.mjs`, then `check-master.mjs --record`, `build-review.mjs` and
  `build-review.mjs --check`. These record 225 turns, resolve every anchor and 418 screens, and
  find no raw font size in turn 230.
- All 22 frames were rendered in headless Chrome at their master sizes (1360 × 900 and 390 × 844),
  both from the review page and from the design master, and inspected by eye in light theme. Four
  frames were also inspected in dark theme.
- No element overflows its frame. Every phone control in a tool bar, sheet or foot is at least
  44 px.
- The prototype was walked through 24 transitions, from the door to an edition and along the phone
  path. Escape closes the Hear dialog, the publish dialog and the sheets. Elements carrying
  `data-go` are focusable and work with Enter.
- These checks validate drawings only. They do not test synthesis, mixing or persistence.

## Regenerate

```text
node design-system/audio-drama-230.mjs [--preview]
node design-system/check-master.mjs --record
node design-system/build-review.mjs
node design-system/build-review.mjs --check
```

`audio-drama-230.view.mjs` holds the components and fixture, `audio-drama-230.frames.mjs` the
frames, and `audio-drama-230.rules.json` the rules. The generator replaces only turn 230 and its
review registrations. The chat panel is turn 225's own composer, borrowed through
`global-chat-224.composer.mjs` and `chapter-page-227.chat.css`.

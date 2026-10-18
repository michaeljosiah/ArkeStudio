# Audio drama — adapting a novel for the ear · design turn 230

Status: **Proposed · revision 4 · 18 October 2026.** For the owner's review, not approved for
implementation. Nothing here adds a production type to the app, generates audio or changes a novel.

Baseline: `origin/main` at f3dc79960, in an isolated worktree. [Review page](audio-drama-230.review.html) ·
[Prototype](audio-drama-230.prototype.html) · [Design master](Arke%20Studio.dc.html#t230) ·
[Research](../docs/research/audio-drama-adaptation.md).

Turn 229 is the Stage uplift (PR 1828), renumbered from 228 when it merged; this turn sits above it.

## Revision 4 (18 October 2026)

The owner asked what generating sounds with ElevenLabs would change. ElevenLabs' sound-effects API
(`POST /v1/sound-generation`) has these limits:

- Each call returns one file.
- A generation is at most 30 s, with a `loop` flag for seamless loops.
- There is no seed, so the same sound cannot be asked for again.
- Full music belongs to the separate Music API (up to 5 minutes).

Arke's Chat refuses sound effects today, so sound generation is new work. No core decision changes,
but sounds become artifacts:

- **Add a sound (230w)** reuses Arke's one reference picker from turn 69, filtered to audio and
  ranked against the cue's words. Its last tiles are Generate, Record and Upload.
- **Generate (230x)** opens inside the same dialog. It shows the script's words, the prompt Arke
  writes from them (editable), the engine, the length, Loop and the name the sound is saved as,
  with the price on the button.
- **Ambience (230y)** is generated as two seamless loops of different lengths, so a long scene
  does not audibly repeat.

Recurring sounds are one artifact placed by every cue. Sounds are generated close and dry, and the
mix adds distance. The Library's impossible 48-second loop is fixed.

Sources: ElevenLabs [sound-effects API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert),
[sound-effects capability](https://elevenlabs.io/docs/capabilities/sound-effects),
[music capability](https://elevenlabs.io/docs/capabilities/music), [API pricing](https://elevenlabs.io/pricing/api).

## Revision 3 (18 October 2026)

The owner asked whether the process had been over-complicated. In seven places it had, and revision 3
removes them:

1. **Step two (230b)** asks only the kind, the name and Adapt from. Arke proposes the number and
   length of episodes after reading the novel; an author cannot know that number in advance.
2. **Setup (230c)** asks one question, the narrator, settled by example. Everything else arrives
   as one plan to accept or change. The five-step list is gone.
3. **Hear** is one press when every speaker has a voice, with the price on the button. The dialog
   (230h) appears only when a decision is waiting, and What's sent sits one tap inside it.
4. **First takes keep themselves (230i).** The author is asked only when a new take would replace
   a kept one, or when a take was misread.
5. **One Review**, in the script and in Audio Studio. Each note says what it rests on: the script
   version or the heard interval. The names Read-through and Listen-through are gone.
6. **Cast (230k)** has one note on how each role sounds. The narrator's version shows only for
   characters the narrator quotes, and the direction layers sit behind What's sent.
7. **The side menu** is Episodes, Adaptation, Cast and Artifacts; Dashboard and Overview repeated
   Episodes.

Keeping an old script after the novel changes now takes an optional reason (230n).

## Revision 2 (18 October 2026)

The owner asked whether audio drama should sit under Story as a kind rather than having its own
door. It should, and revision 2 makes that change: 230a now shows the three existing doors, with
Tell a story naming audio drama, and 230b asks What kind of story?. The production is medium
`story` with kind `audio-drama`, so no new medium is needed. Nothing else in the turn changes.

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
| 6 | **A kind under Tell a story** (revision 2). Step two asks What kind of story?: Novel, Audio drama or Other. | Admit Audio Drama in Story setup. | Revision 1 drew a fourth LISTEN door; the owner asked whether audio drama should sit under Story, and it should. The work is writing first, it builds on Story's writing room, cast and Audio Studio, and a separate listening door would split listening across two doors, because the audiobook already sits under Story. On this point this turn now agrees with turn 228's notes. |
| 7 | **Kept from the listener**: facts with their reveal episode, produced at setup and used by review, cast labels and transcripts. | Knowledge ceiling inside the specialists' context packet. | A mystery is an authored decision. It should be visible and editable, not hidden in a prompt. |
| 8 | **One Review** (revision 3). Each note says whether it rests on the script, by version, or on audio heard, by interval. | One review flow, labelled "Script reviewed · audio not assessed". | Revision 1 named two reviews; the simplification pass found that was two concepts for one job. This now agrees with turn 228's notes, with the evidence carried on each note rather than on the flow. |
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
| 230a | Create something new: Tell a story now names audio drama. |
| 230b | What kind of story?: Novel, Audio drama or Other, then the name and Adapt from. |
| 230c | Setup: Arke has read all 18 chapters, asks one question by example (the narrator), then proposes one plan: episodes, secrets kept from the listener, the pilot. |
| 230d | Arke's draft of the pilot scene waits in the page. Chat says what changed and what it read. |
| 230e | A line opens its source paragraph and the decision behind it: Hear. |
| 230f | A cue: what is heard, its purpose, required or optional, and no sound yet. |
| 230w | Add a sound: the reference picker (turn 69), this production's and the world's sounds ranked against the cue; Generate, Record, Upload. |
| 230x | Generate a sound in the same dialog: the script's words, what's sent, the engine, length, loop, saved as an artifact. |
| 230y | Generate an ambience: two seamless loops, 30 s and 23 s. |
| 230g | Ten lines selected: Hear, or Ask Arke with audio-specific asks. |
| 230h | Hear 10 lines: the dialog appears only because Sereth has no voice; What's sent is one tap away. |
| 230i | Takes beside their lines: first takes kept, one replacement to choose, one misread line to retake. |
| 230j | Review: notes beside their lines, each resting on script v3; no audio heard yet. |
| 230k | Cast: one note on how each role sounds; the narrator's version where the narrator quotes them. |
| 230l | The quiet scene: silence, an interruption that keeps a secret, two takes out of date. |
| 230m | Adaptation: the map, with chapter 5 (Cut) opened. |
| 230n | Source changed: chapter 6 v14, v15 and the script. Keep the script with a reason, or Ask Arke to revise. |
| 230o | Audio Studio: episode 1 as one arrangement, with a review note on a heard interval. |
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
| The door and step two (`world.tsx`); the setup conversation with Adapt from and Target | 230a–c | Kinds on Tell a story's step two; an audio-drama kind of Story in `ADAPTATION_KINDS`; Narrator and Pilot steps; Kept from the listener |
| The chapter writing room: the held bar, tracked edits, review notes with Fix, Intentional and Dismiss, versions | 230d, 230j, prototype Fix | A radio-script document with stable line ids, beds, silence, interruptions, channels and Heard as |
| Voices, voice direction with Sent as, grouped requests, quotes, Activity, transcript checks, recorded takes | 230h, 230i | A Hear dialog over any selection; a blocking choice for missing voices; a take column in the script |
| Character narration note, used by the Performed reading | 230k | Actor direction for this production; per-line layered direction |
| Audio Studio for a chapter: sequence, passage and fixed placement; Current and Suggested; stereo render | 230o | An episode as the unit; scenes as ruler regions; the review strip of heard intervals |
| SPEC-052 verdicts (Keep, Cut, Merge, Show, Expand, Invent) in design; Target built | 230m | The Adaptation page and map; Hear as the audio name for Show; the source-change compare |
| The audiobook show page; story editions | 230p, 230q | Audio-drama editions with listener transcripts, credits, the production script and stems |
| Builder Chat (turn 225); chapter-review specialists | 230d | Adaptation, script, performance and listening specialists behind the same single Arke |

## Open questions for the owner

1. **Should Audio Studio's unit become the episode?** This turn recommends it. The alternative is
   scenes plus an episode sequencer, which this turn argues against.
2. ~~Is LISTEN a fourth door, or a kind under WRITE?~~ Settled in revision 2: a kind under Tell a story.
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

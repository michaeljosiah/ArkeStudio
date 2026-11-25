# Turn 287 · Director's checks: notes

The owner, 25 November 2026, after the first Wan pass of Gold on Gold (scene 2 of Na Love or Juju: The Film):

> Do we need Arke to do a director review of the shot setup? Like a checklist it goes through before we generate the
> video? We may also need a post shot generation review for consistency. So a pre and post operation on the shots to go
> through a typical checklist review in a systematic way. Checking for camera, consistency, seems between shots,
> lighting.
>
> Do we have a base director pre and post operation but allow users to define this at the production level. Basically
> when deciding what type of movie the want to create? Some would like shaky came, specific lighting style or some other
> unique elements designed at the production level and carried over shot by shot and reviewed as pre and post shot
> generation.

Then: "draft it now yes".

## What the scene showed

Gold on Gold was made outside the Studio's generator: 77 Wan 3.0 takes on topview, with Arke's shots, frames and voices.
Every fault below was found after the owner watched the parts. A check run before or after the shot would have found
each one first.

| What went wrong | When a check would have caught it | How it was measured |
| --- | --- | --- |
| About 50 of 77 prompts said "the camera is locked off and does not move", against the production's handheld rule | Before: the movement words against the look | the prompts, counted |
| The takes drifted 5 to 20 px and never breathed | After: what the camera did against what was asked | `cam_motion.py`: tracked background, similarity transform per frame |
| Shot 53 opened in the wrong set: the face reference rode as the first frame | Before: which picture is the first frame | the reference thumbnails, looked at |
| Shot 56 grew a third hand | After: hands counted | frames, looked at |
| Shot 69 dissolved inside the take; 69 and 72 invented a voice near the end | After: cuts inside a take, words heard against the script | frame difference; transcription |
| Five lines laid under takes that re-read them sat 60 to 120 ms off the take's voice | After: the laid line against the take's voice | `env_lag.py`: loudness envelopes, 1 s windows |
| A frame lost at each shot that ran to its take's end slid the voices 0.68 s off by the end of part 2 | On the cut: sync at the end as well as the start; frames per shot | `cut_drift.py`, `verify_sync.py` |
| No line crossed a cut; shots waited 0.5 to 1.7 s before a line and up to 2.4 s after | Before: a beat before and after the line (room to cut); on the cut: split cuts, waiting | `split_points.py` |
| Each take's room tone changed at every cut | On the cut: one room tone per place; after: the take's own hits kept only when clear | `wan_fx_check.py` |
| 44 played the hand touch, and 45 played it again | Before: the opening against the shot before as the Cut plays it (Fix 1, turn 286) | frames |
| 58 to 60: the phone went face down again, and Ife stood, then sat | Before: the opening state | frames |

The tools named are the film's own scripts, kept outside the repository. The new measurements in rule 10 are those
tools, made into checks.

## The production's look (rule 3)

A look is chosen when the production is made, from a preset, and then edited. Every field is a choice plus words.

| Field | Choices | Words, for example |
| --- | --- | --- |
| Camera | handheld · steady · locked · shaky; how strongly; pushes on beats | "eye level, breathes, eases closer on a beat" |
| Light | key low · key high; the source named for each place | "purple from above, the bar's warm glow, no fill" |
| Lens and focus | wide · normal · long; shallow · deep | "long lens across the floor, shallow" |
| Grade | words | "35 mm, a little under, grain" |
| Cutting | split cuts on · off; insert length; pace | "cut on the beat; inserts a second" |
| Sound | one room per place; the model's own hits kept when clear; music the room plays | "the club's song under everything, no ducking" |
| Performance | naturalistic · heightened · deadpan | "small, real; nobody plays to camera" |
| Its own checks | lines the production adds | "Ade's watch on his left wrist" · "Ife in her October look" · "no wides in the club" |

Presets give a starting look: Naturalistic drama, Romance, Thriller, Found footage, Music video. A preset fills the fields
and nothing else; editing a field after that changes only that field.

The Gold on Gold look, as it would be written: camera handheld, gentle, pushes on beats; light low key, the club's
purple from above and the bar's glow, no fill; lens shallow; grade 35 mm, a little under, grain; cutting with split
cuts, inserts a second; sound with one room per place, the club's song under everything; performance naturalistic.
Its own checks: Ade's watch on the near wrist, Ife's October look, Tunde in the navy polo, the champagne bucket on her
table from shot 42 on.

## The lists (rules 5 to 7)

Each item is **measured** (a tool returns a number), **looked** (frames are sampled and judged by the continuity
skill's standard), or **read** (the shot's words against a rule). Each has a result: **pass**, **fix** (Arke proposes
the change on a card), or **ask** (a choice only the person can make). **Hard** items hold a paid press until fixed or
overridden.

### Before a shot is made

| Item | Kind | Hard | From |
| --- | --- | --- | --- |
| The line is the script's, word for word; one speaker a shot | read | yes | the brief |
| Everyone seen is @mentioned; no body words | read | yes | the brief, the local route skill |
| The set-up is named as last time; same side of the line; a 30° and size step from the last shot of the same person | read, looked | no | continuity skill §3 |
| Movement words match the look; the moves the model must not make are named | read | yes | the look; continuity skill §4 |
| It opens in the state the shot before ends in, as the Cut plays it: who, where, gaze, hands, props, clothes | looked | yes | turn 286 Fix 1 |
| The cut's kind is set: matched or deliberate | read | no | turn 286 Fix 2 |
| The place's light source and its side match the set-up | read | no | the look; film-look rules |
| A beat before and after a line; the action already moving | read | no | continuity skill §4 |
| The request: the first frame riding is the set-up frame; pictures and size within the route's limits; the voice attached when it speaks; the price | measured | yes | turn 286 rule 7 (issue 3277) |
| The production's own lines | looked | as set | the look |

### After a take comes back

| Item | Kind | Hard | From |
| --- | --- | --- | --- |
| Lip sync: the take's voice against the line sent; drift across the line | measured | yes | new: the laid-line lag |
| Words heard against the script; voices nobody wrote | measured | yes | `transcribe_audio` |
| Cuts or dissolves inside the take | measured | yes | new: cut detection inside a take |
| What the camera did against what was asked | measured | no | new: camera motion |
| The face against the sheet; hands counted; clothes and props | looked | yes | turn 286 rule 7 (issue 3276) |
| Light and colour against the shots either side | measured | no (advice) | turn 286 rule 7 |
| The joins: first frame against the shot before, last against the next | looked | yes on matched cuts | turn 286 cut pair |
| The model's own sound: its hits on their actions, its room tone | measured | no | new: event against the floor |
| The production's own lines | looked | as set | the look |

A result can say where to trim: "invented word at 7.6 s: end at 7.4". A remake carries the failed items into its
prompt, so the next take is asked for what the last one missed.

### On the cut

| Item | Kind | From |
| --- | --- | --- |
| Each matched cut holds: pose, gaze, hands, props, sides | looked | turn 286 cut pair |
| Sync at the start and at the end: no drift | measured | new: frames per shot, voice against take |
| One room tone per place; no jump at a cut | measured | turn 286 sound at a cut; sound skill §5 |
| No mouth moves without a line | looked | sound skill §2 |
| Inserts about a second | measured | sound skill §3 |
| Lines that could run over a listener; waiting before and after lines | measured | sound skill §4 |

## Why not more prose in the brief

Turn 286 rule 2: a rule that can be measured is a check, and a check is the same every time. The scene was made by
someone who knew every rule above and still wrote "locked off" fifty times, because it stopped a fault in front of them.
Read rules lose to the problem in front of you. A check doesn't.

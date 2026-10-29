# Turn 246 · A story plays itself

Drawn on 28 October 2026 and approved by the owner the same day (“Approve all”), with Player P19 (ArkePlayer PR #29). Nothing is built.

## Asked

The owner, on 28 October 2026, in substance:

- "Whenever an option is provided to the user it must be at least two as a minimum."
- "The interactive story should play like a video, going through the video with optional narration
  and only pausing when an option is displayed. There should not be a need to tap to move forward."

The owner had seen `1 Several weeks later` alone in Preview on First Contact. The design said the
opposite: 174 moved a visual novel on with a tap or a key, `Auto` was a toggle and off by default,
and a choice with one open option showed it as one button. Arke Player's P19 draws the same rules
on the phone, in the same words.

## The rules

These five are the owner's, and P19 uses the same words.

1. **A story plays itself.** A visual novel moves from beat to beat on its own: a voiced beat when
   its voice ends, an unvoiced beat after time to read it. Keep the shipped timing. An interactive
   movie already plays its clips. A story opens playing.
2. **No tap moves on.** A tap or click shows or hides the controls, as a film's do: Play/Pause,
   Back (the previous beat), Log, and Narration where the story has voices. `Auto` is gone;
   Play/Pause replaces it. On a keyboard, Space pauses. If you keep a key that skips ahead, it is
   for the author, never needed.
3. **It stops only for a choice of two or more.** Every option shown is one of at least two. A
   closed choice shown with its reason counts as one of the two.
4. **A lone option is never shown.** When only one way on is open, the story plays straight through
   to where it leads, with no pause and no label.
5. **Narration is optional.** When a story carries voices, Narration is on, and the listener can
   turn it off. With it off, or in a story without voices, each beat holds for its reading time.
   The control shows only when the story has voices.

For the author, in the Studio only: a choice that is the only way out of its scene in some state
is a link. The Branch Map draws it plainly. Its label is the author's note and is never shown to
a listener. Its inspector says that it plays through.

## What it draws

- **246a:** Preview playing The Lantern Road with the controls hidden. Maren's line types on as her
  voice reads it. The beat's tick fills, and there is no `tap ›`.
- **246b:** a click shows the controls. This is 156a's film bar at the foot: Pause, Back,
  Narration, the beat ticks, Log, Route and Full screen. The line box sits above the bar.
- **246c:** paused. The bar stays and shows Play, and a Play sits at the centre.
- **246d:** Narration off. The beat holds for its reading time.
- **246e:** First Contact stops at The first name on the board, with two ways on.
- **246f:** First Contact as it stands, without voices, so there is no Narration.
- **246g:** the Branch Map with First Contact's links drawn plainly. Several weeks later is
  selected, and its inspector says `Plays through`.
- **246h:** a beat's Advance without On tap.

## The timing, as shipped

`interactive-player.js` `schedule()`:

- A voiced beat moves on 1.2 s after its voice ends.
- An unvoiced beat holds `min(12, 1.5 + 0.3 × words)` seconds. That was Auto's.
- A Hold beat holds its own `holdSec` (4 by default).
- The controls rest 2.5 s after the last movement while the story plays (`aip-rest`).

Nothing changes in these numbers. What changes is that they always run.

## First Contact, counted

First Contact has 15 scenes and 39 ways on (`routing.json`). An exploration of all 202 reachable
states with `exploreStory` found:

- **8 ways on are alone in every state:** Go to the landing markers, Several weeks later, Check the
  lower inspection wall, Reach the evacuation landing, Check the jammed cage, Reach the emergency
  control board, Leave the damaged refuge, and Follow the retaining wall.
- **None is alone in only some states.**
- **None carries an `unavailable` reason.**

So a route now stops 6 times (scenes 5, 7, 9, 12, 13 and 14), not 14. Its beats are all saved
`advance: "tap"` today, and they will play as After the line. First Contact has no voices yet
(`performances/` is empty), which is why 246a–d use The Lantern Road.

## Calls for the owner

1. The controls are 156a's film bar at the foot, rather than 174's buttons at the top right. The
   line lifts above the bar while it shows.
2. Route and Full screen stay beside Log. The rule names Play/Pause, Back, Log and Narration, but
   without Route a listener would lose Choose again.
3. → stays as the author's key to the next beat. Enter no longer moves on.
4. Narration belongs to a visual novel. An interactive movie keeps 156's Mute, because its voices
   are in its clips.
5. Preview opens playing. The web package keeps 156f's poster, because a browser will not start a
   voice before a first press. Rule 1's "opens playing" cannot hold there as written.
6. A lone link has no row in Check.
7. A link is drawn plainly only when it is alone in every state. A choice alone on some routes keeps
   its pill and says `Sometimes plays through`. This is approved and not drawn. It refines the
   Studio-only rule, which says "in some state".
8. 174c's Advance loses On tap, and After the voice becomes After the line.
9. The current beat's tick fills as it plays.
10. Log and Route open over a playing story without pausing it, as they do today.

## Rests on

- 156, the player, its bar, its resting controls and its poster.
- 174, the visual novel's line box, ticks, Log and beat settings.
- 240, the Branch Map and its inspector.
- SPEC-063 R-11, R-23 and R-26, and SPEC-058 R-87 (P19's half).

## The samples

- **The Lantern Road** is The Undersong's. 174 drew it, with its pictures
  (`art-direction-illustrated.png`, `world-undersong.png`).
- **First Contact** uses its own stills, copied from the world without writing to it:
  - `frame-sh_fc-002-1` became `assets/t246-fc-open-hands.jpg`.
  - `frame-sh_fc-005-1` became `assets/t246-fc-first-name.jpg`.
  - Both are 1280 × 720.
- Scene titles, lines, choices, links and counts are First Contact's own.
- Walked state, progress and `24 choices not walked` are samples.

## To regenerate

    node design-system/story-plays-itself-246.mjs
    node design-system/check-master.mjs --record
    node design-system/build-review.mjs
    node design-system/check-master.mjs

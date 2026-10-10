# Listen Slow push — approved turn 211

**Owner approved on 2026-10-10; implemented by PR #1700.** Open the [focused HTML review](listen-slow-push-211.review.html)
or [master turn 211](Arke%20Studio.dc.html#t211). The drawings remain the approved reference.

The current shared player is the baseline, including its contained picture, phone 62% image
area, transport, Text, Chapters, sleep timer and Close. A labelled **Slow push · On / Off**
switch joins the top controls on desktop and sits beneath the title on a phone. This placement
avoids adding another item to the phone's already variable-width Speed / Sleep / Text row.

- Default On for still pictures. An explicitly saved Off stays Off.
- System Reduced motion overrides any saved On. If that OS preference changes back while the
  player is open, motion stays off until the listener turns it on deliberately.
- The existing 6% video-export movement follows the saved focus, over the picture's whole hold.
  Pause, seek, playback speed and buffering use the narration's clock.
- The fitted picture rectangle and its letterbox area stay fixed. The optional push crops up
  to 6% inside that rectangle; Off shows the whole image. This is an explicit approved exception
  to SPEC-047 R-69's never-cropped stills, not a change to cover-fill framing.
- Clips and their fallback stills receive no extra transform. Cover/poster images stay static.
- The same shared module serves Listen and newly exported HTML players. Preferences are local
  to each player/book and device. MP4 export's existing Slow push setting remains independent.

## Review states

| Frame | Review |
|---|---|
| 211a | Desktop, default On |
| 211b | Phone, labelled 44px toggle |
| 211c | Phone, system Reduced motion |
| 211d | Desktop, remembered Off and paused |
| 211e | Phone, clip keeps its own movement; static clip poster drawing |
| 211f | Exported HTML player parity |

The standalone review's **Try it** section runs a real muted audio element containing forty
seconds of silence. Its time drives the prototype image transform; Play, Pause, scrub, speed,
start/end comparison, OS-preference simulation and saved-choice reset are inspectable. It has
no application connection, private manuscript, model request, media write or charge. The image
is the repository's public Undersong harbour illustration. The approved behavior
is recorded in the master rules; a design prototype is not an implementation acceptance test.

## Source and validation

SPEC-047 R-75 records the approved behavior. The shared player now receives each picture’s exact hold and optional focus from the app and HTML package mapper; old package inputs derive a hold from the next picture or chapter end. Still movement follows the audio clock. MP4 behavior remains independent.

Regenerate with `node design-system/listen-slow-push-211.mjs`, then
`node design-system/check-master.mjs --record` and `node design-system/build-review.mjs`.
The static master and review checks passed. Dedicated headless Chrome rendered all six HTML
states with the custom Geist face and loaded artwork, no horizontal overflow and a 44px new
toggle. Root inspected the desktop, phone and Reduced-motion screenshots. Prototype checks passed
for actual media-clock playback, frozen pause, midpoint seek at 1.03×, saved Off across reload,
Reduced-motion precedence, no surprise restart, deliberate On and a 320px phone with the long
End of chapter sleep label. Screenshots and `render-report.json` are local review artifacts;
the installed app was never used. These are design checks, not product acceptance tests.

Implementation validation includes native shared-player and exporter-template renders, the six literal master/actual pairs, keyboard switch operation, saved Off, actual MediaQueryList change events in both directions and a scrollable Text region at 320px/200% text. The enlarged-text repair keeps Text between the switch and transport. Existing enlarged timer-row overflow is tracked in [issue #1701](https://github.com/michaeljosiah/ArkeStudio/issues/1701); no broad transport redesign is included.

The comparison records retained differences rather than claiming full-screen pixel identity: existing active Text styling, small baseline transport/line-height and icon differences, and the offline package’s existing system-font fallback. The approved static drawing uses an illustrative 1.03× crop; the implemented example at 6:06 follows its exact 24%→66% picture hold, about 1.0257×. Frame 211e draws a poster; the implementation uses a real sanitized fixture clip. All new switch positions and minimum hit areas match.

No new world schema, provider call, model download or installed-app change is part of this implementation.

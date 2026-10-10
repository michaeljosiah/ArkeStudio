# Listen Slow push — proposed turn 211

**Design only, awaiting owner approval.** Open the [focused HTML review](listen-slow-push-211.review.html)
or [master turn 211](Arke%20Studio.dc.html#t211). No product implementation is included.

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
  to 6% inside that rectangle; Off shows the whole image. This is an explicit proposed exception
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
is the repository's public Undersong harbour illustration. The proposal's production behavior
is recorded in the master rules; a design prototype is not an implementation acceptance test.

## Source and validation

Read live SPEC-047 R-66–R-74, R-134–R-136 and R-183; the reserved R-75 follow-up already names
slow push. Current `audiobook-player.js` preserves only source/motion identity in its typed input,
so implementation must carry picture hold and focus through that seam. Current
`DEFAULT_VIDEO_OPTIONS.slowPush` is true and `VIDEO_PUSH` is 0.06. The shared player currently
shows a static still; MP4 behavior alone does not implement Listen.

Regenerate with `node design-system/listen-slow-push-211.mjs`, then
`node design-system/check-master.mjs --record` and `node design-system/build-review.mjs`.
The static master and review checks passed. Dedicated headless Chrome rendered all six HTML
states with the custom Geist face and loaded artwork, no horizontal overflow and a 44px new
toggle. Root inspected the desktop, phone and Reduced-motion screenshots. Prototype checks passed
for actual media-clock playback, frozen pause, midpoint seek at 1.03×, saved Off across reload,
Reduced-motion precedence, no surprise restart, deliberate On and a 320px phone with the long
End of chapter sleep label. Screenshots and `render-report.json` are local review artifacts;
the installed app was never used. These are design checks, not product acceptance tests.

After approval, amend the live requirement, implement once in the shared player, and validate
clock/preference/accessibility behavior plus literal master/actual paired renders. No new world
schema field, paid generation or player UI beyond this turn is proposed.

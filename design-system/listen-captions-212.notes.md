# Listen captions — approved turn 212

The owner approved the two-line caption proposal on 2026-10-11 for issue #1711, then explicitly
authorized implementation, an immediate PR merge and an installed-app update. The original
proposal was shown in the conversation against the owner's Chapter 22 scene. The public
[master turn 212](Arke%20Studio.dc.html#t212) retains its geometry with fictional public content.

Text now shows only the current phrase, at most two measured lines above the actual transport,
up to 640px wide. Long individual-take blocks and long sentences both advance through all words;
no manuscript regrouping or new narration is required. The current font, viewport and available
height determine the split. One available line uses shorter cues; an impossible safe area hides
the overlay instead of overlapping the controls. Text has its existing default and preference.

Validated acoustic intervals use their chapter-clock boundaries and clear during silence.
Otherwise the player's existing sentence/whole-block clock is divided by character weight,
as the video cue compiler already does. This remains an estimate. MP4 and subtitle cue sizing
remain unchanged; line breaks depend on the destination geometry. Both Listen and new HTML
exports carry measured intervals and use the same shared player module. Older packages continue
to work with their existing inputs.

Validation: player regressions cover a whole long passage, individual sentences, measured silence,
speed, paused seek, changed timing inputs and an unbroken token. Real Chromium layout checks
cover desktop, 390px and 320px phones, short landscape, and doubled caption text, with every
word retained and no third line or transport collision. SPEC-047 R-70/R-138 records this amendment.

Regenerate the drawings with `node design-system/listen-captions-212.mjs`, then record the
ledger and review with `node design-system/check-master.mjs --record` and
`node design-system/build-review.mjs`. Turn 211 remains unchanged as the historical baseline.

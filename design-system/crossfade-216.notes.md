# Crossfade design turns 216–219

Status: **proposed, awaiting owner review**. Created 12 October 2026. No new capability
specification or application implementation is included. The owner has agreed to preserve
existing cut positions and total production duration.

Open the [focused review](crossfade-216.review.html) for the interactive example and all
26 HTML drawings. The [design master](Arke%20Studio.dc.html#t219) holds the same turns;
the [review index](design-review.html) records their proposed status.

| Turn | Review focus | Frames |
| --- | --- | --- |
| [216](crossfade-216.review.html#turn-216) | Select a join, add, edit duration, preview, remove; Fold and phone | a–f |
| [217](crossfade-216.review.html#turn-217) | All still images, selected images, time range, exceptions and one Undo | a–f |
| [218](crossfade-216.review.html#turn-218) | Separate join/duration protection, named release, broken adjacency | a–f |
| [219](crossfade-216.review.html#turn-219) | Arke composite cards, explicit Review, sticky edits, incoming versions, stale bases and Apply | a–h |

## Decisions proposed for approval

- A transition belongs to an ordered pair of touching still clips on one picture track.
  Its blend straddles the existing cut symmetrically. Audio timing, cues and total duration
  stay fixed. Video joins and gaps are skipped in this first scope.
- One second is the starting duration; the Inspector also shows frames and the blend
  window. Direct editing respects a visible local limit. Neighbouring blends cannot
  overlap into a three-picture blend. No silent shortening or retiming.
- Batch authoring previews every affected join. Both images must belong to a selection;
  time ranges include a cut at From and exclude a cut at To. Keep existing is the default.
  Replacing unprotected transitions is explicit. Shorter fades need acceptance or exclusion.
- Join protection preserves the crossfade at this exact pair; duration protection preserves
  its duration independently. Direct edits remain available and update protected values.
  A named release retains other protection. Review releases remain pending until the
  resulting version is explicitly reviewed and applied. Removing a transition directly
  removes its own protection in the same Undo transaction.
- Arke resolves ordinary chat using the current cut and conversation. Suggestions are
  composite cards in Arke. Preparation and arrival do not activate Suggested. Review enters
  an exact version, with Current/Suggested on one clock. There is no permanent Changes tab.
- Manual pending edits and Keep Current decisions survive revisions and resume. New
  versions wait for explicit Review. Changed dependencies require Update and another
  Review. Apply saves exactly the reviewed arrangement in one Undo entry. Discard leaves
  Current unchanged; closing review preserves the pending proposal.

## Review points before specification

These are proposed choices, not unresolved implementation promises:

1. Confirm the one-second starting value and the first scope of adjacent stills only.
2. Confirm explicit acceptance of shorter batch fades rather than automatic fitting.
3. Confirm separate protection of transition presence/type and duration, including the
   behaviour when the original clip pair stops touching.

After design approval, the specification should settle frame rounding at the symmetric
boundary, exact maximum-duration calculation, still transforms during extended blend
coverage, alpha/compositing behaviour, source invalidation, persistence and export parity.
SPEC-053 covers the existing effects authoring and review vocabulary; these picture
transitions are outside its accepted implementation scope.

## Isolated prototype

The example is a 72-second fixture with public design artwork. It supports adding/removing
the selected transition, typed duration, symmetric handles, preview, batch scope and
short-join decisions, independent protection, named releases, composite review, Keep
Current, revisions, stale-base recovery, Apply, discard, Undo and local resume.

The preview is an illustrative two-image scrub/loop, with no audio, decoding or export.
The duration changes the proposed blend window; loop playback is illustrative. Ask Arke
prepares a deterministic fixture, not a model response to arbitrary text. The short-join
list and the broken-adjacency drawing are examples, not a media planner. Only the named
Harbour → Coast join is interactive; other joins are batch/review examples. A new manual
batch starts from Current outside an active proposal review; pending single-join edits use
the Inspector. Browser storage saves only this fixture and Reset example clears it.

## Regenerate and check

From the repository root, with Node 22.12+ and a Chromium browser (`CHROME` overrides its
Windows default path):

```powershell
node design-system/crossfade-216.mjs
node design-system/check-master.mjs --record
node design-system/build-review.mjs
node design-system/check-master.mjs --render
node design-system/build-review.mjs --check
node design-system/crossfade-216.check.mjs
node design-system/crossfade-216.serve.mjs
```

The last command prints a read-only loopback review URL. The focused check writes its
report and screenshots to `.dev/crossfade-design/`, covering 26 drawings, images, fonts,
review and protection boundaries, batch exceptions, Undo, resume, and 984/390/320 layouts.
These checks verify the design fixture, not application acceptance.

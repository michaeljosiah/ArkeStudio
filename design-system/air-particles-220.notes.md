# Air Particles design turns 220–223

Status: **proposed, awaiting owner review**, 12 October 2026. No design approval,
specification acceptance or product implementation is implied.

Open the [focused review](air-particles-220.review.html), the
[master](Arke%20Studio.dc.html#t220), or the [review index](design-review.html).
The generator writes the same 31 HTML drawings into both review surfaces.

| Turn | Focus | Frames |
| --- | --- | --- |
| 220 | Adding, independent placement, appearance, pattern, phone/Fold/dark | a–g |
| 221 | Speed, airflow, contacts, boundary behaviour and optional audio | a–f |
| 222 | Normal/Screen/Add, opacity, imported overlay, protection and release | a–i |
| 223 | Arke cards, explicit Review, manual adjustments, revisions, stale state, Apply | a–i |

## Motion refinement behind the designs

The owner supplied a local AirParticles-008 reference and reviewed three independent
procedural studies before requesting less clustering. The fourth study changes the
initial distribution to seeded, jittered coverage and uses divergence-free shared flow
plus independent smoothly turning headings. At a picture-edge bounce the heading also
reflects, avoiding repeated outward acceleration and edge accumulation. Particle contacts
and open/bouncing boundaries remain separately selectable.

A 48-cell count check at the default seed measured the coefficient of variation at the
end of the 7.92-second comparison as 0.606 for v3 and 0.217 for v4. At 220 seconds v4 was
0.304 with no empty cells. This is a diagnostic of that seed/settings combination, not
a universal perceptual-uniformity or production-performance claim. Seeking remains
repeatable. The motion library included here is an isolated design study, not Studio's
renderer, an exact physical reconstruction of the supplied clip or a performance budget.

The supplied movie and production artwork stay in the owner's local comparison folder;
neither is added to this repository. The drawings use the existing public harbour artwork
and an original procedural particle still. The comparison is available locally at
`http://127.0.0.1:62115/?revision=4` while its separate server is running.

## Decisions proposed for review

- Air Particles is a new preset alongside the existing six, with texture, softness and
  depth variation. Existing targets, intervals, emitting area, fades and curves continue
  under SPEC-053. No required music track or audio source.
- Physics controls are Speed, Airflow variation, Gentle particle deflections, and Picture
  boundary: Soft bounce/Open flow. New pattern is an explicit seeded edit. Proposed
  starting choices are gentle contacts, Soft bounce and dispersed motion.
- Picture boundaries belong to the visual target. They are not walls detected inside an
  image, and an emitting region does not become a collision box. No masks or scene geometry.
- Simple audio response presets stay first. Advanced retains beat/bass/energy, affected
  property, cap and smoothing. Reaction follows the source's audible contribution and
  never silently changes pattern, boundary mode, contact enablement or protection.
- Normal, Screen and Add plus opacity belong to each procedural effect or visual media
  clip. Existing clips remain Normal. The new light preset proposes Screen by default.
  Generated particles have transparency; imported black plates require blending to reveal
  lower pictures. Track/group blend modes and automatic overlay repetition are outside scope.
- Property protection covers each appearance, blend, pattern and physics setting. Whole
  effect and fixed passage scopes remain distinct from exact boundary and coverage rules.
  Human edits remain available. Release names one rule and scope; a pending release creates
  another card marked Release on Apply and requires another explicit Review.
- Arke has the same authoring vocabulary. Appearance-only requests keep current target,
  interval and optional sound; context resolves them without a mandatory prerequisite form.
  Composite cards live in Arke. Current stays active until Review in timeline. Manual
  pending edits and Keep Current choices remain sticky through revisions. New versions
  wait for Review. Changed dependencies require Update and Review. Apply is one exact,
  undoable transaction; there is no permanent Changes tab.

SPEC-053 R-1–16, R-22–38 supplies the accepted baseline for placement, sound, protection and
review. SPEC-054 supplies the existing crossfade context; blend changes do not retime cuts.
These designs propose extensions, so neither accepted specification was amended at this
design stage. A specification should follow owner approval.

## Questions to settle after this design review

1. Confirm the proposed initial Soft bounce, gentle contacts and Screen defaults.
2. Define exact colour space, alpha representation, opacity and clipping for all three
   blend modes, including crossfades, scoped effects, upper clips and missing picture.
3. Define supported ProRes/source proxy preparation and alpha preservation. EXR, camera
   RAW and plugin support are not prerequisites for a procedural preset or these modes.
4. Define deterministic motion profile, seeded pattern persistence, contact/population
   limits, checkpoints, seek bounds and measured preview/export parity. The study's 660
   default candidates are not a commitment to a product limit.
5. Extend typed authoring/protection to new properties and clip blending, with exact
   fixed-passage preservation and explicit conflicts for unsupported segmentation.

## Isolated fixture and limitations

The 72-second fixture supports typed appearance and physics edits, a real procedural
motion canvas, blend/opacity preview, explicit new patterns, placement/cancel, separate
property/boundary/coverage protection, named release, synthetic Arke suggestions, explicit
review, sticky Amount edits, incoming versions, changed-base recovery, Apply, Undo, discard
and local resume. It persists only browser-local demonstration state. Reset clears it.

There is one selected-effect fixture and one public picture. Add demonstrates that slot;
it is not a multi-effect library. Track/clip targets, audio mappings and protected passages
show the proposed authoring contract; there is no real target compositor, audio analysis,
arbitrary chat interpretation, passage segmentation or production authority. The source
overlay drawings use an original synthetic plate, not the owner's media. The master has a
procedural still; the focused review paints the proposed states and animates the live area.
The demo's display-referred canvas and alpha conversion are not final colour/render rules.

## Regenerate and verify

```powershell
node design-system/air-particles-220.mjs
node design-system/check-master.mjs --record
node design-system/build-review.mjs
node design-system/check-master.mjs --render
node design-system/build-review.mjs --check
node design-system/air-particles-220.check.mjs
node design-system/air-particles-220.serve.mjs
```

The focused check starts isolated headless Chrome (`CHROME` overrides the executable),
captures all 31 drawings and writes a report to `.dev/air-particles-design/`. It checks
artwork/fonts, desktop/Fold/390/320px layout, placement cancellation, pattern changes,
review entry, sticky adjustment, incoming version, release/application/Undo, stale refresh,
resume/discard and explicit audio-source selection. Product gates are not evidence for
this design-only change; implementation and platform rendering checks follow approval.

Validation on 12 October 2026: 31 drawings and 60 focused browser checks passed. Master rendering, Geist loading, anchors and generated-review consistency passed. The pre-existing missing-turn t195 ledger warning remains; no historical turn was edited. Appearance, physics, blend examples, granular protection, Arke review, dark and phone drawings were visually inspected.

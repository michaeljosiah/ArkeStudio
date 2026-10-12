# Air Particles design turns 220–223

Status: **turn 220 revision 2 proposed; turns 221–223 preliminary**, 12 October 2026. No design approval,
specification acceptance or product implementation is implied.

Open the [focused review](air-particles-220.review.html), the
[master](Arke%20Studio.dc.html#t220), or the [review index](design-review.html).
The generator writes 34 HTML drawings into both review surfaces: ten revised turn 220 drawings and 24 earlier interaction concepts. The focused page collapses the earlier drawings under explicit preliminary labels.

| Turn | Focus | Frames |
| --- | --- | --- |
| 220 revision 2 | Existing library/dialog/Inspector, placement, appearance, Motion, area/fades, phone/Fold/dark | a–j |
| 221 | Speed, airflow, contacts, boundary behaviour and optional audio | a–f |
| 222 | Normal/Screen/Add, opacity, imported overlay, protection and release | a–i |
| 223 | Arke cards, explicit Review, manual adjustments, revisions, stale state, Apply | a–i |

## Revision 2: preserve the existing editor

The owner rejected the earlier shell as too large an editor redesign. Turn 220 now
adds Air Particles within the existing Cut editor. Inspector and Arke remain its only
permanent panel tabs. Appearance and Motion are existing scrolling section headings;
there are no new Appearance, Physics, Blend or Changes tabs.

The desktop drawing follows the 44px titlebar, 46px production rail, 286px library,
308px Inspector, 53px Cut header and 348px preview row in the current source. It retains
the two-column preset grid, existing Add effect modal, Effects lane and independent
Visual target / Start / End / Move to fields. Time fields use HH:MM:SS:FF at 24fps.
Colour, Direction, emitting area, fades, curves, optional audio and protection remain
in the Inspector. Texture, Softness, Depth variation and Blend mode follow the existing
Appearance fields. Pattern and an expandable Particle physics group follow Direction
and Speed in Motion.

Phone uses the existing Details sheet with a fixed Done footer. Fold uses the compact
preview/Inspector row, full-width timeline below, bottom tools and right Arke rail.
Dashed gold outlines are removable review annotations, not new product decoration.

Sources checked: client fidelity.css, editor-effect-library, editor-effect-inspector,
editor-effect-fields, editor-effect-area, editor-effect-target, editor-responsive and
EditorDialog, plus saved real application acceptance captures. The live app inspection
connection timed out; no claim of a fresh live pixel comparison is made. Public sample
artwork replaces private scratch artwork, and unrelated controls remain illustrative.
The design drawings are not screenshots or a production implementation.

Turns 221–223 preserve earlier interaction ideas for discussion, explicitly labelled
preliminary and awaiting shell alignment. They do not authorize an alternative editor
layout. This revision makes no application or private specification changes.

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

Revision 2's focused fixture exercises the turn 220 integration: select the preset,
open Add effect, choose independent target/frame range/track, cancel or add, edit
appearance/colour, preview motion and blending, choose a new pattern, and Undo. New
appearance and physics controls use the original independent procedural study. Direction,
emitting area, curves, audio, protection, other presets, Arke and export are context only
and are disabled or labelled as such in this fixture. They remain existing app features.

The fixture uses one selected-effect slot and public artwork, without real target
compositing, audio analysis, world writes or model calls. It does not persist state.
Review shortcuts above it are outside the app drawing, explicitly labelled as review
navigation. They select an example effect to expose the relevant Inspector section.
The study's display-referred canvas and alpha conversion are not final render rules.

The old standalone prototype source remains as historical interaction evidence; it is
not loaded by the revised focused review. Preliminary 221–223 drawings remain available
in collapsed sections. Arke/protection approval awaits their revised designs.

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

The focused check starts isolated headless Chrome (CHROME overrides the executable),
captures the ten revised drawings and writes a report to .dev/air-particles-design/.
It checks artwork/fonts, desktop/Fold/390/320px layout, preservation of existing tabs,
preliminary labels, placement cancellation, target/range independence, frame validation,
appearance edits, pattern/Undo, phone Add/Details/Done and removable review annotations.

Validation on 12 October 2026: ten revised drawings and 34 focused browser checks
passed. Application tests are outside this design-only change. The pre-existing missing
turn t195 ledger warning remains; no historical turn before 220 was edited.

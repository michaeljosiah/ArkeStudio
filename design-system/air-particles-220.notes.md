# Air Particles design turns 220–223

Status: **turns 220–223 revision 3 proposed, awaiting owner review**, 12 October 2026. No design approval,
specification acceptance or product implementation is implied.

Open the [focused review](air-particles-220.review.html), the
[master](Arke%20Studio.dc.html#t220), or the [review index](design-review.html).
The generator writes 38 HTML drawings into the master and focused review. The generated review index retains each drawing’s scoped styles and desktop/Fold/phone width. All four turns now use the existing Cut structure.

| Turn | Focus | Frames |
| --- | --- | --- |
| 220 | Existing library/dialog/Inspector, placement, appearance, Motion, area/fades, phone/Fold/dark | a–j |
| 221 | Speed, airflow, contacts, boundary behaviour and optional audio and readiness | a–h |
| 222 | Normal/Screen/Add, opacity, imported overlay, protection and release | a–j |
| 223 | Arke cards, explicit Review, manual adjustments, revisions, stale state, Apply, phone/Fold | a–j |

## Revision 3: all four turns in the existing editor

The owner rejected the earlier shell as too large an editor redesign. All four turns now
place the additions within the existing Cut editor. Inspector and Arke remain its only
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
EditorDialog, editor-effect-audio/protection/review-bar, editor-effect-proposal-card,
ProductionConversation and saved real application acceptance captures. The live app inspection
connection timed out; no claim of a fresh live pixel comparison is made. Public sample
artwork replaces private scratch artwork, and unrelated controls remain illustrative.
The design drawings are not screenshots or a production implementation.

Turn 221 expands Particle physics inside Motion and uses the existing Audio reaction
section for optional source, response presets and Advanced. Silent and changed-source
states distinguish base atmosphere from unavailable reaction.

Turn 222 places effect blending in Appearance and clip blending beneath the existing
placed-picture source/timing controls. Imported media uses the Media library and its
ordinary picture clip; no procedural effect is manufactured. Property scopes, exact
boundaries and coverage use the existing protection section. Named pending Release
creates a fresh card and leaves Current protected until explicit Review and Apply.

Turn 223 uses the current Arke panel/composite-card structure, and existing Arke sheets
on compact devices. Only explicit Review opens the temporary comparison bar. Show
changes returns to the card; Inspect effect uses the ordinary Inspector. Manual
adjustments are visible and retained through the scripted revision. Source/Current
changes disable Apply until Update and another Review. No application or private
specification changes are included.

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

The focused fixture exercises adding, target/range/track choice, cancellation, appearance,
colour, procedural motion, blend/opacity, Pattern and Undo. It illustrates audio binding
and response controls without audio playback or analysis. The defaults/mappings use the
existing Gentle shimmer, Beat pulse and Build with energy vocabulary.

Scripted Arke cards support explicit Review, ordinary pending edits, Keep current,
scoped permission to revise, named Current and pending release, incoming versions,
stale Update/Review, close/reopen, Discard and exact one-step Apply/Undo. Arrival retains
the selected panel, clock and active preview. It is one selected-effect example, not an
AI engine, real authority, complete multi-effect compiler or production acceptance test.
Fixed-passage controls record the illustrated scope; the fixture does not implement
arbitrary segmentation or a real target compositor. All proposal state resets on reload.

Direction/emitting-area behaviour, curves, other presets and export remain labelled
context-only. Buttons above the drawing are review shortcuts/simulations, not editor
navigation. Only public artwork and an independently generated synthetic overlay are
used; the imported video examples do not decode the owner’s original file.

The focused canvases use the independent study. Static master/index canvases use a
representative original still, gated by the active interval and the selected blend mode,
opacity and transparent/opaque source type. They are not exact motion checkpoints or
preview/export acceptance evidence. The live study uses a retained simulation origin
and anchored fades: trims preserve phase/envelopes, Move shifts them, and Fit fades is
explicit. Playback/seek update both clocks and the playhead. The study’s display-referred
colour and alpha handling still require a production rendering specification.

The earlier alternate-shell modules remain historical source, unloaded by this page.
All visible 220–223 drawings and the active fixture now use the shared native layout.

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
captures all 38 revised drawings and writes a report to .dev/air-particles-design/.
It checks artwork/fonts, desktop/Fold/390/320px layout, existing panel tabs, Add/Cancel,
independent placement, frame validation, simulation/fade anchors, clocks, appearance,
Pattern/Undo, audio bindings, granular release, sticky manual/Keep current decisions,
explicit review entry, incoming/stale recovery, Apply/Undo and mobile sheets. It also
opens the generated review index to verify retained CSS, device widths, active-interval
gating and static Normal/Add compositing.

Validation on 12 October 2026: all 38 revised drawings and 107 focused browser checks
passed, including the generated review index. Master rendering/fonts/anchors and generated
review consistency passed. Application tests are outside this design-only change. The pre-existing missing
turn t195 ledger warning remains; no historical turn before 220 was edited.

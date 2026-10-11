# Editor effects — approved designs 213–215

**Designs approved by the owner on 2026-10-11; SPEC-053 proposed for specification review.** Open the
[focused HTML review and isolated prototype](editor-effects-213.review.html), or
[turn 215 in the master](Arke%20Studio.dc.html#t215). These are HTML drawings and design
discussion decisions. Design approval authorized drafting the specification, not application
implementation. SPEC-053 now records the proposed contract in the private document set; these
drawings do not claim that the application supports effects.

The owner's use case is a music video consisting mainly of still pictures transitioning over
a backing track, with occasional short video clips. They chose continuous atmosphere with
optional audio reaction, manual control plus a reviewable arrangement suggestion, and equal
authoring capability for Arke and humans. Simple response presets come first; beat, bass and
energy live under Advanced. Review uses the ordinary editor controls on an editable pending
version, with an explicit application boundary. The owner subsequently requested independent
visual target, time range and optional audio source, granular protection, and Inspector/Arke
as the only permanent tabs. Turn 215 was then revised so Arke composite cards own suggestions
and change details, and Review in timeline is the explicit entry to Suggested. Those revisions
were approved by the owner before the specification was drafted.

## The turns

| Turn | Frames | Review |
|---|---|---|
| 213 | a–h | Library, target/time placement, appearance/emitting area, granular protection, phone collection/Inspector, independent binding and audio-property protection |
| 214 | a–i | Simple response, Advanced, independent curves, reaction Off, changed source, Fold/phone, full response mapping/limits and track/clip/video-sound/mix source chooser |
| 215 | a–l | Request, Arke composite card/review, manual adjustment, arriving revision, changed base, application/undo, phone/Fold/resume, Current before review, preparing and phone ready card |

The master remains the source of the drawings. `editor-effects-213.mjs` writes all three turns
without changing historical ones, registers their approved design state in `build-review.mjs`, and
generates the focused companion. Existing Cut turns 121–133 supply the desktop composition;
turn 170 supplies touch behaviour, and turn 196 supplies native conversation-card review.
All new interface type uses the vendored Geist tokens; the light and dark surfaces use the
existing palette. The picture is the repository's public harbour asset.

## Approved interaction decisions

- Effects have an independent visual target (composition, video track or visual clip), time
  interval and optional audio input. Track/clip effects apply before that picture joins the
  composition; they disappear where the targeted picture is absent. Selecting a target never
  rewrites start/end. Initial range can use a selected picture, selection or current video
  duration, with typed start/end. Newly added effects have audio reaction Off.
- Base atmosphere, authored intensity and audio reaction are separately editable. Intensity
  and reaction curves have direct manipulation and typed point controls. Fades determine final
  visibility; reaction cannot bring back an effect faded to zero.
- Audio reaction explicitly selects an audio track, audio clip, video clip containing sound
  or composition mix, independently of visual placement. There is no required music lane.
  Signals follow placed timing and audio levels; the mix respects timeline routing and mute.
  Silence/outside-source time retains base atmosphere. Presets and strength come first.
  Advanced exposes beat/bass/energy, affected property, cap and smoothing. Editing these values marks Custom.
- Source readiness, likely beats and inferred section labels have distinct meanings. Source
  changes require refreshed analysis/review, and a missing source has no automatic replacement.
- Protection names individual properties and a passage or whole effect. Colour protection
  leaves amount/size/opacity editable. Target, start/end, motion/fades/curves, audio source,
  enabled state, preset, strength and individual Advanced properties can be protected and
  released independently. It constrains new AI suggestions while retaining
  direct human edits. Arke can perform every saved effect operation through the same authorities.
- Inspector and Arke are the only permanent tabs. Arke owns a composite proposal card with
  expandable per-effect changes, target/time/audio, protection and manual adjustments. During
  review the change-count button returns to the reviewed card in Arke; Inspect effect opens
  Inspector and Back to proposal returns to that card. There is no separate Inspector change
  list or Changes tab.
- Agent engagement, preparation and card arrival leave Current playback and authoring active.
  Only choosing Review in timeline opens the review bar and activates Suggested, retaining
  clock/transport. Generating, reviewing and applying are separate actions.
- A new revision arrives as another composite card with Review version N. It retains the
  earlier adjusted version, Current/Suggested comparison and playhead until explicitly chosen.
  Requesting or receiving a new revision never adopts it into the preview automatically.
- Review edits the pending version. Current/Suggested comparison keeps the same clock and one
  soundtrack; temporary visibility/reaction overrides stay out of the committed arrangement.
- Keep current and Exclude revise the complete proposed arrangement. Arke revisions include
  manual adjustments and protection. Alternate proposals retain earlier reviewed versions.
- Changed base/source disables application until a fresh preview is reviewed. Update proposal
  prepares a fresh composite card; entering its preview remains an explicit Review action. Compatible manual
  adjustments carry forward; conflicts require an explicit decision. Apply commits the exact
  reviewed version in one revision/Undo entry. Closing a review retains it; Discard resolves it.

SPEC-053 R-1–41 now defines the proposed authoring, analysis, rendering, protection and review
contracts, with six initial procedural presets, versioned analysis, deterministic preview/export,
lineage-aware passage protection and exact reviewed-version application. Its delivery programme
requires measured renderer/profile limits and platform parity before release. Recorded overlay
packaging, still pan/zoom, picture transitions and masks remain outside this capability. Automatic
effects requests affect effects unless the user explicitly includes other timeline content.

The specification is proposed, with approval of designs recorded separately. Its acceptance
scenarios A-1–A-14 and frame trace connect the drawings to later application verification. No
application implementation was performed as part of this specification step.

## Isolated prototype

The **Try the review** section starts in Arke with Current and an unreviewed ready card.
Choose Review in timeline to open Suggested. It demonstrates comparison at one playhead, amount changes,
independent target/time edits, explicit track/clip/video-sound/mix selection, audio-free
placement/suggestions, response presets/Advanced, reaction Off, independent curve edits,
granular protection/release, composite card navigation, explicit preview entry, a revision
arriving without replacing the reviewed version, an illustrative
Arke revision preserving adjustments and protected audio strength/source, Keep current/Exclude,
applying/undoing, discarding and resuming. The scenario toolbar can simulate an intervening current-timeline edit. Browser-local
fixture state includes the unreviewed/active/incoming versions and survives reload; Reset example clears that fixture. At phone widths Done closes
the Inspector so the curve and timeline are reachable.

Particles use deterministic synthetic timing. The waveform, likely beats, energy and Arke
revision are illustrative fixtures: no real backing audio, acoustic analysis, model request,
provider call, world write or installed application is used. The live scene has one illustrative
picture, so target/multi-track compositing and source levels are described in the drawings
rather than computed by a real renderer. Some surrounding controls and the wider preset
catalogue are drawings; this is a focused review prototype, not a complete
editor implementation or product acceptance test.

## Regeneration and verification

```powershell
node design-system/editor-effects-213.mjs
node design-system/check-master.mjs --record
node design-system/build-review.mjs
node design-system/editor-effects-213.check.mjs
node design-system/check-master.mjs --render
node design-system/build-review.mjs --check
```

The dedicated check uses headless Chrome (`CHROME` overrides its path) with an isolated
temporary profile. It saves rendered states and an inspectable report beneath the ignored
`.dev/editor-effects-design/` directory. It exercises the review boundary and verifies artwork,
Geist loading, horizontal layout, light/dark, desktop/Fold/390px/320px and new touch controls.
Static master/review checks and visual inspection are required before delivering the drawings.
These checks establish the prototype and drawings only; application tests follow a separately
approved specification and implementation.

To open the focused review in a browser, run
`node design-system/editor-effects-213.serve.mjs` and use its printed loopback URL. The host
serves only the drawings and public design assets; it has no application session.

Validation on 2026-10-11: 29 revised HTML states rendered with loaded artwork and Geist; 84 focused
layout and interaction checks passed. Desktop appearance, Advanced, curves, arrangement
review, ready/preparing composite cards, revision arrival, granular protection, target/time
placement, audio-source choice, changed-base, Fold,
phone and dark drawings were visually inspected. The master render and generated companion checks passed. The master still reports its pre-existing
pending missing-turn warning for t195 (recorded in the ledger); no historical turn was changed.

# Turn 240 · Remembered choices

27 October 2026, revision 3. Proposed for owner review, not approved or implemented. Extends
turn 157's Branch Map; requirement authority is SPEC-063 revision 4 and ArkeStudio issue #2199.

The owner requested a new turn showing remembered values, conditional choices and dialogue,
using The Red Quiet as the example. These drawings use First Contact, the existing interactive
prelude, and its six-person crew. They do not edit the authored production or world canon.

The design keeps the existing map, paths, Inspector, Arke panel, preview and narrow list.
It introduces no condition/assignment nodes or internal Scene branching. Header **Story facts**
declares the values. Select a choice for **Available when** and **Remember**. Open its Scene and
select a dialogue line for **Show when**. **Preview facts** explains the state at that route
point, apart from the authored defaults.

| Frame | What it settles |
|---|---|
| 240a | Map badges and a shared later scene |
| 240b | Production-local crew facts and defaults |
| 240c | Enum values, starting value and used-by references |
| 240d | A literal consequence on Seal the bore |
| 240e | All conditions: Elsie and Tomas both Alive for auxiliary power |
| 240f | A selected dialogue line with a guard and caption/voice behavior |
| 240g | Preview facts, manual-release choices and an explicit sacrifice cost |
| 240h | Four survivors, Imani's sacrifice, Wei's earlier loss and testimony |
| 240i | A state-dependent failure with a witness route |
| 240j | The narrow list and a rounded condition sheet |
| 240k | Click the outgoing + on the selected launch-collar node |
| 240l | The + opens the Define connector dialog helper |
| 240m | Destination and choice text together in the dialog |
| 240n | Conditions and remembered values in that same dialog |
| 240o | One complete added choice, selected and still not walked |
| 240p | The same rounded dialog helper on a phone |
| 240q | Choose on map, then return to the same dialog draft |

Revision 2 filled a missing entry point the owner identified: clicking the outgoing +. It is
a button beside the selected scene, not nested inside its selection button. Click, Enter or
Space now opens **Define connector**, a modal dialog helper, with From scene filled. The
owner explicitly requested a dialog in revision 3, superseding revision 2's creation Inspector.
To scene, choice text, Available when and Remember are defined together in the helper. The
map, its Inspector and product chrome are dimmed and inert, and keyboard focus is contained.

**Choose on map** suspends the dialog and outlines eligible destinations. Selecting a node
reopens the same draft. **Back to connector** or Escape during map selection returns without
changing the destination or losing any fields. The source cannot target itself in this flow.
Changing To scene in the dialog also preserves the text, conditions and remembered values.

The new example adds **Ask Dev to hold the release**, from **The launch collar** to
**Above the Quiet**. It requires Dev Alive and Wei not Alive, then sets Dev to Lost at release.
The existing remote-release and fortress-return paths stay visible as context.

The new edge is dotted and labelled Draft until Add choice. A missing destination or blank
text disables Add. Conditions use only the chosen fact's declared values; Remember assigns
each fact at most once. Add saves the complete local example and selects its connector, still
marked Not walked. Cancel or Escape in the dialog discards the draft and returns focus to +;
the backdrop does not discard work. Editing an already added choice uses **Edit connector**
and Save choice. Drag/drop is specified as a shortcut into the same helper;
this prototype exercises the complete click and keyboard path, not a drag implementation.

On a phone, the helper remains a dialog: all four corners rounded, 12-pixel outer gap, a
scrolling body and a fixed action footer. It is not the existing Inspector sheet. Choose on
map uses the narrow destination list and returns to the same phone-sized helper.

The crew remain Imani Okoro (Black Nigerian), Dev Malik (Indian), Lin Wei (Chinese),
Ana Lucía Reyes (Mexican), Elsie Ward (white Scottish) and Tomas Vale (white English).
Labels use full names. Sample lines are interface examples written for this turn, not a
change to the main novel. Art is not invented for the map: this is the text-only draft.

Important distinctions: defaults versus local preview values; actual route prefix versus a
labelled temporary scenario; traversal coverage versus editorial approval; guarded words
versus a pre-rendered image/audio track that still contains an absent person. Rewind must
replay the prefix rather than carry a later casualty into an earlier choice.

The focused review has a frame picker, theme switch and local interactions. Review and Keep
demonstrate the acceptance shape without writing any world file. The fixture is a drawing,
not the implemented SPEC-063 evaluator. Its illustrative findings are not reported defects
in the authored First Contact production. The full 104-route parity check remains required
when implementation begins.

Regenerate with `node design-system/branch-map-state-240.mjs`, then
`node design-system/check-master.mjs --record` and `node design-system/build-review.mjs`.
Serve using `node design-system/branch-map-state-240.serve.mjs` and open the reported review URL.
Validated in the in-app browser: all seventeen frames in light and dark (34 layout checks), no
horizontal Inspector overflow, Geist Sans token use, and a phone sheet without horizontal
canvas overflow. Reviewed desktop map, dark dialogue and phone-sheet screenshots. Checked
the remembered-effect Review/Keep flow, adding an Ana condition to dialogue, opening Dev's
own fact, hiding auxiliary when Elsie is lost, and choosing again at C3 to restore Wei's
remote-release option. The phone controls use a 44-pixel minimum height.

The connector checks additionally exercised: keyboard + activation; choosing a destination
node; typing a custom label; adding two conditions and a remembered loss; changing destination
by both dropdown and node click while retaining those settings; saving and inspecting the
same custom choice; required-field disabling; Cancel; Escape and focus restoration. No nested
buttons or horizontal Inspector/canvas overflow were found; phone controls meet 44-pixel height.

Revision 3 checks additionally confirmed actual modal semantics, inert background, Tab and
Shift+Tab containment, draft retention through map selection, Escape returning from the map
to the dialog versus discarding within the dialog, saving/closing the helper and selecting
the new connector. Phone measurements confirmed an 820-pixel dialog inside the 844-pixel
frame with 12-pixel top/bottom margins, no horizontal overflow, visible action footer and
44-pixel controls; its map-selection round trip preserved the draft and 390-pixel frame.

The master check passes with 236 turns and resolving anchors; generated-review validation
passes with 510 registered screens. These are design/prototype checks, not qualification of
the future runtime evaluator or all 104 routes. No application test/build is necessary for
this design-only change.

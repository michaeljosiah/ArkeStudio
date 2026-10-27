# Turn 240 · Remembered choices

27 October 2026. Proposed for owner review, not approved or implemented. Extends turn 157's
Branch Map; requirement authority is SPEC-063 revision 1 and ArkeStudio issue #2199.

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
Validated in the in-app browser: all ten frames in light and dark (20 layout checks), no
horizontal Inspector overflow, Geist Sans token use, and a phone sheet without horizontal
canvas overflow. Reviewed desktop map, dark dialogue and phone-sheet screenshots. Checked
the remembered-effect Review/Keep flow, adding an Ana condition to dialogue, opening Dev's
own fact, hiding auxiliary when Elsie is lost, and choosing again at C3 to restore Wei's
remote-release option. The phone controls use a 44-pixel minimum height.

The master check passes with 236 turns and resolving anchors; generated-review validation
passes with 503 registered screens. These are design/prototype checks, not qualification of
the future runtime evaluator or all 104 routes. No application test/build is necessary for
this design-only change.

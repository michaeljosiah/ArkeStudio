# Turn 228 · the Stage, uplifted

Drawn 17 October 2026 for epic #1826 (issues #1817–#1825). Not yet approved.

## What is drawn

| Frame | Screen | Issue |
|---|---|---|
| 228a | Lit look, camera written as words | #1825, #1820 |
| 228b | The same stage in Greybox | #1825 |
| 228c | Camera mode on shot 1 in the Plate look; the plate's form | #1818 |
| 228d | Ife on her last mark: Lean on, hand on Ade's shoulder, look at | #1821 |
| 228e | Add set's kit, a Room's form, a Light's form and the production's Look | #1819, #1825 |
| 228f | Build with Arke as a working log | #1823 |
| 228g | Board 1: four cameras, one cut animatic, the line check | #1824 |
| 228h | The Bench: numbered references, timed cuts, Follow | #1817 |

#1822 (the stage-designer brief) has no screen.

## The pictures are renders

The viewport images come from the app's own engine (three.js 0.185), not from a paint program.
`stage-228.render.mjs` builds one scene, a hotel lobby at night: Ade waits in an armchair, and
Ife comes out of the lifts, crosses to him and leans on his shoulder. It renders that scene in
three looks:

- **Greybox:** today's renderer, reproduced.
- **Lit:** material tags, practical lights, AgX, soft shadows, GTAO, fog and a night sky.
- **Plate:** the plate projected from shot 1's camera.

The set is assembled from kit functions. The figures are jointed mannequins, posed by name, and
Ife's hand reaches Ade's shoulder through a two-bone IK solve. Every render is deterministic.

To regenerate after a scene edit:

    node design-system/stage-228.renders.mjs     # stills into assets/, label positions into stage-228.labels.json
    node design-system/stage-228.mjs             # review page, master turn, build-review entries
    node design-system/check-master.mjs --record && node design-system/build-review.mjs

## The plate is a stand-in

The world has no empty location picture. `assets/stage-228-plate.jpg` is the empty left corner
of `nloj-backdrop.jpg`, cropped to 9:16 above the figures. The lobby is modelled to sit under
it: a warm back wall, a planter, a dark frame on the right and a polished floor. A generated
plate would replace it with no other change.

## What the renders proved

- **Lit makes the figures and the set separate.** In Greybox, Ade's capsule disappears into
  the chair and the walls. In Lit, the figures sit apart from the set and the light has a
  direction a video model can follow.
- **Pose names plus IK carry the action.** Seven named poses and one hand target are enough to
  draw sit, check the time, walk and lean on, which capsules cannot do.
- **Plate projection only reads from the matching camera.** From the overview it smears, so
  the Plate look is drawn in Camera mode only (228c).

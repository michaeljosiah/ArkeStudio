# The Stage — design, implementation and user guide

Reference implementation: `stage-viewport.js` (the 3D component) and the Stage tab in `Scene Workspace Vertical.dc.html` (the workspace around it).

---

## Part 1 · What the Stage is for

Between a written shot and a rendered clip there is a decision nobody was making: **where the camera is, and how it moves.** A text prompt can say "slow push-in", but it cannot say *how far*, *from what height*, or *when the move starts relative to the actor*. Two shots described the same way come back different.

The Stage closes that gap. It is a greybox previs space where the shot is blocked out — cast as figures, set as massing, camera as a rig on a motion path — and the result is exported as a **playblast**: a reference artefact the generator receives alongside the character sheets and the prompt.

Three principles govern it:

1. **Greybox, not render.** Nothing here is meant to look like the finished shot. Figures are neutral capsules, the set is translucent massing. The output is spatial information, not imagery.
2. **One camera.** Not a fleet of camera objects — one camera whose position over time is the animation. This is Blender's model and it was arrived at by correcting a worse design (see §5).
3. **Everything measurable is measured.** Camera height in metres, distance in metres, timing in seconds. The playblast carries numbers the prompt can state.

---

## Part 2 · Technical implementation

### 2.1 Libraries

| Library | Role |
|---|---|
| **three.js** | The whole 3D layer — scene graph, WebGL renderer, cameras, raycasting |
| **OrbitControls** (three.js addon) | Navigating the viewport (orbit, pan, zoom) |
| **TransformControls** (three.js addon) | The move gizmo — coloured axis arrows for repositioning objects |

Nothing else. No physics, no animation library, no scene-graph framework. All three come from three.js's own distribution, pinned via an import map.

**Why TransformControls rather than hand-rolled dragging.** The three.js docs describe it as adapting "a similar interaction model of DCC tools like Blender", and it is explicitly not for moving the scene camera — precisely this job. It also owns its own drag state and emits `dragging-changed`, which is the clean way to stop it fighting OrbitControls. An earlier hand-rolled plane-drag implementation lost that fight repeatedly.

### 2.2 Architecture

The Stage is a **web component** (`<stage-viewport>`), mounted into the Design Component via `<x-import component-from-global-scope="stage-viewport">`. This boundary matters: three.js owns imperative, per-frame mutable state, which does not belong inside a React render cycle. The component takes declarative attributes and emits events; it never reads application state directly.

**Attributes in** (all JSON strings or scalars):

| Attribute | Contents |
|---|---|
| `cast` | `[{name, colour, x, z, r, to, ghost}]` — figures, with `to` marking a walk destination |
| `sets` | `[{name, x, z, w, h, d}]` — set massing boxes, named for labelling |
| `keys` | `[{t, p:[x,y,z], l:[x,y,z], anchor, track}]` — the camera keyframes |
| `active` | index of the selected key |
| `mode` | `look` (outside view) or `camera` (through the lens) |
| `t` | playhead, normalised 0–1 |
| `ghost` | previous-shot continuity ghost on/off |

**Events out:**

| Event | Meaning |
|---|---|
| `autokey` | camera moved → insert-or-update a key at the playhead |
| `autoaim` | aim target moved → same, for the look-at |
| `castchange` / `walkchange` | a figure's start or end position moved |
| `keypick` | a key was selected in the viewport |
| `selchange` | selection changed (drives the panel readout) |
| `trackpick` | a figure was double-clicked → lock the camera onto them |

The workspace holds all state (`cams`, `figs`, `blocks` keyed by shot or board id) and passes it back down. The viewport is a pure function of its attributes plus transient interaction state.

### 2.3 The camera model

A shot's camera animation is an ordered list of keys:

```js
{ t: 5.0,                  // seconds
  p: [-2.55, 1.5, 0.2],    // position — world, or an OFFSET if anchored
  l: [0, 1.25, 0],         // look-at target
  anchor: 'Maren',         // if set, p is relative to this subject
  track: 'Maren' }         // if set, l follows this subject live
```

Position and aim are **independent channels**. That separation is Blender's Track To constraint: you move the camera freely and the aim is handled, or you move the target and the camera swivels in place.

**Sampling.** Two functions resolve the camera at any moment:

```js
sampleCam(keys, s, clock)   // position at path parameter s, evaluated at time `clock`
sampleAim(keys, s, clock)   // aim target, same
```

The two parameters are separate because an anchored key's world position depends on where its subject is *at that moment*, which is a different question from which key pair we're interpolating between. Passing one value for both is the common case; the drawn motion path passes them separately so it can plot the true animated curve rather than straight lines between static points.

**Resolution.** `keyWorld(k, u)` and `keyLook(k, u)` turn a stored key into world coordinates:
- no anchor → `p` is already world
- anchored → `p + subjectPosition(anchor, u)`
- tracking → aim is the subject's live position at height `l[1]`

### 2.4 Two hard-won implementation details

These cost several iterations each and would cost any reimplementation the same.

**`Object3D.lookAt` has two opposite conventions.** Called on a Camera or Light it orients `-Z` toward the target. Called on a plain `Object3D` or `Group` it orients **`+Z`** toward the target. The camera rig is a Group containing a PerspectiveCamera, so `group.lookAt(target)` aims the group's `+Z` at the subject while the child camera and the drawn frustum both look down `-Z` — 180° wrong. Every rig-orienting call must use camera convention explicitly:

```js
const aimAt = (g, target) => {
  m.lookAt(g.position, target, THREE.Object3D.DEFAULT_UP);  // -Z faces target
  g.quaternion.setFromRotationMatrix(m);
};
```

This was invisible on inspection — the code read correctly. It was caught only by measuring `dot(lensForward, normalize(target - position))` and finding `-1.0` where `+1.0` was required. **Orientation must be measured, not eyeballed.**

**World matrices only refresh on render.** three.js updates `matrixWorld` during `renderer.render()`. Any raycast issued between a scene rebuild and the next frame therefore tests objects at their *previous* transforms — typically the origin for freshly created objects. Every pick path must call `updateMatrixWorld(true)` on the groups it is about to raycast.

### 2.5 Rendering

One canvas, one renderer, two cameras:

- **`view`** — the orbit camera. What you see in Look mode.
- **`shot`** — the shot camera. A **child of the rig group** at local origin with identity rotation, so rig and lens cannot diverge in position or orientation. This is the standard camera-rig pattern: add the camera to a rig, and move the rig rather than the camera.

Both modes render through a **16:9 letterbox** computed with `setViewport` + `setScissor` + `setScissorTest`, rather than stretching the shot camera to the pane's aspect. This keeps the drawn frustum an honest guide — it and the render are the same shape.

In Look mode a second pass renders the shot camera into a small rect in the top-right corner: a live lens preview, always on screen. The rig, gizmo and staging aids are hidden for that pass. Both passes restore renderer state in `finally` blocks.

**Frustum from the real lens.** The wireframe cone is generated from the shot camera's actual field of view and aspect (`h = d·tan(fov/2)`, `w = h·aspect`), not from hardcoded proportions. What is drawn is what is seen.

### 2.6 Performance

The render loop is transform-only. `build()` — which creates geometry — runs on structural change (cast, sets, key count, selection, mode) and never on a playhead tick. Per frame, `refresh(u)` moves existing objects and rewrites the motion path into a fixed 60-point buffer in place.

The loop is also crash-proof: the body is wrapped in `try/catch` with the next frame armed in `finally`, so one bad frame cannot permanently freeze the viewport. An earlier version armed the frame at the top and died on the first exception.

Labels are DOM elements in an overlay, positioned each frame by projecting world points through the orbit camera. They are HTML rather than sprites so they carry design-system typography and stay crisp at any zoom.

### 2.7 Interaction model

Navigation and manipulation are separated the way Blender separates them:

| Input | Action |
|---|---|
| Left click on an object | Select it — nothing moves |
| Left drag on a gizmo arrow | Move the selection along that axis |
| Left drag on empty space | Orbit (hand-driven, since the left button is taken off OrbitControls) |
| Middle drag | Orbit |
| Right drag | Pan |
| Scroll | Zoom |
| Double-click a figure | Lock the camera's aim onto them |
| Left drag in Camera mode | Pan and tilt from where the camera stands |

`OrbitControls.mouseButtons.LEFT` is set to `null`. This is not a preference — with LEFT bound to ROTATE, OrbitControls takes pointer capture before any selection code can run, and no amount of `stopPropagation` prevents it (that only stops *other* elements; OrbitControls listens on the same one, registered first).

---

## Part 3 · User guide

### 3.1 Getting in

Select a shot in the storyboard and open the **Stage** tab. If the shot has never been staged, one button: **Stage the shot**. Arke reads the script and the filed frame, places the cast, puts down set massing, and creates a starting camera move.

The header then reads something like `v1 · 2 keys · dolly`.

### 3.2 Reading the viewport

- **Grey capsule figures** — the cast. Named labels float above them.
- **Translucent boxes** — set massing, labelled from the scene's locations.
- **Dark camera body with a wireframe cone** — the camera, at the playhead. The cone is what it sees.
- **Small ring on the ground with a sight line** — the aim target.
- **Solid curve with diamonds along it** — the motion path. Each diamond is a keyframe; the filled one is selected.
- **Top-right window** — a live view through the lens, always on.
- **Bottom-right cube** — the orientation gizmo; click a face for a straight-on view.

Two modes, toggled top-left: **Look** (from outside) and **Camera** (through the lens).

### 3.3 Simple: move the camera

1. **Click the camera.** It gains a ring on the floor and three coloured axis arrows. The panel reads `◆ camera`. Nothing has moved.
2. **Drag an arrow.** Red is X, green is up/down, blue is Z. The lens preview updates as you drag.
3. **Release.** A keyframe is written at the playhead. The chip reads `key moved · Keep`.

Clicking selects; dragging an arrow moves. They're separate steps so you always know what you're about to affect.

### 3.4 Simple: change where it points

Either:

- **Drag the aim ring** on the floor. The camera swivels on the spot — position unchanged.
- **Double-click a figure.** The camera locks onto them; the panel reads `aim · Maren`. It now follows them wherever they go.
- **In Camera mode, drag.** You pan and tilt from where the camera stands, watching through the lens. Released, it writes the aim key.

### 3.5 Building a move

The camera animation is keyframes in time. The workflow is Blender's:

> **Move the playhead → move the camera → a keyframe is written there.**

1. Drag the playhead to where you want the move to reach a position.
2. Drag the camera to that position.
3. Release. If a key already exists there it updates; if not, a new one is inserted, inheriting the aim and anchor of the key it grew from.

Repeat for as many positions as the move needs. Along the timeline:

- Diamonds mark keys. Interior diamonds **drag horizontally to retime**, clamped between their neighbours.
- **`+`** inserts a key at the playhead without moving the camera; **`−`** removes the selected one. Start and end are protected.
- Clicking a diamond moves the playhead to it, so the camera jumps to that framing.

### 3.6 Making the cast move

In the panel's **Movement** block, every character is listed with `holds` or `walks`. Click a row to switch.

Switched to `walks`, a translucent copy appears at their end position with a dashed, arrowed path between. Drag the solid figure to set where they start, the translucent one to set where they finish. They travel that path as you scrub and turn to face their direction of travel.

The translucent figure is a staging aid — it does not appear in Camera view or in the playblast.

### 3.7 Complex: a tracked camera on a walking subject

This is the case that motivated the whole feature, and it's demonstrated by **Shot 17 · Maren walks the drowned corridor** (15s). She walks 12m down a corridor; the camera follows from behind, swings out to her left, rises overhead, then comes round to the front — one continuous move.

Done naively, this is impossible to author: if the camera's positions are fixed world coordinates and the subject covers 12m, every position is wrong the moment she moves.

**The answer is anchoring.** Each key has an **anchor** row — `world`, or any cast member. Anchored, the key's position becomes an **offset from that subject** rather than a world coordinate. You describe where the camera sits *relative to her*, once, and it holds that relationship for the entire walk.

The corridor setup:

| Time | Offset from Maren | Reads as |
|---|---|---|
| 0s | `[0, 1.55, +3.0]` | 3m behind, eye level |
| 5s | `[−2.55, 1.5, +0.2]` | 2.5m out to her left |
| 10s | `[0.2, 4.4, 0.5]` | 4.4m overhead |
| 15s | `[0, 1.45, −2.9]` | 2.9m ahead, looking back |

To build it yourself:

1. Set the subject to `walks` and drag her end position down the corridor.
2. With the playhead at 0s, set the camera key's **anchor** to her name. This also locks the aim onto her, which is almost always what you want.
3. Place the camera behind her. A blue tether line draws to her, showing they're joined.
4. Move the playhead to 5s, drag the camera out to her left. New key, anchored, aim still locked.
5. Repeat at 10s (overhead) and 15s (front).

Press play. She walks, the camera swings through all four positions, and she stays centred throughout because the aim is tracking rather than pointing at a fixed spot.

Two things worth knowing:

- **The drawn path is the true animated path.** With anchored keys it's sampled from the real motion, so it curves around the subject rather than being straight lines between static points.
- **Lengthen the walk and the camera still works.** Because the keys are offsets, doubling the distance she covers requires no camera edits at all.

### 3.8 Placing an overhead camera

A camera looking straight down has no stable up vector, so its roll becomes arbitrary. Offset overhead keys slightly off-centre — the corridor demo uses `x: 0.2, z: 0.5` rather than `0, 0`. Small enough to read as directly above, large enough to keep the horizon predictable.

### 3.9 Reading out

The **Camera** panel shows the selected key's height, distance back, and aim in metres, with nudge arrows for fine adjustment. **Framing** resolves what the camera actually delivers — shot size, angle, lens. These are the numbers that go into the prompt.

### 3.10 Getting out

**Export playblast** files the move as a reference artefact on the shot. **Render with this** opens the generation session with the playblast attached alongside the character sheets, and the camera move written into the prompt as timed beats.

The playblast is what makes the Stage worth using: the generator receives an actual spatial reference for the move rather than an adjective.

---

## Part 4 · Deliberate limits

- **One camera per shot.** No A/B camera setups. Cutting between angles is what separate shots are for. If multi-camera is wanted it's a real feature, not a tweak.
- **Greybox only.** No texturing, no lighting design, no props beyond massing. The moment it starts looking like a render, people will judge it as one.
- **No inverse kinematics or character animation.** Figures translate and turn. Performance is the generator's job.
- **Interpolation is linear between keys.** The `ease` field is recorded and passed to the prompt but does not shape the previs curve.

---

## Part 5 · Design history worth carrying forward

Two decisions were reversed during development, and the reasons generalise.

**Multiple camera rigs → one camera.** The first version drew a separate rig for every keyframe, all visible at once. It became unreadable past three keys, and "which one am I moving?" was a constant question. Blender's model — one camera at the current frame, keys as dots on a motion path — is better because *the camera is one object over time*, and showing it as several objects contradicts that.

**Hand-rolled dragging → TransformControls.** Custom plane-projection dragging kept losing to OrbitControls over pointer capture and mouse-button ownership: four separate defects, each a variation on "the wrong thing received the press". The gizmo solves it structurally, and it also gives users something they already understand — axis arrows.

The pattern in both: **when a mature tool has solved an interaction, adopt its model rather than inventing one.** Users arriving from Blender already know how this works, and the conventions exist because the naive alternatives were tried and failed.

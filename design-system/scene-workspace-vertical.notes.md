# Arke Scene Workspace — Implementation Spec

Reference implementation: `Scene Workspace Vertical.dc.html` (standalone export: `Arke Scene Workspace Vertical.html`).
This document describes every feature in that design: what it does, why it exists, and what the user should end up with. An engineer or agent should be able to build the real thing from this without seeing the prototype.

---

## 1. Purpose and scope

The Scene Workspace is where a creator turns a written scene into rendered footage. It owns one scene at a time. Everything upstream (episode, world, character sheets) and downstream (assembly, export) lives elsewhere.

The workspace answers four questions in order:

1. What happens in this scene? (script)
2. What does each moment look like? (frames)
3. Which moments must be generated together to stay consistent? (boards)
4. Does it play? (clips and preview)

**Design principle that governs the whole surface: the scene is authored top to bottom, and every derived thing states where it came from.** Nothing is silently inferred without being visible, and no two surfaces are allowed to own the same decision.

---

## 2. Core object model

Build these as real entities. The prototype fakes persistence; the product must not.

### 2.1 Scene
- `id`, `episodeId`, `number`, `title`, `synopsis`
- Scene context: `location`, `time`, `look`, `aspect`. These are **inherited defaults** for every shot.
- Derived: total runtime (sum of shot durations), frame coverage count.

### 2.2 Shot
- `n` (ordinal within the scene), `title`
- `script` — the prose of what happens. The dominant text. May contain `@` tokens.
- `prompt` — the image prompt. Derived from script + references + camera unless hand-edited.
- `intent` — a one-line note on why the shot exists.
- Camera: `size`, `angle`, `lens`, `dof`, `move`, `pace`
- Timing: `dur` (seconds)
- Look: `light`, `time`, `aspect`
- Sound: `vo`, ambience, effects
- `refs: string[]` — names of world entities the shot uses.
- `img` — the frame (null if not generated)
- `clip` — null, `"board {letter}"`, or `"solo"`
- `status` / `origin` — used to derive the state chip.

**Inheritance rule:** any field present in scene context is shown on the shot only when it *differs* from the scene. Equal values are inherited and invisible. This keeps a shot card quiet by default and makes an override meaningful.

### 2.3 Reference
A world entity (character, prop, location) with `name`, `thumb`, `meta` (e.g. `sheet v4 · lead`). References are not created here — they're drawn from the world catalogue.

**References are inferred from the script.** Typing `@Maren` in a shot's script or prompt files Maren as a reference on that shot. `+ Reference` exists only for things that aren't named in the script.

### 2.4 Audio
- `id`, `name`, `kindLabel` (e.g. `voice sample · @Maren`), `character`, `dur`, `targets: shotIds[]`
- Audio is a **reference input**, exactly like a character sheet. A voice sample attached to a shot is sent with that shot's (or its board's) generation request.

### 2.5 Board
A **derived** grouping of consecutive shots that will be generated as one image / one pass. Boards are never stored as user-authored objects; they're computed (see §6) with a small set of user overrides (`splits`, `merges`). A board has: `letter`, `members`, `dur`, `reason` (why it started), `warnings`, `notes`.

### 2.6 Clip
The video artefact. Two kinds:
- **Board clip** — one clip per board; each member shot holds an in/out point into it.
- **Solo clip** — one shot rendered on its own. Conceptually a board of one.

### 2.7 Take
One generation attempt: `id`, `mode` (Image/Video), `model`, `status` (running/done/discarded), `output`, `prompt`, `references`, `cost`, `createdAt`. **Takes must persist on the shot or board** (the prototype loses them on session close — see §14).

---

## 3. Global layout

Fixed three-column app frame:

- **Left rail** (~54px): app-level navigation icons.
- **Centre column**: scene header → view tabs → the active view.
- **Right panel** (~331px): Arke, the assistant. Header shows `Arke · Shot 15` with the frame thumbnail; it follows the current selection. Selection alone provides context — there is no "ask Arke to look at this" action.

All overlays (preview lightbox, board image, generate dialog, clip dialog, reference dialog, generation session) are children of the **app frame**, which is the positioned ancestor. They must cover the full window including the left rail and Arke panel. *This was a real bug: scoping them to the centre column left a third of the app lit and interactive behind a modal.*

---

## 4. Scene header

- Breadcrumb: `Saltlight · episode 2 · the vigil`
- Title: `Scene 4 · the verse rises`
- Editable synopsis (contentEditable, one or two lines)
- Inherited scene context as quiet chips: location, time, look, aspect
- Metrics: `5 shots · 22.5s · 3 frames filed`
- Actions: `Review scene` (outline), `Generate frames` (primary)

**Naming matters:** the primary is `Generate frames`, not "Generate scene" — it produces stills. The word "scene" is reserved for video rendering, so the label never over-promises.

**One owner per action.** There must be exactly one `Generate frames` control. An earlier build had it in both the header and the toolbar and they behaved differently — two identical primaries stacked 100px apart is a defect, not redundancy.

---

## 5. View tabs

A segmented control above the content: **Storyboard** (default) · **Flow** · **Preview**. Plus, on the right of that row:

- Coverage line: `2 of 5 without a frame`
- `Show boards` / `Boards on` toggle
- (During a run, both are hidden — see §8.)

Each tab is a distinct mode of working, not a different rendering of the same thing:
- **Storyboard** — authoring. Write here.
- **Flow** — a node canvas for power users. Wire and run here.
- **Preview** — playback. Judge here.

Opening Flow triggers a fit-to-content (§11.8).

---

## 6. The board packing algorithm

This is the heart of the design and must be implemented exactly.

### 6.1 Why boards exist
Generating each frame independently causes drift — the character's face, the light, the grade all move between shots. Generating several consecutive shots as a single grid image ("shot board") forces one pass, so cast, light and grade hold together. But video models cap at 10–30s, so a scene maps to a *sequence* of boards, not one.

### 6.2 The scene's own values
Do not compare shots against static defaults. Derive the scene's `time` and `light` as the **modal value across the scene's shots** (the value most shots share). A shot "overrides" only if it differs from that.

### 6.3 Packing rules
Walk the shots in order, accumulating into the current board. Start a new board when:

| Condition | Reason label | Notes |
|---|---|---|
| `board.dur + shot.dur > cap` | `clip limit` | Never overridable. The cap comes from the selected model. |
| user forced a split before this shot | `by hand` | From `Split board here` or a boundary drag |
| user merged this boundary | *(no break)* | Suppresses the automatic break below |
| shot's `time` differs from the scene's | `time of day changes` | Hard break |
| shot's cast and the previous shot's cast have **no overlap** | `cast changes` | Hard break |

**Lighting is deliberately NOT a break.** A practical lantern inside a blue-hour scene is an accent, not a continuity failure. It surfaces as a soft note on the board (`lighting accent · shot 12 · practical lantern, inside a blue hour scene`) in neutral grey. *An earlier build broke on lighting and produced four single-shot boards out of five shots, which defeats the entire feature.*

### 6.4 Single-shot collapse
After packing, fold any single-shot board into whichever neighbour has room under the cap. A board of one delivers zero cross-shot consistency — it's per-shot generation wearing a board label. **Exception:** never collapse a board the user split by hand.

### 6.5 Carried warnings — the honesty rule
Whenever a hard break is suppressed (by a merge, a boundary drag, or the single-shot collapse), the reason must be **carried forward onto the surviving board as an amber warning**:

- `spans a time-of-day change · shot 15 dusk in a night board`
- `spans a cast change · shot 14 brings Sereth, Sereth's lantern`
- `shot 15 rendered separately · may not match this board`

A seam the user chose stays visible; a seam that appears by accident is impossible. Warnings are amber (`--warning`); lighting accents are neutral (`--neutral-400`). The two are visually distinct because they mean different things.

### 6.6 Model caps
| Model | Clip limit |
|---|---|
| Kestrel v3 | 30s |
| Halo motion | 20s |
| Draft fast | 10s |

Changing the model repacks the boards live.

### 6.7 Performance
`packBoards` runs on nearly every render. **Memoise it** on a key covering: cap, shot order, and each shot's `dur`/`time`/`light`/`clip`/`refs`, plus the `splits` and `merges` maps.

---

## 7. Storyboard view

The scene as full-width rows, read top to bottom, max content width ~980px.

### 7.1 The row
Three regions, left to right:

**Frame (252px)**
- The image, or a hatched `no frame yet` placeholder
- Top-left: shot label (`shot 15`), draggable — this is the reorder handle
- Bottom-left: `16:9 · 6.0s · 35mm`
- On hover: a centred 42px **preview button** (only when a frame exists — its hit area is the circle alone, so the rest of the thumbnail stays draggable), plus a bottom action bar with `Prompt` / `Variants` / `Upload`
- Run states overlay here: `queued` (white wash), `generating frame…` (dark, pulsing), and a red `came back dark · Retry` strip on failure

**Body (flexible)**
- Title line: `Shot 15 · Wide` plus the state chip (see 7.2)
- `script changed · Re-read` strip when the script has moved on from the prompt
- **The script** — the dominant text, 13px/1.7, contentEditable, `@` picker enabled. This is the only thing on the card at full weight.
- Optional expanded image prompt (mono, quiet) with `Rebuild` / `Hide`
- Reference chips (name + round thumb), inferred from `@` usage
- Override labels — only fields that differ from the scene (`medium close-up override`, `slow push-in override`)

**Actions (158px, hairline divider)**
- `Regenerate` (outline) or `Generate frame` (primary) sharing a line with the `···` menu
- Beneath it, in a fixed slot: `prompt · auto` and `Edit`
  *The fixed slot matters — when this sat in the wrapping meta row it jumped around as content reflowed.*
- `···` menu: Open in generator · Advanced · Duplicate · Add shot after · Delete

### 7.2 Shot state vocabulary
| Chip | Dot | Meaning |
|---|---|---|
| `story` | neutral | Script written, no frame. A legitimate state, not an error. |
| `storyboard` | amber | Framed, not final |
| `production-ready` | green | Ready to render |
| `needs attention` | red | Blank or broken |
| `rendered` | near-black | A clip exists for this shot |

### 7.3 Dividers between rows
At rest: a quiet hover-only line with a `+` (insert a shot here). When boards are on, it also offers `Split board here`. During a boundary drag it becomes a dashed drop target labelled `Move boundary here`.

### 7.4 Board bands
When `Show boards` is on, a band header appears above each board's first row:

`⠿ Board A   shots 12–14   ————   split · time of day changes   13.5s / 30s   [prompt icon] [board icon]   Merge up`

- The band name is the **drag handle** — drag it onto any divider to move where the board begins (suppresses the old boundary, sets a new one).
- `Merge up` folds the board into the one above.
- Two icon buttons with dark tooltips below-right (`Consolidated prompt`, `View board image`). Icons, not text links — the band had five text fragments and read as noise.
- Warnings and accents render beneath the header.

### 7.5 The consolidated prompt
`Prompt` on a band expands one editable prompt for the whole board:

```
The pier below The Vigil, dusk, blue hour, 16:9. Continuous cast, light and grade across every cell.

1. medium close-up, 50mm — @Maren grips the rail of @The Vigil, head tilted…
2. extreme wide, 24mm — The harbour below @The Vigil goes still…
3. medium, 50mm — @Sereth raises the lantern…
```

Scene context first, then the member shots as numbered beats with size and lens. `Rebuild` reassembles from current scripts; edits persist until rebuilt. Without this, board mode is a black box.

### 7.6 The board artefact
`View board image` opens the board as one image: a grid of numbered 16:9 cells (2 columns up to 4 members, 3 beyond), each labelled `shot 14` with duration and lighting accent.

- Per-cell **Retry** regenerates that cell *against the rest of the board as reference*
- **Retry board** redoes the whole pass
- Cells without frames read `no frame yet`
- Footer states the contract: "One image, one pass — cast, light and grade are shared."

This is the honest review surface: a shot pulled out of context always looks fine; the board is where drift is visible.

---

## 8. Generate frames — dialog and run

### 8.1 The confirm dialog
Opened from the header primary. Title is live: `Generate 2 frames`.

**Method** — two cards, each stating its consequence rather than explaining the technique:
- *Per shot* — "Each frame generated on its own. Fastest, and a single frame is cheap to retry — but characters and light drift between shots."
- *Shot board* (default) — "Consecutive shots generated as one image, then sliced. Holds cast, light and grade together — a retry redoes the whole board."

**Packing preview** (board mode only) — `5 shots → 2 boards`, plus one card per board: range, `13.5s / 30s`, spare headroom (amber under 2s), the split reason, and any warnings/accents. Below: "Boards break at the clip limit and wherever continuity breaks. Frames are sliced back onto the shots; the board is kept as the source for retries."

**Include** — `Shots without a frame` / `Every shot in the scene`. Defaults to whichever is non-empty when the dialog opens.

**Model** — three chips with their caps; switching repacks live.

**Footer** — inherited scene context, `2 frames · about 14s` (derived from count, never hardcoded), Cancel, Generate frames.

**Zero-frame guard, three layers:** the scope defaults to *every shot* when nothing is missing; if the scope still resolves to zero the primary is replaced by "Every shot already has a frame. Switch to *every shot in the scene* to re-render."; and the run engine refuses to start an empty run. *All three are needed — the first build hung forever on `0 of 0 frames` with only Cancel as an exit.*

### 8.2 The run bar
Confirming starts a run in place — no modal, no separate progress screen. The toolbar row becomes the run bar and **owns the row** (coverage line and boards toggle hide for the duration):

`▁▁▁▁▃▃▃  Board A   3 of 6 frames   ~21s left   Pause   Cancel`

- Determinate progress line, current step, count, ETA
- Pause / Resume / Cancel; Pause and Cancel never shrink, the label/ETA clip first
- In board mode a whole board goes active together and its frames land together; in per-shot mode one at a time
- Rows stay editable throughout; editing a script mid-run marks it `script changed`, it does not block

### 8.3 Failure and retry
A failed frame gets a red `came back dark · Retry` strip and the run continues past it. **All retries go through one path** (`requeue`): clear the failure flag, re-queue the shot as a new run step, let the run bar cover it. The row strip, the Arke report row, `Retry board` and `retryCell` all call it. *Two consecutive bugs came from having a second retry path that regenerated the image without clearing the failure — leaving a red "came back dark" banner sitting on top of a successful frame.*

### 8.4 Completion
The bar collapses to `5 frames added · 1 failed` with **Review** and a dismiss ×. Review opens the first new frame in the preview lightbox so you can arrow through the results. No success screen.

---

## 9. The generation session

The workspace **hands off** to the existing generation session rather than inventing a bespoke render dialog. Two entry points: a shot's `···` → **Open in generator** (Image mode), a board band → **Render board** (Video mode). Also reachable from every node on the canvas.

### 9.1 Header carries provenance
`‹ Saltlight · episode 2 · scene 4 | Board A | 3 shots · 13.5s · one pass | generation session`

Never "Untitled session". The session belongs to something, and Accept needs to know where the result goes.

### 9.2 Left column (392px)
- **Image / Video** mode tabs
- **References** — thumbnails prefilled from the subject's `@` tokens (`Image 1`, `Image 2`…), the board sheet for a board, and any attached **audio** as a waveform tile labelled `Audio` with `voice sample · @Maren · 9.0s`. Plus a dashed `+ reference` slot.
- **Prompt** — the assembled consolidated prompt, editable, `@` picker live, with `Rebuild`
- Context chips: `aspect · 16:9`, `duration · 13.5s`, `sound · on` (Video) / `seed · auto` (Image)
- Model presets with per-take cost (Image: GPT Image 2 ~$0.14, Kestrel stills ~$0.09. Video: Seedance 2.0 Fast ~$3.63, Kestrel v3 ~$5.10)
- `~$3.63 a take` and **Generate**

### 9.3 Right side — takes
- Filter: All / Filed / Discarded
- **Centre preview.** An image take is a still. A video take gets a large play control, a transport bar with a play head running the clip's real duration, and `2.4s / 4.0s`. A running take shows `rendering…`.
- **Take rail (152px)** — each take is a 16:9 first-frame thumbnail with `take 2 · ready` beneath and a play badge on video takes. A generating take is a hatched placeholder with a spinner. Clicking loads that take into the centre.
- **Accept / Discard sit directly below the playback view**, with a line stating the outcome: `accepting files the clip onto 3 shots`.

Accept files the artefact back — a frame onto the shot, or motion onto every shot in the board — flips those rows to `rendered`, and logs to Arke.

---

## 10. Arke narration

Arke is a log, not a chatbot bolted on.

- Header shows `Arke · Shot 15` with the frame thumbnail; follows selection.
- After a run: "Generated 5 frames for scene 4 across 2 boards, so cast and light hold together. Shot 16 came back dark — worth a retry." Text adapts to per-shot mode.
- Below it, a **report card**: one row per step (`board a · 3 frames · one pass`, green dot), one row per failure (red dot, `came back dark`, live `Retry`).
- Clicking a row selects that shot.
- **Report rows reconcile against live state.** A failed row whose shot has since got a frame flips to a green dot and reads `came back dark · retried`, with the Retry link removed. The original wording stays as history. *Rows built from a frozen snapshot contradicted the rest of the app within seconds.*
- Accepting a take also logs, with the affected shots as rows.

---

## 11. Flow — the node canvas

A React Flow-style canvas for power users who want granular control over how each artefact is produced. **It is not a second place to write.** Script editing lives in the storyboard; the canvas is about wiring, running and comparing.

### 11.1 Node types and geometry
| Kind | Size | Content |
|---|---|---|
| `ref` | 156×178 | Large portrait image, name + `sheet v4 · lead` centred beneath |
| `shot` | 232×96 | 80px frame strip, `Shot 13 · 4.0s`, title, `Medium · 50mm`, run button |
| `board` | 196×86 | `Board A`, `shots 12–14 · 3 cells`, `13.5s / 30s`, `Render` |
| `clip` | 208×152 | Video card — frame fills the top, play badge, duration corner, name + `rendered · 13.5s`, run button |
| `audio` | 196×74 | Play control, name, level meter, `voice sample · @Maren · 9.0s · feeds 2 shots` |

**Every card must be `box-sizing: border-box` and exactly the size the graph maths uses.** Otherwise padding inflates the card and ports/edges attach *inside* it.

### 11.2 Default layout
References in two columns (x 20 / 192, pitch 196), shots at x 400 (pitch 118), boards at x 700 aligned to their members' mean y, clips at x 960.

### 11.3 Edges
- Reference → shot: dashed, `--neutral-300` (soft input)
- Audio → shot: dashed (soft input)
- Shot → board → clip: solid, `--neutral-400` (production path)
- Shot → solo clip: solid
- Cubic beziers from right-centre of source to left-centre of target.

### 11.4 Connecting and disconnecting
- **Reference port** (right edge) → drag onto a shot to attach. A dashed wire follows the pointer.
- **Audio port** → drag onto a shot to attach the voice sample.
- **Shot port** → drag onto empty canvas to create a **solo clip** node. Dropping on an existing clip is refused with a toast: "Board membership is set in the storyboard bands — use Split or Merge there."
- Hovering any soft edge reveals a small × at its midpoint to detach.
- **Shot→board and board→clip edges are not hand-editable.** Board membership has exactly one owner: the storyboard bands.

### 11.5 Hover toolbar
On hover, a row of icons appears above the node: **move handle** (left), then **details**, **open larger**, **⋮** (right).

- Details: shot → inspector; board/clip → board image
- Open larger: shot → preview lightbox; board → board image; clip → **clip dialog** (16:9, play control, transport, real duration); reference → the sheet at 440px
- ⋮ → the node's context menu

**The toolbar box must overlap the card** (e.g. `top:-26px; height:32px; padding-bottom:10px; box-sizing:border-box`). Any gap between the icons and the card is a dead band that fires mouseleave and dismisses the toolbar before it can be clicked. *This broke twice at 5px and again at 2.2px.*

### 11.6 Context menus (right-click, or ⋮)
- **Canvas**: Add shot here (lands at the click point) · Add audio here · Arrange and fit · Open the generate dialog
- **Shot**: Open in generator · Render as clip · Advanced · Duplicate shot · Delete shot
- **Reference**: Attach to every shot · Detach from every shot
- **Audio**: Open in generator · Delete audio
- **Board / clip**: Render this board · View board image · Show the storyboard bands

Menus must be **clamped to the canvas** on open (they sit in an `overflow: hidden` container) — slide in from the right/bottom edge rather than being cut off. Left-clicking a node dismisses any open menu.

### 11.7 Clip nodes play on hover
Hovering a clip node cycles its board's member frames (~620ms) with a `playing` badge, and stops on leave. Enlarge opens the clip dialog with a real transport.

### 11.8 Canvas controls
Bottom-left: zoom out / `100%` / zoom in / **Arrange**. Arrange is **fit-to-content** — it clears manual positions, computes the graph bounding box and sets zoom and pan so every node is inside the canvas. Opening the Flow tab runs the same fit.

**The toolbar must swallow `mousedown` and act on `click`.** Otherwise every zoom press also starts a canvas pan, and Arrange fights its own reset.

---

## 12. Preview

The scene played end to end on the shots' real durations.

- **Stage**: the current shot's frame, `shot 15` label, an honest `still · animatic` / `motion · rendered` badge, and title + `Wide · 35mm · 6.0s` along the bottom. Frameless shots show a placeholder rather than black.
- **Transport**: play/pause, restart, `8.4s / 22.5s`
- **Filmstrip**: every shot sized proportionally to its duration; the live shot lifted out with a near-black outline while the rest sit under a white wash; **board boundaries drawn as vertical rules**; frameless shots hatched. Click any shot to seek.
- The script of the current shot sits beneath.

Preview is where a seam between two board passes becomes obvious, which is why the boundaries are drawn on the strip.

---

## 13. Cross-cutting rules

### 13.1 Timing
**Never accumulate `+0.1` per tick.** Every clock (scene preview, take playback, clip dialog) records a start timestamp and computes `elapsed = (Date.now() - t0) / 1000`. Accumulating ties playback speed to render cost — the prototype ran at 0.27× real time and then stalled entirely.

Pause freezes the position; reaching the end stops playback and holds the head at the end; changing the selected take/clip clears the timer and resets.

### 13.2 Render cost
- Memoise `packBoards` (§6.7)
- Do not build the node graph unless the Flow tab is active
- These two together are what make playback keep time

### 13.3 Overlay geometry
- Overlays mount on the app frame, not the centre column
- Tooltips inside a scrolling container drop **below** the trigger and align to its right edge so they can't cross the container's top or right edge
- Context menus clamp to their container
- Hover toolbars overlap their trigger

### 13.4 One owner per decision
| Decision | Owner |
|---|---|
| Board membership | Storyboard bands (split / merge / drag) |
| Script text | Storyboard row (and the inspector, same field) |
| Frame generation in bulk | Header `Generate frames` |
| Single-artefact generation | The generation session |
| Wiring references and audio | Flow canvas |

Every other surface links to the owner rather than duplicating the control.

### 13.5 Honesty rules
- A suppressed continuity break always leaves a visible warning
- A shot rendered outside its board says so, on the board
- Preview labels animatic frames as animatic
- The board artefact, not the individual frame, is the review surface for consistency

---

## 14. Known gaps — build these too

The prototype stops short in five places. All five are real product requirements:

1. **Takes don't persist.** They live in the session and vanish on close. They must belong to the shot or board, with history browsable later. This also resolves the open case: *if a board is rendered after a shot has a solo clip, the board wins and the solo clip becomes a discarded take rather than being overwritten.*
2. **No scene completion.** There's no lock, no "done", no route back to the episode with the scene signed off. The workspace currently has no exit.
3. **No whole-scene video run.** Frames can be generated in bulk; clips can only be rendered one board at a time through the session. A scene-level render queue (with per-board checkpoints, minutes-long durations, and the ability to navigate away while it runs) is missing.
4. **Audio nodes have no generation session behind them.** Attaching a voice sample works; generating one does not.
5. **Preview plays frames, not clips.** Once clips exist it should play them.

---

## 15. Visual system

SpecOne design system (shadcn neutral). Do not invent values.

- **Surfaces** white `--card` / `--background`; `--secondary` `#F5F5F5` for recessed strips and segmented controls
- **Text** `--foreground` `#0A0A0A`, `--muted-foreground` `#737373`, `--neutral-400` for the quietest metadata
- **Primary** `--primary` `#171717`; **destructive** red is the only hue in the chrome
- **Status** green / amber / red only as 6px dots and small labels, never as fills
- **Borders** 1px `--border` hairlines do most of the separating work
- **Radius** buttons/inputs 8px, cards 14px, pills 999px
- **Type** Geist throughout; Geist Mono for IDs, paths, durations, and state labels (`prompt · auto`, `13.5s / 30s`) — never for UI labels
- **Casing** sentence case everywhere; small uppercase section labels in sans with light tracking
- **Icons** Lucide, ~1.75px stroke, 12–17px, functional only
- **Motion** 150–200ms `cubic-bezier(0.4,0,0.2,1)`; the only loops are the generating pulse and the spinner
- **Minimum sizes** UI text 13–14px, metadata never below 9.5px mono, hit targets 24px+ on the canvas and 44px on touch

---

## 16. Acceptance checklist

- [ ] Scene context inherits; only overrides show on rows
- [ ] `@` picker writes tokens and files references in script and prompt, on the row and in the inspector
- [ ] Packing matches §6 exactly, including modal scene values, the lighting exemption, single-shot collapse, and carried warnings
- [ ] Split / Merge / boundary drag all work and cannot breach the clip limit
- [ ] Consolidated prompt assembles, edits, and rebuilds per board
- [ ] Board artefact opens with per-cell and whole-board retry
- [ ] Generate dialog states consequences, previews packing, derives its estimate, and cannot start an empty run
- [ ] Run bar owns its row, pauses, cancels, survives edits, and reports failures without blocking
- [ ] Every retry clears the failure flag and re-queues through one path
- [ ] Session opens prefilled with references (including audio), prompt, context and cost, from every entry point
- [ ] Takes render, play, and accept back onto the right shots
- [ ] Canvas: drag, pan, zoom, fit, connect, disconnect, context menus, hover toolbars, clip hover-play, enlarge dialogs
- [ ] Preview plays at real time with a seekable, board-marked filmstrip
- [ ] Arke narrates every run and reconciles its rows against live state
- [ ] All overlays cover the whole app frame
- [ ] No clock accumulates per tick

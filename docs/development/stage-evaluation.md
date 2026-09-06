# Stage evaluation (#886)

The deterministic fixture set defines these checks before scoring model-authored drafts. Camera
positions are in metres and marks in shot-local seconds. General checks: finite transforms,
ordered tracks, exact shot coverage, head projections inside normalized ±0.98 at quarter-second
samples (foreground shoulders can crop), no unintended camera/subject intersections, and visible
script-relevant openings and props. Review intermediate motion, not only the first and last frame.

| Fixture | Measurable expectations | Cinematic review |
|---|---|---|
| Dialogue two-shot | Both heads remain in frame for 6s; fixed camera; left/right order preserved | Balanced readable faces and eyelines |
| Over shoulder | Foreground shoulder may crop; listener remains visible throughout 6s | Shoulder establishes relation without hiding listener |
| Doorway entry | Actor waits to 1s, crosses z=0 at 3s, stops at 5s; 1.4m opening and 2.4m clearance | Actor visibly passes through an opening, not a wall |
| Seated furniture | Actor stays seated for 6s; face visible above table | Chair/table dimensions and body relationship are plausible |
| Delayed action | Hold to 1s; cross by 3s; finish turn by 4s; sit at 5s | Distinct beats read without sliding through furniture |
| Independent motion | Actor crosses x=-2 to +2 in 6s while camera completes an orbit | Camera and actor move independently; tracking keeps subject framed |
| Valley chase | Driver rides car from z=0 to 50 in 8s; camera settles in car space at 6s; final offset holds within 1e-8m | Valley/road/car silhouettes read, windows are open, final driver view is unobstructed |

Fixtures live in `packages/contracts/test/fixtures/stage-scenes.ts`. Tests use the same evaluator
as the viewport; they are a tool regression baseline, not evidence that a live model interprets
every script correctly. The model-loop fixture deliberately changes the first composition after
reading actual PNG files; it checks transport, preservation and provenance with a fake adapter.

Run the affected tests using the commands in [testing](testing.md). For an actual WebGL/encoder gate:

```powershell
node apps/desktop/scripts/stage-visual-smoke.mjs
```

This launches a hidden sandboxed Electron window with a dedicated test bridge, renders all fixture
inspection frames and MP4s through StageViewport and the real Stage exporter, and prints its
output directory. It needs installed Electron plus `ffmpeg`/`ffprobe` on PATH; optional
`ARKE_STAGE_FFMPEG` and `ARKE_STAGE_FFPROBE` name executables. It makes no model/provider calls.
Each output includes measured encoded metadata, an opening PNG and frame observations. Expect
1280×720, 30fps, 180 frames for 6s or 240 for 8s. Compare decoded opening video to opening PNG
(with lossy-codec tolerance), and inspect camera framing, screen orientation and timed action.
Outputs are intentionally retained for visual review in the printed temporary directory.

For live AI evaluation, select a capable image-reading model in production/Stage designer settings.
Use each fixture brief without feeding its coordinates to the model. Compare Build with Arke
against Quick layout using the measurable constraints above, then review framing, occlusion,
motion readability and assumptions. Preserve blocking on a second request and ask for camera-only
corrections. Record the actual model, source versions, outputs and remaining issues. Model fidelity
is unscored until that run is performed; schema validity and fake-adapter success are insufficient.

The transport regression files an MP4, admits it in Bench, resolves contained bytes and captures
the real provider client's request. This proves delivery without spending on generation. An
explicitly authorized paid smoke test can separately evaluate whether generated motion follows
the accepted reference. Compare the generated take and playable Stage reference in Bench.

World schema 10 is a compatibility fence: expanded Stage fields, animation, provenance and encoded video metadata cause
the normal committer to advance the world minimum reader version. No bulk migration is required;
legacy boxes/figures/cameras remain readable. Restoring a scene restores its Stage state with the
existing scene journal; prior playblast artifacts remain history and are revalidated before use.

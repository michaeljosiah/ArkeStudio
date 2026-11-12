# Local media measurement - turn 258

Approved by the owner 1 November 2026 for the narrowed issue #253, on main 833007167.
The owner authorized music-aware generation and reliable media measurement/recovery.
The owner approved the seven drawings before application UI implementation.

These seven drawings use the existing Cut inspector and phone Clip details sheet.
Measure media reads the selected source locally. Repeated presses coalesce; failures and
missing tools leave the take intact. Source changes refuse stale metadata. Full measurements
become adjacent media-info records; immutable take.json and paid media remain unchanged.
No master editor, marker-import UI, waveform service or second timeline is introduced.

The backend follows SPEC-013 R-1/R-3 and the media sidecar contract, SPEC-019 R-11 for
music exclusion, and SPEC-037 R-1/R-4 for delivery authority. The source identity, hash fences,
containment and lifecycle are coordinator responsibilities, never inferred by the renderer.
A duration-only probe cannot establish whether audio exists.

Rebuild: node design-system/media-measurement-258.mjs; node design-system/check-master.mjs --record;
node design-system/build-review.mjs. The drawings are synthetic and do not read an author world.
The approved turn is mirrored into the accepted prototype.

Validation: all 14 light/dark drawing captures pass, including font tokens, horizontal fit, fixed
sheet chrome and phone target sizes/scrolling. Backend take/Bench/measurement suites pass,
including current-world wire publication, no provider enqueue, source-change refusal and native
probe cancellation. Full repository typecheck, build and lint pass (8 pre-existing lint warnings).
Private SPEC-013/019 amendments are committed at 0a13a65 naming PR #2312. The approved application controls are implemented. Six actual Cut/App browser cases pass across desktop, phone and short windows in both themes, including retry/success, conditional absence for measured files, local commands, phone targets, Tab containment and existing sheet Escape/focus return. Client measurement/Cut/prompt regressions pass (63 tests). Native replies in this UI fixture are synthetic; the coordinator temporary-world tests separately verify persistence. Drawing checks alone do not establish native UI behavior.

Product scope: the owner asked whether the benefit justifies the complexity. Keep score guidance automatic and recovery conditional on missing measurement or failure, with no new screen or setting. Existing measured files show no standing action.

# Local media measurement - turn 258

Proposed 1 November 2026 for the narrowed issue #253, on main 833007167.
The owner authorized music-aware generation and reliable media measurement/recovery.
The earlier request for a design turn before UI implementation remains in force.

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
The accepted prototype mirror follows owner UI approval.

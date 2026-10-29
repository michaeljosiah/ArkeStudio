# Ming 7.9B · smaller-chunk narration · 25 October 2026

The owner requested a smaller-chunk retry of the 241-word Embers scene after the whole-request
seed run stopped at 19.76 seconds and omitted much of the dialogue. See the
[control audit](ming-controls-audit-2026-10-25.md) for that failed read and the separately
accepted short expressive deliveries. This follow-up tests word coverage and continuity of
the narrator and storytelling tone across chunk boundaries.

## Controlled method

The same scene is split at whole-sentence boundaries into seven chunks of 29, 37, 40, 26, 34,
39 and 36 words. Closing quotes remain attached to their sentences; only outer whitespace is
stripped. A token-sequence assertion verifies that no spoken words were added, removed or
reordered. The original quotations and internal paragraph structure are otherwise retained.

Every chunk uses the original 13.62-second Embers narrator reference and its transcript,
English seed cloning, seed 1895 and the explicit 1,000-step ceiling. No previous generated take
is promoted to a reference. The original BF16 checkpoint, pinned upstream source and runtime
are unchanged from the prior 7.9B trials. All seven mapped requests pass the upstream task
resolver before inference. The model is loaded once for the batch; cases run sequentially.

The planned final WAV would concatenate the seven generated PCM16 payloads in order, without
silence, gain adjustment, crossfade, trimming or denoising. No complete prepared set or joined
take was delivered before testing stopped. The local page retains the reference, failed
unchunked take and individual raw attempts.

Individual completed raw chunks were screened locally with the same
faster-whisper small CPU-int8 engine as earlier auditions. Word screening is advisory;
proper-name spellings and accent effects require judgement. Voice, storytelling tone,
character interpretation and transitions require owner listening and cannot pass from ASR.

## Results

The seven raw chunks completed. Chunks 1, 4, 5 and 7 recovered their words in the advisory
transcript screen, apart from Jace being transcribed as Jayce/Jase. Chunks 2, 3 and 6 omitted
substantial text; these were also the three inputs containing internal paragraph breaks.
This correlation does not establish a cause. Quoted dialogue in single-line chunks 4 and 5
was recovered, so removing quotation marks was not justified by these results.

A controlled retry folded only whitespace in chunks 2, 3 and 6, preserving all non-whitespace
characters, seed, reference and settings. The owner then ended testing and chose to pursue
Ming as an optional local model. The retry was stopped during its first case, before any
completed comparison take was saved; no audition worker remained running. It provides no
evidence that whitespace folding resolves omissions. Neither complete-read nor voice/tone
continuity across an assembled scene has been accepted.

## Owner decision

The owner considers Ming capable and wants an optional local model. The accepted neutral
clones and stronger 7.9B short delivery contrast support proceeding to integration design.
Word completeness, passage preparation, per-part retry and reliable joining remain product
requirements, alongside the earlier directed-accent limitation. The acceptance does not turn
the failed long reads into successful results.

All recordings, text, references and provenance remain local. No world or Studio reader
configuration was changed by the experiment.

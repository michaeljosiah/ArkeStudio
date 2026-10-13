# Shared agent media evidence

The conversation harness can now inspect generated media through three shared leased tools:
`inspect_media`, `sample_video` and `analyze_audio_signal`. World, production and Bench chat
use the same coordinator implementation through MCP, across supported harness adapters.
These reads introduce no agent-owned paths, provider calls, authored edits or acceptance.

Sources are immutable production takes (including pass segments), Bench takes and catalogued
artifacts with landed hashes. Legacy hashless takes refuse. Inspection hashes a contained source
into a private snapshot, decodes that snapshot, then verifies the current identity and bytes
again before recording a receipt. World closure, Stop, run/lease revocation, changed world and
image privacy changes prevent successful delivery. The host uses the existing bounded process
runner, with no shell, remote protocols or metadata tags in results.

Video sampling returns up to eight metadata-free PNG frames within a take-relative interval
of at most 60 seconds. Receipts distinguish requested times, decoded source times and segment
view times. Images share `view_image`'s pinned model capability, privacy policy, cloud disclosure
and 24-image/20 MB encoded run budgets. Gaps between samples, continuous motion, flicker and
audiovisual sync remain unreviewed. This does not establish native video-model input.

Audio measurements decode original channels at the original sample rate into bounded float
PCM. Per-channel sample peak, RMS, silence and full-scale sample flags carry the original hash,
PCM hash, stream index and decoded sample duration. Ambiguous tracks require an explicit index.
True peak, LUFS, loudness range, timestamp discontinuities, transcription, semantic sound
identification and listening/performance judgments are explicitly unmeasured. Raw audio stays
local; these tools do not send an audio attachment to a model.

Receipts persist as `media.receipt`, replay into the bounded workspace projection, and raise
the world reader boundary to schema 78. Each observation records the profile and decoder version.
There is no cross-run evidence cache: every call verifies current source bytes. A later cache
must key decoder/profile/source/stream/interval and revalidate identity before reuse.

Validation includes original-rate stereo with known silence/full-scale samples and real VFR
seeking, typed coverage checks, leased MCP image blocks, disclosures, changed bytes, cancellation,
explicit streams, segment offsets and budgets. Native fixture tests can be required with
`ARKE_AGENT_MEDIA_NATIVE_REQUIRED=1` and `ARKE_FFMPEG`/`ARKE_FFPROBE` host paths.

Next increments remain local timestamped transcription with separate derivative provenance,
continuous-motion/flicker/sync coverage, measured true peak/loudness, sound/voice listening
specialists, versioned reuse and a context-aware director delegating through bounded authorities.
The global Chat presentation is not itself a master orchestrating agent.

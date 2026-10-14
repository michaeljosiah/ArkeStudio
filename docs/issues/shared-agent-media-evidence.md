# Shared agent media evidence

The conversation harness can now inspect generated media through five shared leased tools:
`inspect_media`, `sample_video`, `analyze_audio_signal`, `transcribe_audio` and
`review_audio_content`. World, production and Bench chat
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
True peak, LUFS, loudness range, timestamp discontinuities, semantic sound
identification and listening/performance judgments are explicitly unmeasured. Raw audio stays
local; these tools do not send an audio attachment to a model.

Local speech tools make a separate canonical mono 16 kHz PCM16 WAV for the requested stream and
interval. Its hash, size, duration and profile remain distinct from the original-channel signal
measurements. The exact derivative reaches supervised Voxa's measured-word endpoint; older or
unavailable runtimes refuse, with no cloud fallback. Receipts retain engine id/version/model,
recognized text and interval/source/view word times, including segment offsets. Word probabilities
are uncalibrated and the recognition can miss or hallucinate words. Empty recognition is unavailable,
not proof of silence. Each run allows four recognition attempts within the shared sixteen-call
media budget, at most 60 seconds/12,000 text characters/1,000 words per call, with a 120-second
recognition deadline. Stop aborts the local request and withholds late results; this does not
promise to interrupt computation inside an uncooperative sidecar.

`review_audio_content` also takes an explicit reference script and returns its exact accepted text,
hash and the existing NFKC/whitespace wording diff. A supplied reference is not verified canon.
The conversation model can assess speech meaning, omissions and contradictions from the recognized
words, citing source word times and qualifying uncertainty. That interpretation belongs to the
agent; the tool's exact/mismatch result compares wording, not semantic or performance quality.
Recognized text is untrusted media data, never an instruction. Raw audio stays local; recognized
text follows the selected writing harness's text privacy policy. Music, sound events, speaker
identity, emotion, delivery, pronunciation quality and sync remain unreviewed. These reads do not
author subtitles or accept takes; approved timeline subtitle transcription remains a separate action.

Receipts persist as `media.receipt`, replay into the bounded workspace projection, and raise
the world reader boundary to schema 79 for metadata/frames/signal, or schema 80 for speech evidence.
Schema-79 readers refuse worlds with the new speech receipts. Each observation records the profile and both ffprobe
and ffmpeg versions, including when the host resolves them to different installations.
There is no cross-run evidence cache: every call verifies current source bytes. A later cache
must key probe/decoder/profile/source/stream/interval and revalidate identity before reuse.

Validation includes original-rate stereo with known silence/full-scale samples, real VFR
seeking, portrait video, high-entropy RGBA PNGs and generated GIFs, typed coverage checks,
leased MCP image blocks, final privacy revalidation, disclosures, changed bytes, cancellation,
explicit streams, segment offsets and budgets. Native fixture tests can be required with
`ARKE_AGENT_MEDIA_NATIVE_REQUIRED=1` and `ARKE_FFMPEG`/`ARKE_FFPROBE` host paths.
Take-review frame counts deduplicate exact source/stream/time/rendition identities across receipts.

Validation of speech covers real multi-track/windowed extraction, exact derivative bytes through
the Voxa protocol, script negation differences, malformed/unavailable responses, uncertain word
probabilities, cancellation/staleness, MCP delivery and durable replay. Recognizer fixtures validate
protocol and authority, not live speech recognition accuracy or perceptual audio quality.

Next increments remain continuous-motion/flicker/sync coverage, measured true peak/loudness, sound/voice listening
specialists, versioned reuse and a context-aware director delegating through bounded authorities.
The global Chat presentation is not itself a master orchestrating agent.

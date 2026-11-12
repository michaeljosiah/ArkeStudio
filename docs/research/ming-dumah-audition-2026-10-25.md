# Ming Dumah narrator audition · 25 October 2026

The owner requested a clone of the voice currently used for Legend of Dumah. The current
Whispers from the Void audiobook configuration and its saved prologue take select
Nkechi — the storyteller, a designed South African English narrator from Google's TTS service.
The alternate oracle voice in the world catalogue was not selected.

A saved prologue take provides a 10.04-second reference and a separate 15.16-second comparison
passage. The 28 target words do not occur in the reference excerpt. Text is from matching
chapter version 1; local faster-whisper word timestamps locate the excerpts. Human verification
of alignment and voice quality remains pending. Source hashes, ranges and provider metadata are
retained privately; the world is read-only and no recording was uploaded or new cloud synthesis
requested.

The 0.5B test uses neutral TTS cloning with reference audio, its transcript, English language
ID, seed 1895 and the same unmodified checkpoint/runtime as the
[Embers audition](ming-embers-audition-2026-10-25.md). It retains native default splitting and
trailing-silence trimming. The probe adds no output gain, denoising or further trimming.

| Result | 0.5B | 7.9B original BF16 |
|---|---|---|
| Output duration | 13.60 s | 12.72 s |
| Synthesis | 34.89 s | 258.31 s |
| RTF | 2.57 | 20.31 |
| Raw peak | 0.827 | 0.813 |
| Samples above full scale | 0 | 0 |
| Local ASR screen | Zero normalized edits | Zero normalized edits |
| Owner listening | Close enough for narration | Pending |

The 0.5B worker completed successfully. Its separate target was copied unchanged to a local
listening page beside the reference and existing original reading. Accent retention, identity,
storytelling pace and audible artifact quality remain listening decisions. The owner selected
"Close enough for narration" for the 0.5B clone. This accepts this voice and short neutral
passage; it is not a directed-accent or chapter-length qualification.

The owner also requested the same test with 7.9B. That clone was the first case in the larger
[control-audit and stress run](ming-controls-audit-2026-10-25.md), using the same reference, words
and seed. Tiny's native seed API and original BF16 checkpoint are retained; its whole-request
generation differs from 0.5B's automatic text splitting. No app reader configuration changed.

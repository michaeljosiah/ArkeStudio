# Ming neutral narration · Embers audition · 25 October 2026

Decision so far: the owner accepted the 0.5B clone as "an almost perfect 1:1" and reported
"no strange audio artifacts". This supports considering an optional, auditioned neutral
narration workflow. It does not reverse the failed directed accent-retention result or
establish a general replacement for every speaker and delivery. The 7.9B comparison generated
successfully; the owner described the two neutral versions as "practically identical" and
requested longer narration with several characters plus quiet and angry delivery tests.
The subsequent [control audit](ming-controls-audit-2026-10-25.md) records owner-preferred
7.9B short delivery contrast, but substantial omissions in its whole-scene seed request.

The owner requested a separate test of simpler narration needs after both model sizes failed
the Nigerian-English whispered accent-retention check. That rejection applies to directed
character performance; it does not establish the quality of neutral narration with another
voice. This audition tests that narrower use before making a replacement recommendation.

## Source and method

The current Embers of the Fallen audiobook selects the ElevenLabs voice labelled
Calen Voss — Resonant, Magnetic, with the note "natural American narration". Its current saved
chapter takes confirm that selection. The older world voice named Harbour glass is not the
selected audiobook narrator and was not used for this test.

A saved, single-speaker narration take provides a 13.62-second reference (48 words) and a
separate 12.80-second original comparison passage (35 words). The target passage does not occur
in the reference. Text comes from the matching chapter version; local faster-whisper word
timestamps locate the excerpts. Human verification of the excerpt boundaries and words remains
pending. The reference uses the canonical "sleet", although the ASR draft transcribed "sleep".

Both Ming sizes receive the same reference, transcript, target text and seed 1895 in their
native cloning task: 0.5B TTS and tiny seed. The explicit 1,000-step ceiling is preserved.
There is no direction, emotion instruction or FREEFORM task. Checkpoints, source revision and
runtime environments are those recorded in the [0.5B report](ming-tts-audition-2026-10-25.md)
and [tiny report](ming-tiny-audition-2026-10-25.md). Tiny uses original BF16 weights.

Source/reference hashes, excerpt ranges, original provider metadata and requests remain in
private local provenance. No world was written, recording uploaded or paid synthesis requested.
Output levels and onset are preserved for listening; the original comparison is an existing
audiobook excerpt, not a fresh cloud generation.

## Results

| Model | Audio | Synthesis | RTF | Raw peak | Samples over full scale |
|---|---|---|---|---|---|
| 0.5B | 11.60 s | 29.89 s | 2.58 | 0.411 | 0 |
| 7.9B original BF16 | 11.76 s | 368.37 s | 31.32 | 0.436 | 0 |

The 0.5B worker loaded in 11.51 seconds after imports and completed in 47.34 seconds, excluding
the prior provenance scan. Peak PyTorch allocation was 3,105,985,024 bytes. The local
faster-whisper screen recovered the passage, spelling "glovebox" as "glove box" and writing
"twenty-one" as "21". Its raw normalized-token edit score is 0.111; that is a screening result,
not an adjudicated 11.1% speech error rate. It does not show an omitted phrase. The 7.9B
transcript screen recovered the same words, with the same spelling/number differences.

The 7.9B model loaded in 79.06 seconds after imports; its worker completed in 456.47 seconds,
excluding the prior provenance scan. It stopped normally at step 147 of the 1,000-step ceiling,
with last stop probability 0.99996. Peak PyTorch allocation was 18,914,484,736 bytes; this
allocator counter does not establish physical residency. Both workers exited successfully.

The owner's 0.5B listening verdict was: "The narration is an almost perfect 1:1. There was also
no strange audio artifacts." Voice similarity and artifact acceptance pass for this clip by
that judgement. Other voices, longer narration, consistency over a chapter and directed delivery
are not qualified by one accepted 11.6-second output.

## What changed from the failed audition

The 0.5B checkpoint, runtime, seed and probe output handling are unchanged. The reference is a
13.62-second neutral American male narration excerpt with canonical source text, instead of the
earlier 9.25-second Nigerian-English character reference. The target is a separate passage of
the same audiobook. No whisper, emotion or FREEFORM instruction is used. Earlier neutral
samples also used TTS cloning, so switching task modes cannot alone explain the improvement.

The probe did not denoise, trim or normalize this output. The upstream 0.5B default processing
is unchanged from the earlier run. No single cause has been isolated: speaker, reference
recording, reference length, transcript origin, target words and delivery differ. The accepted
result supports a voice-specific neutral use case, not a diagnosed fix for the earlier failure.

## Recommendation and validation

Consider 0.5B for optional local neutral narration after an audition with the intended voice.
It achieved owner-accepted identity and artifact quality on this passage at roughly 2.6 times
the audio duration in synthesis. The 7.9B version took about 12.3 times as long to synthesize
the same words on this occupied desktop and has not demonstrated an accepted quality advantage
here. Neither result qualifies a general character-performance replacement. Longer passages
and chapter-level consistency remain untested for this narrator.

The local comparison page contains the reference, existing original reading and both clones.
Copied audio hashes match the journals; WAV header checks confirm mono 44.1 kHz PCM16 outputs.
No output exceeded full scale. Documentation links, source syntax and whitespace checks pass.
Only private audition setup and documentation changed in this follow-up; no application
configuration changed or application-wide test gate was run.

## Longer scene and delivery stress audition

The follow-up uses 0.5B because the owner heard practically identical short results and this
runtime generated them much faster. The same 13.62-second reference and seed 1895 are retained.
A 241-word chapter scene combines narration with dialogue by Reina, Jace and Mercer. This is
one cloned narrator interpreting several story characters, not three independently cloned
speaker identities. The unmodified upstream API performs its default text splitting and
per-fragment trailing-silence trimming; this does not qualify one uninterrupted decoder context
of the final output duration.

A separate 30-word audition line is generated four ways: neutral TTS cloning, BASIC with
low volume and medium pitch/speed, EMOTION anger, and FREEFORM instructed to whisper very
quietly with restrained urgency. "Silent" is interpreted as very quiet spoken delivery;
the low-volume and whispered cases cover different ways of doing that. The line is new
audition text rather than a quotation attributed to the chapter.

TTS retains the reference's acoustic prompt and transcript. The tonal tasks follow the upstream
speaker-reference examples without a prompt transcript, using the speaker embedding. They do
not share the full TTS conditioning path. Reference-conditioned FREEFORM remains experimental
and is not recommended by upstream. This distinction matters when judging any identity drift.
The probe applies no output gain change, denoising or extra trimming. These samples test model
delivery controls rather than a postprocessing volume reduction.

| Stress case | Audio | Synthesis | RTF | Raw peak | Samples over full scale |
|---|---|---|---|---|---|
| Neutral tone control | 7.70 s | 20.31 s | 2.64 | 0.610 | 0 |
| Low-volume BASIC | 7.60 s | 19.32 s | 2.54 | 0.392 | 0 |
| Angry EMOTION | 7.90 s | 19.44 s | 2.46 | 0.220 | 0 |
| Whispered FREEFORM | 8.60 s | 21.28 s | 2.47 | 0.643 | 0 |
| Long dialogue, original punctuation | 65.80 s | 167.44 s | 2.54 | 0.448 | 0 |
| Long dialogue, double quotes removed | 64.50 s | 164.11 s | 2.54 | 0.523 | 0 |

All five cases generated successfully and the worker exited 0. Copied hashes and mono 44.1 kHz
PCM16 headers match the journals. The short clips' local ASR screens recovered every normalized
word. This does not establish that the requested delivery was achieved or identity retained.

The long screen's raw token error score is 0.021. It spells Jace as Jayce/Jase, repeats "drawer",
reads "it" as "at" in one phrase and ends with "I'm a" instead of "I'm impatient". A separate
screen of the last 12 seconds also failed to recover "impatient". These are listening flags,
not adjudicated speech errors. The original long output is preserved unchanged.

The upstream preprocessing/splitting functions produce 18 fragments from this quoted scene;
the last contains only a closing quotation mark and a period. This is an observed input-edge
case, not proof that it caused the final-word problem. A controlled second run removes only
the 22 ASCII double quotation marks. Its spoken word sequence is verified unchanged; default
model settings and the reference are retained. It splits into 17 fragments, with no final
punctuation-only fragment. The comparison generated and its worker exited 0; copied hash and
WAV header checks pass.

The quotation-free screen recovers the complete final "I'm not doing it because I'm impatient"
but still repeats "drawer", substitutes "at" for "it", and spells Jace/Reina differently. Its
raw token edit score also rounds to 0.021. Recovering the ending is not proof that the extra
punctuation fragment caused the earlier problem: removing quotes changes tokens, fragment
boundaries and the sequence of random draws across the run. Both original outputs are retained.
The remaining repetition flag prevents treating the longer test as an unqualified word-fidelity
pass without listening adjudication.

Word fidelity, speaker consistency, character interpretation, tone and artifact acceptance
remain separate listening checks. The owner reported: "It does retain the identity but it did
not sound quiet and angry was not a significant contrast." This accepts reported identity
retention but rejects quietness and sufficient anger contrast in the delivered short tests.
No owner verdict on long-scene word fidelity is recorded yet.
All four short screens recover the requested words, but only human listening can establish
that quiet/anger/whisper controls preserve this narrator and achieve the requested delivery.
No output waveform cleanup or level adjustment was introduced in this follow-up.

The owner requested an online setup check and a matching 7.9B trial. See the
[control audit](ming-controls-audit-2026-10-25.md) for official-source verification, matched
task-mode baselines, reference-free diagnostics and the larger-model comparison.

# Ming delivery controls · online audit · 25 October 2026

The owner heard retained Embers narrator identity but insufficient quietness and anger contrast
in the [0.5B stress audition](ming-embers-audition-2026-10-25.md). They requested verification
against online instructions and the same test with the 7.9B variant. This audit separates
API setup correctness from audible instruction following.

## Official-source verification

GitHub's current main revision is `028c1eace193e7acdb256453da89b6e9207e052b`, identical to the
pinned inference source. The live README, control reference, runnable cookbook, CLI, task
resolver and prompt contract were checked on 25 October 2026.

- BASIC accepts exact Chinese values for speed, pitch and volume. The submitted low-volume
  request uses medium speed, medium pitch and low volume; all three fields are present.
- EMOTION anger uses `愤怒`, as submitted. The default Chinese instruction schema is correct;
  the English explanations in the guide are not control-value aliases.
- Controls resolve into the native structured instruction before generation. The probe passes
  the request directly to `MingTTS.synthesize`; it does not discard the controls. The native
  CFG default remains 2.0.
- FREEFORM takes a separate natural-language instruction. The README and control guide
  recommend reference-free use. Our clone-preserving whisper supplied a reference, so it is
  an experimental conditioning path, not evidence of recommended reference-free performance.
- A low-volume attribute is not an explicit whisper instruction. The model does not expose an
  anger-intensity parameter in its documented emotion controls.

The README's BASIC example permits speaker-embedding input without a transcript; the notebook
also illustrates acoustic reference plus transcript. The prior speaker-reference calls are
valid, but they do not match neutral TTS's full acoustic conditioning. The methodological
correction is to compare BASIC low against BASIC medium and EMOTION anger against EMOTION
neutral with otherwise identical requests. No upstream inference-code patch or checkpoint
replacement was needed for this 0.5B check.

The project also reports weaker emotion accuracy when words do not carry emotional cues.
That limitation does not turn an owner-rejected performance into a pass.

Sources: [control reference](https://github.com/inclusionAI/Ming-3.0-tts/blob/028c1eace193e7acdb256453da89b6e9207e052b/cookbooks/instruction_en.md),
[runnable cookbook](https://github.com/inclusionAI/Ming-3.0-tts/blob/028c1eace193e7acdb256453da89b6e9207e052b/cookbooks/cookbook.ipynb),
[task resolver](https://github.com/inclusionAI/Ming-3.0-tts/blob/028c1eace193e7acdb256453da89b6e9207e052b/tts_tasks.py),
[pipeline](https://github.com/inclusionAI/Ming-3.0-tts/blob/028c1eace193e7acdb256453da89b6e9207e052b/ming_tts.py),
[README controls and limitations](https://github.com/inclusionAI/Ming-3.0-tts/tree/028c1eace193e7acdb256453da89b6e9207e052b).

## Follow-up design and results

0.5B generated matched BASIC medium and EMOTION neutral controls, plus reference-free FREEFORM
whisper and anger diagnostics. The latter two are deliberately not Embers voice clones: they
test the recommended instruction pathway separately from speaker retention. All use the same
30-word target and seed 1895. Their waveforms retain original levels, including any clipping.

| 0.5B follow-up | Audio | Synthesis | Raw RMS | Samples over full scale | ASR normalized edits |
|---|---|---|---|---|---|
| BASIC medium control | 7.60 s | 20.15 s | 0.05879 | 0 | 0 |
| EMOTION neutral control | 8.30 s | 20.59 s | 0.05483 | 0 | 0 |
| FREEFORM whisper, no reference | 9.00 s | 22.38 s | 0.07960 | 1 | 0 |
| FREEFORM anger, no reference | 8.50 s | 21.32 s | 0.11462 | 4 | 0 |

Against the same-mode controls, the earlier BASIC-low waveform's RMS is about 3.0 dB lower;
the earlier EMOTION-angry waveform's RMS is about 9.5 dB lower than EMOTION neutral. These
whole-waveform energy measurements include pauses and are not perceived loudness or evidence
of a quiet/angry performance. The owner's delivery rejection remains the acoustic verdict.
Reference-free diagnostic peaks are 1.200 and 1.111 respectively; their sparse over-full-scale
samples saturate in PCM16. These diagnostic outputs are not advertised as clean clones.

The requested 7.9B run includes the same four original deliveries, the two same-mode neutral
controls and the original 241-word scene. It also includes the newly requested Dumah narrator
clone. Original BF16 weights, source pin and environment are unchanged from the earlier
[tiny trial](ming-tiny-audition-2026-10-25.md). The neutral/long cases map to native seed tasks;
basic/emotion/freeform use their native named controls. Tiny generates a whole target per
request, unlike 0.5B's default automatic splitting. Exact mapped requests and stop evidence
are retained, so these model-specific execution differences are visible.

All larger-model requests produced WAVs, and the corrected worker exited 0. The long scene
nevertheless failed word-fidelity screening: normal termination is not a complete-read pass.
Technical generation, word screening and owner listening remain separate gates.

| 7.9B case | Audio | Synthesis | RTF | Stop step | ASR screen |
|---|---|---|---|---|---|
| Neutral TTS clone | 7.44 s | 128.37 s | 17.25 | 93 | 0 |
| BASIC low volume | 7.84 s | 191.52 s | 24.43 | 98 | 0 |
| EMOTION anger | 8.24 s | 149.39 s | 18.13 | 103 | 0 |
| FREEFORM whisper with reference | 10.00 s | 178.29 s | 17.83 | 125 | 0 |
| BASIC medium control | 7.20 s | 130.76 s | 18.16 | 90 | 0 |
| EMOTION neutral control | 8.08 s | 154.01 s | 19.06 | 101 | 0 |
| 241-word scene, incomplete | 19.76 s | 392.78 s | 19.88 | 247 | 0.680 token edit rate; substantial omissions |

None of those raw outputs exceeded full scale. Tiny BASIC low has about 2.6 dB lower
whole-waveform RMS than its BASIC medium control; anger has about 0.7 dB higher RMS than
EMOTION neutral. These energy figures do not quantify emotional delivery quality.

The owner listened to the corrected 7.9B quiet, angry and whispered short samples and selected
"Stronger contrast; identity retained" relative to 0.5B. This distinguishes expressive delivery
for the tested Embers voice despite their practically identical earlier neutral reads. It does
not establish longer-scene word fidelity, all accents or all speakers. In particular, the
earlier Nigerian directed-accent failure remains a separate result.

The long-scene request retained all 241 input words, its reference/transcript and the explicit
1,000-step ceiling. The model chose a stop at step 247, with stop probability 0.95257; it did
not exhaust the ceiling. Its 19.76-second output covers much of the opening narration but
skips substantial dialogue and jumps to fragments from later in the scene. This is not merely
an ASR spelling difference for a character name. The screen's 0.680 raw token edit rate is
advisory rather than human-adjudicated WER, but the incomplete read prevents acceptance.
The output remains available with an explicit incomplete-read label.

This test does not isolate whether length, quotation/newline structure or another conditioning
effect caused the omissions. It does not establish a fixed 20-second model limit: the earlier
97-word tiny test generated a complete-screened 31.68-second passage. It also does not qualify
Tiny's separate multi-speaker podcast task, which requires at least two reference entries and
a speaker-labelled script. The owner's subsequent
[smaller-chunk retry](ming-chunked-audition-2026-10-25.md) is recorded separately rather than
represented as an outcome of this whole-request test.

## Tiny adapter correction

Further review of Tiny's native task resolver found a probe adapter mismatch: Tiny's basic,
emotion and freeform tasks reject a target-language line, although 0.5B accepts `language_id`
on those task requests. The adapter had forwarded that field unconditionally. Its mapping now
retains target language only for seed, paralinguistic and multilingual tasks. Reference audio,
target words, controls, seed and decode ceiling are preserved. This is a probe adapter fix,
not a model-code change.
The earlier Nigerian-English tiny whisper request did not contain a target-language field and
generated successfully; that earlier accent-retention verdict is not invalidated by this fix.

The first larger worker generated valid Dumah and neutral TTS results. The five tonal requests
were rejected before synthesis; these are setup errors, not acoustic failures. After the
neutral result was saved, only the verified worker started for this audition was stopped and
the remaining cases restarted in a fresh output directory with the fixed adapter. The partial
long read was interrupted and is not a delivered take. The old runner snapshot, original
journal and restart reason are preserved privately.

Seven standard-library probe tests pass, including a regression covering BASIC, EMOTION and
FREEFORM language-field mapping. The unchanged upstream `resolve_task_request` also accepts
all eight corrected mapped requests without loading a model. Current comparison players use
valid first-run outputs and corrected retry outputs; rejected attempts remain in the journal.

Source: [Tiny task resolver](https://github.com/inclusionAI/Ming-3.0-tts/blob/028c1eace193e7acdb256453da89b6e9207e052b/ming_tiny/task_protocol.py).

## Decision and validation

The accepted Embers and Dumah neutral clones support considering 0.5B for auditioned local
narration. The owner-preferred short expressive Embers outputs give 7.9B a distinct use case
where generation time is acceptable. They do not make it a drop-in whole-scene or all-accent
replacement: the 241-word seed request omitted dialogue, and Nigerian directed accent
retention failed earlier. Longer narration still requires an explicitly qualified segmentation
and word-fidelity workflow; neither is added to the app by this probe.

Eight delivered larger-model files are retained across the valid first-run and corrected-run
results: Dumah plus seven Embers cases. Seven short screens have zero normalized word edits;
the long screen fails as described. All delivered copied hashes and mono 44.1 kHz PCM16 headers
match their journals, and no delivered larger-model output exceeds full scale. The interrupted
take and five setup rejections are excluded from delivered counts. The corrected worker exited
successfully. Seven probe tests, native request validation, source syntax, documentation links,
the private-document path guard and whitespace checks pass. Application packages and reader
configuration were unchanged; the full npm application gate was not run.

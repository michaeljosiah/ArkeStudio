# ElevenLabs audiobook direction

Issue [#1753](https://github.com/michaeljosiah/ArkeStudio/issues/1753) extends SPEC-047's
performed reading and SPEC-049's grouped reads. The private design set was readable during
implementation but was not a Git checkout; this document records the implemented requirement
changes, not a claimed private-spec commit.

Character performance briefs allow 300 characters. Audible delivery phrases allow 160;
each provider still declares its own tag limit. Eleven v4 accepts the 160-character bound
without the former two-word restriction. Other tag readers retain sixty unless their row
declares otherwise. These are Arke product limits, not ElevenLabs syntax guarantees.
Longer character briefs compile as bounded comma/semicolon-separated clauses; an indivisible
oversized clause is visibly held rather than truncated. Existing notes remain valid.

Under Performed, `compileAudiobookPerformance` places v4 character notes on their cast turns,
including dialogue inside a narration paragraph. It preserves the selected narrator's timbre
and restores the original narration voice/accent between character turns. Character voice
quality and temporary delivery remain separate. No manuscript words are changed. The same
compiler supplies the block preview and queued speech. Unmatched cast turns refuse a read
rather than guessing who speaks. Plain Narrator and full Cast retain their existing meanings.

The director explicitly examines dramatic beats and adds sparse anchored pauses, leaving
punctuation-driven pacing alone. Its custom delivery phrases carry emotional direction beyond
the six portable presets. The marker menu includes emotional presets and the additional
Eleven vocalizations; unsupported provider controls remain held. Natural-language directions
are best effort: an accepted request is not proof that an actor followed them.

V4 requests preserve voice settings by default. Stability is not a pacing control. The provider
requests 24 kHz PCM and wraps it in WAV without transcoding, enabling the existing local
transcription, checked block alignment, durable cut provenance and cost allocation. Grouping
requires the local transcriber and remains opt-out through per-paragraph requests. Both token
and character billing can group when the model declares the capability. The exact compiled
text, including tags and paragraph separators, must fit the model's request cap. A re-read
with neighbours falls back to the single-block route when the combined request exceeds it.

The grouped-read confirmation includes v4 request previews (endpoint and JSON). These are
labelled previews; provider-call records in Activity remain the evidence of actual HTTP calls.
The preview shows tags explicitly and the existing controls identify held direction.

The audiobook raises the world reader boundary to 78 when it first saves a character brief
over sixty characters, a delivery phrase over sixty, or a newly supported vocalization.
An older reader must not silently discard these records. Merely opening a world does not
raise it.

Regression coverage: contracts `audiobook-performance`, `audiobook-performed`, `cadence`,
`voice-direction` and `grouped-reads`; providers `clients` and `manifest`; coordinator
`audiobook-director` and `audiobook-grouped`; client `chapter-audiobook` and `voice-direction`.
The simulated provider tests establish request construction, pricing, saving and mapping.
Listening remains necessary to assess the chosen voice's actual performance.

Official guidance checked 2026-10-13:
- [Audio tags](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/how-do-audio-tags-work-with-eleven-v3-and-v4)
- [Prompting and pauses](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)
- [TTS request and PCM output](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)

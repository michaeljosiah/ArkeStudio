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

The read confirmation includes v4 request previews (endpoint and JSON) from the coordinator’s
priced run, including the neighbours paid for on a scoped re-read. These are
labelled previews; provider-call records in Activity remain the evidence of actual HTTP calls.
The preview shows tags explicitly and the existing controls identify held direction.

The audiobook raises the world reader boundary to 78 when it first saves a character brief
over sixty characters, a delivery phrase over sixty, or a newly supported vocalization.
An older reader must not silently discard these records. Merely opening a world does not
raise it. Performance quotes carrying new cue formats raise the boundary before their first
durable write, including sealed world-chat quotes and native preparation.

Regression coverage: contracts `audiobook-performance`, `audiobook-performed`, `cadence`,
`voice-direction` and `grouped-reads`; providers `clients` and `manifest`; coordinator
`audiobook-director` and `audiobook-grouped`; client `chapter-audiobook` and `voice-direction`.
The simulated provider tests establish request construction, pricing, saving and mapping.
Listening remains necessary to assess the chosen voice's actual performance.

Official guidance checked 2026-10-13:
- [Audio tags](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/how-do-audio-tags-work-with-eleven-v3-and-v4)
- [Prompting and pauses](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)
- [TTS request and PCM output](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)


Request cleanup (2026-10-13): performed v4 retains structured speaker runs until grouping
chooses an actual request boundary. `packTurns` renders shared context once and identity cues
only when the speaker changes; a solo or scoped reread establishes its own context. Narration
returns use the authored book narration brief, so an explicit accent is retained. Temporary
spoken delivery resets before the next run, including across paragraph boundaries. Reaction-only
requests do not inherit the prose performance. Group caps, quotes, confirmation previews and
queued text use the same rendered turns. This implements SPEC-049's request-scoped direction
amendment; direction tags remain best-effort provider input, not guaranteed vocal control.

V4 cadence mapping retains source line breaks while cue coordinates remain whitespace-folded.
Bench's typed pause conversion therefore preserves paragraph layout rather than flattening the
request. Exact-string regressions cover text, line breaks, inline cues, scoped requests, character
transitions and request limits. Do not normalize whitespace when comparing a reviewed prompt
with the actual provider request: doing so concealed the original paragraph-loss regression.


Lean audible cues (2026-10-14, PR #1757): keep full character descriptions as planning context.
The director requests the fewest audible traits needed, not narrator identity instructions.
`audiblePerformanceBrief` removes only known legacy scaffolding and carries an imitation's
accent forward; unrecognised clauses remain intact and over-limit cues are held, never cut.
Saved briefs and character sheets are not rewritten by compilation. Book-specific author cues
can be shorter than the retained character description.

The compiler no longer injects a same-narrator instruction. A book note consisting only of
`natural <accent> narration` describes the baseline and is used on returns, not at the opening;
other expressive book/chapter instructions still lead independent requests. A short reporting
clause (at most eight words) between the same character's cast dialogue can continue without
an accent reset. Action, changed speakers, longer narration and temporary delivery still reset.
This is a conservative English reporting-clause heuristic, not universal language understanding.
Manuscript words, quotation marks and paragraph boundaries must survive unchanged. The reviewed
Threshold opening has 14 tags and 11 paragraph breaks; its lean preview has not been synthesized.


Character narration ownership (2026-10-14, issue #1765): the character Voice tab, the
Reading sheet and chapter speaker editors now edit the character's `narration` by default.
A book difference requires the explicit **Override for this book** control. Existing overrides
remain intact and visible; **Use character narration** removes only that book's override.
Speakers without an active character sheet retain book-scoped directions.

The Voice tab shows overrides even when entered without book context, and offers a book
selector. Each book panel shows the saved effective character cue and source. V4 previews
and the request compiler share `characterPerformanceDirection`, including legacy scaffold
cleanup and provider limits. Held cues and non-performed reading modes are labelled as not
sent. This is the standing character cue; the complete confirmation request still shows
line delivery, pauses, narration returns and grouping. Editing never generates audio.
Existing notes are not silently migrated between books. Moving an existing book note to a
character is a deliberate content change, checked against the current effective direction.
